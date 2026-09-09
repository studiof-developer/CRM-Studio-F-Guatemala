import { Clock, Snowflake, Thermometer, Flame, CircleDollarSign, MessageSquareWarning, CheckCircle2, Star, Zap, AlertTriangle, Tag, Package } from 'lucide-react';

// The 7 fixed pipeline stages — temperature/ticket_status (tickets.js's BUCKET_CASE_SQL)
// decide which one a contact is actually in, so this order/list is NOT itself editable.
// Configuración > Pipeline can only change label/icon/color/display-order per key.
export const COLUMN_ORDER = ['pendiente', 'en_atencion', 'cotizacion', 'medio_pago', 'pagado', 'pqrs', 'resuelto'];

// Shown until the admin-saved 'pipeline_columns' setting loads (or if it's never set).
export const DEFAULT_COLUMN_META = {
  pendiente: { label: 'No atendidos', icon: 'Clock', color: 'warning' },
  en_atencion: { label: 'En conversación', icon: 'Snowflake', color: 'info' },
  cotizacion: { label: 'Cotización', icon: 'Thermometer', color: 'warning' },
  medio_pago: { label: 'Medio de pago', icon: 'Flame', color: 'danger' },
  pagado: { label: 'Pagado', icon: 'CircleDollarSign', color: 'success' },
  pqrs: { label: 'PQRS', icon: 'MessageSquareWarning', color: 'purple' },
  resuelto: { label: 'Resuelto', icon: 'CheckCircle2', color: 'success' },
};

// Must match settings.js's PIPELINE_ICONS/PIPELINE_COLORS whitelist exactly — a name
// saved here that the backend won't accept just fails to save, and a name the backend
// accepts that isn't mapped here silently falls back instead of throwing, so keep both
// lists identical when adding an option to either side.
export const PIPELINE_ICON_MAP = { Clock, Snowflake, Thermometer, Flame, CircleDollarSign, MessageSquareWarning, CheckCircle2, Star, Zap, AlertTriangle, Tag, Package };
export const PIPELINE_ICON_NAMES = Object.keys(PIPELINE_ICON_MAP);

export const PIPELINE_COLOR_CLASSES = {
  warning: { iconBg: 'bg-warning-bg', iconText: 'text-warning', dot: 'bg-warning' },
  info: { iconBg: 'bg-info-bg', iconText: 'text-info', dot: 'bg-info' },
  danger: { iconBg: 'bg-danger-bg', iconText: 'text-danger', dot: 'bg-danger' },
  success: { iconBg: 'bg-success-bg', iconText: 'text-success', dot: 'bg-success' },
  purple: { iconBg: 'bg-purple-bg', iconText: 'text-purple', dot: 'bg-purple' },
};
export const PIPELINE_COLOR_NAMES = Object.keys(PIPELINE_COLOR_CLASSES);
