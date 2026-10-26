import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { X, Loader2, Calendar, Mail, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import { fetchPipelineStats, fetchPipelineStatsCosts, fetchPipelineStatsAdvisors, fetchMetaAdsReport } from '../api.js';
import { showError } from './Toast.jsx';
import Select from './Select.jsx';
import { PERIOD_OPTIONS, guatemalaToday, addDays, monthBounds, MONTH_NAMES } from '../lib/pipelinePeriod.js';
import { DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_COLOR_CLASSES } from '../lib/pipelineColumns.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

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

// Meta's own pricing_category values, confirmed against Studio F's WABA (MARKETING,
// SERVICE) plus the two other billable categories the docs list — shown as whatever
// Meta actually sends if a new one ever shows up, rather than hiding it.
const PRICING_CATEGORY_LABELS = { MARKETING: 'Marketing', UTILITY: 'Utilidad', AUTHENTICATION: 'Autenticación', SERVICE: 'Servicio (gratis)', AI_BOT: 'Bot IA' };

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('es-GT', { style: 'currency', currency }).format(amount);
  } catch {
    // An unrecognized/unusual currency code from Meta shouldn't crash the whole popup —
    // falls back to a plain grouped number with the raw code appended.
    return `${new Intl.NumberFormat('es-GT').format(amount)} ${currency}`;
  }
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

const money0 = (n) => Math.round(n).toLocaleString('es-GT');

// Atención y ventas por asesora en el periodo. Conversión = ventas de la asesora ÷ conversaciones que atendió.
function AdvisorTable({ adv }) {
  if (!adv) return <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>;
  if (adv.failed) return <p className="text-xs text-danger">No se pudo cargar la atención por asesora.</p>;
  if (!adv.advisors.length) return <p className="text-xs text-muted-foreground">Sin atención ni ventas de asesoras en este periodo.</p>;
  const tot = adv.advisors.reduce((t, a) => ({ c: t.c + a.conversations, m: t.m + a.messages, s: t.s + a.sales, v: t.v + a.salesAmount }), { c: 0, m: 0, s: 0, v: 0 });
  const th = 'px-3 py-2 text-right font-semibold';
  return (
    <div className="max-h-64 overflow-auto rounded-xl border border-line">
      <table className="w-full min-w-[760px] text-xs">
        <thead className="sticky top-0 bg-paper uppercase tracking-wide text-greige-ink">
          <tr><th className="px-3 py-2 text-left font-semibold">Asesora</th><th className={th}>Conversaciones atendidas</th><th className={th}>Ventas</th><th className={th}>Valor (Q)</th><th className={th}>Valor (COP)</th><th className={th}>Conversión</th></tr>
        </thead>
        <tbody>
          {adv.advisors.map((a) => (
            <tr key={a.advisor} className="border-t border-line-soft tabular-nums">
              <td className="px-3 py-1.5 text-left text-ink">{a.advisor}</td>
              <td className="px-3 py-1.5 text-right">{a.conversations}</td>
              <td className="px-3 py-1.5 text-right font-semibold text-ink">{a.sales}</td><td className="px-3 py-1.5 text-right">{money0(a.salesAmount)}</td>
              <td className="px-3 py-1.5 text-right text-greige-ink">{money0(a.salesAmount * adv.fxQtoCop)}</td><td className="px-3 py-1.5 text-right text-greige-ink">{pctText(a.conversionRate)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-black/[0.03] font-bold tabular-nums text-ink dark:bg-white/[0.04]">
            <td className="px-3 py-2 text-left">Total</td><td className="px-3 py-2 text-right">{tot.c}</td><td className="px-3 py-2 text-right">{tot.s}</td>
            <td className="px-3 py-2 text-right">{money0(tot.v)}</td><td className="px-3 py-2 text-right">{money0(tot.v * adv.fxQtoCop)}</td><td className="px-3 py-2 text-right">{pctText(tot.c > 0 ? tot.s / tot.c : null)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// Excel gerencial: el mismo formato de la hoja del trafficker, con la pauta de Meta (filtro de campaña activo) y lo que atendió el CRM.
async function downloadExcel({ data, adv, dateFrom, dateTo, line }) {
  try {
    let meta = [];
    try { meta = (await fetchMetaAdsReport({ since: dateFrom, until: dateTo, level: 'campaign' })).daily ?? []; } catch { /* sin Meta: esas columnas salen vacías */ }
    const metaBy = Object.fromEntries(meta.map((d) => [d.date, d]));
    const fx = adv?.fxQtoCop ?? 420;
    // Formato del trafficker: WhatsApp = conversaciones por anuncio (Meta), más Instagram, Messenger y respuestas a difusión; el total no cuenta el orgánico de WhatsApp.
    const rows = data.dailyConversations.map((d) => {
      const x = metaBy[d.day];
      const wa = x?.conversations ?? d.ads;
      const total = wa + d.social + d.broadcast;
      return {
        Fecha: d.day, Clics: x?.linkClicks ?? '', 'Costo por clic': x?.cpc ?? '', CTR: x?.ctr != null ? x.ctr / 100 : '', '% conversión': x?.conversionPct != null ? x.conversionPct / 100 : '',
        WhatsApp: wa, 'Costo por mensaje': x?.costPerConversation ?? '', Inversión: x?.spend ?? '',
        'Difusiones enviadas': d.broadcastSent, Leídos: d.broadcastRead, '% tasa de lectura': d.broadcastSent > 0 ? d.broadcastRead / d.broadcastSent : 0, 'Respuestas de difusiones': d.broadcast,
        Instagram: d.instagram, Messenger: d.messenger, 'Total de todos los canales': total,
        Ventas: d.sales, 'Valor en ventas (Q)': d.salesAmount, 'Valor en ventas (COP)': d.salesAmount * fx, 'Tasa de cierre': total > 0 ? d.sales / total : 0, ROAS: x?.spend > 0 ? (d.salesAmount * fx) / x.spend : '',
        'WhatsApp por anuncio (CRM)': d.ads, 'WhatsApp orgánico (CRM, fuera del total)': d.organic,
      };
    });
    const sumK = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const spend = sumK('Inversión'); const cop = sumK('Valor en ventas (COP)'); const totalAll = sumK('Total de todos los canales'); const ventas = sumK('Ventas');
    rows.push({ Fecha: 'Total', Clics: sumK('Clics'), WhatsApp: sumK('WhatsApp'), Inversión: spend, 'Difusiones enviadas': sumK('Difusiones enviadas'), Leídos: sumK('Leídos'), 'Respuestas de difusiones': sumK('Respuestas de difusiones'),
      Instagram: sumK('Instagram'), Messenger: sumK('Messenger'), 'Total de todos los canales': totalAll, Ventas: ventas, 'Valor en ventas (Q)': sumK('Valor en ventas (Q)'), 'Valor en ventas (COP)': cop,
      'Tasa de cierre': totalAll > 0 ? ventas / totalAll : 0, ROAS: spend > 0 ? cop / spend : '',
      'WhatsApp por anuncio (CRM)': sumK('WhatsApp por anuncio (CRM)'), 'WhatsApp orgánico (CRM, fuera del total)': sumK('WhatsApp orgánico (CRM, fuera del total)') });
    const byAdvisor = (adv?.daily ?? []).map((r) => ({ Fecha: r.day, Asesora: r.advisor, 'Conversaciones atendidas': r.conversations, Ventas: r.sales, 'Valor (Q)': r.salesAmount, 'Valor (COP)': r.salesAmount * fx,
      Conversión: r.conversations > 0 ? r.sales / r.conversations : '' }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Gerencial');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byAdvisor.length ? byAdvisor : [{ Aviso: 'Sin datos de asesoras en el periodo' }]), 'Por asesora y día');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Periodo: `${dateFrom} a ${dateTo}`, Línea: line || 'Todas', 'Tipo de cambio Q→COP': fx, Nota: 'Pauta (clics, costo, inversión, mensajes Meta) = Meta con el filtro de campaña del Informe de anuncios. Lo demás = CRM.' }]), 'Notas');
    XLSX.writeFile(wb, `estadisticas-${dateFrom}_${dateTo}.xlsx`);
  } catch (err) { showError(err.message || 'No se pudo generar el Excel'); }
}

function SumRow({ label, value, strong, purple }) {
  return (
    <div className={`flex items-center justify-between ${purple ? 'text-purple-600 dark:text-purple-400' : ''}`}>
      <span>{label}</span>
      <span className={`${strong || purple ? 'font-bold' : 'font-semibold'} ${purple ? '' : strong ? 'text-accent' : 'text-ink'}`}>{value}</span>
    </div>
  );
}

// Conversaciones día por día (lo que el gerente ve en su Excel, pero con lo que el CRM atendió de verdad).
function DailyTable({ rows }) {
  const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  const sales = rows.some((r) => r.sales == null) ? null : sum('sales');
  const COLS = [['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['messenger', 'Messenger'], ['ads', 'Anuncios'], ['broadcast', 'Difusión'], ['organic', 'Orgánico WA'], ['managerTotal', 'Total gerencial']];
  const th = 'px-3 py-2 text-right font-semibold';
  return (
    <div className="rounded-xl border border-line">
      <div className="max-h-72 overflow-auto">
      <table className="w-full min-w-[900px] text-xs">
        <thead className="sticky top-0 bg-paper uppercase tracking-wide text-greige-ink">
          <tr><th className="px-3 py-2 text-left font-semibold">Día</th><th className={th}>Conversaciones</th>{COLS.map(([k, l]) => <th key={k} className={th}>{l}</th>)}<th className={th}>Ventas</th><th className={th}>Valor (Q)</th><th className={th}>Cierre</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day} className="border-t border-line-soft tabular-nums">
              <td className="px-3 py-1.5 text-left text-ink">{r.day.slice(8)}/{r.day.slice(5, 7)}</td>
              <td className="px-3 py-1.5 text-right font-semibold text-ink">{r.total}</td>
              {COLS.map(([k]) => <td key={k} className={`px-3 py-1.5 text-right ${k === 'managerTotal' ? 'font-semibold text-ink' : 'text-greige-ink'}`}>{r[k]}</td>)}
              <td className="px-3 py-1.5 text-right text-ink">{r.sales ?? '—'}</td>
              <td className="px-3 py-1.5 text-right text-greige-ink">{r.salesAmount ? Math.round(r.salesAmount).toLocaleString('es-GT') : '—'}</td>
              <td className="px-3 py-1.5 text-right text-greige-ink">{r.sales != null && r.managerTotal > 0 ? pctText(r.sales / r.managerTotal) : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-black/[0.03] font-bold tabular-nums text-ink dark:bg-white/[0.04]">
            <td className="px-3 py-2 text-left">Suma de días</td><td className="px-3 py-2 text-right">{sum('total')}</td>
            {COLS.map(([k]) => <td key={k} className="px-3 py-2 text-right">{sum(k)}</td>)}
            <td className="px-3 py-2 text-right">{sales ?? '—'}</td><td className="px-3 py-2 text-right">{Math.round(sum('salesAmount')).toLocaleString('es-GT')}</td><td className="px-3 py-2 text-right">{sales != null && sum('managerTotal') > 0 ? pctText(sales / sum('managerTotal')) : '—'}</td>
          </tr>
        </tfoot>
      </table>
      </div>
      <p className="border-t border-line-soft px-3 py-2 text-[11px] text-muted-foreground">Un cliente que escribe dos días distintos cuenta en cada día; por eso la suma de días puede ser mayor que las conversaciones del resumen.</p>
    </div>
  );
}

// "Expandir estadísticas" (2026-09-12): the board's own stat strip only ever shows a
// card for a bucket that HAS unread messages — a bucket sitting at 0 just isn't there.
// This is the "todos los estados, sin excepción" view, plus two operational numbers the
// board doesn't surface at all (mensajes por hora, demora en primera respuesta). Its own
// period filter, independent of whatever the board is currently showing.
// Sin "Todo": las estadísticas siempre son de un periodo concreto (por defecto, hoy).
const STATS_PERIODS = PERIOD_OPTIONS.filter((o) => o.value !== 'todo');
const pctText = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

export default function StatsModal({ open, onClose, lineId, lineOptions = [], role }) {
  const [periodPreset, setPeriodPreset] = useState('hoy');
  const [line, setLine] = useState(lineId ?? '');
  useEffect(() => { setLine(lineId ?? ''); }, [lineId]);
  const todayStr = guatemalaToday();
  const [monthCursor, setMonthCursor] = useState(() => {
    const [y, m] = todayStr.split('-').map(Number);
    return { year: y, month: m };
  });
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);

  // Plain calendar days, on purpose — NOT the advisor board's "since the last advisor
  // message before the day started" shift-aware cutoff (HandoffQueue.jsx/pipelinePeriod's
  // useDayCutoffs). This is a reporting popup: "Hoy" has to mean literally today,
  // midnight to now (2026-09-13 report: bars for hours that hadn't happened yet today
  // were actually yesterday's activity bleeding in through that cutoff), not a
  // pipeline-specific idea of when "today's backlog" starts.
  let dateFrom, dateTo;
  if (periodPreset === 'hoy') { dateFrom = todayStr; dateTo = todayStr; }
  else if (periodPreset === 'ayer') { dateFrom = addDays(todayStr, -1); dateTo = addDays(todayStr, -1); }
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
  const [adv, setAdv] = useState(null);
  const [costs, setCosts] = useState(null); // los costos vienen de Meta y tardan más: la pantalla se arma sin esperarlos
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setData(null);
    setCosts(null);
    setAdv(null);
    setError(null);
    fetchPipelineStats({ from: dateFrom, to: dateTo, lineId: line || undefined })
      .then((d) => { if (current) setData(d); })
      .catch((err) => { if (current) setError(err.message); });
    fetchPipelineStatsAdvisors({ from: dateFrom, to: dateTo, lineId: line || undefined })
      .then((a) => { if (current) setAdv(a); })
      .catch(() => { if (current) setAdv({ advisors: [], daily: [], fxQtoCop: 420, failed: true }); });
    fetchPipelineStatsCosts({ from: dateFrom, to: dateTo })
      .then((c) => { if (current) setCosts(c); })
      .catch((err) => { if (current) setCosts({ conversionCostError: err.message, messageCostError: err.message }); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dateFrom, dateTo, line]);

  const dayRef = useRef(null);
  const days = data?.dailyConversations ?? [];
  useChart(dayRef, () => ({
    type: 'bar',
    data: {
      labels: days.map((d) => `${d.day.slice(8)}/${d.day.slice(5, 7)}`),
      datasets: [
        { label: 'Anuncios', data: days.map((d) => d.ads), backgroundColor: '#4338ca', borderRadius: 2 },
        { label: 'Difusión', data: days.map((d) => d.broadcast), backgroundColor: '#f59e0b', borderRadius: 2 },
        { label: 'Orgánico', data: days.map((d) => d.organic), backgroundColor: '#10b981', borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true } },
        y: { stacked: true, beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
      },
    },
  }), [data]);

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
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ type: 'spring', bounce: 0.12, duration: 0.22 }}
            className="glass-card w-full max-w-7xl max-h-[92vh] overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Estadísticas del pipeline</h3>
              <div className="flex flex-wrap items-center gap-2">
                {lineOptions.length > 2 && <Select value={line} onChange={setLine} options={lineOptions} className="w-44 shrink-0" />}
                <Select value={periodPreset} onChange={setPeriodPreset} options={STATS_PERIODS} className="w-44 shrink-0" />
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
              <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-[230px_240px_340px_1fr]">
                <div className="flex flex-col gap-6">
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Resumen del periodo</p>
                    <div className="flex flex-col gap-2">
                      <StatCard
                        label="Conversaciones"
                        value={data.conversations.conversations}
                        iconBg="bg-accent-soft"
                        iconText="text-accent"
                        icon={Calendar}
                        sub="Clientes que escribieron cada día, sumados día por día (como las cuenta Meta). WhatsApp, Instagram y Messenger"
                      />
                      <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface/50 p-2 text-[11px] text-greige-ink">
                        <SumRow label="Total gerencial" value={data.conversations.managerTotal} strong />
                        <p className="text-[10px] leading-tight text-muted-foreground">Anuncios + difusión + Instagram + Messenger (sin orgánico de WhatsApp), como lo arma el trafficker.</p>
                        <SumRow label="Clientes distintos" value={data.conversations.people} />
                        <SumRow label="• Nuevos" value={data.conversations.newPeople} />
                        <SumRow label="• Recurrentes" value={data.conversations.returning} />
                        <p className="mt-1 border-t border-line/60 pt-1 font-medium uppercase tracking-wide">Por canal</p>
                        <SumRow label="WhatsApp" value={data.conversations.byChannel.whatsapp} />
                        <SumRow label="Instagram" value={data.conversations.byChannel.instagram} />
                        <SumRow label="Messenger" value={data.conversations.byChannel.messenger} />
                        <p className="mt-1 border-t border-line/60 pt-1 font-medium uppercase tracking-wide">Por origen</p>
                        <SumRow label="Anuncios Meta" value={data.conversations.byOrigin.ads} purple />
                        <SumRow label="Respuesta a difusión" value={data.conversations.byOrigin.broadcast} />
                        <SumRow label="Orgánico de WhatsApp" value={data.conversations.byOrigin.organic} />
                        <SumRow label="Instagram y Messenger" value={data.conversations.byOrigin.social} />
                        <p className="mt-1 border-t border-line/60 pt-1 font-medium uppercase tracking-wide">Cierre</p>
                        <SumRow label="Ventas confirmadas" value={data.conversations.sales ?? '—'} strong />
                        <SumRow label="Valor vendido" value={data.conversations.salesAmount ? `Q ${Math.round(data.conversations.salesAmount).toLocaleString('es-GT')}` : '—'} />
                        <SumRow label="Tasa de cierre" value={pctText(data.conversations.closeRate)} />
                        <SumRow label="ROAS" value={costs?.conversionCost?.spend > 0 ? ((data.conversations.salesAmount * (adv?.fxQtoCop ?? 420)) / costs.conversionCost.spend).toFixed(2) : '…'} />
                        <p className="text-[10px] leading-tight text-muted-foreground">Valor vendido en COP ÷ inversión de pauta.</p>
                        <p className="text-[10px] leading-tight text-muted-foreground">Ventas del reporte de ventas (suma de las asesoras de la línea elegida) ÷ total gerencial.</p>
                      </div>
                      <StatCard
                        label="No leídos"
                        value={data.buckets.filter((b) => b.bucket !== 'pendiente').reduce((sum, b) => sum + b.unreadTotal, 0)}
                        iconBg="bg-warning/10"
                        iconText="text-warning"
                        icon={Mail}
                      />
                      <StatCard
                        label="No atendidos"
                        value={data.buckets.find((b) => b.bucket === 'pendiente')?.total ?? 0}
                        iconBg={metaFor('pendiente').iconBg}
                        iconText={metaFor('pendiente').iconText}
                        icon={metaFor('pendiente').icon}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-6">
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Todos los estados</p>
                    <div className="flex flex-col gap-2">
                      {data.buckets.map((b) => {
                        const meta = metaFor(b.bucket);
                        return (
                          <StatCard key={b.bucket} label={meta.label} value={b.total} iconBg={meta.iconBg} iconText={meta.iconText} icon={meta.icon}
                            sub={`${b.unreadTotal} no leído(s)`} unit={b.unreadTotal > 0 ? `· ${b.unreadTotal} no leídos` : undefined} />
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Demora en primera respuesta</p>
                    <StatCard
                      label="promedio en el periodo"
                      value={formatMinutes(data.avgFirstResponseMinutes)}
                      iconBg={PIPELINE_COLOR_CLASSES.warning.iconBg}
                      iconText={PIPELINE_COLOR_CLASSES.warning.iconText}
                      icon={PIPELINE_ICON_MAP.Clock}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-6">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-greige-ink">Costo de conversión</p>
                    {costs?.conversionCost?.nameFilter && <p className="mt-0.5 text-[11px] text-muted-foreground">Pauta: campañas que contienen “{costs.conversionCost.nameFilter}”, igual que el Informe de anuncios.</p>}
                    <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">Dos formas de medirlo: lo que Meta cuenta como "resultado" (conversaciones iniciadas) y lo que el CRM confirma como venta real. No tienen por qué coincidir.</p>
                    {costs?.conversionCost && (
                      <div className="flex flex-col gap-3">
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-greige-ink">Costo por resultado — igual a Meta Ads</p>
                          <div className="flex flex-wrap gap-2">
                            <StatCard
                              label="gasto en pauta"
                              value={formatMoney(costs?.conversionCost.spend, costs?.conversionCost.currency)}
                              iconBg={PIPELINE_COLOR_CLASSES.danger.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.danger.iconText}
                              icon={PIPELINE_ICON_MAP.CircleDollarSign}
                            />
                            <StatCard
                              label="conversaciones"
                              value={costs?.conversionCost.results}
                              iconBg={PIPELINE_COLOR_CLASSES.info.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.info.iconText}
                              icon={PIPELINE_ICON_MAP.MessageSquareWarning}
                            />
                            <StatCard
                              label="por resultado"
                              value={costs?.conversionCost.costPerResult != null ? formatMoney(costs?.conversionCost.costPerResult, costs?.conversionCost.currency) : 'Sin conversaciones'}
                              iconBg={PIPELINE_COLOR_CLASSES.warning.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.warning.iconText}
                              icon={PIPELINE_ICON_MAP.CircleDollarSign}
                            />
                          </div>
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-greige-ink">Costo por venta — confirmada en el CRM</p>
                          <div className="flex flex-wrap gap-2">
                            <StatCard
                              label="pagados de pauta"
                              value={costs?.conversionCost.conversions}
                              iconBg={PIPELINE_COLOR_CLASSES.success.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.success.iconText}
                              icon={PIPELINE_ICON_MAP.CheckCircle2}
                            />
                            <StatCard
                              label="por venta"
                              value={costs?.conversionCost.costPerConversion != null ? formatMoney(costs?.conversionCost.costPerConversion, costs?.conversionCost.currency) : 'Sin ventas'}
                              iconBg={PIPELINE_COLOR_CLASSES.info.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.info.iconText}
                              icon={PIPELINE_ICON_MAP.CircleDollarSign}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    {costs?.conversionCostError && (
                      <p className="text-xs text-danger">No se pudo leer Meta Ads: {costs?.conversionCostError}</p>
                    )}
                    {!costs && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
                    {costs && !costs.conversionCost && !costs.conversionCostError && (
                      <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-greige-ink">Costo por mensaje</p>
                    {data.costsAreAccountWide && <p className="mt-0.5 text-[11px] text-warning">Facturación de toda la cuenta de WhatsApp: no se separa por línea.</p>}
                    <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">Lo que WhatsApp cobra por cada mensaje enviado — facturación de la plataforma, no gasto en pauta. No tiene por qué coincidir con "Costo de conversión".</p>
                    {costs?.messageCost && (
                      <>
                        <div className="flex flex-wrap gap-2">
                          <StatCard
                            label="gasto acumulado"
                            value={formatMoney(costs?.messageCost.totalCost, costs?.messageCost.currency)}
                            iconBg={PIPELINE_COLOR_CLASSES.danger.iconBg}
                            iconText={PIPELINE_COLOR_CLASSES.danger.iconText}
                            icon={PIPELINE_ICON_MAP.CircleDollarSign}
                          />
                          <StatCard
                            label="mensajes cobrados"
                            value={costs?.messageCost.billableVolume}
                            iconBg={PIPELINE_COLOR_CLASSES.warning.iconBg}
                            iconText={PIPELINE_COLOR_CLASSES.warning.iconText}
                            icon={PIPELINE_ICON_MAP.MessageSquareWarning}
                          />
                          <StatCard
                            label="promedio por mensaje"
                            value={costs?.messageCost.avgCostPerMessage != null ? formatMoney(costs?.messageCost.avgCostPerMessage, costs?.messageCost.currency) : 'Sin mensajes cobrados'}
                            iconBg={PIPELINE_COLOR_CLASSES.info.iconBg}
                            iconText={PIPELINE_COLOR_CLASSES.info.iconText}
                            icon={PIPELINE_ICON_MAP.CircleDollarSign}
                          />
                        </div>
                        {costs?.messageCost.byCategory.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {costs?.messageCost.byCategory.map((c) => (
                              <span key={c.category} className="rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] text-greige-ink">
                                {PRICING_CATEGORY_LABELS[c.category] ?? c.category}: {c.volume} · {c.cost > 0 ? `${formatMoney(c.costPerMessage, costs?.messageCost.currency)}/msg` : 'gratis'}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {costs?.messageCostError && (
                      <p className="text-xs text-danger">No se pudo leer WhatsApp: {costs?.messageCostError}</p>
                    )}
                    {!costs && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
                    {costs && !costs.messageCost && !costs.messageCostError && (
                      <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  {days.length > 1 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Conversaciones por día</p>
                      <div style={{ position: 'relative', height: 230 }}>
                        <canvas ref={dayRef} role="img" aria-label="Conversaciones por día, por origen" />
                      </div>
                    </div>
                  )}
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Conversaciones por hora del día</p>
                    <div style={{ position: 'relative', height: days.length > 1 ? 200 : 380 }}>
                      <canvas ref={hourRef} role="img" aria-label="Conversaciones de clientes por hora del día" />
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-greige-ink">Atención y ventas por asesora</p>
                    {role !== 'asesor' && <button type="button" onClick={() => downloadExcel({ data, adv, dateFrom, dateTo, line })} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-muted"><Download size={13} />Descargar Excel</button>}
                  </div>
                  <AdvisorTable adv={adv} />
                </div>
                {data.dailyConversations?.length > 1 && (
                  <div className="lg:col-span-4">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Conversaciones por día</p>
                    <DailyTable rows={data.dailyConversations} />
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
