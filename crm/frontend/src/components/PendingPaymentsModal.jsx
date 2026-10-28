import { ExternalLink, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import InfoModal from './InfoModal.jsx';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ago = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 60000));
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.floor(min / 60)} h ${min % 60} min`;
  return `hace ${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
};

const GT_DATE = (iso) => new Date(iso).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// Excel de los pendientes tal como están en pantalla: asesora, nombre del cliente, número (o nombre del contacto si el chat es de Instagram o Messenger),
// monto a pagar y la última vez que se le escribió (cuando la asesora le envió los medios de pago).
function downloadPending(items) {
  const rows = items.map((it) => {
    const social = String(it.phone ?? '').startsWith('social:');
    return [it.advisorName, social ? '' : (it.customerName ?? ''), social ? (it.customerName ?? 'Contacto de red social') : it.phone, it.amount != null ? Number(it.amount) : 'Por confirmar', GT_DATE(it.sentAt)];
  });
  const ws = XLSX.utils.aoa_to_sheet([['Asesor', 'Nombre del cliente', 'Número o contacto', 'Monto a pagar (Q)', 'Última vez contactado'], ...rows]);
  rows.forEach((r, i) => { if (typeof r[3] === 'number') ws[`D${i + 2}`].z = '#,##0.00'; });
  ws['!cols'] = [{ wch: 28 }, { wch: 28 }, { wch: 24 }, { wch: 18 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pagos pendientes');
  XLSX.writeFile(wb, `pagos-pendientes-${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' })}.xlsx`);
}

// Pagos pendientes: medios de pago (link de NeoLink o cuenta) que las asesoras entregaron en los últimos 8 días y que todavía no tienen
// comprobante ni venta registrada. El monto es el de la página del link o el total que cotizó la asesora en el chat.
export default function PendingPaymentsModal({ open, onClose, pending }) {
  const items = pending?.items ?? [];
  return (
    <InfoModal open={open} onClose={onClose} title="Pagos pendientes" subtitle="Medios de pago enviados por las asesoras que todavía no tienen comprobante ni venta (últimos 8 días)">
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl border border-warn/30 bg-warn/10 p-3"><p className="text-xl font-bold text-warn">{q(pending?.total)}</p><p className="text-[11px] font-semibold uppercase tracking-wide text-greige-ink">Por cobrar</p></div>
          <div className="rounded-xl border border-line p-3"><p className="text-xl font-bold text-ink">{pending?.count ?? 0}</p><p className="text-[11px] font-semibold uppercase tracking-wide text-greige-ink">Pendientes</p></div>
        </div>
        {items.length > 0 && <button type="button" onClick={() => downloadPending(items)} className="flex w-fit items-center gap-1.5 justify-self-end rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-muted"><Download size={13} />Descargar en Excel</button>}
        {items.length === 0
          ? <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-greige-ink">No hay pagos pendientes ahora mismo.</p>
          : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wider text-greige"><th className="px-3 py-2">Asesora</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">Medio</th><th className="px-3 py-2 text-right">Monto</th><th className="px-3 py-2">Enviado</th><th className="px-3 py-2" /></tr></thead>
                <tbody className="divide-y divide-line">
                  {items.map((it) => (
                    <tr key={`${it.source}-${it.phone}`}>
                      <td className="px-3 py-2 font-semibold text-ink">{it.advisorName}</td>
                      <td className="px-3 py-2 text-ink">{it.customerName ?? '—'}<span className="block text-[11px] text-greige">{it.phone}</span></td>
                      <td className="px-3 py-2 text-xs text-greige-ink">{it.medium === 'link' ? 'Link de pago' : 'Transferencia'}</td>
                      <td className="px-3 py-2 text-right font-bold text-warn">{it.amount != null ? q(it.amount) : <span className="text-xs font-medium text-greige-ink">por confirmar</span>}</td>
                      <td className="px-3 py-2 text-xs text-greige-ink">{ago(it.sentAt)}</td>
                      <td className="px-3 py-2">{it.url && <a href={it.url} target="_blank" rel="noopener noreferrer" aria-label="Abrir el link de pago" className="text-accent hover:underline"><ExternalLink size={14} /></a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {pending?.unknownCount > 0 && <p className="rounded-xl bg-warn/10 p-3 text-xs text-warn">{pending.unknownCount} pendiente{pending.unknownCount === 1 ? '' : 's'} sin monto (no se leyó el link o la asesora no cotizó un total): no suman al total hasta que se conozca.</p>}
        <p className="text-[11px] text-greige">Cuando el cliente manda su comprobante y la venta entra al CRM, el pendiente deja de aparecer aquí. A los 8 días sin pago también sale de la lista. Un cliente cuenta una sola vez.</p>
      </div>
    </InfoModal>
  );
}
