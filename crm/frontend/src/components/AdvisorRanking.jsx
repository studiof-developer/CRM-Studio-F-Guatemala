import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

// Ranking compacto: una fila por asesora con ventas (posición, nombre, monto, barra de participación). Las asesoras sin ventas
// quedan ocultas en una línea que se despliega, para que el ranking mida lo mismo con 2 asesoras que con 8.
// onOpen(asesora, filtro) abre el detalle de ventas; `action` es el interruptor Ranking | Tabla.
export default function AdvisorRanking({ advisors, onOpen, action }) {
  const [showIdle, setShowIdle] = useState(false);
  const active = advisors.filter((a) => a.cantidadVentas > 0 || a.porRevisar > 0);
  const idle = advisors.filter((a) => !active.includes(a));

  return (
    <section className="min-w-0 rounded-2xl border border-line bg-paper p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-ink">Ranking de asesoras</h3>
          <p className="text-[11px] text-greige-ink">Por monto vendido en el período</p>
        </div>
        {action}
      </div>

      {active.length === 0
        ? <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-greige-ink">Todavía no hay ventas en este período.</p>
        : (
          <ul className="grid gap-1">
            {active.map((a) => (
              <li key={a.advisorName}>
                <div role="button" tabIndex={0} onClick={() => onOpen(a, 'todas')} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(a, 'todas'); }}
                  className="cursor-pointer rounded-xl px-3 py-2.5 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                  <div className="flex items-center gap-3">
                    <span className="w-7 shrink-0 text-center text-base">{MEDAL[a.rank] ?? <span className="text-sm font-semibold text-greige">{a.rank}.</span>}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-semibold text-ink">{a.advisorName}</span>
                        <span className="shrink-0 text-sm font-bold text-success">{q(a.totalQuetzales)}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, a.porcentajeDelTotal)}%` }} /></div>
                        <span className="w-10 text-right text-[11px] font-semibold text-ink">{a.porcentajeDelTotal}%</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-greige-ink">
                        <span>{a.cantidadVentas} venta{a.cantidadVentas === 1 ? '' : 's'} · ticket {q(a.ticketPromedio)}</span>
                        {a.porValidar > 0 && <span className="font-semibold text-warn">{q(a.porValidarTotal).replace('.00', '')} por validar</span>}
                        {a.porRevisar > 0 && (
                          <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(a, 'revisar'); }} className="rounded-full bg-warn/15 px-2 py-0.5 font-semibold text-warn hover:bg-warn/25">{a.porRevisar} por revisar</button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

      {idle.length > 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <button type="button" onClick={() => setShowIdle(!showIdle)} aria-expanded={showIdle} className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs font-semibold text-greige-ink hover:text-ink">
            <span>{idle.length} asesora{idle.length === 1 ? '' : 's'} sin ventas</span>
            <ChevronDown size={14} className={`transition-transform ${showIdle ? 'rotate-180' : ''}`} />
          </button>
          {showIdle && <ul className="mt-1 grid gap-0.5 px-3 pb-1">{idle.map((a) => <li key={a.advisorName} className="truncate text-xs text-greige-ink">{a.advisorName}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
