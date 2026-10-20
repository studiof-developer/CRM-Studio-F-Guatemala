import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

// Ventana informativa del CRM (ayuda, explicaciones largas): se cierra con la X, con Escape o al tocar fuera.
export default function InfoModal({ open, title, subtitle, onClose, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm" onClick={onClose}
        >
          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            initial={{ opacity: 0, scale: 0.97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ type: 'spring', bounce: 0.1, duration: 0.25 }}
            className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-xl" onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-ink">{title}</h2>
                {subtitle && <p className="mt-0.5 text-sm text-greige-ink">{subtitle}</p>}
              </div>
              <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-1.5 text-greige hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]"><X size={18} /></button>
            </div>
            <div className="overflow-y-auto px-6 py-5">{children}</div>
            <div className="flex justify-end border-t border-line px-6 py-3">
              <button type="button" onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90">Entendido</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
