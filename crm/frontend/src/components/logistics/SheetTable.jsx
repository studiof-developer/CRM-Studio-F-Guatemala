import { StatusBadge, ModeBadge, SlaChip, q, fmtDT } from '../../lib/logisticsUi.jsx';

export default function SheetTable({ sheets, onOpen, showAdvisor = false }) {
  if (!sheets.length) return <div className="rounded-2xl border border-dashed border-line bg-paper-soft p-10 text-center text-sm text-greige-ink">No hay fichas con estos filtros.</div>;
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-paper">
      <table className="w-full min-w-[720px] text-sm">
        <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-greige-ink">
          <th className="px-4 py-2.5">Ficha</th><th className="px-4 py-2.5">Cliente</th><th className="px-4 py-2.5">Pago</th><th className="px-4 py-2.5 text-right">Total</th><th className="px-4 py-2.5">Estado</th>
          {showAdvisor && <th className="px-4 py-2.5">Asesora</th>}<th className="px-4 py-2.5">Cambió</th>
        </tr></thead>
        <tbody>
          {sheets.map((s) => (
            <tr key={s.id} onClick={() => onOpen(s.id)} className="cursor-pointer border-b border-line-soft last:border-0 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
              <td className="px-4 py-3 font-semibold text-ink">{s.sheet_number}</td>
              <td className="px-4 py-3 text-ink">{s.full_name ?? '—'}<div className="text-xs text-greige-ink">{s.items_count} prenda(s) · {s.payments_count} pago(s)</div></td>
              <td className="px-4 py-3"><ModeBadge mode={s.payment_mode} /></td>
              <td className="px-4 py-3 text-right tabular-nums text-ink">{q(s.total)}</td>
              <td className="px-4 py-3"><div className="flex flex-col items-start gap-1"><StatusBadge status={s.status} label={s.statusLabel} /><SlaChip sla={s.sla} status={s.status} /></div></td>
              {showAdvisor && <td className="px-4 py-3 text-greige-ink">{s.advisor_name}</td>}
              <td className="px-4 py-3 text-xs text-greige-ink">{fmtDT(s.status_changed_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
