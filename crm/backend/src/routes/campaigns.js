import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import multer from 'multer';
import { pool } from '../db.js';
import * as whatsapp from '../whatsapp.js';
import { EFFECTIVE_STATUS_SQL, VALID_TEMPERATURES } from './customers.js';
import { findConversationThread } from './conversations.js';
import { writeAttachmentFile, linkExistingFile } from '../attachmentStorage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Maps an opaque upload token to the file this backend itself wrote to disk. Never let
// a client hand back a raw file path to store in message_attachments — GET
// /api/attachments/:id/file streams whatever path is in that row with no extra checks,
// so a client-controlled path there is an arbitrary-file-read hole. The token is the
// only thing that crosses back over HTTP; the real path never leaves the server.
// ponytail: in-process Map, single instance only, entries never expire — fine at the
// volume this shop sends (a handful of uploads a day), revisit if that changes.
const headerUploads = new Map();

// Single word to plug into a template's name parameter when the customer never gave
// one — most of the customer base didn't (see the reactivation-template fix). Kept in
// one place, on-brand for a women's fashion shop, so it reads naturally in any current
// or future template rather than a word chosen for one specific message.
const FALLBACK_TEMPLATE_NAME = 'amiga';

function firstName(fullName) {
  return fullName?.trim().split(/\s+/)[0] || null;
}

// A number that already got a broadcast recently shouldn't get another one — that's how
// the same pauta ends up repeated on the same person. Only broadcast sends count here
// (regular conversation stays open); campaign sends are already tagged with campaignId,
// so this only ever scans that (small, indexed) subset of the table, not all of it.
const COOLDOWN_HOURS = 42;
async function getCooldownMap() {
  const { rows } = await pool.query(
    `SELECT split_part(session_id, '__', 1) AS phone, max(created_at) AS last_sent
     FROM n8n_chat_histories
     WHERE message->'additional_kwargs'->>'campaignId' IS NOT NULL
       -- A send that failed (at dispatch, or later via the delivery-status webhook)
       -- never reached the customer, so it shouldn't block a retry for 42h.
       AND coalesce(message->'additional_kwargs'->>'status', '') <> 'failed'
       AND created_at > now() - interval '${COOLDOWN_HOURS} hours'
     GROUP BY phone`
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.phone, new Date(new Date(r.last_sent).getTime() + COOLDOWN_HOURS * 3600 * 1000));
  }
  return map;
}

// A template's body can carry {{1}}, {{2}}... in order — this app only ever fills them
// all with the same value (the customer's name), which covers every template in use
// today. A template needing distinct values per placeholder (e.g. name + order number)
// isn't supported yet; that needs a real per-field mapping, not guessed here.
function countBodyParams(template) {
  const body = template.components?.find((c) => c.type === 'BODY')?.text ?? '';
  const matches = body.match(/\{\{\d+\}\}/g);
  return matches ? new Set(matches).size : 0;
}

// Meta rejects the send outright if the template defines a media header and none is
// attached — "(#132012) ... expected IMAGE, received UNKNOWN" — so the picker needs to
// know up front whether it has to ask for one. Only IMAGE is supported for now; a
// VIDEO/DOCUMENT header template will show clearly as unsupported rather than fail
// silently at send time.
function getHeaderFormat(template) {
  return template.components?.find((c) => c.type === 'HEADER')?.format ?? null;
}

router.get('/templates', async (req, res, next) => {
  try {
    const templates = await whatsapp.listTemplates();
    res.json(
      templates
        .filter((t) => t.status === 'APPROVED')
        .map((t) => ({
          name: t.name,
          language: t.language,
          category: t.category,
          body: t.components?.find((c) => c.type === 'BODY')?.text ?? '',
          paramCount: countBodyParams(t),
          headerFormat: getHeaderFormat(t),
        }))
    );
  } catch (err) { next(err); }
});

// Uploaded once per campaign, not once per recipient — the resulting media id is valid
// for 30 days and Meta allows reusing it across every send in the batch.
router.post('/header-media', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const mediaId = await whatsapp.uploadMedia(req.file.buffer, req.file.mimetype);
    // Also kept on our own disk (separately from Meta's copy) so the CRM can show the
    // same image inline in the conversation thread, the same way any other attachment
    // renders — Meta's media id isn't fetchable back out to display in our own UI.
    const filePath = await writeAttachmentFile(req.file.buffer);
    const token = crypto.randomUUID();
    headerUploads.set(token, {
      filePath, mimeType: req.file.mimetype, filename: req.file.originalname, sizeBytes: req.file.buffer.length,
    });
    res.json({ mediaId, headerImageToken: token });
  } catch (err) { next(err); }
});

// Powers both "cuántos hay disponibles" before sending and the manual add-by-search box.
router.get('/audience', async (req, res, next) => {
  try {
    const { temperature, q } = req.query;
    if (temperature && !VALID_TEMPERATURES.includes(temperature)) {
      return res.status(400).json({ error: 'invalid temperature' });
    }
    const params = [];
    const clauses = [];
    if (temperature) { params.push(temperature); clauses.push(`(${EFFECTIVE_STATUS_SQL}) = $${params.length}`); }
    if (q?.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      clauses.push(`(lower(c.full_name) LIKE $${params.length} OR c.whatsapp_number LIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.full_name, c.whatsapp_number, (${EFFECTIVE_STATUS_SQL}) AS temperature
       FROM customers c
       ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
       ORDER BY c.full_name NULLS LAST
       LIMIT 200`,
      params
    );
    const cooldown = await getCooldownMap();
    // The temperature-only pool (no q) is what feeds the "X disponibles" count — that
    // count needs to already exclude cooldown numbers, since POST / backfills around
    // them too. A manual name/phone search (q) keeps a cooling-down person visible but
    // flagged, so the picker can explain why it won't let them be added.
    const withCooldown = rows.map((r) => ({
      id: r.id, fullName: r.full_name, phone: r.whatsapp_number, temperature: r.temperature,
      cooldownUntil: cooldown.get(r.whatsapp_number)?.toISOString() ?? null,
    }));
    res.json(temperature && !q?.trim() ? withCooldown.filter((r) => !r.cooldownUntil) : withCooldown);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ca.*,
              (SELECT count(*) FROM n8n_chat_histories h WHERE h.message->'additional_kwargs'->>'campaignId' = ca.id::text) AS sent_count,
              (SELECT count(*) FROM n8n_chat_histories h WHERE h.message->'additional_kwargs'->>'campaignId' = ca.id::text
                 AND h.message->'additional_kwargs'->>'status' IN ('delivered','read')) AS delivered_count,
              (SELECT count(*) FROM n8n_chat_histories h WHERE h.message->'additional_kwargs'->>'campaignId' = ca.id::text
                 AND h.message->'additional_kwargs'->>'status' = 'read') AS read_count,
              (SELECT count(*) FROM n8n_chat_histories h WHERE h.message->'additional_kwargs'->>'campaignId' = ca.id::text
                 AND h.message->'additional_kwargs'->>'status' = 'failed') AS failed_count
       FROM campaigns ca ORDER BY ca.created_at DESC LIMIT 100`
    );
    res.json(rows.map((r) => ({
      id: r.id,
      templateName: r.template_name,
      temperature: r.temperature,
      requestedCount: r.requested_count,
      recipientCount: r.recipient_count,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      sentCount: Number(r.sent_count),
      deliveredCount: Number(r.delivered_count),
      readCount: Number(r.read_count),
      failedCount: Number(r.failed_count),
    })));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const campaign = rows[0];

    const { rows: recipients } = await pool.query(
      `SELECT h.session_id, h.created_at, h.message->'additional_kwargs' AS kwargs,
              c.id AS customer_id, c.full_name, c.whatsapp_number
       FROM n8n_chat_histories h
       LEFT JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
       WHERE h.message->'additional_kwargs'->>'campaignId' = $1
       ORDER BY h.id ASC`,
      [String(campaign.id)]
    );

    res.json({
      id: campaign.id,
      templateName: campaign.template_name,
      temperature: campaign.temperature,
      requestedCount: campaign.requested_count,
      recipientCount: campaign.recipient_count,
      status: campaign.status,
      createdBy: campaign.created_by,
      createdAt: campaign.created_at,
      completedAt: campaign.completed_at,
      recipients: recipients.map((r) => ({
        customerName: r.full_name,
        phone: r.whatsapp_number ?? r.session_id.split('__')[0],
        status: r.kwargs?.status ?? 'sent',
        statusError: r.kwargs?.statusError ?? null,
        sentAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// Re-sends only the recipients still marked failed — updates their existing row in place
// (not a new one) so campaign counts stay one-row-per-recipient instead of double
// counting a retried customer. The header image, if any, is pulled back off disk from
// whichever recipient's message_attachments row already has it (linkExistingFile ran for
// every recipient, success or fail) and re-uploaded fresh, since the original Meta media
// id was never persisted and headerUploads is only an in-process, short-lived map.
router.post('/:id/retry-failed', async (req, res, next) => {
  try {
    const { rows: campaignRows } = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
    if (!campaignRows.length) return res.status(404).json({ error: 'not found' });
    const campaign = campaignRows[0];

    const resolved = await resolveTemplate(campaign.template_name, campaign.template_language);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { paramCount, headerFormat, bodyTemplate } = resolved;

    const { rows: failed } = await pool.query(
      `SELECT h.id, h.session_id, c.full_name,
              coalesce(c.whatsapp_number, split_part(h.session_id, '__', 1)) AS phone
       FROM n8n_chat_histories h
       LEFT JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
       WHERE h.message->'additional_kwargs'->>'campaignId' = $1
         AND h.message->'additional_kwargs'->>'status' = 'failed'`,
      [String(campaign.id)]
    );
    if (!failed.length) return res.status(400).json({ error: 'No hay envíos fallidos en esta difusión' });

    let headerMediaId = null;
    if (headerFormat === 'IMAGE') {
      const { rows: attRows } = await pool.query(
        `SELECT a.file_path, a.mime_type FROM message_attachments a
         JOIN n8n_chat_histories h ON h.id = a.n8n_message_id
         WHERE h.message->'additional_kwargs'->>'campaignId' = $1 LIMIT 1`,
        [String(campaign.id)]
      );
      if (!attRows.length) {
        return res.status(400).json({ error: 'No se encontró la imagen original de esta difusión — no se puede reintentar' });
      }
      const buffer = await fs.promises.readFile(attRows[0].file_path);
      headerMediaId = await whatsapp.uploadMedia(buffer, attRows[0].mime_type);
    }

    // Same respond-then-background pattern as a fresh send — the campaign detail view
    // is already SSE-driven, so each recipient's status flips live as retries land.
    retryFailedRecipients(campaign.id, failed, campaign.template_name, campaign.template_language, bodyTemplate, paramCount, headerMediaId).catch((err) =>
      console.error(`campaign ${campaign.id} retry batch failed`, err)
    );

    res.json({ retrying: failed.length });
  } catch (err) { next(err); }
});

// A batch send is throttled to one every ~350ms rather than fired all at once — Meta
// rate-limits bursts, and blasting them concurrently is also how a number's quality
// rating takes a hit. Fine for the volumes this shop sends today.
// ponytail: no persistence of "how far the batch got" — a restart mid-send drops the
// rest of the batch silently. The orphan-recovery sweep does not cover this path since
// these rows are tagged sentBy: 'campaign', not 'advisor'. Acceptable while campaigns
// are small and rare; revisit if they become a daily habit.
const SEND_DELAY_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Renders the literal text sent — {{1}}, {{2}}... all filled with the same name, same
// as the params array built for the actual API call — so the thread shows what the
// customer really received instead of the bare template name.
function renderBody(bodyTemplate, name) {
  return bodyTemplate.replace(/\{\{\d+\}\}/g, name);
}

async function sendToRecipient(campaignId, customer, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment) {
  const name = firstName(customer.full_name) || FALLBACK_TEMPLATE_NAME;
  const params = Array(paramCount).fill(name);
  let sentWamid = null;
  let error = null;
  try {
    const result = await whatsapp.sendTemplate(customer.whatsapp_number, templateName, templateLanguage, params, headerMediaId);
    sentWamid = result?.messages?.[0]?.id ?? null;
    if (!sentWamid) error = 'WhatsApp no devolvió un id de mensaje — el envío no se confirmó';
  } catch (err) {
    error = err.message;
  }
  // The catch in runCampaign's loop never fires — this never throws, it records the
  // failure and returns normally — so without this the real reason only ever reached
  // the database (statusError), never the console, making a genuine send failure look
  // like nothing happened at all when someone checked the logs instead of the tooltip.
  if (error) console.error(`campaign ${campaignId} send to ${customer.whatsapp_number} failed:`, error);

  const { sessionIds } = await findConversationThread(customer.whatsapp_number);
  const sessionId = sessionIds?.[0] ?? customer.whatsapp_number;
  const message = {
    type: 'ai',
    content: renderBody(bodyTemplate, name),
    additional_kwargs: {
      sentBy: 'campaign',
      campaignId: String(campaignId),
      ...(sentWamid ? { wamid: sentWamid } : { status: 'failed', statusError: error }),
    },
    response_metadata: {},
    tool_calls: [],
  };
  const { rows } = await pool.query(
    `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb) RETURNING id`,
    [sessionId, JSON.stringify(message)]
  );

  if (headerAttachment) {
    await linkExistingFile({
      n8nMessageId: rows[0].id,
      kind: 'image',
      filename: headerAttachment.filename,
      mimeType: headerAttachment.mimeType,
      filePath: headerAttachment.filePath,
      sizeBytes: headerAttachment.sizeBytes,
    });
  }
}

// Updates the recipient's existing row in place instead of inserting a new one — see the
// retry-failed route for why (avoids double-counting the recipient in campaign stats).
async function retryRecipient(messageId, sessionId, phone, fullName, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId) {
  const name = firstName(fullName) || FALLBACK_TEMPLATE_NAME;
  const params = Array(paramCount).fill(name);
  let sentWamid = null;
  let error = null;
  try {
    const result = await whatsapp.sendTemplate(phone, templateName, templateLanguage, params, headerMediaId);
    sentWamid = result?.messages?.[0]?.id ?? null;
    if (!sentWamid) error = 'WhatsApp no devolvió un id de mensaje — el envío no se confirmó';
  } catch (err) {
    error = err.message;
  }
  if (error) console.error(`campaign retry message ${messageId} to ${phone} failed:`, error);

  const { rows } = await pool.query(`SELECT message FROM n8n_chat_histories WHERE id = $1`, [messageId]);
  const prev = rows[0]?.message;
  if (!prev) return false;
  const message = {
    ...prev,
    content: renderBody(bodyTemplate, name),
    additional_kwargs: {
      sentBy: 'campaign',
      campaignId: prev.additional_kwargs?.campaignId,
      ...(sentWamid ? { wamid: sentWamid } : { status: 'failed', statusError: error }),
    },
  };
  await pool.query(`UPDATE n8n_chat_histories SET message = $2::jsonb WHERE id = $1`, [messageId, JSON.stringify(message)]);
  // session_id (not the row id) is what listener.js reads to flush anything an advisor
  // had queued for this same customer, same as every other message-mutating route.
  await pool.query(`SELECT pg_notify('message_changes', json_build_object('session_id', $1::text)::text)`, [sessionId]);
  return !!sentWamid;
}

async function retryFailedRecipients(campaignId, failed, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId) {
  for (const r of failed) {
    await retryRecipient(r.id, r.session_id, r.phone, r.full_name, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId).catch((err) =>
      console.error(`campaign ${campaignId} retry recipient ${r.id} failed`, err)
    );
    await sleep(SEND_DELAY_MS);
  }
}

async function runCampaign(campaignId, audience, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment) {
  for (const customer of audience) {
    await sendToRecipient(campaignId, customer, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment).catch((err) =>
      console.error(`campaign ${campaignId} recipient ${customer.id} failed`, err)
    );
    await sleep(SEND_DELAY_MS);
  }
  await pool.query(`UPDATE campaigns SET status = 'completed', completed_at = now() WHERE id = $1`, [campaignId]);
}

// 7-15 digits covers bare local numbers up through full E.164 — same rule
// findConversationThread() uses to recognise a phone as a phone.
const PHONE_RE = /^\d{7,15}$/;

// Shared by a fresh send and a retry — re-checked against Meta both times, not just
// trusted from the templates screen, since a template can be paused or fail review
// between when the tab loaded and when send is clicked (or between the original send
// and a retry days later).
async function resolveTemplate(templateName, templateLanguage) {
  const templates = await whatsapp.listTemplates();
  const template = templates.find((t) => t.name === templateName && t.language === templateLanguage);
  if (!template) return { error: 'La plantilla no existe o cambió' };
  if (template.status !== 'APPROVED') return { error: 'La plantilla no está activa en este momento' };
  const headerFormat = getHeaderFormat(template);
  if (headerFormat && headerFormat !== 'IMAGE') {
    return { error: `Las plantillas con encabezado de tipo ${headerFormat} todavía no están soportadas` };
  }
  return {
    template, headerFormat, paramCount: countBodyParams(template),
    bodyTemplate: template.components?.find((c) => c.type === 'BODY')?.text ?? '',
  };
}

router.post('/', async (req, res, next) => {
  try {
    const { templateName, templateLanguage, temperature, count, order, customerIds, newRecipients, headerMediaId, headerImageToken } = req.body ?? {};
    if (!templateName?.trim() || !templateLanguage?.trim()) {
      return res.status(400).json({ error: 'templateName and templateLanguage required' });
    }
    if (Array.isArray(newRecipients)) {
      const bad = newRecipients.filter((r) => !PHONE_RE.test(String(r.phone ?? '').trim()));
      if (bad.length) return res.status(400).json({ error: `Número inválido: ${bad.map((r) => r.phone).join(', ')}` });
    }
    if (temperature && !VALID_TEMPERATURES.includes(temperature)) {
      return res.status(400).json({ error: 'invalid temperature' });
    }
    const sortOrder = order === 'oldest' ? 'ASC' : 'DESC';

    const resolved = await resolveTemplate(templateName, templateLanguage);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { paramCount, headerFormat, bodyTemplate } = resolved;
    if (headerFormat === 'IMAGE' && !headerMediaId) {
      return res.status(400).json({ error: 'Esta plantilla necesita una imagen de encabezado — súbela antes de enviar' });
    }
    // The token only ever resolves to a file this backend itself wrote — see the
    // headerUploads comment above for why a client-supplied path is never trusted here.
    const headerAttachment = headerImageToken ? headerUploads.get(headerImageToken) : null;
    if (headerFormat === 'IMAGE' && !headerAttachment) {
      return res.status(400).json({ error: 'La imagen subida ya no está disponible — vuelve a subirla e intenta de nuevo' });
    }

    const cooldown = await getCooldownMap();
    const skippedCooldown = [];

    let audience = [];
    if (temperature) {
      // Excluded in SQL, before the LIMIT, so a number in cooldown gets skipped over in
      // favor of the next eligible one in the same order — not just a shorter batch.
      const cooldownPhones = [...cooldown.keys()];
      const { rows } = await pool.query(
        `SELECT c.id, c.full_name, c.whatsapp_number
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT max(h.created_at) AS last_seen FROM n8n_chat_histories h
           WHERE h.session_id LIKE c.whatsapp_number || '%' AND h.message->>'type' = 'human'
         ) act ON true
         WHERE (${EFFECTIVE_STATUS_SQL}) = $1
           AND NOT (c.whatsapp_number = ANY($3::text[]))
         ORDER BY act.last_seen ${sortOrder} NULLS LAST
         LIMIT $2`,
        [temperature, count && count > 0 ? count : 100000, cooldownPhones]
      );
      audience = rows;
    }

    if (Array.isArray(customerIds) && customerIds.length) {
      const { rows } = await pool.query(
        `SELECT id, full_name, whatsapp_number FROM customers WHERE id = ANY($1)`,
        [customerIds]
      );
      const seen = new Set(audience.map((c) => c.id));
      for (const c of rows) {
        if (seen.has(c.id)) continue;
        // A deliberate, one-off pick — skip and report it rather than silently sending
        // (or silently dropping), same as the manual-search picker already flags it.
        if (cooldown.has(c.whatsapp_number)) { skippedCooldown.push({ phone: c.whatsapp_number, fullName: c.full_name }); continue; }
        audience.push(c); seen.add(c.id);
      }
    }

    // A number typed in that isn't a customer yet — created the same way an advisor
    // starting a fresh conversation already creates one (see POST /api/conversations),
    // so it becomes a normal customer with a normal thread and temperature after this,
    // not a special one-off case the rest of the app doesn't know about. Existing
    // full_name is never overwritten — only filled in if it was empty.
    if (Array.isArray(newRecipients) && newRecipients.length) {
      const seen = new Set(audience.map((c) => c.id));
      for (const { phone, fullName } of newRecipients) {
        const trimmedPhone = String(phone).trim();
        if (cooldown.has(trimmedPhone)) { skippedCooldown.push({ phone: trimmedPhone, fullName: fullName?.trim() || null }); continue; }
        const { rows } = await pool.query(
          `INSERT INTO customers (whatsapp_number, full_name) VALUES ($1, $2)
           ON CONFLICT (whatsapp_number) DO UPDATE SET full_name = COALESCE(customers.full_name, EXCLUDED.full_name)
           RETURNING id, full_name, whatsapp_number`,
          [trimmedPhone, fullName?.trim() || null]
        );
        const c = rows[0];
        if (!seen.has(c.id)) { audience.push(c); seen.add(c.id); }
      }
    }

    if (!audience.length) {
      return res.status(400).json({
        error: skippedCooldown.length
          ? 'Todos los destinatarios seleccionados recibieron una difusión en las últimas 42 horas'
          : 'La audiencia quedó vacía',
      });
    }

    const { rows: created } = await pool.query(
      `INSERT INTO campaigns (template_name, template_language, temperature, requested_count, customer_ids, recipient_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [templateName, templateLanguage, temperature ?? null, count ?? null, audience.map((c) => c.id), audience.length, req.user.fullName]
    );
    const campaignId = created[0].id;

    // Same pattern as every other outbound send in this app: respond once the audience
    // is locked in and stored, then let the actual WhatsApp calls happen in the
    // background instead of holding the request open for what could be minutes.
    runCampaign(campaignId, audience, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment).catch((err) =>
      console.error(`campaign ${campaignId} failed`, err)
    );

    res.status(201).json({ id: campaignId, recipientCount: audience.length, skippedCooldown });
  } catch (err) { next(err); }
});

export default router;
