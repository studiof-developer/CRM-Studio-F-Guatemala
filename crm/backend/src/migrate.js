import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './db.js';

// 2026-09-17: db/init/*.sh only runs on a brand-new Postgres volume (Postgres' own
// docker-entrypoint-initdb.d convention) - an already-running deployment never picks up
// a new one, which until now meant every schema/trigger fix needed a human to paste raw
// SQL into a production terminal by hand (repeatedly a source of paste corruption and
// confusion). This runs migrations/*.sql (bundled into the image alongside src/ - see
// Dockerfile) against whatever database the backend is already pointed at, in order,
// tracking what's been applied - so `git push` alone is enough, same as every other change.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`migration applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      // Loud and fatal on purpose - starting up with a half-applied schema silently is
      // worse than the deploy failing where it's obvious something needs a look.
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}
