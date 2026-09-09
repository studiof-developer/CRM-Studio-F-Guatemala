import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import Conversations from '../Conversations.jsx';

// Reuses the exact same conversation-thread UI as the Conversaciones page — messages,
// composer, attachments, presence highlight, payment banner, every "toy" it already
// has — inside an overlay, instead of duplicating any of it. Conversations.jsx's own
// singleThreadMode just skips rendering its chat list, since the popup already knows
// which one conversation to show. `key={phone}` forces a clean remount per customer,
// so nothing (draft text, thread scroll position, presence target) leaks from one
// popup open to the next.
export default function ChatPopup({ phone, user, onClose }) {
  useEffect(() => {
    if (!phone) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phone, onClose]);

  return (
    <AnimatePresence>
      {phone && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            className="relative h-[88vh] w-[92vw] max-w-6xl overflow-hidden rounded-2xl border border-line bg-paper shadow-2xl"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.06] text-greige-ink transition-colors hover:bg-black/[0.12] dark:bg-white/[0.08] dark:hover:bg-white/[0.16]"
            >
              <X size={16} />
            </button>
            {/* Conversations.jsx's own root has no explicit width (it doesn't need one on
                the real Conversaciones page — its parent there is a plain block div, not
                a flex container). This wrapper's parent USED to be `flex`, which turns a
                plain block child into a flex item that shrinks to its content width
                instead of filling the box — exactly the large empty gap reported
                (2026-09-10). Dropped `flex` above so it goes back to filling 100% width,
                same as the real page. */}
            <Conversations key={phone} user={user} openSessionId={phone} onOpenedConversation={() => {}} singleThreadMode />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
