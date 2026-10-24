import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { X, Search, Plus, Trash2, Check, ChevronLeft, ChevronRight, Send, Loader2, ImageIcon, Wallet, Truck, CreditCard, CheckCircle2, Circle, ShieldCheck, Store, Home, Building2, StickyNote } from 'lucide-react';
import { fetchCustomers, fetchCustomerQuotes, fetchProducts, productImageUrl, createSheet, fetchSheet, updateSheet, runSheetStep, fetchChatProofs } from '../../api.js';
import { showSuccess, showError } from '../Toast.jsx';
import Avatar from '../Avatar.jsx';
import { PaymentDialog, ProofThumbStatic } from './StepDialogs.jsx';
import { Drawer, Panel, PrimaryBtn, GhostBtn, FieldRow, ProofThumb, AuditPill, TestBadge, inputCls, SOFT, METHOD_LABELS, q, fmtDT } from '../../lib/logisticsUi.jsx';

const STEPS = [['cliente', 'Cliente'], ['prendas', 'Prendas'], ['entrega', 'Entrega y datos'], ['pagos', 'Pagos'], ['revision', 'Revisión']];
const NOTE_CHIPS = ['Paga envío al recibir', 'Ya pagó envío', 'Recoge en tienda', 'No enviar factura (solicitud del cliente)', 'Pendiente datos'];
const FORM_KEYS = ['full_name', 'phone', 'phone_alt', 'email', 'dpi', 'birthday_month', 'birthday_day', 'receiver_name', 'delivery_type', 'pickup_store', 'department', 'city', 'zone', 'address', 'address_ref',
  'shipping_payment', 'payment_mode', 'dispatch_warehouse', 'notes', 'advisor_code', 'campaign', 'invoice_name', 'invoice_nit'];

// El asterisco sale de lo que el administrador marcó como obligatorio en Configuración.
const isRequired = (config, key, deliveryType) => (config?.requiredFields ?? []).includes(key) || (deliveryType !== 'tienda' && (config?.requiredForDelivery ?? []).includes(key));

function Progress({ step, maxStep, onGo, lockFirst }) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto">
      {STEPS.map(([key, label], i) => {
        const done = i < step; const now = i === step; const reachable = i <= maxStep;
        return (
          <li key={key} className="flex items-center gap-1">
            <button type="button" disabled={!reachable || (i === 0 && lockFirst)} onClick={() => onGo(i)} aria-current={now ? 'step' : undefined}
              className={`flex items-center gap-2 whitespace-nowrap rounded-full py-1.5 pl-1.5 pr-3.5 text-sm font-semibold transition ${now ? 'bg-accent text-white' : done ? 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]' : 'text-greige'} disabled:cursor-not-allowed`}>
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] ${now ? 'bg-white/25' : done ? 'bg-success text-white' : SOFT}`}>{done ? <Check size={13} strokeWidth={3} /> : i + 1}</span>{label}
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-3 bg-line" />}
          </li>
        );
      })}
    </ol>
  );
}

function Segmented({ value, onChange, options, cols = 2 }) {
  return (
    <div className={`grid gap-2 ${cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      {options.map(([v, title, text, Icon]) => (
        <button type="button" key={v} onClick={() => onChange(v)} aria-pressed={value === v} className={`flex items-start gap-3 rounded-xl border-2 p-3.5 text-left transition ${value === v ? 'border-accent bg-accent-soft' : 'border-line hover:border-greige'}`}>
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${value === v ? 'bg-accent text-white' : `${SOFT} text-greige-ink`}`}><Icon size={17} /></span>
          <span><span className="block text-sm font-semibold text-ink">{title}</span><span className="block text-xs text-greige-ink">{text}</span></span>
        </button>
      ))}
    </div>
  );
}

const Option = ({ checked, onClick, title, text }) => (
  <button type="button" onClick={onClick} aria-pressed={checked} className={`flex w-full items-center gap-3 rounded-xl border-2 px-3.5 py-3 text-left transition ${checked ? 'border-accent bg-accent-soft' : 'border-line hover:border-greige'}`}>
    {checked ? <CheckCircle2 size={18} className="shrink-0 text-accent" /> : <Circle size={18} className="shrink-0 text-greige" />}
    <span className="min-w-0"><span className="block text-sm font-semibold text-ink">{title}</span><span className="block truncate text-xs text-greige-ink">{text}</span></span>
  </button>
);

// — paso 1: cliente y cotización —
function CustomerStep({ onCreate, busy, initialCustomer = null }) {
  const [isTest, setIsTest] = useState(false);
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
  // Desde el chat el cliente ya viene elegido y se propone su cotización más reciente (la asesora puede cambiarla o quitarla).
  const chosen = quotes.find((x) => x.id === quoteId) ?? null;
  const pick = (c, preselect = false) => {
    setCustomer(c); setQuoteId(null);
    fetchCustomerQuotes(c.id).then((qs) => { setQuotes(qs); if (preselect && qs.length) setQuoteId([...qs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0].id); }).catch(() => setQuotes([]));
  };
  useEffect(() => { if (initialCustomer) pick(initialCustomer, true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
              {!initialCustomer && <button type="button" onClick={() => { setCustomer(null); setQuotes([]); }} className="text-xs font-semibold text-accent hover:underline">Cambiar</button>}</div>
          </Panel>
          <Panel title="¿Parte de una cotización?" icon={CreditCard}>
            <div className="space-y-2">
              <Option checked={quoteId === null} onClick={() => setQuoteId(null)} title="Sin cotización" text="Agrego las prendas desde el catálogo." />
              {quotes.map((qt) => <Option key={qt.id} checked={quoteId === qt.id} onClick={() => setQuoteId(qt.id)} title={`${qt.quoteNumber} · ${q(qt.grandTotal)}`} text={`${qt.items.length} prenda(s) · ${fmtDT(qt.createdAt)} · ${qt.advisorName ?? ''}`} />)}
            </div>
          </Panel>
          {chosen && (
            <Panel title={`Lo que lleva la cotización ${chosen.quoteNumber}`} icon={CheckCircle2}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] text-left text-sm">
                  <thead><tr className="text-[11px] uppercase tracking-wide text-greige"><th className="py-1.5 pr-3 font-semibold">Referencia</th><th className="py-1.5 pr-3 font-semibold">Prenda</th><th className="py-1.5 pr-3 font-semibold">Talla / color</th><th className="py-1.5 pr-3 text-right font-semibold">Cant.</th><th className="py-1.5 text-right font-semibold">Precio</th></tr></thead>
                  <tbody>{chosen.items.map((it) => <tr key={it.id} className="border-t border-line-soft"><td className="py-2 pr-3 font-mono text-xs">{it.sku}</td><td className="py-2 pr-3 text-ink">{it.name}</td><td className="py-2 pr-3 text-greige-ink">{[it.size, it.color].filter(Boolean).join(' · ') || '—'}</td><td className="py-2 pr-3 text-right tabular-nums">{it.quantity}</td><td className="py-2 text-right font-semibold tabular-nums">{q(it.final_price ?? it.unit_price)}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="mt-2 flex justify-end gap-4 text-sm"><span className="text-greige-ink">Total de la cotización</span><b className="tabular-nums text-ink">{q(chosen.grandTotal)}</b></div>
              <p className="mt-1 text-xs text-greige">Estas prendas pasan a la ficha; en el paso siguiente puedes ajustarlas y elegir la tienda de cada una.</p>
            </Panel>
          )}
          <Panel title="¿Es una ficha de prueba?" icon={StickyNote}>
            <button type="button" role="checkbox" aria-checked={isTest} onClick={() => setIsTest((v) => !v)} className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-sm transition ${isTest ? 'border-accent bg-accent-soft' : 'border-line hover:border-greige'}`}>
              {isTest ? <CheckCircle2 size={18} className="mt-px shrink-0 text-accent" /> : <Circle size={18} className="mt-px shrink-0 text-greige" />}
              <span><span className="block font-semibold text-ink">Crearla de prueba</span><span className="block text-xs text-greige-ink">Se marca como PRUEBA y tú (o el administrador) la puedes eliminar por completo en cualquier momento. Una ficha real nunca se borra, solo se cancela. Esta decisión no se puede cambiar después.</span></span>
            </button>
          </Panel>
          <div className="flex justify-end"><PrimaryBtn disabled={busy} onClick={() => onCreate(customer.id, quoteId, isTest)}>{busy ? <Loader2 size={16} className="animate-spin" /> : null}Crear borrador y continuar<ChevronRight size={16} /></PrimaryBtn></div>
        </>
      )}
    </div>
  );
}

// — paso 2: prendas, cada una con su tienda de origen —
function ItemsStep({ items, setItems, warehouses, locked }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [allStore, setAllStore] = useState('');
  useEffect(() => {
    if (term.trim().length < 2) { setResults([]); return undefined; }
    setLoading(true);
    const t = setTimeout(() => fetchProducts(term).then(setResults).catch(() => setResults([])).finally(() => setLoading(false)), 350);
    return () => clearTimeout(t);
  }, [term]);
  const add = (p) => { setItems((l) => [...l, { product_id: p.id, reference: String(p.reference || p.sku || ''), description: p.name ?? '', size: p.size ?? '', color: p.color ?? '', quantity: 1, unit_price: Number(p.price) || 0, discount_pct: Number(p.discount_pct) || 0, origin_warehouse: '' }]); setTerm(''); setResults([]); };
  const set = (n, k, v) => setItems((l) => l.map((it, i) => (i === n ? { ...it, [k]: v } : it)));
  const goods = items.reduce((s, i) => s + Number(i.unit_price || 0) * (1 - Number(i.discount_pct || 0) / 100) * Number(i.quantity || 0), 0);
  const stores = new Set(items.map((i) => String(i.origin_warehouse ?? '').trim().toLowerCase()).filter(Boolean));
  const COLS = 'sm:grid-cols-[1.3fr_.55fr_.7fr_.45fr_.75fr_.55fr_1fr_auto]';

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
          <button type="button" onClick={() => setItems((l) => [...l, { reference: '', description: '', size: '', color: '', quantity: 1, unit_price: '', discount_pct: 0, origin_warehouse: '' }])} className="mt-3 text-xs font-semibold text-accent hover:underline">+ Agregar una fila a mano</button>
        </Panel>
      )}
      <Panel title={`Prendas del pedido (${items.length})`} pad={false}
        right={!locked && items.length > 1 && (
          <span className="flex items-center gap-1.5"><input list="wiz-stores" className={`${inputCls} !w-36 !py-1.5 !text-xs`} placeholder="Tienda para todas" value={allStore} onChange={(e) => setAllStore(e.target.value)} />
            <button type="button" disabled={!allStore.trim()} onClick={() => { setItems((l) => l.map((i) => ({ ...i, origin_warehouse: allStore.trim() }))); setAllStore(''); }} className="text-xs font-semibold text-accent disabled:opacity-40">Aplicar</button></span>
        )}>
        {items.length === 0 && <p className="px-5 py-8 text-center text-sm text-greige-ink">Aún no hay prendas. Búscalas arriba.</p>}
        {items.length > 0 && <div className={`hidden grid-cols-[1.3fr_.55fr_.7fr_.45fr_.75fr_.55fr_1fr_auto] gap-x-3 px-5 pt-3 text-[11px] font-medium text-greige sm:grid`}><span>Referencia</span><span>Talla</span><span>Color</span><span>Cant.</span><span>Precio (Q)</span><span>Desc. %</span><span>Tienda de origen</span><span className="w-9" /></div>}
        <ul className="divide-y divide-line-soft">
          {items.map((it, n) => (
            <li key={n} className={`grid grid-cols-2 items-center gap-x-3 gap-y-2 px-5 py-3.5 ${COLS}`}>
              <input aria-label="Referencia" placeholder="Referencia" className={`${inputCls} col-span-2 sm:col-span-1`} disabled={locked} value={it.reference} onChange={(e) => set(n, 'reference', e.target.value)} />
              <input aria-label="Talla" placeholder="Talla" className={inputCls} disabled={locked} value={it.size} onChange={(e) => set(n, 'size', e.target.value)} />
              <input aria-label="Color" placeholder="Color" className={inputCls} disabled={locked} value={it.color} onChange={(e) => set(n, 'color', e.target.value)} />
              <input aria-label="Cantidad" type="number" min="1" className={inputCls} disabled={locked} value={it.quantity} onChange={(e) => set(n, 'quantity', e.target.value)} />
              <input aria-label="Precio" type="number" step="0.01" min="0" className={inputCls} disabled={locked} value={it.unit_price} onChange={(e) => set(n, 'unit_price', e.target.value)} />
              <input aria-label="Descuento %" type="number" min="0" max="100" className={inputCls} disabled={locked} value={it.discount_pct} onChange={(e) => set(n, 'discount_pct', e.target.value)} />
              <input aria-label="Tienda de origen" list="wiz-stores" placeholder="Tienda de origen" className={inputCls} disabled={locked} value={it.origin_warehouse ?? ''} onChange={(e) => set(n, 'origin_warehouse', e.target.value)} />
              {!locked && <button type="button" aria-label="Quitar prenda" onClick={() => setItems((l) => l.filter((_, i) => i !== n))} className="rounded-lg p-2 text-greige hover:text-danger"><Trash2 size={16} /></button>}
            </li>
          ))}
        </ul>
        <datalist id="wiz-stores">{(warehouses ?? []).map((w) => <option key={w} value={w} />)}</datalist>
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line-soft px-5 py-4">
          <p className="max-w-sm text-xs text-greige-ink">{stores.size > 1 ? `Sale de ${stores.size} tiendas: se pedirán ${stores.size} traslados (TR).` : stores.size === 1 ? 'Sale de una sola tienda: se pide 1 traslado (TR).' : 'Indica de qué tienda sale cada prenda según el stock: de ahí salen los traslados.'}</p>
          <div className="text-right"><div className="text-xs text-greige-ink">Total del pedido (el flete va aparte)</div><div className="text-2xl font-bold tabular-nums text-ink">{q(goods)}</div></div>
        </div>
      </Panel>
    </div>
  );
}

// — paso 3: entrega y datos, en el orden de la ficha de papel —
function DeliveryStep({ data, set, config, transfers }) {
  const req = (k) => (isRequired(config, k, data.delivery_type) ? ' *' : '');
  const text = (k, label, props = {}) => <FieldRow key={k} label={`${label}${req(k)}`} className={props.className}><input className={inputCls} value={data[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props.input} /></FieldRow>;
  const pickup = data.delivery_type === 'tienda';
  return (
    <div className="space-y-4">
      <Panel title="Datos del cliente" icon={Check}>
        <div className="grid gap-3 sm:grid-cols-2">
          {text('full_name', 'Nombre y apellidos')}{text('phone', 'Teléfono')}
          {text('dpi', 'DPI')}{text('email', 'Correo')}
          {text('phone_alt', 'Teléfono alterno')}{text('receiver_name', 'Quién recibe (si es otra persona)')}
          <FieldRow label="Cumpleaños (mes y día)"><span className="flex gap-2"><input className={inputCls} placeholder="Mes" value={data.birthday_month ?? ''} onChange={(e) => set('birthday_month', e.target.value)} /><input className={inputCls} placeholder="Día" value={data.birthday_day ?? ''} onChange={(e) => set('birthday_day', e.target.value)} /></span></FieldRow>
        </div>
      </Panel>

      <Panel title="¿Cómo recibe el pedido?" icon={Truck}>
        <Segmented cols={3} value={data.delivery_type} onChange={(v) => set('delivery_type', v)} options={[
          ['domicilio', 'A domicilio', 'Llega a su dirección.', Home], ['agencia', 'En agencia', 'Lo recoge en una agencia de la paquetería.', Building2], ['tienda', 'Recoge en tienda', 'Según el stock, en una de nuestras tiendas.', Store]]} />
        {pickup ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <FieldRow label="Tienda donde recoge *" hint="Se coordina con el cliente según dónde esté el stock. Ahí se reúne el pedido."><input list="wiz-pickup" className={inputCls} value={data.pickup_store ?? ''} onChange={(e) => set('pickup_store', e.target.value)} /></FieldRow>
            <datalist id="wiz-pickup">{(config?.warehouses ?? []).map((w) => <option key={w} value={w} />)}</datalist>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {text('department', 'Departamento')}{text('city', 'Ciudad')}
            {text('zone', 'Zona')}{text('address_ref', 'Vereda o referencia')}
            {text('address', 'Dirección', { className: 'sm:col-span-2' })}
          </div>
        )}
      </Panel>

      {!pickup && (
        <Panel title="Flete" icon={Truck}>
          <p className="mb-3 text-xs text-greige-ink">El flete no entra en el total del pedido. Indica quién lo paga.</p>
          <Segmented value={data.shipping_payment} onChange={(v) => set('shipping_payment', v)} options={[
            ['al_recibir', 'Paga al recibir', 'El cliente se lo paga a la paquetería en la entrega.', Wallet], ['pagado', 'Ya pagó el flete', 'Viene dentro de los pagos que cargues.', CheckCircle2]]} />
          <FieldRow label="Monto del flete (Q)" className="mt-3 max-w-[200px]"><input className={inputCls} type="number" step="0.01" min="0" value={data.shipping} onChange={(e) => set('shipping', e.target.value)} /></FieldRow>
        </Panel>
      )}

      {config?.allowCodGoods && (
        <Panel title="Tipo de pago del pedido" icon={Wallet}>
          <Segmented value={data.payment_mode} onChange={(v) => set('payment_mode', v)} options={[
            ['contado', 'Contado', 'El cliente paga el pedido antes del despacho.', Wallet], ['contraentrega', 'Contraentrega', 'Paga un anticipo y el saldo al recibir.', Truck]]} />
        </Panel>
      )}

      <Panel title="Observaciones del cliente" icon={StickyNote}>
        <p className="mb-2 text-xs text-greige-ink">Lo que pide el cliente y logística debe saber (lo que hoy va resaltado en amarillo en la ficha).</p>
        <textarea rows={3} className={inputCls} value={data.notes ?? ''} onChange={(e) => set('notes', e.target.value)} placeholder="Ej. Recoge en Oakland · No enviar factura · Entregar en recepción" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {NOTE_CHIPS.map((c) => <button type="button" key={c} onClick={() => set('notes', [data.notes, c].filter(Boolean).join('. '))} className={`rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-greige-ink transition hover:border-accent hover:text-accent`}>+ {c}</button>)}
        </div>
      </Panel>

      <Panel title="Despacho y otros datos">
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow label="Bodega de despacho" hint={pickup ? 'Es la tienda donde recoge.' : 'Desde donde sale el paquete.'}><input className={inputCls} disabled={pickup} value={pickup ? data.pickup_store ?? '' : data.dispatch_warehouse ?? ''} onChange={(e) => set('dispatch_warehouse', e.target.value)} /></FieldRow>
          <FieldRow label="Traslados (TR)"><span className={`flex min-h-[42px] items-center rounded-xl px-3.5 text-sm text-ink ${SOFT}`}>{transfers.length ? `${transfers.length} · ${transfers.map((t) => t.store).join(', ')}` : 'Se calculan con la tienda de cada prenda'}</span></FieldRow>
          {text('advisor_code', 'Código de vendedora')}{text('invoice_name', 'Nombre para la factura')}
          {text('invoice_nit', 'NIT')}{text('campaign', 'Campaña')}
        </div>
      </Panel>
    </div>
  );
}

// — paso 4: pagos —
function PaymentsStep({ detail, onAdd }) {
  const { payments, paid, sheet } = detail;
  // Comprobantes que el cliente mandó por el chat y todavía no respaldan un pago de esta ficha: un clic y el pago nace con su comprobante y el monto leído.
  const [proofs, setProofs] = useState([]);
  useEffect(() => { fetchChatProofs(sheet.customer_id).then((r) => setProofs(r.proofs)).catch(() => {}); }, [sheet.customer_id]);
  const used = new Set(payments.map((p) => p.attachment_id));
  const suggested = proofs.filter((p) => !used.has(p.id)).sort((a, b) => (b.ocr_amount != null) - (a.ocr_amount != null)).slice(0, 8);
  const declared = payments.filter((p) => p.audit_status !== 'rechazado').reduce((s, p) => s + Number(p.amount), 0);
  const withFreight = paid.required > Number(sheet.total) + 0.001;
  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><div className="text-xs text-greige-ink">Lo que se debe cubrir para pasar a Logística{sheet.payment_mode === 'contraentrega' ? ` (anticipo ${detail.config.codAdvancePct}%)` : ''}</div><div className="text-2xl font-bold tabular-nums text-ink">{q(paid.required)}</div>
            {withFreight && <div className="text-xs text-greige">Pedido {q(sheet.total)} + flete ya pagado {q(sheet.shipping)}</div>}
            {sheet.shipping_payment === 'al_recibir' && <div className="text-xs text-greige">El flete ({q(sheet.shipping)}) se paga al recibir: no va en estos pagos.</div>}</div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${declared + 0.001 >= paid.required ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning'}`}>Declarado {q(declared)}</span>
        </div>
        {declared + 0.001 < paid.required && <p className="mt-2 text-xs text-warning">Faltan {q(paid.required - declared)} por cargar.</p>}
      </Panel>
      {suggested.length > 0 && (
        <Panel title="Comprobantes del chat" icon={ImageIcon}>
          <p className="mb-2 text-xs text-greige-ink">Lo que mandó el cliente o reenvió la asesora (marcado "Asesora"). Toca uno para agregarlo como pago; el monto sobre la imagen es lo que leyó el sistema, confírmalo.</p>
          <div className="flex flex-wrap gap-2">
            {suggested.map((p) => (
              <button key={p.id} type="button" onClick={() => onAdd({ chatId: p.id, amount: p.ocr_amount ?? '' })} title={fmtDT(p.created_at)} className="block rounded-xl ring-2 ring-transparent transition hover:ring-accent"><ProofThumbStatic id={p.id} mime={p.mime_type} ocr={p.ocr_amount} fromAdvisor={p.from_advisor} /></button>
            ))}
          </div>
        </Panel>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {payments.map((p) => (
          <div key={p.id} className="flex gap-3 rounded-2xl border border-line bg-paper p-3.5 shadow-sm">
            {p.attachment_id && <ProofThumb id={p.attachment_id} mime={p.mime_type} filename={p.filename} size="h-24 w-20" />}
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="tabular-nums text-ink">{q(p.amount)}</b><AuditPill status={p.audit_status} /></div><p className="mt-1 text-xs text-greige-ink">{METHOD_LABELS[p.method]}{p.bank ? ` · ${p.bank}` : ''}</p><p className="break-all font-mono text-[11px] text-greige-ink">ref. {p.reference_number}</p>{p.platform_verified && <p className="mt-1 flex items-center gap-1 text-[11px] text-success"><ShieldCheck size={11} />Verificado en NeoLink</p>}</div>
          </div>
        ))}
        <button type="button" onClick={() => onAdd()} className="flex min-h-[112px] flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-line text-sm font-medium text-greige-ink transition hover:border-accent hover:text-accent"><Plus size={20} />Agregar pago</button>
      </div>
    </div>
  );
}

// — paso 5: revisión —
function ReviewStep({ detail }) {
  const { sheet, items, payments, missing, transfers } = detail;
  const way = { domicilio: 'A domicilio', agencia: 'En agencia', tienda: `Recoge en ${sheet.pickup_store ?? 'tienda'}` }[sheet.delivery_type];
  return (
    <div className="space-y-4">
      <Panel title={missing.length ? 'Falta por completar' : 'Todo listo para auditoría'} icon={missing.length ? Circle : ShieldCheck}>
        {missing.length ? <ul className="space-y-1.5">{missing.map((m) => <li key={m} className="flex items-center gap-2 text-sm text-warning"><Circle size={12} />{m}</li>)}</ul>
          : <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 size={16} />La ficha tiene todos los datos obligatorios. Al enviarla, la auditora verifica cada pago contra el banco.</p>}
      </Panel>
      <Panel title="Resumen">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-[11px] text-greige">Cliente</dt><dd className="text-ink">{sheet.full_name ?? '—'} · {sheet.phone ?? '—'}</dd></div>
          <div><dt className="text-[11px] text-greige">Entrega</dt><dd className="text-ink">{way}{sheet.delivery_type !== 'tienda' && [sheet.address, sheet.department].filter(Boolean).length ? ` · ${[sheet.address, sheet.department].filter(Boolean).join(', ')}` : ''}</dd></div>
          <div><dt className="text-[11px] text-greige">Prendas</dt><dd className="text-ink">{items.length} · {items.reduce((s, i) => s + i.quantity, 0)} unidades</dd></div>
          <div><dt className="text-[11px] text-greige">Traslados</dt><dd className="text-ink">{transfers.length} · {transfers.map((t) => t.store).join(', ') || '—'}</dd></div>
          <div><dt className="text-[11px] text-greige">Pagos</dt><dd className="text-ink">{payments.length}</dd></div>
          <div><dt className="text-[11px] text-greige">Flete</dt><dd className="text-ink">{sheet.delivery_type === 'tienda' ? 'Sin envío' : `${q(sheet.shipping)} · ${sheet.shipping_payment === 'al_recibir' ? 'se paga al recibir' : 'ya pagado'}`}</dd></div>
          <div><dt className="text-[11px] text-greige">Total del pedido</dt><dd className="text-lg font-bold tabular-nums text-ink">{q(sheet.total)}</dd></div>
          {sheet.notes && <div className="sm:col-span-2"><dt className="text-[11px] text-greige">Observaciones</dt><dd className="rounded-lg bg-yellow-300/25 px-3 py-2 text-ink">{sheet.notes}</dd></div>}
        </dl>
      </Panel>
    </div>
  );
}

const toForm = (sheet) => ({
  ...Object.fromEntries(FORM_KEYS.map((k) => [k, sheet[k] ?? ''])),
  shipping: sheet.shipping ?? 0,
});
const toItems = (d) => d.items.map((i) => ({ product_id: i.product_id, reference: i.reference, description: i.description ?? '', size: i.size, color: i.color, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct, origin_warehouse: i.origin_warehouse ?? '' }));

// Asistente para crear o completar una ficha: cada paso se guarda al avanzar, así que nada se pierde si se cierra.
export default function SheetWizard({ sheetId: initialId = null, customer = null, onClose }) {
  const [sheetId, setSheetId] = useState(initialId);
  const [detail, setDetail] = useState(null);
  const [step, setStep] = useState(initialId ? 1 : 0);
  const [maxStep, setMaxStep] = useState(initialId ? 4 : 0);
  const [form, setForm] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState(null);

  const hydrate = useCallback((d) => { setDetail(d); setForm(toForm(d.sheet)); setItems(toItems(d)); }, []);
  const load = useCallback((id) => fetchSheet(id).then(hydrate).catch((e) => setError(e.message)), [hydrate]);
  useEffect(() => { if (initialId) load(initialId); }, [initialId, load]);

  const hasApproved = detail?.payments.some((p) => p.audit_status === 'aprobado') ?? false;
  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const liveTransfers = (() => { const m = new Map(); for (const i of items) { const n = String(i.origin_warehouse ?? '').trim(); if (n) m.set(n.toLowerCase(), { store: n }); } return [...m.values()]; })();

  async function create(customerId, quoteId, isTest) {
    setBusy(true);
    try { const s = await createSheet({ customerId, quoteId, isTest }); setSheetId(s.id); await load(s.id); setStep(1); setMaxStep(4); } catch (e) { showError(e.message); } finally { setBusy(false); }
  }

  // Guarda lo del paso actual en el servidor (si aplica) y devuelve true si se puede avanzar.
  async function saveStep() {
    try {
      if (step === 1 && !hasApproved) await updateSheet(sheetId, { data: {}, items });
      if (step === 2) await updateSheet(sheetId, { data: { ...form, shipping: form.delivery_type === 'tienda' ? 0 : Number(form.shipping || 0) } });
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
    try { await runSheetStep(sheetId, 'submit', {}); showSuccess('Ficha enviada a auditoría de pago'); onClose(sheetId); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const ready = !!detail && !!form;
  return (
    <>
      <Drawer onClose={() => onClose(sheetId)} width="max-w-[900px]" locked={busy || paying}>
        <header className="shrink-0 border-b border-line bg-paper px-6 pb-3 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div><h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-ink">{sheetId ? `Ficha ${detail?.sheet.sheet_number ?? ''}` : 'Nueva ficha de pedido'}{detail?.sheet.is_test && <TestBadge />}</h2><p className="text-sm text-greige-ink">Se guarda como borrador mientras avanzas.</p></div>
            <button type="button" onClick={() => onClose(sheetId)} aria-label="Cerrar" className="rounded-lg p-2 text-greige hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]"><X size={20} /></button>
          </div>
          <div className="mt-3"><Progress step={step} maxStep={maxStep} onGo={go} lockFirst={!!sheetId} /></div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && <CustomerStep onCreate={create} busy={busy} initialCustomer={customer} />}
          {step > 0 && !ready && !error && <div className="flex justify-center py-20 text-greige"><Loader2 className="animate-spin" /></div>}
          {step > 0 && typeof error === 'string' && <p className="text-sm text-danger">{error}</p>}
          {ready && step === 1 && <ItemsStep items={items} setItems={setItems} warehouses={detail.config.warehouses} locked={hasApproved} />}
          {ready && step === 2 && <DeliveryStep data={form} set={setField} config={detail.config} transfers={liveTransfers} />}
          {ready && step === 3 && <PaymentsStep detail={detail} onAdd={(preset) => setPaying(preset ?? true)} />}
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
      <AnimatePresence>{paying && <PaymentDialog sheet={detail.sheet} preset={typeof paying === 'object' ? paying : null} onClose={() => setPaying(false)} onDone={() => { setPaying(false); load(sheetId); }} />}</AnimatePresence>
    </>
  );
}
