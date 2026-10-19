import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';

// Menú "Herramientas" del panel de ventas por asesora: agrupa las acciones que se usan de vez en cuando
// (exportar, copiar el resumen, analizar chats, auditar) para dejar a la vista solo lo de todos los días.
// items: [{ label, hint?, icon, onClick, disabled?, busy? }]
export default function SalesToolsMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-xl border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-muted"
      >
        <span>Herramientas</span>
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1.5 w-72 rounded-xl border border-line bg-paper p-1.5 shadow-lg">
          {items.map((item) => {
            const Icon = item.busy ? RefreshCw : item.icon;
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { setOpen(false); item.onClick(); }}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
              >
                <Icon size={14} className={`mt-0.5 shrink-0 text-greige-ink ${item.busy ? 'animate-spin' : ''}`} />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-ink">{item.label}</span>
                  {item.hint && <span className="mt-0.5 block text-[11px] leading-snug text-greige-ink">{item.hint}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
