import { ExternalLink } from 'lucide-react';
import InfoModal from './InfoModal.jsx';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ago = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 60000));
  return min < 60 ? `hace ${min} min` : `hace ${Math.floor(min / 60)} h ${min % 60} min`;
};

// Pagos pendientes: links de NeoLink que las asesoras mandaron en las últimas 24 h y que todavía no tienen una venta registrada.
// El monto es el que muestra la página del link.
export default function PendingPaymentsModal({ open, onClose, pending }) {
  const items = pending?.items ?? [];
  return (
    <InfoModal open={open} onClose={onClose} title="Pagos pendientes" subtitle="Links de pago enviados que todavía no se han pagado (últimas 24 horas)">
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl border border-warn/30 bg-warn/10 p-3"><p className="text-xl font-bold text-warn">{q(pending?.total)}</p><p className="text-[11px] font-semibold uppercase tracking-wide text-greige-ink">Por cobrar</p></div>
          <div className="rounded-xl border border-line p-3"><p className="text-xl font-bold text-ink">{pending?.count ?? 0}</p><p className="text-[11px] font-semibold uppercase tracking-wide text-greige-ink">Links enviados</p></div>
        </div>
        {items.length === 0
          ? <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-greige-ink">No hay links de pago pendientes ahora mismo.</p>
          : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-line text-[11px] uppercase tracking-wider text-greige"><th className="px-3 py-2">Asesora</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2 text-right">Monto</th><th className="px-3 py-2">Enviado</th><th className="px-3 py-2" /></tr></thead>
                <tbody className="divide-y divide-line">
                  {items.map((it) => (
                    <tr key={it.id}>
                      <td className="px-3 py-2 font-semibold text-ink">{it.advisorName}</td>
                      <td className="px-3 py-2 text-ink">{it.customerName ?? '—'}<span className="block text-[11px] text-greige">{it.phone}</span></td>
                      <td className="px-3 py-2 text-right font-bold text-warn">{it.amount != null ? q(it.amount) : <span className="text-xs font-medium text-greige-ink">por confirmar</span>}</td>
                      <td className="px-3 py-2 text-xs text-greige-ink">{ago(it.sentAt)}</td>
                      <td className="px-3 py-2"><a href={it.url} target="_blank" rel="noopener noreferrer" aria-label="Abrir el link de pago" className="text-accent hover:underline"><ExternalLink size={14} /></a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {pending?.unknownCount > 0 && <p className="rounded-xl bg-warn/10 p-3 text-xs text-warn">No se pudo leer el monto de {pending.unknownCount} link{pending.unknownCount === 1 ? '' : 's'}; se vuelve a intentar al actualizar. No suman al total hasta entonces.</p>}
        <p className="text-[11px] text-greige">Cuando el cliente paga y la venta entra al CRM, el link deja de aparecer aquí. Si le mandan otro link al mismo cliente, cuenta solo el último.</p>
      </div>
    </InfoModal>
  );
}
