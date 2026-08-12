import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Confirmar', danger = false, busy = false, confirmDisabled = false, children, onConfirm, onCancel }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', bounce: 0.25, duration: 0.45 }}
            className="glass-card w-full max-w-sm rounded-2xl border border-line bg-paper p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${danger ? 'bg-danger-bg text-danger' : 'bg-accent-soft text-accent'}`}>
                <AlertTriangle size={18} />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-greige-ink">{message}</p>
              </div>
            </div>
            {children && <div className="mt-4">{children}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onCancel}
                disabled={busy}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-greige-ink transition-colors hover:bg-black/[0.04] hover:text-ink disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={onConfirm}
                disabled={busy || confirmDisabled}
                className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50 ${
                  danger ? 'bg-danger' : 'bg-accent'
                }`}
              >
                {busy ? 'Un momento…' : confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
