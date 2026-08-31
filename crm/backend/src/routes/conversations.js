import { Router } from 'express';
import fs from 'fs';
import multer from 'multer';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';
import { EFFECTIVE_STATUS_SQL, VALID_TEMPERATURES } from './customers.js';
import * as whatsapp from '../whatsapp.js';
import { saveAttachment, isAllowedAttachmentMime } from '../attachmentStorage.js';
import { compressStoredAttachment } from '../attachmentCompression.js';

// WhatsApp's own per-type caps (not ours) — checked again per-kind below, once we know
// the file's mimetype. Multer's limit has to be a single outer bound before that, so it
// uses the largest of the three (documents) rather than an arbitrary smaller number that
// would reject a valid, under-the-WhatsApp-limit document before it even reaches that check.
const WHATSAPP_MAX_BYTES = { image: 5 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 100 * 1024 * 1024 };
const WHATSAPP_KIND_LABEL = { image: 'imágenes', audio: 'audios', document: 'documentos' };

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(...Object.values(WHATSAPP_MAX_BYTES)) },
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

// The real WhatsApp send happens in the background after the advisor already sees
// "sent" in the CRM (see the POST /messages and /attachments handlers below) — without
// this, a failure (customer outside the 24h window, invalid token, Meta rate limit...)
// was only ever a server-side console.error, completely invisible to the advisor and
// the customer never got the message. This makes the failure show up as a red mark on
// the message itself instead of vanishing silently.
async function markSendFailed(messageId, err) {
  console.error('WhatsApp send failed', err);
  // Store the reason too — without it, diagnosing "why didn't this arrive" means
  // digging through container logs that may already have rotated away. Meta's error
  // bodies are verbose, so keep just enough to identify the cause.
  const reason = String(err?.message ?? err).slice(0, 500);
  const { rows } = await pool.query(
    `UPDATE n8n_chat_histories
     SET message = jsonb_set(
           jsonb_set(message, '{additional_kwargs,status}', '"failed"'),
           '{additional_kwargs,statusError}', to_jsonb($2::text))
     WHERE id = $1 RETURNING session_id`,
    [messageId, reason]
  );
  if (rows.length) {
    await pool.query(`SELECT pg_notify('message_changes', json_build_object('session_id', $1::text)::text)`, [rows[0].session_id]);
  }
}

// Meta only delivers free-form messages within 24h of the customer's last inbound
// message. Outside that window the ONLY thing that gets through is an approved
// template — and a template does not reopen the window: just the customer replying
// does. So anything written into a closed window is queued, a template goes out to
// prompt a reply, and the queue flushes the moment they answer (see flushQueued below).
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function getConversationWindow(sessionIds) {
  const { rows } = await pool.query(
    `SELECT max(created_at) AS last_inbound_at FROM n8n_chat_histories
     WHERE session_id = ANY($1) AND message->>'type' = 'human'`,
    [sessionIds]
  );
  const lastInboundAt = rows[0]?.last_inbound_at ?? null;
  // No inbound at all means the customer never wrote, so there is no open window either.
  return { lastInboundAt, isOpen: !!lastInboundAt && Date.now() - new Date(lastInboundAt).getTime() < WINDOW_MS };
}

// One template per dormant stretch — the advisor writing five lines into a dead chat
// must not fire five billable templates at the customer, which is also how a number
// gets flagged. Anything already sent since the last inbound counts as "asked already".
async function reactivationAlreadySent(sessionIds, lastInboundAt) {
  const { rows } = await pool.query(
    `SELECT 1 FROM n8n_chat_histories
     WHERE session_id = ANY($1)
       AND (
         message->'additional_kwargs'->>'reactivationTemplate' = 'true'
         -- A broadcast template (difusión) already prompted the customer within this
         -- same dormant stretch — firing the reactivation template on top of that risks
         -- Meta's per-user marketing frequency cap for no benefit, since either one
         -- reopens the window the same way (only the customer's reply actually does).
         OR message->'additional_kwargs'->>'campaignId' IS NOT NULL
       )
       AND ($2::timestamptz IS NULL OR created_at > $2)
     LIMIT 1`,
    [sessionIds, lastInboundAt]
  );
  return rows.length > 0;
}

async function sendReactivationTemplate(sessionId, sessionIds, phone, lastInboundAt) {
  if (await reactivationAlreadySent(sessionIds, lastInboundAt)) return;
  await whatsapp.sendTemplate(phone, OUTREACH_TEMPLATE_NAME, OUTREACH_TEMPLATE_LANG);
  // The literal text the customer received, not a note about it — the advisor needs to
  // read what was actually said before writing the next line. Doubles as the marker
  // that tells reactivationAlreadySent() this dormant stretch is already covered.
  await pool.query(
    `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb)`,
    [sessionId, JSON.stringify({
      type: 'ai',
      content: OUTREACH_TEMPLATE_BODY,
      additional_kwargs: { sentBy: 'sistema', reactivationTemplate: true },
      response_metadata: {},
      tool_calls: [],
    })]
  );
}

// A send that resolves without giving us a wamid never reached WhatsApp either — Meta
// always returns one for an accepted message. Treated as a failure rather than "no tick
// to update", which is how it used to slip through unnoticed.
async function handleSendResult(messageId, result) {
  const sentWamid = result?.messages?.[0]?.id;
  if (!sentWamid) {
    return markSendFailed(messageId, new Error('WhatsApp no devolvió un id de mensaje — el envío no se confirmó'));
  }
  await pool.query(
    `UPDATE n8n_chat_histories SET message = jsonb_set(message, '{additional_kwargs,wamid}', $2::jsonb) WHERE id = $1`,
    [messageId, JSON.stringify(sentWamid)]
  );
  // Only now that delivery is confirmed — the queued/orphan-recovery paths re-read this
  // exact file from disk to send it, so compressing any earlier would ship a lower
  // quality photo to the customer instead of just shrinking what the CRM stores.
  const { rows } = await pool.query(`SELECT id FROM message_attachments WHERE n8n_message_id = $1`, [messageId]);
  if (rows.length) compressStoredAttachment(rows[0].id);
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
  // The most recent ticket regardless of status — not just active ones. A resolved
  // ticket still means a human has this relationship; the compose box shouldn't lock
  // back up and pretend it's "bot" again just because the last issue was closed out.
  // erp_customers.telefono/celular are bare 8-digit Guatemala local numbers with no
  // country code, while whatsapp_number is the full number (country code included) —
  // matched by the last 8 digits instead of an exact match, which would never hit.
  // A customer with no purchase in the ERP simply gets no match here — every erp_*
  // field below comes back null, nothing else about their profile is affected.
  const { rows } = await pool.query(
    `SELECT c.id, c.full_name, c.zone, c.department, c.municipio, c.preferred_line, c.preferred_size, c.purchase_frequency, c.address,
            c.dpi, c.email, c.birth_date,
            c.paid_locked, c.paid_method, c.manual_status, ${EFFECTIVE_STATUS_SQL} AS temperature,
            t.id AS ticket_id, t.status AS ticket_status, t.handoff_reason,
            e.nombre AS erp_nombre, e.venta_neta_total AS erp_venta_neta_total,
            e.facturas_totales AS erp_facturas_totales, e.unidades_totales AS erp_unidades_totales,
            e.fecha_ultima_compra AS erp_fecha_ultima_compra, e.dias_sin_compra AS erp_dias_sin_compra,
            e.segmento_sin_compra AS erp_segmento_sin_compra, e.sucursal_preferida AS erp_sucursal_preferida,
            e.blusas AS erp_blusas, e.jeans AS erp_jeans, e.vestidos AS erp_vestidos,
            e.pantalones AS erp_pantalones, e.otros AS erp_otros,
            e.talla_blusa AS erp_talla_blusa, e.talla_jean AS erp_talla_jean, e.talla_calzado AS erp_talla_calzado
     FROM customers c
     LEFT JOIN LATERAL (
       SELECT id, status, handoff_reason FROM tickets
       WHERE customer_id = c.id
       ORDER BY created_at DESC LIMIT 1
     ) t ON true
     LEFT JOIN LATERAL (
       SELECT * FROM erp_customers
       WHERE right(c.whatsapp_number, 8) IN (telefono, celular)
       ORDER BY venta_neta_total DESC NULLS LAST LIMIT 1
     ) e ON true
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
async function resolveSessionIds(threadKey) {
  if (PHONE_RE.test(threadKey)) {
    // Production session_ids are the phone itself, but some channels stamp a suffix
    // on it (e.g. "<phone>__whatsapp") — LIKE-prefix match instead of exact-match so
    // those aren't silently invisible to this lookup even though the list (which
    // strips the suffix the same way) shows them just fine. The content-equals-phone
    // clause is only there for legacy sessions (random session_id) that merge into
    // this thread because the customer once typed their own number as a message.
    const { rows } = await pool.query(
      `SELECT DISTINCT session_id FROM n8n_chat_histories
       WHERE session_id LIKE $1 || '%'
          OR (message->>'type' = 'human' AND trim(message->>'content') = $1)`,
      [threadKey]
    );
    return rows.map((r) => r.session_id);
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT session_id FROM n8n_chat_histories WHERE session_id LIKE $1`,
    [`${threadKey}%`]
  );
  return rows.map((r) => r.session_id);
}

export async function findConversationThread(threadKey, { limit = 50 } = {}) {
  const sessionIds = await resolveSessionIds(threadKey);
  if (!sessionIds.length) return { messages: [], customer: null, phone: null, hasMoreOlder: false };

  // A long-running customer's full history used to load unconditionally on every open,
  // every 15s poll, and every live event while the thread was open — the same "loads
  // everything, gets slower as it grows" problem already fixed for the conversation
  // list. Only the most recent `limit` messages load by default; the frontend grows
  // `limit` and re-fetches when the advisor scrolls up wanting older ones.
  const { rows: messagesDesc } = await pool.query(
    `SELECT id, message, created_at FROM n8n_chat_histories WHERE session_id = ANY($1) ORDER BY id DESC LIMIT $2`,
    [sessionIds, limit]
  );
  const messages = messagesDesc.reverse();
  const hasMoreOlder = messagesDesc.length === limit;

  // Was previously read off of `messages` itself, which broke once that stopped being
  // the full history — a targeted query stays correct regardless of the page window,
  // and only runs at all for legacy sessions where the key isn't already the phone.
  const phone = PHONE_RE.test(threadKey)
    ? threadKey
    : await (async () => {
        const { rows } = await pool.query(
          `SELECT trim(message->>'content') AS phone FROM n8n_chat_histories
           WHERE session_id = ANY($1) AND message->>'type' = 'human' AND trim(message->>'content') ~ '^\\d{7,15}$'
           ORDER BY id ASC LIMIT 1`,
          [sessionIds]
        );
        return rows[0]?.phone ?? null;
      })();

  const customer = phone ? (await findCustomerByPhone(phone)).customer : null;
  return { messages, customer, phone, sessionIds, hasMoreOlder };
}

// The template must already be approved in Meta's WhatsApp Manager under this exact
// name/language — see the CRM ops notes for the approved wording ("seguimiento_asesor").
const OUTREACH_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'seguimiento_asesor';

// Mirror of the body approved in WhatsApp Manager. Meta sends the real thing from its
// own copy; this only goes into the CRM transcript so the advisor sees exactly what the
// customer received. If the template is edited in Meta, edit this line to match or the
// transcript lies.
//
// Deliberately parameterless: most customers never give their name, so a "Hola {{1}}"
// template forced a guess for the majority of sends, and Meta rejects empty parameters
// so there was no way to just leave it out. Greeting nobody by name is better than
// greeting them wrong. Also generic enough that ONE template covers both uses —
// first contact, and waking a conversation that went past the 24h window.
const OUTREACH_TEMPLATE_BODY =
  '¡Hola! 👋 Te escribimos de Studio F Guatemala ✨ Nos gustaría brindarte información sobre nuestras prendas, tallas y envíos, y resolver cualquier duda que tengas. Responde este mensaje y un asesor te atiende enseguida 😊';
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
      await whatsapp.sendTemplate(phone, OUTREACH_TEMPLATE_NAME, OUTREACH_TEMPLATE_LANG);
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
      content: OUTREACH_TEMPLATE_BODY,
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
    const { q, temperature, ticketStatus } = req.query;
    const unreadOnly = req.query.unread === 'true';
    // Loading every conversation up front got heavy once the list passed ~1000 threads.
    // Filters run in JS below (over fields the SQL doesn't have a clean WHERE for), so a
    // filtered view still needs the full set — only the plain, most-common "just open the
    // list" case is capped here, newest-active first, with the frontend paging in more as
    // the advisor scrolls. Unread is always a small slice of the total regardless of how
    // many threads exist, so it's cheap to never cap — capping it was the bug: the "no
    // leído" filter and the sidebar badge were both silently missing any unread thread
    // that fell outside the default recency window instead of showing every real one.
    const hasFilter = !!(q?.trim() || temperature || ticketStatus || unreadOnly);
    const limit = hasFilter ? null : Math.min(Number(req.query.limit) || 50, 5000);
    const { rows } = await pool.query(`
      WITH readable AS (
        -- Skip tool-call/tool-result rows (empty content, raw JSON) — only real
        -- human/assistant messages count here. Empty content alone can't be the test
        -- though: a photo or document sent with no caption is a real message with an
        -- empty content field, and excluding it meant a customer who sent only a photo
        -- never bumped the thread's position, never raised its unread badge and never
        -- showed in the preview — the advisor had no signal anything had arrived.
        SELECT h.session_id, h.id, h.message, h.created_at
        FROM n8n_chat_histories h
        WHERE h.message->>'type' IN ('human', 'ai')
          AND (
            coalesce(h.message->>'content', '') <> ''
            OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
          )
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
        -- n8n stamps some channels' session_ids as "<phone>__whatsapp" (or similar) —
        -- strip everything from the first "__" on before testing/using it as the phone,
        -- the same way cleanSessionId() does on the JS side. Without this, a suffixed
        -- session_id with no phone-as-message fallback resolves to a NULL phone, which
        -- silently breaks the customer/ticket join and unread counting for that thread.
        SELECT r.id, r.message, r.created_at,
               CASE WHEN split_part(r.session_id, '__', 1) ~ '^\\d{7,15}$' THEN split_part(r.session_id, '__', 1) ELSE p.phone END AS phone,
               CASE WHEN split_part(r.session_id, '__', 1) ~ '^\\d{7,15}$' THEN split_part(r.session_id, '__', 1) ELSE COALESCE(p.phone, r.session_id) END AS thread_key
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
      ),
      -- Read state is shared across the whole team (one watermark per phone, not per
      -- advisor) — whoever opens the thread first marks it read for everyone, same as
      -- a shared support inbox. Counts only customer messages newer than that watermark.
      unread_counts AS (
        SELECT th.thread_key, count(*) AS unread_count
        FROM threaded th
        LEFT JOIN conversation_reads cr ON cr.phone = th.phone
        WHERE th.message->>'type' = 'human' AND th.id > COALESCE(cr.last_read_message_id, 0)
        GROUP BY th.thread_key
      )
      SELECT l.thread_key, l.id AS last_id, l.message, l.created_at, cnt.message_count,
             l.phone, c.full_name, c.zone, c.paid_locked, t.status AS ticket_status,
             CASE WHEN c.id IS NULL THEN NULL ELSE (${EFFECTIVE_STATUS_SQL}) END AS temperature,
             COALESCE(uc.unread_count, 0) AS unread_count,
             att.kind AS last_attachment_kind, att.filename AS last_attachment_filename
      FROM last_msg l
      JOIN counts cnt USING (thread_key)
      LEFT JOIN unread_counts uc USING (thread_key)
      -- So the preview can name the file when the last message is an attachment with
      -- no caption, instead of rendering an empty line.
      LEFT JOIN message_attachments att ON att.n8n_message_id = l.id
      LEFT JOIN customers c ON c.whatsapp_number = l.phone
      LEFT JOIN LATERAL (
        SELECT status FROM tickets
        WHERE customer_id = c.id
        ORDER BY created_at DESC LIMIT 1
      ) t ON true
      ORDER BY l.id DESC
      ${limit ? 'LIMIT $1' : ''}
    `, limit ? [limit] : []);
    // The advisor team handles every zone, so no zone filtering here.
    let visible = rows;

    const qLower = q?.trim().toLowerCase();
    if (qLower) {
      visible = visible.filter((r) =>
        (r.full_name ?? '').toLowerCase().includes(qLower) || (r.phone ?? '').includes(qLower)
      );
    }

    if (temperature) {
      if (!VALID_TEMPERATURES.includes(temperature)) return res.status(400).json({ error: 'invalid temperature' });
      visible = visible.filter((r) => r.temperature === temperature);
    }

    // "bot" isn't a real ticket status — it means no active ticket exists at all.
    const VALID_TICKET_FILTERS = ['bot', 'esperando_asesor', 'en_atencion', 'resuelto'];
    if (ticketStatus) {
      if (!VALID_TICKET_FILTERS.includes(ticketStatus)) return res.status(400).json({ error: 'invalid ticketStatus' });
      visible = visible.filter((r) => (ticketStatus === 'bot' ? !r.ticket_status : r.ticket_status === ticketStatus));
    }

    if (unreadOnly) {
      visible = visible.filter((r) => Number(r.unread_count) > 0);
    }

    res.json(visible.map((r) => ({
      sessionId: cleanSessionId(r.thread_key),
      lastId: r.last_id,
      lastMessageAt: r.created_at,
      messageCount: Number(r.message_count),
      lastMessage: r.message,
      lastAttachment: r.last_attachment_kind
        ? { kind: r.last_attachment_kind, filename: r.last_attachment_filename }
        : null,
      customerName: r.full_name,
      phone: r.phone,
      ticketStatus: r.ticket_status,
      // Resuelto still lets the advisor keep typing — only "no ticket at all yet" and
      // "esperando_asesor" (needs to be taken first) lock the compose box.
      enAtencion: r.ticket_status === 'en_atencion' || r.ticket_status === 'resuelto',
      temperature: r.temperature,
      paidLocked: r.paid_locked ?? false,
      unreadCount: Number(r.unread_count),
    })));
  } catch (err) { next(err); }
});

// Searches every conversation, not just whatever's currently open — WhatsApp's own
// "search all chats" feature. Registered before /:sessionId on purpose: Express would
// otherwise match "search-all" as a sessionId value on that route instead of this one.
// distanceFromLatest lets the frontend jump straight to the exact message in whichever
// chat it's in, reusing the same grow-the-window trick as the in-chat search.
router.get('/search-all', async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json([]);
    const { rows } = await pool.query(
      `WITH matches AS (
         SELECT h.id, h.session_id, h.message->>'content' AS content, h.created_at,
                (SELECT count(*) FROM n8n_chat_histories h2 WHERE h2.session_id = h.session_id AND h2.id >= h.id) AS distance_from_latest
         FROM n8n_chat_histories h
         WHERE h.message->>'content' ILIKE $1
         ORDER BY h.id DESC
         LIMIT 30
       )
       SELECT m.*, split_part(m.session_id, '__', 1) AS phone, c.full_name
       FROM matches m
       LEFT JOIN customers c ON c.whatsapp_number = split_part(m.session_id, '__', 1)
       ORDER BY m.id DESC`,
      [`%${q}%`]
    );
    res.json(rows.map((r) => ({
      id: r.id,
      sessionId: cleanSessionId(r.session_id),
      customerName: r.full_name,
      phone: r.phone,
      content: r.content,
      createdAt: r.created_at,
      distanceFromLatest: Number(r.distance_from_latest),
    })));
  } catch (err) { next(err); }
});

router.get('/:sessionId', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 5000);
    const { messages, customer, phone, hasMoreOlder } = await findConversationThread(req.params.sessionId, { limit });
    if (!messages.length) return res.status(404).json({ error: 'not found' });

    if (customer) logAccess(req.user, customer.id, 'view_conversation');

    // Read state is shared across the team — whichever advisor opens the thread first
    // marks it read for everyone, same as a shared support inbox. Doesn't block the
    // response; the list picks up the change on its next refresh (SSE-driven).
    if (phone) {
      const maxId = messages[messages.length - 1].id;
      pool.query(
        `INSERT INTO conversation_reads (phone, last_read_message_id, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (phone) DO UPDATE SET last_read_message_id = GREATEST(conversation_reads.last_read_message_id, $2), updated_at = now()`,
        [phone, maxId]
      )
        .then(() => pool.query(`SELECT pg_notify('read_changes', $1)`, [phone]))
        .catch((err) => console.error('mark conversation read failed', err));
    }

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
      enAtencion: customer?.ticket_status === 'en_atencion' || customer?.ticket_status === 'resuelto',
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
      // null when this phone has no match in erp_customers — the frontend hides the
      // whole section in that case, same as any other "cliente nuevo, sin historial".
      erp: customer?.erp_nombre == null ? null : {
        nombre: customer.erp_nombre,
        ventaNetaTotal: customer.erp_venta_neta_total,
        facturasTotales: customer.erp_facturas_totales,
        unidadesTotales: customer.erp_unidades_totales,
        fechaUltimaCompra: customer.erp_fecha_ultima_compra,
        diasSinCompra: customer.erp_dias_sin_compra,
        segmentoSinCompra: customer.erp_segmento_sin_compra,
        sucursalPreferida: customer.erp_sucursal_preferida,
        blusas: customer.erp_blusas,
        jeans: customer.erp_jeans,
        vestidos: customer.erp_vestidos,
        pantalones: customer.erp_pantalones,
        otros: customer.erp_otros,
        tallaBlusa: customer.erp_talla_blusa,
        tallaJean: customer.erp_talla_jean,
        tallaCalzado: customer.erp_talla_calzado,
      },
      paidLocked: customer?.paid_locked ?? false,
      paidMethod: customer?.paid_method ?? null,
      phone,
      hasMoreOlder,
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

// A customer's native WhatsApp quote-reply only carries the wamid of what they replied
// to, not a snapshot of it (unlike the advisor's own reply button, which stores one at
// send time) — the preview has to look that message up. If it's older than the
// currently-loaded page, this fetches just that one row instead of growing the whole
// window just to render a quote. Reuses the wamid partial index already built for the
// delivery-status webhook.
router.get('/:sessionId/message-by-wamid/:wamid', async (req, res, next) => {
  try {
    const sessionIds = await resolveSessionIds(req.params.sessionId);
    if (!sessionIds.length) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      `SELECT h.id, h.message, h.created_at,
              (SELECT count(*) FROM n8n_chat_histories h2 WHERE h2.session_id = ANY($1) AND h2.id >= h.id) AS distance_from_latest
       FROM n8n_chat_histories h
       WHERE h.session_id = ANY($1) AND h.message->'additional_kwargs'->>'wamid' = $2
       LIMIT 1`,
      [sessionIds, req.params.wamid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const r = rows[0];
    const { rows: attRows } = await pool.query(
      `SELECT id, kind, filename, mime_type, size_bytes FROM message_attachments WHERE n8n_message_id = $1`,
      [r.id]
    );
    const a = attRows[0];
    res.json({
      id: r.id,
      createdAt: r.created_at,
      ...r.message,
      attachment: a ? { id: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes } : null,
      // Lets the frontend grow its loaded window to exactly fit this message before
      // trying to scroll to it, the same trick already used for in-chat search jumps.
      distanceFromLatest: Number(r.distance_from_latest),
    });
  } catch (err) { next(err); }
});

// The advisor's own reply button snapshots the quoted message's content at send time
// (id, text, from), so unlike a customer's native quote-reply there's nothing to fetch
// to render the preview — only distanceFromLatest is missing, needed to size the window
// before jumping to it if it's older than what's currently loaded.
router.get('/:sessionId/message-distance/:id', async (req, res, next) => {
  try {
    const sessionIds = await resolveSessionIds(req.params.sessionId);
    if (!sessionIds.length) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      `SELECT count(*) AS distance_from_latest FROM n8n_chat_histories
       WHERE session_id = ANY($1) AND id >= $2`,
      [sessionIds, req.params.id]
    );
    if (Number(rows[0].distance_from_latest) === 0) return res.status(404).json({ error: 'not found' });
    res.json({ distanceFromLatest: Number(rows[0].distance_from_latest) });
  } catch (err) { next(err); }
});

// Searches the WHOLE thread, not just whatever page is currently loaded in the UI —
// the message list only ever keeps the most recent `limit` in memory. distanceFromLatest
// tells the frontend how big a "most recent N" window it needs to request for this
// result to actually be in `messages`, so it can jump straight there.
router.get('/:sessionId/search', async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json([]);
    const sessionIds = await resolveSessionIds(req.params.sessionId);
    if (!sessionIds.length) return res.json([]);
    const { rows } = await pool.query(
      `SELECT h.id, h.message->>'content' AS content, h.message->>'type' AS type, h.created_at,
              (SELECT count(*) FROM n8n_chat_histories h2 WHERE h2.session_id = ANY($1) AND h2.id >= h.id) AS distance_from_latest
       FROM n8n_chat_histories h
       WHERE h.session_id = ANY($1) AND h.message->>'content' ILIKE $2
       ORDER BY h.id DESC LIMIT 25`,
      [sessionIds, `%${q}%`]
    );
    res.json(rows.map((r) => ({
      id: r.id, content: r.content, type: r.type, createdAt: r.created_at,
      distanceFromLatest: Number(r.distance_from_latest),
    })));
  } catch (err) { next(err); }
});

// Advisor peeked at a thread and has to step away — rolls the read watermark back
// to the last advisor/bot reply so the badge shows exactly the customer's messages
// still waiting on a response, instead of forcing them to remember unassisted.
router.post('/:sessionId/mark-unread', async (req, res, next) => {
  try {
    const { messages, phone } = await findConversationThread(req.params.sessionId);
    if (!messages.length || !phone) return res.status(404).json({ error: 'not found' });

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.message?.type !== 'human') {
      return res.status(400).json({ error: 'nothing pending to mark unread' });
    }

    const lastReply = [...messages].reverse().find((r) => r.message?.type === 'ai');
    const watermark = lastReply ? lastReply.id : 0;

    await pool.query(
      `INSERT INTO conversation_reads (phone, last_read_message_id, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (phone) DO UPDATE SET last_read_message_id = $2, updated_at = now()`,
      [phone, watermark]
    );
    await pool.query(`SELECT pg_notify('read_changes', $1)`, [phone]);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// "Bot" state means no ticket row exists yet for this customer at all — normally
// that's fine, but the n8n handoff can fail to fire (or a customer never triggers
// it) leaving them stuck with no ticket for an advisor to take. This lets an advisor
// claim it directly: upserts the customer row (may not exist yet — the bot may never
// have saved their data) and opens a ticket straight into en_atencion.
router.post('/:sessionId/take', async (req, res, next) => {
  try {
    const { phone } = await findConversationThread(req.params.sessionId);
    if (!phone) return res.status(404).json({ error: 'not found' });

    const { rows: customerRows } = await pool.query(
      `INSERT INTO customers (whatsapp_number) VALUES ($1)
       ON CONFLICT (whatsapp_number) DO UPDATE SET whatsapp_number = excluded.whatsapp_number
       RETURNING id`,
      [phone]
    );
    const customerId = customerRows[0].id;

    const { rows: ticketRows } = await pool.query(
      `INSERT INTO tickets (customer_id, status, handoff_reason, assigned_advisor, first_response_at)
       VALUES ($1, 'en_atencion', 'tomado_manualmente', $2, now())
       RETURNING id, status`,
      [customerId, req.user.fullName]
    );

    res.json({ ticketId: ticketRows[0].id, ticketStatus: ticketRows[0].status });
  } catch (err) { next(err); }
});

router.post('/:sessionId/messages', async (req, res, next) => {
  try {
    const { content, replyTo } = req.body ?? {};
    if (!content?.trim()) return res.status(400).json({ error: 'content required' });

    const { sessionIds, phone } = await findConversationThread(req.params.sessionId);
    if (!sessionIds?.length) return res.status(404).json({ error: 'conversation not found' });

    // Multiple session_ids can share one thread (see findConversationThread) — append
    // to the most recently active one so it stays in the bot's own memory window too.
    const { rows: latest } = await pool.query(
      `SELECT session_id FROM n8n_chat_histories WHERE session_id = ANY($1) ORDER BY id DESC LIMIT 1`,
      [sessionIds]
    );

    const windowState = await getConversationWindow(sessionIds);

    const message = {
      type: 'ai',
      content: content.trim(),
      additional_kwargs: {
        sentBy: 'advisor',
        advisorName: req.user.fullName,
        // Held rather than sent: Meta would reject it outright right now. It goes out
        // by itself as soon as the customer answers the reactivation template below.
        ...(windowState.isOpen ? {} : { status: 'queued' }),
        // Snapshot, not a live reference — the quoted message stays exactly as it
        // looked when the advisor hit reply, even if the thread scrolls past it.
        ...(replyTo?.id ? { replyTo: {
          id: replyTo.id,
          content: String(replyTo.content ?? '').slice(0, 300),
          from: replyTo.from ?? null,
          attachmentKind: replyTo.attachmentKind ?? null,
          attachmentId: replyTo.attachmentId ?? null,
        } } : {}),
      },
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
    // ponytail: fire-and-forget, so a container restart in the gap between this insert
    // and the send completing orphans the message — saved, never sent, never marked
    // failed. Narrow window (a deploy landing mid-send), but the honest fix is an outbox
    // table + a worker that retries anything still without a wamid after a few minutes.
    // replyTo.wamid (only present for customer messages n8n tagged with their WhatsApp
    // message id) makes this show as a native quoted reply on the customer's phone too.
    // We also save OUR OWN wamid back onto the row once Meta returns it, so that if the
    // customer later replies to THIS message using WhatsApp's own quote feature, we can
    // match their context.id back to it and show what they're replying to in the CRM.
    // No phone means there is nobody to deliver to — previously this branch just did
    // nothing at all, leaving the message sitting in the CRM looking sent forever.
    if (!phone) {
      markSendFailed(inserted[0].id, new Error('La conversación no tiene un número de teléfono asociado'))
        .catch((e) => console.error('markSendFailed failed', e));
    } else if (!windowState.isOpen) {
      // Queued above; all that happens now is nudging the customer to reply so the
      // window reopens and flushQueuedMessages() can release it.
      sendReactivationTemplate(latest[0].session_id, sessionIds, phone, windowState.lastInboundAt)
        .catch((err) => markSendFailed(inserted[0].id, err).catch((e) => console.error('markSendFailed failed', e)));
    } else {
      whatsapp.sendText(phone, content.trim(), replyTo?.wamid)
        .then((result) => handleSendResult(inserted[0].id, result))
        .catch((err) => markSendFailed(inserted[0].id, err).catch((e) => console.error('markSendFailed failed', e)));
    }
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

    const maxBytes = WHATSAPP_MAX_BYTES[kind] ?? WHATSAPP_MAX_BYTES.document;
    if (req.file.size > maxBytes) {
      return res.status(400).json({
        error: `El archivo pesa demasiado para WhatsApp (máx. ${Math.floor(maxBytes / (1024 * 1024))}MB para ${WHATSAPP_KIND_LABEL[kind] ?? 'documentos'}).`,
      });
    }

    const caption = (req.body?.caption ?? '').trim();

    const windowState = await getConversationWindow(sessionIds);

    const message = {
      type: 'ai',
      content: caption,
      additional_kwargs: {
        sentBy: 'advisor',
        advisorName: req.user.fullName,
        ...(windowState.isOpen ? {} : { status: 'queued' }),
      },
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

    // Saved and shown already — the two sequential Meta round-trips (upload the media,
    // then send it) happen in the background instead of making the advisor wait on them,
    // same as text messages.
    res.status(201).json({
      id: inserted[0].id,
      createdAt: inserted[0].created_at,
      ...message,
      attachment: { id: attachmentId, kind, filename: req.file.originalname, mimeType: req.file.mimetype, sizeBytes: req.file.buffer.length },
    });

    if (!phone) {
      markSendFailed(inserted[0].id, new Error('La conversación no tiene un número de teléfono asociado'))
        .catch((e) => console.error('markSendFailed failed', e));
    } else if (!windowState.isOpen) {
      // The file is already on disk, so the flush re-uploads it from there once the
      // customer replies — this is exactly the case that lost the guía photo.
      sendReactivationTemplate(latest[0].session_id, sessionIds, phone, windowState.lastInboundAt)
        .catch((err) => markSendFailed(inserted[0].id, err).catch((e) => console.error('markSendFailed failed', e)));
    } else {
      whatsapp.uploadMedia(req.file.buffer, req.file.mimetype)
        .then((mediaId) => whatsapp.sendMedia(phone, kind, mediaId, req.file.originalname, caption || undefined))
        .then((result) => handleSendResult(inserted[0].id, result))
        .catch((err) => markSendFailed(inserted[0].id, err).catch((e) => console.error('markSendFailed failed', e)));
    }
  } catch (err) { next(err); }
});

// Called by the listener whenever any row lands in n8n_chat_histories. If that row was
// the customer answering, the 24h window just reopened and everything the advisor wrote
// while it was shut can finally go out — in the order they wrote it. This is what makes
// a dead conversation resume by itself instead of the advisor having to remember.
// Sends a message that is already stored in the transcript — used both when the queue
// is released and when a restart-orphaned send is recovered. Attachments are re-read
// from disk, since the original upload buffer is long gone by then.
async function deliverStoredMessage(row, phone, attachment) {
  let result;
  if (attachment) {
    const buffer = await fs.promises.readFile(attachment.file_path);
    const mediaId = await whatsapp.uploadMedia(buffer, attachment.mime_type);
    result = await whatsapp.sendMedia(phone, attachment.kind, mediaId, attachment.filename, row.message.content || undefined);
  } else {
    result = await whatsapp.sendText(phone, row.message.content);
  }
  const sentWamid = result?.messages?.[0]?.id;
  if (!sentWamid) throw new Error('WhatsApp no devolvió un id de mensaje — el envío no se confirmó');
  await pool.query(
    `UPDATE n8n_chat_histories SET message = jsonb_set(
       jsonb_set(message, '{additional_kwargs,status}', '"sent"'),
       '{additional_kwargs,wamid}', $2::jsonb) WHERE id = $1`,
    [row.id, JSON.stringify(sentWamid)]
  );
  // Only now, delivery confirmed — this function is exactly what re-reads the file from
  // disk to send it, so compressing any earlier would ship the customer a lower-quality
  // photo instead of just shrinking what the CRM keeps.
  if (attachment) compressStoredAttachment(attachment.id);
}

export async function flushQueuedMessages(rawSessionId) {
  if (!rawSessionId) return;
  const { sessionIds, phone } = await findConversationThread(cleanSessionId(rawSessionId));
  if (!phone || !sessionIds?.length) return;

  const { rows: queued } = await pool.query(
    `SELECT id, message FROM n8n_chat_histories
     WHERE session_id = ANY($1) AND message->'additional_kwargs'->>'status' = 'queued'
     ORDER BY id ASC`,
    [sessionIds]
  );
  if (!queued.length) return;

  // Re-check rather than trust the notification: the row that woke us could have been
  // our own outgoing message, in which case the window is still shut.
  const { isOpen } = await getConversationWindow(sessionIds);
  if (!isOpen) return;

  const { rows: attachments } = await pool.query(
    `SELECT id, n8n_message_id, kind, filename, mime_type, file_path FROM message_attachments
     WHERE n8n_message_id = ANY($1)`,
    [queued.map((q) => q.id)]
  );
  const attachmentFor = new Map(attachments.map((a) => [a.n8n_message_id, a]));

  for (const row of queued) {
    try {
      await deliverStoredMessage(row, phone, attachmentFor.get(row.id));
    } catch (err) {
      // Stop on the first failure: the rest would fail the same way, and burning
      // through the whole queue just multiplies the errors the customer might see.
      await markSendFailed(row.id, err).catch((e) => console.error('markSendFailed failed', e));
      break;
    }
  }
  await pool.query(`SELECT pg_notify('message_changes', json_build_object('session_id', $1::text)::text)`, [sessionIds[0]]);
}

// Recovers sends orphaned by a restart. The real WhatsApp call happens in a background
// promise after the row is already stored, so a container dying in that gap (a deploy
// landing mid-send) left a message saved, never sent, and never marked failed — the
// advisor saw a normal checkmark forever. No outbox table needed: a stored outgoing
// message with no wamid and no terminal status IS a pending send.
//
// Three bounds keep this from doing damage, and none of them are optional:
//   - sentBy = 'advisor': bot replies land in this same table from n8n, which sends
//     them itself. Sweeping those would re-send every bot message ever written.
//   - older than 2 minutes: anything younger may still be in flight right now.
//   - younger than 1 hour: without an upper bound, the first run after deploy would
//     pick up every historical message that predates wamid stamping and blast it at
//     customers. An orphan from a restart is minutes old; nothing older is ours to fix.
//
// ponytail: retrying can duplicate a message that Meta actually accepted just before
// the crash (we can't tell — the send API has no idempotency key). A duplicate is
// recoverable, a silently lost message is the bug we're here to kill, so it retries.
export async function recoverOrphanedSends() {
  const { rows: orphans } = await pool.query(
    `SELECT id, session_id, message FROM n8n_chat_histories
     WHERE message->>'type' = 'ai'
       AND message->'additional_kwargs'->>'sentBy' = 'advisor'
       AND message->'additional_kwargs'->>'wamid' IS NULL
       AND coalesce(message->'additional_kwargs'->>'status', '') NOT IN ('failed', 'queued')
       AND created_at < now() - interval '2 minutes'
       AND created_at > now() - interval '1 hour'
     ORDER BY id ASC
     LIMIT 25`
  );
  if (!orphans.length) return 0;
  console.warn(`recovering ${orphans.length} orphaned send(s)`);

  const { rows: attachments } = await pool.query(
    `SELECT id, n8n_message_id, kind, filename, mime_type, file_path FROM message_attachments
     WHERE n8n_message_id = ANY($1)`,
    [orphans.map((o) => o.id)]
  );
  const attachmentFor = new Map(attachments.map((a) => [a.n8n_message_id, a]));

  let recovered = 0;
  for (const row of orphans) {
    try {
      const { sessionIds, phone } = await findConversationThread(cleanSessionId(row.session_id));
      if (!phone) throw new Error('La conversación no tiene un número de teléfono asociado');

      // Time passed while we were down, so the window may have shut in the meantime.
      // Hand it to the queue rather than burning a doomed send — the reactivation
      // template and the flush-on-reply already know what to do with it.
      const { isOpen } = await getConversationWindow(sessionIds);
      if (!isOpen) {
        await pool.query(
          `UPDATE n8n_chat_histories
           SET message = jsonb_set(message, '{additional_kwargs,status}', '"queued"') WHERE id = $1`,
          [row.id]
        );
        continue;
      }

      await deliverStoredMessage(row, phone, attachmentFor.get(row.id));
      recovered += 1;
    } catch (err) {
      await markSendFailed(row.id, err).catch((e) => console.error('markSendFailed failed', e));
    }
  }
  return recovered;
}

export default router;
