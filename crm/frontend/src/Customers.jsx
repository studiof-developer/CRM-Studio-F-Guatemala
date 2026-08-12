import { useEffect, useState, useCallback } from 'react';
import { CircleDollarSign, MessageSquareWarning, MapPin, ShoppingBag, Phone } from 'lucide-react';
import { fetchCustomerCounts, fetchCustomers, fetchCustomer, updateCustomerTags } from './api.js';
import { TEMP_META, BUCKET_ORDER } from './lib/temperature.js';
import { PAID_METHOD_LABELS, PAID_METHOD_ORDER } from './lib/paymentMethods.js';
import Badge from './components/Badge.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

export default function Customers() {
  const [counts, setCounts] = useState({});
  const [bucket, setBucket] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirmPaidOpen, setConfirmPaidOpen] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [paidMethod, setPaidMethod] = useState('');

  const loadCounts = useCallback(() => {
    fetchCustomerCounts().then(setCounts).catch((err) => setError(err.message));
  }, []);

  useEffect(() => { loadCounts(); }, [loadCounts]);

  const loadCustomers = useCallback(async (status) => {
    setLoading(true);
    setError(null);
    try {
      setCustomers(await fetchCustomers(status));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (bucket) loadCustomers(bucket);
  }, [bucket, loadCustomers]);

  const reloadDetail = useCallback(() => {
    if (!selectedId) { setDetail(null); return; }
    fetchCustomer(selectedId).then(setDetail).catch((err) => setError(err.message));
  }, [selectedId]);

  useEffect(() => { reloadDetail(); }, [reloadDetail]);

  async function handleSetStatus(e) {
    const value = e.target.value;
    try {
      await updateCustomerTags(selectedId, { manualStatus: value || null });
      reloadDetail();
      loadCounts();
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
      showSuccess('Cliente marcado como Pagado');
    } catch (err) {
      showError(err.message);
    } finally {
      setMarkingPaid(false);
      setConfirmPaidOpen(false);
      setPaidMethod('');
    }
  }

  if (!bucket) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
          <p className="mt-1 text-sm text-muted-foreground">Segmentados por su momento con Studio F.</p>
        </div>

        {error && <p className="mb-4 text-sm text-danger">{error}</p>}

        <ul className="flex flex-col gap-2 rounded-2xl border border-border bg-paper p-2">
          {BUCKET_ORDER.map((key) => {
            const { label, icon: Icon, iconBg, iconText } = TEMP_META[key];
            return (
              <li key={key}>
                <button
                  onClick={() => setBucket(key)}
                  className="flex w-full items-center justify-between rounded-xl px-4 py-3.5 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-3">
                    <span className={`flex h-9 w-9 items-center justify-center rounded-full ${iconBg}`}>
                      <Icon size={16} className={iconText} />
                    </span>
                    <span className="text-sm font-medium">{label}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">{counts[key] ?? 0}</span>
                    <span className="text-muted-foreground">›</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  const { label, icon: Icon, iconText } = TEMP_META[bucket];

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => { setBucket(null); setSelectedId(null); loadCounts(); }}
          className="rounded-lg px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          ‹ Clientes
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="flex items-center gap-2 text-sm font-medium">
          <Icon size={15} className={iconText} /> {label}
        </span>
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <ul className="flex flex-col gap-2">
          {loading && (
            <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Cargando…
            </li>
          )}
          {!loading && customers.length === 0 && (
            <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No hay clientes en este estado.
            </li>
          )}
          {customers.map((c) => (
            <li
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`cursor-pointer rounded-xl border p-4 transition-all ${
                c.id === selectedId
                  ? 'border-accent bg-accent-soft shadow-sm'
                  : 'border-border bg-paper hover:border-foreground/20 hover:shadow-sm'
              }`}
            >
              <p className="text-sm font-medium">{c.full_name || c.whatsapp_number}</p>
              <p className="mt-1 text-sm text-muted-foreground">{c.department || 'Sin departamento'}</p>
            </li>
          ))}
        </ul>

        <section className="rounded-2xl border border-border bg-paper p-8">
          {!detail && (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center text-sm text-muted-foreground">
              Selecciona un cliente para ver su perfil.
            </div>
          )}
          {detail && (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-semibold">{detail.full_name || detail.whatsapp_number}</h2>
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Phone size={13} /> {detail.whatsapp_number}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={TEMP_META[detail.temperature].variant}>{TEMP_META[detail.temperature].label}</Badge>
                    {detail.paid_locked && detail.temperature !== 'pagado' && (
                      <Badge variant={TEMP_META.pagado.variant}>{TEMP_META.pagado.label}</Badge>
                    )}
                  </div>
                  {detail.paid_locked && detail.paid_method && (
                    <p className="text-xs text-muted-foreground">Pagó por {PAID_METHOD_LABELS[detail.paid_method]}</p>
                  )}
                </div>
              </div>

              <div className="mt-4 flex items-center gap-3 rounded-xl bg-muted p-3">
                <label className="text-xs font-medium text-muted-foreground">Estado (control del asesor):</label>
                <select
                  value={detail.manual_status ?? ''}
                  onChange={handleSetStatus}
                  className="rounded-lg border border-border bg-paper px-2.5 py-1 text-xs outline-none focus:border-accent"
                >
                  <option value="">Automático</option>
                  {BUCKET_ORDER.map((k) => (
                    <option key={k} value={k}>{TEMP_META[k].label}</option>
                  ))}
                </select>
                {!detail.paid_locked && (
                  <button
                    onClick={() => setConfirmPaidOpen(true)}
                    className="ml-auto rounded-lg border border-success-bg bg-success-bg/50 px-2.5 py-1 text-xs font-semibold text-success transition-colors hover:bg-success-bg"
                  >
                    Marcar como Pagado
                  </button>
                )}
              </div>

              <div className="mt-6 grid grid-cols-2 gap-5 border-y border-border py-6">
                <InfoRow icon={MapPin} label="Departamento" value={detail.department || '—'} />
                <InfoRow icon={ShoppingBag} label="Línea preferida" value={detail.preferred_line || '—'} />
                <InfoRow icon={CircleDollarSign} label="Compras totales" value={detail.purchase_frequency} />
                <InfoRow icon={MessageSquareWarning} label="Conversaciones" value={detail.conversationSessionIds.length} />
              </div>

              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground">Consentimientos</h3>
                {detail.consents.length === 0 && (
                  <p className="mt-1.5 text-sm text-muted-foreground">Sin consentimientos registrados.</p>
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
                <h3 className="text-sm font-medium text-muted-foreground">Pedidos</h3>
                {detail.orders.length === 0 && (
                  <p className="mt-1.5 text-sm text-muted-foreground">Sin pedidos registrados.</p>
                )}
                <ul className="mt-2 flex flex-col gap-2">
                  {detail.orders.map((o) => (
                    <li key={o.id} className="flex items-center justify-between rounded-lg bg-muted px-3.5 py-2.5 text-sm">
                      <span className="font-medium">{o.ticket_code ?? `Carrito #${o.id}`}</span>
                      <span className="text-muted-foreground">{o.status}</span>
                      <span className="font-medium">{o.total ? `Q${o.total}` : '—'}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground">Tickets de soporte</h3>
                {detail.tickets.length === 0 && (
                  <p className="mt-1.5 text-sm text-muted-foreground">Sin tickets registrados.</p>
                )}
                <ul className="mt-2 flex flex-col gap-2">
                  {detail.tickets.map((t) => (
                    <li key={t.id} className="rounded-lg bg-muted px-3.5 py-2.5 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t.status}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(t.created_at).toLocaleDateString('es-GT')}
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{t.handoff_reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>

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
        <select
          value={paidMethod}
          onChange={(e) => setPaidMethod(e.target.value)}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="">Selecciona el medio de pago…</option>
          {PAID_METHOD_ORDER.map((k) => (
            <option key={k} value={k}>{PAID_METHOD_LABELS[k]}</option>
          ))}
        </select>
      </ConfirmDialog>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={16} className="mt-0.5 text-muted-foreground" />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}
