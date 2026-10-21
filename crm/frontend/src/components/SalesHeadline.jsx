import { ArrowDownRight, ArrowUpRight, Minus, Shirt, Target } from 'lucide-react';
import { deltaPct } from '../lib/salesCompare.js';
import { PaymentMethodsMini } from './SalesInsights.jsx';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const q0 = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { maximumFractionDigits: 0 })}`;
const TEAM_STATUS = { met: ['Meta cumplida', 'text-success', 'bg-success'], ahead: ['Adelantado', 'text-success', 'bg-success'], on_track: ['En ritmo', 'text-accent', 'bg-accent'], behind: ['Atrasado', 'text-danger', 'bg-danger'] };

// Contenedor del resumen general del reporte de ventas: el total del período y cómo va contra el período comparable, las cifras
// de apoyo, los medios de pago y, a la derecha, las acciones (prendas vendidas y meta mensual) con el avance de la meta del equipo.
// Lo "por validar" se avisa aparte para que nadie lea el total como definitivo sin saberlo.
export default function SalesHeadline({ title, summary, previous, porValidarTotal, porValidarCount, updatedAt, methods, goals, canEdit, canDefine, pending, onShowItems, onShowPending, onGoal }) {
  const current = summary.totalQuetzales;
  const pct = previous?.total != null ? deltaPct(current, previous.total) : null;
  const up = pct != null && pct > 0.05, down = pct != null && pct < -0.05;
  const tone = up ? 'bg-success-bg text-success' : down ? 'bg-danger/10 text-danger' : 'bg-black/[0.06] text-greige-ink dark:bg-white/[0.1]';
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  const btn = 'inline-flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2 text-xs font-semibold text-ink shadow-xs transition-colors hover:border-accent hover:text-accent';

  return (
    <section className="rounded-3xl border border-success/20 bg-gradient-to-r from-success-bg/60 via-paper to-paper px-6 py-6 md:px-8">
      <div className="flex flex-wrap items-stretch gap-x-10 gap-y-6">
        <div className="min-w-0 self-center">
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
          <dl className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3">
            {[['Ventas', summary.totalVentas], ['Clientes', summary.totalClientes], ['Ticket promedio', q(summary.ticketPromedio)]].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-greige-ink">{label}</dt>
                <dd className="mt-0.5 text-xl font-bold tracking-tight text-ink">{value}</dd>
              </div>
            ))}
            {pending && (
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-warn">Pendiente de pago</dt>
                <dd className="mt-0.5">
                  <button type="button" onClick={onShowPending} title="Ver los pagos pendientes: medios de pago enviados que todavía no se pagan" className="text-left text-xl font-bold tracking-tight text-warn hover:underline">
                    {q(pending.total)}
                    <span className="ml-1.5 text-xs font-semibold text-greige-ink">{pending.count} pendiente{pending.count === 1 ? '' : 's'}{pending.unknownCount ? ` · ${pending.unknownCount} sin monto` : ''}</span>
                  </button>
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="min-w-[240px] flex-1 self-center border-line md:max-w-sm xl:border-l xl:pl-8">
          <PaymentMethodsMini methods={methods} total={current} />
        </div>

        <div className="ml-auto flex w-full flex-col justify-center gap-2.5 border-line sm:w-64 xl:border-l xl:pl-8">
          {goals.map((g) => {
            const [label, text, bar] = TEAM_STATUS[g.team.status];
            return (
              <div key={g.lineId} className="rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-greige-ink">Meta del mes · {g.lineLabel}</span>
                  <span className={`font-bold ${text}`}>{label}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"><div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, g.team.pct)}%` }} /></div>
                <p className="mt-1 text-[11px] text-greige-ink">{q0(g.team.total)} de {q0(g.team.goal)} · {g.team.pct.toFixed(1)} %</p>
              </div>
            );
          })}
          {onShowItems && <button type="button" onClick={onShowItems} className={btn}><Shirt size={14} /> Ver prendas vendidas</button>}
          {goals.length > 0 && canEdit && <button type="button" onClick={() => onGoal(goals[0])} className={btn}><Target size={14} /> Cambiar meta mensual</button>}
          {goals.length === 0 && canDefine && <button type="button" onClick={() => onGoal(null)} className={`${btn} border-dashed text-accent`}><Target size={14} /> Definir meta mensual</button>}
          {updatedAt && <p className="text-center text-[11px] text-greige">Actualizado a las {updatedAt}</p>}
        </div>
      </div>
      {porValidarTotal > 0 && (
        <p className="mt-5 rounded-xl bg-warn/10 px-3.5 py-2 text-xs font-medium text-warn">
          Incluye {q(porValidarTotal)} por validar ({porValidarCount} venta{porValidarCount === 1 ? '' : 's'}): el monto sale del precio aprobado o la asesora no es clara. Un supervisor las confirma.
        </p>
      )}
    </section>
  );
}
