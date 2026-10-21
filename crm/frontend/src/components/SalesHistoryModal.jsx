import { useCallback, useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Play, Eye, Undo2 } from 'lucide-react';
import { fetchSalesHistory, startSalesHistory, restoreSalesHistory, explainSalesChat } from '../api.js';
import { showError, showSuccess } from './Toast.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

const fmtDate = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });

// Reconstruye las ventas de días pasados leyendo los chats: lo registrado en cada día se reemplaza por lo que dicen los chats.
// Corre en el servidor (se puede cerrar la ventana); si se corta, al iniciar de nuevo retoma en el primer día que falte.
export default function SalesHistoryModal({ open, onClose, onChanged }) {
  const [from, setFrom] = useState('2026-10-01');
  const [to, setTo] = useState('2026-10-19');
  const [state, setState] = useState(null);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [undo, setUndo] = useState(null);
  const [chatPhone, setChatPhone] = useState('');
  const [chatDay, setChatDay] = useState('2026-10-15');
  const [chatLines, setChatLines] = useState(null);
  const seen = useRef(0);
  const jobId = useRef(null);
  const logRef = useRef(null);
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchSalesHistory(seen.current);
      if (s.job && s.job.id !== jobId.current) { jobId.current = s.job.id; seen.current = 0; setLines([]); return refresh(); }
      if (s.job?.lines.length) { seen.current = s.job.total; setLines((prev) => [...prev, ...s.job.lines]); }
      setState(s);
      if (wasRunning.current && s.job && !s.job.running) onChanged?.();
      wasRunning.current = !!s.job?.running;
    } catch (err) { showError(err.message); }
    return null;
  }, [onChanged]);

  useEffect(() => {
    if (!open) return undefined;
    seen.current = 0; jobId.current = null; setLines([]);
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [open, refresh]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [lines]);

  async function start(mode) {
    setBusy(true);
    try { await startSalesHistory({ mode, from, to }); seen.current = 0; await refresh(); }
    catch (err) { showError(err.message); } finally { setBusy(false); setConfirmApply(false); }
  }

  async function explain() {
    setBusy(true);
    try { setChatLines((await explainSalesChat(chatPhone, chatDay)).lines); }
    catch (err) { showError(err.message); } finally { setBusy(false); }
  }

  async function restore() {
    setBusy(true);
    try {
      const r = await restoreSalesHistory(undo);
      showSuccess(`Listo: ${r.restored} ventas devueltas, ${r.reinserted} que se habían borrado vuelven, ${r.deleted} insertadas se quitan y ${r.daysReopened} días quedan pendientes.`);
      onChanged?.(); await refresh();
    } catch (err) { showError(err.message); } finally { setBusy(false); setUndo(null); }
  }

  if (!open) return null;
  const job = state?.job;
  const running = !!job?.running;
  const done = state?.days ?? [];
  const inputCls = 'rounded-lg border border-line bg-paper px-2 py-1 text-ink';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="relative flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-line bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div>
            <h3 className="text-base font-bold text-ink">Reconstruir ventas de días pasados</h3>
            <p className="mt-0.5 text-xs text-greige-ink">
              Lee los chats día por día y deja las ventas como dicen los chats: comprobante, link o medios de pago, y quién vendió. Lo ya registrado en esos días se reemplaza y las ventas sin respaldo en el chat se borran (las que un supervisor validó no se tocan). Antes de aplicar se guarda una copia para poder deshacer.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-greige-ink hover:bg-muted hover:text-ink" title="Cerrar"><X size={20} /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3 text-xs text-greige-ink">
          <label className="flex items-center gap-1">Desde <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} disabled={running} className={inputCls} /></label>
          <label className="flex items-center gap-1">Hasta <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} disabled={running} className={inputCls} /></label>
          <button type="button" onClick={() => start('preview')} disabled={busy || running || !from || !to} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 font-semibold text-ink hover:bg-muted disabled:opacity-50">
            <Eye size={13} /><span>1. Revisar (no cambia nada)</span>
          </button>
          <button type="button" onClick={() => setConfirmApply(true)} disabled={busy || running || !from || !to} className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {running && job?.mode === 'apply' ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}<span>2. Aplicar</span>
          </button>
          {running && <span className="flex items-center gap-1.5 font-semibold text-warning"><RefreshCw size={12} className="animate-spin" />{job.mode === 'apply' ? 'Aplicando' : 'Revisando'} {job.from} → {job.to}… puedes cerrar esta ventana, sigue en el servidor.</span>}
        </div>

        <div className="border-b border-line px-5 py-2 text-xs text-greige-ink">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">Ver cómo lee el motor un chat:</span>
            <input value={chatPhone} onChange={(e) => setChatPhone(e.target.value)} placeholder="Últimos dígitos (ej. 7107)" className={`${inputCls} w-44`} />
            <input type="date" value={chatDay} onChange={(e) => setChatDay(e.target.value)} className={inputCls} />
            <button type="button" onClick={explain} disabled={busy || chatPhone.replace(/\D/g, '').length < 4 || !chatDay} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1 font-semibold text-ink hover:bg-muted disabled:opacity-50">
              <Eye size={12} /><span>Ver</span>
            </button>
            {chatLines && <button type="button" onClick={() => setChatLines(null)} className="font-semibold text-greige-ink hover:text-ink">Cerrar</button>}
          </div>
          {chatLines && <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-secondary p-3 font-mono text-[11px] leading-relaxed text-ink">{chatLines.join('\n')}</pre>}
        </div>

        {job?.error && !running &&<p className="border-b border-line bg-danger/10 px-5 py-2 text-xs text-danger">Se cortó: {job.error}. Los días ya terminados quedan guardados; vuelve a pulsar Aplicar para retomar.</p>}
        {job && !running && !job.error && <p className="border-b border-line bg-success/10 px-5 py-2 text-xs text-success">{job.mode === 'apply' ? `Terminado${job.backup ? ` · copia: ${job.backup}` : ''}.` : 'Revisión lista: no se cambió nada. Compara unos días con las libretas y, si cuadra, pulsa Aplicar.'}</p>}

        <div className="grid min-h-0 flex-1 gap-4 overflow-auto p-5 md:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <pre ref={logRef} className="h-[50vh] overflow-auto whitespace-pre rounded-xl border border-line bg-secondary p-3 font-mono text-[11px] leading-relaxed text-ink">
            {lines.length ? lines.join('\n') : 'Pulsa "Revisar" para ver, día por día, lo registrado contra lo que dicen los chats.'}
          </pre>
          <div className="space-y-4 text-xs">
            <div>
              <p className="mb-1 font-semibold text-ink">Días ya reconstruidos ({done.length})</p>
              {done.length ? (
                <ul className="max-h-40 space-y-0.5 overflow-auto">
                  {done.map((d) => <li key={d.day} className="flex justify-between rounded-lg bg-secondary px-2 py-1"><span className="font-semibold text-ink">{d.day}</span><span className="text-greige-ink">{fmtDate(d.completedAt)}</span></li>)}
                </ul>
              ) : <p className="text-greige-ink">Ninguno todavía.</p>}
            </div>
            <div>
              <p className="mb-1 font-semibold text-ink">Copias para deshacer</p>
              {state?.backups?.length ? (
                <ul className="space-y-1">
                  {state.backups.map((b) => (
                    <li key={b.name} className="rounded-lg bg-secondary px-2 py-1.5">
                      <p className="text-ink">{b.from} → {b.to}</p>
                      <p className="break-all text-[10px] text-greige-ink">{b.name}</p>
                      <button type="button" onClick={() => setUndo(b.name)} disabled={busy || running} className="mt-1 flex items-center gap-1 font-semibold text-danger hover:underline disabled:opacity-50"><Undo2 size={12} />Deshacer</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-greige-ink">Aún no hay copias.</p>}
              <p className="mt-1 text-[10px] text-greige-ink">Si hay varias, deshaz primero la más nueva.</p>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmApply}
        title="¿Reconstruir estas ventas?"
        message={`Se reemplazarán las ventas del ${from} al ${to} por lo que dicen los chats y se borrarán las que no tengan respaldo. Se guarda una copia para deshacer. Puede tardar un buen rato; si se corta, retoma donde quedó.`}
        confirmLabel="Aplicar"
        danger
        busy={busy}
        onConfirm={() => start('apply')}
        onCancel={() => setConfirmApply(false)}
      />
      <ConfirmDialog
        open={!!undo}
        title="¿Deshacer esta corrida?"
        message={`Las ventas vuelven a como estaban antes de la copia ${undo}: se devuelven las borradas, se quitan las que insertó la corrida y esos días quedan pendientes de reconstruir.`}
        confirmLabel="Deshacer"
        danger
        busy={busy}
        onConfirm={restore}
        onCancel={() => setUndo(null)}
      />
    </div>
  );
}
