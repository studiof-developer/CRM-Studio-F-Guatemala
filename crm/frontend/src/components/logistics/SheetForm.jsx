import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { updateSheet } from '../../api.js';
import { showSuccess, showError } from '../Toast.jsx';
import { PrimaryBtn, GhostBtn, FieldRow, inputCls, q } from '../../lib/logisticsUi.jsx';

const FIELDS = [
  ['campaign', 'Nombre de la campaña *'], ['full_name', 'Nombre completo *'], ['phone', 'Celular *'], ['phone_alt', 'Celular alterno'], ['email', 'Correo *'], ['receiver_name', 'Quién recibe (si es otra persona)'],
  ['address', 'Dirección *'], ['address_ref', 'Referencia de la dirección'], ['city', 'Ciudad *'], ['department', 'Departamento *'], ['invoice_name', 'Nombre para la factura'], ['invoice_nit', 'NIT'],
];
const EMPTY_ITEM = { reference: '', description: '', size: '', color: '', quantity: 1, unit_price: '', discount_pct: 0 };

// Datos de la ficha y sus prendas (lo que hoy va en la ficha de papel). El total lo calcula el servidor.
export default function SheetForm({ detail, onSaved }) {
  const { sheet, items: savedItems, payments, config } = detail;
  const hasApproved = payments.some((p) => p.audit_status === 'aprobado');
  const [data, setData] = useState(() => ({
    ...Object.fromEntries(FIELDS.map(([k]) => [k, sheet[k] ?? ''])),
    payment_mode: sheet.payment_mode, delivery_type: sheet.delivery_type, origin_mode: sheet.origin_mode, dispatch_warehouse: sheet.dispatch_warehouse ?? '',
    origin_warehouses: (sheet.origin_warehouses ?? []).join(', '), shipping: sheet.shipping ?? 0, notes: sheet.notes ?? '',
  }));
  const [items, setItems] = useState(() => savedItems.map((i) => ({ reference: i.reference, description: i.description ?? '', size: i.size, color: i.color, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct })));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setData((s) => ({ ...s, [k]: v }));
  const setItem = (n, k, v) => setItems((list) => list.map((it, i) => (i === n ? { ...it, [k]: v } : it)));

  const goods = items.reduce((s, i) => s + Number(i.unit_price || 0) * (1 - Number(i.discount_pct || 0) / 100) * Number(i.quantity || 0), 0);
  const total = goods + Number(data.shipping || 0);

  async function save() {
    setBusy(true);
    try {
      const body = { data: { ...data, origin_warehouses: data.origin_warehouses.split(',').map((x) => x.trim()).filter(Boolean) } };
      if (!hasApproved) body.items = items;
      await updateSheet(sheet.id, body);
      showSuccess('Ficha guardada');
      onSaved();
    } catch (err) { showError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <FieldRow label="Tipo de pago"><select className={inputCls} value={data.payment_mode} onChange={(e) => set('payment_mode', e.target.value)}><option value="contado">Contado</option><option value="contraentrega">Contraentrega</option></select></FieldRow>
        <FieldRow label="Entrega"><select className={inputCls} value={data.delivery_type} onChange={(e) => set('delivery_type', e.target.value)}><option value="domicilio">A domicilio</option><option value="agencia">En agencia</option></select></FieldRow>
        <FieldRow label="Origen de las prendas"><select className={inputCls} value={data.origin_mode} onChange={(e) => set('origin_mode', e.target.value)}><option value="unica">Una sola tienda / bodega</option><option value="multiple">Varias tiendas / bodegas</option></select></FieldRow>
        <FieldRow label="Tienda(s) / bodega(s) de origen" className="sm:col-span-2"><input className={inputCls} list="log-warehouses" value={data.origin_warehouses} onChange={(e) => set('origin_warehouses', e.target.value)} placeholder="Separa con comas si son varias" /></FieldRow>
        <FieldRow label="Bodega de despacho"><input className={inputCls} value={data.dispatch_warehouse} onChange={(e) => set('dispatch_warehouse', e.target.value)} /></FieldRow>
        <datalist id="log-warehouses">{(config.warehouses ?? []).map((w) => <option key={w} value={w} />)}</datalist>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map(([k, label]) => <FieldRow key={k} label={label}><input className={inputCls} value={data[k]} onChange={(e) => set(k, e.target.value)} /></FieldRow>)}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-greige-ink">Prendas *</span>
          {!hasApproved && <GhostBtn className="!px-2.5 !py-1 text-xs" onClick={() => setItems((l) => [...l, { ...EMPTY_ITEM }])}><Plus size={12} className="mr-1 inline" />Agregar prenda</GhostBtn>}
        </div>
        {hasApproved && <p className="mb-2 rounded-lg bg-warning/15 px-3 py-2 text-xs text-warning">Ya hay un pago aprobado: las prendas y el total no se cambian. Si el cliente pide otra prenda, se crea otra ficha.</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-greige-ink"><th className="pb-1 pr-2">Referencia</th><th className="pb-1 pr-2">Descripción</th><th className="pb-1 pr-2">Talla</th><th className="pb-1 pr-2">Color</th><th className="pb-1 pr-2">Cant.</th><th className="pb-1 pr-2">Precio</th><th className="pb-1 pr-2">Desc. %</th><th /></tr></thead>
            <tbody>
              {items.map((it, n) => (
                <tr key={n}>
                  {['reference', 'description', 'size', 'color'].map((k) => <td key={k} className="pr-2 pb-1.5"><input className={inputCls} disabled={hasApproved} value={it[k]} onChange={(e) => setItem(n, k, e.target.value)} /></td>)}
                  <td className="w-16 pr-2 pb-1.5"><input className={inputCls} type="number" min="1" disabled={hasApproved} value={it.quantity} onChange={(e) => setItem(n, 'quantity', e.target.value)} /></td>
                  <td className="w-24 pr-2 pb-1.5"><input className={inputCls} type="number" step="0.01" min="0" disabled={hasApproved} value={it.unit_price} onChange={(e) => setItem(n, 'unit_price', e.target.value)} /></td>
                  <td className="w-20 pr-2 pb-1.5"><input className={inputCls} type="number" min="0" max="100" disabled={hasApproved} value={it.discount_pct} onChange={(e) => setItem(n, 'discount_pct', e.target.value)} /></td>
                  <td className="pb-1.5">{!hasApproved && <button type="button" aria-label="Quitar prenda" onClick={() => setItems((l) => l.filter((_, i) => i !== n))} className="rounded p-1.5 text-greige hover:text-danger"><Trash2 size={14} /></button>}</td>
                </tr>
              ))}
              {!items.length && <tr><td colSpan={8} className="py-4 text-center text-sm text-greige-ink">Aún no hay prendas.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FieldRow label="Envío (Q)"><input className={inputCls} type="number" step="0.01" min="0" disabled={hasApproved} value={data.shipping} onChange={(e) => set('shipping', e.target.value)} /></FieldRow>
        <FieldRow label="Notas" className="sm:col-span-2"><input className={inputCls} value={data.notes} onChange={(e) => set('notes', e.target.value)} /></FieldRow>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-secondary px-4 py-3">
        <span className="text-sm text-greige-ink">Total estimado (el servidor lo recalcula al guardar)</span>
        <span className="text-lg font-bold tabular-nums text-ink">{q(hasApproved ? sheet.total : total)}</span>
      </div>
      <div className="flex justify-end"><PrimaryBtn onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Guardar ficha'}</PrimaryBtn></div>
    </div>
  );
}
