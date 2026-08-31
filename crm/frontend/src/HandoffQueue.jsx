import { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Clock, CheckCircle2, Snowflake, Thermometer, Flame, CircleDollarSign, MessageSquareWarning, AlertTriangle, ArrowUpDown } from 'lucide-react';
import { fetchPipeline, updateTicket, updateCustomerTags } from './api.js';
import { Button } from './components/ui.jsx';
import { showSuccess, showError } from './components/Toast.jsx';
import { isOverdue, formatWait, SLA_MINUTES } from './lib/sla.js';
import { useLiveEvent } from './lib/liveEvents.js';

// The 4 columns that are really the customer's temperature wearing a pipeline-stage
// name — see the 2026-08-31 conversation that settled this. "Pendiente" comes from the
// ticket having no advisor yet; "Resuelto" and "Pagado" are terminal states with their
// own dedicated, deliberate actions elsewhere (paid needs a payment method captured
// too, and is one-way once set — not something to flip with a casual drag).
const COLUMN_META = {
  pendiente: { label: 'No atendidos', icon: Clock, iconBg: 'bg-warning-bg', iconText: 'text-warning' },
  en_atencion: { label: 'En conversación', icon: Snowflake, iconBg: 'bg-info-bg', iconText: 'text-info' },
  cotizacion: { label: 'Cotización', icon: Thermometer, iconBg: 'bg-warning-bg', iconText: 'text-warning' },
  medio_pago: { label: 'Medio de pago', icon: Flame, iconBg: 'bg-danger-bg', iconText: 'text-danger' },
  pagado: { label: 'Pagado', icon: CircleDollarSign, iconBg: 'bg-success-bg', iconText: 'text-success' },
  pqrs: { label: 'PQRS', icon: MessageSquareWarning, iconBg: 'bg-purple-bg', iconText: 'text-purple' },
  resuelto: { label: 'Resuelto', icon: CheckCircle2, iconBg: 'bg-success-bg', iconText: 'text-success' },
};
const COLUMN_ORDER = ['pendiente', 'en_atencion', 'cotizacion', 'medio_pago', 'pagado', 'pqrs', 'resuelto'];

// Only these move by dragging — each is a plain, reversible manual_status write, no
// extra info required. Dropping onto "resuelto" is also allowed (a natural way to
// close out a card), just not dragging out of it. "pendiente" and "pagado" are display
// only: taking a ticket and marking someone paid both stay deliberate button actions.
const DRAG_SOURCES = new Set(['en_atencion', 'cotizacion', 'medio_pago', 'pqrs']);
const DROP_TARGETS = new Set(['en_atencion', 'cotizacion', 'medio_pago', 'pqrs', 'resuelto']);
const TEMPERATURE_FOR_COLUMN = { en_atencion: 'frio', cotizacion: 'tibio', medio_pago: 'caliente', pqrs: 'pqrs' };

function emptyColumns() {
  return Object.fromEntries(COLUMN_ORDER.map((key) => [key, { total: 0, cards: [] }]));
}

export default function HandoffQueue({ user, onOpenConversation }) {
  const [columns, setColumns] = useState(emptyColumns);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyTicketId, setBusyTicketId] = useState(null);
  // Only "No atendidos" gets this control — the backend already sends exactly those
  // 40 (oldest-waiting-first, the ones the SLA cares about) regardless of which way
  // this is flipped, so re-sorting here is always safe: never hides a card the other
  // direction would have shown.
  const [pendienteOldestFirst, setPendienteOldestFirst] = useState(true);
  const dragDataRef = useRef(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setColumns(await fetchPipeline());
    } catch (err) {
      setError(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const loadQuiet = useCallback(() => load(false), [load]);
  useLiveEvent('ticket_changes', loadQuiet);
  // No live channel exists for a plain temperature change (only tickets broadcast) —
  // this catches those within a minute instead of never, same fallback role the poll
  // already played in the old queue view.
  useEffect(() => {
    const id = setInterval(loadQuiet, 60000);
    return () => clearInterval(id);
  }, [loadQuiet]);

  async function handleTake(ticketId, whatsappNumber) {
    setBusyTicketId(ticketId);
    try {
      await updateTicket(ticketId, { status: 'en_atencion', assigned_advisor: user.fullName });
      showSuccess('Ticket asignado a ti');
      load(false);
      // Taking it is only step one — the advisor still needs to actually talk to the
      // customer, which happens in Conversaciones, not this board.
      if (whatsappNumber) onOpenConversation?.(whatsappNumber);
    } catch (err) {
      showError(err.message);
    } finally {
      setBusyTicketId(null);
    }
  }

  function handleDragStart(e, card, sourceColumn) {
    dragDataRef.current = { ticketId: card.ticketId, customerId: card.customerId, sourceColumn };
    e.dataTransfer.effectAllowed = 'move';
  }

  async function handleDrop(e, targetColumn) {
    e.preventDefault();
    const drag = dragDataRef.current;
    dragDataRef.current = null;
    if (!drag || drag.sourceColumn === targetColumn) return;

    // Moves the card in front of the advisor immediately — waiting on the round trip
    // before it visually lands would make the drag feel broken, and load(false) right
    // after reconciles it against the real data either way.
    setColumns((prev) => {
      const from = prev[drag.sourceColumn];
      const card = from.cards.find((c) => c.ticketId === drag.ticketId);
      if (!card) return prev;
      return {
        ...prev,
        [drag.sourceColumn]: { total: from.total - 1, cards: from.cards.filter((c) => c.ticketId !== drag.ticketId) },
        [targetColumn]: { total: prev[targetColumn].total + 1, cards: [card, ...prev[targetColumn].cards] },
      };
    });

    try {
      if (targetColumn === 'resuelto') {
        await updateTicket(drag.ticketId, { status: 'resuelto' });
      } else {
        await updateCustomerTags(drag.customerId, { manualStatus: TEMPERATURE_FOR_COLUMN[targetColumn] });
      }
      load(false);
    } catch (err) {
      showError(err.message);
      load(false);
    }
  }

  const q = search.trim().toLowerCase();
  const matches = (c) => !q || (c.fullName || '').toLowerCase().includes(q) || (c.whatsappNumber || '').includes(q);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-3xl">
      <div className="border-b border-border p-4">
        <h1 className="text-lg font-semibold tracking-tight">Pipeline</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Cómo va cada contacto, de primer contacto a cerrado.</p>
        <div className="relative mt-3 max-w-sm">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o número"
            className="w-full rounded-full border border-border bg-muted py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent focus:bg-paper"
          />
        </div>
      </div>

      {error && <p className="p-4 text-sm text-danger">{error}</p>}
      {loading ? (
        <p className="p-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="flex flex-1 gap-3 overflow-x-auto p-4">
          {COLUMN_ORDER.map((key) => {
            const meta = COLUMN_META[key];
            const Icon = meta.icon;
            let cards = columns[key].cards.filter(matches);
            // The backend already sends this column oldest-first — only reverse for
            // display, never re-fetch or re-derive which cards are in the set.
            if (key === 'pendiente' && !pendienteOldestFirst) cards = [...cards].reverse();
            const isDropTarget = DROP_TARGETS.has(key);
            return (
              <div
                key={key}
                onDragOver={(e) => { if (isDropTarget) e.preventDefault(); }}
                onDrop={isDropTarget ? (e) => handleDrop(e, key) : undefined}
                className="flex w-72 shrink-0 flex-col rounded-2xl border border-border bg-muted/40"
              >
                <div className="flex items-center gap-2 border-b border-border p-3">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full ${meta.iconBg} ${meta.iconText}`}>
                    <Icon size={13} />
                  </span>
                  <span className="text-sm font-semibold">{meta.label}</span>
                  {key === 'pendiente' && (
                    <button
                      type="button"
                      onClick={() => setPendienteOldestFirst((v) => !v)}
                      title={pendienteOldestFirst ? 'Más antiguo primero' : 'Más reciente primero'}
                      className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ArrowUpDown size={10} />
                      {pendienteOldestFirst ? 'Antiguo' : 'Reciente'}
                    </button>
                  )}
                  <span className="ml-auto rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
                    {q ? cards.length : columns[key].total}
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                  {cards.length === 0 && (
                    <p className="p-3 text-center text-xs text-muted-foreground">Nada aquí.</p>
                  )}
                  {cards.map((card) => {
                    const overdue = key === 'pendiente' && isOverdue(card.stageSince);
                    return (
                    <div
                      key={card.ticketId}
                      draggable={DRAG_SOURCES.has(key)}
                      onDragStart={(e) => handleDragStart(e, card, key)}
                      className={`rounded-xl border p-3 shadow-sm transition-shadow hover:shadow-md ${
                        overdue ? 'border-danger/40 bg-danger/5' : 'border-border bg-paper'
                      } ${DRAG_SOURCES.has(key) ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{card.fullName || card.whatsappNumber}</p>
                        {overdue && (
                          <span className="flex shrink-0 animate-pulse items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-white">
                            <AlertTriangle size={10} /> atrasado
                          </span>
                        )}
                      </div>
                      {card.lastMessage && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{card.lastMessage}</p>
                      )}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className={`flex items-center gap-1 text-[11px] ${overdue ? 'font-semibold text-danger' : 'text-muted-foreground'}`}>
                          {overdue
                            ? `Esperando hace ${formatWait(card.stageSince)} (más de ${SLA_MINUTES} min)`
                            : `hace ${formatWait(card.stageSince)}`}
                        </span>
                        {key === 'pendiente' ? (
                          <Button
                            onClick={() => handleTake(card.ticketId, card.whatsappNumber)}
                            disabled={busyTicketId === card.ticketId}
                            className="!h-7 !px-2.5 !text-xs"
                          >
                            Tomar
                          </Button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpenConversation?.(card.whatsappNumber)}
                            className="text-xs font-semibold text-accent hover:underline"
                          >
                            Ir al chat
                          </button>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
