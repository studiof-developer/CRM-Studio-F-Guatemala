import { Router } from 'express';
import { pool } from '../db.js';
import { isValidStatus } from '../ticketStatus.js';
import { logAccess, logBusinessAction } from '../auditLog.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';

const router = Router();

const TICKET_STATUS_LABELS = { esperando_asesor: 'Pendiente', en_atencion: 'En atención', resuelto: 'Resuelto' };

// The advisor team handles every zone for Studio F Guatemala (not zone-assigned
// individually), so this is a no-op — kept as a hook in case that ever changes.
function zoneClause() {
  return '';
}

// Every column a contact can land in, and the order they're drawn in on the board.
// "pendiente" and "resuelto" come straight from the ticket's own status; everything
// else in between is really the customer's temperature wearing a pipeline-stage name
// (see the 2026-08-31 conversation that settled this — Cotización is just "tibio",
// Medio de pago is "caliente", etc., under a name that means something to an advisor
// instead of a weather word). One ticket can only ever be in exactly one column, so
// this is a strict priority order, not a set of independent flags: a resolved ticket
// shows as resuelto no matter what temperature is sitting on the customer underneath.
// "despacho" (2026-09-11) is manual-only — temperature never computes it automatically
// (TEMPERATURE_SQL in customers.js only ever produces frio/tibio/caliente/pagado), an
// advisor sets it themselves once a paid order starts shipping (drag, or the Estado
// dropdown in the chat panel).
export const PIPELINE_COLUMNS = ['pendiente', 'en_atencion', 'cotizacion', 'medio_pago', 'pagado', 'despacho', 'pqrs', 'resuelto'];

// Both temped CTEs below exclude 'bot' (never handed off to a human yet) AND
// 'difusion_enviada' — a No atendidos contact who just got a broadcast (campaigns.js)
// lands here: reached, but not by an advisor, so it doesn't belong in En atención
// either. Invisible on the board the same way 'bot' already is, until the customer's
// own reply flips it straight back to esperando_asesor with a fresh stage_since (see
// update_customer_last_message() in db/init/031, extended by 045).
const HIDDEN_TICKET_STATUSES_SQL = `('bot', 'difusion_enviada')`;

// Called by both GET /pipeline below and (indirectly, by staying in sync with it)
// anywhere else that needs to know "which column does this row belong to" — kept in
// one place so the board and the SQL CASE that mirrors it can't drift apart silently.
const BUCKET_CASE_SQL = `
  CASE
    WHEN ticket_status = 'resuelto' THEN 'resuelto'
    WHEN ticket_status = 'esperando_asesor' THEN 'pendiente'
    WHEN temperature = 'pqrs' THEN 'pqrs'
    WHEN temperature = 'despacho' THEN 'despacho'
    WHEN temperature = 'pagado' THEN 'pagado'
    WHEN temperature = 'caliente' THEN 'medio_pago'
    WHEN temperature = 'tibio' THEN 'cotizacion'
    ELSE 'en_atencion'
  END
`;

// WhatsApp closes the free-form window 24h after the customer's own last message — past
// that, only a template reaches them, so there's nothing left for an advisor to do here.
// Shared by both /pipeline and /pipeline/export: normally (dormant !== 'true') a stale
// contact is hidden from the advisor board entirely; dormant='true' (Marketing's board)
// shows ONLY those. Restricted (2026-09-12 request) to just en_atencion/cotizacion/
// medio_pago — "No atendidos" is already the highest-priority signal and shouldn't be
// hidden away, and "Pagado"/"PQRS"/"Por despacho" sitting quiet doesn't mean "cold lead"
// the way it does mid-conversation. Every other bucket ALWAYS stays on the advisor board
// and NEVER appears on Marketing's, regardless of how long it's been quiet. Re-embeds
// BUCKET_CASE_SQL directly (reading temped's own ticket_status/temperature columns)
// rather than the `bucket` alias it computes — a CTE can't reference its own SELECT-list
// aliases in its own WHERE clause, so the raw expression has to be repeated here at the
// same level. Same 24h condition audit.js's /unanswered already uses
// (c.last_customer_message_at <= now() - interval '24 hours').
const DORMANT_ELIGIBLE_BUCKET_SQL = `(${BUCKET_CASE_SQL}) IN ('en_atencion', 'cotizacion', 'medio_pago')`;
function dormancyClauseSql(dormant) {
  return dormant === 'true'
    ? ` AND ${DORMANT_ELIGIBLE_BUCKET_SQL} AND last_customer_message_at IS NOT NULL AND last_customer_message_at < now() - interval '24 hours'`
    : ` AND (NOT (${DORMANT_ELIGIBLE_BUCKET_SQL}) OR last_customer_message_at IS NULL OR last_customer_message_at >= now() - interval '24 hours')`;
}

// One column at a time, paged — "traer todo" (2026-08-31: 2733 in "en_atencion" alone)
// still can't mean one query that returns thousands of rows. Instead every column loads
// its first page up front and pulls the next one as the advisor scrolls that column,
// same PAGE_SIZE-at-a-time pattern already used for the conversation list — nothing is
// ever hidden, it just arrives incrementally instead of all at once.
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// Coalesces identical concurrent requests (same reasoning as conversations.js/
// dashboard.js) — several advisors opening the board within the same few seconds share
// one query per column instead of each firing their own.
const READ_CACHE_TTL_MS = 3000;
const pipelineCache = new Map();
function cachedRead(key, run) {
  const hit = pipelineCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = run().catch((err) => { pipelineCache.delete(key); throw err; });
  pipelineCache.set(key, { expires: Date.now() + READ_CACHE_TTL_MS, promise });
  return promise;
}

// "No atendidos" sorts/displays by stage_since (ticket wait time — that's what its SLA
// is actually about). Every other column sorts/displays by last_customer_message_at
// instead, falling back to stage_since only for the rare contact with a temperature set
// but no message history at all. Sorting and displaying by two DIFFERENT timestamps was
// exactly the bug reported 2026-08-31 — the board's order (by stage_since) and the
// "hace X" next to each message (by a separately-fetched last-message time) didn't
// correspond to each other at all. Both now come from customers.last_customer_message_at
// — kept current by a trigger on n8n_chat_histories (db/init/031) instead of a
// per-request LATERAL lookup, so this stays a plain indexed sort no matter how deep a
// column gets paged.
function orderExprFor(bucket) {
  return bucket === 'pendiente' ? 'stage_since' : 'COALESCE(last_customer_message_at, stage_since)';
}

// Shared by the paged board view and the unpaginated export below — same period/search/
// unread filters, same -06 Guatemala convention as the "Sin responder" report (this
// business never observes DST, so a plain offset is always correct). Returns the WHERE
// fragments and params ($2 onward — $1 is always the bucket) to splice into `totaled`.
function buildPipelineFilters(bucket, query, paramsSoFar) {
  const orderExpr = orderExprFor(bucket);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const { from, to, since, until, q, unreadOnly } = query;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    throw Object.assign(new Error('from/to must be YYYY-MM-DD'), { status: 400 });
  }
  if (since && !Number.isFinite(Date.parse(since))) {
    throw Object.assign(new Error('since must be a valid timestamp'), { status: 400 });
  }
  if (until && !Number.isFinite(Date.parse(until))) {
    throw Object.assign(new Error('until must be a valid timestamp'), { status: 400 });
  }
  const trimmedQ = (q ?? '').trim();
  const params = paramsSoFar;
  let dateClause = '';
  // Tracked separately from the params pushed into dateClause above (those are keyed to
  // orderExpr, not to customer.created_at) — used only for the new-vs-continuing
  // breakdown below. Left null for a search or the unbounded "Todo" period: with no
  // period boundary, "arrived new within this window" has no meaning to compute.
  let periodStartIso = null;
  let periodEndIso = null;
  if (trimmedQ) {
    // A search match has to show up no matter what period is selected — a customer
    // who wrote a week ago is still a real result, not something Hoy/Ayer should be
    // able to hide. Name/phone only (temped never carries message text to search).
    params.push(`%${trimmedQ}%`);
    dateClause += ` AND (full_name ILIKE $${params.length} OR whatsapp_number ILIKE $${params.length})`;
  } else if (since) {
    // "Hoy"/"Ayer" filter on the exact moment staff last wrote before that day started
    // (see /last-advisor-activity below), not calendar midnight — a precise timestamp,
    // so since/until take over from from/to instead of combining with them.
    periodStartIso = new Date(since).toISOString();
    params.push(periodStartIso);
    dateClause += ` AND ${orderExpr} >= $${params.length}`;
  } else if (from) {
    periodStartIso = `${from}T00:00:00-06:00`;
    params.push(periodStartIso);
    dateClause += ` AND ${orderExpr} >= $${params.length}`;
  }
  if (!trimmedQ) {
    if (until) {
      periodEndIso = new Date(until).toISOString();
      params.push(periodEndIso);
      dateClause += ` AND ${orderExpr} < $${params.length}`;
    } else if (to) {
      const toTs = new Date(`${to}T00:00:00-06:00`);
      toTs.setUTCDate(toTs.getUTCDate() + 1); // exclusive end — the whole "to" day counts
      periodEndIso = toTs.toISOString();
      params.push(periodEndIso);
      dateClause += ` AND ${orderExpr} < $${params.length}`;
    }
  }
  // Independent of the period/search filters above (stacks with either) — "solo no
  // leídos" narrows whatever's already selected instead of replacing it. EXISTS short-
  // circuits on the first unread row and reuses the same session_id prefix index the
  // per-page unread_count below already relies on, so this stays reasonably cheap
  // even applied across a whole bucket (thousands of rows) before pagination, unlike
  // a full unread COUNT per row would be.
  const unreadOnlyClause = unreadOnly === 'true'
    ? ` AND EXISTS (
          SELECT 1 FROM n8n_chat_histories h
          WHERE h.session_id LIKE whatsapp_number || '%'
            AND h.message->>'type' = 'human'
            AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = whatsapp_number), 0)
        )`
    : '';
  return { orderExpr, dateClause, unreadOnlyClause, trimmedQ, periodStartIso, periodEndIso };
}

router.get('/pipeline', async (req, res, next) => {
  try {
    const bucket = req.query.bucket;
    if (!PIPELINE_COLUMNS.includes(bucket)) return res.status(400).json({ error: 'invalid bucket' });
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const sort = req.query.sort === 'asc' ? 'ASC' : 'DESC';

    const params = [bucket];
    const { orderExpr, dateClause, unreadOnlyClause, trimmedQ, periodStartIso, periodEndIso } = buildPipelineFilters(bucket, req.query, params);
    const { from, to, since, until, unreadOnly, dormant } = req.query;
    const dormancyClause = dormancyClauseSql(dormant);

    // "Nuevas" vs "continuas" — only computable when there's an actual period boundary
    // to compare customer.created_at against (not for "Todo" or a search, neither of
    // which have a meaningful start). New params, not reused from dateClause's above:
    // those are keyed to orderExpr (stage_since/last_message), this is keyed to when
    // the CUSTOMER first ever showed up, a different column entirely.
    let newTotalSql = 'NULL::bigint';
    if (periodStartIso) {
      params.push(periodStartIso);
      const startParam = params.length;
      let cond = `customer_created_at >= $${startParam}`;
      if (periodEndIso) {
        params.push(periodEndIso);
        cond += ` AND customer_created_at < $${params.length}`;
      }
      newTotalSql = `count(*) FILTER (WHERE ${cond}) OVER (PARTITION BY ${BUCKET_CASE_SQL})`;
    }

    // Fixed to today's Guatemala calendar day regardless of whatever period the columns
    // themselves are filtered to (unlike bucket_new_total above) — "cuánta gente entró
    // hoy" as a standing number, same day-boundary convention dashboard.js already uses
    // (AT TIME ZONE 'America/Guatemala', not a manual -06 offset, since this one needs
    // to track "today" as it rolls over, not a fixed caller-supplied instant).
    const newTodaySql = `count(*) FILTER (WHERE (customer_created_at AT TIME ZONE 'America/Guatemala') >= date_trunc('day', now() AT TIME ZONE 'America/Guatemala')) OVER (PARTITION BY ${BUCKET_CASE_SQL})`;

    // db/init/051: replaced the correlated EXISTS-per-row version (2026-09-11 outage —
    // that ran across every row in the date-filtered set, unconditionally, on every
    // single /pipeline call) with a plain read of customers.has_unread, a column now
    // kept current by triggers instead of computed per request. Same window-partitioned
    // shape as bucket_total/bucket_new_total, just cheap now.
    const unreadTotalSql = `count(*) FILTER (WHERE customer_has_unread) OVER (PARTITION BY ${BUCKET_CASE_SQL})`;

    const offsetParam = params.length + 1;
    params.push(offset);
    const limitParam = params.length + 1;
    params.push(limit);

    const { rows } = await cachedRead(`${bucket}:${offset}:${limit}:${sort}:${from ?? ''}:${to ?? ''}:${since ?? ''}:${until ?? ''}:${trimmedQ}:${unreadOnly ?? ''}:${dormant ?? ''}`, () => pool.query(`
      WITH temped AS (
        SELECT t.id AS ticket_id, t.status AS ticket_status, t.assigned_advisor,
               c.id AS customer_id, c.full_name, c.whatsapp_number, c.created_at AS customer_created_at,
               c.has_unread AS customer_has_unread,
               ${EFFECTIVE_STATUS_SQL} AS temperature,
               GREATEST(t.updated_at, c.updated_at) AS stage_since,
               c.last_customer_message_at, c.last_customer_message, c.awaiting_reply,
               c.last_message_at, c.last_message
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        WHERE t.status NOT IN ${HIDDEN_TICKET_STATUSES_SQL}
      ),
      -- bucket_total and friends counted here, over the whole (small — tickets/
      -- customers, not messages) date-filtered set, before narrowing to just this one
      -- column — same reasoning for all four, just different partitioned counts.
      -- dormancyClause references temped's OWN output columns (temperature,
      -- last_customer_message_at), so it has to live here rather than in temped's own
      -- WHERE — a CTE can't reference its own SELECT-list aliases in its WHERE clause.
      totaled AS (
        SELECT *, ${BUCKET_CASE_SQL} AS bucket,
               count(*) OVER (PARTITION BY ${BUCKET_CASE_SQL}) AS bucket_total,
               ${newTotalSql} AS bucket_new_total,
               ${newTodaySql} AS bucket_new_today_total,
               ${unreadTotalSql} AS bucket_unread_total
        FROM temped
        WHERE true ${dateClause} ${unreadOnlyClause} ${dormancyClause}
      ),
      paged AS (
        SELECT * FROM totaled WHERE bucket = $1
        ORDER BY ${orderExpr} ${sort}
        OFFSET $${offsetParam} LIMIT $${limitParam}
      )
      -- unread_count only computed for this one page (up to 200 rows), same reasoning
      -- as MAX_PAGE_SIZE above and audit.js's message_count — a per-row subquery over
      -- n8n_chat_histories is fine bounded to a page, not fine over a whole 2733-row
      -- bucket, which is why it's kept out of temped/totaled entirely.
      SELECT paged.*,
             (SELECT count(*) FROM n8n_chat_histories h
              WHERE h.session_id LIKE paged.whatsapp_number || '%'
                AND h.message->>'type' = 'human'
                AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = paged.whatsapp_number), 0)
             ) AS unread_count
      FROM paged
      ORDER BY ${orderExpr} ${sort}
    `, params));

    const bucketTotal = rows[0] ? Number(rows[0].bucket_total) : 0;
    const bucketNewTotal = rows[0] && rows[0].bucket_new_total != null ? Number(rows[0].bucket_new_total) : null;
    res.json({
      total: bucketTotal,
      // null when there's no period boundary to compare against (Todo, or a search) —
      // the frontend hides the breakdown rather than showing a meaningless split.
      newTotal: bucketNewTotal,
      continuingTotal: bucketNewTotal != null ? bucketTotal - bucketNewTotal : null,
      // Fixed to today regardless of period, and unread — independent of both filters
      // above, always meaningful, so no null-when-unavailable case for either.
      newTodayTotal: rows[0] ? Number(rows[0].bucket_new_today_total) : 0,
      unreadTotal: rows[0] ? Number(rows[0].bucket_unread_total) : 0,
      cards: rows.map((r) => ({
        ticketId: r.ticket_id,
        customerId: r.customer_id,
        fullName: r.full_name,
        whatsappNumber: r.whatsapp_number,
        temperature: r.temperature,
        ticketStatus: r.ticket_status,
        assignedAdvisor: r.assigned_advisor,
        lastMessage: r.last_customer_message,
        awaitingReply: r.awaiting_reply === true,
        unreadCount: Number(r.unread_count),
        stageSince: r.stage_since,
        lastMessageAt: r.last_customer_message_at,
        // Whichever side wrote last, for the card preview — lastMessage/lastMessageAt
        // above stay customer-only (the overdue/SLA calc needs specifically that), so
        // this is separate rather than repointing them. awaitingReply already says
        // whose it is: true means this preview IS the customer's message (same event
        // as lastMessage above); false means it's our own most recent reply.
        previewMessage: r.last_message,
        previewMessageAt: r.last_message_at,
      })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Whole-bucket, unpaginated — "download everyone in this column" instead of the paged
// board view above (same filters: period, search, unreadOnly). No unread_count (that
// per-row subquery is only cheap bounded to one page, see the comment above) and a hard
// cap so a runaway bucket can't try to hand back an unbounded Excel file.
const EXPORT_ROW_CAP = 10000;
router.get('/pipeline/export', async (req, res, next) => {
  try {
    const bucket = req.query.bucket;
    if (!PIPELINE_COLUMNS.includes(bucket)) return res.status(400).json({ error: 'invalid bucket' });

    const params = [bucket];
    const { orderExpr, dateClause, unreadOnlyClause } = buildPipelineFilters(bucket, req.query, params);
    const dormancyClause = dormancyClauseSql(req.query.dormant);

    const { rows } = await pool.query(`
      WITH temped AS (
        SELECT t.status AS ticket_status, ${EFFECTIVE_STATUS_SQL} AS temperature,
               c.full_name, c.whatsapp_number,
               GREATEST(t.updated_at, c.updated_at) AS stage_since,
               c.last_customer_message_at, c.last_customer_message
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        WHERE t.status NOT IN ${HIDDEN_TICKET_STATUSES_SQL}
      ),
      totaled AS (
        SELECT *, ${BUCKET_CASE_SQL} AS bucket
        FROM temped
        WHERE true ${dateClause} ${unreadOnlyClause} ${dormancyClause}
      )
      SELECT full_name, whatsapp_number, stage_since, last_customer_message_at, last_customer_message
      FROM totaled WHERE bucket = $1
      ORDER BY ${orderExpr} ASC
      LIMIT ${EXPORT_ROW_CAP}
    `, params);

    res.json(rows.map((r) => ({
      fullName: r.full_name,
      whatsappNumber: r.whatsapp_number,
      stageSince: r.stage_since,
      lastMessageAt: r.last_customer_message_at,
      lastMessage: r.last_customer_message,
    })));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// The boundary the Pipeline's "Hoy"/"Ayer" filters actually use: not calendar midnight,
// but the last moment any advisor/supervisor/admin sent a message before that day
// started (Studio F runs shifts that end and resume overnight — a lead that comes in
// at 11pm is "today's" backlog even though it's still yesterday by the wall clock).
// `before` (optional) narrows to messages sent strictly before that timestamp, so the
// frontend can ask for "the cutoff before today started" and "before yesterday started"
// as two calls to the same endpoint — omit it for "the most recent ever". Backed by a
// partial index (db/init/041) so this stays a single backward index-scan no matter how
// large n8n_chat_histories grows, instead of a full scan over every advisor message ever sent.
router.get('/last-advisor-activity', async (req, res, next) => {
  try {
    const { before } = req.query;
    if (before && !Number.isFinite(Date.parse(before))) {
      return res.status(400).json({ error: 'before must be a valid timestamp' });
    }
    const { rows } = await pool.query(
      `SELECT MAX(created_at) AS ts FROM n8n_chat_histories
       WHERE message->>'type' = 'ai' AND message->'additional_kwargs'->>'sentBy' = 'advisor'
         ${before ? 'AND created_at < $1::timestamptz' : ''}`,
      before ? [new Date(before).toISOString()] : []
    );
    res.json({ timestamp: rows[0]?.ts ?? null });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [];
    let statusClause = '';
    if (status) {
      if (!isValidStatus(status)) return res.status(400).json({ error: 'invalid status' });
      params.push(status);
      statusClause = `AND t.status = $${params.length}`;
    }
    const zClause = zoneClause(req.user, params);

    const { rows } = await pool.query(
      `SELECT t.id, t.status, t.handoff_reason, t.assigned_advisor, t.created_at, t.updated_at,
              c.id AS customer_id, c.full_name, c.whatsapp_number, c.department
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       WHERE true ${statusClause} ${zClause}
       ORDER BY t.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.status, t.handoff_reason, t.assigned_advisor, t.created_at, t.updated_at,
              c.id AS customer_id, c.full_name, c.whatsapp_number, c.department, c.municipio, c.preferred_line,
              c.preferred_size, c.purchase_frequency, c.purchase_status, c.zone
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const ticket = rows[0];

    logAccess(req.user, ticket.customer_id, 'view_ticket');

    const orders = await pool.query(
      `SELECT ticket_code, status, total, payment_method, shipping_address, created_at
       FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
      [ticket.customer_id]
    );
    ticket.orders = orders.rows;
    res.json(ticket);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await pool.query(`SELECT id, status, customer_id FROM tickets WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
    const before = existing.rows[0];

    const { status, assigned_advisor } = req.body ?? {};
    if (status && !isValidStatus(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const { rows } = await pool.query(
      `UPDATE tickets SET
         status = COALESCE($1, status),
         assigned_advisor = COALESCE($2, assigned_advisor),
         first_response_at = CASE WHEN $1 = 'en_atencion' AND first_response_at IS NULL THEN now() ELSE first_response_at END,
         resolved_at = CASE WHEN $1 = 'resuelto' THEN now() ELSE resolved_at END,
         updated_at = now()
       WHERE id = $3
       RETURNING id, status, assigned_advisor, updated_at, first_response_at, resolved_at`,
      [status ?? null, assigned_advisor ?? null, req.params.id]
    );
    if (status && status !== before.status) {
      logBusinessAction(req.user, before.customer_id, 'ticket_status_changed', `${TICKET_STATUS_LABELS[before.status] ?? before.status} → ${TICKET_STATUS_LABELS[status] ?? status}`);
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
