import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { X, RefreshCw, Download, Play, ClipboardList } from 'lucide-react';
import { startSalesAnalysis, fetchSalesAnalysis, crossCheckSalesNotebook, downloadSalesChatExport } from '../api.js';
import { guatemalaToday } from '../lib/pipelinePeriod.js';

const ISSUE_LABEL = {
  sin_medios_de_pago_en_chat: 'Sin medios de pago recientes (24 h) en el chat',
  monto_no_leido: 'Monto no leído',
  monto_distinto_a_cotizacion: 'Monto distinto a lo cotizado',
  varias_asesoras: 'Varias asesoras en la venta',
  asesora_por_validar: 'Otra asesora tomó el chat tras los medios de pago (por validar)',
  sin_asesora: 'Sin asesora',
  sin_prueba_del_cliente: 'Sin prueba del cliente en el chat',
  monto_por_validar: 'Monto por validar (precio aprobado)',
  precio_sin_aprobacion_del_cliente: 'Precio sin aprobación explícita del cliente',
  varias_cotizaciones: 'Varias prendas cotizadas y sin comprobante (el total no está en el chat)',
};
const SHIFT_LABEL = { manana: 'Mañana', tarde: 'Tarde', domingo: 'Domingo', fuera_de_turno: 'Fuera de turno' };
const VERDICT = {
  coincide: ['Coincide', 'bg-success/10 text-success'],
  con_diferencias: ['Con diferencias', 'bg-warning/15 text-warning'],
  sin_venta_en_chat: ['Sin venta en el chat', 'bg-danger/10 text-danger'],
  cliente_no_encontrado: ['Cliente no encontrado', 'bg-danger/10 text-danger'],
};
const DIFF_LABEL = { asesora_distinta: 'asesora distinta', monto_distinto: 'monto distinto', medio_distinto: 'medio distinto' };

// Transcripción de los cuadernos a mano (fotos del 14, 15 y 18 de octubre). Es editable: lo que
// no se lee bien en la foto hay que corregirlo aquí antes de contrastar.
const NOTEBOOK_SEED = `# fecha | asesora | últimos 4 dígitos o nombre | medio (link / transferencia) | monto
# Transcrito de las fotos de los cuadernos; corrige lo que no se lea bien.
2026-10-18 | Leydi | 2915 | link |
2026-10-18 | Leydi | Marina Reyes | transferencia |
 | Leydi | Diana Aldana | transferencia |
 | Leydi | 6020 | transferencia |
 | Leydi | Dayana | link |
 | Leydi | 7170 | transferencia |
 | Leydi | 2633 | link |
2026-10-15 | Leydi | 6693 | link |
2026-10-15 | Leydi | Patricia | link |
2026-10-15 | Leydi | 4595 | link |
2026-10-15 | Leydi | Susy | transferencia |
2026-10-14 | Leydi | 1059 | transferencia | 898
2026-10-14 | Leydi | 7107 | transferencia | 349
2026-10-14 | Aura | 4947 | | 1286
2026-10-14 | Aura | 8666 | |
2026-10-14 | Aura | 5352 | | 349
2026-10-14 | Aura | 1882 | |
2026-10-14 | Aura | 5625 | | 750
2026-10-14 | Aura | 0037 | | 974.5
2026-10-14 | Aura | 7851 | | 705
2026-10-14 | Aura | 4291 | | 974`;

function parseNotebook(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [date, advisor, ref, medium, amount] = l.split('|').map((x) => x.trim());
    const n = Number(String(amount ?? '').replace(',', '.'));
    return {
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      advisor: advisor || undefined,
      ref,
      medium: /^(link|transferencia)$/i.test(medium) ? medium.toLowerCase() : undefined,
      amount: Number.isFinite(n) && n > 0 ? n : undefined,
    };
  }).filter((e) => e.ref);
}

const fmtQ = (n) => (n == null ? '—' : `Q ${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2 })}`);
const fmtDate = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });

export default function SalesAnalysisModal({ open, onClose }) {
  const [run, setRun] = useState(null);
  const [tab, setTab] = useState('resumen');
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [advisorFilter, setAdvisorFilter] = useState('');
  const [issueFilter, setIssueFilter] = useState('');
  const [verifiedFilter, setVerifiedFilter] = useState('');
  const [notebookText, setNotebookText] = useState(NOTEBOOK_SEED);
  const [notebook, setNotebook] = useState(null);
  const [checking, setChecking] = useState(false);
  const [exportFrom, setExportFrom] = useState(() => `${guatemalaToday().slice(0, 8)}01`);
  const [exportTo, setExportTo] = useState(() => guatemalaToday());
  const [exporting, setExporting] = useState(false);
  const timer = useRef(null);

  const load = async (id = 'latest') => {
    try {
      const r = await fetchSalesAnalysis(id, { full: true });
      setRun(r);
      return r;
    } catch (err) { setError(err.message); return null; }
  };

  useEffect(() => {
    if (!open) return undefined;
    setError(null);
    load();
    return () => clearTimeout(timer.current);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mientras corre, consulta el avance cada 3 s (sin traer el informe completo).
  useEffect(() => {
    if (!open || run?.status !== 'running' || run.stalled) return undefined;
    timer.current = setTimeout(async () => {
      try {
        const r = await fetchSalesAnalysis(run.id);
        if (r.status === 'running') setRun((prev) => ({ ...prev, ...r }));
        else await load(run.id);
      } catch (err) { setError(err.message); }
    }, 3000);
    return () => clearTimeout(timer.current);
  }, [open, run]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setStarting(true); setError(null);
    try {
      const { id } = await startSalesAnalysis();
      await load(id);
    } catch (err) { setError(err.message); } finally { setStarting(false); }
  }

  async function exportChats() {
    setExporting(true); setError(null);
    try { await downloadSalesChatExport(exportFrom, exportTo); } catch (err) { setError(err.message); } finally { setExporting(false); }
  }

  async function checkNotebook() {
    setChecking(true); setError(null);
    try { setNotebook(await crossCheckSalesNotebook(parseNotebook(notebookText))); }
    catch (err) { setError(err.message); } finally { setChecking(false); }
  }

  const result = run?.status === 'done' ? run.result : null;
  const rows = useMemo(() => (result?.rows ?? []).filter((r) =>
    (!advisorFilter || (r.advisor ?? 'Sin atribuir') === advisorFilter) && (!issueFilter || r.issues.includes(issueFilter))
    && (!verifiedFilter || (verifiedFilter === 'verificadas') === r.verified)
  ), [result, advisorFilter, issueFilter, verifiedFilter]);

  function exportExcel() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Asesora', 'Ventas', 'Total (Q)', 'Sin monto', 'Mañana (Q)', 'Tarde (Q)', 'Domingo (Q)', 'Fuera de turno (Q)', 'Link', 'Transferencia'],
      ...result.byAdvisor.map((a) => [a.advisor, a.ventas, a.total, a.sinMonto, a.porTurno.manana ?? 0, a.porTurno.tarde ?? 0, a.porTurno.domingo ?? 0, a.porTurno.fuera_de_turno ?? 0, a.porMedio.link ?? 0, a.porMedio.transferencia ?? 0]),
    ]), 'Por asesora');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Turno', 'Cliente', 'Teléfono', 'Últimos 4', 'Línea', 'Estado', 'Prueba', 'Base del monto', 'Monto (Q)', 'Cotizado (Q)', 'Asesora', 'Regla', 'Dio medios de pago', 'Confirmó', 'Medio', 'Atendieron', 'Alertas'],
      ...result.rows.map((r) => [fmtDate(r.at), SHIFT_LABEL[r.shift] ?? r.shift, r.customer, r.phone, r.last4, r.line, r.verified ? 'Verificada' : 'Pendiente de confirmar', `${r.type === 'comprobante' ? 'Comprobante' : 'Confirmación'}${r.via ? ` (${r.via})` : ''}${r.voucher ? ' + voucher' : ''}`, r.amountBasis === 'precio_aprobado' ? 'Último precio aprobado por el cliente (por validar)' : (r.amountBasis === 'comprobante' ? `Leído de ${r.via ?? 'comprobante'}` : ''), r.amount ?? '', r.quote ?? '', r.advisor ?? '', r.rule ?? '', r.paymentInfoBy ?? '', r.confirmedBy ?? '', r.medium ?? '', r.touchedBy.join(', '), r.issues.map((i) => ISSUE_LABEL[i] ?? i).join('; ')]),
    ]), 'Ventas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Cliente', 'Teléfono', 'Estado actual'], ...result.withoutEvidence.map((c) => [c.customer, c.phone, c.currentStatus]),
    ]), 'Pagados sin evidencia');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Cliente', 'Teléfono', 'Monto leído (Q)', 'Motivo'], ...(result.orphans ?? []).map((o) => [fmtDate(o.at), o.customer, o.phone, o.amount ?? '', 'Llegó sin medios de pago previos ni confirmación de la asesora']),
    ]), 'Pruebas sin contexto');
    if (result.comparison) {
      const c = result.comparison;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Día', 'Registrado en el CRM (Q)', 'Ventas registradas', 'Según chats verificados (Q)', 'Ventas en chats', 'Diferencia (Q)', 'Por validar (Q)', 'Pendientes de confirmar (Q)', 'Por revisar en el CRM (Q)'],
        ...c.daily.map((d) => [d.day, d.registrado, d.registradoN, d.chat, d.chatN, d.diferencia, d.porValidar, d.pendientes, d.revisar]),
      ]), 'Día por día');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Día', 'Asesora', 'Registrado en el CRM (Q)', 'Ventas registradas', 'Según chats verificados (Q)', 'Ventas en chats', 'Diferencia (Q)', 'Por validar (Q)', 'Pendientes (Q)'],
        ...c.advisorDay.map((d) => [d.day, d.advisor, d.registrado, d.registradoN, d.chat, d.chatN, d.diferencia, d.porValidar, d.pendientes]),
      ]), 'Asesora por día');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Día', 'Resultado', 'Cliente', 'Teléfono', 'Chat: monto (Q)', 'Chat: asesora', 'Chat: base', 'CRM: monto (Q)', 'CRM: asesora', 'CRM: estado', 'Diferencias', 'Cifras cotizadas'],
        ...c.items.map((i) => [i.day, COMPARE_LABEL[i.status] ?? i.status, i.customer, i.phone, i.chatAmount ?? '', i.chatAdvisor ?? '', i.amountBasis === 'precio_aprobado' ? 'Precio aprobado (por validar)' : (i.via ? `Leído de ${i.via}` : ''), i.registeredAmount ?? '', i.registeredAdvisor ?? '', i.registeredStatus ?? '', (i.diffs ?? []).map((d) => DIFF_COMPARE[d] ?? d).join(', '), (i.quotedAmounts ?? []).join(' · ')]),
      ]), 'Comparación');
    }
    XLSX.writeFile(wb, `analisis_chats_vendidos_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  if (!open) return null;
  const running = run?.status === 'running' && !run.stalled;
  const pct = run?.total ? Math.min(100, Math.round((run.progress / run.total) * 100)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="relative flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-line bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div>
            <h3 className="text-base font-bold text-ink">Análisis de chats de clientes que compraron</h3>
            <p className="mt-0.5 text-xs text-greige-ink">
              Recorre el historial de los clientes en Pagado / Por despacho y reconstruye cada venta: comprobante, quién dio los medios de pago, monto y turno, y la compara día por día con lo registrado en el CRM{result?.period ? ` (del ${result.period.from} al ${result.period.to})` : ' (por defecto: mes pasado y este mes)'}. Solo lee; no cambia ventas.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {result && (
              <button type="button" onClick={exportExcel} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-muted">
                <Download size={13} /><span>Excel</span>
              </button>
            )}
            <button type="button" onClick={start} disabled={starting || running} className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {starting || running ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
              <span>{running ? 'Analizando...' : result ? 'Analizar de nuevo' : 'Analizar todos los chats'}</span>
            </button>
            <button type="button" onClick={onClose} className="rounded-xl p-2 text-greige-ink hover:bg-muted hover:text-ink" title="Cerrar"><X size={20} /></button>
          </div>
        </div>

        {error && <p className="border-b border-line bg-danger/10 px-5 py-2 text-xs text-danger">{error}</p>}
        {run?.status === 'error' && <p className="border-b border-line bg-danger/10 px-5 py-2 text-xs text-danger">El análisis falló: {run.error}</p>}
        {run?.stalled && <p className="border-b border-line bg-warning/15 px-5 py-2 text-xs text-warning">El análisis anterior se interrumpió (probablemente por un reinicio del servidor). Vuelve a iniciarlo.</p>}
        {running && (
          <div className="border-b border-line px-5 py-3">
            <div className="mb-1 flex justify-between text-xs text-greige-ink"><span>Analizando chats…</span><span>{run.progress} / {run.total} clientes ({pct}%)</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} /></div>
            <p className="mt-1 text-[11px] text-greige-ink">Puede tardar bastante y usa CPU del servidor: conviene correrlo fuera del horario de las asesoras. Puedes cerrar esta ventana: el análisis sigue en el servidor.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2 text-xs text-greige-ink">
          <span className="font-semibold text-ink">Exportar los chats de Pagado / Por despacho (.txt) para revisarlos a mano:</span>
          <label className="flex items-center gap-1">Desde <input type="date" value={exportFrom} max={exportTo} onChange={(e) => setExportFrom(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1 text-ink" /></label>
          <label className="flex items-center gap-1">Hasta <input type="date" value={exportTo} min={exportFrom} onChange={(e) => setExportTo(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1 text-ink" /></label>
          <button type="button" onClick={exportChats} disabled={exporting || !exportFrom || !exportTo} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1 font-semibold text-ink hover:bg-muted disabled:opacity-50">
            {exporting ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}<span>{exporting ? 'Exportando…' : 'Exportar chats'}</span>
          </button>
        </div>

        <div className="flex gap-1 border-b border-line px-5 py-2 text-xs font-semibold">
          {[['resumen', 'Resumen por asesora'], ['comparar', 'Comparar con el CRM'], ['ventas', 'Ventas reconstruidas'], ['cuaderno', 'Contrastar con cuadernos']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 transition-colors ${tab === k ? 'bg-secondary text-ink' : 'text-greige-ink hover:text-ink'}`}>{label}</button>
          ))}
        </div>

        <div className="min-h-[260px] flex-1 overflow-auto px-5 py-4 text-xs">
          {tab === 'cuaderno' ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div>
                <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink"><ClipboardList size={14} />Anotaciones de los cuadernos (una por línea)</p>
                <textarea value={notebookText} onChange={(e) => setNotebookText(e.target.value)} spellCheck={false} className="h-72 w-full rounded-xl border border-line bg-paper p-3 font-mono text-[11px] text-ink outline-none focus:border-accent" />
                <button type="button" onClick={checkNotebook} disabled={checking} className="mt-2 flex items-center gap-1.5 rounded-xl bg-accent px-4 py-1.5 font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  {checking ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}<span>{checking ? 'Contrastando…' : 'Contrastar con los chats'}</span>
                </button>
              </div>
              <div>
                {!notebook ? <p className="py-10 text-center text-greige-ink">Cada anotación se busca por los últimos 4 dígitos (o el nombre) y se compara con la venta que el chat muestra: asesora, medio y monto.</p> : (
                  <table className="w-full text-left">
                    <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-2 pr-2">Cuaderno</th><th className="py-2 pr-2">Resultado</th><th className="py-2">El chat dice</th></tr></thead>
                    <tbody>
                      {notebook.map((r, i) => (
                        <tr key={i} className="border-b border-line-soft align-top">
                          <td className="py-2 pr-2 text-ink">{r.entry.ref}<div className="text-[10px] text-greige-ink">{[r.entry.date, r.entry.advisor, r.entry.medium, r.entry.amount && fmtQ(r.entry.amount)].filter(Boolean).join(' · ')}</div></td>
                          <td className="py-2 pr-2">
                            <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${(VERDICT[r.verdict] || ['', ''])[1]}`}>{(VERDICT[r.verdict] || [r.verdict])[0]}</span>
                            {r.diffs?.length > 0 && <div className="mt-0.5 text-[10px] text-warning">{r.diffs.map((d) => DIFF_LABEL[d] ?? d).join(', ')}</div>}
                            {r.matches.length > 1 && <div className="mt-0.5 text-[10px] text-greige-ink">{r.matches.length} clientes coinciden</div>}
                          </td>
                          <td className="py-2 text-ink">
                            {r.sale ? (<>{r.sale.advisor ?? 'Sin asesora'} · {fmtQ(r.sale.amount)} · {r.sale.medium ?? 'medio ?'}<div className="text-[10px] text-greige-ink">{fmtDate(r.sale.at)} · {SHIFT_LABEL[r.sale.shift] ?? r.sale.shift}{r.sale.paymentInfoBy ? ` · medios de pago: ${r.sale.paymentInfoBy}` : ''}</div></>)
                              : r.matches[0] ? <span className="text-greige-ink">{r.matches[0].customer} ({r.matches[0].status ?? 'sin estado'})</span> : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : !result ? (
            <p className="py-16 text-center text-sm text-greige-ink">{running ? 'Esperando el resultado…' : 'Aún no hay un análisis. Pulsa "Analizar todos los chats".'}</p>
          ) : tab === 'comparar' ? (
            <CompareView comparison={result.comparison} />
          ) : tab === 'resumen' ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {[['Clientes analizados', result.customersAnalyzed], ['Ventas verificadas por la asesora', result.ventas], ['Total verificado', fmtQ(result.totalQuetzales)], ['Pendientes de confirmar', result.ventasPendientes], ['Pagados sin evidencia en el chat', result.clientesSinEvidencia]].map(([l, v]) => (
                  <div key={l} className="rounded-xl border border-line p-3"><p className="text-[11px] text-greige-ink">{l}</p><p className="mt-1 text-lg font-bold text-ink">{v}</p></div>
                ))}
              </div>
              <table className="w-full text-left">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-2">Asesora</th><th className="py-2 text-right">Ventas</th><th className="py-2 text-right">Total</th><th className="py-2 text-right">Mañana</th><th className="py-2 text-right">Tarde</th><th className="py-2 text-right">Domingo</th><th className="py-2 text-right">Fuera turno</th><th className="py-2 text-right">Link</th><th className="py-2 text-right">Transf.</th><th className="py-2 text-right">Sin monto</th><th className="py-2 text-right">Pend.</th><th className="py-2 text-right">Por validar</th></tr></thead>
                <tbody>
                  {result.byAdvisor.map((a) => (
                    <tr key={a.advisor} className="border-b border-line-soft">
                      <td className="py-2 font-semibold text-ink">{a.advisor}</td><td className="py-2 text-right">{a.ventas}</td><td className="py-2 text-right font-semibold text-success">{fmtQ(a.total)}</td>
                      <td className="py-2 text-right">{fmtQ(a.porTurno.manana ?? 0)}</td><td className="py-2 text-right">{fmtQ(a.porTurno.tarde ?? 0)}</td><td className="py-2 text-right">{fmtQ(a.porTurno.domingo ?? 0)}</td><td className="py-2 text-right">{fmtQ(a.porTurno.fuera_de_turno ?? 0)}</td>
                      <td className="py-2 text-right">{a.porMedio.link ?? 0}</td><td className="py-2 text-right">{a.porMedio.transferencia ?? 0}</td><td className="py-2 text-right">{a.sinMonto || '—'}</td><td className="py-2 text-right text-warning">{a.pendientes || '—'}</td><td className="py-2 text-right text-warning">{a.porValidar ? `${a.porValidar} (${fmtQ(a.porValidarTotal)})` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div>
                <p className="mb-2 font-semibold text-ink">Calidad de los datos (qué no se pudo comprobar en el chat)</p>
                <ul className="grid gap-1.5 md:grid-cols-2">
                  {[['Pruebas pendientes de confirmar por la asesora', result.quality.pendientesDeConfirmar], ['Montos por validar (último precio aprobado, sin monto en el chat)', result.quality.montoPorValidar], ['Precio sin aprobación explícita del cliente', result.quality.precioSinAprobacion], ['Pruebas descartadas: sin medios de pago ni confirmación', result.quality.comprobantesSinContexto], ['Pagos por link sin prueba del cliente', result.quality.sinPruebaDelCliente], ['Ventas sin medios de pago en el chat', result.quality.sinMediosDePagoEnChat], ['Ventas sin monto leído', result.quality.montoNoLeido], ['Monto distinto a lo cotizado', result.quality.montoDistintoACotizacion], ['Ventas con varias asesoras', result.quality.variasAsesoras], ['Ventas sin asesora', result.quality.sinAsesora], ['Imágenes del cliente sin monto leído', result.quality.imagenesSinMonto], ['Comprobantes reenviados (no duplican)', result.comprobantesReenviados]].map(([l, v]) => (
                    <li key={l} className="flex justify-between rounded-lg bg-secondary px-3 py-1.5"><span className="text-greige-ink">{l}</span><strong className="text-ink">{v}</strong></li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-3 flex flex-wrap gap-2">
                <select value={advisorFilter} onChange={(e) => setAdvisorFilter(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1 text-ink">
                  <option value="">Todas las asesoras</option>
                  {result.byAdvisor.map((a) => <option key={a.advisor} value={a.advisor}>{a.advisor}</option>)}
                </select>
                <select value={verifiedFilter} onChange={(e) => setVerifiedFilter(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1 text-ink">
                  <option value="">Verificadas y pendientes</option>
                  <option value="verificadas">Solo verificadas</option>
                  <option value="pendientes">Solo pendientes de confirmar</option>
                </select>
                <select value={issueFilter} onChange={(e) => setIssueFilter(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1 text-ink">
                  <option value="">Todas las alertas</option>
                  {Object.entries(ISSUE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <span className="self-center text-greige-ink">{rows.length} ventas{rows.length > 500 ? ' (se muestran 500; el Excel trae todas)' : ''}</span>
              </div>
              <table className="w-full text-left">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-2 pr-2">Fecha / turno</th><th className="py-2 pr-2">Cliente</th><th className="py-2 pr-2 text-right">Monto</th><th className="py-2 pr-2">Asesora</th><th className="py-2 pr-2">Dio medios de pago</th><th className="py-2">Alertas</th></tr></thead>
                <tbody>
                  {rows.slice(0, 500).map((r, i) => (
                    <tr key={i} className="border-b border-line-soft align-top">
                      <td className="whitespace-nowrap py-2 pr-2 text-ink">{fmtDate(r.at)}<div className="text-[10px] text-greige-ink">{SHIFT_LABEL[r.shift] ?? r.shift}</div></td>
                      <td className="py-2 pr-2 text-ink">{r.customer}<div className="text-[10px] text-greige-ink">…{r.last4} · {r.type === 'comprobante' ? 'comprobante' : 'confirmación'}{r.via ? ` (${r.via})` : ''}{r.voucher ? ' + voucher' : ''}</div>
                        <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.verified ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning'}`}>{r.verified ? `Verificada${r.confirmedBy ? ` · ${r.confirmedBy}` : ''}` : 'Pendiente de confirmar'}</span></td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right font-semibold text-ink">{fmtQ(r.amount)}<div className="text-[10px] font-normal text-greige-ink">{[r.medium, r.amountBasis === 'precio_aprobado' ? 'precio aprobado · por validar' : (r.via ? `leído de ${r.via}` : null)].filter(Boolean).join(' · ')}</div></td>
                      <td className="py-2 pr-2 text-ink">{r.advisor ?? '—'}<div className="text-[10px] text-greige-ink">{(r.rule ?? '').replace(/_/g, ' ')}</div></td>
                      <td className="py-2 pr-2 text-ink">{r.paymentInfoBy ?? '—'}</td>
                      <td className="py-2 text-[10px] text-warning">{r.issues.map((x) => ISSUE_LABEL[x] ?? x).join(' · ')}{r.issues.includes('varias_cotizaciones') && r.quotedAmounts?.length > 1 && <div className="text-greige-ink">Cotizó: {r.quotedAmounts.map((q) => fmtQ(q)).join(' · ')} (suma {fmtQ(r.quotedAmounts.reduce((a, b) => a + b, 0))})</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const COMPARE_LABEL = { coincide: 'Coincide', con_diferencias: 'Con diferencias', solo_en_chat: 'Solo en el chat (falta en el CRM)', solo_registrada: 'Solo en el CRM (sin comprobante en el chat)' };
const DIFF_COMPARE = { monto: 'monto', asesora: 'asesora', dia: 'día', no_confirmada_en_crm: 'no confirmada en el CRM' };
const COMPARE_BADGE = { coincide: 'bg-success/10 text-success', con_diferencias: 'bg-warning/15 text-warning', solo_en_chat: 'bg-danger/10 text-danger', solo_registrada: 'bg-danger/10 text-danger' };
const diffClass = (n) => (Math.abs(n) < 0.5 ? 'text-greige-ink' : n > 0 ? 'text-success' : 'text-danger');

function CompareView({ comparison: c }) {
  const [filter, setFilter] = useState('diferencias');
  const advisors = useMemo(() => {
    const m = new Map();
    for (const d of c?.advisorDay ?? []) {
      const a = m.get(d.advisor) ?? { advisor: d.advisor, registrado: 0, chat: 0, porValidar: 0, pendientes: 0 };
      a.registrado += d.registrado; a.chat += d.chat; a.porValidar += d.porValidar; a.pendientes += d.pendientes;
      m.set(d.advisor, a);
    }
    return [...m.values()].sort((x, y) => y.chat - x.chat);
  }, [c]);
  if (!c) return <p className="py-16 text-center text-sm text-greige-ink">Este análisis es anterior a la comparación. Pulsa "Analizar de nuevo".</p>;
  const items = c.items.filter((i) => (filter === 'diferencias' ? i.status !== 'coincide' : filter === 'todas' || i.status === filter));
  return (
    <div className="space-y-5">
      <p className="text-greige-ink">Del {c.from} al {c.to}. <strong className="text-ink">Registrado en el CRM</strong> es lo que las asesoras reportaron/marcaron como venta; <strong className="text-ink">Según chats</strong> solo cuenta ventas con comprobante y confirmación de la asesora.</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[['Registrado en el CRM', fmtQ(c.totals.registrado)], ['Según chats (verificado)', fmtQ(c.totals.chat)], ['Diferencia', fmtQ(c.totals.diferencia)], ['De eso, por validar', fmtQ(c.totals.porValidar)], ['Pendiente de confirmar', fmtQ(c.totals.pendientes)]].map(([l, v]) => (
          <div key={l} className="rounded-xl border border-line p-3"><p className="text-[11px] text-greige-ink">{l}</p><p className="mt-1 text-lg font-bold text-ink">{v}</p></div>
        ))}
      </div>
      <div className="overflow-auto">
        <p className="mb-2 font-semibold text-ink">Día por día</p>
        <table className="w-full text-left">
          <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-2">Día</th><th className="py-2 text-right">CRM</th><th className="py-2 text-right">Chats</th><th className="py-2 text-right">Diferencia</th><th className="py-2 text-right">Por validar</th><th className="py-2 text-right">Pendiente</th><th className="py-2 text-right">Por revisar (CRM)</th></tr></thead>
          <tbody>
            {c.daily.filter((d) => d.registradoN || d.chatN || d.pendientesN || d.revisarN).map((d) => (
              <tr key={d.day} className="border-b border-line-soft">
                <td className="py-1.5 font-semibold text-ink">{d.day}</td>
                <td className="py-1.5 text-right">{fmtQ(d.registrado)} <span className="text-[10px] text-greige-ink">({d.registradoN})</span></td>
                <td className="py-1.5 text-right">{fmtQ(d.chat)} <span className="text-[10px] text-greige-ink">({d.chatN})</span></td>
                <td className={`py-1.5 text-right font-semibold ${diffClass(d.diferencia)}`}>{fmtQ(d.diferencia)}</td>
                <td className="py-1.5 text-right text-warning">{d.porValidar ? fmtQ(d.porValidar) : '—'}</td>
                <td className="py-1.5 text-right text-warning">{d.pendientesN ? `${fmtQ(d.pendientes)} (${d.pendientesN})` : '—'}</td>
                <td className="py-1.5 text-right text-greige-ink">{d.revisarN ? `${fmtQ(d.revisar)} (${d.revisarN})` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="mb-2 font-semibold text-ink">Por asesora (todo el periodo)</p>
        <table className="w-full text-left">
          <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-2">Asesora</th><th className="py-2 text-right">CRM</th><th className="py-2 text-right">Chats</th><th className="py-2 text-right">Diferencia</th><th className="py-2 text-right">Por validar</th><th className="py-2 text-right">Pendiente</th></tr></thead>
          <tbody>
            {advisors.map((a) => (
              <tr key={a.advisor} className="border-b border-line-soft">
                <td className="py-1.5 font-semibold text-ink">{a.advisor}</td><td className="py-1.5 text-right">{fmtQ(a.registrado)}</td><td className="py-1.5 text-right">{fmtQ(a.chat)}</td>
                <td className={`py-1.5 text-right font-semibold ${diffClass(a.chat - a.registrado)}`}>{fmtQ(a.chat - a.registrado)}</td>
                <td className="py-1.5 text-right text-warning">{a.porValidar ? fmtQ(a.porValidar) : '—'}</td><td className="py-1.5 text-right text-warning">{a.pendientes ? fmtQ(a.pendientes) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="font-semibold text-ink">Venta por venta</p>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1 text-ink">
            <option value="diferencias">Solo lo que no coincide ({c.items.length - (c.counts.coincide ?? 0)})</option>
            <option value="todas">Todas ({c.items.length})</option>
            {Object.entries(COMPARE_LABEL).map(([k, l]) => <option key={k} value={k}>{l} ({c.counts[k] ?? 0})</option>)}
          </select>
          <span className="text-greige-ink">{items.length > 500 ? 'Se muestran 500; el Excel trae todas.' : ''}</span>
        </div>
        <table className="w-full text-left">
          <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-2 pr-2">Día</th><th className="py-2 pr-2">Cliente</th><th className="py-2 pr-2">El chat dice</th><th className="py-2 pr-2">El CRM tiene</th><th className="py-2">Resultado</th></tr></thead>
          <tbody>
            {items.slice(0, 500).map((i, k) => (
              <tr key={k} className="border-b border-line-soft align-top">
                <td className="whitespace-nowrap py-2 pr-2 text-ink">{i.day}</td>
                <td className="py-2 pr-2 text-ink">{i.customer}<div className="text-[10px] text-greige-ink">{i.phone}</div></td>
                <td className="py-2 pr-2 text-ink">{i.chatAmount != null || i.chatAdvisor ? (<>{fmtQ(i.chatAmount)} · {i.chatAdvisor ?? 'sin asesora'}<div className="text-[10px] text-greige-ink">{i.amountBasis === 'precio_aprobado' ? 'precio aprobado · por validar' : i.via ? `leído de ${i.via}` : ''}{!i.verified ? ' · sin confirmar' : ''}</div>{i.quotedAmounts?.length > 1 && <div className="text-[10px] text-warning">Cotizó: {i.quotedAmounts.map((q) => fmtQ(q)).join(' · ')}</div>}</>) : '—'}</td>
                <td className="py-2 pr-2 text-ink">{i.registeredAmount != null ? (<>{fmtQ(i.registeredAmount)} · {i.registeredAdvisor}<div className="text-[10px] text-greige-ink">{i.registeredStatus}{i.locked ? ' · bloqueada' : ''}</div></>) : '—'}</td>
                <td className="py-2"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${COMPARE_BADGE[i.status]}`}>{COMPARE_LABEL[i.status]}</span>{i.diffs?.length > 0 && <div className="mt-0.5 text-[10px] text-warning">{i.diffs.map((d) => DIFF_COMPARE[d] ?? d).join(', ')}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
