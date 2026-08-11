import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function Pagination({
  page, pageCount, totalItems, pageSize, onChange,
  pageSizeOptions, onPageSizeChange,
}) {
  if (totalItems === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground">
          {from}–{to} de {totalItems}
        </p>
        {pageSizeOptions && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Mostrar
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="rounded-md border border-border px-1.5 py-1 text-xs outline-none focus:border-primary"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => onChange(page - 1)}
            disabled={page === 1}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            aria-label="Página anterior"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="px-2 text-xs text-muted-foreground">
            Página {page} de {pageCount}
          </span>
          <button
            onClick={() => onChange(page + 1)}
            disabled={page === pageCount}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            aria-label="Página siguiente"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
