import { pool } from './db.js';
import { auditSales } from './salesAttribution.js';
import { resolveAdvisor } from './salesThreads.js';

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
  const [{ rows: marks }, { rows: done }, { rows: advisors }] = await Promise.all([
    pool.query('SELECT item_key, verdict, note, amount_override, advisor_override, keep, discard FROM sales_day_reviews WHERE day = $1', [day]),
    pool.query('SELECT 1 FROM sales_rebuild_days WHERE day = $1', [day]),
    pool.query(`SELECT full_name FROM users WHERE role IN ('asesor', 'supervisor', 'admin') AND full_name IS NOT NULL ORDER BY full_name`),
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
  return {
    day, paid, orphans, deletes, advisors: advisors.map((a) => a.full_name), completed: done.length > 0,
    marks: Object.fromEntries(marks.map((m) => [m.item_key, {
      verdict: m.verdict, note: m.note, amountOverride: m.amount_override != null ? Number(m.amount_override) : null, advisorOverride: m.advisor_override, keep: m.keep, discard: m.discard,
    }])),
  };
}

// verdict null borra la marca. Una marca "mal" puede traer la corrección: monto correcto, asesora correcta o conservar la venta.
export async function markItem({ day, itemKey, verdict, note, amountOverride = null, advisorOverride = null, keep = false, discard = false, userId }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !/^[rs]:\d+$/.test(itemKey ?? '')) throw Object.assign(new Error('Día o venta no válidos'), { status: 400 });
  if (verdict === null) { await pool.query('DELETE FROM sales_day_reviews WHERE day = $1 AND item_key = $2', [day, itemKey]); return; }
  if (!['ok', 'mal'].includes(verdict)) throw Object.assign(new Error('La marca debe ser ok o mal'), { status: 400 });
  const amount = amountOverride === null || amountOverride === '' ? null : Number(amountOverride);
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || amount > 10000)) throw Object.assign(new Error('El monto debe estar entre Q1 y Q10,000'), { status: 400 });
  const advisor = String(advisorOverride ?? '').trim() || null;
  if (advisor && !(await resolveAdvisor(advisor)).id) throw Object.assign(new Error(`La asesora "${advisor}" no existe en el CRM`), { status: 400 });
  await pool.query(
    `INSERT INTO sales_day_reviews (day, item_key, verdict, note, amount_override, advisor_override, keep, discard, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $9, $8, now())
     ON CONFLICT (day, item_key) DO UPDATE SET verdict = $3, note = $4, amount_override = $5, advisor_override = $6, keep = $7, discard = $9, reviewed_by = $8, reviewed_at = now()`,
    [day, itemKey, verdict, String(note ?? '').slice(0, 500) || null, verdict === 'mal' ? amount : null, verdict === 'mal' ? advisor : null, verdict === 'mal' && !!keep, userId ?? null, verdict === 'mal' && !!discard]
  );
}

// Fija en una venta lo que la persona corrigió: monto y/o asesora quedan validados y el motor ya no los mueve.
async function fixSale(saleId, m, userId) {
  const sets = ["status = 'confirmada'", 'updated_at = now()'];
  const vals = [saleId];
  if (m.amount_override != null) { vals.push(m.amount_override, userId); sets.push(`amount = $${vals.length - 1}`, `amount_validated_by = $${vals.length}`, 'amount_validated_at = now()'); }
  else sets.push('amount_validated_at = COALESCE(amount_validated_at, now())');
  if (m.advisor_override) {
    const u = await resolveAdvisor(m.advisor_override);
    vals.push(u.name, u.id, userId);
    sets.push(`advisor_name = $${vals.length - 2}`, `advisor_id = $${vals.length - 1}`, `advisor_override_by = $${vals.length}`, 'advisor_override_at = now()', "attributed_by = 'manual'", 'attribution_uncertain = false');
  }
  const { rowCount } = await pool.query(`UPDATE sales SET ${sets.join(', ')} WHERE id = $1`, vals);
  return rowCount;
}

// phase 'before': las ventas marcadas "conservar" se validan antes de reconstruir (así no se borran). phase 'after': el monto/asesora
// corregidos de las ventas que leyó el motor se fijan sobre la venta ya creada o actualizada.
export async function applyHumanCorrections(day, userId, phase, log = () => {}) {
  const { rows: marks } = await pool.query(
    `SELECT item_key, amount_override, advisor_override, keep, discard FROM sales_day_reviews
     WHERE day = $1 AND verdict = 'mal' AND (amount_override IS NOT NULL OR advisor_override IS NOT NULL OR keep OR discard)`, [day]
  );
  let n = 0;
  for (const m of marks) {
    const id = Number(m.item_key.slice(2));
    if (phase === 'before' && m.item_key.startsWith('s:') && m.keep) n += await fixSale(id, m, userId);
    if (phase === 'after' && m.item_key.startsWith('r:') && m.discard) {
      // no fue una compra: no queda registro (si no existe aún, no hay nada que borrar)
      n += (await pool.query(`DELETE FROM sales WHERE evidence_message_id = $1 AND evidence_type IN ('receipt_ocr', 'advisor_confirmation')`, [id])).rowCount;
    } else if (phase === 'after' && m.item_key.startsWith('r:')) {
      const { rows } = await pool.query(`SELECT id FROM sales WHERE evidence_message_id = $1 AND evidence_type IN ('receipt_ocr', 'advisor_confirmation') ORDER BY id LIMIT 1`, [id]);
      if (rows[0]) n += await fixSale(rows[0].id, m, userId);
      else log(`Aviso: la venta marcada ${m.item_key} no existe después de reconstruir; su corrección no se aplicó`);
    }
  }
  if (n) log(`${phase === 'before' ? 'Ventas conservadas' : 'Correcciones aplicadas'}: ${n}`);
}
