import { useEffect, useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Search, Clock, CheckCircle2, AlertTriangle, ArrowUpDown, Loader2, Headset, ChevronLeft, ChevronRight, Calendar, LayoutGrid, Mail, Download } from 'lucide-react';
import { fetchPipelineColumn, fetchPipelineExport, updateTicket, updateCustomerTags, fetchPresenceSnapshot, fetchLastAdvisorActivity, fetchSettings } from './api.js';
import { Button } from './components/ui.jsx';
import Select from './components/Select.jsx';
import { showSuccess, showError } from './components/Toast.jsx';
import { formatWait, minutesSince } from './lib/sla.js';
import { useLiveEvent, onLiveEvent } from './lib/liveEvents.js';
import { colorFor, hexToRgba } from './lib/avatarColor.js';
import { COLUMN_ORDER, DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_COLOR_CLASSES } from './lib/pipelineColumns.js';

// The 4 columns that are really the customer's temperature wearing a pipeline-stage
// name — see the 2026-08-31 conversation that settled this. "No atendidos" comes from
// the ticket having no advisor yet; "Resuelto" and "Pagado" are terminal states with
// their own dedicated, deliberate actions elsewhere (paid needs a payment method
// captured too, and is one-way once set — not something to flip with a casual drag).
// Every column defaults most-recently-active-first and can be flipped — real pagination
// means flipping a column never hides anything, it's purely a display preference now.
const DEFAULT_SORT = {};

// Only these move by dragging — each is a plain, reversible manual_status write, no
// extra info required. Dropping onto "resuelto" is also allowed (a natural way to
// close out a card), just not dragging out of it. "pendiente" is display only: taking a
// ticket stays a deliberate button action. "pagado" is draggable ONLY into "despacho"
// (enforced in moveCard below, not here) — marking someone paid otherwise stays
// protected from casual dragging, this is the one deliberate exception (2026-09-11).
const DRAG_SOURCES = new Set(['en_atencion', 'cotizacion', 'medio_pago', 'pqrs', 'pagado', 'despacho']);
const DROP_TARGETS = new Set(['en_atencion', 'cotizacion', 'medio_pago', 'pqrs', 'resuelto', 'despacho']);

// Pagado and despacho only ever move FORWARD — pagado into despacho, despacho into
// resuelto. A backward or sideways drag from either is pointless (customers.js's
// paid_locked guard would just pin manual_status back to 'pagado' server-side anyway),
// so both the drag handler and the "Mover a" dropdown share this restriction instead of
// one silently rejecting a move the other still offers.
function allowedTargetsFor(sourceKey) {
  if (sourceKey === 'pagado') return new Set(['despacho']);
  if (sourceKey === 'despacho') return new Set(['resuelto']);
  return DROP_TARGETS;
}

// "No atendidos" is overdue on raw wait time (nobody's even looked yet — the default
// 15 min is meant to be aggressive there, see slaMinutes below). These 4 are already
// claimed/active — what actually matters is whether the CUSTOMER is the one waiting: if
// the advisor already replied, the clock is on the customer, not us, no matter how long
// it's been. A longer default window (an hour, not 15 minutes) since this is a real
// back-and-forth, not an unclaimed queue. Both thresholds are admin-editable
// (Configuración > General) — the constants below are just the fallback defaults.
const AWAITING_REPLY_COLUMNS = new Set(['en_atencion', 'cotizacion', 'medio_pago', 'pqrs']);
const DEFAULT_SLA_MINUTES = 15;
const DEFAULT_AWAITING_REPLY_OVERDUE_MINUTES = 60;
const TEMPERATURE_FOR_COLUMN = { en_atencion: 'frio', cotizacion: 'tibio', medio_pago: 'caliente', pqrs: 'pqrs', despacho: 'despacho' };

const PAGE_SIZE = 50;

// "60" reads better as "1h" than "60 min" in the overdue tooltip — matches the
// implicit assumption the old hardcoded "(más de 1h)" text baked in, now that the
// threshold itself can be any number an admin picks.
function formatMinutes(m) {
  return m % 60 === 0 ? `${m / 60}h` : `${m} min`;
}

// Guatemala never observes DST — a fixed -06 offset always gives today's real local
// calendar date regardless of the browser's own timezone, matching the same
// convention the "Sin responder" report and the backend's own pipeline date filter use.
function guatemalaToday() {
  return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function monthBounds(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const PERIOD_OPTIONS = [
  { value: 'todo', label: 'Todo', icon: LayoutGrid, iconClassName: 'text-greige-ink' },
  { value: 'hoy', label: 'Hoy', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'ayer', label: 'Ayer', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'semana', label: 'Última semana', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'mes', label: 'Mes', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'personalizado', label: 'Periodo personalizado', icon: Calendar, iconClassName: 'text-accent' },
];
function emptyColumn(key) {
  return { cards: [], total: 0, newTotal: null, continuingTotal: null, newTodayTotal: 0, unreadTotal: 0, offset: 0, loading: false, sort: DEFAULT_SORT[key] ?? 'desc' };
}
function emptyColumns() {
  return Object.fromEntries(COLUMN_ORDER.map((key) => [key, emptyColumn(key)]));
}

// A key missing from a previously-saved custom order (a new column added after an admin
// already customized theirs, like "despacho" — 2026-09-11) gets inserted right after its
// nearest preceding neighbor in COLUMN_ORDER, instead of just tacked onto the end —
// otherwise "despacho" (meant to sit right after "pagado") landed after "resuelto"
// because that's wherever the custom order happened to end.
function mergeDisplayOrder(customOrder) {
  if (!customOrder) return COLUMN_ORDER;
  const result = customOrder.map((c) => c.key);
  for (const key of COLUMN_ORDER) {
    if (result.includes(key)) continue;
    const idx = COLUMN_ORDER.indexOf(key);
    let insertAt = result.length;
    for (let i = idx - 1; i >= 0; i--) {
      const pos = result.indexOf(COLUMN_ORDER[i]);
      if (pos !== -1) { insertAt = pos + 1; break; }
    }
    result.splice(insertAt, 0, key);
  }
  return result;
}

export default function HandoffQueue({ user, onOpenConversation }) {
  // 2026-09-11: search/period/column filters are admin+supervisor only — an asesor
  // gets the full board (defaults do the rest: "Todo" period, no column narrowing) plus
  // just "Solo no leídos", which stays available to every role.
  const canFilter = user.role === 'admin' || user.role === 'supervisor';
  const [columns, setColumns] = useState(emptyColumns);
  const [search, setSearch] = useState('');
  // Debounced separately from `search` itself — the input needs to feel instant, but a
  // search re-fetches every column server-side (see `searching` below), so typing
  // shouldn't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  const searching = debouncedSearch.length > 0;
  // Independent of the period/search filters — narrows whatever's already selected
  // instead of replacing it (Hoy + solo no leídos, una búsqueda + solo no leídos, etc.
  // all compose).
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [exportingKey, setExportingKey] = useState(null);
  const [error, setError] = useState(null);
  const [busyTicketId, setBusyTicketId] = useState(null);
  const dragDataRef = useRef(null);

  // Admin-editable label/icon/color/order (Configuración > Pipeline) — null until
  // loaded, everything falls back to DEFAULT_COLUMN_META/COLUMN_ORDER until then.
  const [pipelineColumns, setPipelineColumns] = useState(null);
  // Admin-editable overdue thresholds (Configuración > General) — start at the same
  // defaults the code used to hardcode, updated once the real setting loads.
  const [slaMinutes, setSlaMinutes] = useState(DEFAULT_SLA_MINUTES);
  const [awaitingReplyOverdueMinutes, setAwaitingReplyOverdueMinutes] = useState(DEFAULT_AWAITING_REPLY_OVERDUE_MINUTES);
  useEffect(() => {
    fetchSettings().then((rows) => {
      const pipelineValue = rows.find((r) => r.key === 'pipeline_columns')?.value;
      if (Array.isArray(pipelineValue)) setPipelineColumns(pipelineValue);
      const slaValue = rows.find((r) => r.key === 'sla_minutes')?.value;
      if (Number.isFinite(slaValue)) setSlaMinutes(slaValue);
      const awaitingValue = rows.find((r) => r.key === 'awaiting_reply_overdue_minutes')?.value;
      if (Number.isFinite(awaitingValue)) setAwaitingReplyOverdueMinutes(awaitingValue);
    }).catch(() => {});
  }, []);
  const displayOrder = mergeDisplayOrder(pipelineColumns);
  function metaFor(key) {
    const cfg = pipelineColumns?.find((c) => c.key === key) ?? DEFAULT_COLUMN_META[key];
    return {
      label: cfg.label,
      icon: PIPELINE_ICON_MAP[cfg.icon] ?? CheckCircle2,
      ...(PIPELINE_COLOR_CLASSES[cfg.color] ?? PIPELINE_COLOR_CLASSES.info),
    };
  }
  const columnFilterOptions = [
    { value: '', label: 'Todas las columnas', icon: LayoutGrid, iconClassName: 'text-greige-ink' },
    ...displayOrder.map((key) => ({ value: key, label: metaFor(key).label, icon: metaFor(key).icon, iconClassName: metaFor(key).iconText })),
  ];

  // Date filter: which period each column's cards/count are scoped to (see api.js's
  // from/to, filtered server-side on the same field the column already sorts by).
  // "onlyColumn" is purely a render-time filter, not a fetch param — every column keeps
  // loading in the background so its count stays right if you switch back to it.
  // Defaults to "Todo" (2026-09-11: reverted from "Hoy" per request) — opens showing
  // the whole pipeline, not just today's slice.
  const [periodPreset, setPeriodPreset] = useState('todo');
  const todayStr = guatemalaToday();
  const [monthCursor, setMonthCursor] = useState(() => {
    const [y, m] = todayStr.split('-').map(Number);
    return { year: y, month: m };
  });
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);
  const [onlyColumn, setOnlyColumn] = useState('');

  // "Hoy"/"Ayer" don't cut at calendar midnight — they cut at the last moment staff
  // (advisor/supervisor/admin, all tagged sentBy:'advisor') wrote before that day
  // started, since a shift's leftover backlog from 11pm is "today's" work, not
  // yesterday's. Fetched once on mount, not kept live — a fixed snapshot for the
  // session, same reasoning as the old "Novedades" idea this replaces.
  const guatemalaMidnight = (dateStr) => `${dateStr}T00:00:00-06:00`;
  const [todayCutoff, setTodayCutoff] = useState(null);
  const [yesterdayCutoff, setYesterdayCutoff] = useState(null);
  useEffect(() => {
    fetchLastAdvisorActivity(guatemalaMidnight(todayStr)).then(({ timestamp }) => setTodayCutoff(timestamp)).catch(() => {});
    fetchLastAdvisorActivity(guatemalaMidnight(addDays(todayStr, -1))).then(({ timestamp }) => setYesterdayCutoff(timestamp)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let dateFrom, dateTo, sinceTs, untilTs;
  if (periodPreset === 'hoy') { sinceTs = todayCutoff ?? guatemalaMidnight(todayStr); }
  else if (periodPreset === 'ayer') {
    sinceTs = yesterdayCutoff ?? guatemalaMidnight(addDays(todayStr, -1));
    untilTs = todayCutoff ?? guatemalaMidnight(todayStr);
  }
  else if (periodPreset === 'semana') { dateFrom = addDays(todayStr, -6); dateTo = todayStr; }
  else if (periodPreset === 'mes') { ({ from: dateFrom, to: dateTo } = monthBounds(monthCursor.year, monthCursor.month)); }
  else if (periodPreset === 'personalizado') { dateFrom = customFrom; dateTo = customTo; }

  // Whole column, not just the loaded page — same period/search/unread filters already
  // active on the board, sent straight to the unpaginated /pipeline/export endpoint
  // instead of trying to page through everything client-side.
  async function exportColumn(key) {
    setExportingKey(key);
    try {
      const rows = await fetchPipelineExport(key, { from: dateFrom, to: dateTo, since: sinceTs, until: untilTs, q: searching ? debouncedSearch : undefined, unreadOnly });
      if (!rows.length) { showError('No hay nada que exportar en esta columna con los filtros actuales'); return; }
      const meta = metaFor(key);
      const headers = ['Cliente', 'Teléfono', 'Esperando desde', 'Último mensaje'];
      const lines = rows.map((r) => [r.fullName ?? '', r.whatsappNumber, formatWait(r.lastMessageAt ?? r.stageSince), r.lastMessage ?? '']);
      const ws = XLSX.utils.aoa_to_sheet([headers, ...lines]);
      ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 40 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, meta.label.slice(0, 31));
      XLSX.writeFile(wb, `pipeline_${key}_${guatemalaToday()}.xlsx`);
      showSuccess(`${rows.length} cliente(s) exportado(s)`);
    } catch (err) {
      showError(err.message);
    } finally {
      setExportingKey(null);
    }
  }

  function shiftMonth(delta) {
    setMonthCursor((prev) => {
      let month = prev.month + delta;
      let year = prev.year;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      return { year, month };
    });
  }
  // Same live-presence map Conversations.jsx keeps — keyed by phone (cleanSessionId
  // strips everything after "__", which for a real WhatsApp session IS the phone), so
  // card.whatsappNumber matches these keys with no extra lookup needed.
  const [presenceByPhone, setPresenceByPhone] = useState({});
  useEffect(() => {
    let cancelled = false;
    fetchPresenceSnapshot().then((rows) => {
      if (cancelled) return;
      const map = {};
      for (const r of rows) map[r.sessionId] = { userId: r.userId, fullName: r.fullName };
      setPresenceByPhone(map);
    }).catch(() => {});
    const unsubscribe = onLiveEvent('presence_changes', (data) => {
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      const { sessionId, userId, fullName } = payload;
      setPresenceByPhone((prev) => {
        const next = { ...prev };
        if (userId) next[sessionId] = { userId, fullName };
        else delete next[sessionId];
        return next;
      });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);
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
      const { cards, total, newTotal, continuingTotal, newTodayTotal, unreadTotal } = await fetchPipelineColumn(key, { offset: 0, limit: PAGE_SIZE, sort, from: dateFrom, to: dateTo, since: sinceTs, until: untilTs, q: searching ? debouncedSearch : undefined, unreadOnly });
      setColumns((prev) => ({ ...prev, [key]: { cards, total, newTotal, continuingTotal, newTodayTotal, unreadTotal, offset: cards.length, loading: false, sort } }));
    } catch (err) {
      setError(err.message);
      setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  }, [dateFrom, dateTo, sinceTs, untilTs, searching, debouncedSearch, unreadOnly]);

  // Appends the next page — this is what makes scrolling to the bottom of, say, "En
  // conversación" (2733 contacts) eventually reach every one of them, a bounded page at
  // a time, instead of ever asking the database for all of them in one go.
  const loadMore = useCallback(async (key) => {
    const col = columnsRef.current[key];
    if (col.loading || col.cards.length >= col.total) return;
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: true } }));
    try {
      const { cards } = await fetchPipelineColumn(key, { offset: col.offset, limit: PAGE_SIZE, sort: col.sort, from: dateFrom, to: dateTo, since: sinceTs, until: untilTs, q: searching ? debouncedSearch : undefined, unreadOnly });
      setColumns((prev) => ({
        ...prev,
        [key]: { ...prev[key], cards: [...prev[key].cards, ...cards], offset: prev[key].offset + cards.length, loading: false },
      }));
    } catch (err) {
      showError(err.message);
      setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  }, [dateFrom, dateTo, sinceTs, untilTs, searching, debouncedSearch, unreadOnly]);

  const reloadAll = useCallback(() => {
    for (const key of COLUMN_ORDER) loadColumn(key, columnsRef.current[key].sort);
  }, [loadColumn]);

  // Also re-fires on mount (dateFrom/dateTo are already set on first render) — one
  // effect covers both the initial load and any period/month/custom-range change.
  useEffect(() => { reloadAll(); }, [reloadAll]); // eslint-disable-line react-hooks/exhaustive-deps
  // ticket_changes also now fires on a plain customer temperature change (drag-and-drop,
  // the OCR auto-Pagado, "Marcar como Pagado" — see db/init/037), not just a real ticket
  // row — reused instead of a new channel since this board already listens to it.
  useLiveEvent('ticket_changes', reloadAll);
  // A new message is what moves the unread badge and "atrasado" clock — without this,
  // those only updated on the next drag/take action or the 60s fallback below.
  useLiveEvent('message_changes', reloadAll);
  // Marking a thread read/unread from Conversations changes conversation_reads, which
  // this board's own unread_count depends on — without this the badge only caught up
  // on the next unrelated reload (message/ticket change or the 60s fallback).
  useLiveEvent('read_changes', reloadAll);
  // Safety net for anything that still slips through (e.g. this tab losing its SSE
  // connection briefly) — same fallback role polling already played in the old queue view.
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

  // Shared by the desktop drag-and-drop drop handler and the mobile "Mover a" select
  // below — native HTML5 drag events never fire on touchscreens, so phones need a
  // second, tap-based way to do the exact same move.
  async function moveCard(drag, targetColumn) {
    if (!drag || drag.sourceColumn === targetColumn) return;
    if (!allowedTargetsFor(drag.sourceColumn).has(targetColumn)) return;

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

  async function handleDrop(e, targetColumn) {
    e.preventDefault();
    const drag = dragDataRef.current;
    dragDataRef.current = null;
    await moveCard(drag, targetColumn);
  }

  const q = search.trim().toLowerCase();
  const matches = (c) => !q || (c.fullName || '').toLowerCase().includes(q) || (c.whatsappNumber || '').includes(q);

  // The single number the period filter is actually for — "cuántos entraron hoy",
  // not "go add up the 7 column headers yourself". Sums whatever's currently visible:
  // every column, or just the one onlyColumn has narrowed to.
  const visibleColumnKeys = COLUMN_ORDER.filter((key) => searching || !onlyColumn || key === onlyColumn);
  const grandTotal = visibleColumnKeys.reduce((sum, key) => sum + (columns[key]?.total ?? 0), 0);
  const periodLabel = searching ? 'Búsqueda' : PERIOD_OPTIONS.find((o) => o.value === periodPreset)?.label ?? '';
  // Nuevas (el primer contacto de ese cliente cae dentro del periodo elegido) vs
  // continuas (ya existían antes) — solo tiene sentido con un periodo acotado (no
  // "Todo" ni una búsqueda), así que el backend manda null y aquí simplemente no se
  // muestra en vez de mostrar un desglose sin significado.
  const hasNewBreakdown = !searching && visibleColumnKeys.every((key) => (columns[key]?.newTotal ?? null) !== null);
  const grandNewTotal = hasNewBreakdown ? visibleColumnKeys.reduce((sum, key) => sum + (columns[key]?.newTotal ?? 0), 0) : null;
  const grandContinuingTotal = hasNewBreakdown ? visibleColumnKeys.reduce((sum, key) => sum + (columns[key]?.continuingTotal ?? 0), 0) : null;
  // Fixed to today regardless of the period filter — "cuánta gente entró hoy", always
  // shown, same reasoning as the period-relative breakdown above but anchored instead
  // of relative. Per-column pendientes/no leídos: "pendiente" IS entirely waiting (its
  // own total already means that), every other column's own unreadTotal is the
  // "esperando respuesta" figure for it.
  const grandNewToday = visibleColumnKeys.reduce((sum, key) => sum + (columns[key]?.newTodayTotal ?? 0), 0);
  // "pendiente" excluded here — everyone in it is already counted under "No atendidos"
  // below, and it has no card of its own in unreadByColumn either, so including it here
  // made the total not match the sum of the cards actually shown (2026-09-11 report).
  const grandUnreadTotal = visibleColumnKeys.filter((key) => key !== 'pendiente').reduce((sum, key) => sum + (columns[key]?.unreadTotal ?? 0), 0);
  // Each card here is "waiting on us" — gets the red alert dot whenever it's nonzero.
  // "Total" and "Nuevas hoy" are neutral counts, not something waiting on a reply, so
  // they never alert. No standalone "No atendidos" card — that number is already the
  // No atendidos column's own header count on the board right below, showing it twice
  // was pure redundancy (2026-09-11 report). Per-column unread cards (one per section
  // that actually has any, "pendiente" excluded — same reasoning) tack onto the same
  // grid instead of a separate pill row, per request — same card, not a smaller shape.
  const statCards = [
    {
      key: 'new-today', label: 'Nuevas hoy', value: grandNewToday, unit: grandNewToday === 1 ? 'conversación' : 'conversaciones',
      iconBg: 'bg-accent-soft', iconText: 'text-accent', icon: Calendar, alert: false,
    },
    {
      key: 'unread', label: 'No leídos', value: grandUnreadTotal, unit: grandUnreadTotal === 1 ? 'chat' : 'chats',
      iconBg: 'bg-warning/10', iconText: 'text-warning', icon: Mail, alert: grandUnreadTotal > 0,
    },
    ...COLUMN_ORDER.filter((key) => key !== 'pendiente' && (columns[key]?.unreadTotal ?? 0) > 0).map((key) => {
      const meta = metaFor(key);
      const count = columns[key].unreadTotal;
      // Shorter, more familiar than the pipeline-stage name for these three — same
      // temperature words the drag-and-drop/tag logic already uses internally
      // (TEMPERATURE_FOR_COLUMN) — keeps each card narrow enough that more fit per row.
      const shortLabel = { en_atencion: 'Frío', cotizacion: 'Tibio', medio_pago: 'Caliente' }[key] ?? meta.label;
      return {
        key: `unread-${key}`, label: `${shortLabel} · no leídos`, value: count, unit: count === 1 ? 'chat' : 'chats',
        iconBg: meta.iconBg, iconText: meta.iconText, icon: meta.icon, alert: true,
      };
    }),
    // Total last, per request — the other cards are what actually needs attention.
    {
      key: 'total', label: periodLabel, value: grandTotal, unit: grandTotal === 1 ? 'conversación' : 'conversaciones',
      iconBg: 'bg-black/[0.04] dark:bg-white/[0.06]', iconText: 'text-ink', icon: LayoutGrid, alert: false,
      sub: hasNewBreakdown ? `${grandNewTotal} nuevas · ${grandContinuingTotal} continuas` : null,
    },
  ];

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="border-b border-border p-4">
        {/* No flex-wrap on this outer row — the title stays pinned top-left on its own
            line no matter what; only the stat strip (flex-1, wraps internally within
            whatever width is left) drops to a second line when it needs to. */}
        <div className="flex items-start justify-between gap-3">
          <h1 className="shrink-0 text-lg font-semibold tracking-tight">Pipeline</h1>
          <div className="flex min-w-0 flex-1 flex-wrap items-stretch justify-end gap-1.5">
            {statCards.map((c) => {
              const Icon = c.icon;
              return (
                <div
                  key={c.key}
                  title={c.sub ?? undefined}
                  className="relative flex shrink-0 items-center gap-2 rounded-lg border border-line bg-paper px-3 py-1.5 shadow-sm"
                >
                  {c.alert && (
                    <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5 items-center justify-center">
                      <span className="absolute h-full w-full animate-ping rounded-full bg-danger opacity-60" />
                      <span className="relative h-2 w-2 rounded-full bg-danger" />
                    </span>
                  )}
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${c.iconBg} ${c.iconText}`}>
                    <Icon size={12} />
                  </span>
                  <span className="whitespace-nowrap text-lg font-semibold leading-none tracking-tight text-ink">{c.value}</span>
                  <span className="whitespace-nowrap text-xs leading-none text-greige-ink">{c.label}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Search is the one filter every role gets — an asesor just doesn't get
              period/column narrowing or "Solo no leídos" alongside it. */}
          <div className="relative min-w-[200px] flex-1 sm:max-w-sm">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o número"
              className="w-full rounded-full border border-border bg-muted py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent focus:bg-paper"
            />
          </div>

          {canFilter && (
            <>
              <Select value={periodPreset} onChange={setPeriodPreset} options={PERIOD_OPTIONS} className="w-44 shrink-0" />

              {periodPreset === 'mes' && (
                <div className="flex shrink-0 items-center gap-1 rounded-lg border border-line bg-paper px-1.5 py-1.5 shadow-sm">
                  <button type="button" onClick={() => shiftMonth(-1)} className="rounded-full p-0.5 text-greige-ink transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Mes anterior">
                    <ChevronLeft size={14} />
                  </button>
                  <span className="min-w-[108px] text-center text-xs font-medium text-ink">{MONTH_NAMES[monthCursor.month - 1]} {monthCursor.year}</span>
                  <button type="button" onClick={() => shiftMonth(1)} className="rounded-full p-0.5 text-greige-ink transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Mes siguiente">
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}

              {periodPreset === 'personalizado' && (
                <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 shadow-sm">
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="bg-transparent text-xs text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]"
                  />
                  <span className="text-xs text-greige-ink">a</span>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="bg-transparent text-xs text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]"
                  />
                </div>
              )}

              <Select value={onlyColumn} onChange={setOnlyColumn} options={columnFilterOptions} className="w-48 shrink-0" />

              <button
                type="button"
                onClick={() => setUnreadOnly((v) => !v)}
                aria-pressed={unreadOnly}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-colors ${
                  unreadOnly ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-paper text-greige-ink hover:text-ink'
                }`}
              >
                <Mail size={12} /> Solo no leídos
              </button>
            </>
          )}

          {!searching && (periodPreset === 'hoy' || periodPreset === 'ayer') && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-greige-ink shadow-sm">
              <Clock size={12} className="text-accent" />
              {periodPreset === 'hoy'
                ? <>Desde el último mensaje de un asesor ayer — {new Date(sinceTs).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })}</>
                : <>De {new Date(sinceTs).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })} a {new Date(untilTs).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })}</>}
            </span>
          )}
        </div>
      </div>

      {error && <p className="p-4 text-sm text-danger">{error}</p>}
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {displayOrder.filter((key) => searching || !onlyColumn || key === onlyColumn).map((key) => {
          const meta = metaFor(key);
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
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.iconBg} ${meta.iconText}`}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{meta.label}</span>
                <span className="shrink-0 rounded-full bg-paper px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground shadow-sm">
                  {q ? cards.length : col.total}
                </span>
                <button
                  type="button"
                  onClick={() => exportColumn(key)}
                  disabled={exportingKey === key}
                  title="Descargar Excel con todos los de esta columna (con los filtros actuales)"
                  className="flex shrink-0 items-center justify-center rounded-full border border-border p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {exportingKey === key ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort(key)}
                  title={col.sort === 'asc' ? 'Más antiguo primero — clic para cambiar' : 'Más reciente primero — clic para cambiar'}
                  className="flex shrink-0 items-center justify-center rounded-full border border-border p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowUpDown size={11} />
                </button>
              </div>
              <div onScroll={(e) => handleScroll(e, key)} className="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                {cards.length === 0 && !col.loading && (
                  <p className="p-3 text-center text-xs text-muted-foreground">Nada aquí.</p>
                )}
                {cards.map((card) => {
                  const overdue = key === 'pendiente'
                    ? minutesSince(card.stageSince) > slaMinutes
                    : AWAITING_REPLY_COLUMNS.has(key) && card.awaitingReply && card.lastMessageAt
                      && minutesSince(card.lastMessageAt) > awaitingReplyOverdueMinutes;
                  const unreadCount = card.unreadCount ?? 0;
                  const hasUnread = unreadCount > 0;
                  // Someone (possibly me, elsewhere) currently has this chat open in
                  // Conversaciones — same live map that page keeps, just consumed here
                  // read-only (Pipeline itself never "holds" a chat open).
                  const presence = presenceByPhone[card.whatsappNumber];
                  return (
                    <div
                      key={card.ticketId}
                      draggable={DRAG_SOURCES.has(key)}
                      onDragStart={(e) => handleDragStart(e, card, key)}
                      title={presence ? `${presence.fullName || 'Alguien'} tiene este chat abierto` : undefined}
                      style={presence ? { backgroundColor: hexToRgba(colorFor(presence.fullName), 0.14) } : undefined}
                      className={`rounded-xl border p-3 shadow-sm transition-shadow hover:shadow-md ${
                        overdue ? 'border-danger/40 bg-danger/5' : hasUnread ? 'border-warning/40 bg-warning/5' : 'border-border bg-paper'
                      } ${DRAG_SOURCES.has(key) ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{card.fullName || card.whatsappNumber}</p>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {hasUnread && (
                            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-warning px-1.5 text-[10px] font-bold text-white">
                              {unreadCount > 99 ? '99+' : unreadCount}
                            </span>
                          )}
                          {overdue && (
                            <span className="flex animate-pulse items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-white">
                              <AlertTriangle size={10} /> atrasado
                            </span>
                          )}
                        </div>
                      </div>
                      {(card.previewMessage ?? card.lastMessage) && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {/* awaitingReply false means the preview is OUR most recent message, not the
                              customer's — without this prefix it reads as if the customer said it. */}
                          {!card.awaitingReply && <span className="font-medium text-ink">Tú: </span>}
                          {card.previewMessage ?? card.lastMessage}
                        </p>
                      )}
                      {card.assignedAdvisor && (
                        <span
                          className="mt-1.5 flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          style={{ backgroundColor: hexToRgba(colorFor(card.assignedAdvisor), 0.16), color: colorFor(card.assignedAdvisor) }}
                        >
                          <Headset size={10} /> {card.assignedAdvisor.split(' ')[0]}
                        </span>
                      )}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className={`flex items-center gap-1 text-[11px] ${overdue ? 'font-semibold text-danger' : 'text-muted-foreground'}`}>
                          {overdue
                            ? key === 'pendiente'
                              ? `Esperando hace ${formatWait(card.stageSince)} (más de ${slaMinutes} min)`
                              : `Sin responder hace ${formatWait(card.lastMessageAt)} (más de ${formatMinutes(awaitingReplyOverdueMinutes)})`
                            : `hace ${formatWait(card.previewMessageAt ?? card.lastMessageAt ?? card.stageSince)}`}
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
                      {DRAG_SOURCES.has(key) && (
                        // Touch devices never fire HTML5 drag events — a tablet in
                        // landscape can be wider than any viewport breakpoint and still
                        // be touch-only, so this stays available at every width rather
                        // than being hidden above md.
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) moveCard({ ticketId: card.ticketId, customerId: card.customerId, sourceColumn: key }, e.target.value);
                          }}
                          className="mt-2 w-full rounded-lg border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground outline-none"
                        >
                          <option value="">Mover a…</option>
                          {[...allowedTargetsFor(key)].filter((t) => t !== key).map((t) => (
                            <option key={t} value={t}>{metaFor(t).label}</option>
                          ))}
                        </select>
                      )}
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
