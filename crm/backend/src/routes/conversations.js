import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';
import { EFFECTIVE_STATUS_SQL, VALID_TEMPERATURES } from './customers.js';
import * as whatsapp from '../whatsapp.js';
import { saveAttachment, isAllowedAttachmentMime } from '../attachmentStorage.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, isAllowedAttachmentMime(file.mimetype)),
});

const MIME_KIND = (mime) => {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
};

export function cleanSessionId(sessionId) {
  return sessionId.split('__')[0];
}

// 7-15 digits covers bare local numbers up through full E.164 (country code + number).
const PHONE_RE = /^\d{7,15}$/;

// The customer's phone number is the first thing the script asks for, so it's
// sitting in the transcript as plain text — no n8n changes needed to find it.
// Shared with routes/audit.js so ai_decision_log rows (keyed only by session_id)
// can be attributed to a customer using the exact same heuristic.
export async function findCustomerBySessionId(sessionIdPrefix) {
  const { rows } = await pool.query(
    `SELECT id, message, created_at FROM n8n_chat_histories WHERE session_id LIKE $1 ORDER BY id ASC`,
    [`${sessionIdPrefix}%`]
  );
  // Production session_ids are already the real wa_id (phone) — only fall back to
  // scanning the transcript for legacy test sessions with non-phone session_ids.
  let phone = PHONE_RE.test(sessionIdPrefix) ? sessionIdPrefix : null;
  if (!phone) {
    const phoneMsg = rows.find((r) => r.message.type === 'human' && PHONE_RE.test(String(r.message.content).trim()));
    phone = phoneMsg?.message.content.trim() ?? null;
  }
  if (!phone) return { messages: rows, customer: null, phone: null };

  const { customer } = await findCustomerByPhone(phone);
  return { messages: rows, customer, phone };
}

async function findCustomerByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT c.id, c.full_name, c.zone, c.department, c.municipio, c.preferred_line, c.preferred_size, c.purchase_frequency, c.address,
            c.dpi, c.email, c.birth_date,
            c.paid_locked, c.paid_method, c.manual_status, ${EFFECTIVE_STATUS_SQL} AS temperature,
            t.id AS ticket_id, t.status AS ticket_status, t.handoff_reason
     FROM customers c
     LEFT JOIN LATERAL (
       SELECT id, status, handoff_reason FROM tickets
       WHERE customer_id = c.id AND status IN ('esperando_asesor', 'en_atencion')
       ORDER BY created_at DESC LIMIT 1
     ) t ON true
     WHERE c.whatsapp_number = $1`,
    [phone]
  );
  return { customer: rows[0] ?? null };
}

// Local test runs generate a fresh random session_id per n8n chat-trigger session,
// so the same real phone number used to show up as several separate threads. Once a
// phone is known, EVERY session_id that ever mentioned it is merged into one thread —
// keyed by phone instead of session_id. Chats where no phone has been captured yet
// (very start of onboarding) still fall back to their raw session_id as the key.
export async function findConversationThread(threadKey) {
  let sessionIds;
  if (PHONE_RE.test(threadKey)) {
    // Production session_ids are the phone itself, so match that directly — the
    // content-equals-phone clause is only there for legacy sessions (random
    // session_id) that merge into this thread because the customer once typed
    // their own number as a message.
    const { rows } = await pool.query(
      `SELECT DISTINCT session_id FROM n8n_chat_histories
       WHERE session_id = $1
          OR (message->>'type' = 'human' AND trim(message->>'content') = $1)`,
      [threadKey]
    );
    sessionIds = rows.map((r) => r.session_id);
  } else {
    const { rows } = await pool.query(
      `SELECT DISTINCT session_id FROM n8n_chat_histories WHERE session_id LIKE $1`,
      [`${threadKey}%`]
    );
    sessionIds = rows.map((r) => r.session_id);
  }
  if (!sessionIds.length) return { messages: [], customer: null, phone: null };

  // id is a single global sequence across all sessions, so merging by id ASC
  // already interleaves multiple session_ids in true chronological order.
  const { rows: messages } = await pool.query(
    `SELECT id, message, created_at FROM n8n_chat_histories WHERE session_id = ANY($1) ORDER BY id ASC`,
    [sessionIds]
  );

  const phone = PHONE_RE.test(threadKey)
    ? threadKey
    : messages.find((r) => r.message.type === 'human' && PHONE_RE.test(String(r.message.content).trim()))
        ?.message.content.trim() ?? null;

  const customer = phone ? (await findCustomerByPhone(phone)).customer : null;
  return { messages, customer, phone, sessionIds };
}

// The template must already be approved in Meta's WhatsApp Manager under this exact
// name/language — see the CRM ops notes for the approved wording ("seguimiento_asesor").
const OUTREACH_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'seguimiento_asesor';
const OUTREACH_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'es';

// Advisor-initiated first contact (customer has no prior thread, or one that's gone
// cold) — WhatsApp requires a pre-approved template for this, not free text.
router.post('/', async (req, res, next) => {
  try {
    const { phone: rawPhone, fullName, address } = req.body ?? {};
    const phone = String(rawPhone ?? '').replace(/\D/g, '');
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'invalid phone' });
    if (!fullName?.trim()) return res.status(400).json({ error: 'fullName required' });
    if (!address?.trim()) return res.status(400).json({ error: 'address required' });

    try {
      await whatsapp.sendTemplate(phone, OUTREACH_TEMPLATE_NAME, OUTREACH_TEMPLATE_LANG, [fullName.trim()]);
    } catch (err) {
      return res.status(502).json({ error: `no se pudo enviar la plantilla de WhatsApp: ${err.message}` });
    }

    const { rows: customerRows } = await pool.query(
      `INSERT INTO customers (whatsapp_number, full_name, address)
       VALUES ($1, $2, $3)
       ON CONFLICT (whatsapp_number) DO UPDATE SET full_name = $2, address = $3, updated_at = now()
       RETURNING id`,
      [phone, fullName.trim(), address.trim()]
    );
    const customerId = customerRows[0].id;

    await pool.query(
      `INSERT INTO tickets (customer_id, status, handoff_reason, assigned_advisor, first_response_at)
       VALUES ($1, 'en_atencion', 'contacto_proactivo', $2, now())`,
      [customerId, req.user.fullName]
    );

    const message = {
      type: 'ai',
      content: `Hola ${fullName.trim()}, te escribimos de Studio F Guatemala 😊 Un asesor quiere darte seguimiento personalizado. ¿Nos confirmas que podemos continuar la conversación por aquí?`,
      additional_kwargs: { sentBy: 'advisor', advisorName: req.user.fullName, template: OUTREACH_TEMPLATE_NAME },
      response_metadata: {},
      tool_calls: [],
    };
    const { rows: inserted } = await pool.query(
      `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb) RETURNING id, created_at`,
      [phone, JSON.stringify(message)]
    );

    res.status(201).json({ sessionId: phone, id: inserted[0].id, createdAt: inserted[0].created_at });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      WITH readable AS (
        -- Skip tool-call/tool-result rows (empty content, raw JSON) — only
        -- real human/assistant text counts as a "message" here.
        SELECT session_id, id, message, created_at
        FROM n8n_chat_histories
        WHERE message->>'type' IN ('human', 'ai')
          AND coalesce(message->>'content', '') <> ''
      ),
      phone_by_session AS (
        SELECT DISTINCT ON (session_id) session_id, trim(message->>'content') AS phone
        FROM readable
        WHERE message->>'type' = 'human'
          AND trim(message->>'content') ~ '^\\d{7,15}$'
        ORDER BY session_id, id ASC
      ),
      -- Once a phone is known, it — not the raw session_id — is the thread's identity,
      -- so every session_id that ever mentioned it collapses into one row. Production
      -- session_ids are already the real wa_id (phone, up to full E.164 length with
      -- country code), so that always wins over the old "first digit-looking message
      -- in the transcript" heuristic below, which exists only for legacy test sessions
      -- with random session_ids and would otherwise misfire on the DPI in the current
      -- intake flow.
      threaded AS (
        SELECT r.id, r.message, r.created_at,
               CASE WHEN r.session_id ~ '^\\d{7,15}$' THEN r.session_id ELSE p.phone END AS phone,
               CASE WHEN r.session_id ~ '^\\d{7,15}$' THEN r.session_id ELSE COALESCE(p.phone, r.session_id) END AS thread_key
        FROM readable r
        LEFT JOIN phone_by_session p USING (session_id)
      ),
      last_msg AS (
        SELECT DISTINCT ON (thread_key) thread_key, phone, id, message, created_at
        FROM threaded
        ORDER BY thread_key, id DESC
      ),
      counts AS (
        SELECT thread_key, count(*) AS message_count
        FROM threaded
        GROUP BY thread_key
      )
      SELECT l.thread_key, l.id AS last_id, l.message, l.created_at, cnt.message_count,
             l.phone, c.full_name, c.zone, c.paid_locked, t.status AS ticket_status,
             CASE WHEN c.id IS NULL THEN NULL ELSE (${EFFECTIVE_STATUS_SQL}) END AS temperature
      FROM last_msg l
      JOIN counts cnt USING (thread_key)
      LEFT JOIN customers c ON c.whatsapp_number = l.phone
      LEFT JOIN LATERAL (
        SELECT status FROM tickets
        WHERE customer_id = c.id AND status IN ('esperando_asesor', 'en_atencion')
        ORDER BY created_at DESC LIMIT 1
      ) t ON true
      ORDER BY l.id DESC
    `);
    // The advisor team handles every zone, so no zone filtering here.
    let visible = rows;

    const q = req.query.q?.trim().toLowerCase();
    if (q) {
      visible = visible.filter((r) =>
        (r.full_name ?? '').toLowerCase().includes(q) || (r.phone ?? '').includes(q)
      );
    }

    const { temperature } = req.query;
    if (temperature) {
      if (!VALID_TEMPERATURES.includes(temperature)) return res.status(400).json({ error: 'invalid temperature' });
      visible = visible.filter((r) => r.temperature === temperature);
    }

    res.json(visible.map((r) => ({
      sessionId: cleanSessionId(r.thread_key),
      lastId: r.last_id,
      lastMessageAt: r.created_at,
      messageCount: Number(r.message_count),
      lastMessage: r.message,
      customerName: r.full_name,
      phone: r.phone,
      ticketStatus: r.ticket_status,
      enAtencion: r.ticket_status === 'en_atencion',
      temperature: r.temperature,
      paidLocked: r.paid_locked ?? false,
    })));
  } catch (err) { next(err); }
});

router.get('/:sessionId', async (req, res, next) => {
  try {
    const { messages, customer, phone } = await findConversationThread(req.params.sessionId);
    if (!messages.length) return res.status(404).json({ error: 'not found' });

    if (customer) logAccess(req.user, customer.id, 'view_conversation');

    const messageIds = messages.map((r) => r.id);
    const { rows: attachments } = messageIds.length
      ? await pool.query(
          `SELECT id, n8n_message_id, kind, filename, mime_type, size_bytes
           FROM message_attachments WHERE n8n_message_id = ANY($1)`,
          [messageIds]
        )
      : { rows: [] };
    const attachmentByMessageId = new Map(attachments.map((a) => [a.n8n_message_id, a]));

    res.json({
      enAtencion: customer?.ticket_status === 'en_atencion',
      ticketId: customer?.ticket_id ?? null,
      ticketStatus: customer?.ticket_status ?? null,
      handoffReason: customer?.handoff_reason ?? null,
      customerId: customer?.id ?? null,
      customerName: customer?.full_name ?? null,
      department: customer?.department ?? null,
      municipio: customer?.municipio ?? null,
      preferredSize: customer?.preferred_size ?? null,
      preferredLine: customer?.preferred_line ?? null,
      purchaseFrequency: customer?.purchase_frequency ?? null,
      address: customer?.address ?? null,
      dpi: customer?.dpi ?? null,
      email: customer?.email ?? null,
      birthDate: customer?.birth_date ?? null,
      temperature: customer?.temperature ?? null,
      manualStatus: customer?.manual_status ?? null,
      paidLocked: customer?.paid_locked ?? false,
      paidMethod: customer?.paid_method ?? null,
      phone,
      messages: messages.map((r) => {
        const a = attachmentByMessageId.get(r.id);
        return {
          id: r.id,
          createdAt: r.created_at,
          ...r.message,
          attachment: a
            ? { id: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes }
            : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

router.post('/:sessionId/messages', async (req, res, next) => {
  try {
    const { content } = req.body ?? {};
    if (!content?.trim()) return res.status(400).json({ error: 'content required' });

    const { sessionIds, phone } = await findConversationThread(req.params.sessionId);
    if (!sessionIds?.length) return res.status(404).json({ error: 'conversation not found' });

    // Multiple session_ids can share one thread (see findConversationThread) — append
    // to the most recently active one so it stays in the bot's own memory window too.
    const { rows: latest } = await pool.query(
      `SELECT session_id FROM n8n_chat_histories WHERE session_id = ANY($1) ORDER BY id DESC LIMIT 1`,
      [sessionIds]
    );

    const message = {
      type: 'ai',
      content: content.trim(),
      additional_kwargs: { sentBy: 'advisor', advisorName: req.user.fullName },
      response_metadata: {},
      tool_calls: [],
    };
    const { rows: inserted } = await pool.query(
      `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb) RETURNING id, created_at`,
      [latest[0].session_id, JSON.stringify(message)]
    );
    res.status(201).json({ id: inserted[0].id, createdAt: inserted[0].created_at, ...message });

    // The advisor's confirmation shouldn't wait on WhatsApp's network round-trip —
    // it's already saved, so respond first and let delivery happen in the background.
    if (phone) whatsapp.sendText(phone, content.trim()).catch((err) => console.error('sendText failed', err));
  } catch (err) { next(err); }
});

router.post('/:sessionId/attachments', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required or file type not allowed' });

    const { sessionIds, phone } = await findConversationThread(req.params.sessionId);
    if (!sessionIds?.length) return res.status(404).json({ error: 'conversation not found' });

    const { rows: latest } = await pool.query(
      `SELECT session_id FROM n8n_chat_histories WHERE session_id = ANY($1) ORDER BY id DESC LIMIT 1`,
      [sessionIds]
    );

    const kind = MIME_KIND(req.file.mimetype);

    let mediaId = null;
    if (phone) {
      mediaId = await whatsapp.uploadMedia(req.file.buffer, req.file.mimetype);
      await whatsapp.sendMedia(phone, kind, mediaId, req.file.originalname);
    }

    const message = {
      type: 'ai',
      content: '',
      additional_kwargs: { sentBy: 'advisor', advisorName: req.user.fullName },
      response_metadata: {},
      tool_calls: [],
    };
    const { rows: inserted } = await pool.query(
      `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb) RETURNING id, created_at`,
      [latest[0].session_id, JSON.stringify(message)]
    );

    const attachmentId = await saveAttachment({
      n8nMessageId: inserted[0].id,
      kind,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
    });

    res.status(201).json({
      id: inserted[0].id,
      createdAt: inserted[0].created_at,
      ...message,
      attachment: { id: attachmentId, kind, filename: req.file.originalname, mimeType: req.file.mimetype, sizeBytes: req.file.buffer.length },
    });
  } catch (err) { next(err); }
});

export default router;
