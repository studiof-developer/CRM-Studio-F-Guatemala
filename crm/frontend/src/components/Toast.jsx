import toast from 'react-hot-toast';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

function ToastCard({ t, kind, message }) {
  const success = kind === 'success';
  return (
    <motion.div
      initial={{ opacity: 0, y: -16, scale: 0.9 }}
      animate={{ opacity: t.visible ? 1 : 0, y: t.visible ? 0 : -16, scale: t.visible ? 1 : 0.9 }}
      transition={{ type: 'spring', bounce: 0.35, duration: 0.5 }}
      className="glass-card flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3 shadow-lg"
    >
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${success ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'}`}>
        {success ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
      </span>
      <p className="text-sm font-medium text-ink">{message}</p>
    </motion.div>
  );
}

export function showSuccess(message) {
  toast.custom((t) => <ToastCard t={t} kind="success" message={message} />);
}

export function showError(message) {
  toast.custom((t) => <ToastCard t={t} kind="error" message={message} />, { duration: 5000 });
}
