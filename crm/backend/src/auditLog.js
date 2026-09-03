import { pool } from './db.js';

// Frontend panels poll every few seconds while open (live handoff status,
// live conversation updates), so a naive "log every request" would flood the
// trail with the same person "viewing" the same record dozens of times a
// minute. One real audit event per (actor, customer, action) per window is
// what a compliance log actually needs — not a heartbeat.
const DEDUPE_WINDOW = '2 minutes';

// Failures here are logged but never thrown — an audit trail glitch must
// never be the reason a real feature (viewing a customer, a ticket...) breaks.
// customerId is null for actions with no associated customer record (login,
// user management) — pass it explicitly as null, not omitted, to log those.
export async function logAccess(user, customerId, action, details = null) {
  if (customerId === undefined) return;
  try {
    await pool.query(
      `INSERT INTO access_audit (actor, actor_user_id, customer_id, action, details)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (
         SELECT 1 FROM access_audit
         WHERE actor_user_id = $2 AND customer_id IS NOT DISTINCT FROM $3 AND action = $4
           AND accessed_at > now() - interval '${DEDUPE_WINDOW}'
       )`,
      [user.fullName, user.id, customerId, action, details]
    );
  } catch (err) {
    console.error('access_audit insert failed', err);
  }
}

// A real state change (took a ticket, moved a pipeline stage, marked someone Paid) is a
// deliberate, one-off action, not a passive view a poll repeats every few seconds — it
// never needs (and must never get) the dedupe above, or a second genuine change within
// the same 2-minute window would silently vanish from the trail.
export async function logBusinessAction(user, customerId, action, details = null) {
  try {
    await pool.query(
      `INSERT INTO access_audit (actor, actor_user_id, customer_id, action, details) VALUES ($1, $2, $3, $4, $5)`,
      [user.fullName, user.id, customerId, action, details]
    );
  } catch (err) {
    console.error('access_audit insert failed', err);
  }
}
