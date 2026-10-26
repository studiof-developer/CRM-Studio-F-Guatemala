import { Router } from 'express';
import { pool } from '../db.js';
import { isValidStatus } from '../ticketStatus.js';
import { logAccess, logBusinessAction } from '../auditLog.js';
import { requireRole } from '../auth.js';
import { getSetting } from './settings.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';
import { fetchAdSpend } from '../metaAds.js';
import { fetchMessageCost } from '../whatsappPricing.js';

const router = Router();

const TICKET_STATUS_LABELS = { esperando_asesor: 'Pendiente', en_atencion: 'En atención', resuelto: 'Resuelto' };

// The advisor team handles every zone for Studio F Guatemala (not zone-assigned
// individually), so this is a no-op — kept as a hook in case that ever changes.
function linesClause(user, tableAlias = 't') {
  if (user.role !== 'asesor') return '';
  return ` AND (
    ${tableAlias}.whatsapp_number_id IN (SELECT whatsapp_number_id FROM user_whatsapp_numbers WHERE user_id = ${Number(user.id)})
    OR (${tableAlias}.whatsapp_number_id IS NULL AND 1 IN (SELECT whatsapp_number_id FROM user_whatsapp_numbers WHERE user_id = ${Number(user.id)}))
  )`;
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
export const PIPELINE_COLUMNS = ['pendiente', 'en_atencion', 'cotizacion', 'medio_pago', 'pagado', 'despacho', 'pqrs'];

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
//
// last_customer_message_at is NULL for a contact who never wrote back at all — only
// ever received an outbound bot/advisor message (e.g. a Meta-ad lead that got the
// welcome template and went silent) — and NULL was being treated as "nothing to judge
// staleness against, leave it alone", which pinned these ancient, obviously-cold
// contacts on the advisor board forever (2026-09-12 report: months-old threads still
// showing in "En conversación"). There's no customer-opened WhatsApp window to measure
// in that case, but functionally it's the same "needs a template, not a normal reply"
// situation, so it falls back to last_message_at — whichever side wrote last (db/init/
// 046), always set once ANY message exists — to judge staleness instead of exempting it.
const TICKET_LAST_MSG_AT_SQL = `CASE WHEN COALESCE(t.whatsapp_number_id, 1) = 1 THEN COALESCE(t.last_message_at, c.last_message_at) ELSE t.last_message_at END`;
const TICKET_LAST_MSG_SQL = `CASE WHEN COALESCE(t.whatsapp_number_id, 1) = 1 THEN COALESCE(t.last_message, c.last_message) ELSE t.last_message END`;
const TICKET_LAST_CUST_MSG_AT_SQL = `CASE WHEN COALESCE(t.whatsapp_number_id, 1) = 1 THEN COALESCE(t.last_customer_message_at, c.last_customer_message_at) ELSE t.last_customer_message_at END`;
const TICKET_LAST_CUST_MSG_SQL = `CASE WHEN COALESCE(t.whatsapp_number_id, 1) = 1 THEN COALESCE(t.last_customer_message, c.last_customer_message) ELSE t.last_customer_message END`;
// Instagram/Messenger: el webhook social solo enciende customers.has_unread (el ticket queda en false, no en NULL), así que ahí manda el cliente.
const TICKET_HAS_UNREAD_SQL = `CASE WHEN c.channel <> 'whatsapp' THEN COALESCE(c.has_unread, false) WHEN COALESCE(t.whatsapp_number_id, 1) = 1 THEN COALESCE(t.has_unread, c.has_unread, false) ELSE COALESCE(t.has_unread, false) END`;
const TICKET_AWAITING_REPLY_SQL = `CASE WHEN COALESCE(t.whatsapp_number_id, 1) = 1 THEN COALESCE(t.awaiting_reply, c.awaiting_reply, false) ELSE COALESCE(t.awaiting_reply, false) END`;
const EXCLUDE_PHANTOM_LINE_TICKET_SQL = `AND (COALESCE(t.whatsapp_number_id, 1) = 1 OR t.last_message_at IS NOT NULL OR t.last_customer_message_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM tickets t1 WHERE t1.customer_id = t.customer_id AND COALESCE(t1.whatsapp_number_id, 1) = 1 AND t1.status NOT IN ${HIDDEN_TICKET_STATUSES_SQL}))`;

const DORMANT_ELIGIBLE_BUCKET_SQL = `(${BUCKET_CASE_SQL}) IN ('en_atencion', 'cotizacion', 'medio_pago')`;
const DORMANCY_TIMESTAMP_SQL = `COALESCE(last_customer_message_at, last_message_at)`;
function dormancyClauseSql(dormant) {
  return dormant === 'true'
    ? ` AND ${DORMANT_ELIGIBLE_BUCKET_SQL} AND ${DORMANCY_TIMESTAMP_SQL} IS NOT NULL AND ${DORMANCY_TIMESTAMP_SQL} < now() - interval '24 hours'`
    : ` AND (NOT (${DORMANT_ELIGIBLE_BUCKET_SQL}) OR ${DORMANCY_TIMESTAMP_SQL} IS NULL OR ${DORMANCY_TIMESTAMP_SQL} >= now() - interval '24 hours')`;
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
    // able to hide. Name/phone always matches; a 3+ char query also matches message
    // content (2026-09-16 request: find every conversation that mentioned a product
    // reference like "S342232", not just name/phone). Each EXISTS only scans that ONE
    // customer's own messages (session_id/contact_id already narrows it), and — unlike
    // the board's own unfiltered load — this only ever runs when an admin deliberately
    // searches, never on a plain poll, so it doesn't carry the same risk as the
    // per-row subqueries that caused earlier outages here.
    params.push(`%${trimmedQ}%`);
    const nameOrPhone = `full_name ILIKE $${params.length} OR whatsapp_number ILIKE $${params.length}`;
    let messageMatch = '';
    if (trimmedQ.length >= 3) {
      messageMatch = `
        OR EXISTS (
          SELECT 1 FROM n8n_chat_histories h
          WHERE h.session_id LIKE whatsapp_number || '%' AND h.message->>'content' ILIKE $${params.length}
        )
        OR EXISTS (
          SELECT 1 FROM social_messages sm
          JOIN social_contacts sc ON sc.id = sm.contact_id
          WHERE sc.customer_id = customer_id AND sm.body ILIKE $${params.length}
        )
      `;
    }
    dateClause += ` AND (${nameOrPhone} ${messageMatch})`;
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
    ? ' AND customer_has_unread = true'
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
    const { from, to, since, until, unreadOnly, dormant, lineId } = req.query;
    const dormancyClause = dormancyClauseSql(dormant);

    const parsedLineId = lineId ? parseInt(lineId, 10) : null;
    let lineFilterSql = '';
    if (parsedLineId) {
      params.push(parsedLineId);
      lineFilterSql = ` AND COALESCE(t.whatsapp_number_id, 1) = $${params.length}`;
    }

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

    const lClause = linesClause(req.user, 't');
    const cacheKey = `${req.user.id}:${bucket}:${offset}:${limit}:${sort}:${from ?? ''}:${to ?? ''}:${since ?? ''}:${until ?? ''}:${trimmedQ}:${unreadOnly ?? ''}:${dormant ?? ''}:${parsedLineId ?? ''}`;

    const { rows } = await cachedRead(cacheKey, () => pool.query(`
      WITH temped AS (
        SELECT t.id AS ticket_id, t.status AS ticket_status, t.assigned_advisor, t.whatsapp_number_id,
               c.id AS customer_id, c.full_name, c.whatsapp_number, c.created_at AS customer_created_at,
               CASE
                 WHEN t.status IN ('esperando_asesor', 'resuelto') THEN false
                 WHEN (${TICKET_LAST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                 WHEN (${TICKET_LAST_MSG_AT_SQL}) > (${TICKET_LAST_CUST_MSG_AT_SQL}) THEN false
                 WHEN (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                 ELSE ${TICKET_HAS_UNREAD_SQL}
               END AS customer_has_unread, c.channel,
               ${EFFECTIVE_STATUS_SQL} AS temperature,
               t.updated_at AS stage_since,
               ${TICKET_LAST_CUST_MSG_AT_SQL} AS last_customer_message_at,
               ${TICKET_LAST_CUST_MSG_SQL} AS last_customer_message,
               CASE
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) > (${TICKET_LAST_CUST_MSG_AT_SQL}) THEN false
                  WHEN (${TICKET_LAST_CUST_MSG_AT_SQL}) >= (${TICKET_LAST_MSG_AT_SQL}) THEN true
                  WHEN (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_MSG_AT_SQL}) IS NULL THEN true
                  ELSE ${TICKET_AWAITING_REPLY_SQL}
                END AS awaiting_reply,
                ${TICKET_LAST_MSG_AT_SQL} AS last_message_at,
                ${TICKET_LAST_MSG_SQL} AS last_message,
                CASE
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN true
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) > (${TICKET_LAST_CUST_MSG_AT_SQL}) THEN true
                  ELSE false
                END AS last_message_by_advisor,
               brnd.name AS brand_name, br.name AS branch_name, wn.label AS line_label, comp.name AS company_name,
               ROW_NUMBER() OVER (PARTITION BY t.customer_id, ${parsedLineId ? '1' : 'COALESCE(t.whatsapp_number_id, 1)'} ORDER BY t.created_at DESC, t.id DESC) AS ticket_rn
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        LEFT JOIN whatsapp_numbers wn ON t.whatsapp_number_id = wn.id
        LEFT JOIN branches br ON wn.branch_id = br.id
        LEFT JOIN brands brnd ON br.brand_id = brnd.id
        LEFT JOIN companies comp ON brnd.company_id = comp.id
        WHERE t.status NOT IN ${HIDDEN_TICKET_STATUSES_SQL} ${EXCLUDE_PHANTOM_LINE_TICKET_SQL} ${lClause} ${lineFilterSql}
      ),
      -- A duplicate open ticket for the same customer (n8n's handoff firing twice on
      -- the same inbound message, 2026-09-14 report — two identical cards, same phone,
      -- same message, same minute) is always a bug: the app's own ticket-creation code
      -- (conversations.js's /take and its campaign-recipient twin) already treats "one
      -- open ticket per customer" as an invariant and reuses whatever's open instead of
      -- inserting a second one — this is the same rule applied on the read side, for
      -- whatever slips through from outside this codebase (the n8n bot flow, which this
      -- app doesn't control). Only ever collapses NON-resuelto duplicates to the most
      -- recent one — every resuelto ticket stays, since a customer legitimately buying
      -- more than once over time is real history, not a duplicate.
      deduped AS (
        SELECT * FROM temped WHERE ticket_rn = 1
      ),
      -- bucket_total and friends counted here, over the whole (small — tickets/
      -- customers, not messages) date-filtered set, before narrowing to just this one
      -- column — same reasoning for all four, just different partitioned counts.
      -- dormancyClause references deduped's OWN output columns (temperature,
      -- last_customer_message_at), so it has to live here rather than in temped's own
      -- WHERE — a CTE can't reference its own SELECT-list aliases in its WHERE clause.
      totaled AS (
        SELECT *, ${BUCKET_CASE_SQL} AS bucket,
               count(*) OVER (PARTITION BY ${BUCKET_CASE_SQL}) AS bucket_total,
               ${newTotalSql} AS bucket_new_total,
               ${newTodaySql} AS bucket_new_today_total,
               ${unreadTotalSql} AS bucket_unread_total
        FROM deduped
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
      -- bucket, which is why it's kept out of temped/totaled entirely. A social-linked
      -- customer has no n8n_chat_histories rows at all — its real count instead comes
      -- from social_contacts.unread_count, already kept current by the webhook/mark-as-
      -- read paths (socialWebhook.js, social.js).
      SELECT paged.*,
             CASE WHEN paged.channel = 'whatsapp' THEN (
               SELECT count(*) FROM n8n_chat_histories h
               WHERE (
                 h.session_id LIKE paged.whatsapp_number || '%' AND ((paged.whatsapp_number_id = 2 AND (h.session_id LIKE '%__line_2%' OR h.whatsapp_number_id = 2)) OR ((paged.whatsapp_number_id = 1 OR paged.whatsapp_number_id IS NULL) AND (h.session_id NOT LIKE '%__line_2%' AND (h.whatsapp_number_id IS NULL OR h.whatsapp_number_id = 1))))
               )
                 AND h.message->>'type' = 'human'
                 AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = paged.whatsapp_number), 0)
             ) ELSE (
               SELECT unread_count FROM social_contacts WHERE customer_id = paged.customer_id
             ) END AS unread_count
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
        whatsappNumberId: r.whatsapp_number_id,
        channel: r.channel,
        branchName: r.branch_name,
        brandName: r.brand_name,
        companyName: r.company_name,
        temperature: r.temperature,
        ticketStatus: r.ticket_status,
        assignedAdvisor: r.assigned_advisor,
        lastMessage: r.last_customer_message,
        awaitingReply: r.awaiting_reply === true,
        lastMessageByAdvisor: r.last_message_by_advisor === true,
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
        brandName: r.brand_name,
        branchName: r.branch_name,
        lineLabel: r.line_label,
      })),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// One customer's current card, wherever (if anywhere) it belongs — what the board's
// live-update listeners fetch instead of reloading all 8 columns from scratch on every
// ticket/message/read event system-wide (2026-09-14 request: "no hace falta recargar
// toda la lista, solo posicionarlo" — a full reload was also what kept snapping an
// advisor's scroll position back to page 1 mid-browse). Accepts whichever identifier the
// triggering event actually carried (see db/init/003, 020, 037's pg_notify payloads):
// customerId directly, a ticketId (the tickets-table trigger only has that), a phone
// (read_changes), or a session_id (message_changes, phone before the "__").
// bucket:null means "doesn't belong on the board right now" (hidden status, dormant,
// outside the active search/period/unreadOnly filter) — the frontend removes whatever
// card it had for this customer instead of adding/updating one.
router.get('/pipeline/card', async (req, res, next) => {
  try {
    const { customerId: customerIdParam, ticketId, sessionId, phone } = req.query;
    let customerId = customerIdParam ? Number(customerIdParam) : null;
    if (!customerId && ticketId) {
      const { rows } = await pool.query(`SELECT customer_id FROM tickets WHERE id = $1`, [ticketId]);
      customerId = rows[0]?.customer_id ?? null;
    }
    if (!customerId && (phone || sessionId)) {
      const rawPhone = phone ?? String(sessionId).split('__')[0];
      const { rows } = await pool.query(`SELECT id FROM customers WHERE whatsapp_number = $1`, [rawPhone]);
      customerId = rows[0]?.id ?? null;
    }
    if (!customerId) return res.json({ customerId: null, bucket: null, card: null });

    const params = [customerId];
    // 'en_atencion' is a throwaway bucket arg — only dateClause/unreadOnlyClause get
    // used below, orderExpr doesn't apply to a single-row lookup.
    const { dateClause, unreadOnlyClause } = buildPipelineFilters('en_atencion', req.query, params);
    const dormancyClause = dormancyClauseSql(req.query.dormant);

    const parsedLineId = req.query.lineId ? parseInt(req.query.lineId, 10) : null;
    let lineFilterSql = '';
    if (parsedLineId) {
      params.push(parsedLineId);
      lineFilterSql = ` AND COALESCE(t.whatsapp_number_id, 1) = $${params.length}`;
    }

    const { rows } = await pool.query(`
      WITH temped AS (
        SELECT t.id AS ticket_id, t.status AS ticket_status, t.assigned_advisor, t.whatsapp_number_id,
               c.id AS customer_id, c.full_name, c.whatsapp_number, c.created_at AS customer_created_at,
               CASE
                 WHEN t.status IN ('esperando_asesor', 'resuelto') THEN false
                 WHEN (${TICKET_LAST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                 WHEN (${TICKET_LAST_MSG_AT_SQL}) > (${TICKET_LAST_CUST_MSG_AT_SQL}) THEN false
                 WHEN (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                 ELSE ${TICKET_HAS_UNREAD_SQL}
               END AS customer_has_unread, c.channel,
               ${EFFECTIVE_STATUS_SQL} AS temperature,
               t.updated_at AS stage_since,
               ${TICKET_LAST_CUST_MSG_AT_SQL} AS last_customer_message_at,
               ${TICKET_LAST_CUST_MSG_SQL} AS last_customer_message,
               CASE
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) > (${TICKET_LAST_CUST_MSG_AT_SQL}) THEN false
                  WHEN (${TICKET_LAST_CUST_MSG_AT_SQL}) >= (${TICKET_LAST_MSG_AT_SQL}) THEN true
                  WHEN (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_MSG_AT_SQL}) IS NULL THEN true
                  ELSE ${TICKET_AWAITING_REPLY_SQL}
                END AS awaiting_reply,
                ${TICKET_LAST_MSG_AT_SQL} AS last_message_at,
                ${TICKET_LAST_MSG_SQL} AS last_message,
                CASE
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN true
                  WHEN (${TICKET_LAST_MSG_AT_SQL}) > (${TICKET_LAST_CUST_MSG_AT_SQL}) THEN true
                  ELSE false
                END AS last_message_by_advisor,
               brnd.name AS brand_name, br.name AS branch_name, wn.label AS line_label, comp.name AS company_name,
               ROW_NUMBER() OVER (PARTITION BY t.customer_id, ${parsedLineId ? '1' : 'COALESCE(t.whatsapp_number_id, 1)'} ORDER BY t.created_at DESC, t.id DESC) AS ticket_rn
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        LEFT JOIN whatsapp_numbers wn ON t.whatsapp_number_id = wn.id
        LEFT JOIN branches br ON wn.branch_id = br.id
        LEFT JOIN brands brnd ON br.brand_id = brnd.id
        LEFT JOIN companies comp ON brnd.company_id = comp.id
        WHERE t.status NOT IN ${HIDDEN_TICKET_STATUSES_SQL} ${EXCLUDE_PHANTOM_LINE_TICKET_SQL} AND c.id = $1 ${linesClause(req.user, 't')} ${lineFilterSql}
      ),
      deduped AS (SELECT * FROM temped WHERE ticket_rn = 1)
      SELECT *, ${BUCKET_CASE_SQL} AS bucket
      FROM deduped
      WHERE true ${dateClause} ${unreadOnlyClause} ${dormancyClause}
      ORDER BY ticket_id DESC
      LIMIT 1
    `, params);

    if (!rows.length) return res.json({ customerId, bucket: null, card: null });
    const r = rows[0];
    const unreadCount = r.channel === 'whatsapp'
      ? Number((await pool.query(
          `SELECT count(*) FROM n8n_chat_histories h
           WHERE h.session_id LIKE $1 || '%' AND h.message->>'type' = 'human'
              AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = $1), 0)`,
          [r.whatsapp_number]
        )).rows[0].count)
      : Number((await pool.query(`SELECT unread_count FROM social_contacts WHERE customer_id = $1`, [r.customer_id])).rows[0]?.unread_count ?? 0);

    res.json({
      customerId,
      bucket: r.bucket,
      card: {
        ticketId: r.ticket_id,
        customerId: r.customer_id,
        fullName: r.full_name,
        whatsappNumber: r.whatsapp_number,
        whatsappNumberId: r.whatsapp_number_id,
        channel: r.channel,
        branchName: r.branch_name,
        brandName: r.brand_name,
        temperature: r.temperature,
        ticketStatus: r.ticket_status,
        assignedAdvisor: r.assigned_advisor,
        lastMessage: r.last_customer_message,
        awaitingReply: r.awaiting_reply === true,
        lastMessageByAdvisor: r.last_message_by_advisor === true,
        unreadCount,
        stageSince: r.stage_since,
        lastMessageAt: r.last_customer_message_at,
        previewMessage: r.last_message,
        previewMessageAt: r.last_message_at,
        brandName: r.brand_name,
        branchName: r.branch_name,
        lineLabel: r.line_label,
        companyName: r.company_name,
      },
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

// "Descargar Conversaciones" (2026-09-16) is explicitly an archive search — "todos los
// chats desde todo el tiempo" — not a view of what's currently actionable on the board.
// A reference could easily have been mentioned in a ticket that's since been resolved,
// gone dormant (>24h, moved off the advisor board per dormancyClauseSql), or never left
// the bot (HIDDEN_TICKET_STATUSES_SQL). None of those apply here: this scans every
// customer directly, not tickets, so nothing about ticket lifecycle state can hide a
// real match.
// dateClause (from buildDateRangeClause against 'h.created_at', or '' for no period —
// 2026-09-16: Mauricio needed to scope a reference search to just the current month
// instead of always "todo el tiempo") only narrows the MESSAGE-content match — a plain
// name/phone match has no message event to date-scope against, so it stays period-
// agnostic, same as it's always been.
function buildAllTimeSearchClause(trimmedQ, params, dateClause = '') {
  params.push(`%${trimmedQ}%`);
  const nameOrPhone = `c.full_name ILIKE $${params.length} OR c.whatsapp_number ILIKE $${params.length}`;
  let messageMatch = '';
  if (trimmedQ.length >= 3) {
    messageMatch = `
      OR EXISTS (
        SELECT 1 FROM n8n_chat_histories h
        WHERE h.session_id LIKE c.whatsapp_number || '%' AND h.message->>'content' ILIKE $${params.length} ${dateClause}
      )
      OR EXISTS (
        SELECT 1 FROM social_messages sm
        JOIN social_contacts sc ON sc.id = sm.contact_id
        WHERE sc.customer_id = c.id AND sm.body ILIKE $${params.length}
      )
    `;
  }
  return `${nameOrPhone} ${messageMatch}`;
}

// Broadens a text search into "everyone who came from the SAME ad" (2026-09-16 finding):
// comparing a literal text search against Meta's own ad-conversation count for a product
// reference showed the CRM wasn't missing data — most customers who click a Click-to-
// WhatsApp ad never retype the product reference in the chat at all, so a pure text
// search structurally undercounts against what Meta reports for that ad. Meta stamps a
// `referral.source_id` (the ad's id) on a customer's first message when they arrive via
// an ad — this finds which ONE ad the text-matched customers most commonly came from
// (LIMIT 1, ordered by frequency), then includes every customer who came from THAT ad.
// Deliberately not every ad any text-matched customer ever touched: a repeat customer
// who later clicked an unrelated generic "50% OFF" ad would otherwise drag in everyone
// who ever clicked THAT ad too — confirmed live (2026-09-16): using every associated ad
// instead of just the dominant one inflated 347 real matches to 2027 bogus ones.
// dateQuery (req.query's from/to/since/until, or {} for no period) optionally scopes
// both which messages count as a text match and which ad-referral messages count toward
// finding/broadening by the dominant ad — Mauricio needed "just September", not always
// every message ever. Returns a WITH-chain ending in all_matches(customer_id); splice
// it before the caller's own SELECT.
function buildArchiveSearchCte(trimmedQ, params, dateQuery = {}) {
  const dateClause = buildDateRangeClause(dateQuery, params, 'h.created_at');
  const whereClause = buildAllTimeSearchClause(trimmedQ, params, dateClause);
  return `
    WITH text_matches AS (
      SELECT c.id AS customer_id, c.whatsapp_number FROM customers c WHERE ${whereClause}
    ),
    related_ads AS (
      SELECT h.message->'additional_kwargs'->'referral'->>'source_id' AS ad_id, count(*) AS n
      FROM n8n_chat_histories h
      JOIN text_matches tm ON h.session_id LIKE tm.whatsapp_number || '%'
      WHERE h.message->'additional_kwargs'->'referral' IS NOT NULL ${dateClause}
      GROUP BY ad_id
      ORDER BY n DESC
      LIMIT 1
    ),
    ad_matches AS (
      SELECT DISTINCT c.id AS customer_id
      FROM customers c
      JOIN n8n_chat_histories h ON h.session_id LIKE c.whatsapp_number || '%'
      WHERE h.message->'additional_kwargs'->'referral'->>'source_id' IN (SELECT ad_id FROM related_ads)
        ${dateClause}
    ),
    all_matches AS (
      SELECT customer_id FROM text_matches
      UNION
      SELECT customer_id FROM ad_matches
    )
  `;
}

router.get('/pipeline/export', async (req, res, next) => {
  try {
    const bucket = req.query.bucket;
    // 'all' spans every customer's entire history instead of one board column — see
    // buildAllTimeSearchClause above. Only allowed alongside an actual search —
    // otherwise this would be an unfiltered whole-database dump.
    const allBuckets = bucket === 'all';
    if (!allBuckets && !PIPELINE_COLUMNS.includes(bucket)) return res.status(400).json({ error: 'invalid bucket' });
    const trimmedQ = (req.query.q ?? '').trim();
    if (allBuckets && !trimmedQ) {
      return res.status(400).json({ error: 'bucket=all requires a search query' });
    }
    // Admin+supervisor, unlike the pre-existing single-column export below — 2026-09-16
    // request, widened same day to include supervisor (informational/read-only, not
    // something that changes customer data).
    if (allBuckets && !['admin', 'supervisor'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });

    if (allBuckets) {
      const params = [];
      const cte = buildArchiveSearchCte(trimmedQ, params, req.query);
      const { rows } = await pool.query(`
        ${cte}
        SELECT c.full_name, c.whatsapp_number, c.channel, ${EFFECTIVE_STATUS_SQL} AS temperature,
               c.last_customer_message_at, c.last_customer_message, c.last_message_at, c.last_message
        FROM customers c
        WHERE c.id IN (SELECT customer_id FROM all_matches)
        ORDER BY COALESCE(c.last_customer_message_at, c.last_message_at, c.created_at) DESC
        LIMIT ${EXPORT_ROW_CAP}
      `, params);
      return res.json(rows.map((r) => ({
        fullName: r.full_name,
        whatsappNumber: r.whatsapp_number,
        channel: r.channel,
        temperature: r.temperature,
        bucket: null,
        lastMessageAt: r.last_customer_message_at ?? r.last_message_at,
        lastMessage: r.last_customer_message ?? r.last_message,
      })));
    }

    const params = [bucket];
    const { orderExpr, dateClause, unreadOnlyClause } = buildPipelineFilters(bucket, req.query, params);
    const dormancyClause = dormancyClauseSql(req.query.dormant);

    const parsedLineId = req.query.lineId ? parseInt(req.query.lineId, 10) : null;
    let lineFilterSql = '';
    if (parsedLineId) {
      params.push(parsedLineId);
      lineFilterSql = ` AND COALESCE(t.whatsapp_number_id, 1) = $${params.length}`;
    }

    const { rows } = await pool.query(`
      WITH temped AS (
        SELECT t.status AS ticket_status, c.id AS customer_id, c.channel,
               ${EFFECTIVE_STATUS_SQL} AS temperature,
               c.full_name, c.whatsapp_number,
               t.updated_at AS stage_since,
               ${TICKET_LAST_CUST_MSG_AT_SQL} AS last_customer_message_at,
               ${TICKET_LAST_CUST_MSG_SQL} AS last_customer_message,
               ${TICKET_LAST_MSG_AT_SQL} AS last_message_at,
               ${TICKET_LAST_MSG_SQL} AS last_message,
               brnd.name AS brand_name, br.name AS branch_name, wn.label AS line_label,
               ROW_NUMBER() OVER (PARTITION BY t.customer_id, ${parsedLineId ? '1' : 'COALESCE(t.whatsapp_number_id, 1)'} ORDER BY t.created_at DESC, t.id DESC) AS ticket_rn
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        LEFT JOIN whatsapp_numbers wn ON t.whatsapp_number_id = wn.id
        LEFT JOIN branches br ON wn.branch_id = br.id
        LEFT JOIN brands brnd ON br.brand_id = brnd.id
        WHERE t.status NOT IN ${HIDDEN_TICKET_STATUSES_SQL} ${EXCLUDE_PHANTOM_LINE_TICKET_SQL} ${linesClause(req.user, 't')} ${lineFilterSql}
      ),
      -- Same duplicate-open-ticket collapse as /pipeline above — see its comment.
      deduped AS (
        SELECT * FROM temped WHERE ticket_rn = 1
      ),
      totaled AS (
        SELECT *, ${BUCKET_CASE_SQL} AS bucket
        FROM deduped
        WHERE true ${dateClause} ${unreadOnlyClause} ${dormancyClause}
      )
      SELECT full_name, whatsapp_number, channel, temperature, bucket, stage_since,
             last_customer_message_at, last_customer_message, last_message_at, last_message
      FROM totaled WHERE bucket = $1
      ORDER BY ${orderExpr} ASC
      LIMIT ${EXPORT_ROW_CAP}
    `, params);

    res.json(rows.map((r) => ({
      fullName: r.full_name,
      whatsappNumber: r.whatsapp_number,
      channel: r.channel,
      temperature: r.temperature,
      bucket: r.bucket,
      stageSince: r.stage_since,
      // Falls back to the generic last-message columns for a contact who never wrote
      // back at all (last_customer_message_at is NULL for those) — same reasoning as
      // DORMANCY_TIMESTAMP_SQL above, otherwise these rows exported with a blank
      // "Último mensaje" and "Sin responder desde" fell back all the way to stage_since.
      lastMessageAt: r.last_customer_message_at ?? r.last_message_at,
      lastMessage: r.last_customer_message ?? r.last_message,
    })));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Preview for the "Descargar Conversaciones" button (2026-09-16 request) — a search's
// count broken down by temperature, so an admin can see "8 en frío, 3 en caliente..."
// before committing to a possibly-large download. Customer-centric (same reasoning as
// buildAllTimeSearchClause above) so a resolved, dormant, or still-with-the-bot
// conversation can't silently be missing from this count — "todo el tiempo" means
// every customer, not just what's currently on the advisor board. Grouped by raw
// temperature rather than BUCKET_CASE_SQL's board bucket, since bucket is a ticket-
// status-flavored concept (pendiente/resuelto/etc.) that doesn't cleanly apply to a
// customer with no active ticket at all.
// "Informe gerencial" numbers (2026-09-16 request) — on top of the temperature
// breakdown, how many of these conversations actually bought (ever), how many of those
// sales landed in the current calendar month specifically, and the conversion rate —
// the same three questions Mauricio asks for any reference, not just this one, so this
// stays reusable rather than one-off. "Compraron" counts pagado+despacho — despacho is
// still a sale, just further along in fulfillment (Mauricio's own words: "si es
// despacho es porque ya pagó"). "Ventas este mes" reads the same customer_marked_paid
// audit event /pipeline/stats' own conversionCost already keys on, scoped to Guatemala's
// calendar month (same AT TIME ZONE convention used everywhere else in this file).
router.get('/pipeline/search-summary', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const trimmedQ = (req.query.q ?? '').trim();
    if (!trimmedQ) return res.status(400).json({ error: 'q is required' });

    const params = [];
    const cte = buildArchiveSearchCte(trimmedQ, params, req.query);
    const [byTempResult, salesResult] = await Promise.all([
      pool.query(`
        ${cte}
        SELECT ${EFFECTIVE_STATUS_SQL} AS temperature, count(*) AS total
        FROM customers c
        WHERE c.id IN (SELECT customer_id FROM all_matches)
        GROUP BY temperature
      `, params),
      pool.query(`
        ${cte}
        SELECT
          count(*) FILTER (WHERE ${EFFECTIVE_STATUS_SQL} IN ('pagado', 'despacho')) AS compraron,
          (SELECT count(*) FROM access_audit aa
           WHERE aa.action = 'customer_marked_paid'
             AND aa.customer_id IN (SELECT customer_id FROM all_matches)
             AND (aa.accessed_at AT TIME ZONE 'America/Guatemala') >= date_trunc('month', now() AT TIME ZONE 'America/Guatemala')
          ) AS ventas_mes
        FROM customers c
        WHERE c.id IN (SELECT customer_id FROM all_matches)
      `, params),
    ]);

    const byTemperature = Object.fromEntries(byTempResult.rows.map((r) => [r.temperature, Number(r.total)]));
    const total = byTempResult.rows.reduce((sum, r) => sum + Number(r.total), 0);
    const compraron = Number(salesResult.rows[0]?.compraron ?? 0);
    res.json({
      total,
      byTemperature,
      compraron,
      conversionRate: total > 0 ? compraron / total : 0,
      ventasEsteMes: Number(salesResult.rows[0]?.ventas_mes ?? 0),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Bucket-agnostic date-range clause for /pipeline/stats below — same since/from/until/to
// parsing and Guatemala -06 convention buildPipelineFilters already uses, minus the
// search/orderExpr coupling that only makes sense for a single paginated column. Used
// against three different date columns (ticket stage_since, message created_at, ticket
// created_at) in three separate queries, so the column expression is caller-supplied
// rather than implied by a bucket the way orderExprFor is.
function buildDateRangeClause(query, params, dateExpr) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const { from, to, since, until } = query;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    throw Object.assign(new Error('from/to must be YYYY-MM-DD'), { status: 400 });
  }
  if (since && !Number.isFinite(Date.parse(since))) {
    throw Object.assign(new Error('since must be a valid timestamp'), { status: 400 });
  }
  if (until && !Number.isFinite(Date.parse(until))) {
    throw Object.assign(new Error('until must be a valid timestamp'), { status: 400 });
  }
  let clause = '';
  if (since) {
    params.push(new Date(since).toISOString());
    clause += ` AND ${dateExpr} >= $${params.length}`;
  } else if (from) {
    params.push(`${from}T00:00:00-06:00`);
    clause += ` AND ${dateExpr} >= $${params.length}`;
  }
  if (until) {
    params.push(new Date(until).toISOString());
    clause += ` AND ${dateExpr} < $${params.length}`;
  } else if (to) {
    const toTs = new Date(`${to}T00:00:00-06:00`);
    toTs.setUTCDate(toTs.getUTCDate() + 1); // exclusive end — the whole "to" day counts
    params.push(toTs.toISOString());
    clause += ` AND ${dateExpr} < $${params.length}`;
  }
  return clause;
}

// The "expandir estadísticas" popup (2026-09-12) — the board's own stat strip only ever
// shows a card for a bucket that HAS unread messages, so an admin can't see the complete
// picture (a bucket sitting at 0 just isn't there). This is the "show me everything, no
// exceptions" view: every one of the 8 buckets' total+unread, plus two operational
// numbers the board doesn't surface at all (conversation volume by hour of day, average time
// to first advisor response) — all for whatever date range the popup's own period
// selector is set to, independent of the board's own filter. One round trip, three cheap
// queries, no caching layer (an on-demand popup, not a page load).
// — Conversaciones reales del periodo (WhatsApp + Instagram + Messenger) para el modal de estadísticas —
// Una "conversación" es un cliente que escribió ese día. Origen del cliente en el periodo: por anuncio (algún mensaje suyo vino con referral de Meta),
// respuesta a difusión (se le mandó una difusión en las 24 horas anteriores a su primer mensaje del día) u orgánico. Instagram y Messenger cuentan como línea 1 (no tienen línea propia).
const guatemalaDay = (iso) => new Date(new Date(iso).getTime() - 6 * 3600000).toISOString().slice(0, 10);

// Las difusiones "novedad pedido" y "seguimiento asesor" son avisos de servicio, no campañas: el trafficker no las cuenta ni en enviadas, ni en leídas, ni en respuestas.
const notServiceBroadcast = (alias) => ` AND NOT EXISTS (SELECT 1 FROM campaigns ca WHERE ca.id::text = ${alias}.message->'additional_kwargs'->>'campaignId' AND ca.template_name ~* 'novedad[ _-]*pedido|seguimiento[ _-]*asesor')`;

function waLineSql(ids) {
  if (!ids?.length) return '';
  return ` AND (${ids.map((n) => (n === 1
    ? "(h.session_id NOT LIKE '%__line_2%' AND (h.whatsapp_number_id IS NULL OR h.whatsapp_number_id = 1))"
    : `(h.session_id LIKE '%__line_${n}%' OR h.whatsapp_number_id = ${n})`)).join(' OR ')})`;
}

const timed = async (name, promise) => { const t0 = Date.now(); const out = await promise; console.log(`[stats] ${name}: ${Date.now() - t0} ms`); return out; };

async function conversationStats(query, lineIds) {
  const hp = []; const sp = [];
  const hDate = buildDateRangeClause(query, hp, 'h.created_at');
  const sDate = buildDateRangeClause(query, sp, 'sm.created_at');
  const socialIncluded = !lineIds?.length || lineIds.includes(1);
  const { rows } = await pool.query(`
    WITH wa AS (
      SELECT split_part(h.session_id, '__', 1) AS ref, 'whatsapp' AS channel, (h.created_at AT TIME ZONE 'America/Guatemala')::date AS day,
             bool_or(h.message->'additional_kwargs'->'referral' IS NOT NULL OR h.message->'additional_kwargs'->>'ad_id' IS NOT NULL) AS ad, min(h.created_at) AS first_at, count(*) AS msgs
      FROM n8n_chat_histories h
      WHERE h.message->>'type' = 'human' ${hDate} ${waLineSql(lineIds)}
      GROUP BY 1, 3
    ),
    -- Las difusiones del periodo (y el día anterior), leídas una sola vez en vez de buscarlas cliente por cliente.
    sends AS (
      SELECT split_part(s.session_id, '__', 1) AS ref, s.created_at AS at FROM n8n_chat_histories s
      WHERE s.message->'additional_kwargs'->>'campaignId' IS NOT NULL ${notServiceBroadcast('s')}
        AND s.created_at >= (SELECT min(first_at) FROM wa) - interval '24 hours' AND s.created_at < (SELECT max(first_at) FROM wa)
    )
    SELECT to_char(wa.day, 'YYYY-MM-DD') AS day, wa.channel, wa.ref, wa.ad, wa.msgs,
           (c.created_at AT TIME ZONE 'America/Guatemala')::date = wa.day AS is_new,
           (NOT wa.ad AND EXISTS (
             SELECT 1 FROM sends s WHERE s.ref = wa.ref AND s.at >= wa.first_at - interval '24 hours' AND s.at < wa.first_at
           )) AS broadcast
    FROM wa LEFT JOIN customers c ON c.whatsapp_number = wa.ref`, hp);
  let social = [];
  if (socialIncluded) {
    ({ rows: social } = await pool.query(`
      SELECT to_char((sm.created_at AT TIME ZONE 'America/Guatemala')::date, 'YYYY-MM-DD') AS day, sc.provider AS channel, 'social:' || sc.id AS ref, false AS ad, count(*) AS msgs,
             bool_or((c.created_at AT TIME ZONE 'America/Guatemala')::date = (sm.created_at AT TIME ZONE 'America/Guatemala')::date) AS is_new, false AS broadcast
      FROM social_messages sm JOIN social_contacts sc ON sc.id = sm.contact_id LEFT JOIN customers c ON c.id = sc.customer_id
      WHERE sm.direction = 'in' ${sDate}
      GROUP BY 1, 2, sc.id`, sp));
  }
  const all = [...rows, ...social];
  const daily = new Map();
  const people = new Map();
  for (const r of all) {
    const origin = r.channel !== 'whatsapp' ? 'social' : r.ad ? 'ads' : r.broadcast ? 'broadcast' : 'organic';
    const d = daily.get(r.day) ?? { day: r.day, total: 0, messages: 0, whatsapp: 0, instagram: 0, messenger: 0, ads: 0, broadcast: 0, organic: 0, social: 0 };
    d.messages += Number(r.msgs) || 0;
    d.total += 1; d[r.channel] = (d[r.channel] ?? 0) + 1; d[origin] += 1;
    daily.set(r.day, d);
    const p = people.get(r.ref) ?? { channel: r.channel, origin: 'organic', isNew: false };
    if (origin === 'ads' || (origin === 'broadcast' && p.origin !== 'ads')) p.origin = origin;
    p.isNew = p.isNew || !!r.is_new;
    people.set(r.ref, p);
  }
  const list = [...people.values()];
  const count = (fn) => list.filter(fn).length;
  // Total gerencial (como lo arma el trafficker): anuncios de WhatsApp + respuestas a difusión + Instagram + Messenger. No incluye el orgánico de WhatsApp.
  const days = [...daily.values()].map((d) => ({ ...d, managerTotal: d.ads + d.broadcast + d.social })).sort((a, b) => a.day.localeCompare(b.day));
  const sum = (k) => days.reduce((n, d) => n + (d[k] ?? 0), 0);
  return {
    daily: days,
    summary: {
      // Conversaciones = clientes por día, sumados (como cuentan Meta y el Excel gerencial); "clientes distintos" es aparte.
      conversations: sum('total'), messages: sum('messages'),
      byChannel: { whatsapp: sum('whatsapp'), instagram: sum('instagram'), messenger: sum('messenger') },
      byOrigin: { ads: sum('ads'), broadcast: sum('broadcast'), organic: sum('organic'), social: sum('social') }, managerTotal: sum('managerTotal'),
      people: list.length, newPeople: count((p) => p.isNew), returning: count((p) => !p.isNew),
    },
  };
}

// Conversaciones por hora: clientes distintos que escribieron en cada hora, en cualquier canal.
async function conversationsByHourQuery(query, lineIds) {
  const hp = []; const sp = [];
  const hDate = buildDateRangeClause(query, hp, 'h.created_at');
  const sDate = buildDateRangeClause(query, sp, 'sm.created_at');
  const socialIncluded = !lineIds?.length || lineIds.includes(1);
  const [wa, soc] = await Promise.all([
    pool.query(`SELECT extract(hour FROM h.created_at AT TIME ZONE 'America/Guatemala')::int AS hour, count(DISTINCT h.session_id) AS total
      FROM n8n_chat_histories h WHERE h.message->>'type' = 'human' ${hDate} ${waLineSql(lineIds)} GROUP BY hour`, hp),
    socialIncluded ? pool.query(`SELECT extract(hour FROM sm.created_at AT TIME ZONE 'America/Guatemala')::int AS hour, count(DISTINCT sm.contact_id) AS total
      FROM social_messages sm WHERE sm.direction = 'in' ${sDate} GROUP BY hour`, sp) : { rows: [] },
  ]);
  const byHour = {};
  for (const r of [...wa.rows, ...soc.rows]) byHour[r.hour] = (byHour[r.hour] ?? 0) + Number(r.total);
  return byHour;
}

// Difusiones enviadas y leídas por día (mensajes de campaña; el estado "read" lo escribe el seguimiento de WhatsApp).
async function broadcastByDay(query, lineIds) {
  const p = [];
  const dateClause = buildDateRangeClause(query, p, 'h.created_at');
  const { rows } = await pool.query(`SELECT to_char((h.created_at AT TIME ZONE 'America/Guatemala')::date, 'YYYY-MM-DD') AS day, count(*) AS sent,
      count(*) FILTER (WHERE h.message->'additional_kwargs'->>'status' = 'read') AS read
    FROM n8n_chat_histories h WHERE h.message->'additional_kwargs'->>'campaignId' IS NOT NULL ${notServiceBroadcast('h')} ${dateClause} ${waLineSql(lineIds)} GROUP BY 1`, p);
  return Object.fromEntries(rows.map((r) => [r.day, { sent: Number(r.sent), read: Number(r.read) }]));
}

// Ventas confirmadas por día (las mismas del módulo de ventas: estado confirmada y con monto), con su valor en Q. Una venta sin línea es de la línea 1.
async function paidByDay(query, lineIds) {
  const p = [];
  const dateClause = buildDateRangeClause(query, p, 's.created_at');
  const lineClause = lineIds?.length ? ` AND COALESCE(s.whatsapp_number_id, 1) IN (${lineIds.map(Number).join(',')})` : '';
  const { rows } = await pool.query(`SELECT to_char((s.created_at AT TIME ZONE 'America/Guatemala')::date, 'YYYY-MM-DD') AS day, count(*) AS n, COALESCE(sum(s.amount), 0) AS amount
    FROM sales s WHERE s.status = 'confirmada' AND s.amount > 0 ${dateClause}${lineClause} GROUP BY 1`, p);
  return Object.fromEntries(rows.map((r) => [r.day, { n: Number(r.n), amount: Number(r.amount) }]));
}

// Todos los días del rango con ceros donde no hubo conversaciones (el modal los dibuja completos).
function fillDays(daily, from, to) {
  if (!from || !to) return daily;
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 400; t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, total: 0, messages: 0, whatsapp: 0, instagram: 0, messenger: 0, ads: 0, broadcast: 0, organic: 0, social: 0, managerTotal: 0 });
  }
  return out;
}

// Atención y ventas por asesora y por día (1.5, 1.6, 1.7). La asesora solo ve lo suyo; admin y supervisor ven a todas.
// Atención = lo que escribió desde el CRM (WhatsApp, Instagram y Messenger), sin las difusiones masivas; venta = a nombre de quien la cerró en el módulo de ventas.
router.get('/pipeline/stats/advisors', async (req, res, next) => {
  try {
    const parsedLineId = req.query.lineId ? parseInt(req.query.lineId, 10) : null;
    let lineIds = parsedLineId ? [parsedLineId] : null;
    if (req.user.role === 'asesor') {
      const { rows: mine } = await pool.query('SELECT whatsapp_number_id FROM user_whatsapp_numbers WHERE user_id = $1', [req.user.id]);
      const own = mine.map((r) => r.whatsapp_number_id);
      lineIds = parsedLineId && own.includes(parsedLineId) ? [parsedLineId] : own;
    }
    const socialIncluded = !lineIds?.length || lineIds.includes(1);
    const hp = []; const sp = []; const vp = [];
    const hDate = buildDateRangeClause(req.query, hp, 'h.created_at');
    const sDate = buildDateRangeClause(req.query, sp, 'sm.created_at');
    const vDate = buildDateRangeClause(req.query, vp, 's.created_at');
    const saleLine = lineIds?.length ? ` AND COALESCE(s.whatsapp_number_id, 1) IN (${lineIds.map(Number).join(',')})` : '';
    const [wa, soc, sales, fx] = await Promise.all([
      pool.query(`SELECT to_char((h.created_at AT TIME ZONE 'America/Guatemala')::date, 'YYYY-MM-DD') AS day, h.message->'additional_kwargs'->>'advisorName' AS advisor,
          count(*) AS msgs, count(DISTINCT split_part(h.session_id, '__', 1)) AS convs
        FROM n8n_chat_histories h
        WHERE h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor' AND h.message->'additional_kwargs'->>'campaignId' IS NULL ${hDate} ${waLineSql(lineIds)}
        GROUP BY 1, 2`, hp),
      socialIncluded ? pool.query(`SELECT to_char((sm.created_at AT TIME ZONE 'America/Guatemala')::date, 'YYYY-MM-DD') AS day, sm.advisor_name AS advisor, count(*) AS msgs, count(DISTINCT sm.contact_id) AS convs
        FROM social_messages sm WHERE sm.direction = 'out' AND sm.advisor_name IS NOT NULL ${sDate} GROUP BY 1, 2`, sp) : { rows: [] },
      pool.query(`SELECT to_char((s.created_at AT TIME ZONE 'America/Guatemala')::date, 'YYYY-MM-DD') AS day, s.advisor_name AS advisor, count(*) AS n, COALESCE(sum(s.amount), 0) AS amount
        FROM sales s WHERE s.status = 'confirmada' AND s.amount > 0 ${vDate}${saleLine} GROUP BY 1, 2`, vp),
      getSetting('fx_q_cop', 420).catch(() => 420),
    ]);
    const norm = (n) => String(n ?? '').trim() || 'Sin asignar';
    const rows = new Map();
    const at = (day, advisor) => { const k = `${day}|${norm(advisor)}`; if (!rows.has(k)) rows.set(k, { day, advisor: norm(advisor), conversations: 0, messages: 0, sales: 0, salesAmount: 0 }); return rows.get(k); };
    for (const r of [...wa.rows, ...soc.rows]) { const x = at(r.day, r.advisor); x.messages += Number(r.msgs); x.conversations += Number(r.convs); }
    for (const r of sales.rows) { const x = at(r.day, r.advisor); x.sales += Number(r.n); x.salesAmount += Number(r.amount); }
    let daily = [...rows.values()];
    if (req.user.role === 'asesor') daily = daily.filter((r) => r.advisor === norm(req.user.fullName));
    daily.sort((a, b) => a.day.localeCompare(b.day) || a.advisor.localeCompare(b.advisor));
    const byAdvisor = new Map();
    for (const r of daily) {
      const a = byAdvisor.get(r.advisor) ?? { advisor: r.advisor, conversations: 0, messages: 0, sales: 0, salesAmount: 0 };
      a.conversations += r.conversations; a.messages += r.messages; a.sales += r.sales; a.salesAmount += r.salesAmount;
      byAdvisor.set(r.advisor, a);
    }
    const advisors = [...byAdvisor.values()].map((a) => ({ ...a, conversionRate: a.conversations > 0 ? a.sales / a.conversations : null })).sort((a, b) => b.salesAmount - a.salesAmount || b.conversations - a.conversations);
    res.json({ advisors, daily, fxQtoCop: Number(fx) > 0 ? Number(fx) : 420 });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Costos de pauta y de mensajes: salen de Meta (llamadas externas, lentas), así que van aparte y la pantalla ya se ve mientras llegan.
// Se recuerdan 5 minutos por periodo: abrir y cerrar el modal no vuelve a preguntarle a Meta.
const COSTS_TTL_MS = 5 * 60 * 1000;
const costsCache = new Map();
async function statsCosts(query) {
  const req = { query };
  const { from, to, since, until } = req.query;
  const guatemalaDateOnly = (iso) => new Date(new Date(iso).getTime() - 6 * 3600000).toISOString().slice(0, 10);
  const metaSinceDate = since ? guatemalaDateOnly(since) : (from ?? null);
  const metaUntilDate = until ? guatemalaDateOnly(until) : (to ?? (metaSinceDate ? guatemalaDateOnly(new Date().toISOString()) : null));

  // El costo por mensaje se pide a la vez que el gasto de pauta, no después.
  const messageCostCall = metaSinceDate && metaUntilDate ? fetchMessageCost(metaSinceDate, metaUntilDate).then((v) => ({ v }), (e) => ({ e })) : null;
  let conversionCost = null;
  let conversionCostError = null;
  if (metaSinceDate && metaUntilDate) {
    try {
      const conversionParams = [];
      const conversionDateClause = buildDateRangeClause(req.query, conversionParams, 'aa.accessed_at');
      const [conversionsResult, spend] = await Promise.all([
        // Scoped to customers who actually arrived THROUGH a pauta — a referral-
        // tagged message anywhere in their thread, same signal dashboard.js's
        // pautaByDay already keys on — and NOT just "everyone who got marked paid"
        // this period, or the number answers "how much did we spend per sale
        // overall" instead of the ad-specific question it's named for (2026-09-13
        // correction). The referral can predate this period by a lot (the ad click
        // and the eventual sale are rarely the same day), so it's checked over the
        // customer's whole history, not narrowed to the same date window as the sale.
        pool.query(
          `SELECT count(DISTINCT aa.customer_id) AS conversions
           FROM access_audit aa
           JOIN customers c ON c.id = aa.customer_id
           WHERE aa.action = 'customer_marked_paid' ${conversionDateClause}
             AND EXISTS (
               SELECT 1 FROM n8n_chat_histories h
               WHERE h.session_id LIKE c.whatsapp_number || '%'
                 AND h.message->'additional_kwargs'->'referral' IS NOT NULL
             )`,
          conversionParams
        ),
        fetchAdSpend(metaSinceDate, metaUntilDate),
      ]);
      if (spend !== null) {
        const conversions = Number(conversionsResult.rows[0].conversions);
        conversionCost = {
          spend: spend.spend,
          currency: spend.currency,
          conversions,
          costPerConversion: conversions > 0 ? spend.spend / conversions : null,
          // Meta Ads' own "Costo por resultado" — spend ÷ conversations STARTED via
          // the ad, not ÷ actual sales like costPerConversion above (2026-09-16
          // report: the two read as the same thing but aren't).
          results: spend.results,
          costPerResult: spend.costPerResult,
        };
      } else {
        // A period WAS picked (that's the only way this branch runs at all) — null
        // here means "not configured", not "no range chosen", and the frontend can't
        // tell those two null/null states apart on its own, so it has to be spelled
        // out as an error rather than left silent the way "Todo" is.
        conversionCostError = 'Meta Ads no está configurado — agrégalo en Configuración > Meta Ads';
      }
    } catch (err) {
      // Meta Ads misconfigured/unreachable shouldn't take the whole popup down with
      // it — the bucket/hour/response-delay numbers above are still good on their own.
      conversionCostError = err.message;
    }
  }

  // Costo por mensaje (2026-09-13) — WhatsApp's own pricing_analytics, confirmed
  // against Studio F's real WABA: SERVICE (a normal reply inside the customer-opened
  // 24h window) always costs 0, MARKETING is what's actually billed. Same
  // period/config-vs-no-range distinction as conversionCost above.
  let messageCost = null;
  let messageCostError = null;
  if (metaSinceDate && metaUntilDate) {
    const { v: cost, e: err } = await messageCostCall;
    if (err) messageCostError = err.message;
    else if (cost !== null) messageCost = cost;
    else messageCostError = 'WhatsApp no está configurado — agrega un número activo en Configuración > Números de WhatsApp';
  }


  return { conversionCost, conversionCostError, messageCost, messageCostError };
}

router.get('/pipeline/stats/costs', async (req, res, next) => {
  try {
    const { from, to, since, until } = req.query;
    const key = JSON.stringify([from, to, since, until]);
    const hit = costsCache.get(key);
    if (hit && Date.now() - hit.at < COSTS_TTL_MS) return res.json(hit.payload);
    const payload = await statsCosts({ from, to, since, until });
    costsCache.set(key, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Abierto a todos los roles (2026-10-24; antes admin y supervisor): la asesora ve los totales de sus líneas asignadas.
const STATS_TTL_MS = 60 * 1000;
const statsCache = new Map();

router.get('/pipeline/stats', async (req, res, next) => {
  try {
    const cacheKey = JSON.stringify([req.user.role === 'asesor' ? req.user.id : 'all', req.query.from, req.query.to, req.query.since, req.query.until, req.query.lineId]);
    const cached = statsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < STATS_TTL_MS) return res.json(cached.payload);
    const started = Date.now();
    const bucketParams = [];
    const bucketDateClause = buildDateRangeClause(req.query, bucketParams, 'stage_since');
    const historyParams = [];
    const historyDateClause = buildDateRangeClause(req.query, historyParams, 'h.created_at');
    const responseParams = [];
    const responseDateClause = buildDateRangeClause(req.query, responseParams, 't.created_at');

    const parsedLineId = req.query.lineId ? parseInt(req.query.lineId, 10) : null;
    // Líneas que cuentan las conversaciones: la elegida; la asesora solo las suyas.
    let lineIds = parsedLineId ? [parsedLineId] : null;
    if (req.user.role === 'asesor') {
      const { rows: mine } = await pool.query('SELECT whatsapp_number_id FROM user_whatsapp_numbers WHERE user_id = $1', [req.user.id]);
      const own = mine.map((r) => r.whatsapp_number_id);
      lineIds = parsedLineId && own.includes(parsedLineId) ? [parsedLineId] : own;
    }
    let statsLineSql = '';
    if (parsedLineId) {
      bucketParams.push(parsedLineId);
      statsLineSql = ` AND COALESCE(t.whatsapp_number_id, 1) = $${bucketParams.length}`;
    }

    const [buckets, byHourMap, responseDelay, conv, paid, broadcasts] = await Promise.all([
      pool.query(`
        WITH temped AS (
          SELECT t.status AS ticket_status, ${EFFECTIVE_STATUS_SQL} AS temperature,
                 t.updated_at AS stage_since,
                 CASE
                 WHEN t.status IN ('esperando_asesor', 'resuelto') THEN false
                 WHEN (${TICKET_LAST_MSG_AT_SQL}) IS NOT NULL AND (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                 WHEN (${TICKET_LAST_MSG_AT_SQL}) > (${TICKET_LAST_CUST_MSG_AT_SQL}) THEN false
                 WHEN (${TICKET_LAST_CUST_MSG_AT_SQL}) IS NULL THEN false
                 ELSE ${TICKET_HAS_UNREAD_SQL}
               END AS customer_has_unread, c.created_at AS customer_created_at,
                 ${TICKET_LAST_CUST_MSG_AT_SQL} AS last_customer_message_at,
                 ${TICKET_LAST_MSG_AT_SQL} AS last_message_at,
                 ROW_NUMBER() OVER (PARTITION BY t.customer_id, ${parsedLineId ? '1' : 'COALESCE(t.whatsapp_number_id, 1)'} ORDER BY t.created_at DESC, t.id DESC) AS ticket_rn
          FROM tickets t JOIN customers c ON c.id = t.customer_id
          WHERE t.status NOT IN ${HIDDEN_TICKET_STATUSES_SQL} ${EXCLUDE_PHANTOM_LINE_TICKET_SQL} ${statsLineSql} ${linesClause(req.user, 't')}
        ),
        -- Same duplicate-open-ticket collapse as /pipeline — see its comment. Has to
        -- happen before bucket_total/unread_total are counted, or a duplicate would
        -- inflate those the same way it inflates the board itself.
        deduped AS (
          SELECT * FROM temped WHERE ticket_rn = 1
        ),
        -- Same dormancy exclusion the advisor board itself applies (dormant absent —
        -- this popup is scoped to the advisor Pipeline, never Marketing's dormant view)
        -- — without it, a dormant en_atencion/cotizacion/medio_pago contact counted here
        -- but not on the board it's meant to mirror (2026-09-13 report: this was showing
        -- 3759 "En conversación" while the actual board, post-dormancy, showed ~20).
        bucketed AS (
          SELECT ${BUCKET_CASE_SQL} AS bucket, customer_has_unread, customer_created_at
          FROM deduped WHERE true ${bucketDateClause} ${dormancyClauseSql()}
        )
        SELECT bucket, count(*) AS total, count(*) FILTER (WHERE customer_has_unread) AS unread_total,
               -- Same "cuánta gente entró hoy" the board's own top stat strip shows
               -- (HandoffQueue.jsx's grandNewToday), fixed to today's Guatemala calendar
               -- day regardless of whatever period this popup itself is filtered to —
               -- 2026-09-16 request to fold the board's own summary strip into this popup.
               count(*) FILTER (WHERE (customer_created_at AT TIME ZONE 'America/Guatemala') >= date_trunc('day', now() AT TIME ZONE 'America/Guatemala')) AS new_today_total
        FROM bucketed GROUP BY bucket
      `, bucketParams),
      timed('por hora', conversationsByHourQuery(req.query, lineIds)),
      pool.query(`
        SELECT round(avg(extract(epoch FROM (t.first_response_at - t.created_at)))/60) AS avg_min
        FROM tickets t JOIN customers c ON c.id = t.customer_id
        WHERE t.first_response_at IS NOT NULL ${responseDateClause} ${parsedLineId ? `AND COALESCE(t.whatsapp_number_id, 1) = $${responseParams.length + 1}` : ''}
      `, parsedLineId ? [...responseParams, parsedLineId] : responseParams),
      timed('conversaciones', conversationStats(req.query, lineIds)),
      timed('ventas', paidByDay(req.query, lineIds)),
      timed('difusiones', broadcastByDay(req.query, lineIds)),
    ]);

    // Zero-fill every bucket/hour a GROUP BY silently drops instead of returning it as
    // 0 — that omission is exactly the "se oculta esa casilla" problem this popup exists
    // to fix, so it can't happen again one level down in the response either.
    const totalsByBucket = Object.fromEntries(buckets.rows.map((r) => [r.bucket, { total: Number(r.total), unreadTotal: Number(r.unread_total) }]));
    const bucketStats = PIPELINE_COLUMNS.map((key) => ({
      bucket: key,
      total: totalsByBucket[key]?.total ?? 0,
      unreadTotal: totalsByBucket[key]?.unreadTotal ?? 0,
    }));
    const conversationsByHour = Array.from({ length: 24 }, (_, hour) => ({ hour, total: byHourMap[hour] ?? 0 }));
    const { from: qFrom, to: qTo, since: qSince, until: qUntil } = req.query;
    const rangeFrom = qSince ? guatemalaDay(qSince) : qFrom;
    const rangeTo = qUntil ? guatemalaDay(new Date(Date.parse(qUntil) - 1).toISOString()) : qTo;
    const daily = fillDays(conv.daily, rangeFrom, rangeTo).map((d) => ({ ...d, sales: paid[d.day]?.n ?? 0, salesAmount: paid[d.day]?.amount ?? 0, broadcastSent: broadcasts[d.day]?.sent ?? 0, broadcastRead: broadcasts[d.day]?.read ?? 0 }));
    const sales = daily.reduce((n, d) => n + d.sales, 0);
    const salesAmount = daily.reduce((n, d) => n + d.salesAmount, 0);
    const conversations = { ...conv.summary, sales, salesAmount, closeRate: conv.summary.managerTotal > 0 ? sales / conv.summary.managerTotal : null };

    // Costo de conversión (2026-09-13): gasto en pauta (Meta Ads, act_ account in
    // Configuración) ÷ clientes QUE LLEGARON POR ESA PAUTA y pasaron a Pagado en el
    // periodo — "de los que entran por pauta, cuántos de verdad terminan comprando"
    // (2026-09-13 clarification), not "cost per sale" in general. The conversion count
    // is customers.js's own 'customer_marked_paid' audit event (access_audit) narrowed
    // to a referral-tagged thread, not anything from Meta, since Meta has no way to know
    // which of its leads actually paid inside this CRM. "Todo" has no bounded range to ask Meta
    // for — pulling an ad account's entire lifetime spend on every popup open is both
    // slow and not really what "costo de conversión" means without a period attached —
    // so the metric is simply unavailable then, same as it would be for any "since the
    // beginning of time" spend figure.
    const payload = {
      buckets: bucketStats,
      conversations,
      dailyConversations: daily,
      // El gasto de pauta y el costo por mensaje salen de Meta y no se separan por línea: con una línea elegida siguen siendo de toda la cuenta.
      costsAreAccountWide: !!parsedLineId,
      conversationsByHour,
      avgFirstResponseMinutes: responseDelay.rows[0].avg_min === null ? null : Number(responseDelay.rows[0].avg_min),
    };
    statsCache.set(cacheKey, { at: Date.now(), payload });
    console.log(`[stats] total: ${Date.now() - started} ms`);
    res.json(payload);
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
    const zClause = linesClause(req.user, 't');

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
