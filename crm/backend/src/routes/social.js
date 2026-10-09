// CRM-facing routes for the Instagram/Messenger inbox — deliberately simple, no Pipeline
// stages/temperature/SLA concepts (those don't exist for a social contact yet, see the
// 2026-09-14 plan). Logged-in advisors/admins only, same as conversations.js.
import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import {
  sendMessengerText,
  sendInstagramText,
  sendSocialAttachment,
  fetchProfileName,
  fetchMessageMediaFromGraph,
  fetchAdCreative,
} from '../metaMessaging.js';
import { logBusinessAction } from '../auditLog.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';
import { saveAttachment, isAllowedAttachmentMime } from '../attachmentStorage.js';
import { MIME_KIND } from './conversations.js';
import { broadcast } from '../events.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, isAllowedAttachmentMime(file.mimetype)),
});

const router = Router();

async function syncMissingProfiles() {
  try {
    const { rows } = await pool.query(`
      SELECT sc.id, sc.provider, sc.external_id, sc.customer_id
      FROM social_contacts sc
      WHERE sc.display_name IS NULL OR sc.display_name = ''
      LIMIT 10
    `);
    for (const c of rows) {
      const profile = await fetchProfileName(c.external_id, c.provider);
      if (profile?.displayName) {
        await pool.query(
          `UPDATE social_contacts SET display_name = $1, profile_pic_url = COALESCE($2, profile_pic_url) WHERE id = $3`,
          [profile.displayName, profile.profilePicUrl, c.id]
        );
        if (c.customer_id) {
          await pool.query(
            `UPDATE customers SET full_name = $1 WHERE id = $2 AND (full_name IS NULL OR full_name = '' OR full_name LIKE 'Contacto de %')`,
            [profile.displayName, c.customer_id]
          );
        }
      }
    }
  } catch (err) {
    console.warn('syncMissingProfiles background failed:', err.message);
  }
}

router.get('/contacts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.id, sc.provider, sc.external_id, sc.display_name, sc.profile_pic_url,
             sc.last_message_at, sc.unread_count,
             sm.body AS last_message_body, sm.direction AS last_message_direction
      FROM social_contacts sc
      LEFT JOIN LATERAL (
        SELECT body, direction FROM social_messages
        WHERE contact_id = sc.id ORDER BY created_at DESC LIMIT 1
      ) sm ON true
      ORDER BY sc.last_message_at DESC NULLS LAST
    `);

    if (rows.some((r) => !r.display_name)) {
      syncMissingProfiles().catch(() => {});
    }

    res.json(rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      externalId: r.external_id,
      displayName: r.display_name,
      profilePicUrl: r.profile_pic_url,
      lastMessageAt: r.last_message_at,
      unreadCount: r.unread_count,
      lastMessage: r.last_message_body,
      lastMessageDirection: r.last_message_direction,
    })));
  } catch (err) { next(err); }
});

router.post('/sync-profiles', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.id, sc.provider, sc.external_id, sc.customer_id
      FROM social_contacts sc
      WHERE sc.display_name IS NULL OR sc.display_name = '' OR sc.display_name LIKE 'Contacto de %'
      LIMIT 50
    `);
    let updated = 0;
    for (const c of rows) {
      const profile = await fetchProfileName(c.external_id, c.provider);
      if (profile?.displayName) {
        await pool.query(
          `UPDATE social_contacts SET display_name = $1, profile_pic_url = COALESCE($2, profile_pic_url) WHERE id = $3`,
          [profile.displayName, profile.profilePicUrl, c.id]
        );
        if (c.customer_id) {
          await pool.query(
            `UPDATE customers SET full_name = $1 WHERE id = $2`,
            [profile.displayName, c.customer_id]
          );
        }
        updated++;
      }
    }
    res.json({ checked: rows.length, updated });
  } catch (err) { next(err); }
});

router.get('/contacts/:id/messages', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT sm.id, sm.direction, sm.body, sm.raw_payload, sm.external_message_id, sm.created_at,
              ma.id AS attachment_id, ma.kind AS attachment_kind, ma.filename AS attachment_filename,
              ma.mime_type AS attachment_mime_type, ma.size_bytes AS attachment_size_bytes
       FROM social_messages sm
       LEFT JOIN message_attachments ma ON ma.social_message_id = sm.id
       WHERE sm.contact_id = $1
       ORDER BY sm.created_at ASC`,
      [req.params.id]
    );
    // Opening the thread marks it read
    await pool.query(`UPDATE social_contacts SET unread_count = 0 WHERE id = $1`, [req.params.id]);
    await pool.query(
      `UPDATE customers SET has_unread = false WHERE id = (SELECT customer_id FROM social_contacts WHERE id = $1)`,
      [req.params.id]
    );
    // Group rows by message ID to cleanly support multiple attachments per message
    const messagesMap = new Map();
    for (const r of rows) {
      if (!messagesMap.has(r.id)) {
        messagesMap.set(r.id, {
          id: r.id,
          direction: r.direction,
          body: r.body,
          raw_payload: r.raw_payload,
          external_message_id: r.external_message_id,
          createdAt: r.created_at,
          attachments: [],
        });
      }
      if (r.attachment_id) {
        messagesMap.get(r.id).attachments.push({
          id: r.attachment_id,
          kind: r.attachment_kind,
          filename: r.attachment_filename,
          mimeType: r.attachment_mime_type,
          sizeBytes: r.attachment_size_bytes,
        });
      }
    }

    const messagesList = Array.from(messagesMap.values());
    console.log(`[social messages] contactId=${req.params.id} count=${messagesList.length}:`, messagesList.map((m) => ({
      id: m.id,
      extId: m.external_message_id,
      body: m.body,
      rawKeys: m.raw_payload ? Object.keys(typeof m.raw_payload === 'string' ? JSON.parse(m.raw_payload) : m.raw_payload) : null,
    })));

    const enrichedMessages = await Promise.all(messagesList.map(async (msg) => {
      let story = null;
      let referral = null;
      let attachments = [...msg.attachments];

      if (msg.raw_payload) {
        try {
          const p = typeof msg.raw_payload === 'string' ? JSON.parse(msg.raw_payload) : msg.raw_payload;

          // 1. Check for story reply or mention (Instagram & Facebook stories)
          const replyStory = p?.message?.reply_to?.story;
          const mentionStory = p?.message?.story?.mention;
          if (replyStory) {
            story = {
              id: replyStory.id || null,
              url: replyStory.url || null,
              type: 'reply',
              title: 'Respondió a tu historia',
            };
          } else if (mentionStory) {
            story = {
              id: mentionStory.id || null,
              url: mentionStory.link || null,
              type: 'mention',
              title: 'Te mencionó en una historia',
            };
          }

          // 2. Check for referral (Meta Ads / Messenger Ads / Instagram Ads / Shortlink)
          const ref = p?.message?.referral || p?.referral || p?.postback?.referral;
          if (ref) {
            const photoUrl = ref.ads_context_data?.photo_url
              || ref.ads_context_data?.image_url
              || ref.ads_context_data?.video_url
              || ref.photo_url
              || ref.image_url
              || ref.thumbnail_url
              || ref.ads_context_data?.thumbnail_url
              || null;

            referral = {
              ad_id: ref.ad_id || null,
              source: ref.source || 'ADS',
              headline: ref.ads_context_data?.ad_title || ref.ad_title || 'Publicidad de Meta',
              body: ref.ref || ref.ads_context_data?.ad_body || null,
              image_url: photoUrl,
              source_url: photoUrl,
            };
          }

          // 3. Check for shares (Facebook Post share, photo share, catalog product share)
          const shareItem = p?.message?.shares?.[0] || p?.shares?.[0];
          if (shareItem) {
            const sharePic = shareItem?.picture || shareItem?.image_url || shareItem?.thumbnail_url;
            if (!referral && (sharePic || shareItem?.link)) {
              referral = {
                ad_id: shareItem.id || null,
                source: 'FACEBOOK_SHARE',
                headline: shareItem.name || 'Publicación compartida',
                body: shareItem.description || null,
                image_url: sharePic || null,
                source_url: shareItem.link || null,
              };
            }
          }

          // 4. Fallback for incoming attachments from payload (images, carousels, catalog products, generic templates)
          if (attachments.length === 0) {
            const rawAtts = p?.message?.attachments || [];
            for (const att of rawAtts) {
              const attType = (att.type || 'image').toLowerCase();
              let directUrl = att.payload?.url || att.url;
              const el = att.payload?.elements?.[0];
              if (!directUrl && el) {
                directUrl = el.image_url || el.picture || el.thumbnail_url;
              }
              if (!directUrl && att.payload?.product) {
                directUrl = att.payload.product.image_url || att.payload.product.picture;
              }
              if (!directUrl && att.payload?.picture) {
                directUrl = att.payload.picture;
              }
              if (!directUrl && att.payload?.image_url) {
                directUrl = att.payload.image_url;
              }

              if (directUrl) {
                attachments.push({
                  id: null,
                  kind: attType === 'video' ? 'video' : attType === 'audio' ? 'audio' : 'image',
                  url: directUrl,
                  filename: att.title || el?.title || (attType === 'share' ? 'Publicación compartida' : (attType === 'fallback' ? 'Contenido compartido' : 'adjunto')),
                });
              }
            }
          }
        } catch {}
      }

      // If referral has ad_id but image_url is missing, fetch ad creative from Graph API
      if (referral?.ad_id && !referral.image_url) {
        try {
          const adCreative = await fetchAdCreative(referral.ad_id);
          if (adCreative?.imageUrl) {
            referral.image_url = adCreative.imageUrl;
            if (!referral.headline && adCreative.title) referral.headline = adCreative.title;
            if (!referral.body && adCreative.body) referral.body = adCreative.body;
          }
        } catch {}
      }

      // If inbound message has no media or referral, but has external_message_id, query Graph API for attachments/shares
      if (msg.direction === 'in' && !referral && attachments.length === 0 && msg.external_message_id) {
        try {
          const graphMedia = await fetchMessageMediaFromGraph(msg.external_message_id);
          if (graphMedia?.imageUrl) {
            referral = {
              ad_id: null,
              source: 'FACEBOOK_POST',
              headline: graphMedia.title || 'Referencia de Facebook',
              body: null,
              image_url: graphMedia.imageUrl,
              source_url: graphMedia.link || null,
            };
          }
        } catch {}
      }

      // If an ad image was persisted locally for this message, link it to referral.image_url
      if (referral && attachments.length > 0) {
        const savedAdImg = attachments.find((a) => a.filename === 'anuncio.jpg');
        if (savedAdImg?.id) {
          referral.image_url = `/api/attachments/${savedAdImg.id}/content`;
          attachments = attachments.filter((a) => a.id !== savedAdImg.id);
        }
      }

      return {
        id: msg.id,
        direction: msg.direction,
        body: msg.body,
        attachment: attachments[0] || null,
        attachments,
        story,
        referral,
        rawPayload: msg.raw_payload,
        createdAt: msg.createdAt,
      };
    }));

    res.json(enrichedMessages);
  } catch (err) { next(err); }
});

// Feeds Conversations.jsx's shared "Info del cliente" panel
router.get('/contacts/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT sc.display_name, sc.provider, sc.external_id, t.status AS ticket_status, t.assigned_advisor,
              t.handoff_reason,
              c.id AS customer_id, COALESCE(${EFFECTIVE_STATUS_SQL}, 'frio') AS temperature, c.manual_status,
              c.paid_locked, c.paid_method, c.dpi, c.email, c.department, c.municipio, c.address,
              c.preferred_line, c.preferred_size, c.birth_date, c.purchase_frequency, c.opted_out_campaigns
       FROM social_contacts sc
       LEFT JOIN customers c ON c.id = sc.customer_id
       LEFT JOIN LATERAL (
         SELECT status, assigned_advisor, handoff_reason FROM tickets WHERE customer_id = c.id
         ORDER BY created_at DESC LIMIT 1
       ) t ON true
       WHERE sc.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const r = rows[0];
    res.json({
      customerId: r.customer_id,
      customerName: r.display_name,
      channel: r.provider,
      externalId: r.external_id,
      phone: r.external_id,
      temperature: r.temperature,
      manualStatus: r.manual_status,
      paidLocked: r.paid_locked ?? false,
      paidMethod: r.paid_method,
      ticketStatus: r.ticket_status,
      assignedAdvisor: r.assigned_advisor,
      handoffReason: r.handoff_reason,
      dpi: r.dpi,
      email: r.email,
      department: r.department,
      municipio: r.municipio,
      address: r.address,
      preferredLine: r.preferred_line,
      preferredSize: r.preferred_size,
      birthDate: r.birth_date,
      purchaseFrequency: r.purchase_frequency,
      optedOutCampaigns: r.opted_out_campaigns ?? false,
      enAtencion: r.ticket_status === 'en_atencion' || r.ticket_status === 'resuelto',
    });
  } catch (err) { next(err); }
});

router.post('/contacts/:id/messages', upload.single('file'), async (req, res, next) => {
  try {
    const body = (req.body?.body ?? req.body?.caption ?? '').trim();
    const hasFile = !!req.file;
    if (!body && !hasFile) return res.status(400).json({ error: 'Mensaje o archivo requerido' });

    const { rows: contactRows } = await pool.query(`SELECT provider, external_id, customer_id FROM social_contacts WHERE id = $1`, [req.params.id]);
    if (!contactRows.length) return res.status(404).json({ error: 'not found' });
    const { provider, external_id: externalId, customer_id: customerId } = contactRows[0];

    let externalMessageId = null;
    let savedAttachmentId = null;
    let attachmentMeta = null;

    try {
      if (hasFile) {
        const kind = MIME_KIND(req.file.mimetype);
        const result = await sendSocialAttachment({
          recipientId: externalId,
          fileBuffer: req.file.buffer,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
        });
        externalMessageId = result?.message_id ?? null;

        savedAttachmentId = await saveAttachment({
          n8nMessageId: null,
          kind,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          buffer: req.file.buffer,
        });
        attachmentMeta = {
          id: savedAttachmentId,
          kind,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.buffer.length,
        };

        // If caption was also provided, send as accompanying text
        if (body) {
          const send = provider === 'instagram' ? sendInstagramText : sendMessengerText;
          await send(externalId, body).catch((err) => console.warn('Caption send error:', err.message));
        }
      } else {
        const send = provider === 'instagram' ? sendInstagramText : sendMessengerText;
        const result = await send(externalId, body);
        externalMessageId = result?.message_id ?? null;
      }
    } catch (err) {
      console.error(`[social send error] provider=${provider} recipient=${externalId}:`, err);
      let friendlyError = err.message;
      try {
        const jsonMatch = err.message.match(/\{.*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed?.error?.message) {
            friendlyError = `Meta: ${parsed.error.message}`;
          }
        }
      } catch {}
      return res.status(502).json({ error: friendlyError });
    }

    const { rows } = await pool.query(
      `INSERT INTO social_messages (contact_id, direction, body, external_message_id)
       VALUES ($1, 'out', $2, $3) RETURNING id, created_at`,
      [req.params.id, body || (hasFile ? `[${req.file.originalname}]` : ''), externalMessageId]
    );
    const messageId = rows[0].id;

    if (savedAttachmentId) {
      await pool.query(
        `UPDATE message_attachments SET social_message_id = $1 WHERE id = $2`,
        [messageId, savedAttachmentId]
      );
    }

    await pool.query(`UPDATE social_contacts SET last_message_at = now() WHERE id = $1`, [req.params.id]);
    if (customerId) {
      await pool.query(
        `UPDATE customers SET last_message_at = now(), last_message = $1, awaiting_reply = false WHERE id = $2`,
        [body || (hasFile ? `[Archivo]` : ''), customerId]
      );
    }

    broadcast('social_message_changes', JSON.stringify({
      contactId: Number(req.params.id),
      provider,
      messageId,
    }));
    broadcast('message_changes', JSON.stringify({
      session_id: `social:${req.params.id}`,
      phone: `social:${req.params.id}`,
    }));

    logBusinessAction(req.user, customerId ?? null, 'social_message_sent', `${provider}:${externalId}`);
    res.status(201).json({
      id: messageId,
      direction: 'out',
      body: body || '',
      attachment: attachmentMeta,
      createdAt: rows[0].created_at,
    });
  } catch (err) { next(err); }
});

export default router;
