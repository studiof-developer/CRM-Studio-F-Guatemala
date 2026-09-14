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

    const body = req.body;
    if (!Array.isArray(body?.entry)) return;
    for (const entry of body.entry) {
      const provider = body.object === 'instagram' ? 'instagram' : 'messenger';
      for (const event of entry.messaging ?? []) {
        // Delivery/read receipts and echoes of our own sent messages also arrive on this
        // same webhook — only a real inbound message (sender != page, has message.text)
        // is something to store here.
        if (!event.message || event.message.is_echo) continue;
        const externalId = event.sender?.id;
        const text = event.message.text;
        if (!externalId) continue;

        const { rows } = await pool.query(
          `INSERT INTO social_contacts (provider, external_id, last_message_at, unread_count)
           VALUES ($1, $2, now(), 1)
           ON CONFLICT (provider, external_id)
             DO UPDATE SET last_message_at = now(), unread_count = social_contacts.unread_count + 1
           RETURNING id`,
          [provider, externalId]
        );
        await pool.query(
          `INSERT INTO social_messages (contact_id, direction, body, raw_payload, external_message_id)
           VALUES ($1, 'in', $2, $3, $4)`,
          [rows[0].id, text ?? null, JSON.stringify(event), event.message.mid ?? null]
        );
      }
    }
  } catch (err) {
    console.error('social webhook processing failed', err);
  }
});

export default router;
