import pg from 'pg';

// pg.Pool reads PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD from env automatically.
// The default max (10) was shared by every advisor, every SSE-driven list refresh, the
// dashboard, and campaign sends all at once — once all 10 were checked out, anything
// else just queued behind them with no time limit, which is exactly the "fast, then 5
// minutes" pattern reported. connectionTimeoutMillis at least turns "hangs forever" into
// a clear error instead of an invisible wait once the pool is genuinely saturated again.
export const pool = new pg.Pool({ max: 30, connectionTimeoutMillis: 10000 });

// An idle client in the pool dying (server restart, idle_session_timeout, a network
// blip) emits 'error' on the pool itself — with no listener that's an uncaught
// exception that crashes the whole process. The pool already discards the dead client
// and opens a fresh one on the next query by itself; this just keeps that from being fatal.
pool.on('error', (err) => console.error('idle pool client error', err));
