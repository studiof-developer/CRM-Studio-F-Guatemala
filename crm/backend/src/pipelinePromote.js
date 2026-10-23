import { pool } from './db.js';
import { getPendingPayments } from './pendingPayments.js';

// Todo cliente con un pago pendiente (la asesora ya le dio los medios de pago —texto, link o la tarjeta como imagen leída con OCR— y todavía no
// paga) debe estar en Caliente (columna «Medio de pago»). El disparador de la base (migración 056) solo lee texto; esto cubre las imágenes y los
// links, y vuelve a revisar todo cada 10 minutos. Solo sube de estado: nunca baja a nadie ni toca a quien ya pagó.
export async function promotePendingToCaliente() {
  const { items } = await getPendingPayments();
  let changed = 0;
  for (const id of new Set(items.map((i) => i.customerId).filter(Boolean))) {
    const { rows: [r] } = await pool.query("SELECT raise_customer_status($1, 'caliente', 'Pendiente de pago') AS status", [id]);
    if (r.status) changed += 1;
  }
  return changed;
}

export function startPendingPromotion() {
  const run = () => promotePendingToCaliente().then((n) => { if (n) console.log(`pipeline: ${n} cliente(s) pasaron a Caliente por pago pendiente`); }).catch((err) => console.error('promotePendingToCaliente failed', err.message));
  setTimeout(() => { run(); setInterval(run, 10 * 60 * 1000); }, 2 * 60 * 1000);
}
