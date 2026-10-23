import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { X, Search, Plus, Trash2, Check, ChevronLeft, ChevronRight, Send, Loader2, ImageIcon, Wallet, Truck, CreditCard, CheckCircle2, Circle, ShieldCheck } from 'lucide-react';
import { fetchCustomers, fetchCustomerQuotes, fetchProducts, productImageUrl, createSheet, fetchSheet, updateSheet, runSheetStep } from '../../api.js';
import { showSuccess, showError } from '../Toast.jsx';
import Avatar from '../Avatar.jsx';
import { PaymentDialog } from './StepDialogs.jsx';
import { Drawer, Panel, PrimaryBtn, GhostBtn, FieldRow, ProofThumb, AuditPill, inputCls, SOFT, METHOD_LABELS, q, fmtDT } from '../../lib/logisticsUi.jsx';

const STEPS = [['cliente', 'Cliente'], ['prendas', 'Prendas'], ['entrega', 'Entrega'], ['pagos', 'Pagos'], ['revision', 'Revisión']];
const CONTACT = [['full_name', 'Nombre completo *'], ['phone', 'Celular *'], ['phone_alt', 'Celular alterno'], ['email', 'Correo *'], ['receiver_name', 'Quién recibe (si es otra persona)'], ['campaign', 'Nombre de la campaña *']];
const ADDRESS = [['address', 'Dirección *'], ['address_ref', 'Referencia de la dirección'], ['city', 'Ciudad *'], ['department', 'Departamento *']];
const InvoiceFields = [['invoice_name', 'Nombre para la factura'], ['invoice_nit', 'NIT']];

function Progress({ step, maxStep, onGo, lockFirst }) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto">
      {STEPS.map(([key, label], i) => {
        const done = i < step; const now = i === step; const reachable = i <= maxStep;
        return (
          <li key={key} className="flex items-center gap-1">
            <button type="button" disabled={!reachable || (i === 0 && lockFirst)} onClick={() => onGo(i)} aria-current={now ? 'step' : undefined}
              className={`flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3.5 text-sm font-semibold transition ${now ? 'bg-accent text-white' : done ? 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]' : 'text-greige'} disabled:cursor-not-allowed`}>
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] ${now ? 'bg-white/25' : done ? 'bg-success text-white' : SOFT}`}>{done ? <Check size={13} strokeWidth={3} /> : i + 1}</span>{label}
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-3 bg-line" />}
          </li>
        );
      })}
    </ol>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map(([v, title, text, Icon]) => (
        <button type="button" key={v} onClick={() => onChange(v)} aria-pressed={value === v} className={`flex items-start gap-3 rounded-xl border-2 p-3.5 text-left transition ${value === v ? 'border-accent bg-accent-soft' : 'border-line hover:border-greige'}`}>
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${value === v ? 'bg-accent text-white' : `${SOFT} text-greige-ink`}`}><Icon size={17} /></span>
          <span><span className="block text-sm font-semibold text-ink">{title}</span><span className="block text-xs text-greige-ink">{text}</span></span>
        </button>
      ))}
    </div>
  );
}

// — paso 1: cliente y cotización —
function CustomerStep({ onCreate, busy }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [quoteId, setQuoteId] = useState(null);
  useEffect(() => {
    if (customer || term.trim().length < 2) { setResults([]); return undefined; }
    const t = setTimeout(() => fetchCustomers(term.trim(), undefined, 15).then((r) => setResults(Array.isArray(r) ? r : (r.customers ?? []))).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [term, customer]);
  const pick = (c) => { setCustomer(c); setQuoteId(null); fetchCustomerQuotes(c.id).then(setQuotes).catch(() => setQuotes([])); };

  return (
    <div className="space-y-4">
      {!customer ? (
        <Panel title="¿Para quién es el pedido?" icon={Search}>
          <div className="relative"><Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-greige" /><input autoFocus className={`${inputCls} pl-10`} placeholder="Busca por nombre o teléfono…" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
          <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
            {results.map((c) => (
              <li key={c.id}><button type="button" onClick={() => pick(c)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                <Avatar name={c.full_name} size={34} /><span className="min-w-0"><span className="block truncate text-sm font-semibold text-ink">{c.full_name ?? 'Sin nombre'}</span><span className="block text-xs text-greige-ink">{String(c.whatsapp_number).startsWith('social:') ? 'Red social' : c.whatsapp_number}</span></span>
              </button></li>
            ))}
            {term.trim().length >= 2 && !results.length && <li className="px-3 py-6 text-center text-sm text-greige-ink">Sin resultados para “{term}”.</li>}
            {term.trim().length < 2 && <li className="px-3 py-6 text-center text-sm text-greige">Escribe al menos 2 letras.</li>}
          </ul>
        </Panel>
      ) : (
        <>
          <Panel>
            <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-3"><Avatar name={customer.full_name} size={40} /><span><span className="block text-sm font-semibold text-ink">{customer.full_name}</span><span className="block text-xs text-greige-ink">{customer.whatsapp_number}</span></span></span>
              <button type="button" onClick={() => { setCustomer(null); setQuotes([]); }} className="text-xs font-semibold text-accent hover:underline">Cambiar</button></div>
          </Panel>
          <Panel title="¿Parte de una cotización?" icon={CreditCard}>
            <div className="space-y-2">
              <Option checked={quoteId === null} onClick={() => setQuoteId(null)} title="Sin cotización" text="Agrego las prendas desde el catálogo." />
              {quotes.map((qt) => <Option key={qt.id} checked={quoteId === qt.id} onClick={() => setQuoteId(qt.id)} title={`${qt.quoteNumber} · ${q(qt.grandTotal)}`} text={`${qt.items.length} prenda(s) · ${fmtDT(qt.createdAt)} · ${qt.advisorName ?? ''}`} />)}
            </div>
          </Panel>
          <div className="flex justify-end"><PrimaryBtn disabled={busy} onClick={() => onCreate(customer.id, quoteId)}>{busy ? <Loader2 size={16} className="animate-spin" /> : null}Crear borrador y continuar<ChevronRight size={16} /></PrimaryBtn></div>
        </>
      )}
    </div>
  );
}

const Option = ({ checked, onClick, title, text }) => (
  <button type="button" onClick={onClick} aria-pressed={checked} className={`flex w-full items-center gap-3 rounded-xl border-2 px-3.5 py-3 text-left transition ${checked ? 'border-accent bg-accent-soft' : 'border-line hover:border-greige'}`}>
    {checked ? <CheckCircle2 size={18} className="shrink-0 text-accent" /> : <Circle size={18} className="shrink-0 text-greige" />}
    <span className="min-w-0"><span className="block text-sm font-semibold text-ink">{title}</span><span className="block truncate text-xs text-greige-ink">{text}</span></span>
  </button>
);

// — paso 2: prendas —
function ItemsStep({ items, setItems, shipping, setShipping, locked }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (term.trim().length < 2) { setResults([]); return undefined; }
    setLoading(true);
    const t = setTimeout(() => fetchProducts(term).then(setResults).catch(() => setResults([])).finally(() => setLoading(false)), 350);
    return () => clearTimeout(t);
  }, [term]);
  const add = (p) => { setItems((l) => [...l, { product_id: p.id, reference: String(p.reference || p.sku || ''), description: p.name ?? '', size: p.size ?? '', color: p.color ?? '', quantity: 1, unit_price: Number(p.price) || 0, discount_pct: Number(p.discount_pct) || 0 }]); setTerm(''); setResults([]); };
  const set = (n, k, v) => setItems((l) => l.map((it, i) => (i === n ? { ...it, [k]: v } : it)));
  const goods = items.reduce((s, i) => s + Number(i.unit_price || 0) * (1 - Number(i.discount_pct || 0) / 100) * Number(i.quantity || 0), 0);

  return (
    <div className="space-y-4">
      {locked && <p className="rounded-xl bg-warning/15 px-4 py-3 text-sm text-warning">Ya hay un pago aprobado: las prendas y el total no se cambian. Si el cliente pide otra prenda, se crea otra ficha.</p>}
      {!locked && (
        <Panel title="Agregar del catálogo" icon={Search}>
          <div className="relative"><Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-greige" /><input className={`${inputCls} pl-10`} placeholder="Referencia, nombre o color…" value={term} onChange={(e) => setTerm(e.target.value)} />{loading && <Loader2 size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin text-greige" />}</div>
          {results.length > 0 && (
            <ul className="mt-3 max-h-72 divide-y divide-line-soft overflow-y-auto rounded-xl border border-line">
              {results.map((p) => (
                <li key={p.id}><button type="button" onClick={() => add(p)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-accent-soft">
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg ${SOFT}`}>{p.image_url ? <img src={productImageUrl(p.image_url)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <ImageIcon size={18} className="text-greige" />}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-ink">{p.reference || p.sku}</span><span className="block truncate text-xs text-greige-ink">{p.name} {p.color ? `· ${p.color}` : ''} {p.size ? `· Talla ${p.size}` : ''}</span></span>
                  <span className="text-right"><span className="block text-sm font-bold tabular-nums text-ink">{q(p.price)}</span><span className="block text-[11px] text-greige">Stock {p.stock_quantity ?? '—'}</span></span>
                  <Plus size={16} className="text-accent" />
                </button></li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setItems((l) => [...l, { reference: '', description: '', size: '', color: '', quantity: 1, unit_price: '', discount_pct: 0 }])} className="mt-3 text-xs font-semibold text-accent hover:underline">+ Agregar una fila a mano</button>
        </Panel>
      )}
      <Panel title={`Prendas del pedido (${items.length})`} pad={false}>
        {items.length === 0 && <p className="px-5 py-8 text-center text-sm text-greige-ink">Aún no hay prendas. Búscalas arriba.</p>}
        {items.length > 0 && <div className="hidden grid-cols-[1.4fr_.7fr_.7fr_.5fr_.8fr_.6fr_auto] gap-x-3 px-5 pt-3 text-[11px] font-medium text-greige sm:grid"><span>Referencia</span><span>Talla</span><span>Color</span><span>Cant.</span><span>Precio (Q)</span><span>Desc. %</span><span className="w-9" /></div>}
        <ul className="divide-y divide-line-soft">
          {items.map((it, n) => (
            <li key={n} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-5 py-3.5 sm:grid-cols-[1.4fr_.7fr_.7fr_.5fr_.8fr_.6fr_auto]">
              <input aria-label="Referencia" placeholder="Referencia" className={inputCls} disabled={locked} value={it.reference} onChange={(e) => set(n, 'reference', e.target.value)} />
              <input aria-label="Talla" placeholder="Talla" className={inputCls} disabled={locked} value={it.size} onChange={(e) => set(n, 'size', e.target.value)} />
              <input aria-label="Color" placeholder="Color" className={inputCls} disabled={locked} value={it.color} onChange={(e) => set(n, 'color', e.target.value)} />
              <input aria-label="Cantidad" type="number" min="1" className={inputCls} disabled={locked} value={it.quantity} onChange={(e) => set(n, 'quantity', e.target.value)} />
              <input aria-label="Precio" type="number" step="0.01" min="0" className={inputCls} disabled={locked} value={it.unit_price} onChange={(e) => set(n, 'unit_price', e.target.value)} />
              <input aria-label="Descuento %" type="number" min="0" max="100" className={inputCls} disabled={locked} value={it.discount_pct} onChange={(e) => set(n, 'discount_pct', e.target.value)} />
              {!locked && <button type="button" aria-label="Quitar prenda" onClick={() => setItems((l) => l.filter((_, i) => i !== n))} className="rounded-lg p-2 text-greige hover:text-danger"><Trash2 size={16} /></button>}
            </li>
          ))}
        </ul>
        <div className="grid gap-3 border-t border-line-soft px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <FieldRow label="Envío (Q)" className="max-w-[180px]"><input className={inputCls} type="number" step="0.01" min="0" disabled={locked} value={shipping} onChange={(e) => setShipping(e.target.value)} /></FieldRow>
          <div className="text-right"><div className="text-xs text-greige-ink">Total del pedido</div><div className="text-2xl font-bold tabular-nums text-ink">{q(goods + Number(shipping || 0))}</div></div>
        </div>
      </Panel>
    </div>
  );
}

// — paso 3: entrega —
function DeliveryStep({ data, set, warehouses }) {
  const field = ([k, label]) => <FieldRow key={k} label={label}><input className={inputCls} value={data[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></FieldRow>;
  return (
    <div className="space-y-4">
      <Panel title="Tipo de pago" icon={Wallet}>
        <Segmented value={data.payment_mode} onChange={(v) => set('payment_mode', v)} options={[
          ['contado', 'Contado', 'El cliente paga el total antes del despacho.', Wallet], ['contraentrega', 'Contraentrega', 'Paga un anticipo y el saldo al recibir (guía por cobrar).', Truck]]} />
      </Panel>
      <Panel title="Cliente" icon={Check}><div className="grid gap-3 sm:grid-cols-2">{CONTACT.map(field)}</div></Panel>
      <Panel title="Entrega" icon={Truck}>
        <Segmented value={data.delivery_type} onChange={(v) => set('delivery_type', v)} options={[['domicilio', 'A domicilio', 'El paquete llega a la dirección del cliente.', Truck], ['agencia', 'En agencia', 'El cliente recoge en una agencia.', Check]]} />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{ADDRESS.map(field)}</div>
      </Panel>
      <Panel title="Origen y facturación">
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow label="Origen de las prendas"><select className={inputCls} value={data.origin_mode} onChange={(e) => set('origin_mode', e.target.value)}><option value="unica">Una sola tienda / bodega</option><option value="multiple">Varias tiendas / bodegas</option></select></FieldRow>
          <FieldRow label="Tienda(s) / bodega(s)" hint="Separa con comas si son varias"><input className={inputCls} list="wiz-warehouses" value={data.origin_warehouses} onChange={(e) => set('origin_warehouses', e.target.value)} /></FieldRow>
          <FieldRow label="Bodega de despacho"><input className={inputCls} value={data.dispatch_warehouse} onChange={(e) => set('dispatch_warehouse', e.target.value)} /></FieldRow>
          {InvoiceFields.map(field)}
          <FieldRow label="Notas" className="sm:col-span-2"><input className={inputCls} value={data.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></FieldRow>
        </div>
        <datalist id="wiz-warehouses">{(warehouses ?? []).map((w) => <option key={w} value={w} />)}</datalist>
      </Panel>
    </div>
  );
}

// — paso 4: pagos —
function PaymentsStep({ detail, onAdd }) {
  const { payments, paid } = detail;
  const covered = paid.approved + 0.001 >= paid.required;
  const declared = payments.filter((p) => p.audit_status !== 'rechazado').reduce((s, p) => s + Number(p.amount), 0);
  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><div className="text-xs text-greige-ink">Lo que se debe cubrir para pasar a Logística{detail.sheet.payment_mode === 'contraentrega' ? ` (anticipo ${detail.config.codAdvancePct}%)` : ''}</div><div className="text-2xl font-bold tabular-nums text-ink">{q(paid.required)}</div></div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${declared + 0.001 >= paid.required ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning'}`}>Declarado {q(declared)}</span>
        </div>
        {!covered && declared + 0.001 < paid.required && <p className="mt-2 text-xs text-warning">Faltan {q(paid.required - declared)} por cargar.</p>}
      </Panel>
      <div className="grid gap-3 sm:grid-cols-2">
        {payments.map((p) => (
          <div key={p.id} className="flex gap-3 rounded-2xl border border-line bg-paper p-3.5 shadow-sm">
            {p.attachment_id && <ProofThumb id={p.attachment_id} mime={p.mime_type} filename={p.filename} size="h-24 w-20" />}
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="tabular-nums text-ink">{q(p.amount)}</b><AuditPill status={p.audit_status} /></div><p className="mt-1 text-xs text-greige-ink">{METHOD_LABELS[p.method]}{p.bank ? ` · ${p.bank}` : ''}</p><p className="break-all font-mono text-[11px] text-greige-ink">ref. {p.reference_number}</p></div>
          </div>
        ))}
        <button type="button" onClick={onAdd} className="flex min-h-[112px] flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-line text-sm font-medium text-greige-ink transition hover:border-accent hover:text-accent"><Plus size={20} />Agregar pago</button>
      </div>
    </div>
  );
}

// — paso 5: revisión —
function ReviewStep({ detail }) {
  const { sheet, items, payments, missing } = detail;
  return (
    <div className="space-y-4">
      <Panel title={missing.length ? 'Falta por completar' : 'Todo listo para auditoría'} icon={missing.length ? Circle : ShieldCheck}>
        {missing.length ? <ul className="space-y-1.5">{missing.map((m) => <li key={m} className="flex items-center gap-2 text-sm text-warning"><Circle size={12} />{m}</li>)}</ul>
          : <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 size={16} />La ficha tiene todos los datos obligatorios. Al enviarla, la auditora verifica cada pago contra el banco.</p>}
      </Panel>
      <Panel title="Resumen">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-[11px] text-greige">Cliente</dt><dd className="text-ink">{sheet.full_name ?? '—'} · {sheet.phone ?? '—'}</dd></div>
          <div><dt className="text-[11px] text-greige">Entrega</dt><dd className="text-ink">{[sheet.address, sheet.city, sheet.department].filter(Boolean).join(', ') || '—'}</dd></div>
          <div><dt className="text-[11px] text-greige">Prendas</dt><dd className="text-ink">{items.length} · {items.reduce((s, i) => s + i.quantity, 0)} unidades</dd></div>
          <div><dt className="text-[11px] text-greige">Pagos</dt><dd className="text-ink">{payments.length} · {sheet.payment_mode === 'contraentrega' ? 'Contraentrega' : 'Contado'}</dd></div>
          <div><dt className="text-[11px] text-greige">Total</dt><dd className="text-lg font-bold tabular-nums text-ink">{q(sheet.total)}</dd></div>
        </dl>
      </Panel>
    </div>
  );
}

const toForm = (sheet) => ({
  payment_mode: sheet.payment_mode, delivery_type: sheet.delivery_type, origin_mode: sheet.origin_mode, dispatch_warehouse: sheet.dispatch_warehouse ?? '', origin_warehouses: (sheet.origin_warehouses ?? []).join(', '),
  notes: sheet.notes ?? '', ...Object.fromEntries([...CONTACT, ...ADDRESS, ...InvoiceFields].map(([k]) => [k, sheet[k] ?? ''])),
});

// Asistente para crear o completar una ficha: cada paso se guarda al avanzar, así que nada se pierde si se cierra.
export default function SheetWizard({ sheetId: initialId = null, onClose, onSubmitted }) {
  const [sheetId, setSheetId] = useState(initialId);
  const [detail, setDetail] = useState(null);
  const [step, setStep] = useState(initialId ? 1 : 0);
  const [maxStep, setMaxStep] = useState(initialId ? 4 : 0);
  const [form, setForm] = useState(null);
  const [items, setItems] = useState([]);
  const [shipping, setShipping] = useState(0);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState(null);

  const hydrate = useCallback((d) => {
    setDetail(d); setForm(toForm(d.sheet)); setShipping(d.sheet.shipping ?? 0);
    setItems(d.items.map((i) => ({ product_id: i.product_id, reference: i.reference, description: i.description ?? '', size: i.size, color: i.color, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct })));
  }, []);
  const load = useCallback((id) => fetchSheet(id).then(hydrate).catch((e) => setError(e.message)), [hydrate]);
  useEffect(() => { if (initialId) load(initialId); }, [initialId, load]);

  const hasApproved = detail?.payments.some((p) => p.audit_status === 'aprobado') ?? false;
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function create(customerId, quoteId) {
    setBusy(true);
    try { const s = await createSheet({ customerId, quoteId }); setSheetId(s.id); await load(s.id); setStep(1); setMaxStep(4); } catch (e) { showError(e.message); } finally { setBusy(false); }
  }

  // Guarda lo del paso actual en el servidor (si aplica) y devuelve true si se puede avanzar.
  async function saveStep() {
    try {
      if (step === 1) await updateSheet(sheetId, { data: { shipping }, ...(hasApproved ? {} : { items }) });
      if (step === 2) await updateSheet(sheetId, { data: { ...form, origin_warehouses: form.origin_warehouses.split(',').map((x) => x.trim()).filter(Boolean) } });
      if (step === 1 || step === 2) await load(sheetId);
      return true;
    } catch (e) { showError(e.message); return false; }
  }

  async function go(n) {
    if (n === step) return;
    if (sheetId && (step === 1 || step === 2)) { setBusy(true); const ok = await saveStep(); setBusy(false); if (!ok) return; } else if (sheetId && step === 3) await load(sheetId);
    setStep(n);
  }

  async function submit() {
    setBusy(true); setError(null);
    try { await runSheetStep(sheetId, 'submit', {}); showSuccess('Ficha enviada a auditoría de pago'); onSubmitted?.(sheetId); onClose(sheetId); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const ready = !!detail && !!form;
  return (
    <>
      <Drawer onClose={() => onClose(sheetId)} width="max-w-[880px]" locked={busy || paying}>
        <header className="shrink-0 border-b border-line bg-paper px-6 pb-3 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div><h2 className="text-lg font-bold tracking-tight text-ink">{initialId || sheetId ? `Ficha ${detail?.sheet.sheet_number ?? ''}` : 'Nueva ficha de pedido'}</h2><p className="text-sm text-greige-ink">Se guarda como borrador mientras avanzas.</p></div>
            <button type="button" onClick={() => onClose(sheetId)} aria-label="Cerrar" className="rounded-lg p-2 text-greige hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]"><X size={20} /></button>
          </div>
          <div className="mt-3"><Progress step={step} maxStep={maxStep} onGo={go} lockFirst={!!sheetId} /></div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && <CustomerStep onCreate={create} busy={busy} />}
          {step > 0 && !ready && !error && <div className="flex justify-center py-20 text-greige"><Loader2 className="animate-spin" /></div>}
          {step > 0 && typeof error === 'string' && <p className="text-sm text-danger">{error}</p>}
          {ready && step === 1 && <ItemsStep items={items} setItems={setItems} shipping={shipping} setShipping={setShipping} locked={hasApproved} />}
          {ready && step === 2 && <DeliveryStep data={form} set={setField} warehouses={detail.config.warehouses} />}
          {ready && step === 3 && <PaymentsStep detail={detail} onAdd={() => setPaying(true)} />}
          {ready && step === 4 && <ReviewStep detail={detail} />}
          {error && typeof error !== 'string' && (
            <div role="alert" className="mt-4 rounded-xl border border-danger/25 bg-danger-bg px-4 py-3 text-sm text-danger"><p className="font-semibold">{error.message}</p>{error.missing?.length > 0 && <ul className="mt-1 list-disc pl-4">{error.missing.map((m) => <li key={m}>{m}</li>)}</ul>}</div>
          )}
        </div>

        {step > 0 && (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-paper px-6 py-3.5">
            <GhostBtn disabled={busy || step <= 1} onClick={() => go(step - 1)}><ChevronLeft size={16} />Atrás</GhostBtn>
            <div className="flex items-center gap-2">
              <GhostBtn disabled={busy} onClick={async () => { if (step === 1 || step === 2) { setBusy(true); const ok = await saveStep(); setBusy(false); if (!ok) return; } onClose(sheetId); }}>Guardar y salir</GhostBtn>
              {step < 4
                ? <PrimaryBtn disabled={busy || !ready} onClick={() => go(step + 1)}>{busy && <Loader2 size={16} className="animate-spin" />}Siguiente<ChevronRight size={16} /></PrimaryBtn>
                : <PrimaryBtn disabled={busy || !ready || detail.missing.length > 0 || !['BORRADOR', 'OBSERVADA'].includes(detail.sheet.status)} onClick={submit}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}Enviar a auditoría</PrimaryBtn>}
            </div>
          </footer>
        )}
      </Drawer>
      <AnimatePresence>{paying && <PaymentDialog sheet={detail.sheet} onClose={() => setPaying(false)} onDone={() => { setPaying(false); load(sheetId); }} />}</AnimatePresence>
    </>
  );
}
