// One-off maintenance script — run manually inside the crm-backend container:
//   node src/scripts/compressExistingAttachments.js
//
// Recompresses every already-stored image/PDF attachment in place, the same way new ones
// get compressed going forward. Skips anything tied to a message still 'queued' for
// send (not yet delivered) — those still need to go out at full quality; the send paths
// that flush/recover a queued message will trigger compression themselves once it lands.
import { pool } from '../db.js';
import { compressStoredAttachment } from '../attachmentCompression.js';

async function main() {
  const { rows } = await pool.query(`
    SELECT a.id, a.size_bytes
    FROM message_attachments a
    JOIN n8n_chat_histories h ON h.id = a.n8n_message_id
    WHERE (a.kind = 'image' OR a.mime_type = 'application/pdf')
      AND coalesce(h.message->'additional_kwargs'->>'status', '') <> 'queued'
    ORDER BY a.id ASC
  `);

  console.log(`${rows.length} attachment(s) to process`);
  let before = 0, after = 0, done = 0;
  for (const row of rows) {
    before += row.size_bytes ?? 0;
    await compressStoredAttachment(row.id);
    const { rows: check } = await pool.query(`SELECT size_bytes FROM message_attachments WHERE id = $1`, [row.id]);
    after += check[0]?.size_bytes ?? row.size_bytes ?? 0;
    done += 1;
    if (done % 100 === 0) console.log(`${done}/${rows.length}...`);
  }

  console.log(`Done. ${done} processed.`);
  console.log(`Before: ${(before / 1024 / 1024).toFixed(1)} MB`);
  console.log(`After:  ${(after / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Saved:  ${((before - after) / 1024 / 1024).toFixed(1)} MB`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
