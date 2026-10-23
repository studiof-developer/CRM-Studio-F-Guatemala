import { motion } from 'framer-motion';
import { Zap, Package, Store, Truck, StickyNote } from 'lucide-react';
import Avatar from '../Avatar.jsx';
import { StatusBadge, ModeBadge, SlaChip, SOFT, q, fmtDT } from '../../lib/logisticsUi.jsx';

const NowPill = () => <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white"><Zap size={10} />Te toca</span>;

function PaidBar({ sheet }) {
  const total = Number(sheet.total) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((Number(sheet.approved_total) / total) * 100)) : 0;
  if (['BORRADOR'].includes(sheet.status)) return null;
  return (
    <div title={`Pago aprobado ${q(sheet.approved_total)} de ${q(total)}`} className="mt-2.5">
      <div className={`h-1.5 overflow-hidden rounded-full ${SOFT}`}><div className={`h-full rounded-full ${pct >= 100 ? 'bg-success' : 'bg-accent'}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// Tarjeta del tablero.
export function SheetCard({ sheet, onOpen, showStatus = true }) {
  return (
    <motion.button layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} type="button" onClick={() => onOpen(sheet.id)}
      className={`block w-full rounded-xl border bg-paper p-3.5 text-left shadow-sm transition-shadow hover:shadow-md ${sheet.actionable ? 'border-accent/50 ring-1 ring-accent/20' : 'border-line'}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex items-center gap-2 whitespace-nowrap"><span className="text-[11px] font-semibold tabular-nums text-greige">{sheet.sheet_number}</span><ModeBadge mode={sheet.payment_mode} /></span>
        {sheet.actionable && <NowPill />}
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-ink">{sheet.full_name ?? 'Sin nombre'}</p>
      <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-greige-ink"><Package size={12} className="shrink-0" /><span className="truncate">{sheet.items_summary ?? 'Sin prendas'}</span></p>
      <div className="mt-2.5 flex items-end justify-between gap-2">
        <span className="text-base font-bold tabular-nums text-ink">{q(sheet.total)}</span>
        <span className="flex items-center gap-1.5"><span title={`Asesora: ${sheet.advisor_name}`}><Avatar name={sheet.advisor_name} size={22} /></span></span>
      </div>
      <PaidBar sheet={sheet} />
      {sheet.notes && <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-yellow-300/25 px-2 py-1 text-[11px] text-ink"><StickyNote size={11} className="mt-0.5 shrink-0" /><span className="line-clamp-2">{sheet.notes}</span></p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {sheet.delivery_type === 'tienda' && <span className="inline-flex items-center gap-1 rounded-full bg-purple/10 px-2 py-0.5 text-[10px] font-semibold text-purple"><Store size={10} />Recoge: {sheet.pickup_store}</span>}
        {sheet.delivery_type !== 'tienda' && sheet.shipping_payment === 'al_recibir' && <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning"><Truck size={10} />Flete al recibir</span>}
        {showStatus && <StatusBadge status={sheet.status} label={sheet.statusLabel} />}
        <SlaChip sla={sheet.sla} status={sheet.status} compact />
      </div>
    </motion.button>
  );
}

// Fila de la lista.
export function SheetRow({ sheet, onOpen, showAdvisor = true }) {
  return (
    <motion.button layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} type="button" onClick={() => onOpen(sheet.id)}
      className={`grid w-full grid-cols-2 items-center gap-x-4 gap-y-2 rounded-xl border bg-paper px-4 py-3 text-left shadow-sm transition hover:shadow-md md:grid-cols-[1.1fr_1.6fr_auto_1.5fr_auto] ${sheet.actionable ? 'border-accent/50 ring-1 ring-accent/20' : 'border-line'}`}>
      <span className="min-w-0">
        <span className="flex items-center gap-2"><span className="text-sm font-semibold tabular-nums text-ink">{sheet.sheet_number}</span><ModeBadge mode={sheet.payment_mode} /></span>
        <span className="text-[11px] text-greige">{fmtDT(sheet.status_changed_at)}</span>
      </span>
      <span className="min-w-0 md:order-none">
        <span className="block truncate text-sm font-medium text-ink">{sheet.full_name ?? 'Sin nombre'}</span>
        <span className="block truncate text-xs text-greige-ink">{sheet.items_summary ?? 'Sin prendas'} · {sheet.payments_count} pago(s)</span>
      </span>
      <span className="text-right text-sm font-bold tabular-nums text-ink md:text-left">{q(sheet.total)}</span>
      <span className="flex flex-wrap items-center gap-1.5"><StatusBadge status={sheet.status} label={sheet.statusLabel} /><SlaChip sla={sheet.sla} status={sheet.status} compact /></span>
      <span className="flex items-center justify-end gap-2">
        {sheet.actionable && <NowPill />}
        {showAdvisor && <span title={`Asesora: ${sheet.advisor_name}`}><Avatar name={sheet.advisor_name} size={26} /></span>}
      </span>
    </motion.button>
  );
}
