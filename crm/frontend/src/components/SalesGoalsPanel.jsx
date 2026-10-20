import { Pencil, Target } from 'lucide-react';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const STATUS = {
  met: ['Meta cumplida', 'bg-success-bg text-success'],
  ahead: ['Adelantada', 'bg-success-bg text-success'],
  on_track: ['En ritmo', 'bg-accent-soft text-accent'],
  behind: ['Atrasada', 'bg-danger/10 text-danger'],
};
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = (ym) => { const [y, m] = ym.split("-").map(Number); const n = MONTHS[m - 1]; return `${n[0].toUpperCase()}${n.slice(1)} ${y}`; };

function Bar({ pct, expectedPct, tone }) {
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-line" title={`Esperado a hoy: ${Math.round(expectedPct)} %`}>
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      <span className="absolute top-0 h-full w-0.5 bg-ink/60" style={{ left: `${Math.min(100, expectedPct)}%` }} />
    </div>
  );
}
const toneOf = (status) => (status === 'behind' ? 'bg-danger' : status === 'on_track' ? 'bg-accent' : 'bg-success');

// Cumplimiento del mes por asesora contra la meta de su línea (no depende del período que se esté viendo). La marca vertical de la
// barra es lo esperado a hoy: pasar de ella es ir adelantada.
export default function SalesGoalsPanel({ goals, canEdit, onEdit }) {
  return (
    <div className="mt-6 grid gap-4">
      {goals.map((g) => {
        const expectedPct = (g.day / g.days) * 100;
        const [teamLabel, teamClass] = STATUS[g.team.status];
        return (
          <section key={g.lineId} className="rounded-2xl border border-line bg-paper p-5 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-bold text-ink"><Target size={16} className="text-accent" />Cumplimiento del mes · {g.lineLabel}</h3>
                <p className="mt-0.5 text-xs text-greige-ink">{monthName(g.month)} · día {g.day} de {g.days} · meta de {q(g.monthly)} por asesora</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${teamClass}`}>Equipo: {teamLabel}</span>
                {canEdit && <button type="button" onClick={() => onEdit(g)} aria-label="Cambiar la meta" className="rounded-lg border border-line p-1.5 text-greige-ink hover:border-accent hover:text-accent"><Pencil size={14} /></button>}
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-1.5 flex items-baseline justify-between text-xs">
                <span className="font-semibold text-ink">Equipo: {q(g.team.total)} de {q(g.team.goal)}</span>
                <span className="font-bold text-ink">{g.team.pct.toFixed(1)} %</span>
              </div>
              <Bar pct={g.team.pct} expectedPct={expectedPct} tone={toneOf(g.team.status)} />
            </div>

            <ul className="mt-5 grid gap-4 md:grid-cols-2">
              {g.advisors.map((a) => {
                const [label, cls] = STATUS[a.status];
                return (
                  <li key={a.name} className="rounded-xl border border-line p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-ink">{a.name}</p>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${cls}`}>{label}</span>
                    </div>
                    <p className="mt-2 text-xl font-extrabold tracking-tight text-ink">{q(a.total)} <span className="text-xs font-medium text-greige-ink">de {q(g.monthly)} · {a.pct.toFixed(1)} %</span></p>
                    <div className="mt-2"><Bar pct={a.pct} expectedPct={expectedPct} tone={toneOf(a.status)} /></div>
                    <p className="mt-2 text-[11px] text-greige-ink">
                      {a.status === 'met' ? 'Ya alcanzó la meta del mes.' : <>Faltan <strong className="text-ink">{q(a.remaining)}</strong> · a este ritmo cerraría en <strong className="text-ink">{q(a.projected)}</strong></>}
                    </p>
                  </li>
                );
              })}
            </ul>
            {g.unassigned > 0 && <p className="mt-3 text-[11px] text-greige">Además hay {q(g.unassigned)} vendidos sin asesora asignada; no cuentan para ninguna meta.</p>}
          </section>
        );
      })}
    </div>
  );
}
