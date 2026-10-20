import { PAID_METHOD_LABELS } from '../lib/paymentMethods.js';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const dayLabel = (d) => String(d).slice(8, 10);

// Dos tarjetas de apoyo a la derecha del reporte de ventas: cómo se pagó y, si el período tiene varios días, cuánto se vendió cada día.
export default function SalesInsights({ daily, methods, total }) {
  const maxDay = Math.max(1, ...daily.map((d) => d.totalQuetzales));
  const showDaily = daily.length > 1;
  if (!showDaily && !methods.length) return null;
  return (
    <>
      {showDaily && (
        <section className="rounded-2xl border border-line bg-paper p-5">
          <h3 className="text-sm font-bold text-ink">Ventas por día</h3>
          <p className="text-[11px] text-greige-ink">Total vendido cada día del período</p>
          <div className="mt-4 flex h-36 items-end gap-1.5" role="img" aria-label="Ventas por día del período">
            {daily.map((d) => (
              <div key={String(d.day)} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${String(d.day).slice(0, 10)} · ${q(d.totalQuetzales)} · ${d.cantidadVentas} venta${d.cantidadVentas === 1 ? '' : 's'}`}>
                <div className="w-full rounded-t-md bg-success/80 transition-colors group-hover:bg-success" style={{ height: `${Math.max(3, (d.totalQuetzales / maxDay) * 100)}%` }} />
                <span className="mt-1 text-[10px] text-greige">{dayLabel(d.day)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {methods.length > 0 && (
        <section className="rounded-2xl border border-line bg-paper p-5">
          <h3 className="text-sm font-bold text-ink">Medios de pago</h3>
          <p className="text-[11px] text-greige-ink">Cómo pagaron los clientes en este período</p>
          <ul className="mt-4 grid gap-3">
            {methods.map((m) => {
              const pct = total > 0 ? (m.totalQuetzales / total) * 100 : 0;
              return (
                <li key={m.method}>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-semibold text-ink">{PAID_METHOD_LABELS[m.method] ?? (m.method === 'otro' ? 'Otro' : m.method)}</span>
                    <span className="text-greige-ink">{m.count} venta{m.count === 1 ? '' : 's'} · <strong className="text-ink">{q(m.totalQuetzales)}</strong> · {pct.toFixed(0)} %</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
