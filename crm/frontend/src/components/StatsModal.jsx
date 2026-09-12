import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip } from 'chart.js';
import { X, Loader2 } from 'lucide-react';
import { fetchPipelineStats } from '../api.js';
import Select from './Select.jsx';
import { PERIOD_OPTIONS, guatemalaToday, addDays, monthBounds, MONTH_NAMES, guatemalaMidnight, useDayCutoffs } from '../lib/pipelinePeriod.js';
import { DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_COLOR_CLASSES } from '../lib/pipelineColumns.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

function useChart(canvasRef, buildConfig, deps) {
  useEffect(() => {
    if (!canvasRef.current) return;
    Chart.getChart(canvasRef.current)?.destroy();
    const chart = new Chart(canvasRef.current, buildConfig());
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function formatMinutes(m) {
  if (m === null) return 'Sin datos';
  if (m < 60) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

function metaFor(key) {
  const cfg = DEFAULT_COLUMN_META[key];
  return {
    label: cfg.label,
    icon: PIPELINE_ICON_MAP[cfg.icon],
    ...(PIPELINE_COLOR_CLASSES[cfg.color] ?? PIPELINE_COLOR_CLASSES.info),
  };
}

// Same visual card HandoffQueue.jsx's own stat strip uses — kept identical so this
// popup reads as "the same board, just showing everything" rather than a new UI.
function StatCard({ label, value, unit, iconBg, iconText, icon: Icon, sub }) {
  return (
    <div title={sub} className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-1.5 shadow-sm">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconBg} ${iconText}`}>
        <Icon size={12} />
      </span>
      <span className="whitespace-nowrap text-lg font-semibold leading-none tracking-tight text-ink">{value}</span>
      <span className="whitespace-nowrap text-xs leading-none text-greige-ink">{label}</span>
      {unit && <span className="whitespace-nowrap text-xs leading-none text-muted-foreground">{unit}</span>}
    </div>
  );
}

// "Expandir estadísticas" (2026-09-12): the board's own stat strip only ever shows a
// card for a bucket that HAS unread messages — a bucket sitting at 0 just isn't there.
// This is the "todos los estados, sin excepción" view, plus two operational numbers the
// board doesn't surface at all (mensajes por hora, demora en primera respuesta). Its own
// period filter, independent of whatever the board is currently showing.
export default function StatsModal({ open, onClose }) {
  const [periodPreset, setPeriodPreset] = useState('todo');
  const todayStr = guatemalaToday();
  const [monthCursor, setMonthCursor] = useState(() => {
    const [y, m] = todayStr.split('-').map(Number);
    return { year: y, month: m };
  });
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);
  const { todayCutoff, yesterdayCutoff } = useDayCutoffs(todayStr);

  let dateFrom, dateTo, sinceTs, untilTs;
  if (periodPreset === 'hoy') { sinceTs = todayCutoff ?? guatemalaMidnight(todayStr); }
  else if (periodPreset === 'ayer') {
    sinceTs = yesterdayCutoff ?? guatemalaMidnight(addDays(todayStr, -1));
    untilTs = todayCutoff ?? guatemalaMidnight(todayStr);
  }
  else if (periodPreset === 'semana') { dateFrom = addDays(todayStr, -6); dateTo = todayStr; }
  else if (periodPreset === 'mes') { ({ from: dateFrom, to: dateTo } = monthBounds(monthCursor.year, monthCursor.month)); }
  else if (periodPreset === 'personalizado') { dateFrom = customFrom; dateTo = customTo; }

  function shiftMonth(delta) {
    setMonthCursor((prev) => {
      let month = prev.month + delta;
      let year = prev.year;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      return { year, month };
    });
  }

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setData(null);
    setError(null);
    fetchPipelineStats({ from: dateFrom, to: dateTo, since: sinceTs, until: untilTs })
      .then(setData)
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dateFrom, dateTo, sinceTs, untilTs]);

  const hourRef = useRef(null);
  useChart(hourRef, () => ({
    type: 'bar',
    data: {
      labels: (data?.conversationsByHour ?? []).map((r) => `${r.hour}h`),
      datasets: [{
        data: (data?.conversationsByHour ?? []).map((r) => r.total),
        backgroundColor: '#4338ca',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
      },
    },
  }), [data]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', bounce: 0.25, duration: 0.45 }}
            className="glass-card w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Estadísticas del pipeline</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={periodPreset} onChange={setPeriodPreset} options={PERIOD_OPTIONS} className="w-44 shrink-0" />
                {periodPreset === 'mes' && (
                  <div className="flex shrink-0 items-center gap-1 rounded-lg border border-line bg-paper px-1.5 py-1.5 shadow-sm">
                    <button type="button" onClick={() => shiftMonth(-1)} className="rounded-full p-0.5 text-greige-ink hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Mes anterior">‹</button>
                    <span className="min-w-[108px] text-center text-xs font-medium text-ink">{MONTH_NAMES[monthCursor.month - 1]} {monthCursor.year}</span>
                    <button type="button" onClick={() => shiftMonth(1)} className="rounded-full p-0.5 text-greige-ink hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Mes siguiente">›</button>
                  </div>
                )}
                {periodPreset === 'personalizado' && (
                  <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 shadow-sm">
                    <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="bg-transparent text-xs text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]" />
                    <span className="text-xs text-greige-ink">a</span>
                    <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} className="bg-transparent text-xs text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]" />
                  </div>
                )}
                <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-greige-ink transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Cerrar">
                  <X size={16} />
                </button>
              </div>
            </div>

            {error && <p className="mt-4 text-sm text-danger">{error}</p>}
            {!data && !error && (
              <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
            )}
            {data && (
              <>
                <p className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-greige-ink">Todos los estados</p>
                <div className="flex flex-wrap gap-2">
                  {data.buckets.map((b) => {
                    const meta = metaFor(b.bucket);
                    return (
                      <StatCard key={b.bucket} label={meta.label} value={b.total} iconBg={meta.iconBg} iconText={meta.iconText} icon={meta.icon}
                        sub={`${b.unreadTotal} no leído(s)`} unit={b.unreadTotal > 0 ? `· ${b.unreadTotal} no leídos` : undefined} />
                    );
                  })}
                </div>

                <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-greige-ink">Demora en primera respuesta</p>
                <StatCard
                  label="promedio en el periodo"
                  value={formatMinutes(data.avgFirstResponseMinutes)}
                  iconBg={PIPELINE_COLOR_CLASSES.warning.iconBg}
                  iconText={PIPELINE_COLOR_CLASSES.warning.iconText}
                  icon={PIPELINE_ICON_MAP.Clock}
                />

                <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-greige-ink">Conversaciones por hora del día</p>
                <div style={{ position: 'relative', height: 200 }}>
                  <canvas ref={hourRef} role="img" aria-label="Conversaciones de clientes por hora del día" />
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
