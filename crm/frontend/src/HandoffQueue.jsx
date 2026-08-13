import { useEffect, useState, useCallback } from 'react';
import { Clock, MapPin, ShoppingBag, User, CircleUser } from 'lucide-react';
import { API_BASE, fetchTickets, fetchTicket, updateTicket } from './api.js';
import Badge from './components/Badge.jsx';
import { Button } from './components/ui.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

const STATUS_META = {
  esperando_asesor: { label: 'Esperando asesor', variant: 'warning' },
  en_atencion: { label: 'En atención', variant: 'info' },
  resuelto: { label: 'Resuelto', variant: 'success' },
  bot: { label: 'Con el bot', variant: 'neutral' },
};

const FILTERS = Object.keys(STATUS_META);

export default function HandoffQueue({ user }) {
  const [statusFilter, setStatusFilter] = useState('esperando_asesor');
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

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/events`, { withCredentials: true });
    es.onmessage = () => loadTickets(false);
    return () => es.close();
  }, [loadTickets]);

  useEffect(() => {
    const id = setInterval(() => loadTickets(false), 30000);
    return () => clearInterval(id);
  }, [loadTickets]);

  useEffect(() => {
    if (!selectedId) { setTicketDetail(null); return; }
    fetchTicket(selectedId).then(setTicketDetail).catch((err) => setError(err.message));
  }, [selectedId]);

  async function handleTake(id) {
    try {
      await updateTicket(id, { status: 'en_atencion', assigned_advisor: user.fullName });
      await loadTickets();
      fetchTicket(id).then(setTicketDetail);
      showSuccess('Ticket asignado a ti');
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

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Cola de Handoff</h1>
        <p className="mt-1 text-sm text-muted-foreground">Conversaciones que necesitan un asesor humano.</p>
      </div>

      <div className="mb-6 inline-flex rounded-xl border border-border bg-muted p-1">
        {FILTERS.map((key) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${
              statusFilter === key
                ? 'bg-paper text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {STATUS_META[key].label}
          </button>
        ))}
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <ul className="flex flex-col gap-2">
          {loading && (
            <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Cargando…
            </li>
          )}
          {!loading && tickets.length === 0 && (
            <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No hay tickets en este estado.
            </li>
          )}
          {tickets.map((t) => (
            <li
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={`cursor-pointer rounded-xl border p-4 transition-all ${
                t.id === selectedId
                  ? 'border-accent bg-accent-soft shadow-sm'
                  : 'border-border bg-paper hover:border-foreground/20 hover:shadow-sm'
              }`}
            >
              <p className="text-sm font-medium">{t.full_name || t.whatsapp_number}</p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{t.handoff_reason}</p>
              <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <Clock size={12} /> {new Date(t.created_at).toLocaleString('es-GT')}
              </p>
            </li>
          ))}
        </ul>

        <section className="rounded-2xl border border-border bg-paper p-8">
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
                  <Button onClick={() => handleTake(ticketDetail.id)}>
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
