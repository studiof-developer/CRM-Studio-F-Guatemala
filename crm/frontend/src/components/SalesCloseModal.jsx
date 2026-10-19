import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { X, RefreshCw, Download, Save } from 'lucide-react';
import { fetchSalesClose, saveSalesClose, fetchSalesCloses, fetchSalesCloseById } from '../api.js';
import { guatemalaToday } from '../lib/pipelinePeriod.js';

const fmtQ = (n) => (n == null ? '—' : `Q ${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2 })}`);
const fmtTime = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
const CUTOFFS = [['', 'Ahora / fin del día'], ['16:00', '4:00 pm'], ['21:00', '9:00 pm'], ['custom', 'Otra hora…']];
const basisLabel = (r) => (r.amountBasis === 'precio_aprobado' ? 'precio aprobado · por validar' : r.via ? `leído de ${r.via}` : '');

export default function SalesCloseModal({ open, onClose }) {
  const [date, setDate] = useState(guatemalaToday());
  const [cutoff, setCutoff] = useState('');
  const [custom, setCustom] = useState('16:00');
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [openAdvisor, setOpenAdvisor] = useState(null);

  const asOf = cutoff === 'custom' ? custom : cutoff;
  const loadSaved = async (d = date) => { try { setSaved(await fetchSalesCloses(d)); } catch { /* la lista es opcional */ } };

  async function calculate() {
    setLoading(true); setError(null);
    try { setResult(await fetchSalesClose(date, asOf || undefined)); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  async function save() {
    setSaving(true); setError(null);
    try { setResult(await saveSalesClose({ date, asOf: asOf || undefined })); await loadSaved(); } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  async function openSaved(id) {
    if (!id) return;
    setLoading(true); setError(null);
    try { setResult(await fetchSalesCloseById(Number(id))); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  useEffect(() => { if (open) { setError(null); loadSaved(date); } }, [open, date]); // eslint-disable-line react-hooks/exhaustive-deps

  function exportExcel() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Asesora', 'Pagado (Q)', 'Ventas pagadas', 'Mañana (Q)', 'Tarde (Q)', 'Domingo (Q)', 'Fuera de turno (Q)', 'De eso, por validar (Q)', 'Comprobantes sin confirmar', 'Pendiente (Q)', 'Ventas pendientes', 'Pendientes sin monto', 'Solo medios enviados', 'Registrado en el CRM (Q)', 'Diferencia (Q)'],
      ...result.advisors.map((a) => [a.advisor, a.pagado, a.pagadoN, a.manana, a.tarde, a.domingo, a.fueraDeTurno, a.porValidar, a.sinConfirmarN, a.pendiente, a.pendienteN, a.pendienteSinMontoN, a.soloMediosN, a.registrado, a.diferencia]),
      ['TOTAL', result.totals.pagado, result.totals.pagadoN, result.totals.manana, result.totals.tarde, result.totals.domingo, result.totals.fueraDeTurno, result.totals.porValidar, result.totals.sinConfirmarN, result.totals.pendiente, result.totals.pendienteN, result.totals.pendienteSinMontoN, result.totals.soloMediosN, result.totals.registrado, result.totals.diferencia],
    ]), 'Resumen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Hora', 'Asesora', 'Cliente', 'Últimos 4', 'Monto (Q)', 'Medio', 'Base del monto', 'Confirmó', 'Dio medios de pago'],
      ...result.paid.map((r) => [fmtTime(r.at), r.advisor ?? '', r.customer, r.last4, r.amount ?? '', r.medium ?? '', basisLabel(r), r.confirmedBy ?? (r.verified ? '' : 'sin confirmar'), r.paymentInfoBy ?? '']),
    ]), 'Pagadas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Medios de pago enviados', 'Asesora', 'Cliente', 'Últimos 4', 'Monto (Q)', 'Medio', 'Estado'],
      ...result.pending.map((p) => [fmtTime(p.at), p.advisor ?? '', p.customer, p.last4, p.amount ?? '', p.medium ?? '', p.real ? (p.customerAccepted ? 'El cliente aceptó' : 'El cliente respondió') : 'Solo se enviaron los medios']),
    ]), 'Pendientes');
    XLSX.writeFile(wb, `cierre_${result.day}_${new Date(result.asOf).toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '')}.xlsx`);
  }

  if (!open) return null;
  const t = result?.totals;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="relative flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-line bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div>
            <h3 className="text-base font-bold text-ink">Cierre del día por asesora</h3>
            <p className="mt-0.5 text-xs text-greige-ink">
              Lo que cada asesora lleva <strong>pagado</strong> (comprobante del cliente o confirmación de la asesora) y <strong>pendiente</strong> (medios de pago enviados, aún sin pago) hasta la hora de corte, leído de los chats. Un cierre guardado queda congelado.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {result && (
              <button type="button" onClick={exportExcel} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-muted">
                <Download size={13} /><span>Excel</span>
              </button>
            )}
            <button type="button" onClick={onClose} className="rounded-xl p-2 text-greige-ink hover:bg-muted hover:text-ink" title="Cerrar"><X size={20} /></button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3 text-xs">
          <label className="flex flex-col gap-1 text-greige-ink">Día
            <input type="date" value={date} max={guatemalaToday()} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1.5 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-greige-ink">Hora de corte
            <select value={cutoff} onChange={(e) => setCutoff(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1.5 text-ink">
              {CUTOFFS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {cutoff === 'custom' && (
            <label className="flex flex-col gap-1 text-greige-ink">Hora (Guatemala)
              <input type="time" value={custom} onChange={(e) => setCustom(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1.5 text-ink" />
            </label>
          )}
          <button type="button" onClick={calculate} disabled={loading || !date} className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {loading ? <RefreshCw size={13} className="animate-spin" /> : null}<span>{loading ? 'Calculando…' : 'Calcular'}</span>
          </button>
          <button type="button" onClick={save} disabled={saving || loading || !date} className="flex items-center gap-1.5 rounded-xl border border-line px-4 py-2 font-semibold text-ink hover:bg-muted disabled:opacity-50" title="Guarda este cierre congelado, con la hora de corte elegida">
            <Save size={13} /><span>{saving ? 'Guardando…' : 'Guardar este cierre'}</span>
          </button>
          {saved.length > 0 && (
            <label className="flex flex-col gap-1 text-greige-ink">Cierres guardados de ese día
              <select defaultValue="" onChange={(e) => openSaved(e.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1.5 text-ink">
                <option value="">Elegir…</option>
                {saved.map((s) => <option key={s.id} value={s.id}>{s.label ?? 'Cierre'} · corte {fmtTime(s.as_of)}</option>)}
              </select>
            </label>
          )}
        </div>

        {error && <p className="border-b border-line bg-danger/10 px-5 py-2 text-xs text-danger">{error}</p>}

        <div className="min-h-[260px] flex-1 overflow-auto px-5 py-4 text-xs">
          {!result ? (
            <p className="py-16 text-center text-sm text-greige-ink">{loading ? 'Leyendo los chats…' : 'Elige el día y la hora de corte, y pulsa "Calcular".'}</p>
          ) : (
            <div className="space-y-5">
              <p className="text-greige-ink">Corte: <strong className="text-ink">{fmtTime(result.asOf)}</strong> · {result.customersAnalyzed ?? '—'} chats con actividad revisados.</p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {[['Pagado', `${fmtQ(t.pagado)} (${t.pagadoN})`], ['De eso, por validar', fmtQ(t.porValidar)], ['Pendiente', `${fmtQ(t.pendiente)} (${t.pendienteN})`], ['Registrado en el CRM', `${fmtQ(t.registrado)} (${t.registradoN})`], ['Diferencia (chats − CRM)', fmtQ(t.diferencia)]].map(([l, v]) => (
                  <div key={l} className="rounded-xl border border-line p-3"><p className="text-[11px] text-greige-ink">{l}</p><p className="mt-1 text-base font-bold text-ink">{v}</p></div>
                ))}
              </div>

              <table className="w-full text-left">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink">
                  <th className="py-2">Asesora</th><th className="py-2 text-right">Pagado</th><th className="py-2 text-right">Por validar</th><th className="py-2 text-right">Sin confirmar</th>
                  <th className="py-2 text-right">Pendiente</th><th className="py-2 text-right">Solo medios</th><th className="py-2 text-right">CRM</th><th className="py-2 text-right">Diferencia</th>
                </tr></thead>
                <tbody>
                  {result.advisors.map((a) => (
                    <tr key={a.advisor} onClick={() => setOpenAdvisor(openAdvisor === a.advisor ? null : a.advisor)} className="cursor-pointer border-b border-line-soft hover:bg-secondary/50">
                      <td className="py-2 font-semibold text-ink">{a.advisor}</td>
                      <td className="py-2 text-right font-semibold text-success">{fmtQ(a.pagado)} <span className="text-[10px] font-normal text-greige-ink">({a.pagadoN})</span><div className="text-[10px] font-normal text-greige-ink">{[a.manana > 0 && `Mañana ${fmtQ(a.manana)}`, a.tarde > 0 && `Tarde ${fmtQ(a.tarde)}`, a.domingo > 0 && `Dom. ${fmtQ(a.domingo)}`, a.fueraDeTurno > 0 && `Fuera de turno ${fmtQ(a.fueraDeTurno)}`].filter(Boolean).join(' · ')}</div></td>
                      <td className="py-2 text-right text-warning">{a.porValidarN ? `${fmtQ(a.porValidar)} (${a.porValidarN})` : '—'}</td>
                      <td className="py-2 text-right text-warning">{a.sinConfirmarN || '—'}</td>
                      <td className="py-2 text-right">{a.pendienteN ? `${fmtQ(a.pendiente)} (${a.pendienteN})` : '—'}{a.pendienteSinMontoN ? <span className="text-[10px] text-greige-ink"> · {a.pendienteSinMontoN} sin monto</span> : null}</td>
                      <td className="py-2 text-right text-greige-ink">{a.soloMediosN || '—'}</td>
                      <td className="py-2 text-right">{fmtQ(a.registrado)} <span className="text-[10px] text-greige-ink">({a.registradoN})</span></td>
                      <td className={`py-2 text-right font-semibold ${Math.abs(a.diferencia) < 0.5 ? 'text-greige-ink' : a.diferencia > 0 ? 'text-success' : 'text-danger'}`}>{fmtQ(a.diferencia)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-greige-ink">Pulsa una asesora para ver cada venta. "Sin confirmar" = comprobante recibido, la asesora aún no confirmó. "Solo medios" = se enviaron los medios de pago y el cliente no respondió.</p>

              {openAdvisor && (() => {
                const paid = result.paid.filter((r) => (r.advisor ?? 'Sin atribuir') === openAdvisor);
                const pend = result.pending.filter((p) => (p.advisor ?? 'Sin atribuir') === openAdvisor);
                return (
                  <div className="space-y-4 rounded-xl border border-line p-4">
                    <div>
                      <p className="mb-1 font-semibold text-ink">{openAdvisor}: pagadas ({paid.length})</p>
                      <table className="w-full text-left">
                        <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-1.5">Hora</th><th className="py-1.5">Cliente</th><th className="py-1.5 text-right">Monto</th><th className="py-1.5">Dio medios de pago</th><th className="py-1.5">Confirmación</th></tr></thead>
                        <tbody>{paid.map((r, i) => (
                          <tr key={i} className="border-b border-line-soft align-top">
                            <td className="whitespace-nowrap py-1.5 text-ink">{fmtTime(r.at)}</td>
                            <td className="py-1.5 text-ink">{r.customer}<div className="text-[10px] text-greige-ink">…{r.last4}</div></td>
                            <td className="whitespace-nowrap py-1.5 text-right font-semibold text-ink">{fmtQ(r.amount)}<div className="text-[10px] font-normal text-greige-ink">{[r.medium, basisLabel(r)].filter(Boolean).join(' · ')}</div></td>
                            <td className="py-1.5 text-ink">{r.paymentInfoBy ?? '—'}</td>
                            <td className="py-1.5">{r.verified ? <span className="text-success">{r.confirmedBy ?? 'Confirmada'}</span> : <span className="text-warning">Sin confirmar</span>}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                    <div>
                      <p className="mb-1 font-semibold text-ink">{openAdvisor}: pendientes ({pend.length})</p>
                      {pend.length === 0 ? <p className="text-greige-ink">Ninguna.</p> : (
                        <table className="w-full text-left">
                          <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink"><th className="py-1.5">Medios de pago</th><th className="py-1.5">Cliente</th><th className="py-1.5 text-right">Monto</th><th className="py-1.5">Estado</th></tr></thead>
                          <tbody>{pend.map((p, i) => (
                            <tr key={i} className="border-b border-line-soft align-top">
                              <td className="whitespace-nowrap py-1.5 text-ink">{fmtTime(p.at)}</td>
                              <td className="py-1.5 text-ink">{p.customer}<div className="text-[10px] text-greige-ink">…{p.last4}</div></td>
                              <td className="whitespace-nowrap py-1.5 text-right text-ink">{fmtQ(p.amount)}<div className="text-[10px] text-greige-ink">{p.medium ?? ''}</div></td>
                              <td className="py-1.5 text-ink">{p.customerAccepted ? 'El cliente aceptó' : p.customerReplied ? 'El cliente respondió' : <span className="text-greige-ink">Solo se enviaron los medios</span>}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
