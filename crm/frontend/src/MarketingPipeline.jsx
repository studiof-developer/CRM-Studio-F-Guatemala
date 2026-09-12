import { useEffect, useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Loader2, Download, RefreshCw, CheckCircle2, Search, Clock, ChevronLeft, ChevronRight, Mail, LayoutGrid } from 'lucide-react';
import { fetchPipelineColumn, fetchPipelineExport } from './api.js';
import Select from './components/Select.jsx';
import { showSuccess, showError } from './components/Toast.jsx';
import { formatWait } from './lib/sla.js';
import { DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_COLOR_CLASSES } from './lib/pipelineColumns.js';
import { guatemalaToday, addDays, monthBounds, MONTH_NAMES, PERIOD_OPTIONS, guatemalaMidnight, useDayCutoffs } from './lib/pipelinePeriod.js';

// Only these 3 ever go dormant (2026-09-12 request) — "No atendidos" is already the
// highest-priority signal and shouldn't be hidden away, and "Pagado"/"PQRS"/"Por
// despacho" sitting quiet doesn't mean "cold lead" the way it does mid-conversation, so
// they stay off this board entirely (see DORMANT_ELIGIBLE_BUCKET_SQL in tickets.js).
const MARKETING_COLUMN_ORDER = ['en_atencion', 'cotizacion', 'medio_pago'];

// Marketing reads these as temperature, not pipeline stage — same 3 buckets, different
// vocabulary for the audience this board is actually for (2026-09-12 request). Icons/
// colors stay as-is (Snowflake/Thermometer/Flame already read as frío/tibio/caliente).
const MARKETING_LABELS = { en_atencion: 'Frío', cotizacion: 'Tibio', medio_pago: 'Caliente' };

const PAGE_SIZE = 50;

function metaFor(key) {
  const cfg = DEFAULT_COLUMN_META[key];
  return {
    label: MARKETING_LABELS[key] ?? cfg.label,
    icon: PIPELINE_ICON_MAP[cfg.icon] ?? CheckCircle2,
    ...(PIPELINE_COLOR_CLASSES[cfg.color] ?? PIPELINE_COLOR_CLASSES.info),
  };
}

const columnFilterOptions = [
  { value: '', label: 'Todas las columnas', icon: LayoutGrid, iconClassName: 'text-greige-ink' },
  ...MARKETING_COLUMN_ORDER.map((key) => ({ value: key, label: metaFor(key).label, icon: metaFor(key).icon, iconClassName: metaFor(key).iconText })),
];

function emptyColumn() {
  return { cards: [], total: 0, offset: 0, loading: false };
}
function emptyColumns() {
  return Object.fromEntries(MARKETING_COLUMN_ORDER.map((key) => [key, emptyColumn()]));
}

// Read-only reporting board: who's gone quiet (>24h since their own last message) in
// each pipeline stage, so Marketing can export the list and run a reactivation
// broadcast. No drag-and-drop, no Tomar, no SLA badges, no live SSE — a manual
// refresh is enough for a board nobody acts on directly. Same search/period/column/
// unread filters as the advisor Pipeline (2026-09-12 request), reusing the exact
// helpers HandoffQueue.jsx uses — see lib/pipelinePeriod.js.
export default function MarketingPipeline({ onOpenConversation }) {
  const [columns, setColumns] = useState(emptyColumns);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  const searching = debouncedSearch.length > 0;
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [onlyColumn, setOnlyColumn] = useState('');
  const [exportingKey, setExportingKey] = useState(null);
  const [error, setError] = useState(null);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const [periodPreset, setPeriodPreset] = useState('todo');
  const todayStr = guatemalaToday();
  const [monthCursor, setMonthCursor] = useState(() => {
    const [y, m] = todayStr.split('-').map(Number);
    return { year: y, month: m };
  });
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);
  const { todayCutoff, yesterdayCutoff } = useDayCutoffs(todayStr);

  let dateFrom, dateTo, sinceTs, untilTs;
  if (periodPreset === 'hoy') { sinceTs = todayCutoff ?? guatemalaMidnight(todayStr); }
  else if (periodPreset === 'ayer') {
    sinceTs = yesterdayCutoff ?? guatemalaMidnight(addDays(todayStr, -1));
    untilTs = todayCutoff ?? guatemalaMidnight(todayStr);
  }
  else if (periodPreset === 'semana') { dateFrom = addDays(todayStr, -6); dateTo = todayStr; }
  else if (periodPreset === 'mes') { ({ from: dateFrom, to: dateTo } = monthBounds(monthCursor.year, monthCursor.month)); }
  else if (periodPreset === 'personalizado') { dateFrom = customFrom; dateTo = customTo; }

  function shiftMonth(delta) {
    setMonthCursor((prev) => {
      let month = prev.month + delta;
      let year = prev.year;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      return { year, month };
    });
  }

  const loadColumn = useCallback(async (key) => {
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: true } }));
    try {
      const { cards, total } = await fetchPipelineColumn(key, { offset: 0, limit: PAGE_SIZE, dormant: true, from: dateFrom, to: dateTo, since: sinceTs, until: untilTs, q: searching ? debouncedSearch : undefined, unreadOnly });
      setColumns((prev) => ({ ...prev, [key]: { cards, total, offset: cards.length, loading: false } }));
    } catch (err) {
      setError(err.message);
      setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  }, [dateFrom, dateTo, sinceTs, untilTs, searching, debouncedSearch, unreadOnly]);

  const loadMore = useCallback(async (key) => {
    const col = columnsRef.current[key];
    if (col.loading || col.cards.length >= col.total) return;
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: true } }));
    try {
      const { cards } = await fetchPipelineColumn(key, { offset: col.offset, limit: PAGE_SIZE, dormant: true, from: dateFrom, to: dateTo, since: sinceTs, until: untilTs, q: searching ? debouncedSearch : undefined, unreadOnly });
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
    for (const key of MARKETING_COLUMN_ORDER) loadColumn(key);
  }, [loadColumn]);

  useEffect(() => { reloadAll(); }, [reloadAll]);

  function handleScroll(e, key) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) loadMore(key);
  }

  async function exportColumn(key) {
    setExportingKey(key);
    try {
      const rows = await fetchPipelineExport(key, { dormant: true, from: dateFrom, to: dateTo, since: sinceTs, until: untilTs, q: searching ? debouncedSearch : undefined, unreadOnly });
      if (!rows.length) { showError('No hay nadie inactivo en esta columna con los filtros actuales'); return; }
      const meta = metaFor(key);
      const headers = ['Cliente', 'Teléfono', 'Sin responder desde', 'Último mensaje'];
      const lines = rows.map((r) => [r.fullName ?? '', r.whatsappNumber, formatWait(r.lastMessageAt ?? r.stageSince), r.lastMessage ?? '']);
      const ws = XLSX.utils.aoa_to_sheet([headers, ...lines]);
      ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 40 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, meta.label.slice(0, 31));
      XLSX.writeFile(wb, `marketing_pipeline_${key}_${guatemalaToday()}.xlsx`);
      showSuccess(`${rows.length} cliente(s) exportado(s)`);
    } catch (err) {
      showError(err.message);
    } finally {
      setExportingKey(null);
    }
  }

  const q = search.trim().toLowerCase();
  const matches = (c) => !q || (c.fullName || '').toLowerCase().includes(q) || (c.whatsappNumber || '').includes(q);

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-greige-ink">Clientes sin responder hace más de 24 horas, por etapa — listos para difusión.</p>
        <button
          type="button"
          onClick={reloadAll}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs font-medium text-greige-ink shadow-sm transition-colors hover:text-ink"
        >
          <RefreshCw size={12} /> Actualizar
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-sm">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o número"
            className="w-full rounded-full border border-border bg-muted py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent focus:bg-paper"
          />
        </div>

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

        {!searching && (periodPreset === 'hoy' || periodPreset === 'ayer') && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs text-greige-ink shadow-sm">
            <Clock size={12} className="text-accent" />
            {periodPreset === 'hoy'
              ? <>Desde el último mensaje de un asesor ayer — {new Date(sinceTs).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })}</>
              : <>De {new Date(sinceTs).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })} a {new Date(untilTs).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' })}</>}
          </span>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {MARKETING_COLUMN_ORDER.filter((key) => searching || !onlyColumn || key === onlyColumn).map((key) => {
          const meta = metaFor(key);
          const Icon = meta.icon;
          const col = columns[key];
          const cards = col.cards.filter(matches);
          return (
            <div key={key} className="flex w-72 shrink-0 flex-col rounded-2xl border border-border bg-muted/40">
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
                  title="Descargar Excel con todos los inactivos de esta columna"
                  className="flex shrink-0 items-center justify-center rounded-full border border-border p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {exportingKey === key ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                </button>
              </div>
              <div onScroll={(e) => handleScroll(e, key)} className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto p-2.5">
                {cards.length === 0 && !col.loading && (
                  <p className="p-3 text-center text-xs text-muted-foreground">Nadie inactivo aquí.</p>
                )}
                {cards.map((card) => (
                  <div key={card.ticketId} className="rounded-xl border border-border bg-paper p-3 shadow-sm">
                    <p className="text-sm font-medium">{card.fullName || card.whatsappNumber}</p>
                    <p className="text-xs text-muted-foreground">{card.whatsappNumber}</p>
                    {(card.previewMessage ?? card.lastMessage) && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {!card.awaitingReply && <span className="font-medium text-ink">Tú: </span>}
                        {card.previewMessage ?? card.lastMessage}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        hace {formatWait(card.previewMessageAt ?? card.lastMessageAt ?? card.stageSince)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onOpenConversation?.(card.whatsappNumber)}
                        className="text-xs font-semibold text-accent hover:underline"
                      >
                        Ir al chat
                      </button>
                    </div>
                  </div>
                ))}
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
