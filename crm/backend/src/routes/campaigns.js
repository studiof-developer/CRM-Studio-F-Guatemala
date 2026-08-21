import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import * as whatsapp from '../whatsapp.js';
import { EFFECTIVE_STATUS_SQL, VALID_TEMPERATURES } from './customers.js';
import { findConversationThread } from './conversations.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Single word to plug into a template's name parameter when the customer never gave
// one — most of the customer base didn't (see the reactivation-template fix). Kept in
// one place, on-brand for a women's fashion shop, so it reads naturally in any current
// or future template rather than a word chosen for one specific message.
const FALLBACK_TEMPLATE_NAME = 'amiga';

function firstName(fullName) {
  return fullName?.trim().split(/\s+/)[0] || null;
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
    res.json({ mediaId });
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
    res.json(rows.map((r) => ({ id: r.id, fullName: r.full_name, phone: r.whatsapp_number, temperature: r.temperature })));
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

// A batch send is throttled to one every ~350ms rather than fired all at once — Meta
// rate-limits bursts, and blasting them concurrently is also how a number's quality
// rating takes a hit. Fine for the volumes this shop sends today.
// ponytail: no persistence of "how far the batch got" — a restart mid-send drops the
// rest of the batch silently. The orphan-recovery sweep does not cover this path since
// these rows are tagged sentBy: 'campaign', not 'advisor'. Acceptable while campaigns
// are small and rare; revisit if they become a daily habit.
const SEND_DELAY_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendToRecipient(campaignId, customer, templateName, templateLanguage, paramCount, headerMediaId) {
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
    content: templateName,
    additional_kwargs: {
      sentBy: 'campaign',
      campaignId: String(campaignId),
      ...(sentWamid ? { wamid: sentWamid } : { status: 'failed', statusError: error }),
    },
    response_metadata: {},
    tool_calls: [],
  };
  await pool.query(`INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb)`, [sessionId, JSON.stringify(message)]);
}

async function runCampaign(campaignId, audience, templateName, templateLanguage, paramCount, headerMediaId) {
  for (const customer of audience) {
    await sendToRecipient(campaignId, customer, templateName, templateLanguage, paramCount, headerMediaId).catch((err) =>
      console.error(`campaign ${campaignId} recipient ${customer.id} failed`, err)
    );
    await sleep(SEND_DELAY_MS);
  }
  await pool.query(`UPDATE campaigns SET status = 'completed', completed_at = now() WHERE id = $1`, [campaignId]);
}

// 7-15 digits covers bare local numbers up through full E.164 — same rule
// findConversationThread() uses to recognise a phone as a phone.
const PHONE_RE = /^\d{7,15}$/;

router.post('/', async (req, res, next) => {
  try {
    const { templateName, templateLanguage, temperature, count, order, customerIds, newRecipients, headerMediaId } = req.body ?? {};
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

    // Re-checked against Meta here, not just trusted from the templates screen — a
    // template can be paused or fail review between when the tab loaded and when send
    // is clicked, and sending against a dead template would fail every single recipient.
    const templates = await whatsapp.listTemplates();
    const template = templates.find((t) => t.name === templateName && t.language === templateLanguage);
    if (!template) return res.status(400).json({ error: 'La plantilla no existe o cambió' });
    if (template.status !== 'APPROVED') return res.status(400).json({ error: 'La plantilla no está activa en este momento' });
    const paramCount = countBodyParams(template);

    const headerFormat = getHeaderFormat(template);
    if (headerFormat && headerFormat !== 'IMAGE') {
      return res.status(400).json({ error: `Las plantillas con encabezado de tipo ${headerFormat} todavía no están soportadas` });
    }
    if (headerFormat === 'IMAGE' && !headerMediaId) {
      return res.status(400).json({ error: 'Esta plantilla necesita una imagen de encabezado — súbela antes de enviar' });
    }

    let audience = [];
    if (temperature) {
      const { rows } = await pool.query(
        `SELECT c.id, c.full_name, c.whatsapp_number
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT max(h.created_at) AS last_seen FROM n8n_chat_histories h
           WHERE h.session_id LIKE c.whatsapp_number || '%' AND h.message->>'type' = 'human'
         ) act ON true
         WHERE (${EFFECTIVE_STATUS_SQL}) = $1
         ORDER BY act.last_seen ${sortOrder} NULLS LAST
         LIMIT $2`,
        [temperature, count && count > 0 ? count : 100000]
      );
      audience = rows;
    }

    if (Array.isArray(customerIds) && customerIds.length) {
      const { rows } = await pool.query(
        `SELECT id, full_name, whatsapp_number FROM customers WHERE id = ANY($1)`,
        [customerIds]
      );
      const seen = new Set(audience.map((c) => c.id));
      for (const c of rows) if (!seen.has(c.id)) { audience.push(c); seen.add(c.id); }
    }

    // A number typed in that isn't a customer yet — created the same way an advisor
    // starting a fresh conversation already creates one (see POST /api/conversations),
    // so it becomes a normal customer with a normal thread and temperature after this,
    // not a special one-off case the rest of the app doesn't know about. Existing
    // full_name is never overwritten — only filled in if it was empty.
    if (Array.isArray(newRecipients) && newRecipients.length) {
      const seen = new Set(audience.map((c) => c.id));
      for (const { phone, fullName } of newRecipients) {
        const { rows } = await pool.query(
          `INSERT INTO customers (whatsapp_number, full_name) VALUES ($1, $2)
           ON CONFLICT (whatsapp_number) DO UPDATE SET full_name = COALESCE(customers.full_name, EXCLUDED.full_name)
           RETURNING id, full_name, whatsapp_number`,
          [String(phone).trim(), fullName?.trim() || null]
        );
        const c = rows[0];
        if (!seen.has(c.id)) { audience.push(c); seen.add(c.id); }
      }
    }

    if (!audience.length) return res.status(400).json({ error: 'La audiencia quedó vacía' });

    const { rows: created } = await pool.query(
      `INSERT INTO campaigns (template_name, template_language, temperature, requested_count, customer_ids, recipient_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [templateName, templateLanguage, temperature ?? null, count ?? null, audience.map((c) => c.id), audience.length, req.user.fullName]
    );
    const campaignId = created[0].id;

    // Same pattern as every other outbound send in this app: respond once the audience
    // is locked in and stored, then let the actual WhatsApp calls happen in the
    // background instead of holding the request open for what could be minutes.
    runCampaign(campaignId, audience, templateName, templateLanguage, paramCount, headerMediaId).catch((err) =>
      console.error(`campaign ${campaignId} failed`, err)
    );

    res.status(201).json({ id: campaignId, recipientCount: audience.length });
  } catch (err) { next(err); }
});

export default router;
