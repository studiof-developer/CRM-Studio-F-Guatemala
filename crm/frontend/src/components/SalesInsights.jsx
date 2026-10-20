import { PAID_METHOD_LABELS } from '../lib/paymentMethods.js';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

// Cómo pagaron los clientes, en versión compacta para el contenedor del resumen general.
export function PaymentMethodsMini({ methods, total }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-greige-ink">Medios de pago</p>
      {methods.length === 0
        ? <p className="mt-2 text-xs text-greige">Sin pagos registrados en este período.</p>
        : (
          <ul className="mt-2 grid gap-2">
            {methods.slice(0, 4).map((m) => {
              const pct = total > 0 ? (m.totalQuetzales / total) * 100 : 0;
              return (
                <li key={m.method}>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-semibold text-ink">{PAID_METHOD_LABELS[m.method] ?? (m.method === 'otro' ? 'Otro' : m.method)}</span>
                    <span className="text-greige-ink"><strong className="text-ink">{q(m.totalQuetzales)}</strong> · {pct.toFixed(0)} %</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

const dayLabel = (d) => String(d).slice(8, 10);

// Ventas de cada día del período; solo tiene sentido con más de un día.
export default function DailySalesCard({ daily }) {
  if (daily.length < 2) return null;
  const maxDay = Math.max(1, ...daily.map((d) => d.totalQuetzales));
  return (
    <section className="rounded-2xl border border-line bg-paper p-5">
      <h3 className="text-sm font-bold text-ink">Ventas por día</h3>
      <p className="text-[11px] text-greige-ink">Total vendido cada día del período</p>
      <div className="mt-4 flex h-32 items-end gap-1.5" role="img" aria-label="Ventas por día del período">
        {daily.map((d) => (
          <div key={String(d.day)} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${String(d.day).slice(0, 10)} · ${q(d.totalQuetzales)} · ${d.cantidadVentas} venta${d.cantidadVentas === 1 ? '' : 's'}`}>
            <div className="w-full rounded-t-md bg-success/80 transition-colors group-hover:bg-success" style={{ height: `${Math.max(3, (d.totalQuetzales / maxDay) * 100)}%` }} />
            <span className="mt-1 text-[10px] text-greige">{dayLabel(d.day)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
