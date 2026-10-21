import { pool } from './db.js';
import { auditSales } from './salesAttribution.js';

// Un día de ventas listo para revisar a mano: lo que el motor lee de los chats (ventas con comprobante o confirmación), las pruebas que
// NO cuenta y las ventas ya registradas que se borrarían. Cada fila lleva una llave estable para guardar la marca de quien revisa.
const paidItem = (i) => ({
  key: `r:${i.receiptId}`, at: i.at, customer: i.customer, phone: i.phone, line: i.line, amount: i.amount, type: i.type, via: i.via,
  voucher: !!i.voucher, medium: i.medium, advisor: i.expectedAdvisor, rule: i.rule, verified: !!i.verified, confirmedBy: i.confirmedBy ?? null,
  issues: i.issues ?? [], status: i.status, recordedAdvisor: i.recordedAdvisor ?? null, recordedAmount: i.recordedAmount ?? null,
  attributionUncertain: !!i.attributionUncertain,
});

export async function reviewDay(day) {
  const audit = await auditSales({ from: day, to: day, ignoreLock: true, ocrMaxReads: Infinity });
  const [{ rows: marks }, { rows: done }] = await Promise.all([
    pool.query('SELECT item_key, verdict, note FROM sales_day_reviews WHERE day = $1', [day]),
    pool.query('SELECT 1 FROM sales_rebuild_days WHERE day = $1', [day]),
  ]);
  const byAt = (a, b) => +new Date(a.at) - +new Date(b.at);
  const paid = audit.items.filter((i) => i.receiptId && i.status !== 'sin_contexto').map(paidItem).sort(byAt);
  const orphans = audit.items.filter((i) => i.status === 'sin_contexto').map((i) => ({
    key: `r:${i.receiptId}`, at: i.at, customer: i.customer, phone: i.phone, line: i.line, amount: i.amount,
  })).sort(byAt);
  const deletes = audit.items.filter((i) => i.saleId && ['sin_evidencia', 'duplicada'].includes(i.status)).map((i) => ({
    key: `s:${i.saleId}`, at: i.at, customer: i.customer, phone: i.phone, amount: i.amount, advisor: i.recordedAdvisor,
    duplicateOf: i.duplicateOf ?? null,
  })).sort(byAt);
  return { day, paid, orphans, deletes, marks: Object.fromEntries(marks.map((m) => [m.item_key, { verdict: m.verdict, note: m.note }])), completed: done.length > 0 };
}

// verdict null borra la marca.
export async function markItem({ day, itemKey, verdict, note, userId }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !/^[rs]:\d+$/.test(itemKey ?? '')) throw Object.assign(new Error('Día o venta no válidos'), { status: 400 });
  if (verdict === null) { await pool.query('DELETE FROM sales_day_reviews WHERE day = $1 AND item_key = $2', [day, itemKey]); return; }
  if (!['ok', 'mal'].includes(verdict)) throw Object.assign(new Error('La marca debe ser ok o mal'), { status: 400 });
  await pool.query(
    `INSERT INTO sales_day_reviews (day, item_key, verdict, note, reviewed_by, reviewed_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (day, item_key) DO UPDATE SET verdict = $3, note = $4, reviewed_by = $5, reviewed_at = now()`,
    [day, itemKey, verdict, String(note ?? '').slice(0, 500) || null, userId ?? null]
  );
}
