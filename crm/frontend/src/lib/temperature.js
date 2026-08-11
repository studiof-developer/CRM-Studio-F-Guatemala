import { Flame, Thermometer, Snowflake, CircleDollarSign, MessageSquareWarning } from 'lucide-react';

// Tailwind can't resolve dynamically-built class names (`bg-${variant}-bg`), so every
// combination is spelled out literally here instead of interpolated at render time.
export const TEMP_META = {
  caliente: { label: 'Caliente', variant: 'danger', icon: Flame, iconBg: 'bg-danger-bg', iconText: 'text-danger' },
  tibio: { label: 'Tibio', variant: 'warning', icon: Thermometer, iconBg: 'bg-warning-bg', iconText: 'text-warning' },
  frio: { label: 'Frío', variant: 'info', icon: Snowflake, iconBg: 'bg-info-bg', iconText: 'text-info' },
  pagado: { label: 'Pagado', variant: 'success', icon: CircleDollarSign, iconBg: 'bg-success-bg', iconText: 'text-success' },
  pqrs: { label: 'PQRS', variant: 'purple', icon: MessageSquareWarning, iconBg: 'bg-purple-bg', iconText: 'text-purple' },
};

export const BUCKET_ORDER = ['caliente', 'tibio', 'frio', 'pagado', 'pqrs'];
