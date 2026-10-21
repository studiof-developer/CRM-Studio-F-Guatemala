// Reconstruye las ventas de días pasados leyendo los chats (ver salesHistory.js). Se corre dentro del contenedor del backend:
//   node src/scripts/rebuildHistory.js --from 2026-10-01 --to 2026-10-19            (en seco: solo informa)
//   node src/scripts/rebuildHistory.js --from 2026-10-01 --to 2026-10-19 --apply    (aplica, con copia de seguridad)
//   node src/scripts/rebuildHistory.js --restore sales_backup_202610211530           (deshace una corrida)
// Opciones: --line N (solo esa línea), --mark-unbacked (las ventas sin comprobante ni confirmación pasan a "por revisar"), --ocr-reads N.
import { pool } from '../db.js';
import { rebuildHistory, restoreBackup } from '../salesHistory.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

try {
  if (value('restore')) {
    const r = await restoreBackup(value('restore'));
    console.log(`Listo: ${r.restored} ventas devueltas a como estaban y ${r.deleted} insertadas por la corrida borradas (${r.from} → ${r.to}).`);
  } else {
    const from = value('from'), to = value('to');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) throw new Error('Usa --from AAAA-MM-DD --to AAAA-MM-DD');
    await rebuildHistory({
      from, to, apply: flag('apply'), lineId: value('line') ? Number(value('line')) : null,
      markUnbacked: flag('mark-unbacked'), ocrMaxReads: value('ocr-reads') ? Number(value('ocr-reads')) : 300,
    });
  }
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
