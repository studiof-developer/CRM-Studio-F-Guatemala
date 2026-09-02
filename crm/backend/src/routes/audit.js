import { Router } from 'express';
import { pool } from '../db.js';
import { findCustomerBySessionId, PHONE_RE } from './conversations.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';

const router = Router();

router.get('/access', async (req, res, next) => {
  try {
    const { customerId, actorUserId, action, from, to } = req.query;
    const clauses = [];
    const params = [];

    if (customerId) { params.push(customerId); clauses.push(`a.customer_id = $${params.length}`); }
    if (actorUserId) { params.push(actorUserId); clauses.push(`a.actor_user_id = $${params.length}`); }
    if (action) { params.push(action); clauses.push(`a.action = $${params.length}`); }
    if (from) { params.push(from); clauses.push(`a.accessed_at >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`a.accessed_at <= $${params.length}`); }

    const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.accessed_at, a.actor,
              c.id AS customer_id, c.full_name AS customer_name,
              u.id AS actor_user_id, u.full_name AS actor_name, u.role AS actor_role
       FROM access_audit a
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE true ${where}
       ORDER BY a.accessed_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/ai-decisions', async (req, res, next) => {
  try {
    const { handedOff } = req.query;
    const clauses = [];
    const params = [];
    if (handedOff !== undefined) { params.push(handedOff === 'true'); clauses.push(`handed_off = $${params.length}`); }
    const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT id, session_id, message_in, rag_context, response_out, confidence, handed_off, created_at
       FROM ai_decision_log
       WHERE true ${where}
       ORDER BY created_at DESC
       LIMIT 100`,
      params
    );

    // Resolving each row's customer and handoff correlation one at a time (up to 200
    // extra queries for 100 rows, each re-scanning that session's full message history
    // just to confirm a phone number regex already tells us) was the same "many small
    // queries fired in parallel" pattern that caused the real slowdowns fixed 2026-08-31
    // elsewhere in the app — batched into two queries total instead.
    //
    // Production session_ids are already the real wa_id (phone) — only the rare legacy
    // test session with a non-phone id needs the expensive transcript-scanning fallback
    // in findCustomerBySessionId, so that only ever runs for those, not for every row.
    const phoneBySessionId = new Map();
    const legacySessionIds = [];
    for (const r of rows) {
      if (!r.session_id) continue;
      if (PHONE_RE.test(r.session_id)) phoneBySessionId.set(r.session_id, r.session_id);
      else legacySessionIds.push(r.session_id);
    }
    for (const sessionId of new Set(legacySessionIds)) {
      const { phone } = await findCustomerBySessionId(sessionId);
      if (phone) phoneBySessionId.set(sessionId, phone);
    }

    const phones = [...new Set(phoneBySessionId.values())];
    const { rows: customers } = phones.length
      ? await pool.query(`SELECT id, full_name, whatsapp_number FROM customers WHERE whatsapp_number = ANY($1)`, [phones])
      : { rows: [] };
    const customerByPhone = new Map(customers.map((c) => [c.whatsapp_number, c]));

    const correlationRows = rows
      .map((r, i) => ({ i, customer: customerByPhone.get(phoneBySessionId.get(r.session_id)) }))
      .filter((c) => c.customer);
    const handedOffByIndex = new Map();
    if (correlationRows.length) {
      const { rows: handoffs } = await pool.query(
        `SELECT v.idx, EXISTS (
           SELECT 1 FROM tickets t
           WHERE t.customer_id = v.customer_id
             AND t.status IN ('esperando_asesor', 'en_atencion')
             AND t.created_at BETWEEN v.created_at - interval '30 seconds' AND v.created_at + interval '30 seconds'
         ) AS handed_off
         FROM unnest($1::int[], $2::int[], $3::timestamptz[]) AS v(idx, customer_id, created_at)`,
        [
          correlationRows.map((c) => c.i),
          correlationRows.map((c) => c.customer.id),
          correlationRows.map((c) => rows[c.i].created_at),
        ]
      );
      for (const h of handoffs) handedOffByIndex.set(h.idx, h.handed_off);
    }

    const enriched = rows.map((r, i) => {
      const customer = customerByPhone.get(phoneBySessionId.get(r.session_id));
      return { ...r, customerName: customer?.full_name ?? null, handed_off: handedOffByIndex.get(i) ?? false };
    });

    res.json(enriched);
  } catch (err) { next(err); }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "No advisor ever really engaged", not "nobody replied at all" — the bot's own
// automatic replies (a greeting, a catalog link, a canned "ya te atiende un asesor")
// flip awaiting_reply off without a human ever actually touching the conversation, so
// that flag alone undercounts real neglect. This is exactly the Pipeline's own "No
// atendidos" bucket (tickets.js's BUCKET_CASE_SQL: no ticket, or ticket still
// esperando_asesor) checked against the customer's MOST RECENT ticket only — an advisor
// closing an unrelated ticket months ago shouldn't exclude someone whose CURRENT
// conversation never got that far. Frío only, since Cotización/Medio de pago/etc. means
// the chat DID develop (a price got quoted, 033) — this is for chats that never got that
// far. The >24h floor and date range matter because this feeds a "send these people a
// broadcast" action. Guatemala never observes DST, so a fixed -06 offset for the day
// boundaries is always correct — same assumption the dashboard snapshot's 7am refresh
// already relies on.
router.get('/unanswered', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });
    }
    const fromTs = new Date(`${from}T00:00:00-06:00`);
    const toTs = new Date(`${to}T00:00:00-06:00`);
    toTs.setUTCDate(toTs.getUTCDate() + 1); // exclusive end — the whole "to" day counts
    if (Number.isNaN(fromTs) || Number.isNaN(toTs) || fromTs >= toTs) {
      return res.status(400).json({ error: 'invalid date range' });
    }

    const { rows } = await pool.query(
      `SELECT
         c.id AS customer_id, c.full_name, c.whatsapp_number AS phone,
         c.last_customer_message_at, c.last_customer_message,
         (SELECT count(*) FROM n8n_chat_histories h WHERE h.session_id LIKE c.whatsapp_number || '%') AS message_count
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT status FROM tickets WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1
       ) t ON true
       WHERE c.last_customer_message_at >= $1::timestamptz AND c.last_customer_message_at < $2::timestamptz
         AND c.last_customer_message_at <= now() - interval '24 hours'
         -- Someone already in Cotización or further along got real follow-up already
         -- (even if the very last reply was late) — this list is for genuinely cold,
         -- never-really-engaged leads, not anyone mid-negotiation.
         AND (${EFFECTIVE_STATUS_SQL}) = 'frio'
         -- The customer's MOST RECENT ticket, not "ever in their whole history" — a
         -- ticket an advisor closed months ago on a different inquiry shouldn't exclude
         -- someone whose CURRENT conversation never got that far. No ticket at all means
         -- it never even escalated past the bot; esperando_asesor means it escalated but
         -- nobody claimed it — both are exactly "no atendidos" in the Pipeline's terms.
         AND (t.status IS NULL OR t.status = 'esperando_asesor')
       ORDER BY c.last_customer_message_at ASC`,
      [fromTs.toISOString(), toTs.toISOString()]
    );
    res.json(rows.map((r) => ({
      phone: r.phone,
      customerId: r.customer_id,
      fullName: r.full_name,
      lastMessageAt: r.last_customer_message_at,
      lastMessage: r.last_customer_message,
      messageCount: Number(r.message_count),
    })));
  } catch (err) { next(err); }
});

export default router;
