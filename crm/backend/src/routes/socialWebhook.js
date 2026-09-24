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
import * as whatsapp from '../whatsapp.js';
import { saveAttachment } from '../attachmentStorage.js';
import { compressImageBuffer } from '../imageCompression.js';
import { compressPdfBuffer } from '../pdfCompression.js';
import { processInboundImageOcr, updateMessageStatus } from './attachments.js';

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

// Every inbound Messenger/Instagram/WhatsApp message lands here.
router.post('/', async (req, res) => {
  // Acknowledge immediately regardless of what's inside — Meta retries (and can pause
  // the whole subscription) if this doesn't return 200 quickly, and a malformed or
  // unrecognized payload here is a Meta-side or webhook-config problem, not something
  // retrying the same bytes would ever fix.
  res.sendStatus(200);
  try {
    const encSecret = await getSetting('meta_app_secret', null);
    const signature = req.get('x-hub-signature-256');
    const body = req.body;
    console.log(`[socialWebhook] Incoming POST: object=${body?.object}, entries=${body?.entry?.length || 0}`);

    if (signature && req.rawBody && encSecret) {
      const appSecret = decryptToken(encSecret);
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
      const signatureMatches = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
      if (!signatureMatches && body?.object !== 'whatsapp_business_account') {
        console.error('social webhook: signature mismatch, dropping payload');
        return;
      }
    }

    if (body?.object === 'whatsapp_business_account') {
      console.log('[socialWebhook] Routing to handleWhatsAppWebhook');
      await handleWhatsAppWebhook(body);
      return;
    }

    const igBusinessId = await getSetting('meta_ig_business_id', null);
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

// Processes direct WhatsApp Cloud API webhook events (body.object === 'whatsapp_business_account').
// Receives inbound messages, pautas (Meta Ads referral with copy, headline, source_url, image),
// media attachments (photos, voice notes, PDFs), OCR receipts and delivery statuses (sent/delivered/read).
async function handleWhatsAppWebhook(body) {
  if (!Array.isArray(body?.entry)) return;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      // Identify which active line this belongs to in the CRM
      const { rows: lineRows } = await pool.query(
        `SELECT id, label, branch_id, access_token_enc
         FROM whatsapp_numbers
         WHERE phone_number_id = $1 AND is_active = true
         LIMIT 1`,
        [phoneNumberId]
      );

      if (!lineRows.length) {
        console.warn(`WhatsApp webhook received for unregistered or inactive phone_number_id: ${phoneNumberId}`);
        continue;
      }

      const line = lineRows[0];
      const lineToken = decryptToken(line.access_token_enc);
      console.log(`[handleWhatsAppWebhook] Event for line "${line.label}" (id: ${line.id}, phone_number_id: ${phoneNumberId})`);

      // 1. Process delivery statuses (sent, delivered, read, failed)
      if (Array.isArray(value.statuses)) {
        for (const st of value.statuses) {
          const wamid = st.id;
          const status = st.status;
          const errorMsg = st.errors?.[0]?.message || st.errors?.[0]?.title || null;
          await updateMessageStatus({ wamid, status, error: errorMsg }).catch((err) =>
            console.error('WhatsApp status update error', err)
          );
        }
      }

      // 2. Process inbound messages
      if (Array.isArray(value.messages)) {
        const contactProfile = value.contacts?.[0]?.profile?.name || null;

        for (const msg of value.messages) {
          const fromPhone = msg.from;
          const wamid = msg.id;
          if (!fromPhone || !wamid) continue;
          console.log(`[handleWhatsAppWebhook] Inbound msg from ${fromPhone}, wamid: ${wamid}, type: ${msg.type}`);

          // Deduplication: if message with this wamid was already stored, skip
          const { rows: existingMsg } = await pool.query(
            `SELECT id FROM n8n_chat_histories WHERE message->'additional_kwargs'->>'wamid' = $1 LIMIT 1`,
            [wamid]
          );
          if (existingMsg.length) continue;

          // 2.1 Ensure Customer
          const { rows: custRows } = await pool.query(
            `INSERT INTO customers (whatsapp_number, full_name)
             VALUES ($1, $2)
             ON CONFLICT (whatsapp_number) DO UPDATE
               SET full_name = COALESCE(customers.full_name, EXCLUDED.full_name)
             RETURNING id, full_name`,
            [fromPhone, contactProfile]
          );
          const customer = custRows[0];

          // 2.2 Ensure Ticket with whatsapp_number_id tied to this specific line
          const { rows: openTickets } = await pool.query(
            `SELECT id, whatsapp_number_id FROM tickets
             WHERE customer_id = $1 AND status != 'resuelto' AND (whatsapp_number_id = $2 OR whatsapp_number_id IS NULL)
             ORDER BY created_at DESC LIMIT 1`,
            [customer.id, line.id]
          );
          let ticketId;
          if (openTickets.length) {
            ticketId = openTickets[0].id;
            if (openTickets[0].whatsapp_number_id !== line.id) {
              await pool.query(`UPDATE tickets SET whatsapp_number_id = $1 WHERE id = $2`, [line.id, ticketId]);
            }
          } else {
            const { rows: newTk } = await pool.query(
              `INSERT INTO tickets (customer_id, whatsapp_number_id, status, handoff_reason)
               VALUES ($1, $2, 'esperando_asesor', 'mensaje_entrante_whatsapp')
               RETURNING id`,
              [customer.id, line.id]
            );
            ticketId = newTk[0].id;
          }

          // 2.3 Parse message type, context and Meta Ads referral (pautas)
          const replyToWamid = msg.context?.id || null;
          const referral = msg.referral || null;
          const msgType = msg.type || 'text';

          let content = '';
          let isMedia = false;
          let mediaInfo = null;

          if (msgType === 'text') {
            content = msg.text?.body || '';
          } else if (['image', 'audio', 'voice', 'document', 'video', 'sticker'].includes(msgType)) {
            isMedia = true;
            const mData = msg[msgType] || {};
            mediaInfo = {
              mediaId: mData.id,
              mimeType: mData.mime_type,
              caption: mData.caption || '',
              filename: mData.filename || (msgType === 'image' || msgType === 'sticker' ? 'imagen.jpg' : (msgType === 'audio' || msgType === 'voice') ? 'audio.ogg' : 'documento'),
              kind: (msgType === 'image' || msgType === 'sticker') ? 'image' : (msgType === 'audio' || msgType === 'voice') ? 'audio' : 'document',
            };
            content = mediaInfo.caption;
          } else if (msgType === 'location') {
            content = `📍 Ubicación: https://www.google.com/maps?q=${msg.location?.latitude},${msg.location?.longitude}`;
          } else if (msgType === 'contacts') {
            const names = msg.contacts?.map((c) => c.name?.formatted_name || c.phones?.[0]?.phone).filter(Boolean).join(', ');
            content = `👤 Contacto compartido: ${names || 'Contacto'}`;
          } else if (msgType === 'reaction') {
            const emoji = msg.reaction?.emoji;
            const targetWamid = msg.reaction?.message_id;
            if (emoji && targetWamid) {
              await pool.query(
                `UPDATE n8n_chat_histories
                 SET message = jsonb_set(message, '{additional_kwargs,reaction}', to_jsonb($2::text))
                 WHERE message->'additional_kwargs'->>'wamid' = $1`,
                [targetWamid, emoji]
              );
              await pool.query(`SELECT pg_notify('message_changes', json_build_object('session_id', $1::text)::text)`, [fromPhone]);
              continue;
            }
          } else {
            content = `[Mensaje tipo: ${msgType}]`;
          }

          const additional_kwargs = {
            wamid,
            ...(replyToWamid ? { replyToWamid } : {}),
            ...(referral ? { referral } : {}),
          };

          const messageObj = {
            type: 'human',
            content,
            additional_kwargs,
            response_metadata: {},
          };

          const { rows: insertedMsg } = await pool.query(
            `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb) RETURNING id`,
            [fromPhone, JSON.stringify(messageObj)]
          );
          const inboundMessageId = insertedMsg[0].id;

          // 2.4 If media, download buffer from Meta Graph API using line's token and store attachment
          if (isMedia && mediaInfo?.mediaId && lineToken) {
            try {
              const { buffer, mimeType: downloadedMime } = await whatsapp.downloadMedia(mediaInfo.mediaId, lineToken);
              let finalBuffer = buffer;
              let storedMime = downloadedMime || mediaInfo.mimeType || 'application/octet-stream';

              if (mediaInfo.kind === 'image') {
                const compressed = await compressImageBuffer(buffer).catch((err) => {
                  console.error('WhatsApp image compression failed', err);
                  return null;
                });
                if (compressed) { finalBuffer = compressed; storedMime = 'image/jpeg'; }
              } else if (storedMime === 'application/pdf') {
                const compressed = await compressPdfBuffer(buffer).catch((err) => {
                  console.error('WhatsApp PDF compression failed', err);
                  return null;
                });
                if (compressed) finalBuffer = compressed;
              }

              await saveAttachment({
                n8nMessageId: inboundMessageId,
                kind: mediaInfo.kind,
                filename: mediaInfo.filename,
                mimeType: storedMime,
                buffer: finalBuffer,
              });

              // Process payment receipt OCR if it's an image
              if (mediaInfo.kind === 'image') {
                processInboundImageOcr({ buffer: finalBuffer, phone: fromPhone, inboundMessageId })
                  .catch((err) => console.error('WhatsApp OCR processing error', err));
              }
            } catch (mediaErr) {
              console.error(`Error downloading media ${mediaInfo.mediaId} for WhatsApp message ${wamid}:`, mediaErr);
            }
          }
        }
      }
    }
  }
}

export default router;

