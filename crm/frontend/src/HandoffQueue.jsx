import { useEffect, useState, useCallback, useRef } from 'react';
import { Search, Clock, CheckCircle2, Snowflake, Thermometer, Flame, CircleDollarSign, MessageSquareWarning, AlertTriangle, ArrowUpDown, Loader2 } from 'lucide-react';
import { fetchPipelineColumn, updateTicket, updateCustomerTags } from './api.js';
import { Button } from './components/ui.jsx';
import { showSuccess, showError } from './components/Toast.jsx';
import { isOverdue, formatWait, SLA_MINUTES } from './lib/sla.js';
import { useLiveEvent } from './lib/liveEvents.js';

// The 4 columns that are really the customer's temperature wearing a pipeline-stage
// name — see the 2026-08-31 conversation that settled this. "No atendidos" comes from
// the ticket having no advisor yet; "Resuelto" and "Pagado" are terminal states with
// their own dedicated, deliberate actions elsewhere (paid needs a payment method
// captured too, and is one-way once set — not something to flip with a casual drag).
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
// "No atendidos" defaults oldest-waiting-first (that's who the SLA cares about);
// everywhere else defaults most-recently-active-first. Every column can be flipped.
const DEFAULT_SORT = { pendiente: 'asc' };

// Only these move by dragging — each is a plain, reversible manual_status write, no
// extra info required. Dropping onto "resuelto" is also allowed (a natural way to
// close out a card), just not dragging out of it. "pendiente" and "pagado" are display
// only: taking a ticket and marking someone paid both stay deliberate button actions.
const DRAG_SOURCES = new Set(['en_atencion', 'cotizacion', 'medio_pago', 'pqrs']);
const DROP_TARGETS = new Set(['en_atencion', 'cotizacion', 'medio_pago', 'pqrs', 'resuelto']);
const TEMPERATURE_FOR_COLUMN = { en_atencion: 'frio', cotizacion: 'tibio', medio_pago: 'caliente', pqrs: 'pqrs' };

const PAGE_SIZE = 50;

function emptyColumn(key) {
  return { cards: [], total: 0, offset: 0, loading: false, sort: DEFAULT_SORT[key] ?? 'desc' };
}
function emptyColumns() {
  return Object.fromEntries(COLUMN_ORDER.map((key) => [key, emptyColumn(key)]));
}

export default function HandoffQueue({ user, onOpenConversation }) {
  const [columns, setColumns] = useState(emptyColumns);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [busyTicketId, setBusyTicketId] = useState(null);
  const dragDataRef = useRef(null);
  // Read fresh column state (offset/sort/loading) from inside callbacks without having
  // to recreate them on every column update — same pattern Conversations.jsx uses for
  // selectedId.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // Replaces a column's cards from scratch, page 1 — used for the initial load, a
  // sort-direction change, and any live-update refresh.
  const loadColumn = useCallback(async (key, sort) => {
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: true, sort } }));
    try {
      const { cards, total } = await fetchPipelineColumn(key, { offset: 0, limit: PAGE_SIZE, sort });
      setColumns((prev) => ({ ...prev, [key]: { cards, total, offset: cards.length, loading: false, sort } }));
    } catch (err) {
      setError(err.message);
      setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  }, []);

  // Appends the next page — this is what makes scrolling to the bottom of, say, "En
  // conversación" (2733 contacts) eventually reach every one of them, a bounded page at
  // a time, instead of ever asking the database for all of them in one go.
  const loadMore = useCallback(async (key) => {
    const col = columnsRef.current[key];
    if (col.loading || col.cards.length >= col.total) return;
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: true } }));
    try {
      const { cards } = await fetchPipelineColumn(key, { offset: col.offset, limit: PAGE_SIZE, sort: col.sort });
      setColumns((prev) => ({
        ...prev,
        [key]: { ...prev[key], cards: [...prev[key].cards, ...cards], offset: prev[key].offset + cards.length, loading: false },
      }));
    } catch (err) {
      showError(err.message);
      setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  }, []);

  const reloadAll = useCallback(() => {
    for (const key of COLUMN_ORDER) loadColumn(key, columnsRef.current[key].sort);
  }, [loadColumn]);

  useEffect(() => { reloadAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLiveEvent('ticket_changes', reloadAll);
  // No live channel exists for a plain temperature change (only tickets broadcast) —
  // this catches those within a minute instead of never, same fallback role polling
  // already played in the old queue view.
  useEffect(() => {
    const id = setInterval(reloadAll, 60000);
    return () => clearInterval(id);
  }, [reloadAll]);

  function toggleSort(key) {
    loadColumn(key, columnsRef.current[key].sort === 'asc' ? 'desc' : 'asc');
  }

  function handleScroll(e, key) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) loadMore(key);
  }

  async function handleTake(ticketId, whatsappNumber) {
    setBusyTicketId(ticketId);
    try {
      await updateTicket(ticketId, { status: 'en_atencion', assigned_advisor: user.fullName });
      showSuccess('Ticket asignado a ti');
      reloadAll();
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
    // before it visually lands would make the drag feel broken, and reloadAll() right
    // after reconciles both columns against the real data either way.
    setColumns((prev) => {
      const from = prev[drag.sourceColumn];
      const card = from.cards.find((c) => c.ticketId === drag.ticketId);
      if (!card) return prev;
      const to = prev[targetColumn];
      return {
        ...prev,
        [drag.sourceColumn]: { ...from, total: Math.max(0, from.total - 1), offset: Math.max(0, from.offset - 1), cards: from.cards.filter((c) => c.ticketId !== drag.ticketId) },
        [targetColumn]: { ...to, total: to.total + 1, offset: to.offset + 1, cards: [card, ...to.cards] },
      };
    });

    try {
      if (targetColumn === 'resuelto') {
        await updateTicket(drag.ticketId, { status: 'resuelto' });
      } else {
        await updateCustomerTags(drag.customerId, { manualStatus: TEMPERATURE_FOR_COLUMN[targetColumn] });
      }
      reloadAll();
    } catch (err) {
      showError(err.message);
      reloadAll();
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
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {COLUMN_ORDER.map((key) => {
          const meta = COLUMN_META[key];
          const Icon = meta.icon;
          const col = columns[key];
          const cards = col.cards.filter(matches);
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
                <button
                  type="button"
                  onClick={() => toggleSort(key)}
                  title={col.sort === 'asc' ? 'Más antiguo primero' : 'Más reciente primero'}
                  className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowUpDown size={10} />
                  {col.sort === 'asc' ? 'Antiguo' : 'Reciente'}
                </button>
                <span className="ml-auto rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
                  {q ? cards.length : col.total}
                </span>
              </div>
              <div onScroll={(e) => handleScroll(e, key)} className="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                {cards.length === 0 && !col.loading && (
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
                {col.loading && (
                  <div className="flex justify-center py-2">
                    <Loader2 size={16} className="animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
