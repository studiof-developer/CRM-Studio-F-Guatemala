import { useEffect, useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Loader2, Download, RefreshCw, CheckCircle2 } from 'lucide-react';
import { fetchPipelineColumn, fetchPipelineExport } from './api.js';
import { showSuccess, showError } from './components/Toast.jsx';
import { formatWait } from './lib/sla.js';
import { DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_COLOR_CLASSES } from './lib/pipelineColumns.js';

// Only these 3 ever go dormant (2026-09-12 request) — "No atendidos" is already the
// highest-priority signal and shouldn't be hidden away, and "Pagado"/"PQRS"/"Por
// despacho" sitting quiet doesn't mean "cold lead" the way it does mid-conversation, so
// they stay off this board entirely (see DORMANT_ELIGIBLE_BUCKET_SQL in tickets.js).
const MARKETING_COLUMN_ORDER = ['en_atencion', 'cotizacion', 'medio_pago'];

const PAGE_SIZE = 50;

function guatemalaToday() {
  return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
}

function metaFor(key) {
  const cfg = DEFAULT_COLUMN_META[key];
  return {
    label: cfg.label,
    icon: PIPELINE_ICON_MAP[cfg.icon] ?? CheckCircle2,
    ...(PIPELINE_COLOR_CLASSES[cfg.color] ?? PIPELINE_COLOR_CLASSES.info),
  };
}

function emptyColumn() {
  return { cards: [], total: 0, offset: 0, loading: false };
}
function emptyColumns() {
  return Object.fromEntries(MARKETING_COLUMN_ORDER.map((key) => [key, emptyColumn()]));
}

// Read-only reporting board: who's gone quiet (>24h since their own last message) in
// each pipeline stage, so Marketing can export the list and run a reactivation
// broadcast. No drag-and-drop, no Tomar, no SLA badges, no live SSE — a manual
// refresh is enough for a board nobody acts on directly.
export default function MarketingPipeline({ onOpenConversation }) {
  const [columns, setColumns] = useState(emptyColumns);
  const [exportingKey, setExportingKey] = useState(null);
  const [error, setError] = useState(null);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const loadColumn = useCallback(async (key) => {
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: true } }));
    try {
      const { cards, total } = await fetchPipelineColumn(key, { offset: 0, limit: PAGE_SIZE, dormant: true });
      setColumns((prev) => ({ ...prev, [key]: { cards, total, offset: cards.length, loading: false } }));
    } catch (err) {
      setError(err.message);
      setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  }, []);

  const loadMore = useCallback(async (key) => {
    const col = columnsRef.current[key];
    if (col.loading || col.cards.length >= col.total) return;
    setColumns((prev) => ({ ...prev, [key]: { ...prev[key], loading: true } }));
    try {
      const { cards } = await fetchPipelineColumn(key, { offset: col.offset, limit: PAGE_SIZE, dormant: true });
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
      const rows = await fetchPipelineExport(key, { dormant: true });
      if (!rows.length) { showError('No hay nadie inactivo en esta columna'); return; }
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

  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-greige-ink">Clientes sin responder hace más de 24 horas, por etapa — listos para difusión.</p>
        <button
          type="button"
          onClick={reloadAll}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs font-medium text-greige-ink shadow-sm transition-colors hover:text-ink"
        >
          <RefreshCw size={12} /> Actualizar
        </button>
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {MARKETING_COLUMN_ORDER.map((key) => {
          const meta = metaFor(key);
          const Icon = meta.icon;
          const col = columns[key];
          return (
            <div key={key} className="flex w-72 shrink-0 flex-col rounded-2xl border border-border bg-muted/40">
              <div className="flex items-center gap-2 border-b border-border p-3">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.iconBg} ${meta.iconText}`}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{meta.label}</span>
                <span className="shrink-0 rounded-full bg-paper px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground shadow-sm">
                  {col.total}
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
                {col.cards.length === 0 && !col.loading && (
                  <p className="p-3 text-center text-xs text-muted-foreground">Nadie inactivo aquí.</p>
                )}
                {col.cards.map((card) => (
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
