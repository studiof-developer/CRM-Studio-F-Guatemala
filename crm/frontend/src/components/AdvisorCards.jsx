import { Eye } from 'lucide-react';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const TURNOS = [['Mañana', 'manana'], ['Tarde', 'tarde'], ['Domingo', 'domingo'], ['Fuera de turno', 'fuera']];

// Una tarjeta por asesora para leer el resultado de un vistazo; la tabla completa sigue disponible en "Tabla".
// onOpen(asesora, filtro) abre su detalle de ventas.
export default function AdvisorCards({ advisors, onOpen }) {
  if (!advisors.length) {
    return <p className="rounded-2xl border border-line bg-paper p-8 text-center text-sm text-greige-ink">No se registraron ventas en este período. Cuando haya pagos en los chats, aparecerán aquí.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {advisors.map((a) => (
        <article key={a.advisorName} className="flex flex-col rounded-2xl border border-line bg-paper p-5 transition-shadow hover:shadow-md">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-base font-bold text-ink"><span className="mr-1.5">{MEDAL[a.rank] ?? <span className="text-sm text-greige">{a.rank}.</span>}</span>{a.advisorName}</p>
              <p className="mt-0.5 text-xs text-greige-ink">{a.cantidadVentas} venta{a.cantidadVentas === 1 ? '' : 's'} · {a.clientesVendidos} cliente{a.clientesVendidos === 1 ? '' : 's'}</p>
            </div>
            <button type="button" onClick={() => onOpen(a, 'todas')} aria-label={`Ver ventas de ${a.advisorName}`} className="rounded-lg border border-line p-1.5 text-greige-ink hover:border-accent hover:text-accent"><Eye size={14} /></button>
          </div>

          <p className="mt-4 text-3xl font-extrabold tracking-tight text-success">{q(a.totalQuetzales)}</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, a.porcentajeDelTotal)}%` }} /></div>
            <span className="w-12 text-right text-xs font-semibold text-ink">{a.porcentajeDelTotal}%</span>
          </div>
          <p className="mt-1 text-[11px] text-greige">del total del equipo · ticket promedio {q(a.ticketPromedio)}</p>

          {(a.turnos || a.porValidar > 0 || a.porRevisar > 0) && (
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line pt-3">
              {a.turnos && TURNOS.filter(([, k]) => a.turnos[k] > 0).map(([label, k]) => (
                <span key={k} className="rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-greige-ink dark:bg-white/[0.08]">{label} {q(a.turnos[k]).replace('.00', '')}</span>
              ))}
              {a.porValidar > 0 && <span className="rounded-full bg-warn/10 px-2.5 py-1 text-[11px] font-semibold text-warn">{q(a.porValidarTotal).replace('.00', '')} por validar</span>}
              {a.porRevisar > 0 && (
                <button type="button" onClick={() => onOpen(a, 'revisar')} className="rounded-full bg-warn/15 px-2.5 py-1 text-[11px] font-semibold text-warn hover:bg-warn/25">{a.porRevisar} por revisar</button>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
