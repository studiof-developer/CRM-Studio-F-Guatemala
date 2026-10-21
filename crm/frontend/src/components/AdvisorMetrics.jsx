import { useState } from 'react';
import { ChevronDown, Eye } from 'lucide-react';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const q0 = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { maximumFractionDigits: 0 })}`;
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const TURNOS = [['Mañana', 'manana'], ['Tarde', 'tarde'], ['Domingo', 'domingo'], ['Fuera de turno', 'fuera']];
const GOAL_STATUS = {
  met: ['Meta cumplida', 'bg-success-bg text-success', 'bg-success'],
  ahead: ['Adelantada', 'bg-success-bg text-success', 'bg-success'],
  on_track: ['En ritmo', 'bg-accent-soft text-accent', 'bg-accent'],
  behind: ['Atrasada', 'bg-danger/10 text-danger', 'bg-danger'],
};

// Avance de la meta del mes de una asesora; la marca vertical es lo esperado a hoy.
function GoalBlock({ goal, monthly, day, days }) {
  const [label, badge, bar] = GOAL_STATUS[goal.status];
  const expectedPct = (day / days) * 100;
  return (
    <div className="mt-3 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-semibold text-greige-ink">Meta del mes · {q0(monthly)}</span>
        <span className={`rounded-full px-2 py-0.5 font-bold ${badge}`}>{label}</span>
      </div>
      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-line" title={`Esperado a hoy: ${Math.round(expectedPct)} %`}>
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, goal.pct)}%` }} />
        <span className="absolute top-0 h-full w-0.5 bg-ink/60" style={{ left: `${Math.min(100, expectedPct)}%` }} />
      </div>
      <p className="mt-1.5 text-[11px] text-greige-ink">
        <strong className="text-ink">{q0(goal.total)}</strong> en el mes · {goal.pct.toFixed(1)} %
        {goal.status === 'met' ? '' : <> · faltan <strong className="text-ink">{q0(goal.remaining)}</strong></>}
      </p>
    </div>
  );
}

// Métricas de cada asesora en mosaico (las columnas se ajustan solas al ancho). Con meta mensual, cada tarjeta lleva su avance.
// Las asesoras sin ventas quedan en una línea desplegable. onOpen(asesora, filtro) abre su detalle; `action` es el interruptor Mosaico | Tabla.
export default function AdvisorMetrics({ advisors, goals, pending, onOpen, onShowPending, action }) {
  const [showIdle, setShowIdle] = useState(false);
  const pendingOf = (name) => Object.entries(pending?.byAdvisor ?? {}).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  const active = advisors.filter((a) => a.cantidadVentas > 0 || a.porRevisar > 0 || pendingOf(a.advisorName));
  const idle = advisors.filter((a) => !active.includes(a));

  const goalOf = (name) => {
    for (const g of goals) {
      const hit = g.advisors.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (hit) return { goal: hit, monthly: g.monthly, day: g.day, days: g.days };
    }
    return null;
  };

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-ink">Métricas de asesoras</h3>
          <p className="text-[11px] text-greige-ink">Lo vendido en el período por cada asesora{goals.length ? ' y su avance de la meta del mes' : ''}</p>
        </div>
        {action}
      </div>

      {active.length === 0
        ? <p className="rounded-2xl border border-dashed border-line bg-paper px-4 py-8 text-center text-sm text-greige-ink">Todavía no hay ventas en este período.</p>
        : (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
            {active.map((a) => {
              const g = goalOf(a.advisorName);
              const pend = pendingOf(a.advisorName);
              return (
                <article key={a.advisorName} className="flex min-w-0 flex-col rounded-2xl border border-line bg-paper p-5 transition-shadow hover:shadow-md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-bold text-ink"><span className="mr-1.5">{MEDAL[a.rank] ?? <span className="text-sm text-greige">{a.rank}.</span>}</span>{a.advisorName}</p>
                      <p className="mt-0.5 text-xs text-greige-ink">{a.cantidadVentas} venta{a.cantidadVentas === 1 ? '' : 's'} · {a.clientesVendidos} cliente{a.clientesVendidos === 1 ? '' : 's'} · ticket {q(a.ticketPromedio)}</p>
                    </div>
                    <button type="button" onClick={() => onOpen(a, 'todas')} aria-label={`Ver ventas de ${a.advisorName}`} className="shrink-0 rounded-lg border border-line p-1.5 text-greige-ink hover:border-accent hover:text-accent"><Eye size={14} /></button>
                  </div>

                  <p className="mt-3 text-3xl font-extrabold tracking-tight text-success">{q(a.totalQuetzales)}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, a.porcentajeDelTotal)}%` }} /></div>
                    <span className="w-12 text-right text-xs font-semibold text-ink">{a.porcentajeDelTotal}%</span>
                  </div>
                  <p className="mt-1 text-[11px] text-greige">del total del equipo en el período</p>

                  {g && <GoalBlock {...g} />}

                  {(a.turnos || a.porValidar > 0 || a.porRevisar > 0 || pend) && (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
                      {a.turnos && TURNOS.filter(([, k]) => a.turnos[k] > 0).map(([label, k]) => (
                        <span key={k} className="rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-greige-ink dark:bg-white/[0.08]">{label} {q0(a.turnos[k])}</span>
                      ))}
                      {pend && <button type="button" onClick={onShowPending} className="rounded-full bg-warn/15 px-2.5 py-1 text-[11px] font-semibold text-warn hover:bg-warn/25">Pendiente de pago {q0(pend.total)} · {pend.count}</button>}
                      {a.porValidar > 0 && <span className="rounded-full bg-warn/10 px-2.5 py-1 text-[11px] font-semibold text-warn">{q0(a.porValidarTotal)} por validar</span>}
                      {a.porRevisar > 0 && (
                        <button type="button" onClick={() => onOpen(a, 'revisar')} className="rounded-full bg-warn/15 px-2.5 py-1 text-[11px] font-semibold text-warn hover:bg-warn/25">{a.porRevisar} por revisar</button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

      {idle.length > 0 && (
        <div className="mt-3 rounded-2xl border border-line bg-paper px-4 py-2">
          <button type="button" onClick={() => setShowIdle(!showIdle)} aria-expanded={showIdle} className="flex w-full items-center justify-between py-1.5 text-xs font-semibold text-greige-ink hover:text-ink">
            <span>{idle.length} asesora{idle.length === 1 ? '' : 's'} sin ventas en este período</span>
            <ChevronDown size={14} className={`transition-transform ${showIdle ? 'rotate-180' : ''}`} />
          </button>
          {showIdle && (
            <ul className="mb-1 mt-1 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {idle.map((a) => {
                const g = goalOf(a.advisorName);
                return (
                  <li key={a.advisorName} className="flex items-center justify-between gap-3 rounded-lg bg-black/[0.03] px-3 py-1.5 text-xs dark:bg-white/[0.04]">
                    <span className="truncate text-ink">{a.advisorName}</span>
                    {g && <span className="shrink-0 text-greige-ink">{g.goal.pct.toFixed(1)} % de la meta</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
