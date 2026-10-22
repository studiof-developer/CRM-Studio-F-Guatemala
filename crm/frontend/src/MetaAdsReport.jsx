import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { RefreshCw, Copy, Download, TrendingDown, TrendingUp } from 'lucide-react';
import { fetchMetaAdsReport } from './api.js';
import { guatemalaToday, addDays } from './lib/pipelinePeriod.js';
import { showError, showSuccess } from './components/Toast.jsx';

// Informe de anuncios de Meta (solo admin): lo mismo que se arma a mano con capturas del Administrador de anuncios, más el texto del
// reporte diario ("amanecimos así…") listo para copiar. Los montos van en la moneda de la cuenta de anuncios (hoy pesos colombianos).
const PRESETS = [
  { key: 'hoy', label: 'Hoy' },
  { key: 'ayer', label: 'Ayer' },
  { key: '7d', label: 'Últimos 7 días' },
  { key: 'mes', label: 'Este mes' },
  { key: 'mesant', label: 'Mes anterior' },
  { key: 'custom', label: 'Personalizado' },
];
const LEVELS = [{ key: 'campaign', label: 'Campañas' }, { key: 'adset', label: 'Conjuntos' }, { key: 'ad', label: 'Anuncios' }];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const STATUS = { ACTIVE: ['Activa', 'bg-success/10 text-success'], PAUSED: ['Desactivada', 'bg-secondary text-greige-ink'], CAMPAIGN_PAUSED: ['Campaña desactivada', 'bg-secondary text-greige-ink'], ADSET_PAUSED: ['Conjunto desactivado', 'bg-secondary text-greige-ink'] };

function rangeOf(key, today, custom) {
  if (key === 'hoy') return { since: today, until: today };
  if (key === 'ayer') return { since: addDays(today, -1), until: addDays(today, -1) };
  if (key === '7d') return { since: addDays(today, -6), until: today };
  if (key === 'mes') return { since: `${today.slice(0, 8)}01`, until: today };
  if (key === 'mesant') {
    const first = `${today.slice(0, 8)}01`; const until = addDays(first, -1);
    return { since: `${until.slice(0, 8)}01`, until };
  }
  return custom;
}
const dayLabel = (d) => `${Number(d.slice(8))} de ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const headline = (key, r, today) => (key === 'hoy' ? `Hoy ${dayLabel(today)} amanecimos así`
  : key === 'ayer' ? `Ayer ${dayLabel(r.since)} cerró así`
    : r.since === r.until ? `${dayLabel(r.since)}:` : `Del ${dayLabel(r.since)} al ${dayLabel(r.until)}:`);

export default function MetaAdsReport() {
  const today = guatemalaToday();
  const [preset, setPreset] = useState('hoy');
  const [custom, setCustom] = useState({ since: addDays(today, -6), until: today });
  const [level, setLevel] = useState('campaign');
  const [onlySpend, setOnlySpend] = useState(true);
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');

  const range = useMemo(() => rangeOf(preset, today, custom), [preset, today, custom]);

  const load = useCallback(async () => {
    if (!range?.since || !range?.until || range.since > range.until) return;
    setLoading(true); setError(null);
    try {
      const r = await fetchMetaAdsReport({ ...range, level });
      setData(r);
      setText([headline(preset, range, today), '', ...r.observations.map((o) => `- ${o}`)].join('\n'));
    } catch (err) { setError(err.message); setData(null); } finally { setLoading(false); }
  }, [range, level, preset, today]);
  useEffect(() => { load(); }, [load]);

  const money = useCallback((n) => (n == null ? '—' : (data?.currency === 'COP' ? '$' : `${data?.currency ?? ''} `) + Math.round(n).toLocaleString('de-DE')), [data?.currency]);
  const pct = (n) => (n == null ? '—' : `${n.toFixed(2).replace('.', ',')}%`);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => (!onlySpend || r.spend > 0)
    && (!search || `${r.name} ${r.campaign ?? ''} ${r.adset ?? ''}`.toLowerCase().includes(search.toLowerCase()))), [data, onlySpend, search]);

  function exportExcel() {
    const head = ['Nombre', 'Campaña', 'Conjunto', 'Estado', 'Gasto', 'Conversaciones', 'Costo por conversación', '% de conversión', 'Clics en el enlace', 'CPC (enlace)', 'CTR (enlace)', 'Impresiones', 'Alcance', 'Frecuencia'];
    const body = rows.map((r) => [r.name, r.campaign ?? '', r.adset ?? '', STATUS[r.status]?.[0] ?? r.status ?? '', r.spend, r.conversations, r.costPerConversation ?? '', r.conversionPct ?? '', r.linkClicks, r.cpc ?? '', r.ctr ?? '', r.impressions, r.reach, r.frequency]);
    const t = data.totals;
    body.push(['TOTAL', '', '', '', t.spend, t.conversations, t.costPerConversation ?? '', t.conversionPct ?? '', t.linkClicks, t.cpc ?? '', t.ctr ?? '', t.impressions, t.reach, '']);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...body]), 'Informe Meta');
    XLSX.writeFile(wb, `informe_meta_${data.since}_${data.until}.xlsx`);
  }

  const change = (cur, prev, lowerIsBetter) => {
    if (cur == null || !prev) return null;
    const d = ((cur - prev) / prev) * 100;
    if (Math.abs(d) < 0.5) return null;
    const good = lowerIsBetter ? d < 0 : d > 0;
    const Icon = d < 0 ? TrendingDown : TrendingUp;
    return <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${good ? 'text-success' : 'text-danger'}`}><Icon size={11} />{Math.abs(d).toFixed(0)}%</span>;
  };
  const inputCls = 'rounded-lg border border-line bg-paper px-2 py-1 text-xs text-ink';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-xl border border-line bg-black/[0.03] p-1 dark:bg-white/[0.05]">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => setPreset(p.key)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${preset === p.key ? 'bg-paper text-ink shadow-sm' : 'text-greige-ink hover:text-ink'}`}>{p.label}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <>
            <input type="date" value={custom.since} max={custom.until} onChange={(e) => setCustom((c) => ({ ...c, since: e.target.value }))} className={inputCls} />
            <input type="date" value={custom.until} min={custom.since} max={today} onChange={(e) => setCustom((c) => ({ ...c, until: e.target.value }))} className={inputCls} />
          </>
        )}
        <button type="button" onClick={load} disabled={loading} title="Actualizar" className="rounded-xl border border-line p-2 text-greige-ink hover:bg-muted hover:text-ink disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
        <div className="ml-auto inline-flex rounded-xl border border-line bg-black/[0.03] p-1 dark:bg-white/[0.05]">
          {LEVELS.map((l) => (
            <button key={l.key} type="button" onClick={() => setLevel(l.key)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${level === l.key ? 'bg-paper text-ink shadow-sm' : 'text-greige-ink hover:text-ink'}`}>{l.label}</button>
          ))}
        </div>
      </div>

      {error && <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs font-medium text-danger">{error}</p>}
      {loading && !data && <p className="py-12 text-center text-sm text-greige-ink">Consultando a Meta…</p>}

      {data && (
        <>
          <p className="text-xs text-greige-ink">
            Cuenta <strong className="text-ink">{data.accountName}</strong> · moneda {data.currency} · del {dayLabel(data.since)} al {dayLabel(data.until)} ({data.days} {data.days === 1 ? 'día' : 'días'}) · comparado con {dayLabel(data.previousRange.since)}{data.previousRange.since !== data.previousRange.until ? ` – ${dayLabel(data.previousRange.until)}` : ''}
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ['Gasto', money(data.totals.spend), change(data.totals.spend, data.previousTotals.spend, false), data.days > 1 ? `${money(data.totals.spend / data.days)} por día` : null],
              ['Conversaciones', data.totals.conversations, change(data.totals.conversations, data.previousTotals.conversations, false), data.days > 1 ? `${(data.totals.conversations / data.days).toFixed(1).replace('.', ',')} por día` : null],
              ['Costo por conversación', money(data.totals.costPerConversation), change(data.totals.costPerConversation, data.previousTotals.costPerConversation, true), null],
              ['% de conversión', pct(data.totals.conversionPct), change(data.totals.conversionPct, data.previousTotals.conversionPct, false), 'conversaciones ÷ clics'],
              ['CTR (enlace)', pct(data.totals.ctr), change(data.totals.ctr, data.previousTotals.ctr, false), null],
            ].map(([label, value, delta, sub]) => (
              <div key={label} className="rounded-xl border border-line p-3">
                <p className="text-[11px] text-greige-ink">{label}</p>
                <p className="mt-1 flex items-baseline gap-2 text-lg font-bold text-ink">{value}{delta}</p>
                {sub && <p className="text-[10px] text-greige-ink">{sub}</p>}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrar por nombre (ej. Rebajas)" className={`${inputCls} w-56`} />
            <label className="flex items-center gap-1.5 text-greige-ink"><input type="checkbox" checked={onlySpend} onChange={(e) => setOnlySpend(e.target.checked)} />Solo con gasto</label>
            <button type="button" onClick={exportExcel} className="ml-auto flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 font-semibold text-ink hover:bg-muted"><Download size={13} />Excel</button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink">
                  <th className="px-3 py-2">{LEVELS.find((l) => l.key === level).label.replace(/s$/, '')}</th><th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2 text-right">Gasto</th><th className="px-3 py-2 text-right">Conversaciones</th><th className="px-3 py-2 text-right">Costo por conv.</th>
                  <th className="px-3 py-2 text-right">% conversión</th><th className="px-3 py-2 text-right">Clics enlace</th><th className="px-3 py-2 text-right">CPC</th><th className="px-3 py-2 text-right">CTR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line-soft align-top">
                    <td className="px-3 py-2 font-semibold text-ink">{r.name}{level !== 'campaign' && <div className="text-[10px] font-normal text-greige-ink">{[r.campaign, level === 'ad' ? r.adset : null].filter(Boolean).join(' › ')}</div>}</td>
                    <td className="px-3 py-2">{r.status && <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${(STATUS[r.status] ?? ['', 'bg-secondary text-greige-ink'])[1]}`}>{(STATUS[r.status] ?? [r.status])[0]}</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.spend)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.conversations || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.costPerConversation)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(r.conversionPct)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.linkClicks}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.cpc)}</td>
                    <td className={`px-3 py-2 text-right font-semibold tabular-nums ${r.ctr != null && r.spend > 0 ? (r.ctr >= 2 ? 'text-success' : 'text-warning') : 'text-greige-ink'}`}>{pct(r.ctr)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-greige-ink">Sin resultados en este período.</td></tr>}
                <tr className="bg-secondary font-bold text-ink">
                  <td className="px-3 py-2" colSpan={2}>Total ({rows.length})</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(data.totals.spend)}</td><td className="px-3 py-2 text-right tabular-nums">{data.totals.conversations}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(data.totals.costPerConversation)}</td><td className="px-3 py-2 text-right tabular-nums">{pct(data.totals.conversionPct)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{data.totals.linkClicks}</td><td className="px-3 py-2 text-right tabular-nums">{money(data.totals.cpc)}</td><td className="px-3 py-2 text-right tabular-nums">{pct(data.totals.ctr)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-greige-ink">CTR en verde: 2% o más. El total de abajo suma todo el nivel, aunque filtres la lista. Conversación con mensaje = lo que Meta cuenta como resultado en las campañas de WhatsApp.</p>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-sm font-semibold text-ink">Reporte para copiar</p>
              <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => showSuccess('Reporte copiado'), () => showError('No se pudo copiar'))} className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Copy size={13} />Copiar</button>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, text.split('\n').length + 1)} className="w-full rounded-xl border border-line bg-paper p-3 text-xs leading-relaxed text-ink outline-none focus:border-accent" />
            <p className="text-[11px] text-greige-ink">Es un borrador con lo que llama la atención: edítalo antes de mandarlo.</p>
          </div>
        </>
      )}
    </div>
  );
}
