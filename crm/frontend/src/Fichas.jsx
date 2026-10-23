import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Plus, Search, ClipboardList } from 'lucide-react';
import { showError } from './components/Toast.jsx';
import { SheetRow } from './components/logistics/SheetCards.jsx';
import SheetDrawer from './components/logistics/SheetDrawer.jsx';
import SheetWizard from './components/logistics/SheetWizard.jsx';
import { fetchSheets, fetchLogisticsMe } from './api.js';
import { PrimaryBtn, EmptyState, Skeleton, SOFT, inputCls } from './lib/logisticsUi.jsx';

const GROUPS = [
  ['todas', 'Todas', () => true],
  ['borrador', 'Borradores', (s) => s.status === 'BORRADOR'],
  ['observada', 'Por corregir', (s) => s.status === 'OBSERVADA'],
  ['auditoria', 'En auditoría de pago', (s) => s.status === 'EN_AUDITORIA_PAGO'],
  ['proceso', 'En proceso', (s) => !['BORRADOR', 'OBSERVADA', 'EN_AUDITORIA_PAGO', 'CERRADO', 'CANCELADA'].includes(s.status)],
  ['cerradas', 'Cerradas', (s) => ['CERRADO', 'CANCELADA'].includes(s.status)],
];

// Fichas de pedido de la asesora: las crea, adjunta los comprobantes y las envía a auditoría de pago.
export default function Fichas() {
  const [sheets, setSheets] = useState(null);
  const [me, setMe] = useState(null);
  const [group, setGroup] = useState('todas');
  const [term, setTerm] = useState('');
  const [openId, setOpenId] = useState(null);
  const [wizard, setWizard] = useState(false);

  const load = useCallback(() => fetchSheets({ scope: 'mine', limit: 300 }).then((r) => setSheets(r.sheets)).catch((e) => showError(e.message)), []);
  useEffect(() => { load(); fetchLogisticsMe().then(setMe).catch(() => {}); }, [load]);

  const counts = useMemo(() => Object.fromEntries(GROUPS.map(([k, , fn]) => [k, (sheets ?? []).filter(fn).length])), [sheets]);
  const rows = useMemo(() => {
    const fn = GROUPS.find(([k]) => k === group)[2];
    const t = term.trim().toLowerCase();
    return (sheets ?? []).filter(fn).filter((s) => !t || [s.sheet_number, s.full_name, s.phone].some((v) => String(v ?? '').toLowerCase().includes(t)));
  }, [sheets, group, term]);

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Fichas de pedido</h1>
          <p className="mt-1 text-sm text-greige-ink">Crea la ficha cuando el cliente paga, adjunta cada comprobante y envíala a auditoría de pago.</p>
        </div>
        <PrimaryBtn onClick={() => setWizard(true)}><Plus size={16} />Nueva ficha</PrimaryBtn>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-paper p-1">
          {GROUPS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={group === k} onClick={() => setGroup(k)} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${group === k ? 'bg-accent text-white shadow-sm' : 'text-greige-ink hover:text-ink'}`}>
              {label}<span className={`rounded-full px-1.5 text-[10px] font-bold ${group === k ? 'bg-white/25' : SOFT}`}>{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64"><Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-greige" /><input className={`${inputCls} pl-9`} placeholder="Ficha, cliente o teléfono" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
      </div>

      {sheets === null ? <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[68px]" />)}</div>
        : rows.length === 0 ? <EmptyState icon={ClipboardList} title={sheets.length ? 'Nada con estos filtros' : 'Aún no tienes fichas'} text={sheets.length ? 'Cambia el filtro o la búsqueda.' : 'Cuando un cliente pague, crea su ficha aquí para que logística la prepare.'} action={!sheets.length && <PrimaryBtn onClick={() => setWizard(true)}><Plus size={16} />Crear la primera ficha</PrimaryBtn>} />
          : <div className="space-y-2.5">{rows.map((s) => <SheetRow key={s.id} sheet={s} onOpen={setOpenId} showAdvisor={false} />)}</div>}

      <AnimatePresence>{wizard && <SheetWizard key="wizard" onClose={(id) => { setWizard(false); load(); if (id) setOpenId(id); }} />}</AnimatePresence>
      <AnimatePresence>{openId && <SheetDrawer key={openId} sheetId={openId} me={me} onClose={() => setOpenId(null)} onChanged={load} />}</AnimatePresence>
    </div>
  );
}
