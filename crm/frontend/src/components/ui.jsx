import { motion } from 'framer-motion';

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-greige-ink">{subtitle}</p>}
      </motion.div>
      {action && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut', delay: 0.1 }}
        >
          {action}
        </motion.div>
      )}
    </div>
  );
}

export function Card({ children, className = '' }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className={`glass-card rounded-2xl p-6 ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function Field({ label, className = '', ...props }) {
  return (
    <label className="group flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-greige-ink transition-colors group-focus-within:text-accent">
        {label}
      </span>
      <input
        {...props}
        className={`rounded-xl border border-line bg-paper/50 px-4 py-3 text-[15px] text-ink shadow-sm outline-none transition-all placeholder:text-greige hover:bg-paper focus:border-transparent focus:ring-2 focus:ring-accent/80 ${className}`}
      />
    </label>
  );
}

export function SelectField({ label, options, className = '', ...props }) {
  return (
    <label className="group flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-greige-ink transition-colors group-focus-within:text-accent">
        {label}
      </span>
      <select
        {...props}
        className={`appearance-none rounded-xl border border-line bg-paper/50 px-4 py-3 text-[15px] text-ink shadow-sm outline-none transition-all hover:bg-paper focus:border-transparent focus:ring-2 focus:ring-accent/80 ${className}`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-white shadow-md shadow-accent/20 hover:bg-accent-hover',
  ghost: 'bg-paper/50 backdrop-blur-md border border-line text-ink hover:bg-paper',
  danger: 'bg-danger/10 border border-danger/20 text-danger hover:bg-danger hover:text-white',
};

export function Button({ children, variant = 'primary', className = '', ...props }) {
  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.96 }}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-semibold transition-colors disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </motion.button>
  );
}

export function EmptyState({ children, className = '' }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`rounded-2xl border border-dashed border-line bg-paper-soft p-12 text-center text-sm text-greige-ink backdrop-blur-sm ${className}`}
    >
      {children}
    </motion.div>
  );
}
