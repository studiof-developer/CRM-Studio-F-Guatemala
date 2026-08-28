import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, CircleDollarSign, MessageSquareWarning, MapPin, ShoppingBag, Phone, Mail, CreditCard, Calendar, Package, Pencil, Clock } from 'lucide-react';
import { fetchCustomerCounts, fetchCustomers, fetchCustomer, updateCustomerTags } from './api.js';
import { TEMP_META, BUCKET_ORDER } from './lib/temperature.js';
import { PAID_METHOD_LABELS, PAID_METHOD_ICONS, PAID_METHOD_ORDER } from './lib/paymentMethods.js';
import { useLiveEvent } from './lib/liveEvents.js';
import Avatar from './components/Avatar.jsx';
import Badge from './components/Badge.jsx';
import Select from './components/Select.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import EditCustomerModal from './components/EditCustomerModal.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

const MANUAL_STATUS_OPTIONS = [
  { value: '', label: 'Automático' },
  ...BUCKET_ORDER.map((k) => ({ value: k, label: TEMP_META[k].label, icon: TEMP_META[k].icon, iconClassName: TEMP_META[k].iconText })),
];

const PAID_METHOD_OPTIONS = PAID_METHOD_ORDER.map((k) => ({
  value: k, label: PAID_METHOD_LABELS[k], icon: PAID_METHOD_ICONS[k], iconClassName: 'text-greige-ink',
}));

export default function Customers() {
  const [counts, setCounts] = useState({});
  const [search, setSearch] = useState('');
  const [temperature, setTemperature] = useState('');
  const [customers, setCustomers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirmPaidOpen, setConfirmPaidOpen] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [paidMethod, setPaidMethod] = useState('');
  const [editOpen, setEditOpen] = useState(false);

  const loadCounts = useCallback(() => {
    fetchCustomerCounts().then(setCounts).catch(() => {});
  }, []);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setCustomers(await fetchCustomers(search, temperature));
    } catch (err) {
      setError(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [search, temperature]);

  useEffect(() => { load(); }, [load]);

  const loadQuiet = useCallback(() => load(false), [load]);
  useLiveEvent('ticket_changes', loadQuiet);

  // SSE is the fast path — this is just a safety net in case that connection silently drops.
  useEffect(() => {
    const id = setInterval(() => load(false), 30000);
    return () => clearInterval(id);
  }, [load]);

  const reloadDetail = useCallback(() => {
    if (!selectedId) { setDetail(null); return; }
    fetchCustomer(selectedId).then(setDetail).catch((err) => setError(err.message));
  }, [selectedId]);

  useEffect(() => { reloadDetail(); }, [reloadDetail]);
  useLiveEvent('ticket_changes', reloadDetail);

  async function handleSetStatus(value) {
    try {
      await updateCustomerTags(selectedId, { manualStatus: value || null });
      reloadDetail();
      loadCounts();
      load(false);
      showSuccess(value ? `Estado cambiado a ${TEMP_META[value].label}` : 'Estado devuelto a automático');
    } catch (err) {
      showError(err.message);
    }
  }

  async function handleMarkPaid() {
    if (!paidMethod) return;
    setMarkingPaid(true);
    try {
      await updateCustomerTags(selectedId, { paidLocked: true, paidMethod });
      reloadDetail();
      loadCounts();
      load(false);
      showSuccess('Cliente marcado como Pagado');
    } catch (err) {
      showError(err.message);
    } finally {
      setMarkingPaid(false);
      setConfirmPaidOpen(false);
      setPaidMethod('');
    }
  }

  const detailTemp = detail ? TEMP_META[detail.temperature] : null;

  return (
    <div className="flex h-full min-w-0 overflow-hidden rounded-3xl">
      {/* List column scrolls on its own — header/search/filter stay put. */}
      <div className="flex w-[360px] max-w-[45vw] shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-4">
          <h1 className="mb-3 text-lg font-semibold text-ink">Clientes</h1>
          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-greige" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o número"
              className="w-full rounded-full border border-line bg-black/[0.03] dark:bg-white/[0.05] py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent focus:bg-paper"
            />
          </div>
          <Select
            value={temperature}
            onChange={setTemperature}
            options={[
              { value: '', label: 'Todos los estados' },
              ...BUCKET_ORDER.map((k) => ({
                value: k, label: TEMP_META[k].label, icon: TEMP_META[k].icon, iconClassName: TEMP_META[k].iconText, meta: counts[k] ?? 0,
              })),
            ]}
          />
        </div>

        <div className="relative flex-1 overflow-y-auto">
          <AnimatePresence>
            {loading && (
              <motion.span
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15 }}
                className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-line bg-paper px-3 py-1 text-[11px] font-medium text-greige-ink shadow-sm"
              >
                Cargando…
              </motion.span>
            )}
          </AnimatePresence>
          {error && <p className="p-4 text-sm text-danger">{error}</p>}
          {!loading && customers.length === 0 && (
            <p className="p-4 text-sm text-greige-ink">Ningún cliente coincide.</p>
          )}
          <ul className="flex flex-col gap-2 p-3">
            {customers.map((c) => {
              const name = c.full_name || c.whatsapp_number;
              const temp = TEMP_META[c.temperature];
              return (
                <li
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-all ${
                    c.id === selectedId
                      ? 'border-accent bg-accent-soft shadow-sm'
                      : 'border-line-soft bg-paper hover:border-line hover:shadow-sm'
                  }`}
                >
                  <Avatar name={name} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{name}</p>
                    <p className="truncate text-xs text-greige-ink">{c.whatsapp_number}</p>
                  </div>
                  {temp && (
                    <span className={`flex shrink-0 items-center gap-1 rounded-full bg-black/[0.03] dark:bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold ${temp.iconText}`}>
                      <temp.icon size={10} /> {temp.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Detail column scrolls independently. */}
      <section className="flex-1 overflow-y-auto p-8">
        {!detail && (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center text-sm text-greige-ink">
            Selecciona un cliente para ver su perfil.
          </div>
        )}
        {detail && (
          <>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <Avatar name={detail.full_name || detail.whatsapp_number} size={44} />
                <div>
                  <h2 className="flex items-center gap-2 text-xl font-semibold text-ink">
                    {detail.full_name || detail.whatsapp_number}
                    <button
                      onClick={() => setEditOpen(true)}
                      className="rounded-lg p-1 text-greige transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-ink"
                      aria-label="Editar cliente"
                      title="Editar cliente"
                    >
                      <Pencil size={14} />
                    </button>
                  </h2>
                  <p className="flex items-center gap-1.5 text-sm text-greige-ink">
                    <Phone size={13} /> {detail.whatsapp_number}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <Badge variant={detailTemp.variant}>{detailTemp.label}</Badge>
                  {detail.paid_locked && detail.temperature !== 'pagado' && (
                    <Badge variant={TEMP_META.pagado.variant}>{TEMP_META.pagado.label}</Badge>
                  )}
                </div>
                {detail.paid_locked && detail.paid_method && (
                  <p className="text-xs text-greige-ink">Pagó por {PAID_METHOD_LABELS[detail.paid_method]}</p>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] p-3">
              <label className="shrink-0 text-xs font-medium text-greige-ink">Estado (control del asesor):</label>
              <Select value={detail.manual_status ?? ''} onChange={handleSetStatus} options={MANUAL_STATUS_OPTIONS} className="w-48" />
              {!detail.paid_locked && (
                <button
                  onClick={() => setConfirmPaidOpen(true)}
                  className="ml-auto rounded-lg border border-success-bg bg-success-bg/50 px-2.5 py-1 text-xs font-semibold text-success transition-colors hover:bg-success-bg"
                >
                  Marcar como Pagado
                </button>
              )}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-5 border-y border-line py-6">
              <InfoRow icon={Mail} label="Correo" value={detail.email || '—'} />
              <InfoRow icon={CreditCard} label="DPI" value={detail.dpi || '—'} />
              <InfoRow icon={MapPin} label="Departamento" value={detail.department || '—'} />
              <InfoRow icon={MapPin} label="Municipio" value={detail.municipio || '—'} />
              <InfoRow icon={MapPin} label="Dirección" value={detail.address || '—'} />
              <InfoRow icon={ShoppingBag} label="Línea preferida" value={detail.preferred_line || '—'} />
              <InfoRow icon={ShoppingBag} label="Talla" value={detail.preferred_size || '—'} />
              <InfoRow icon={Calendar} label="Fecha de nacimiento" value={detail.birth_date ? new Date(detail.birth_date).toLocaleDateString('es-GT', { timeZone: 'UTC' }) : '—'} />
              <InfoRow icon={Package} label="Estado de compra" value={detail.purchase_status || '—'} />
              <InfoRow icon={CircleDollarSign} label="Compras totales" value={detail.purchase_frequency} />
              <InfoRow icon={MessageSquareWarning} label="Conversaciones" value={detail.conversationSessionIds.length} />
            </div>

            {/* Only shows up when this phone matches a real purchase record in the ERP —
                a customer who's only ever chatted, never bought, just doesn't get this
                section, same profile as before this existed. */}
            {detail.erp && (
              <div className="border-b border-line py-6">
                <div className="mb-3 flex items-center gap-1.5">
                  <span className="flex items-center gap-1 rounded-full bg-cyan-bg px-2 py-0.5 text-[10px] font-semibold text-cyan">
                    <CircleDollarSign size={10} /> Cliente ERP
                  </span>
                  <p className="truncate text-xs text-greige-ink">{detail.erp.nombre}</p>
                </div>
                <div className="grid grid-cols-2 gap-5">
                  <InfoRow icon={CircleDollarSign} label="Venta total histórica" value={detail.erp.ventaNetaTotal != null ? `Q${Number(detail.erp.ventaNetaTotal).toLocaleString('es-GT')}` : '—'} />
                  <InfoRow icon={ShoppingBag} label="Facturas / unidades" value={`${detail.erp.facturasTotales ?? 0} facturas · ${detail.erp.unidadesTotales ?? 0} unidades`} />
                  <InfoRow icon={Clock} label="Última compra" value={detail.erp.fechaUltimaCompra ? `${new Date(detail.erp.fechaUltimaCompra).toLocaleDateString('es-GT', { timeZone: 'UTC' })} (${detail.erp.diasSinCompra} días)` : '—'} />
                  <InfoRow icon={MapPin} label="Sucursal preferida" value={detail.erp.sucursalPreferida || '—'} />
                  <InfoRow
                    icon={ShoppingBag}
                    label="Interés por línea"
                    value={
                      [['Blusas', detail.erp.blusas], ['Jeans', detail.erp.jeans], ['Vestidos', detail.erp.vestidos], ['Pantalones', detail.erp.pantalones], ['Otros', detail.erp.otros]]
                        .filter(([, n]) => n > 0)
                        .sort((a, b) => b[1] - a[1])
                        .map(([label, n]) => `${label} (${n})`)
                        .join(', ') || '—'
                    }
                  />
                  {(detail.erp.tallaBlusa || detail.erp.tallaJean || detail.erp.tallaCalzado) && (
                    <InfoRow
                      icon={ShoppingBag}
                      label="Tallas (histórico ERP)"
                      value={[detail.erp.tallaBlusa && `Blusa ${detail.erp.tallaBlusa}`, detail.erp.tallaJean && `Jean ${detail.erp.tallaJean}`, detail.erp.tallaCalzado && `Calzado ${detail.erp.tallaCalzado}`].filter(Boolean).join(' · ')}
                    />
                  )}
                </div>
              </div>
            )}

            <div className="mt-6">
              <h3 className="text-sm font-medium text-greige-ink">Consentimientos</h3>
              {detail.consents.length === 0 && (
                <p className="mt-1.5 text-sm text-greige-ink">Sin consentimientos registrados.</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {detail.consents.map((c, i) => (
                  <Badge key={i} variant={c.accepted ? 'success' : 'neutral'}>
                    {c.type}: {c.accepted ? 'aceptado' : 'rechazado'}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-medium text-greige-ink">Pedidos</h3>
              {detail.orders.length === 0 && (
                <p className="mt-1.5 text-sm text-greige-ink">Sin pedidos registrados.</p>
              )}
              <ul className="mt-2 flex flex-col gap-2">
                {detail.orders.map((o) => (
                  <li key={o.id} className="flex items-center justify-between rounded-lg bg-black/[0.03] dark:bg-white/[0.05] px-3.5 py-2.5 text-sm">
                    <span className="font-medium text-ink">{o.ticket_code ?? `Carrito #${o.id}`}</span>
                    <span className="text-greige-ink">{o.status}</span>
                    <span className="font-medium text-ink">{o.total ? `Q${o.total}` : '—'}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-6">
              <h3 className="text-sm font-medium text-greige-ink">Tickets de soporte</h3>
              {detail.tickets.length === 0 && (
                <p className="mt-1.5 text-sm text-greige-ink">Sin tickets registrados.</p>
              )}
              <ul className="mt-2 flex flex-col gap-2">
                {detail.tickets.map((t) => (
                  <li key={t.id} className="rounded-lg bg-black/[0.03] dark:bg-white/[0.05] px-3.5 py-2.5 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ink">{t.status}</span>
                      <span className="text-xs text-greige-ink">
                        {new Date(t.created_at).toLocaleDateString('es-GT')}
                      </span>
                    </div>
                    <p className="mt-1 text-greige-ink">{t.handoff_reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmPaidOpen}
        title="Marcar como Pagado"
        message="Esto marca al cliente como Pagado de forma permanente — no se puede deshacer. Indica el medio de pago:"
        confirmLabel="Marcar como Pagado"
        busy={markingPaid}
        confirmDisabled={!paidMethod}
        onConfirm={handleMarkPaid}
        onCancel={() => { setConfirmPaidOpen(false); setPaidMethod(''); }}
      >
        <Select
          value={paidMethod}
          onChange={setPaidMethod}
          placeholder="Selecciona el medio de pago…"
          options={PAID_METHOD_OPTIONS}
        />
      </ConfirmDialog>

      <EditCustomerModal
        open={editOpen}
        customer={detail}
        onCancel={() => setEditOpen(false)}
        onSaved={() => { setEditOpen(false); reloadDetail(); load(false); }}
      />
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={16} className="mt-0.5 text-greige" />
      <div>
        <p className="text-xs text-greige-ink">{label}</p>
        <p className="text-sm font-medium text-ink">{value}</p>
      </div>
    </div>
  );
}
