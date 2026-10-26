import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { RefreshCw, Copy, Download, TrendingDown, TrendingUp, ArrowUpDown, Radio } from 'lucide-react';
import { fetchMetaAdsReport } from './api.js';
import { guatemalaToday, addDays } from './lib/pipelinePeriod.js';
import { rateCpr, rateConv, CPR_LABEL, CONV_LABEL, longDay, executiveReading, DEFAULT_THRESHOLDS } from './lib/metaAdsRating.js';
import { showError, showSuccess } from './components/Toast.jsx';
import { AdThumb, AdViewer } from './components/AdCreative.jsx';

// Informe de anuncios de Meta (admin y supervisión): el mismo informe ejecutivo que el traficker le entrega al gerente, pero con los
// datos en vivo de Meta. Se vuelve a pedir solo cada 5 minutos; Meta suele reflejar el gasto del día con unos minutos de retraso.
// Los montos van en la moneda de la cuenta de anuncios (hoy pesos colombianos).
const PRESETS = [
  { key: 'hoy', label: 'Hoy' },
  { key: 'ayer', label: 'Ayer' },
  { key: '7d', label: 'Últimos 7 días' },
  { key: 'mes', label: 'Este mes' },
  { key: 'mesant', label: 'Mes anterior' },
  { key: 'custom', label: 'Personalizado' },
];
const LEVELS = [{ key: 'campaign', label: 'Campañas' }, { key: 'adset', label: 'Conjuntos' }, { key: 'ad', label: 'Anuncios' }];
const STATUS = { ACTIVE: ['Activa', true], PAUSED: ['Desactivada', false], CAMPAIGN_PAUSED: ['Campaña desactivada', false], ADSET_PAUSED: ['Conjunto desactivado', false] };
const METRICS = [
  ['conversations', 'Conversaciones', (d) => d.conversations, 'count'], ['spend', 'Inversión', (d) => d.spend, 'money'], ['cpr', 'Costo por conversación', (d) => d.costPerConversation, 'money'],
  ['conversion', 'Conversión clic → mensaje', (d) => d.conversionPct, 'pct'], ['clicks', 'Clics en el enlace', (d) => d.linkClicks, 'count'],
];
const REFRESH_MS = 5 * 60 * 1000;
const PILL = { good: 'bg-success/10 text-success', regular: 'bg-warning/15 text-warning', bad: 'bg-danger/10 text-danger' };

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
const headline = (key, r, today) => (key === 'hoy' ? `Hoy ${longDay(today)} amanecimos así`
  : key === 'ayer' ? `Ayer ${longDay(r.since)} cerró así`
    : r.since === r.until ? `${longDay(r.since)}:` : `Del ${longDay(r.since)} al ${longDay(r.until)}:`);
const rangeTitle = (r) => (r.since === r.until ? longDay(r.since) : r.since.slice(0, 7) === r.until.slice(0, 7) ? `${Number(r.since.slice(8))} al ${longDay(r.until)}` : `${longDay(r.since)} al ${longDay(r.until)}`);
const shortDay = (d) => `${Number(d.slice(8))} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(d.slice(5, 7)) - 1]}`;

const Rating = ({ kind, rate }) => (rate ? <span className={`ml-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${PILL[rate]}`}>{(kind === 'cpr' ? CPR_LABEL : CONV_LABEL)[rate]}</span> : null);

// Barras por día con selector de métrica, como en el informe del traficker.
function Evolution({ daily, money, pct }) {
  const [metric, setMetric] = useState('conversations');
  const [, , get, kind] = METRICS.find((m) => m[0] === metric);
  const fmt = (v) => (v == null ? '—' : kind === 'money' ? money(v) : kind === 'pct' ? pct(v) : Math.round(v).toLocaleString('de-DE'));
  const vals = daily.map(get);
  const max = Math.max(...vals.filter((v) => v != null), 0) || 1;
  const dense = daily.length > 12;
  return (
    <div className="rounded-2xl border border-line bg-paper p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Evolución diaria</h3>
        <select value={metric} onChange={(e) => setMetric(e.target.value)} className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-ink">
          {METRICS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      {daily.length < 2 ? <p className="py-16 text-center text-sm text-greige-ink">Elige un rango de dos o más días para ver la evolución.</p> : (
        <div className="flex h-56 items-end gap-2 border-b border-line px-1 pt-3" role="img" aria-label="Evolución diaria">
          {daily.map((d, i) => (
            <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5" title={`${shortDay(d.date)}: ${fmt(vals[i])}`}>
              {!dense && <span className="text-[11px] font-bold tabular-nums text-ink">{fmt(vals[i])}</span>}
              <div className="w-3/5 max-w-[90px] rounded-t-lg bg-gradient-to-b from-sky-400 to-blue-600 transition-[height]" style={{ height: `${vals[i] == null ? 4 : Math.max(4, (vals[i] / max) * 78)}%` }} />
              <span className="mb-1.5 truncate text-[10px] font-semibold text-greige-ink">{dense ? Number(d.date.slice(8)) : shortDay(d.date)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, delta, rating }) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-4 shadow-sm">
      <p className="text-xs text-greige-ink">{label}</p>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-2xl font-extrabold tracking-tight text-ink tabular-nums">{value}{delta}</p>
      <div className="mt-1 text-[11px] text-greige-ink">{rating}{sub}</div>
    </div>
  );
}

function Th({ k, sort, onSort, children, right = true }) {
  return (
    <th className={`cursor-pointer select-none whitespace-nowrap px-3 py-2.5 ${right ? 'text-right' : ''}`} onClick={() => onSort(k)}>
      <span className="inline-flex items-center gap-1">{children}<ArrowUpDown size={10} className={sort.key === k ? 'text-accent' : 'opacity-30'} /></span>
    </th>
  );
}

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
  const [live, setLive] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [sort, setSort] = useState({ key: 'conversations', desc: true });
  const [day, setDay] = useState('all');
  const [shown, setShown] = useState(60);
  const [viewer, setViewer] = useState(null);
  // Filtro "el nombre de la campaña contiene…": sin tocarlo manda el del servidor ("mensajes"); lo que cada quien escribe se recuerda en su navegador.
  const [nameFilter, setNameFilter] = useState(() => { try { return localStorage.getItem('metaAdsNameFilter') ?? undefined; } catch { return undefined; } });
  const [nameDraft, setNameDraft] = useState(null);
  const applyName = () => {
    if (nameDraft === null) return;
    const v = nameDraft.trim();
    setNameFilter(v); setNameDraft(null);
    try { localStorage.setItem('metaAdsNameFilter', v); } catch { /* sin almacenamiento: vale solo esta sesión */ }
  };

  const range = useMemo(() => rangeOf(preset, today, custom), [preset, today, custom]);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!range?.since || !range?.until || range.since > range.until) return;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const r = await fetchMetaAdsReport({ ...range, level, name: nameFilter });
      setData(r);
      setText([headline(preset, range, today), '', ...r.observations.map((o) => `- ${o}`)].join('\n'));
    } catch (err) { setError(err.message); if (!quiet) setData(null); } finally { setLoading(false); }
  }, [range, level, preset, today, nameFilter]);
  useEffect(() => { setDay('all'); setShown(60); load(); }, [load]);

  // En vivo: se vuelve a pedir cada 5 minutos mientras la pestaña está a la vista y el rango incluye hoy.
  const includesToday = range?.until >= today;
  useEffect(() => {
    if (!live || !includesToday) return undefined;
    const t = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [live, includesToday, load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const currency = data?.currency;
  const th = data?.thresholds ?? DEFAULT_THRESHOLDS;
  const money = useCallback((n) => (n == null ? '—' : (currency === 'COP' ? '$' : `${currency ?? ''} `) + Math.round(n).toLocaleString('de-DE')), [currency]);
  const pct = (n) => (n == null ? '—' : `${n.toFixed(2).replace('.', ',')}%`);
  const count = (n) => Math.round(n ?? 0).toLocaleString('de-DE');

  const onSort = (key) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }));
  const sortVal = (r, k) => ({ name: r.name, spend: r.spend, conversations: r.conversations, costPerConversation: r.costPerConversation, conversionPct: r.conversionPct, linkClicks: r.linkClicks, cpc: r.cpc, ctr: r.ctr })[k];
  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => (!onlySpend || r.spend > 0 || r.conversations > 0) && (!search || `${r.name} ${r.campaign ?? ''} ${r.adset ?? ''}`.toLowerCase().includes(search.toLowerCase())));
    return list.sort((a, b) => {
      const x = sortVal(a, sort.key); const y = sortVal(b, sort.key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * (sort.desc ? -1 : 1);
    });
  }, [data, onlySpend, search, sort]);
  const dayRows = useMemo(() => (data?.dayRows ?? []).filter((r) => day === 'all' || r.date === day), [data, day]);
  const days = useMemo(() => (data?.daily ?? []).map((d) => d.date), [data]);
  const reading = useMemo(() => (data ? executiveReading({ daily: data.daily, rows: data.rows, totals: data.totals, thresholds: th, fmt: money, pct }) : []), [data, th, money]);

  function exportExcel() {
    const head = ['Nombre', 'Campaña', 'Conjunto', 'Estado', 'Gasto', 'Conversaciones', 'Costo por conversación', '% de conversión', 'Clics en el enlace', 'CPC (enlace)', 'CTR (enlace)', 'Impresiones', 'Alcance', 'Frecuencia'];
    const body = rows.map((r) => [r.name, r.campaign ?? '', r.adset ?? '', STATUS[r.status]?.[0] ?? r.status ?? '', r.spend, r.conversations, r.costPerConversation ?? '', r.conversionPct ?? '', r.linkClicks, r.cpc ?? '', r.ctr ?? '', r.impressions, r.reach, r.frequency]);
    const t = data.totals;
    body.push(['TOTAL', '', '', '', t.spend, t.conversations, t.costPerConversation ?? '', t.conversionPct ?? '', t.linkClicks, t.cpc ?? '', t.ctr ?? '', t.impressions, t.reach, '']);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...body]), 'Informe Meta');
    if (data.dayRows?.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Día', 'Nombre', 'Campaña', 'Estado', 'Gasto', 'Conversaciones', 'Costo por conversación', '% de conversión', 'Clics en el enlace', 'CPC (enlace)', 'CTR (enlace)'],
        ...data.dayRows.map((r) => [r.date, r.name, r.campaign ?? '', STATUS[r.status]?.[0] ?? r.status ?? '', r.spend, r.conversations, r.costPerConversation ?? '', r.conversionPct ?? '', r.linkClicks, r.cpc ?? '', r.ctr ?? ''])]), 'Detalle por día');
    }
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
  const ago = data?.fetchedAt ? Math.max(0, Math.round((now - new Date(data.fetchedAt).getTime()) / 60000)) : null;
  const T = data?.totals;
  const prev = data?.previousTotals;
  const activeRows = (data?.rows ?? []).filter((r) => r.spend > 0 || r.conversations > 0).length;
  const levelWord = { campaign: 'campaña', adset: 'conjunto', ad: 'anuncio' }[level];

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
        <button type="button" onClick={() => load()} disabled={loading} title="Actualizar ahora" className="rounded-xl border border-line p-2 text-greige-ink hover:bg-muted hover:text-ink disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
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
          <div className="flex flex-wrap items-end justify-between gap-4 rounded-3xl bg-gradient-to-br from-[#091c38] to-[#0c75cf] px-7 py-6 text-white shadow-md">
            <div className="min-w-0">
              <h2 className="text-2xl font-extrabold tracking-tight">Meta Ads · {rangeTitle(data)}</h2>
              <p className="mt-1 text-sm text-blue-100">Informe ejecutivo de campañas · {data.accountName} · Valores en {data.currency}</p>
            </div>
            <div className="text-right text-xs text-blue-100">
              <button type="button" onClick={() => setLive((v) => !v)} disabled={!includesToday} className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 font-semibold text-white disabled:opacity-60">
                <Radio size={12} className={live && includesToday ? 'text-emerald-300' : 'text-white/60'} />{live && includesToday ? 'En vivo · cada 5 min' : includesToday ? 'En vivo pausado' : 'Período cerrado'}
              </button>
              <p className="mt-1.5">{ago == null ? '' : ago === 0 ? 'Actualizado hace un momento' : `Actualizado hace ${ago} min`}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper px-3 py-2 text-xs">
            <span className="font-semibold text-ink">El nombre de la campaña contiene</span>
            <input value={nameDraft ?? data.nameFilter ?? ''} onChange={(e) => setNameDraft(e.target.value)} onBlur={applyName} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder="(toda la cuenta)" className={`${inputCls} w-44`} />
            {data.nameFilter && data.excluded?.count > 0
              ? <span className="text-warning">Se excluyen {data.excluded.count} campaña{data.excluded.count === 1 ? '' : 's'} con gasto ({money(data.excluded.spend)}): {data.excluded.names.join(', ')}</span>
              : <span className="text-greige-ink">{data.nameFilter ? 'Ninguna campaña con gasto queda fuera.' : 'Sin filtro: se suma toda la cuenta.'}</span>}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Inversión registrada" value={money(T.spend)} delta={change(T.spend, prev.spend, false)} sub={data.days > 1 ? `${money(T.spend / data.days)} por día · ${data.days} días` : 'Un día'} />
            <Kpi label="Conversaciones generadas" value={count(T.conversations)} delta={change(T.conversations, prev.conversations, false)} sub={data.days > 1 ? `${(T.conversations / data.days).toFixed(1).replace('.', ',')} por día` : 'Resultados reportados'} />
            <Kpi label="Costo por conversación" value={money(T.costPerConversation)} delta={change(T.costPerConversation, prev.costPerConversation, true)} rating={<Rating kind="cpr" rate={rateCpr(T.costPerConversation, th)} />} sub={prev.costPerConversation ? ` antes ${money(prev.costPerConversation)}` : ''} />
            <Kpi label="Conversión clic → mensaje" value={pct(T.conversionPct)} delta={change(T.conversionPct, prev.conversionPct, false)} rating={<Rating kind="conv" rate={rateConv(T.conversionPct, th)} />} />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Clics en el enlace" value={count(T.linkClicks)} delta={change(T.linkClicks, prev.linkClicks, false)} />
            <Kpi label="CPC promedio" value={money(T.cpc)} delta={change(T.cpc, prev.cpc, true)} />
            <Kpi label={`${levelWord[0].toUpperCase()}${levelWord.slice(1)}s con datos`} value={activeRows} sub={`de ${data.rows.length} en la cuenta`} />
            <Kpi label="CTR consolidado" value={pct(T.ctr)} delta={change(T.ctr, prev.ctr, false)} sub={T.impressions ? `${count(T.impressions)} impresiones · ${T.ctr >= 2 ? 'sobre la meta de 2% ✅' : 'bajo la meta de 2%'}` : ''} />
          </div>

          <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
            <Evolution daily={data.daily ?? []} money={money} pct={pct} />
            <div className="rounded-2xl border border-line bg-paper p-5 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold text-ink">Lectura ejecutiva</h3>
              {reading.length ? (
                <div className="space-y-2.5">
                  {reading.map((r) => <p key={r.title} className="rounded-r-xl border-l-[3px] border-sky-300 bg-sky-50/60 px-3 py-2 text-sm leading-snug text-ink dark:bg-sky-400/10"><b>{r.title}</b> {r.text}</p>)}
                </div>
              ) : <p className="text-sm text-greige-ink">Sin conversaciones en este período para leer.</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrar por nombre (ej. Rebajas)" className={`${inputCls} w-56`} />
            <label className="flex items-center gap-1.5 text-greige-ink"><input type="checkbox" checked={onlySpend} onChange={(e) => setOnlySpend(e.target.checked)} />Solo con gasto</label>
            <span className="text-greige-ink">Haz clic en un encabezado para ordenar</span>
            <button type="button" onClick={exportExcel} className="ml-auto flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 font-semibold text-ink hover:bg-muted"><Download size={13} />Excel</button>
          </div>

          <div className="rounded-2xl border border-line bg-paper shadow-sm">
            <div className="border-b border-line-soft px-5 py-3.5"><h3 className="text-sm font-semibold text-ink">Rendimiento por {levelWord} · acumulado {data.days} {data.days === 1 ? 'día' : 'días'}</h3></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-xs">
                <thead>
                  <tr className="bg-black/[0.02] text-[11px] uppercase tracking-wide text-greige-ink dark:bg-white/[0.03]">
                    {level === 'ad' && <th className="px-3 py-2.5">Imagen</th>}<Th k="name" sort={sort} onSort={onSort} right={false}>{levelWord}</Th><th className="px-3 py-2.5">Estado</th>
                    <Th k="spend" sort={sort} onSort={onSort}>Inversión</Th><Th k="conversations" sort={sort} onSort={onSort}>Conversaciones</Th><Th k="costPerConversation" sort={sort} onSort={onSort}>Costo / conversación</Th>
                    <Th k="conversionPct" sort={sort} onSort={onSort}>Conversión</Th><Th k="linkClicks" sort={sort} onSort={onSort}>Clics</Th><Th k="cpc" sort={sort} onSort={onSort}>CPC</Th><Th k="ctr" sort={sort} onSort={onSort}>CTR</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} className="border-t border-line-soft align-top hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                      {level === 'ad' && <td className="px-3 py-2.5"><AdThumb adId={r.id} name={r.name} onOpen={() => setViewer(i)} /></td>}
                      <td className="px-3 py-2.5 font-semibold text-ink">{r.name}{level !== 'campaign' && <div className="text-[10px] font-normal text-greige-ink">{[r.campaign, level === 'ad' ? r.adset : null].filter(Boolean).join(' › ')}</div>}</td>
                      <td className="px-3 py-2.5">{r.status && <span className={`whitespace-nowrap text-[11px] font-bold ${STATUS[r.status]?.[1] ? 'text-success' : 'text-greige-ink'}`}>● {STATUS[r.status]?.[0] ?? r.status}</span>}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{money(r.spend)}{T.spend > 0 && <div className="text-[10px] text-greige-ink">{((r.spend / T.spend) * 100).toFixed(0)}% del gasto</div>}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums">{r.conversations || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{money(r.costPerConversation)}<Rating kind="cpr" rate={rateCpr(r.costPerConversation, th)} /></td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{pct(r.conversionPct)}<Rating kind="conv" rate={rateConv(r.conversionPct, th)} /></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{count(r.linkClicks)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{money(r.cpc)}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${r.ctr != null && r.spend > 0 ? (r.ctr >= 2 ? 'text-success' : 'text-warning') : 'text-greige-ink'}`}>{pct(r.ctr)}</td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={level === 'ad' ? 10 : 9} className="px-3 py-8 text-center text-greige-ink">Sin resultados en este período.</td></tr>}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line bg-black/[0.03] font-bold text-ink dark:bg-white/[0.04]">
                    <td className="px-3 py-2.5" colSpan={level === 'ad' ? 3 : 2}>Total ({rows.length})</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{money(T.spend)}</td><td className="px-3 py-2.5 text-right tabular-nums">{count(T.conversations)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{money(T.costPerConversation)}</td><td className="px-3 py-2.5 text-right tabular-nums">{pct(T.conversionPct)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{count(T.linkClicks)}</td><td className="px-3 py-2.5 text-right tabular-nums">{money(T.cpc)}</td><td className="px-3 py-2.5 text-right tabular-nums">{pct(T.ctr)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {data.dayRows?.length > 0 && (
            <div className="rounded-2xl border border-line bg-paper shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-5 py-3.5">
                <h3 className="text-sm font-semibold text-ink">Detalle por día</h3>
                {days.length <= 8 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {[['all', 'Todos'], ...days.map((d) => [d, shortDay(d)])].map(([k, label]) => (
                      <button key={k} type="button" onClick={() => { setDay(k); setShown(60); }} className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${day === k ? 'border-accent bg-accent text-white' : 'border-line text-greige-ink hover:text-ink'}`}>{label}</button>
                    ))}
                  </div>
                ) : (
                  <select value={day} onChange={(e) => { setDay(e.target.value); setShown(60); }} className={inputCls}><option value="all">Todos los días</option>{days.map((d) => <option key={d} value={d}>{shortDay(d)}</option>)}</select>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-left text-xs">
                  <thead><tr className="bg-black/[0.02] text-[11px] uppercase tracking-wide text-greige-ink dark:bg-white/[0.03]">
                    <th className="px-3 py-2.5">Día</th><th className="px-3 py-2.5">{levelWord}</th><th className="px-3 py-2.5">Entrega</th>
                    <th className="px-3 py-2.5 text-right">Inversión</th><th className="px-3 py-2.5 text-right">Conversaciones</th><th className="px-3 py-2.5 text-right">Costo / conversación</th>
                    <th className="px-3 py-2.5 text-right">Conv. clic → mensaje</th><th className="px-3 py-2.5 text-right">Clics</th><th className="px-3 py-2.5 text-right">CPC</th><th className="px-3 py-2.5 text-right">CTR</th>
                  </tr></thead>
                  <tbody>
                    {dayRows.slice(0, shown).map((r) => (
                      <tr key={`${r.date}-${r.id}`} className="border-t border-line-soft hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{shortDay(r.date)}</td>
                        <td className="px-3 py-2.5 font-semibold text-ink">{r.name}</td>
                        <td className="px-3 py-2.5">{r.status && <span className={`whitespace-nowrap text-[11px] font-bold ${STATUS[r.status]?.[1] ? 'text-success' : 'text-greige-ink'}`}>● {STATUS[r.status]?.[0] ?? r.status}</span>}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(r.spend)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{count(r.conversations)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(r.costPerConversation)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{pct(r.conversionPct)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{count(r.linkClicks)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(r.cpc)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{pct(r.ctr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {dayRows.length > shown && <button type="button" onClick={() => setShown((n) => n + 100)} className="w-full border-t border-line-soft py-2.5 text-xs font-semibold text-accent hover:underline">Ver más ({dayRows.length - shown} filas)</button>}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-greige-ink">
            Fuente: Meta Ads, cuenta {data.accountName}, en vivo (se actualiza cada 5 minutos; Meta puede tardar unos minutos en reflejar el gasto del día). Los totales suman todas las filas del nivel, aunque filtres la lista. Las conversaciones registradas con inversión {money(0)} se cuentan en volumen, pero no tienen costo individual atribuible ese día.
            Costo por conversación: bueno ≤ {money(th.cprGood)}, regular hasta {money(th.cprRegular)}, malo &gt; {money(th.cprRegular)}. Conversión clic → mensaje: buena &gt; {th.convGood}%, regular &gt; {th.convRegular}%. CTR en verde: 2% o más. El CTR consolidado se calcula con las impresiones totales (no se promedian los CTR de cada fila).
          </p>

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
      {viewer != null && rows[viewer] && <AdViewer ads={rows} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
