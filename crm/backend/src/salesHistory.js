import { pool } from './db.js';
import { auditSales, rebuildSales } from './salesAttribution.js';
import { guatemalaParts } from './salesRules.js';

// Reconstrucción de ventas de días pasados leyendo los chats, día por día, con el mismo motor que ya cuadra el día a día
// (auditSales / rebuildSales) pero sin los candados de "calibrado a mano". Primero se corre en seco (solo informa), y al aplicar se
// guarda una copia de las ventas del rango que permite deshacer todo (restoreBackup). Lo que un supervisor ya validó no se mueve.
const q = (n) => `Q${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const listDays = (from, to) => {
  const out = [];
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d = new Date(+d + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
};

// Lo que el chat dice que se vendió ese día: episodios con comprobante o confirmación de la asesora y monto, por asesora.
export function chatTotals(items) {
  const byAdvisor = new Map();
  for (const i of items) {
    if (!i.type || !i.verified || !(Number(i.amount) > 0)) continue;
    const name = i.expectedAdvisor || 'Sin Asignar';
    const cur = byAdvisor.get(name) ?? { total: 0, count: 0 };
    cur.total += Number(i.amount); cur.count += 1;
    byAdvisor.set(name, cur);
  }
  return byAdvisor;
}

// registered / chat: Map asesora -> { total, count }. Una fila por asesora con las dos cifras y su diferencia.
export function compareDay(registered, chat) {
  const names = [...new Set([...registered.keys(), ...chat.keys()])].sort();
  return names.map((name) => {
    const r = registered.get(name) ?? { total: 0, count: 0 }, c = chat.get(name) ?? { total: 0, count: 0 };
    return { name, registered: r.total, registeredCount: r.count, chat: c.total, chatCount: c.count, diff: c.total - r.total };
  });
}

export async function registeredByDay(from, to) {
  const { rows } = await pool.query(
    `SELECT to_char(created_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD') AS day, COALESCE(NULLIF(TRIM(advisor_name), ''), 'Sin Asignar') AS advisor, SUM(amount) AS total, COUNT(*)::int AS count
     FROM sales WHERE status = 'confirmada' AND amount > 0 AND COALESCE(notes, '') NOT LIKE '%no se reconoció como comprobante%'
       AND created_at >= $1 AND created_at <= $2 GROUP BY 1, 2`,
    [new Date(`${from}T00:00:00-06:00`), new Date(`${to}T23:59:59.999-06:00`)]
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.day)) out.set(r.day, new Map());
    out.get(r.day).set(r.advisor, { total: Number(r.total), count: r.count });
  }
  return out;
}

const CHANGE_LABEL = {
  sin_venta: 'FALTA LA VENTA', asesor_distinto: 'ASESORA DISTINTA', monto_distinto: 'MONTO DISTINTO', fecha_distinta: 'FECHA DISTINTA', confirmacion_pendiente: 'SE CONFIRMA',
};
const gtDay = (d) => guatemalaParts(d).ymd;

function describeChange(i) {
  const who = `${i.customer ?? ''} (…${String(i.phone ?? '').slice(-4)})`;
  if (i.status === 'sin_venta') return `${CHANGE_LABEL.sin_venta}: ${q(i.amount)} ${who} → ${i.expectedAdvisor ?? 'sin atribuir'}`;
  if (i.status === 'asesor_distinto') return `${CHANGE_LABEL.asesor_distinto}: ${q(i.amount)} ${who}: registrada ${i.recordedAdvisor} → chats ${i.expectedAdvisor}`;
  if (i.status === 'monto_distinto') return `${CHANGE_LABEL.monto_distinto}: ${who}: registrado ${q(i.recordedAmount)} → comprobante ${q(i.amount)}`;
  if (i.status === 'fecha_distinta') return `${CHANGE_LABEL.fecha_distinta}: ${q(i.amount)} ${who}: registrada ${gtDay(i.recordedAt)} → chats ${gtDay(i.at)}`;
  return `${CHANGE_LABEL.confirmacion_pendiente}: ${q(i.amount)} ${who} (${i.expectedAdvisor ?? 'sin atribuir'})`;
}

// Informe de un día (en seco): totales registrados vs lo que dicen los chats, cambios que se harían y ventas sin respaldo.
export async function previewDay(day, { lineId = null, ocrMaxReads = 300, registered }) {
  const audit = await auditSales({ from: day, to: day, lineId, ignoreLock: true, ocrMaxReads });
  const rows = compareDay(registered.get(day) ?? new Map(), chatTotals(audit.items));
  const changes = audit.items.filter((i) => CHANGE_LABEL[i.status]).map(describeChange);
  const unbacked = audit.items.filter((i) => i.status === 'sin_evidencia' || i.status === 'duplicada')
    .map((i) => `${i.status === 'duplicada' ? 'DUPLICADA' : 'SIN RESPALDO'}: ${q(i.amount)} ${i.customer ?? ''} (…${String(i.phone ?? '').slice(-4)}) registrada a ${i.recordedAdvisor}`);
  const noContext = audit.items.filter((i) => i.status === 'sin_contexto').length;
  return { day, rows, changes, unbacked, noContext, counts: audit.counts };
}

function printDay(log, rep, label = '') {
  log(`== ${rep.day}${label} ==`);
  if (!rep.rows.length) log('   sin ventas registradas ni en los chats');
  for (const r of rep.rows) log(`   ${r.name.padEnd(28)} registrado ${q(r.registered).padStart(12)} (${r.registeredCount})   chats ${q(r.chat).padStart(12)} (${r.chatCount})   dif ${(r.diff >= 0 ? '+' : '') + q(r.diff)}`);
  for (const c of rep.changes) log(`   · ${c}`);
  for (const u of rep.unbacked) log(`   ? ${u}`);
  if (rep.noContext) log(`   (${rep.noContext} comprobante(s) sin medios de pago ni confirmación en el chat: no cuentan)`);
}

// Copia de las ventas del rango (y 2 días alrededor, por si una venta cambia de fecha) para poder deshacer.
export async function createBackup(from, to) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  const name = `sales_backup_${stamp}`;
  const { rows: [m] } = await pool.query('SELECT COALESCE(max(id), 0) AS max FROM sales');
  const a = new Date(+new Date(`${from}T00:00:00-06:00`) - 2 * 86400000), b = new Date(+new Date(`${to}T23:59:59.999-06:00`) + 2 * 86400000);
  await pool.query(`CREATE TABLE ${name} AS SELECT * FROM sales WHERE created_at >= $1 AND created_at <= $2`, [a, b]);
  await pool.query(`COMMENT ON TABLE ${name} IS '${JSON.stringify({ maxId: Number(m.max), from, to })}'`);
  return name;
}

const RESTORE_COLUMNS = ['advisor_name', 'advisor_id', 'amount', 'receipt_amount', 'amount_source', 'amount_basis', 'attribution_uncertain', 'attribution_locked', 'status', 'created_at', 'confirmed_at', 'attributed_by', 'evidence_type', 'evidence_message_id', 'notes', 'updated_at'];

// Deshace una reconstrucción: devuelve las ventas de la copia a como estaban y borra las que la corrida insertó.
export async function restoreBackup(table) {
  if (!/^sales_backup_\d{12}$/.test(table ?? '')) throw new Error('Nombre de copia inválido (sales_backup_AAAAMMDDHHMM)');
  const { rows: [c] } = await pool.query("SELECT obj_description(to_regclass($1)) AS comment", [table]);
  if (!c?.comment) throw new Error(`No existe la copia ${table}`);
  const meta = JSON.parse(c.comment);
  const set = RESTORE_COLUMNS.map((col) => `${col} = b.${col}`).join(', ');
  const upd = await pool.query(`UPDATE sales s SET ${set} FROM ${table} b WHERE s.id = b.id`);
  const del = await pool.query(
    `DELETE FROM sales WHERE id > $1 AND created_at <= $2 AND evidence_type IN ('receipt_ocr', 'advisor_confirmation')`,
    [meta.maxId, new Date(`${meta.to}T23:59:59.999-06:00`)]
  );
  return { restored: upd.rowCount, deleted: del.rowCount, ...meta };
}

export async function rebuildHistory({ from, to, apply = false, lineId = null, markUnbacked = false, ocrMaxReads = 300, log = console.log }) {
  const days = listDays(from, to);
  if (!days.length || days.length > 31) throw new Error('El rango debe tener entre 1 y 31 días');
  log(`${apply ? 'APLICANDO' : 'EN SECO (no cambia nada)'}: ${from} → ${to} · ${days.length} días${lineId ? ` · línea ${lineId}` : ''}`);
  const before = await registeredByDay(from, to);
  const reports = [];
  for (const day of days) {
    const rep = await previewDay(day, { lineId, ocrMaxReads, registered: before });
    reports.push(rep);
    printDay(log, rep);
  }
  const sum = (key) => reports.reduce((n, r) => n + r.rows.reduce((m, x) => m + x[key], 0), 0);
  log(`\nTOTAL ${from} → ${to}: registrado ${q(sum('registered'))} · según los chats ${q(sum('chat'))} · diferencia ${q(sum('chat') - sum('registered'))}`);
  if (!apply) { log('\nNada cambió. Para aplicar: el mismo comando con --apply'); return { applied: false, reports }; }

  const backup = await createBackup(from, to);
  log(`\nCopia de seguridad: ${backup}  (para deshacer: --restore ${backup})`);
  for (const day of days) {
    await rebuildSales({ from: day, to: day, lineId, apply: true, ignoreLock: true, markUnbacked, ocrMaxReads });
  }
  const after = await registeredByDay(from, to);
  log('\nCÓMO QUEDÓ (registrado después de aplicar):');
  const done = [];
  for (const day of days) {
    const rep = await previewDay(day, { lineId, ocrMaxReads, registered: after });
    done.push(rep);
    printDay(log, { ...rep, changes: [] }, ' (después)');
  }
  return { applied: true, backup, reports, after: done };
}
