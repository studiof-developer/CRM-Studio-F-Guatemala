import { rebuildHistory, completedDays, listBackups } from './salesHistory.js';
import { rescanRejectedReceipts } from './salesRescan.js';

// Corre la reconstrucción del historial en segundo plano para el botón del CRM (la misma lógica que el script de terminal).
// Una sola corrida a la vez (además del candado en la base). El estado vive en memoria: si el servidor se reinicia a mitad de camino,
// lo ya terminado queda registrado por día y al volver a iniciar retoma donde quedó.
// hooks.before / hooks.after (opcionales): pasos extra antes y después de reconstruir (las correcciones humanas de la revisión de un día).
const MAX_LINES = 5000;
let job = null;

export async function startHistoryJob({ mode, from, to, force = false, userName = null, hooks = {} }) {
  if (job?.running) throw Object.assign(new Error('Ya hay una reconstrucción corriendo. Espera a que termine.'), { status: 409 });
  const cur = { id: Date.now(), mode, from, to, force, userName, running: true, error: null, startedAt: new Date().toISOString(), finishedAt: null, lines: [], backup: null };
  job = cur;
  const log = (l) => { if (cur.lines.length < MAX_LINES) cur.lines.push(String(l)); };
  (async () => {
    await hooks.before?.(log);
    const r = await rebuildHistory({ from, to, apply: mode === 'apply', force, log });
    cur.backup = r?.backup ?? null;
    if (mode === 'apply') await hooks.after?.(log);
  })()
    .catch((err) => { cur.error = err.message; log(`ERROR: ${err.message}`); })
    .finally(() => { cur.running = false; cur.finishedAt = new Date().toISOString(); });
  return { id: cur.id };
}

// Misma ventana de progreso que la reconstrucción: relee los comprobantes guardados y quita los que eran pantallas de rechazo/verificación.
export async function startRescanJob({ days = 30, userName = null }) {
  if (job?.running) throw Object.assign(new Error('Ya hay un proceso corriendo. Espera a que termine.'), { status: 409 });
  const cur = { id: Date.now(), mode: 'rescan', from: null, to: null, force: false, userName, running: true, error: null, startedAt: new Date().toISOString(), finishedAt: null, lines: [], backup: null };
  job = cur;
  const log = (l) => { if (cur.lines.length < MAX_LINES) cur.lines.push(String(l)); };
  rescanRejectedReceipts({ days, log })
    .catch((err) => { cur.error = err.message; log(`ERROR: ${err.message}`); })
    .finally(() => { cur.running = false; cur.finishedAt = new Date().toISOString(); });
  return { id: cur.id };
}

export async function getHistoryState(since = 0) {
  const [days, backups] = await Promise.all([completedDays(), listBackups()]);
  const j = job && { id: job.id, mode: job.mode, from: job.from, to: job.to, running: job.running, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt, backup: job.backup, userName: job.userName, total: job.lines.length, lines: job.lines.slice(Math.max(0, since)) };
  return { job: j, days: days.map((d) => ({ day: d.day, completedAt: d.completed_at, backup: d.backup_table })), backups };
}

export const isHistoryJobRunning = () => !!job?.running;
