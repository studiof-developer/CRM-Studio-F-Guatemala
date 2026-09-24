// Meta's Messenger Platform webhook — receives BOTH Messenger ('page' object) and
// Instagram ('instagram' object) DMs under one subscription, per Meta's own model.
// No requireAuth (Meta calls this directly, no CRM session — same reasoning as
// attachments.js's inboundRouter for n8n), protected instead by the GET handshake's
// verify_token and the POST body's HMAC signature, both checked against Configuración >
// Redes sociales' own settings.
import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { getSetting } from './settings.js';
import { decryptToken } from '../tokenCrypto.js';
import { fetchProfileName } from '../metaMessaging.js';

const router = Router();

// Meta calls this once, when the webhook URL is first entered in the App Dashboard (and
// again any time it's re-verified) — echoes back hub.challenge only if hub.verify_token
// matches what Configuración > Redes sociales has saved, proving this endpoint is really
// ours and not something else answering on this URL.
router.get('/', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = await getSetting('meta_webhook_verify_token', null);
  const expectedPlain = expected ? decryptToken(expected) : null;
  if (mode === 'subscribe' && expectedPlain && token === expectedPlain) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Every inbound Messenger/Instagram message lands here. Signature-verified against the
// Meta App Secret — anyone who doesn't know that secret can't forge a message into a
// customer's thread by POSTing here directly.
router.post('/', async (req, res) => {
  // Acknowledge immediately regardless of what's inside — Meta retries (and can pause
  // the whole subscription) if this doesn't return 200 quickly, and a malformed or
  // unrecognized payload here is a Meta-side or webhook-config problem, not something
  // retrying the same bytes would ever fix.
  res.sendStatus(200);
  try {
    const encSecret = await getSetting('meta_app_secret', null);
    if (!encSecret) return; // not configured yet — nothing to verify against
    const appSecret = decryptToken(encSecret);
    const signature = req.get('x-hub-signature-256');
    if (!signature || !req.rawBody) return;
    const expectedSig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      console.error('social webhook: signature mismatch, dropping payload');
      return;
    }

    const igBusinessId = await getSetting('meta_ig_business_id', null);
    const body = req.body;
    if (!Array.isArray(body?.entry)) return;
    for (const entry of body.entry) {
      const isInstagramEntry = body.object === 'instagram'
        || (igBusinessId && entry.id === igBusinessId);
      for (const event of entry.messaging ?? []) {
        // Delivery/read receipts and echoes of our own sent messages also arrive on this
        // same webhook — only a real inbound message (sender != page, has message)
        // is something to store here.
        if (!event.message || event.message.is_echo) continue;
        const externalId = event.sender?.id;
        if (!externalId) continue;

        const provider = (isInstagramEntry || (igBusinessId && event.recipient?.id === igBusinessId))
          ? 'instagram'
          : 'messenger';

        let text = event.message.text;
        if (!text && event.message.attachments?.length) {
          const first = event.message.attachments[0];
          text = `[${(first.type || 'archivo').toUpperCase()}]`;
        }

        const { rows } = await pool.query(
          `INSERT INTO social_contacts (provider, external_id, last_message_at, unread_count)
           VALUES ($1, $2, now(), 1)
           ON CONFLICT (provider, external_id)
             DO UPDATE SET last_message_at = now(), unread_count = social_contacts.unread_count + 1
           RETURNING id, display_name, profile_pic_url, customer_id, provider`,
          [provider, externalId]
        );
        const contact = rows[0];

        // Fetch display name if not yet set
        if (!contact.display_name) {
          try {
            const profile = await fetchProfileName(externalId, contact.provider);
            if (profile?.displayName) {
              contact.display_name = profile.displayName;
              contact.profile_pic_url = profile.profilePicUrl ?? contact.profile_pic_url;
              await pool.query(
                `UPDATE social_contacts SET display_name = $1, profile_pic_url = COALESCE($2, profile_pic_url) WHERE id = $3`,
                [contact.display_name, contact.profile_pic_url, contact.id]
              );
            }
          } catch (err) {
            console.error('social webhook: profile name lookup failed', err);
          }
        }

        await pool.query(
          `INSERT INTO social_messages (contact_id, direction, body, raw_payload, external_message_id)
           VALUES ($1, 'in', $2, $3, $4)`,
          [contact.id, text ?? null, JSON.stringify(event), event.message.mid ?? null]
        );

        await ensureCustomerAndTicket(contact, contact.provider, text);
      }
    }
  } catch (err) {
    console.error('social webhook processing failed', err);
  }
});

// Phase 3 (2026-09-14): gives a social contact the same customers/tickets presence a
// WhatsApp customer already has, so it can appear on the shared Pipeline board.
// whatsapp_number stores the synthetic 'social:<social_contacts.id>' — see
// db/init/055's comment for why that exact format is safe against the ~20 phone-regex
// call sites elsewhere, and why it doubles for free as the sessionId
// Conversations.jsx already routes to SocialThreadPanel.
async function ensureCustomerAndTicket(contact, provider, text) {
  let customerId = contact.customer_id;
  if (!customerId) {
    const { rows: custRows } = await pool.query(
      `INSERT INTO customers (whatsapp_number, full_name, channel) VALUES ($1, $2, $3) RETURNING id`,
      [`social:${contact.id}`, contact.display_name ?? null, provider]
    );
    customerId = custRows[0].id;
    await pool.query(`UPDATE social_contacts SET customer_id = $1 WHERE id = $2`, [customerId, contact.id]);
  } else if (contact.display_name) {
    // If contact already exists, keep customers.full_name updated if it was missing or generic placeholder
    await pool.query(
      `UPDATE customers SET full_name = $1 WHERE id = $2 AND (full_name IS NULL OR full_name = '' OR full_name LIKE 'Contacto de %')`,
      [contact.display_name, customerId]
    );
  }

  // No bot/AI layer intercepts social messages — every inbound message needs a human
  // right away, so a brand-new ticket starts at 'esperando_asesor' ("Pendiente"), not
  // 'bot'. Reuses the same "one open ticket per customer" invariant conversations.js's
  // own /:sessionId/take already relies on: reuse whatever non-resuelto ticket exists,
  // only open a new one if the customer's last ticket was actually resolved.
  const { rows: openTickets } = await pool.query(
    `SELECT id FROM tickets WHERE customer_id = $1 AND status != 'resuelto' ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (!openTickets.length) {
    await pool.query(
      `INSERT INTO tickets (customer_id, status, handoff_reason) VALUES ($1, 'esperando_asesor', 'mensaje_entrante_social')`,
      [customerId]
    );
  }

  // Mirrors update_customer_last_message() (db/init/031/046/051) — there's no
  // n8n_chat_histories row here to hang that trigger off of, so this is the
  // application-code equivalent. Firing this UPDATE is also what makes the Pipeline
  // board live-update for free: db/init/037's trigger already notifies on any
  // customers UPDATE, and HandoffQueue.jsx already listens for it.
  await pool.query(
    `UPDATE customers SET last_customer_message_at = now(), last_customer_message = $1,
       last_message_at = now(), last_message = $1, awaiting_reply = true, has_unread = true
     WHERE id = $2`,
    [text ?? null, customerId]
  );
}

export default router;
