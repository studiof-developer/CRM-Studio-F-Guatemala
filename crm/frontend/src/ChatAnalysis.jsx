import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Loader2, Download, MessageSquare } from 'lucide-react';
import { fetchChatAnalysis, fetchChatAnalysisDetail } from './api.js';
import Select from './components/Select.jsx';
import { showError } from './components/Toast.jsx';

// Análisis de chats (administración y supervisión): clasifica los chats ya guardados en los casos que se revisan a diario.
// La clasificación vive en el servidor (chatAnalysis.js); aquí solo se elige el período y se navega el resultado.
const CATS = [
  { id: 'col', label: 'Pauta · Nueva colección', tag: 'bg-purple/10 text-purple' },
  { id: 'desc', label: 'Pauta · % de descuento', tag: 'bg-warn/10 text-warn' },
  { id: 'guia', label: 'Preguntan por guía', tag: 'bg-cyan/10 text-cyan' },
  { id: 'cambio', label: 'Cambio de talla o prenda', tag: 'bg-danger/10 text-danger' },
  { id: 'retomo', label: 'Atendidos ayer, retomaron hoy', tag: 'bg-ok/10 text-ok' },
  { id: 'ref', label: 'Pauta · Referencia puntual', tag: 'bg-accent/10 text-accent' },
];
const SHORT = { col: 'Nueva colección', desc: '% descuento', guia: 'Guía', cambio: 'Cambio', retomo: 'Retomó hoy', ref: 'Referencia' };
const TAG_BY_ID = Object.fromEntries(CATS.map((c) => [c.id, c.tag]));

const GT_MS = 6 * 3600000;
const gtShift = (d) => new Date(+new Date(d) - GT_MS);
const dayKey = (d) => gtShift(d).toISOString().slice(0, 10);
const hhmm = (d) => gtShift(d).toISOString().slice(11, 16);
const niceDate = (d) => `${dayKey(d)} ${hhmm(d)}`;
const toInput = (d) => gtShift(d).toISOString().slice(0, 16); // valor de <input type="datetime-local"> en hora de Guatemala
const fromInput = (s) => new Date(`${s}:00-06:00`);

const PRESETS = [
  { value: 'ayer9', label: 'Ayer 9 pm → ahora' },
  { value: 'hoy', label: 'Hoy desde las 12 am' },
  { value: 'ayer', label: 'Todo el día de ayer' },
  { value: '3dias', label: 'Últimas 72 horas' },
  { value: 'custom', label: 'Personalizado' },
];
function presetRange(key) {
  const now = new Date();
  const today = dayKey(now), yday = dayKey(new Date(+now - 86400000));
  const at = (day, h) => new Date(`${day}T${h}:00-06:00`);
  if (key === 'hoy') return [at(today, '00:00'), now];
  if (key === 'ayer') return [at(yday, '00:00'), at(today, '00:00')];
  if (key === '3dias') return [new Date(+now - 72 * 3600000), now];
  return [at(yday, '21:00'), now];
}

const subKeysOf = (it, cat) => (cat === 'desc' ? it.pcts.map((p) => `${p}%`) : [...it.adIds.map((i) => `Anuncio ${i}`), ...it.refCodes]);

export default function ChatAnalysis({ onOpenConversation }) {
  const [preset, setPreset] = useState('ayer9');
  const [range, setRange] = useState(() => presetRange('ayer9'));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [cat, setCat] = useState('all');
  const [sub, setSub] = useState('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const run = useCallback(async (from, to) => {
    setLoading(true); setSelected(null); setDetail(null); setCat('all'); setSub('all');
    try { setData(await fetchChatAnalysis(from.toISOString(), to.toISOString())); }
    catch (err) { showError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { run(range[0], range[1]); /* solo al abrir: después se analiza con el botón */ // eslint-disable-line react-hooks/exhaustive-deps
  }, []);

  function changePreset(v) {
    setPreset(v);
    if (v !== 'custom') setRange(presetRange(v));
  }
  const setEdge = (i, value) => { if (!value) return; setPreset('custom'); setRange((r) => (i === 0 ? [fromInput(value), r[1]] : [r[0], fromInput(value)])); };

  const items = data?.items ?? [];
  const counts = useMemo(() => Object.fromEntries(CATS.map((c) => [c.id, items.filter((it) => it.cats.includes(c.id)).length])), [items]);
  const subs = useMemo(() => {
    if (cat !== 'desc' && cat !== 'ref') return [];
    const m = {};
    items.filter((it) => it.cats.includes(cat)).forEach((it) => subKeysOf(it, cat).forEach((k) => { m[k] = (m[k] ?? 0) + 1; }));
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [items, cat]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => (cat === 'all' || it.cats.includes(cat))
      && (sub === 'all' || subKeysOf(it, cat).includes(sub))
      && (!needle || `${it.phone} ${it.name ?? ''} ${it.lastText}`.toLowerCase().includes(needle)));
  }, [items, cat, sub, q]);

  async function openChat(phone) {
    setSelected(phone); setDetail(null); setDetailLoading(true);
    try { setDetail(await fetchChatAnalysisDetail(phone, data.window.from, data.window.to)); }
    catch (err) { showError(err.message); }
    finally { setDetailLoading(false); }
  }

  function downloadCsv() {
    const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['telefono', 'nombre', 'nuevo', 'por_pauta', 'categorias', 'id_anuncio', 'referencias', 'porcentajes', 'copy_del_anuncio', 'mensajes_en_periodo', 'ultimo_mensaje'];
    const rows = list.map((it) => [it.phone, it.name, it.isNew ? 'si' : 'no', it.viaAd ? 'si' : 'no', it.cats.map((c) => SHORT[c]).join(' | '), it.adIds.join(' | '), it.refCodes.join(' | '), it.pcts.join(' | '), it.adCopy, it.msgsInWindow, niceDate(it.lastAt)].map(quote).join(','));
    const url = URL.createObjectURL(new Blob([`﻿${head.join(',')}\n${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `analisis_chats_${dayKey(data.window.from)}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  const input = 'rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent';
  return (
    <div className="mx-auto max-w-[1500px] px-4 pb-10 pt-8 md:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Análisis</h1>
          <p className="mt-1 text-sm text-greige-ink">Clasifica los chats ya guardados: pautas, guías, cambios y clientes que retoman. Solo lectura.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-56"><Select value={preset} onChange={changePreset} options={PRESETS} /></div>
          <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-greige">Desde<input type="datetime-local" className={input} value={toInput(range[0])} onChange={(e) => setEdge(0, e.target.value)} /></label>
          <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-greige">Hasta<input type="datetime-local" className={input} value={toInput(range[1])} onChange={(e) => setEdge(1, e.target.value)} /></label>
          <button type="button" onClick={() => run(range[0], range[1])} disabled={loading} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Analizar
          </button>
        </div>
      </div>
      <p className="mb-4 text-xs text-greige">Hora de Guatemala. Máximo 7 días por consulta.{data && ` · ${items.length} chats con mensajes en el período.`}</p>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <button type="button" onClick={() => { setCat('all'); setSub('all'); }} aria-pressed={cat === 'all'} className={`rounded-2xl border p-4 text-left transition ${cat === 'all' ? 'border-accent bg-accent text-white' : 'border-line bg-paper hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'}`}>
          <div className="text-2xl font-bold">{items.length}</div><div className="text-xs font-semibold opacity-80">Todos los chats</div>
        </button>
        {CATS.map((c) => (
          <button key={c.id} type="button" onClick={() => { setCat(c.id); setSub('all'); }} aria-pressed={cat === c.id} className={`rounded-2xl border p-4 text-left transition ${cat === c.id ? 'border-accent bg-accent text-white' : 'border-line bg-paper hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'}`}>
            <div className="text-2xl font-bold">{counts[c.id]}</div><div className="text-xs font-semibold opacity-80">{c.label}</div>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className="flex max-h-[75vh] min-h-[320px] flex-col overflow-hidden rounded-2xl border border-line bg-paper">
          <div className="grid gap-2 border-b border-line p-3">
            <input className={`${input} w-full`} type="search" placeholder="Buscar por número, nombre o texto…" value={q} onChange={(e) => setQ(e.target.value)} />
            {subs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {[['all', 'Todos', null], ...subs.map(([k, n]) => [k, k, n])].map(([k, label, n]) => (
                  <button key={k} type="button" aria-pressed={sub === k} onClick={() => setSub(k)} className={`rounded-full border px-3 py-0.5 text-xs font-semibold ${sub === k ? 'border-accent bg-accent text-white' : 'border-line text-greige-ink hover:bg-black/[0.04]'}`}>{label}{n != null && ` · ${n}`}</button>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between text-xs text-greige">
              <span>{list.length} de {items.length} chats</span>
              <button type="button" onClick={downloadCsv} disabled={!list.length} className="inline-flex items-center gap-1 font-semibold text-accent hover:underline disabled:opacity-50"><Download className="h-3.5 w-3.5" /> Lista en CSV</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && <p className="p-6 text-center text-sm text-greige">Analizando chats…</p>}
            {!loading && !list.length && <p className="p-6 text-center text-sm text-greige">Ningún chat coincide.</p>}
            {list.map((it) => (
              <button key={it.phone} type="button" onClick={() => openChat(it.phone)} aria-current={selected === it.phone} className={`block w-full border-b border-line px-4 py-3 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04] ${selected === it.phone ? 'bg-accent/10 shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`}>
                <div className="flex justify-between gap-2 text-sm font-semibold text-ink"><span className="truncate">{it.name ?? 'Sin nombre'} · {it.phone}</span><span className="shrink-0 text-xs font-normal text-greige">{hhmm(it.lastAt)}</span></div>
                <div className="mt-0.5 truncate text-[13px] text-greige-ink">{it.lastRole === 'customer' ? '' : '↪ '}{it.lastText || '(adjunto)'}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {it.cats.map((c) => <span key={c} className={`rounded-full px-2 py-px text-[11px] font-bold ${TAG_BY_ID[c]}`}>{SHORT[c]}</span>)}
                  {it.isNew && <span className="rounded-full bg-black/[0.06] px-2 py-px text-[11px] font-bold text-greige-ink dark:bg-white/[0.1]">Nuevo</span>}
                  {it.viaAd && <span className="rounded-full bg-black/[0.06] px-2 py-px text-[11px] font-bold text-greige-ink dark:bg-white/[0.1]">Pauta</span>}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0">
          {!selected && <div className="grid min-h-[320px] place-content-center rounded-2xl border border-dashed border-line p-8 text-center text-sm text-greige">Elige un chat de la lista para ver la ficha del cliente, de dónde llegó y la conversación.</div>}
          {selected && detailLoading && <div className="grid min-h-[320px] place-content-center rounded-2xl border border-line bg-paper p-8 text-sm text-greige"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>}
          {detail && !detailLoading && <ChatDetail detail={detail} windowFrom={data.window.from} onOpenConversation={onOpenConversation} />}
        </div>
      </div>
    </div>
  );
}

const HIDDEN_FIELDS = new Set(['id', 'whatsapp_number']);
const fmtField = (k, v) => (/_at$/.test(k) && typeof v === 'string' ? niceDate(v) : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v));

function ChatDetail({ detail, windowFrom, onOpenConversation }) {
  const { customer: cu, analysis: a } = detail;
  const fields = Object.entries(cu ?? {}).filter(([k, v]) => !HIDDEN_FIELDS.has(k) && v !== null && v !== '');
  const ref = detail.firstReferral;
  const lastLine = [...detail.messages].reverse().find((m) => m.line)?.line;
  let lastDay = '', marked = false;
  return (
    <div className="grid gap-4">
      <div className="rounded-2xl border border-line bg-paper p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-ink">{cu?.full_name ?? 'Sin nombre'}</h2>
            <p className="text-sm text-greige-ink">{detail.phone} · primer mensaje: {detail.firstMessageAt ? niceDate(detail.firstMessageAt) : '—'} · {detail.totalMessagesEver ?? '?'} mensajes en total</p>
            <div className="mt-2 flex flex-wrap gap-1">{a.cats.map((c) => <span key={c} className={`rounded-full px-2 py-px text-[11px] font-bold ${TAG_BY_ID[c]}`}>{SHORT[c]}</span>)}</div>
          </div>
          {onOpenConversation && <button type="button" onClick={() => onOpenConversation(detail.phone, lastLine)} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"><MessageSquare className="h-4 w-4" /> Abrir en Conversaciones</button>}
        </div>
        {fields.length > 0 && (
          <dl className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-5 gap-y-3">
            {fields.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wide text-greige">{k.replace(/_/g, ' ')}</dt><dd className="break-words text-sm text-ink">{fmtField(k, v)}</dd></div>)}
          </dl>
        )}
      </div>

      {(ref || a.refCodes.length > 0 || a.pcts.length > 0) && (
        <div className="rounded-2xl border border-line bg-paper p-5">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-greige">Origen{ref ? ' · anuncio de Meta' : ''}</p>
          {ref ? (
            <dl className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-5 gap-y-3">
              {Object.entries(ref).filter(([, v]) => v).map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wide text-greige">{k.replace(/_/g, ' ')}</dt><dd className="break-words text-sm text-ink">{typeof v === 'object' ? JSON.stringify(v) : fmtField(k, v)}</dd></div>)}
            </dl>
          ) : <p className="text-sm text-greige-ink">Sin dato de anuncio de Meta; por el texto del primer mensaje parece una promoción ({[...a.pcts.map((p) => `${p}%`), ...a.refCodes].join(', ')}).</p>}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-line bg-paper p-5">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-greige">Tickets</p>
          {detail.tickets.length ? detail.tickets.map((t) => <p key={t.id} className="border-b border-line py-1.5 text-sm text-ink last:border-0">#{t.id} · {t.status} · {t.assigned_advisor ?? 'sin asesora'} · {niceDate(t.created_at)}</p>) : <p className="text-sm text-greige">Sin tickets.</p>}
        </div>
        <div className="rounded-2xl border border-line bg-paper p-5">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-greige">Ventas</p>
          {detail.sales.length ? detail.sales.map((s, i) => <p key={i} className="border-b border-line py-1.5 text-sm text-ink last:border-0">Q{Number(s.amount).toFixed(2)} · {s.status} · {s.advisor_name ?? '—'} · {niceDate(s.created_at)}</p>) : <p className="text-sm text-greige">Sin ventas registradas.</p>}
        </div>
      </div>

      <div className="grid gap-1.5 rounded-2xl border border-line bg-paper p-5">
        {detail.messages.map((m) => {
          const day = dayKey(m.at), parts = [];
          if (m.inWindow && !marked) { marked = true; parts.push(<div key={`w${m.id}`} className="mt-2 text-center text-xs font-bold text-accent">▼ Desde aquí: período analizado ({niceDate(windowFrom)})</div>); }
          if (day !== lastDay) { lastDay = day; parts.push(<div key={`d${m.id}`} className="mt-2 text-center text-xs font-bold text-greige">{day}</div>); }
          const mine = m.role !== 'customer';
          parts.push(
            <div key={m.id} className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${mine ? 'ml-auto bg-accent/15 text-ink' : 'bg-black/[0.05] text-ink dark:bg-white/[0.07]'} ${m.inWindow ? '' : 'opacity-60'}`}>
              {m.text || (m.attachments.length ? '' : '(sin texto)')}
              {m.attachments.map((at, i) => <span key={i} className="mt-1 block rounded-lg bg-paper px-2 py-1 text-xs font-semibold">📎 {at.kind}{at.amount != null && ` · monto leído Q${Number(at.amount).toFixed(2)}`}{at.text && ` · “${String(at.text).slice(0, 140)}”`}</span>)}
              {m.referral && <span className="mt-1 block rounded-lg bg-warn/10 px-2 py-1 text-xs"><b>Llegó por anuncio</b> {[m.referral.headline, m.referral.body].filter(Boolean).join(' — ')}{m.referral.source_id && ` · ID ${m.referral.source_id}`}</span>}
              {m.campaignId && <span className="mt-1 block rounded-lg bg-paper px-2 py-1 text-xs font-semibold">Difusión #{m.campaignId}</span>}
              <span className="mt-0.5 block text-[11px] text-greige-ink">{m.role === 'customer' ? 'Cliente' : m.role === 'advisor' ? (m.advisor ?? 'Asesora') : 'Bot'} · {hhmm(m.at)}{m.line ? ` · línea ${m.line}` : ''}</span>
            </div>
          );
          return parts;
        })}
      </div>
    </div>
  );
}
