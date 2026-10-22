import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PageHeader } from './components/ui.jsx';
import { showError } from './components/Toast.jsx';
import SheetTable from './components/logistics/SheetTable.jsx';
import SheetDetail from './components/logistics/SheetDetail.jsx';
import { fetchSheets, fetchLogisticsMe, fetchCustomers, fetchCustomerQuotes, createSheet } from './api.js';
import { Modal, PrimaryBtn, GhostBtn, inputCls, q, fmtDT } from './lib/logisticsUi.jsx';

function NewSheetModal({ onClose, onCreated }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [quoteId, setQuoteId] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (customer || term.trim().length < 2) { setResults([]); return undefined; }
    const t = setTimeout(() => fetchCustomers(term.trim(), undefined, 15).then((r) => setResults(Array.isArray(r) ? r : (r.customers ?? []))).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [term, customer]);

  function pick(c) {
    setCustomer(c); setQuoteId(null);
    fetchCustomerQuotes(c.id).then(setQuotes).catch(() => setQuotes([]));
  }

  async function create() {
    setBusy(true);
    try { onCreated(await createSheet({ customerId: customer.id, quoteId })); } catch (err) { showError(err.message); setBusy(false); }
  }

  return (
    <Modal title="Nueva ficha de pedido" subtitle="Elige al cliente y, si ya cotizaste, la cotización: las prendas se copian de ahí." onClose={onClose}
      footer={<><GhostBtn onClick={onClose} disabled={busy}>Cancelar</GhostBtn><PrimaryBtn onClick={create} disabled={!customer || busy}>{busy ? 'Creando…' : 'Crear ficha'}</PrimaryBtn></>}>
      {!customer ? (
        <div>
          <input autoFocus className={inputCls} placeholder="Buscar cliente por nombre o teléfono…" value={term} onChange={(e) => setTerm(e.target.value)} />
          <ul className="mt-2 max-h-64 overflow-y-auto">
            {results.map((c) => <li key={c.id}><button type="button" onClick={() => pick(c)} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"><b className="text-ink">{c.full_name ?? 'Sin nombre'}</b> <span className="text-xs text-greige-ink">{String(c.whatsapp_number).startsWith('social:') ? 'Red social' : c.whatsapp_number}</span></button></li>)}
            {term.trim().length >= 2 && !results.length && <li className="px-3 py-2 text-sm text-greige-ink">Sin resultados.</li>}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-sm"><span><b>{customer.full_name}</b> · {customer.whatsapp_number}</span><button type="button" className="text-xs font-semibold text-accent" onClick={() => { setCustomer(null); setQuotes([]); }}>Cambiar</button></div>
          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-greige-ink">Cotización</span>
            <label className="flex items-center gap-2 py-1 text-sm"><input type="radio" checked={quoteId === null} onChange={() => setQuoteId(null)} />Sin cotización (agrego las prendas a mano)</label>
            {quotes.map((qt) => <label key={qt.id} className="flex items-center gap-2 py-1 text-sm"><input type="radio" checked={quoteId === qt.id} onChange={() => setQuoteId(qt.id)} />{qt.quoteNumber} · {q(qt.grandTotal)} · {qt.items.length} prenda(s) · {fmtDT(qt.createdAt)}</label>)}
          </div>
        </div>
      )}
    </Modal>
  );
}

// Fichas de pedido de la asesora: las crea, adjunta los comprobantes y las envía a auditoría de pago.
export default function Fichas() {
  const [sheets, setSheets] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => fetchSheets({ scope: 'mine' }).then(setSheets).catch((e) => showError(e.message)).finally(() => setLoading(false)), []);
  useEffect(() => { load(); fetchLogisticsMe().then(setMe).catch(() => {}); }, [load]);
  const rows = Array.isArray(sheets) ? sheets : sheets.sheets ?? [];

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Fichas de pedido" subtitle="Crea la ficha cuando el cliente paga, adjunta cada comprobante y envíala a auditoría de pago."
        action={<PrimaryBtn onClick={() => setCreating(true)} className="inline-flex items-center gap-2"><Plus size={16} />Nueva ficha</PrimaryBtn>} />
      {loading ? <p className="py-10 text-center text-sm text-greige-ink">Cargando…</p> : <SheetTable sheets={rows} onOpen={setOpenId} />}
      {creating && <NewSheetModal onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); load(); setOpenId(s.id); }} />}
      {openId && <SheetDetail sheetId={openId} me={me} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}
