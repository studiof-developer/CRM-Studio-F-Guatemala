import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import multer from 'multer';
import { pool } from '../db.js';
import * as whatsapp from '../whatsapp.js';
import { EFFECTIVE_STATUS_SQL, VALID_TEMPERATURES } from './customers.js';
import { findConversationThread, MIME_KIND, WHATSAPP_MAX_BYTES } from './conversations.js';
import { writeAttachmentFile, linkExistingFile } from '../attachmentStorage.js';
import { requireRole } from '../auth.js';
import { fetchReport, validRange } from '../metaAdsReport.js';
import { logBusinessAction } from '../auditLog.js';
import { getSetting } from './settings.js';
import { fetchMessageCost } from '../whatsappPricing.js';
import { buildComponents, validateNew, describeTemplate, LANGUAGES, CATEGORIES } from '../whatsappTemplates.js';

const router = Router();
// Was capped at a flat 5MB back when a header could only ever be an IMAGE (WhatsApp's own
// image limit) — now that DOCUMENT headers (e.g. a PDF catalog) are supported too, this
// needs to allow up to whatever the largest WhatsApp media type permits, same reasoning
// as conversations.js's own attachment upload limit.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(...Object.values(WHATSAPP_MAX_BYTES)) } });

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
// Admin-editable (Configuración > General) — 42h is just the fallback default.
async function getCooldownMap(lineId) {
  const cooldownHours = await getSetting('broadcast_cooldown_hours', 42);
  const params = [cooldownHours];
  let lineClause = '';
  if (lineId) {
    params.push(lineId);
    lineClause = `AND COALESCE(whatsapp_number_id, CASE WHEN session_id ~ '__line_[0-9]+' THEN (regexp_match(session_id, '__line_([0-9]+)'))[1]::int ELSE 1 END) = $2`;
  }
  const { rows } = await pool.query(
    `SELECT split_part(session_id, '__', 1) AS phone, max(created_at) AS last_sent
     FROM n8n_chat_histories
     WHERE message->'additional_kwargs'->>'campaignId' IS NOT NULL
       -- A send that failed (at dispatch, or later via the delivery-status webhook)
       -- never reached the customer, so it shouldn't block a retry for the cooldown.
       AND coalesce(message->'additional_kwargs'->>'status', '') <> 'failed'
       AND created_at > now() - make_interval(hours => $1::int)
       ${lineClause}
     GROUP BY phone`,
    params
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.phone, new Date(new Date(r.last_sent).getTime() + cooldownHours * 3600 * 1000));
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
// know up front whether it has to ask for one. IMAGE and DOCUMENT (e.g. a PDF catalog)
// and VIDEO are supported.
const SUPPORTED_HEADER_FORMATS = ['IMAGE', 'DOCUMENT', 'VIDEO'];
function getHeaderFormat(template) {
  return template.components?.find((c) => c.type === 'HEADER')?.format ?? null;
}

// GET /api/campaigns/meta-ads-report?since=YYYY-MM-DD&until=YYYY-MM-DD&level=campaign|adset|ad — informe de anuncios de Meta (admin y supervisor)
router.get('/meta-ads-report', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { since, until, level = 'campaign' } = req.query;
    if (!validRange(since, until)) return res.status(400).json({ error: 'Indica un rango de fechas válido' });
    res.json(await fetchReport({ since, until, level }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    // el error de Meta (token vencido, sin permiso ads_read…) sirve tal cual a quien administra
    if (/Meta|token|permission|OAuth/i.test(err.message)) return res.status(502).json({ error: err.message });
    next(err);
  }
});

router.get('/meta-strategy', async (req, res, next) => {
  try {
    const lineId = req.query.lineId ? Number(req.query.lineId) : undefined;
    const creds = await whatsapp.getActiveCredentials(undefined, lineId).catch(() => null);

    let phoneInfo = null;
    if (creds?.phoneNumberId && creds?.token) {
      phoneInfo = await whatsapp.verifyNumber(creds.phoneNumberId, creds.token, creds.wabaId).catch((err) => {
        return { error: err.message };
      });
    }

    // Estadísticas de 24 horas y 30 días en el CRM
    const { rows: statsRows } = await pool.query(
      `SELECT
         COUNT(DISTINCT split_part(session_id, '__', 1)) FILTER (WHERE created_at > now() - interval '24 hours' AND message->'additional_kwargs'->>'campaignId' IS NOT NULL) AS outbound_24h_unique,
         COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours' AND message->'additional_kwargs'->>'campaignId' IS NOT NULL) AS outbound_24h_total,
         COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours' AND message->'additional_kwargs'->>'campaignId' IS NOT NULL AND coalesce(message->'additional_kwargs'->>'status','') = 'failed') AS outbound_24h_failed,
         COUNT(DISTINCT split_part(session_id, '__', 1)) FILTER (WHERE created_at > now() - interval '30 days') AS total_active_contacts_30d
       FROM n8n_chat_histories`
    );

    // Conteo de base por temperaturas (Frío, Tibio, Caliente)
    const { rows: audiencePool } = await pool.query(
      `SELECT 
         (${EFFECTIVE_STATUS_SQL}) AS temperature,
         COUNT(*) AS count
       FROM customers c
       WHERE c.opted_out_campaigns = false
       GROUP BY temperature`
    );

    const poolByTemp = {};
    for (const r of audiencePool) {
      if (r.temperature) poolByTemp[r.temperature] = Number(r.count);
    }

    // Cooldown actual configurado
    const cooldownHours = await getSetting('broadcast_cooldown_hours', 42);

    res.json({
      configured: Boolean(creds),
      phoneNumberId: creds?.phoneNumberId ?? null,
      wabaId: creds?.wabaId ?? null,
      qualityRating: phoneInfo?.quality_rating ?? 'UNKNOWN',
      verifiedName: phoneInfo?.verified_name ?? null,
      displayPhoneNumber: phoneInfo?.display_phone_number ?? null,
      codeVerificationStatus: phoneInfo?.code_verification_status ?? null,
      cooldownHours,
      stats: {
        outbound24hUnique: Number(statsRows[0]?.outbound_24h_unique || 0),
        outbound24hTotal: Number(statsRows[0]?.outbound_24h_total || 0),
        outbound24hFailed: Number(statsRows[0]?.outbound_24h_failed || 0),
        totalActiveContacts30d: Number(statsRows[0]?.total_active_contacts_30d || 0),
      },
      audiences: {
        en_atencion: poolByTemp.en_atencion || 0,
        cotizacion: poolByTemp.cotizacion || 0,
        medio_pago: poolByTemp.medio_pago || 0,
      },
      officialLimits: {
        tier1: 1000,
        tier2: 10000,
        tier3: 100000,
        tier4: 'Ilimitado',
        currentTierEstimated: 'Tier 1 (1,000 / día) o Tier 2 según WABA',
        crmSafeSpeed: '350 ms / mensaje (~2.8 mensajes por segundo)',
      },
      pricing: {
        marketingUsd: 0.0740,
        utilityUsd: 0.0200,
        serviceUsd: 0.0000,
        ctwaUsd: 0.0000,
        trmCopEst: 4000,
        marketingCop: 296,
        utilityCop: 80,
      }
    });
  } catch (err) { next(err); }
});

router.get('/templates', async (req, res, next) => {
  try {
    const lineId = req.query.lineId ? Number(req.query.lineId) : undefined;
    const templates = await whatsapp.listTemplates(lineId);
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

// ---- Gestión de plantillas de WhatsApp (Marketing > Plantillas) — administración y supervisión ----
// La lista trae TODOS los estados (también en revisión, rechazada o pausada), a diferencia del selector de /templates de
// arriba que solo ofrece las aprobadas. Crear, editar o borrar una plantilla afecta a toda la cuenta de Meta, no a un envío.
const lineOf = (q) => (q.lineId ? Number(q.lineId) : undefined);

// Los errores de Meta llegan como "WhatsApp API 400: {json}"; se muestran con el texto que Meta da para el usuario.
function metaError(err) {
  const m = /^WhatsApp API (\d+): ([\s\S]*)$/.exec(err.message ?? '');
  if (!m) return err;
  try {
    const e = JSON.parse(m[2]).error ?? {};
    return Object.assign(new Error(e.error_user_msg || e.error_user_title || e.message || err.message), { status: Number(m[1]) >= 500 ? 502 : 400 });
  } catch { return err; }
}
const sendError = (res, next, err) => { const e = metaError(err); e.status ? res.status(e.status).json({ error: e.message }) : next(e); };
const specOf = (b) => ({ header: b.header, body: b.body, footer: b.footer, buttons: b.buttons });

router.get('/templates/manage', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const templates = await whatsapp.listTemplates(lineOf(req.query));
    res.json({ templates: templates.map(describeTemplate), languages: LANGUAGES, categories: CATEGORIES });
  } catch (err) { sendError(res, next, err); }
});

// Lo que cada plantilla ha hecho en las difusiones de este CRM (no es el panel de métricas de Meta): envíos, entregados,
// leídos y fallidos, sumando todas las difusiones que la usaron.
router.get('/templates/stats', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ca.template_name AS name, count(DISTINCT ca.id)::int AS campaigns, count(h.id)::int AS sent,
              count(*) FILTER (WHERE h.message->'additional_kwargs'->>'status' IN ('delivered','read'))::int AS delivered,
              count(*) FILTER (WHERE h.message->'additional_kwargs'->>'status' = 'read')::int AS read,
              count(*) FILTER (WHERE h.message->'additional_kwargs'->>'status' = 'failed')::int AS failed,
              max(ca.created_at) AS last_used
       FROM campaigns ca
       LEFT JOIN n8n_chat_histories h ON h.message->'additional_kwargs'->>'campaignId' = ca.id::text
       GROUP BY ca.template_name`
    );
    res.json(Object.fromEntries(rows.map((r) => [r.name, { campaigns: r.campaigns, sent: r.sent, delivered: r.delivered, read: r.read, failed: r.failed, lastUsed: r.last_used }])));
  } catch (err) { next(err); }
});

// Además de lo anterior, cuántos clientes respondieron en las 72 horas siguientes al envío (se calcula solo al pedirlo).
router.get('/templates/:name/stats', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT count(h.id)::int AS sent,
              count(*) FILTER (WHERE h.message->'additional_kwargs'->>'status' IN ('delivered','read'))::int AS delivered,
              count(*) FILTER (WHERE h.message->'additional_kwargs'->>'status' = 'read')::int AS read,
              count(*) FILTER (WHERE h.message->'additional_kwargs'->>'status' = 'failed')::int AS failed,
              count(*) FILTER (WHERE rp.replied)::int AS replied,
              count(DISTINCT ca.id)::int AS campaigns
       FROM campaigns ca
       JOIN n8n_chat_histories h ON h.message->'additional_kwargs'->>'campaignId' = ca.id::text
       LEFT JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM n8n_chat_histories r
           WHERE r.session_id = h.session_id AND r.message->>'type' = 'human'
             AND r.created_at > h.created_at AND r.created_at <= h.created_at + interval '72 hours'
         ) AS replied
       ) rp ON true
       WHERE ca.template_name = $1`,
      [req.params.name]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Avisos que Meta manda por webhook (aprobada, rechazada, pausada, cambio de calidad o de categoría).
router.get('/templates/events', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, template_name, language, event, detail, created_at FROM whatsapp_template_events ORDER BY id DESC LIMIT 40`
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.template_name, language: r.language, event: r.event, detail: r.detail, at: r.created_at })));
  } catch (err) { next(err); }
});

// Archivo de ejemplo para el encabezado de imagen / video / documento: Meta lo pide para revisar la plantilla.
const SAMPLE_LIMITS = { 'image/jpeg': 5, 'image/png': 5, 'video/mp4': 16, 'application/pdf': 100 };
router.post('/templates/sample', requireRole('admin', 'supervisor'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo de ejemplo.' });
    const maxMb = SAMPLE_LIMITS[req.file.mimetype];
    if (!maxMb) return res.status(400).json({ error: 'Formato no admitido. Usa JPG o PNG (imagen), MP4 (video) o PDF (documento).' });
    if (req.file.size > maxMb * 1024 * 1024) return res.status(400).json({ error: `El archivo pesa más de ${maxMb} MB.` });
    const handle = await whatsapp.uploadTemplateSample(req.file.buffer, req.file.mimetype, req.file.originalname, lineOf(req.body));
    res.json({ handle });
  } catch (err) { sendError(res, next, err); }
});

// Body: { name, category, language, header, body: {text, examples}, footer, buttons, lineId } — ver whatsappTemplates.js.
// Queda en revisión; Meta la aprueba en minutos o hasta ~1 día, este envío no puede acelerarlo.
router.post('/templates', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const language = b.language || 'es';
    validateNew({ name: b.name, category: b.category, language });
    const components = buildComponents(specOf(b));
    const result = await whatsapp.createTemplate({ name: b.name, category: b.category, language, components, lineId: lineOf(b) });
    logBusinessAction(req.user, null, 'whatsapp_template_created', `${b.name} (${b.category}, ${language})`);
    res.status(201).json(result);
  } catch (err) { sendError(res, next, err); }
});

// Editar una plantilla existente (por el id que le da Meta). Una aprobada admite 1 edición al día y 10 al mes, y no cambia de categoría.
router.put('/templates/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    if (!/^\d{5,25}$/.test(req.params.id)) return res.status(400).json({ error: 'Plantilla inválida.' });
    const b = req.body ?? {};
    if (b.category && !CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'Categoría inválida.' });
    const components = buildComponents(specOf(b));
    const result = await whatsapp.updateTemplate({ templateId: req.params.id, components, category: b.category, lineId: lineOf(b) });
    logBusinessAction(req.user, null, 'whatsapp_template_updated', `${b.name ?? req.params.id} (${b.language ?? ''})`);
    res.json(result);
  } catch (err) { sendError(res, next, err); }
});

// Con ?hsmId borra solo ese idioma; sin él, todos los idiomas con ese nombre.
router.delete('/templates/:name', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const hsmId = /^\d{5,25}$/.test(req.query.hsmId ?? '') ? req.query.hsmId : undefined;
    await whatsapp.deleteTemplate(req.params.name, lineOf(req.query), hsmId);
    logBusinessAction(req.user, null, 'whatsapp_template_deleted', `${req.params.name}${hsmId ? ` (idioma ${req.query.language ?? hsmId})` : ' (todos los idiomas)'}`);
    res.json({ ok: true });
  } catch (err) { sendError(res, next, err); }
});

// Uploaded once per campaign, not once per recipient — the resulting media id is valid
// for 30 days and Meta allows reusing it across every send in the batch.
router.post('/header-media', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const lineId = req.body.lineId ? Number(req.body.lineId) : undefined;
    const mediaId = await whatsapp.uploadMedia(req.file.buffer, req.file.mimetype, undefined, lineId);
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
// "Período de estado": clientes que HOY están en la temperatura elegida y que estuvieron en ese estado dentro del
// período (fechas en hora de Guatemala, ambas incluidas). Para tibio ("Cotización") significa que recibieron una
// cotización en esas fechas: un mensaje de la asesora o del bot con un monto en Q, o una cotización del Cotizador.
// Para las demás temperaturas, que su ticket cambió de etapa en esas fechas.
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function periodRange(from, to) {
  if (!YMD.test(from ?? '') || !YMD.test(to ?? '')) return null;
  const a = new Date(`${from}T00:00:00-06:00`);
  const b = new Date(`${to}T23:59:59.999-06:00`);
  return a <= b ? { from: a, to: b } : null;
}

// Cliente con historial de compras en el ERP: mismo cruce por los últimos 8 dígitos del teléfono que usa la ficha del cliente.
const ERP_BUYER_SQL = `EXISTS (
  SELECT 1 FROM erp_customers e
  WHERE COALESCE(e.facturas_totales, 0) > 0 AND (e.telefono = right(c.whatsapp_number, 8) OR e.celular = right(c.whatsapp_number, 8))
)`;

function periodClauseSql(temperature, range, params) {
  params.push(range.from);
  const f = params.length;
  params.push(range.to);
  const t = params.length;
  if (temperature === 'tibio') {
    return `(
      c.whatsapp_number IN (
        SELECT split_part(h.session_id, '__', 1) FROM n8n_chat_histories h
        WHERE h.created_at >= $${f} AND h.created_at <= $${t} AND h.message->>'type' = 'ai'
          AND h.message->>'content' ~ '(^|[^A-Za-z])Q ?[0-9]{2,5}'
      )
      OR EXISTS (SELECT 1 FROM quotes q WHERE q.customer_id = c.id AND q.created_at >= $${f} AND q.created_at <= $${t})
    )`;
  }
  return `EXISTS (SELECT 1 FROM tickets tk WHERE tk.customer_id = c.id AND tk.updated_at >= $${f} AND tk.updated_at <= $${t})`;
}

router.get('/audience', async (req, res, next) => {
  try {
    const { temperature, q, lineId } = req.query;
    if (temperature && !VALID_TEMPERATURES.includes(temperature)) {
      return res.status(400).json({ error: 'invalid temperature' });
    }
    const range = periodRange(req.query.periodFrom, req.query.periodTo);
    if ((req.query.periodFrom || req.query.periodTo) && !range) return res.status(400).json({ error: 'Período inválido: usa fechas AAAA-MM-DD con "desde" antes de "hasta"' });
    const countOnly = req.query.countOnly === '1';
    const params = [];
    const clauses = ['c.opted_out_campaigns = false'];
    if (temperature) { params.push(temperature); clauses.push(`(${EFFECTIVE_STATUS_SQL}) = $${params.length}`); }
    if (temperature && range) clauses.push(periodClauseSql(temperature, range, params));
    if (temperature && req.query.erpOnly === '1') clauses.push(ERP_BUYER_SQL);
    if (q?.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      clauses.push(`(lower(c.full_name) LIKE $${params.length} OR c.whatsapp_number LIKE $${params.length})`);
    }
    const parsedLineId = lineId ? Number(lineId) : null;
    if (parsedLineId) {
      params.push(parsedLineId);
      clauses.push(`(
        EXISTS (
          SELECT 1 FROM tickets t 
          WHERE t.customer_id = c.id 
            AND (t.whatsapp_number_id = $${params.length} OR ($${params.length} = 1 AND t.whatsapp_number_id IS NULL))
        )
        OR EXISTS (
          SELECT 1 FROM n8n_chat_histories h 
          WHERE split_part(h.session_id, '__', 1) = c.whatsapp_number 
            AND (h.whatsapp_number_id = $${params.length} OR h.session_id LIKE '%__line_' || $${params.length})
        )
      )`);
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.full_name, c.whatsapp_number, (${EFFECTIVE_STATUS_SQL}) AS temperature
       FROM customers c
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.full_name NULLS LAST
       ${countOnly ? '' : 'LIMIT 200'}`,
      params
    );
    const cooldown = await getCooldownMap(parsedLineId);
    // The temperature-only pool (no q) is what feeds the "X disponibles" count — that
    // count needs to already exclude cooldown numbers, since POST / backfills around
    // them too. A manual name/phone search (q) keeps a cooling-down person visible but
    // flagged, so the picker can explain why it won't let them be added.
    const withCooldown = rows.map((r) => ({
      id: r.id, fullName: r.full_name, phone: r.whatsapp_number, temperature: r.temperature,
      cooldownUntil: cooldown.get(r.whatsapp_number)?.toISOString() ?? null,
    }));
    const result = temperature && !q?.trim() ? withCooldown.filter((r) => !r.cooldownUntil) : withCooldown;
    res.json(countOnly ? { count: result.length } : result);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    // Auto-complete any campaign stuck in 'sending' for > 10 minutes with no recent message activity
    await pool.query(
      `UPDATE campaigns ca
       SET status = 'completed', completed_at = COALESCE(completed_at, now())
       WHERE ca.status = 'sending'
         AND ca.created_at < now() - interval '10 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM n8n_chat_histories h
           WHERE h.message->'additional_kwargs'->>'campaignId' = ca.id::text
             AND h.created_at > now() - interval '5 minutes'
         )`
    ).catch(() => {});

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
    const lineId = campaign.whatsapp_number_id ? Number(campaign.whatsapp_number_id) : undefined;

    const resolved = await resolveTemplate(campaign.template_name, campaign.template_language, lineId);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { paramCount, headerFormat, bodyTemplate } = resolved;

    const { rows: failed } = await pool.query(
      `SELECT h.id, h.session_id, c.full_name,
              coalesce(c.whatsapp_number, split_part(h.session_id, '__', 1)) AS phone,
              h.message->'additional_kwargs'->'extraParams' AS extra_params
       FROM n8n_chat_histories h
       LEFT JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
       WHERE h.message->'additional_kwargs'->>'campaignId' = $1
         AND h.message->'additional_kwargs'->>'status' = 'failed'`,
      [String(campaign.id)]
    );
    if (!failed.length) return res.status(400).json({ error: 'No hay envíos fallidos en esta difusión' });

    let headerMediaId = null;
    let headerFilename = null;
    if (SUPPORTED_HEADER_FORMATS.includes(headerFormat)) {
      const { rows: attRows } = await pool.query(
        `SELECT a.file_path, a.mime_type, a.filename FROM message_attachments a
         JOIN n8n_chat_histories h ON h.id = a.n8n_message_id
         WHERE h.message->'additional_kwargs'->>'campaignId' = $1 LIMIT 1`,
        [String(campaign.id)]
      );
      if (!attRows.length) {
        return res.status(400).json({ error: 'No se encontró el archivo original de esta difusión — no se puede reintentar' });
      }
      const buffer = await fs.promises.readFile(attRows[0].file_path);
      headerMediaId = await whatsapp.uploadMedia(buffer, attRows[0].mime_type, undefined, lineId);
      headerFilename = attRows[0].filename;
    }

    // Same respond-then-background pattern as a fresh send — the campaign detail view
    // is already SSE-driven, so each recipient's status flips live as retries land.
    retryFailedRecipients(campaign.id, failed, campaign.template_name, campaign.template_language, bodyTemplate, paramCount, headerMediaId, headerFormat, headerFilename, lineId).catch((err) =>
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

// Renders the literal text sent — {{1}} is always the customer's name; {{2}} and up (the
// "guías" case — a tracking number, an order code, anything per-recipient) come from
// extraParams, in order. A template with no extraParams supplied for a {{2}}+ falls back
// to the name too, same as before this existed, rather than leaving a raw "{{2}}" in the
// thread if something upstream forgot to pass one.
function renderBody(bodyTemplate, name, extraParams = []) {
  return bodyTemplate.replace(/\{\{(\d+)\}\}/g, (_, n) => (n === '1' ? name : extraParams[Number(n) - 2] ?? name));
}

async function sendToRecipient(campaignId, customer, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment, headerFormat, lineId) {
  const name = firstName(customer.full_name) || FALLBACK_TEMPLATE_NAME;
  const extraParams = customer.extraParams ?? [];
  // A template with NO {{n}} placeholders at all (paramCount 0) still had the
  // customer's name tacked on unconditionally — Meta error #132000, "number of
  // localizable_params (1) does not match the expected number of params (0)", on every
  // single recipient (2026-09-10 report: recuperacion_rebajas, 53/53 failed). Trim to
  // what the template actually declares instead of always sending at least the name.
  const params = [name, ...extraParams].slice(0, paramCount);
  let sentWamid = null;
  let error = null;
  try {
    const result = await whatsapp.sendTemplate(customer.whatsapp_number, templateName, templateLanguage, params, headerMediaId, headerFormat, headerAttachment?.filename, lineId);
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

  // Whoever just got a broadcast HAS been reached — but not by an advisor, so it's wrong
  // to keep showing them as actively "En atención"/Cotización/etc (nobody's actually
  // attending). 'difusion_enviada' takes them off BOTH pipelines entirely (same as 'bot',
  // see HIDDEN_TICKET_STATUSES_SQL in tickets.js) until they actually reply, at which
  // point db/init/045's trigger flips them straight back to esperando_asesor with a fresh
  // stage_since — reappearing as a normal, recently-arrived "No atendido", not wherever
  // they used to sit. Originally guarded to status = 'esperando_asesor' only, back when a
  // broadcast could only ever reach a "No atendidos" contact — the 2026-09-12 Marketing
  // Pipeline can now hand this function a dormant contact from ANY temperature bucket
  // (en_atencion, cotizacion, medio_pago, pagado, pqrs all share ticket_status
  // 'en_atencion' under the hood — see tickets.js's BUCKET_CASE_SQL), so both need
  // covering or most of that pipeline never actually disappears after being broadcast to.
  // despacho stays excluded on purpose — same "sitting quiet while it ships is normal,
  // not a cold lead" exemption already applied everywhere else this session, so it's
  // never touched even if someone deliberately picks a despacho customer by hand. Only on
  // an actual successful send (a failed one didn't really reach them), and never touches
  // an already-resolved ticket (not in the IN list).
  if (sentWamid) {
    await pool.query(
      `UPDATE tickets t SET status = 'difusion_enviada', updated_at = now()
       FROM customers c
       WHERE t.customer_id = $1 AND c.id = t.customer_id
         AND (t.whatsapp_number_id = $2 OR ($2 = 1 AND t.whatsapp_number_id IS NULL))
         AND t.status IN ('esperando_asesor', 'en_atencion')
         AND COALESCE(c.manual_status, '') <> 'despacho'`,
      [customer.id, lineId || 1]
    );
  }

  const { sessionIds } = await findConversationThread(customer.whatsapp_number, { lineId });
  const sessionId = (lineId && customer.whatsapp_number)
    ? `${customer.whatsapp_number}__line_${lineId}`
    : (sessionIds?.[0] ?? customer.whatsapp_number);

  const message = {
    type: 'ai',
    content: renderBody(bodyTemplate, name, extraParams),
    additional_kwargs: {
      sentBy: 'campaign',
      campaignId: String(campaignId),
      whatsappNumberId: lineId ?? 1,
      // Persisted so a later retry (which only has the message row, not the original
      // request) re-sends with the SAME per-recipient value instead of falling back to
      // repeating the name for {{2}}+.
      ...(extraParams.length ? { extraParams } : {}),
      ...(sentWamid ? { wamid: sentWamid } : { status: 'failed', statusError: error }),
    },
    response_metadata: {},
    tool_calls: [],
  };
  const { rows } = await pool.query(
    `INSERT INTO n8n_chat_histories (session_id, message, whatsapp_number_id) VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [sessionId, JSON.stringify(message), lineId ?? 1]
  );

  // A broadcast reaching someone is us writing to THEM — there's nothing left for staff
  // to "read" at that point, but conversation_reads never heard about this send, so an
  // old, already-stale unread customer message from before the campaign kept showing
  // the whole thread as unread indefinitely (2026-09-11 report). Same mark-as-read
  // conversations.js already does when a thread is opened, just triggered by the send
  // instead — catches the thread up through this very message.
  if (sentWamid) {
    try {
      await pool.query(
        `INSERT INTO conversation_reads (phone, last_read_message_id, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (phone) DO UPDATE SET last_read_message_id = GREATEST(conversation_reads.last_read_message_id, $2), updated_at = now()`,
        [customer.whatsapp_number, rows[0].id]
      );
      await pool.query(`SELECT pg_notify('read_changes', $1)`, [customer.whatsapp_number]);
    } catch (readErr) {
      console.error(`campaign ${campaignId} mark-read for ${customer.whatsapp_number} failed:`, readErr);
    }
  }

  if (headerAttachment) {
    await linkExistingFile({
      n8nMessageId: rows[0].id,
      kind: MIME_KIND(headerAttachment.mimeType),
      filename: headerAttachment.filename,
      mimeType: headerAttachment.mimeType,
      filePath: headerAttachment.filePath,
      sizeBytes: headerAttachment.sizeBytes,
    });
  }
}

// Updates the recipient's existing row in place instead of inserting a new one — see the
// retry-failed route for why (avoids double-counting the recipient in campaign stats).
async function retryRecipient(messageId, sessionId, phone, fullName, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerFormat, headerFilename, extraParams = [], lineId) {
  const name = firstName(fullName) || FALLBACK_TEMPLATE_NAME;
  // Same paramCount trim as sendToRecipient above — a retry must match the template
  // exactly the same way the original send needs to.
  const params = [name, ...extraParams].slice(0, paramCount);
  let sentWamid = null;
  let error = null;
  try {
    const result = await whatsapp.sendTemplate(phone, templateName, templateLanguage, params, headerMediaId, headerFormat, headerFilename, lineId);
    sentWamid = result?.messages?.[0]?.id ?? null;
    if (!sentWamid) error = 'WhatsApp no devolvió un id de mensaje — el envío no se confirmó';
  } catch (err) {
    error = err.message;
  }
  if (error) console.error(`campaign retry message ${messageId} to ${phone} failed:`, error);

  // Same broadened "reached, so leave the pipeline (without faking En atención)"
  // reasoning as sendToRecipient above — a retry is just the send finally landing, so it
  // earns the same ticket flip on success, from any active status, despacho excluded.
  if (sentWamid) {
    await pool.query(
      `UPDATE tickets t SET status = 'difusion_enviada', updated_at = now()
       FROM customers c
       WHERE c.whatsapp_number = $1 AND c.id = t.customer_id
         AND (t.whatsapp_number_id = $2 OR ($2 = 1 AND t.whatsapp_number_id IS NULL))
         AND t.status IN ('esperando_asesor', 'en_atencion')
         AND COALESCE(c.manual_status, '') <> 'despacho'`,
      [phone, lineId || 1]
    );
  }

  const { rows } = await pool.query(`SELECT message FROM n8n_chat_histories WHERE id = $1`, [messageId]);
  const prev = rows[0]?.message;
  if (!prev) return false;
  const message = {
    ...prev,
    content: renderBody(bodyTemplate, name, extraParams),
    additional_kwargs: {
      sentBy: 'campaign',
      campaignId: prev.additional_kwargs?.campaignId,
      whatsappNumberId: lineId ?? prev.additional_kwargs?.whatsappNumberId ?? 1,
      ...(extraParams.length ? { extraParams } : {}),
      ...(sentWamid ? { wamid: sentWamid } : { status: 'failed', statusError: error }),
    },
  };
  await pool.query(`UPDATE n8n_chat_histories SET message = $2::jsonb, whatsapp_number_id = COALESCE(whatsapp_number_id, $3) WHERE id = $1`, [messageId, JSON.stringify(message), lineId ?? 1]);
  // session_id (not the row id) is what listener.js reads to flush anything an advisor
  // had queued for this same customer, same as every other message-mutating route.
  await pool.query(`SELECT pg_notify('message_changes', json_build_object('session_id', $1::text)::text)`, [sessionId]);

  // Same mark-as-read reasoning as sendToRecipient above — a retry landing is the send
  // finally reaching them.
  if (sentWamid) {
    try {
      await pool.query(
        `INSERT INTO conversation_reads (phone, last_read_message_id, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (phone) DO UPDATE SET last_read_message_id = GREATEST(conversation_reads.last_read_message_id, $2), updated_at = now()`,
        [phone, messageId]
      );
      await pool.query(`SELECT pg_notify('read_changes', $1)`, [phone]);
    } catch (readErr) {
      console.error(`campaign retry mark-read for ${phone} failed:`, readErr);
    }
  }

  return !!sentWamid;
}

async function retryFailedRecipients(campaignId, failed, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerFormat, headerFilename, lineId) {
  for (const r of failed) {
    await retryRecipient(r.id, r.session_id, r.phone, r.full_name, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerFormat, headerFilename, r.extra_params ?? [], lineId).catch((err) =>
      console.error(`campaign ${campaignId} retry recipient ${r.id} failed`, err)
    );
    await sleep(SEND_DELAY_MS);
  }
}

async function runCampaign(campaignId, audience, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment, headerFormat, lineId) {
  for (const customer of audience) {
    await sendToRecipient(campaignId, customer, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment, headerFormat, lineId).catch((err) =>
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
async function resolveTemplate(templateName, templateLanguage, lineId) {
  const templates = await whatsapp.listTemplates(lineId);
  const template = templates.find((t) => t.name === templateName && t.language === templateLanguage);
  if (!template) return { error: 'La plantilla no existe o cambió' };
  if (template.status !== 'APPROVED') return { error: 'La plantilla no está activa en este momento' };
  const headerFormat = getHeaderFormat(template);
  if (headerFormat && !SUPPORTED_HEADER_FORMATS.includes(headerFormat)) {
    return { error: `Las plantillas con encabezado de tipo ${headerFormat} todavía no están soportadas` };
  }
  return {
    template, headerFormat, paramCount: countBodyParams(template),
    bodyTemplate: template.components?.find((c) => c.type === 'BODY')?.text ?? '',
  };
}

router.post('/', async (req, res, next) => {
  try {
    const { erpBuyersOnly, templateName, templateLanguage, temperature, count, order, customerIds, newRecipients, headerMediaId, headerImageToken, whatsappNumberId, periodFrom, periodTo } = req.body ?? {};
    const range = periodRange(periodFrom, periodTo);
    if ((periodFrom || periodTo) && !range) return res.status(400).json({ error: 'Período inválido: usa fechas AAAA-MM-DD con "desde" antes de "hasta"' });
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
    const lineId = whatsappNumberId ? Number(whatsappNumberId) : undefined;
    const sortOrder = order === 'oldest' ? 'ASC' : 'DESC';

    const resolved = await resolveTemplate(templateName, templateLanguage, lineId);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { paramCount, headerFormat, bodyTemplate } = resolved;

    // {{2}} and beyond need a real per-recipient value (a tracking number, an order
    // code — "envío de guías") — there's no sensible one for a bulk temperature/
    // customerIds audience, only for a pasted list where each row brings its own.
    if (paramCount > 1) {
      if (temperature || (Array.isArray(customerIds) && customerIds.length)) {
        return res.status(400).json({ error: `Esta plantilla necesita ${paramCount - 1} valor(es) extra por cliente — solo se puede enviar pegando la lista de destinatarios con sus valores, no por segmento ni cliente existente.` });
      }
      if (!Array.isArray(newRecipients) || !newRecipients.length) {
        return res.status(400).json({ error: 'Esta plantilla necesita una lista de destinatarios con sus valores extra.' });
      }
      const badParams = newRecipients.filter((r) => !Array.isArray(r.params) || r.params.length !== paramCount - 1 || r.params.some((p) => !String(p ?? '').trim()));
      if (badParams.length) {
        return res.status(400).json({ error: `Faltan valores para: ${badParams.map((r) => r.phone).join(', ')}` });
      }
    }

    const headerNeedsMedia = SUPPORTED_HEADER_FORMATS.includes(headerFormat);
    if (headerNeedsMedia && !headerMediaId) {
      return res.status(400).json({
        error: headerFormat === 'DOCUMENT'
          ? 'Esta plantilla necesita un documento de encabezado — súbelo antes de enviar'
          : headerFormat === 'VIDEO'
            ? 'Esta plantilla necesita un video de encabezado — súbelo antes de enviar'
            : 'Esta plantilla necesita una imagen de encabezado — súbela antes de enviar',
      });
    }
    // The token only ever resolves to a file this backend itself wrote — see the
    // headerUploads comment above for why a client-supplied path is never trusted here.
    const headerAttachment = headerImageToken ? headerUploads.get(headerImageToken) : null;
    if (headerNeedsMedia && !headerAttachment) {
      return res.status(400).json({ error: 'El archivo subido ya no está disponible — vuelve a subirlo e intenta de nuevo' });
    }

    const cooldown = await getCooldownMap(lineId);
    const skippedCooldown = [];

    let audience = [];
    if (temperature) {
      // Excluded in SQL, before the LIMIT, so a number in cooldown gets skipped over in
      // favor of the next eligible one in the same order — not just a shorter batch.
      const cooldownPhones = [...cooldown.keys()];
      // Con período se envía a TODOS los que cumplen (la cantidad no aplica).
      const queryParams = [temperature, !range && count && count > 0 ? count : 100000, cooldownPhones];
      let lineClause = '';
      if (lineId) {
        queryParams.push(lineId);
        lineClause = `AND (
          EXISTS (
            SELECT 1 FROM tickets t 
            WHERE t.customer_id = c.id 
              AND (t.whatsapp_number_id = $4 OR ($4 = 1 AND t.whatsapp_number_id IS NULL))
          )
          OR EXISTS (
            SELECT 1 FROM n8n_chat_histories h 
            WHERE split_part(h.session_id, '__', 1) = c.whatsapp_number 
              AND (h.whatsapp_number_id = $4 OR h.session_id LIKE '%__line_' || $4)
          )
        )`;
      }
      const periodClause = range ? `AND ${periodClauseSql(temperature, range, queryParams)}` : '';
      const { rows } = await pool.query(
        `SELECT c.id, c.full_name, c.whatsapp_number
         FROM customers c
         LEFT JOIN (
           SELECT split_part(h.session_id, '__', 1) AS phone, max(h.created_at) AS last_seen FROM n8n_chat_histories h
           WHERE h.message->>'type' = 'human' GROUP BY 1
         ) act ON act.phone = c.whatsapp_number
         WHERE (${EFFECTIVE_STATUS_SQL}) = $1
           AND NOT (c.whatsapp_number = ANY($3::text[]))
           AND c.opted_out_campaigns = false
           ${erpBuyersOnly === true ? `AND ${ERP_BUYER_SQL}` : ''}
           ${lineClause}
           ${periodClause}
         ORDER BY act.last_seen ${sortOrder} NULLS LAST
         LIMIT $2`,
        queryParams
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
      for (const { phone, fullName, params } of newRecipients) {
        const trimmedPhone = String(phone).trim();
        if (cooldown.has(trimmedPhone)) { skippedCooldown.push({ phone: trimmedPhone, fullName: fullName?.trim() || null }); continue; }
        const { rows } = await pool.query(
          `INSERT INTO customers (whatsapp_number, full_name) VALUES ($1, $2)
           ON CONFLICT (whatsapp_number) DO UPDATE SET full_name = COALESCE(customers.full_name, EXCLUDED.full_name)
           RETURNING id, full_name, whatsapp_number`,
          [trimmedPhone, fullName?.trim() || null]
        );
        const c = rows[0];
        // {{1}} still comes from c.full_name (an existing customer keeps their real
        // name via the COALESCE above) — params here only ever fills {{2}} and beyond.
        if (!seen.has(c.id)) { audience.push({ ...c, extraParams: Array.isArray(params) ? params : [] }); seen.add(c.id); }
      }
    }

    if (!audience.length) {
      return res.status(400).json({
        error: skippedCooldown.length
          ? 'Todos los destinatarios seleccionados recibieron una difusión en las últimas 42 horas'
          : 'La audiencia quedó vacía',
      });
    }

    // Guard against double-click / concurrent duplicate campaign submissions within 90 seconds
    const { rows: recentDup } = await pool.query(
      `SELECT id, recipient_count FROM campaigns
       WHERE template_name = $1
         AND COALESCE(whatsapp_number_id, 1) = COALESCE($2::int, 1)
         AND recipient_count = $3
         AND created_at > now() - interval '90 seconds'
       ORDER BY id DESC LIMIT 1`,
      [templateName, lineId ?? null, audience.length]
    );
    if (recentDup.length > 0) {
      return res.status(201).json({
        id: recentDup[0].id,
        recipientCount: recentDup[0].recipient_count,
        skippedCooldown,
        deduplicated: true,
      });
    }

    const { rows: created } = await pool.query(
      `INSERT INTO campaigns (template_name, template_language, temperature, requested_count, customer_ids, recipient_count, created_by, whatsapp_number_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [templateName, templateLanguage, temperature ?? null, count ?? null, audience.map((c) => c.id), audience.length, req.user.fullName, lineId ?? null]
    );
    const campaignId = created[0].id;

    // Same pattern as every other outbound send in this app: respond once the audience
    // is locked in and stored, then let the actual WhatsApp calls happen in the
    // background instead of holding the request open for what could be minutes.
    runCampaign(campaignId, audience, templateName, templateLanguage, bodyTemplate, paramCount, headerMediaId, headerAttachment, headerFormat, lineId).catch((err) =>
      console.error(`campaign ${campaignId} failed`, err)
    );

    res.status(201).json({ id: campaignId, recipientCount: audience.length, skippedCooldown });
  } catch (err) { next(err); }
});

export default router;
