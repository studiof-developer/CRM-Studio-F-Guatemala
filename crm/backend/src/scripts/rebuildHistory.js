// Reconstruye las ventas de días pasados leyendo los chats (ver salesHistory.js). Se corre dentro del contenedor del backend:
//   node src/scripts/rebuildHistory.js --from 2026-10-01 --to 2026-10-19            (en seco: solo informa)
//   node src/scripts/rebuildHistory.js --from 2026-10-01 --to 2026-10-19 --apply    (aplica; si se corta, volver a correr el mismo
//                                                                                    comando retoma en el primer día que falte)
//   node src/scripts/rebuildHistory.js --status                                     (días ya reconstruidos)
//   node src/scripts/rebuildHistory.js --restore sales_backup_202610211530           (deshace una corrida)
// Opciones: --force (rehace también los días ya completos), --line N (solo esa línea), --keep-unbacked (no borrar las ventas sin
// respaldo en el chat), --ocr-reads N (tope de imágenes nuevas a leer por día; por defecto sin tope).
import { pool } from '../db.js';
import { rebuildHistory, restoreBackup, completedDays } from '../salesHistory.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

try {
  if (flag('status')) {
    const rows = await completedDays();
    console.log(rows.length ? `Días reconstruidos (${rows.length}):` : 'Todavía no se ha reconstruido ningún día.');
    for (const r of rows) console.log(`  ${r.day}  ${new Date(r.completed_at).toLocaleString('es-GT', { timeZone: 'America/Guatemala' })}  copia: ${r.backup_table}`);
  } else if (value('restore')) {
    const r = await restoreBackup(value('restore'));
    console.log(`Listo: ${r.restored} ventas devueltas a como estaban, ${r.reinserted} que se habían borrado vuelven, ${r.deleted} insertadas por la corrida se quitan y ${r.daysReopened} días quedan pendientes (${r.from} → ${r.to}).`);
  } else {
    const from = value('from'), to = value('to');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) throw new Error('Usa --from AAAA-MM-DD --to AAAA-MM-DD');
    await rebuildHistory({
      from, to, apply: flag('apply'), force: flag('force'), lineId: value('line') ? Number(value('line')) : null,
      keepUnbacked: flag('keep-unbacked'), ocrMaxReads: value('ocr-reads') ? Number(value('ocr-reads')) : Infinity,
    });
  }
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
