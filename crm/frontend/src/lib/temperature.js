import { Flame, Thermometer, Snowflake, CircleDollarSign, MessageSquareWarning, Package } from 'lucide-react';

// Tailwind can't resolve dynamically-built class names (`bg-${variant}-bg`), so every
// combination is spelled out literally here instead of interpolated at render time.
// "despacho" (2026-09-11) is manual-only, same as pagado/pqrs — never computed
// automatically, an advisor sets it themselves once a paid order starts shipping.
export const TEMP_META = {
  caliente: { label: 'Caliente', variant: 'danger', icon: Flame, iconBg: 'bg-danger-bg', iconText: 'text-danger' },
  tibio: { label: 'Tibio', variant: 'warning', icon: Thermometer, iconBg: 'bg-warning-bg', iconText: 'text-warning' },
  frio: { label: 'Frío', variant: 'info', icon: Snowflake, iconBg: 'bg-info-bg', iconText: 'text-info' },
  pagado: { label: 'Pagado', variant: 'success', icon: CircleDollarSign, iconBg: 'bg-success-bg', iconText: 'text-success' },
  despacho: { label: 'Por despacho', variant: 'info', icon: Package, iconBg: 'bg-info-bg', iconText: 'text-info' },
  pqrs: { label: 'PQRS', variant: 'purple', icon: MessageSquareWarning, iconBg: 'bg-purple-bg', iconText: 'text-purple' },
};

export const BUCKET_ORDER = ['caliente', 'tibio', 'frio', 'pagado', 'despacho', 'pqrs'];
