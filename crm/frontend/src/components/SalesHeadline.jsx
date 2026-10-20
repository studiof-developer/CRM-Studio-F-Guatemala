import { ArrowDownRight, ArrowUpRight, Minus, Shirt } from 'lucide-react';
import { deltaPct } from '../lib/salesCompare.js';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Franja de resumen del reporte de ventas (ancho completo, alto fijo): el total en grande, cómo va contra el período comparable y
// tres cifras de apoyo. Lo "por validar" se avisa aparte para que nadie lea el total como definitivo sin saberlo.
export default function SalesHeadline({ title, summary, previous, porValidarTotal, porValidarCount, updatedAt, onShowItems }) {
  const current = summary.totalQuetzales;
  const pct = previous?.total != null ? deltaPct(current, previous.total) : null;
  const up = pct != null && pct > 0.05, down = pct != null && pct < -0.05;
  const tone = up ? 'bg-success-bg text-success' : down ? 'bg-danger/10 text-danger' : 'bg-black/[0.06] text-greige-ink dark:bg-white/[0.1]';
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;

  return (
    <section className="rounded-3xl border border-success/20 bg-gradient-to-r from-success-bg/60 via-paper to-paper px-6 py-5 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-x-10 gap-y-5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-greige-ink">{title}</p>
          <p className="mt-0.5 text-[2.4rem] font-extrabold leading-none tracking-tight text-success md:text-5xl">{q(current)}</p>
          <div className="mt-2.5 flex min-h-[1.5rem] flex-wrap items-center gap-2 text-xs">
            {previous && (previous.loading
              ? <span className="text-greige">Comparando…</span>
              : previous.total == null
                ? null
                : pct == null
                  ? <span className="text-greige-ink">Sin ventas en {previous.label} para comparar.</span>
                  : (
                    <>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-bold ${tone}`}><Icon size={14} />{pct > 0 ? '+' : ''}{pct.toFixed(1)} %</span>
                      <span className="text-greige-ink">frente a {previous.label}: <strong className="text-ink">{q(previous.total)}</strong></span>
                    </>
                  ))}
          </div>
        </div>

        <dl className="flex items-center gap-8 md:gap-12">
          {[['Ventas', summary.totalVentas], ['Clientes', summary.totalClientes], ['Ticket promedio', q(summary.ticketPromedio)]].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-greige-ink">{label}</dt>
              <dd className="mt-1 text-2xl font-bold tracking-tight text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col items-start gap-2 md:items-end">
          {onShowItems && (
            <button type="button" onClick={onShowItems} className="inline-flex items-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2 text-xs font-semibold text-ink shadow-xs transition-colors hover:border-accent hover:text-accent">
              <Shirt size={14} /> Ver prendas vendidas
            </button>
          )}
          {updatedAt && <p className="text-[11px] text-greige">Actualizado a las {updatedAt}</p>}
        </div>
      </div>
      {porValidarTotal > 0 && (
        <p className="mt-4 rounded-xl bg-warn/10 px-3.5 py-2 text-xs font-medium text-warn">
          Incluye {q(porValidarTotal)} por validar ({porValidarCount} venta{porValidarCount === 1 ? '' : 's'}): el monto sale del precio aprobado o la asesora no es clara. Un supervisor las confirma.
        </p>
      )}
    </section>
  );
}
