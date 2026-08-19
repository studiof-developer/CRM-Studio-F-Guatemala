import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

// Native <select> can't be styled beyond its closed state — no per-option icons or
// colors, since the open list is OS-rendered in every browser that matters. This is
// a from-scratch dropdown so filters can carry the same icon/color language as the
// badges and pills everywhere else in the app.
//
// options: [{ value, label, icon?: LucideIcon, iconClassName?: string, meta?: string|number, group?: string }]
export default function Select({ value, onChange, options, placeholder = 'Seleccionar…', className = '', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const selected = options.find((o) => o.value === value);

  function toggle() {
    if (disabled) return;
    setHighlight(options.findIndex((o) => o.value === value));
    setOpen((o) => !o);
  }

  function selectOption(opt) {
    onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); toggle(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[highlight]) selectOption(options[highlight]); }
  }

  let lastGroup;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded-lg border bg-paper px-3 py-1.5 text-left text-xs font-medium text-ink outline-none transition-colors disabled:opacity-50 ${
          open ? 'border-accent' : 'border-line hover:border-line-soft'
        }`}
      >
        {selected?.icon && <selected.icon size={13} className={`shrink-0 ${selected.iconClassName ?? 'text-greige-ink'}`} />}
        <span className="flex-1 truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className={`shrink-0 text-greige transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div role="listbox" className="absolute left-0 right-0 z-30 mt-1.5 max-h-72 overflow-y-auto rounded-xl border border-line bg-paper p-1.5 shadow-lg">
          {options.map((opt, i) => {
            const showGroup = opt.group && opt.group !== lastGroup;
            lastGroup = opt.group;
            const isSelected = opt.value === value;
            return (
              <div key={opt.value}>
                {showGroup && (
                  <p className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-greige first:pt-1">{opt.group}</p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectOption(opt)}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                    isSelected
                      ? 'bg-accent-soft font-semibold text-accent'
                      : i === highlight
                        ? 'bg-black/[0.04] dark:bg-white/[0.06] text-ink'
                        : 'text-ink'
                  }`}
                >
                  {opt.icon && (
                    <opt.icon size={13} className={`shrink-0 ${isSelected ? 'text-accent' : opt.iconClassName ?? 'text-greige-ink'}`} />
                  )}
                  <span className="flex-1 truncate">{opt.label}</span>
                  {opt.meta != null && (
                    <span className="shrink-0 rounded-full bg-black/[0.05] dark:bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-greige-ink">
                      {opt.meta}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
