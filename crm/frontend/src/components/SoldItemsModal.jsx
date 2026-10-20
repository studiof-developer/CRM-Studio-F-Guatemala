import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import InfoModal from './InfoModal.jsx';
import { fetchSoldItems } from '../api.js';

const q = (n) => `Q ${Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Prendas vendidas en el período y la línea que se están viendo. La prenda sale de la cotización de cada venta (la enlazada, o la
// última del cliente en los 30 días anteriores); lo que no tiene cotización se avisa aparte en vez de adivinarse.
export default function SoldItemsModal({ open, onClose, filters, title }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setData(null); setError(null);
    fetchSoldItems(filters).then(setData).catch((err) => setError(err.message));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <InfoModal open={open} onClose={onClose} title="Prendas vendidas" subtitle={title}>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!error && !data && <p className="flex items-center gap-2 py-6 text-sm text-greige-ink"><Loader2 size={16} className="animate-spin" /> Buscando las prendas de cada venta…</p>}
      {data && (
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            {[['Prendas', data.totalUnits], ['Referencias distintas', data.groups.length], ['Ventas con prendas', `${data.salesWithItems} de ${data.salesTotal}`]].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-line p-3"><p className="text-xl font-bold text-ink">{value}</p><p className="text-[11px] font-semibold uppercase tracking-wide text-greige">{label}</p></div>
            ))}
          </div>

          {data.groups.length === 0
            ? <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-greige-ink">Ninguna venta de este período tiene una cotización con prendas.</p>
            : (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-left text-sm">
                  <thead><tr className="border-b border-line text-[11px] uppercase tracking-wider text-greige"><th className="px-3 py-2">Referencia</th><th className="px-3 py-2">Prenda</th><th className="px-3 py-2 text-center">Unidades</th><th className="px-3 py-2">Tallas</th><th className="px-3 py-2 text-right">Total</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {data.groups.map((g) => (
                      <tr key={g.sku}>
                        <td className="px-3 py-2 font-mono text-xs font-semibold text-ink">{g.sku}</td>
                        <td className="px-3 py-2 text-ink">{g.name}</td>
                        <td className="px-3 py-2 text-center font-bold text-ink">{g.units}</td>
                        <td className="px-3 py-2 text-xs text-greige-ink">{Object.entries(g.sizes).map(([size, n]) => `${size} × ${n}`).join(' · ')}</td>
                        <td className="px-3 py-2 text-right font-semibold text-success">{q(g.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          {(data.salesWithoutItems > 0 || data.salesMismatch > 0) && (
            <ul className="grid gap-1.5 rounded-xl bg-warn/10 p-3 text-xs text-warn">
              {data.salesWithoutItems > 0 && <li><strong>{data.salesWithoutItems}</strong> venta{data.salesWithoutItems === 1 ? '' : 's'} sin cotización del Cotizador: no se sabe qué prenda fue.</li>}
              {data.salesMismatch > 0 && <li><strong>{data.salesMismatch}</strong> venta{data.salesMismatch === 1 ? '' : 's'} con una cotización que no coincide con lo cobrado: la prenda es una referencia, no una certeza.</li>}
            </ul>
          )}
        </div>
      )}
    </InfoModal>
  );
}
