import pg from 'pg';

// pg.Pool reads PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD from env automatically.
export const pool = new pg.Pool();
