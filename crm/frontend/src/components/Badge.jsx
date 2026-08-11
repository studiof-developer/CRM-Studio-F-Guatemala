const VARIANTS = {
  neutral: 'bg-line-soft text-greige-ink border-line',
  warning: 'bg-warn/10 text-warn border-warn/20',
  info: 'bg-accent-soft text-accent border-accent/20',
  success: 'bg-ok/10 text-ok border-ok/20',
  danger: 'bg-danger/10 text-danger border-danger/20',
  purple: 'bg-purple/10 text-purple border-purple/20',
};

export default function Badge({ variant = 'neutral', children }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${VARIANTS[variant]}`}
    >
      {children}
    </span>
  );
}
