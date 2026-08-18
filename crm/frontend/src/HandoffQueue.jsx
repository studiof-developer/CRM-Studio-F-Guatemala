import { useEffect, useState, useCallback } from 'react';
import { Clock, MapPin, ShoppingBag, User, CircleUser, AlertTriangle, Search } from 'lucide-react';
import { fetchTickets, fetchTicket, updateTicket } from './api.js';
import Badge from './components/Badge.jsx';
import { Button } from './components/ui.jsx';
import { showSuccess, showError } from './components/Toast.jsx';
import { isOverdue, formatWait, SLA_MINUTES } from './lib/sla.js';
import { useLiveEvent } from './lib/liveEvents.js';

const STATUS_META = {
  esperando_asesor: { label: 'Esperando asesor', variant: 'warning' },
  en_atencion: { label: 'En atención', variant: 'info' },
  resuelto: { label: 'Resuelto', variant: 'success' },
  bot: { label: 'Con el bot', variant: 'neutral' },
};

const FILTERS = Object.keys(STATUS_META);

export default function HandoffQueue({ user, onOpenConversation }) {
  const [statusFilter, setStatusFilter] = useState('esperando_asesor');
  const [search, setSearch] = useState('');
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [ticketDetail, setTicketDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadTickets = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setTickets(await fetchTickets(statusFilter));
    } catch (err) {
      setError(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  useLiveEvent('ticket_changes', useCallback(() => loadTickets(false), [loadTickets]));

  // Fallback in case the SSE connection silently drops — SSE is the fast path now,
  // this is just a safety net, so it doesn't need to be as tight as before.
  useEffect(() => {
    const id = setInterval(() => loadTickets(false), 60000);
    return () => clearInterval(id);
  }, [loadTickets]);

  useEffect(() => {
    if (!selectedId) { setTicketDetail(null); return; }
    fetchTicket(selectedId).then(setTicketDetail).catch((err) => setError(err.message));
  }, [selectedId]);

  async function handleTake(id, phone) {
    try {
      await updateTicket(id, { status: 'en_atencion', assigned_advisor: user.fullName });
      await loadTickets();
      fetchTicket(id).then(setTicketDetail);
      showSuccess('Ticket asignado a ti');
      // Taking it here is only step one — the advisor still needs to actually talk to
      // the customer, which happens in Conversaciones, not this queue.
      if (phone) onOpenConversation?.(phone);
    } catch (err) {
      showError(err.message);
    }
  }

  async function handleResolve(id) {
    try {
      await updateTicket(id, { status: 'resuelto' });
      await loadTickets();
      setSelectedId(null);
      showSuccess('Ticket marcado como resuelto');
    } catch (err) {
      showError(err.message);
    }
  }

  const visibleTickets = tickets.filter((t) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (t.full_name || '').toLowerCase().includes(q) || (t.whatsapp_number || '').includes(q);
  });

  return (
    <div className="flex h-full min-w-0 overflow-hidden rounded-3xl">
      {/* List column scrolls on its own — the header/filters/search stay put. */}
      <div className="flex w-[360px] max-w-[45vw] shrink-0 flex-col border-r border-border">
        <div className="border-b border-border p-4">
          <h1 className="text-lg font-semibold tracking-tight">Cola de Handoff</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Conversaciones que necesitan un asesor humano.</p>

          <div className="relative mt-3">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o número"
              className="w-full rounded-full border border-border bg-muted py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent focus:bg-paper"
            />
          </div>

          <div className="mt-3 inline-flex flex-wrap gap-1 rounded-xl border border-border bg-muted p-1">
            {FILTERS.map((key) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  statusFilter === key
                    ? 'bg-paper text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {STATUS_META[key].label}
              </button>
            ))}
          </div>
        </div>

        <ul className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
          {error && <li className="text-sm text-danger">{error}</li>}
          {loading && (
            <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Cargando…
            </li>
          )}
          {!loading && visibleTickets.length === 0 && (
            <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {tickets.length === 0 ? 'No hay tickets en este estado.' : 'Ningún resultado para esa búsqueda.'}
            </li>
          )}
          {visibleTickets.map((t) => {
            const overdue = t.status === 'esperando_asesor' && isOverdue(t.created_at);
            return (
              <li
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`cursor-pointer rounded-xl border p-4 transition-all ${
                  t.id === selectedId
                    ? 'border-accent bg-accent-soft shadow-sm'
                    : overdue
                      ? 'border-danger/40 bg-danger/5 hover:shadow-sm'
                      : 'border-border bg-paper hover:border-foreground/20 hover:shadow-sm'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{t.full_name || t.whatsapp_number}</p>
                  {overdue && (
                    <span className="flex shrink-0 animate-pulse items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-white">
                      <AlertTriangle size={10} /> atrasado
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{t.handoff_reason}</p>
                <p className={`mt-2 flex items-center gap-1 text-xs ${overdue ? 'font-semibold text-danger' : 'text-muted-foreground'}`}>
                  {overdue ? <AlertTriangle size={12} /> : <Clock size={12} />}
                  {overdue
                    ? `Esperando hace ${formatWait(t.created_at)} (más de ${SLA_MINUTES} min)`
                    : new Date(t.created_at).toLocaleString('es-GT')}
                </p>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Detail column scrolls independently — selecting a ticket further down the
          list no longer drags the whole page with it. */}
      <section className="flex-1 overflow-y-auto p-8">
          {!ticketDetail && (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center text-sm text-muted-foreground">
              Selecciona un ticket para ver el detalle.
            </div>
          )}
          {ticketDetail && (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-semibold">{ticketDetail.full_name || ticketDetail.whatsapp_number}</h2>
                  <p className="text-sm text-muted-foreground">{ticketDetail.whatsapp_number}</p>
                </div>
                <Badge variant={STATUS_META[ticketDetail.status].variant}>
                  {STATUS_META[ticketDetail.status].label}
                </Badge>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-5 border-y border-border py-6">
                <InfoRow icon={MapPin} label="Departamento" value={ticketDetail.department || '—'} />
                <InfoRow icon={MapPin} label="Municipio" value={ticketDetail.municipio || '—'} />
                <InfoRow icon={ShoppingBag} label="Línea preferida" value={ticketDetail.preferred_line || '—'} />
                <InfoRow icon={ShoppingBag} label="Talla" value={ticketDetail.preferred_size || '—'} />
                <InfoRow icon={User} label="Compras previas" value={ticketDetail.purchase_frequency} />
                <InfoRow icon={CircleUser} label="Asesor asignado" value={ticketDetail.assigned_advisor || '—'} />
              </div>

              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground">Motivo del handoff</h3>
                <p className="mt-1.5 text-sm">{ticketDetail.handoff_reason}</p>
              </div>

              <div className="mt-6">
                <h3 className="text-sm font-medium text-muted-foreground">Pedidos</h3>
                {ticketDetail.orders.length === 0 && (
                  <p className="mt-1.5 text-sm text-muted-foreground">Sin pedidos registrados.</p>
                )}
                <ul className="mt-2 flex flex-col gap-2">
                  {ticketDetail.orders.map((o) => (
                    <li
                      key={o.ticket_code ?? o.created_at}
                      className="flex items-center justify-between rounded-lg bg-muted px-3.5 py-2.5 text-sm"
                    >
                      <span className="font-medium">{o.ticket_code ?? '(sin ticket)'}</span>
                      <span className="text-muted-foreground">{o.status}</span>
                      <span className="font-medium">Q{o.total ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-8 flex gap-3">
                {ticketDetail.status === 'esperando_asesor' && (
                  <Button onClick={() => handleTake(ticketDetail.id, ticketDetail.whatsapp_number)}>
                    Tomar ticket
                  </Button>
                )}
                {ticketDetail.status === 'en_atencion' && (
                  <Button
                    onClick={() => handleResolve(ticketDetail.id)}
                    className="bg-ok shadow-ok/20 hover:bg-ok/90"
                  >
                    Marcar resuelto
                  </Button>
                )}
              </div>
            </>
          )}
      </section>
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
