import { pool } from './db.js';

// Frontend panels poll every few seconds while open (live handoff status,
// live conversation updates), so a naive "log every request" would flood the
// trail with the same person "viewing" the same record dozens of times a
// minute. One real audit event per (actor, customer, action) per window is
// what a compliance log actually needs — not a heartbeat.
const DEDUPE_WINDOW = '2 minutes';

// Failures here are logged but never thrown — an audit trail glitch must
// never be the reason a real feature (viewing a customer, a ticket...) breaks.
export async function logAccess(user, customerId, action) {
  if (!customerId) return;
  try {
    await pool.query(
      `INSERT INTO access_audit (actor, actor_user_id, customer_id, action)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM access_audit
         WHERE actor_user_id = $2 AND customer_id = $3 AND action = $4
           AND accessed_at > now() - interval '${DEDUPE_WINDOW}'
       )`,
      [user.fullName, user.id, customerId, action]
    );
  } catch (err) {
    console.error('access_audit insert failed', err);
  }
}
