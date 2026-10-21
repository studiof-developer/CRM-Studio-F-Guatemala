import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, MessageSquare, Eye, Check, Ban, Copy, Play, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchSalesDayReview, markSalesDayItem, explainSalesChat, startSalesHistory, fetchSalesHistory } from '../api.js';
import { showError, showSuccess } from './Toast.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

const fmtQ = (n) => (n == null ? 'sin monto' : `Q${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2 })}`);
const fmtTime = (d) => new Date(d).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit', hour12: false });
const last4 = (p) => String(p ?? '').slice(-4);
const addDays = (day, n) => new Date(+new Date(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ISSUE = {
  sin_medios_de_pago_en_chat: 'sin medios de pago en el chat', monto_no_leido: 'monto no leído', monto_por_validar: 'monto por validar', varias_asesoras: 'varias asesoras',
  asesora_por_validar: 'asesora por validar', sin_prueba_del_cliente: 'sin prueba del cliente', precio_sin_aprobacion_del_cliente: 'precio sin aprobar', varias_cotizaciones: 'varias cotizaciones',
  monto_distinto_a_cotizacion: 'monto distinto a lo cotizado', sin_asesora: 'sin asesora',
};
const CRM = { ok: 'ya está igual en el CRM', sin_venta: 'falta en el CRM (se agrega)', asesor_distinto: 'CRM tiene otra asesora', monto_distinto: 'CRM tiene otro monto', fecha_distinta: 'CRM la tiene en otra fecha', confirmacion_pendiente: 'CRM la tiene por revisar' };

// Revisión de un día, venta por venta: el motor lista lo que leyó de los chats, la persona abre cada chat, lo marca como correcto o incorrecto
// y, cuando todo está correcto, aplica ese día. Lo incorrecto no se corrige aquí: se copia con su nota para ajustar el motor.
export default function SalesDayReviewModal({ open, onClose, onOpenConversation, onChanged }) {
  const [day, setDay] = useState('2026-10-14');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [marks, setMarks] = useState({});
  const [explain, setExplain] = useState({});
  const [confirmApply, setConfirmApply] = useState(false);
  const [applying, setApplying] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async (d) => {
    setLoading(true); setData(null); setExplain({});
    try { const r = await fetchSalesDayReview(d); setData(r); setMarks(r.marks ?? {}); }
    catch (err) { showError(err.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const groups = useMemo(() => (data ? [['paid', data.paid], ['orphans', data.orphans], ['deletes', data.deletes]] : []), [data]);
  const all = useMemo(() => groups.flatMap(([, rows]) => rows), [groups]);
  const reviewed = all.filter((r) => marks[r.key]).length;
  const bad = all.filter((r) => marks[r.key]?.verdict === 'mal');
  const ready = data && all.length > 0 && reviewed === all.length && bad.length === 0;

  async function mark(item, verdict, note = marks[item.key]?.note ?? '') {
    const prev = marks[item.key];
    const next = verdict === null ? undefined : { verdict, note };
    setMarks((m) => { const c = { ...m }; if (next) c[item.key] = next; else delete c[item.key]; return c; });
    try { await markSalesDayItem({ day, itemKey: item.key, verdict, note }); }
    catch (err) { showError(err.message); setMarks((m) => { const c = { ...m }; if (prev) c[item.key] = prev; else delete c[item.key]; return c; }); }
  }

  async function showEngine(item) {
    setExplain((e) => ({ ...e, [item.key]: { loading: true } }));
    try { const r = await explainSalesChat(String(item.phone).replace(/\D/g, ''), day); setExplain((e) => ({ ...e, [item.key]: { lines: r.lines } })); }
    catch (err) { showError(err.message); setExplain((e) => ({ ...e, [item.key]: undefined })); }
  }

  function copyBad() {
    const text = [`Revisión del ${day}: ventas marcadas como incorrectas`, ...bad.map((r) => `· ${fmtTime(r.at)} ${r.customer} (…${last4(r.phone)}) ${fmtQ(r.amount)}${r.advisor ? ` · ${r.advisor}` : ''}: ${marks[r.key]?.note || '(sin nota)'}`)].join('\n');
    navigator.clipboard.writeText(text).then(() => showSuccess('Observaciones copiadas'), () => showError('No se pudo copiar'));
  }

  async function applyDay() {
    setApplying(true); setConfirmApply(false);
    try {
      await startSalesHistory({ mode: 'apply', from: day, to: day, force: !!data?.completed });
      const poll = async () => {
        const s = await fetchSalesHistory(0);
        if (s.job?.running) { timer.current = setTimeout(poll, 2500); return; }
        setApplying(false);
        if (s.job?.error) showError(`Se cortó: ${s.job.error}`);
        else { showSuccess(`Día ${day} reconstruido`); onChanged?.(); load(day); }
      };
      timer.current = setTimeout(poll, 2500);
    } catch (err) { showError(err.message); setApplying(false); }
  }

  if (!open) return null;
  const btn = 'flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-ink hover:bg-muted disabled:opacity-50';

  // Funciones (no componentes) para que escribir una nota no remonte el campo en cada render.
  const actions = (item) => {
    const m = marks[item.key];
    return (
      <div className="flex flex-wrap items-center gap-1">
        {item.phone && <button type="button" className={btn} onClick={() => onOpenConversation?.(item.phone, item.line)} disabled={!onOpenConversation}><MessageSquare size={11} />Chat</button>}
        {item.phone && <button type="button" className={btn} onClick={() => showEngine(item)}><Eye size={11} />Motor</button>}
        <button type="button" onClick={() => mark(item, m?.verdict === 'ok' ? null : 'ok')} title="Correcto" className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold ${m?.verdict === 'ok' ? 'border-success bg-success text-white' : 'border-line text-ink hover:bg-muted'}`}><Check size={11} />Correcto</button>
        <button type="button" onClick={() => mark(item, m?.verdict === 'mal' ? null : 'mal')} title="Incorrecto" className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold ${m?.verdict === 'mal' ? 'border-danger bg-danger text-white' : 'border-line text-ink hover:bg-muted'}`}><Ban size={11} />Incorrecto</button>
      </div>
    );
  };

  const extra = (item) => (
    <>
      {marks[item.key]?.verdict === 'mal' && (
        <input
          defaultValue={marks[item.key]?.note ?? ''} onBlur={(e) => mark(item, 'mal', e.target.value)} placeholder="¿Qué está mal? (ej. la vendió Leydi, el monto es Q349)"
          className="mt-1.5 w-full rounded-lg border border-danger/40 bg-paper px-2 py-1 text-[11px] text-ink outline-none focus:border-danger"
        />
      )}
      {explain[item.key]?.loading && <p className="mt-1.5 text-[11px] text-greige-ink">Leyendo el chat…</p>}
      {explain[item.key]?.lines && (
        <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-secondary p-2 font-mono text-[10.5px] leading-relaxed text-ink">{explain[item.key].lines.join('\n')}</pre>
      )}
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="relative flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-line bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div>
            <h3 className="text-base font-bold text-ink">Revisar un día, venta por venta</h3>
            <p className="mt-0.5 text-xs text-greige-ink">El motor lista lo que leyó de los chats de ese día. Abre cada chat, mira cómo fue y márcalo. Cuando todo esté correcto, aplica el día.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-greige-ink hover:bg-muted hover:text-ink" title="Cerrar"><X size={20} /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3 text-xs text-greige-ink">
          <button type="button" onClick={() => { const d = addDays(day, -1); setDay(d); load(d); }} disabled={loading || applying} className={btn} title="Día anterior"><ChevronLeft size={12} /></button>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1 text-ink" />
          <button type="button" onClick={() => { const d = addDays(day, 1); setDay(d); load(d); }} disabled={loading || applying} className={btn} title="Día siguiente"><ChevronRight size={12} /></button>
          <button type="button" onClick={() => load(day)} disabled={loading || applying || !day} className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {loading ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}<span>{loading ? 'Leyendo los chats…' : 'Cargar el día'}</span>
          </button>
          {data && <span className="font-semibold text-ink">{reviewed} de {all.length} revisadas{data.completed ? ' · día ya reconstruido' : ''}</span>}
          {data && all.length > 0 && <div className="h-1.5 w-32 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-success transition-all" style={{ width: `${Math.round((reviewed / all.length) * 100)}%` }} /></div>}
        </div>

        <div className="min-h-[240px] flex-1 space-y-6 overflow-auto px-5 py-4 text-xs">
          {!data && !loading && <p className="py-16 text-center text-sm text-greige-ink">Elige un día y pulsa "Cargar el día". La primera vez puede tardar, porque lee las fotos de los comprobantes.</p>}
          {loading && <p className="py-16 text-center text-sm text-greige-ink">Leyendo los chats de ese día… puede tardar un par de minutos.</p>}
          {data && (
            <>
              <section>
                <h4 className="mb-2 text-sm font-bold text-ink">Ventas que leyó el motor ({data.paid.length}) · {fmtQ(data.paid.reduce((s, r) => s + (Number(r.amount) || 0), 0))}</h4>
                {!data.paid.length && <p className="text-greige-ink">El motor no encontró ventas ese día.</p>}
                <div className="divide-y divide-line-soft rounded-xl border border-line">
                  {data.paid.map((r) => (
                    <div key={r.key} className="p-3">
                      <div className="grid gap-2 md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_auto] md:items-start">
                        <div>
                          <p className="font-semibold text-ink">{fmtTime(r.at)} · {r.customer} <span className="font-normal text-greige-ink">(…{last4(r.phone)})</span></p>
                          <p className="text-greige-ink">{r.type === 'comprobante' ? 'Comprobante' : 'Confirmación de la asesora'}{r.via ? ` (${r.via})` : ''}{r.medium ? ` · ${r.medium}` : ''}{r.type === 'comprobante' && !r.verified ? ' · la asesora no confirmó' : ''}</p>
                          {r.issues.length > 0 && <p className="text-warning">{r.issues.map((i) => ISSUE[i] ?? i).join(' · ')}</p>}
                        </div>
                        <div>
                          <p className="font-bold text-success">{fmtQ(r.amount)}</p>
                          <p className="text-ink">{r.advisor ?? 'Sin asesora'}{r.attributionUncertain ? ' (por validar)' : ''}</p>
                          <p className="text-[11px] text-greige-ink">{CRM[r.status] ?? r.status}{r.recordedAdvisor && r.status !== 'ok' ? ` (${r.recordedAdvisor}${r.recordedAmount != null ? `, ${fmtQ(r.recordedAmount)}` : ''})` : ''}</p>
                        </div>
                        {actions(r)}
                      </div>
                      {extra(r)}
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h4 className="mb-1 text-sm font-bold text-ink">Pruebas que el motor NO cuenta ({data.orphans.length})</h4>
                <p className="mb-2 text-greige-ink">El cliente mandó un comprobante pero no hay medios de pago de la asesora en las 24 h anteriores. Si alguna es una venta real, márcala como incorrecta.</p>
                {!data.orphans.length ? <p className="text-greige-ink">Ninguna.</p> : (
                  <div className="divide-y divide-line-soft rounded-xl border border-line">
                    {data.orphans.map((r) => (
                      <div key={r.key} className="p-3">
                        <div className="grid gap-2 md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_auto] md:items-center">
                          <p className="font-semibold text-ink">{fmtTime(r.at)} · {r.customer} <span className="font-normal text-greige-ink">(…{last4(r.phone)})</span></p>
                          <p className="text-ink">{fmtQ(r.amount)} · no cuenta</p>
                          {actions(r)}
                        </div>
                        {extra(r)}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h4 className="mb-1 text-sm font-bold text-ink">Ventas del CRM que se borrarían ({data.deletes.length})</h4>
                <p className="mb-2 text-greige-ink">Están registradas pero el chat no tiene comprobante, confirmación ni medios de pago que las respalde. Si alguna sí fue una compra, márcala como incorrecta.</p>
                {!data.deletes.length ? <p className="text-greige-ink">Ninguna.</p> : (
                  <div className="divide-y divide-line-soft rounded-xl border border-line">
                    {data.deletes.map((r) => (
                      <div key={r.key} className="p-3">
                        <div className="grid gap-2 md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_auto] md:items-center">
                          <p className="font-semibold text-ink">{fmtTime(r.at)} · {r.customer} <span className="font-normal text-greige-ink">(…{last4(r.phone)})</span></p>
                          <p className="text-ink">{fmtQ(r.amount)} · {r.advisor}{r.duplicateOf ? ` · duplicada de la venta ${fmtQ(r.duplicateOf.amount)} de ${r.duplicateOf.advisor}` : ''}</p>
                          {actions(r)}
                        </div>
                        {extra(r)}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {data && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-xs">
            <span className="text-greige-ink">{bad.length > 0 ? `${bad.length} marcada(s) como incorrecta(s): copia las observaciones y pásamelas para ajustar el motor.` : ready ? 'Todo revisado y correcto.' : 'Marca todas las filas como correctas para poder aplicar el día.'}</span>
            <div className="flex items-center gap-2">
              {bad.length > 0 && <button type="button" onClick={copyBad} className={btn}><Copy size={12} />Copiar observaciones</button>}
              <button type="button" onClick={() => setConfirmApply(true)} disabled={!ready || applying} className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-1.5 font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {applying ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}<span>{applying ? 'Aplicando…' : 'Aplicar este día'}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmApply}
        title={`¿Aplicar el ${day}?`}
        message={`Las ventas de ese día quedan como las listó el motor y se borran las que no tienen respaldo. Se guarda una copia para deshacer desde "Reconstruir ventas de días pasados".`}
        confirmLabel="Aplicar"
        danger
        onConfirm={applyDay}
        onCancel={() => setConfirmApply(false)}
      />
    </div>
  );
}
