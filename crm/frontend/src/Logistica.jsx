import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Plus, Search, Zap, AlertTriangle, Clock, PackageCheck, Timer, Boxes, LayoutGrid, List as ListIcon, Route, SlidersHorizontal, Inbox, ShieldCheck, Hash, ClipboardCheck, Warehouse, Truck, PartyPopper, PauseCircle, Lock, Package } from 'lucide-react';
import { showError, showSuccess } from './components/Toast.jsx';
import { SheetCard, SheetRow } from './components/logistics/SheetCards.jsx';
import SheetDrawer from './components/logistics/SheetDrawer.jsx';
import SheetWizard from './components/logistics/SheetWizard.jsx';
import { fetchLogisticsMe, fetchLogisticsBoard, fetchSheets, fetchLogisticsConfig, saveLogisticsConfig } from './api.js';
import { PrimaryBtn, FieldRow, Kpi, Panel, EmptyState, Skeleton, STAGES, SOFT, inputCls, q } from './lib/logisticsUi.jsx';

const VIEWS = [['board', 'Tablero', LayoutGrid], ['list', 'Lista', ListIcon], ['process', 'Proceso', Route], ['config', 'Configuración', SlidersHorizontal, true]];
const COLUMN_STYLE = {
  entrada: { icon: ShieldCheck, tone: 'text-warning bg-warning/15' },
  traslado: { icon: Warehouse, tone: 'text-purple bg-purple/10' },
  preparacion: { icon: Package, tone: 'text-accent bg-accent-soft' },
  despacho: { icon: Truck, tone: 'text-accent bg-accent-soft' },
  cierre: { icon: PartyPopper, tone: 'text-success bg-success/10' },
  excepciones: { icon: PauseCircle, tone: 'text-greige-ink bg-black/[0.05] dark:bg-white/[0.08]' },
};
const CLOSED_LIMIT = 8;
const FIELD_LABELS = { full_name: 'Nombre y apellidos', phone: 'Teléfono', email: 'Correo', dpi: 'DPI', address: 'Dirección', department: 'Departamento', city: 'Ciudad', zone: 'Zona', address_ref: 'Vereda o referencia', campaign: 'Campaña' };

function Toolbar({ filters, set, withStatus, me }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1 sm:max-w-xs"><Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-greige" /><input className={`${inputCls} pl-9`} placeholder="Ficha, cliente o teléfono" value={filters.q} onChange={(e) => set('q', e.target.value)} /></div>
      {withStatus && <select className={`${inputCls} !w-auto`} value={filters.status} onChange={(e) => set('status', e.target.value)}><option value="">Todos los estados</option>{Object.entries(me.statusLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
      <select className={`${inputCls} !w-auto`} value={filters.mode} onChange={(e) => set('mode', e.target.value)}><option value="">Contado y contraentrega</option><option value="contado">Solo contado</option><option value="contraentrega">Solo contraentrega</option></select>
      <button type="button" aria-pressed={filters.mine} onClick={() => set('mine', !filters.mine)} className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition ${filters.mine ? 'border-accent bg-accent text-white' : 'border-line bg-paper text-greige-ink hover:text-ink'}`}><Zap size={14} />Lo que me toca</button>
      <button type="button" aria-pressed={filters.overdue} onClick={() => set('overdue', !filters.overdue)} className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition ${filters.overdue ? 'border-danger bg-danger text-white' : 'border-line bg-paper text-greige-ink hover:text-ink'}`}><AlertTriangle size={14} />Vencidas</button>
    </div>
  );
}

function Board({ sheets, columns, filters, onOpen, goList }) {
  const grouped = useMemo(() => columns.map((col) => {
    const statuses = col.statuses.map((s) => s.status);
    let cards = sheets.filter((s) => statuses.includes(s.status));
    // las más urgentes primero: vencidas, luego las que me tocan, luego por fecha límite
    cards = [...cards].sort((a, b) => (b.sla.overdue - a.sla.overdue) || (b.actionable - a.actionable) || (new Date(a.deadline_at ?? '2100-01-01') - new Date(b.deadline_at ?? '2100-01-01')));
    return { ...col, cards, overdue: cards.filter((c) => c.sla.overdue).length };
  }), [sheets, columns]);
  const visible = grouped.filter((c) => c.key !== 'excepciones' || c.cards.length);
  return (
    <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-4 md:-mx-8 md:px-8">
      {visible.map((col) => {
        const st = COLUMN_STYLE[col.key];
        const Icon = st.icon;
        const shown = col.key === 'cierre' ? col.cards.slice(0, CLOSED_LIMIT) : col.cards;
        return (
          <section key={col.key} className="flex max-h-[calc(100dvh-340px)] min-h-[260px] w-[300px] shrink-0 flex-col rounded-2xl border border-line bg-black/[0.02] dark:bg-white/[0.02]">
            <header className="flex items-center justify-between gap-2 px-3.5 py-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><span className={`flex h-7 w-7 items-center justify-center rounded-lg ${st.tone}`}><Icon size={14} /></span>{col.label}</h3>
              <span className="flex items-center gap-1.5">{col.overdue > 0 && <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-bold text-danger">{col.overdue} vencidas</span>}<span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums text-greige-ink ${SOFT}`}>{col.cards.length}</span></span>
            </header>
            <div className="flex-1 space-y-2.5 overflow-y-auto px-3 pb-3">
              {shown.map((s) => <SheetCard key={s.id} sheet={s} onOpen={onOpen} />)}
              {!shown.length && <p className="px-2 py-10 text-center text-xs text-greige">{filters.mine || filters.overdue || filters.q ? 'Nada con estos filtros' : 'Nada aquí por ahora'}</p>}
              {col.key === 'cierre' && col.cards.length > CLOSED_LIMIT && <button type="button" onClick={() => goList('CERRADO')} className="w-full rounded-lg py-2 text-xs font-semibold text-accent hover:underline">Ver las {col.cards.length} cerradas en la lista</button>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ListView({ sheets, onOpen }) {
  if (!sheets.length) return <EmptyState icon={Inbox} title="Nada con estos filtros" text="Cambia el estado, el tipo de pago o la búsqueda." />;
  return <div className="space-y-2.5">{sheets.map((s) => <SheetRow key={s.id} sheet={s} onOpen={onOpen} />)}</div>;
}

// El proceso tal como está cargado en el sistema: cada paso con su código, quién lo hace y qué exige.
function Process({ me }) {
  const stageOf = (step) => {
    const from = Array.isArray(step.from) ? step.from[0] : null;
    return from ? STAGES.findIndex((s) => s.statuses.includes(from)) : -1;
  };
  const steps = Object.entries(me.steps).map(([key, s]) => ({ key, ...s, stage: stageOf(s) })).sort((a, b) => a.code.localeCompare(b.code));
  return (
    <div className="space-y-4">
      <p className="text-sm text-greige-ink">Quien hace un paso no puede hacer el que lo controla (separación de funciones). Cada paso exige sus variables y su evidencia, y queda sellado en el historial de la ficha.</p>
      {[...STAGES.map((s, i) => ({ ...s, idx: i })), { key: 'exc', label: 'Excepciones', icon: PauseCircle, idx: -1 }].map((stage) => {
        const list = steps.filter((s) => s.stage === stage.idx);
        if (!list.length) return null;
        return (
          <Panel key={stage.key} title={stage.label} icon={stage.icon} right={<span className="text-xs text-greige">{list.length} paso(s)</span>} pad={false}>
            <ul className="divide-y divide-line-soft">
              {list.map((s) => (
                <li key={s.key} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 px-5 py-3">
                  <code className={`mt-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-greige-ink ${SOFT}`}>{s.code}</code>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{s.label}{s.mode && <span className="ml-2 rounded bg-purple/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-purple">{s.mode}</span>}</p>
                    <p className="mt-0.5 text-xs text-greige-ink">{s.fields.length ? `Registra: ${s.fields.map((f) => f.label).join(' · ')}` : 'Sin variables'}{s.evidence ? ` · Evidencia: ${s.evidence}` : ''}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">{s.roles.map((r) => <span key={r} className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent">{r === 'asesora' ? 'Asesora de la ficha' : me.roleLabels[r]}</span>)}</div>
                </li>
              ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}

function Config({ me }) {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [nextNum, setNextNum] = useState('');
  useEffect(() => { fetchLogisticsConfig().then((c) => setCfg({ ...c, holidays: c.holidays.join('\n'), warehouses: c.warehouses.join('\n') })).catch((e) => showError(e.message)); }, []);
  if (!cfg) return <div className="space-y-3"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  async function save() {
    setBusy(true);
    try {
      const saved = await saveLogisticsConfig({ ...cfg, holidays: lines(cfg.holidays), warehouses: lines(cfg.warehouses), numbering: { ...cfg.numbering, next: nextNum } });
      setCfg({ ...saved, holidays: saved.holidays.join('\n'), warehouses: saved.warehouses.join('\n') }); setNextNum('');
      showSuccess('Configuración guardada');
    } catch (e) { showError(e.message); } finally { setBusy(false); }
  }
  const toggleKey = (list, key) => set(list, cfg[list].includes(key) ? cfg[list].filter((x) => x !== key) : [...cfg[list], key]);
  const num = (k, label, hint, step = '1') => <FieldRow label={label} hint={hint}><input className={inputCls} type="number" min="0" step={step} value={cfg[k]} onChange={(e) => set(k, e.target.value)} /></FieldRow>;
  const toggle = (k, title, text) => (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3.5 transition hover:border-greige">
      <input type="checkbox" className="mt-1 h-4 w-4 rounded border-line text-accent focus:ring-accent" checked={cfg[k]} onChange={(e) => set(k, e.target.checked)} />
      <span><span className="block text-sm font-semibold text-ink">{title}</span><span className="block text-xs text-greige-ink">{text}</span></span>
    </label>
  );
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"><AlertTriangle size={18} className="mt-0.5 shrink-0" /><span>Estos parámetros son los puntos que todavía se están validando. Cambiarlos aplica a los pasos siguientes; lo ya sellado no se modifica.</span></div>
      <Panel title="Plazos" icon={Timer}>
        <div className="grid gap-4 sm:grid-cols-2">
          {num('totalBusinessDays', 'Plazo total (días hábiles)', 'Cuenta desde que se aprueba el pago.')}
          <FieldRow label="Feriados" hint="Uno por línea, AAAA-MM-DD. No cuentan como día hábil."><textarea rows={3} className={inputCls} value={cfg.holidays} onChange={(e) => set('holidays', e.target.value)} /></FieldRow>
        </div>
      </Panel>
      <Panel title="Pagos y contraentrega" icon={ShieldCheck}>
        <div className="grid gap-4 sm:grid-cols-3">
          {num('codAdvancePct', 'Anticipo de contraentrega (%)', 'Sobre el total del pedido.')}
          {num('codMaxAttempts', 'Intentos de entrega', 'Máximo en contraentrega.')}
          {num('amountToleranceQ', 'Diferencia tolerada (Q)', 'Entre lo pagado y lo debido.', '0.01')}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {toggle('includeFreightInRequired', 'Si el flete ya está pagado, los pagos lo cubren', 'El pago exigido es el pedido más el flete cuando la asesora marca “ya pagó el flete”.')}
          {toggle('allowCodGoods', 'Permitir contraentrega del pedido completo', 'Apagado: en las fichas actuales solo el flete se cobra al recibir. Enciéndelo solo si se vuelve a vender así.')}
        </div>
      </Panel>
      <Panel title="Numeración de las fichas" icon={Hash}>
        <div className="grid gap-4 sm:grid-cols-3">
          <FieldRow label="Cómo numerar">
            <select className={inputCls} value={cfg.numbering.mode} onChange={(e) => set('numbering', { ...cfg.numbering, mode: e.target.value })}>
              <option value="auto">Automática (FIC-2026-00001)</option><option value="custom">Definir yo el número</option>
            </select>
          </FieldRow>
          {cfg.numbering.mode === 'custom' && <>
            <FieldRow label="Prefijo (opcional)" hint="Ej. vacío para 2287, o “STF-” para STF-2287."><input className={inputCls} value={cfg.numbering.prefix} onChange={(e) => set('numbering', { ...cfg.numbering, prefix: e.target.value })} /></FieldRow>
            <FieldRow label="Próxima ficha empieza en" hint="Si quieres seguir el talonario de papel, pon el siguiente número. Déjalo vacío para no cambiarlo."><input className={inputCls} type="number" min="1" value={nextNum} onChange={(e) => setNextNum(e.target.value)} placeholder="2287" /></FieldRow>
          </>}
        </div>
        <p className="mt-3 text-xs text-greige-ink">La próxima ficha que se cree será la <b className="text-ink">{cfg.nextNumber}</b>. No se repiten números ya usados.</p>
      </Panel>
      <Panel title="Datos obligatorios de la ficha" icon={ClipboardCheck}>
        <p className="mb-3 text-xs text-greige-ink">Sin esto la ficha no sale a auditoría. Empezamos con lo que las asesoras llenan casi siempre en la ficha de papel; puedes endurecerlo cuando quieras.</p>
        <div className="grid gap-6 sm:grid-cols-2">
          {[['requiredFields', 'Siempre'], ['requiredForDelivery', 'Si va a domicilio o agencia']].map(([list, title]) => (
            <div key={list}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-greige-ink">{title}</h4>
              <div className="grid gap-1.5">
                {Object.entries(FIELD_LABELS).map(([k, label]) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2.5 text-sm text-ink"><input type="checkbox" className="h-4 w-4 rounded border-line text-accent focus:ring-accent" checked={cfg[list].includes(k)} onChange={() => toggleKey(list, k)} />{label}</label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-greige">Siempre se exigen, además: al menos una prenda con su tienda de origen, y un pago con comprobante y referencia.</p>
      </Panel>
      <Panel title="Bodegas" icon={Warehouse}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldRow label="Bodega de despacho"><input className={inputCls} value={cfg.dispatchWarehouse} onChange={(e) => set('dispatchWarehouse', e.target.value)} /></FieldRow>
          <FieldRow label="Tiendas / bodegas de origen" hint="Una por línea. Alimenta las sugerencias de la ficha."><textarea rows={3} className={inputCls} value={cfg.warehouses} onChange={(e) => set('warehouses', e.target.value)} /></FieldRow>
        </div>
      </Panel>
      <Panel title="Control" icon={Lock}>
        <div className="grid gap-3 sm:grid-cols-2">
          {toggle('enforceSod', 'Separación de funciones', 'Quien hace un paso no puede hacer el que lo controla.')}
          {toggle('adminAllRoles', 'El administrador ejerce cualquier rol', 'Sigue sujeto a la separación de funciones.')}
        </div>
      </Panel>
      <Panel title="Tiempo máximo por estado" icon={Clock} right={<span className="text-xs text-greige">En horas · vacío = sin alerta</span>}>
        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(me.statusLabels).filter(([k]) => !['CERRADO', 'CANCELADA', 'BORRADOR'].includes(k)).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2.5 text-xs text-greige-ink"><input className={`${inputCls} !w-[72px] !px-2.5 !py-1.5`} type="number" min="0" value={cfg.sla?.[k] ?? ''} onChange={(e) => set('sla', { ...cfg.sla, [k]: e.target.value })} /><span className="truncate" title={l}>{l}</span></label>
          ))}
        </div>
      </Panel>
      <div className="flex justify-end"><PrimaryBtn onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Guardar configuración'}</PrimaryBtn></div>
    </div>
  );
}

export default function Logistica({ user }) {
  const [me, setMe] = useState(null);
  const [board, setBoard] = useState(null);
  const [sheets, setSheets] = useState(null);
  const [view, setView] = useState('board');
  const [filters, setFilters] = useState({ q: '', status: '', mode: '', mine: false, overdue: false });
  const [openId, setOpenId] = useState(null);
  const [wizard, setWizard] = useState(false);

  const load = useCallback(() => Promise.all([fetchLogisticsBoard(), fetchSheets({ scope: 'all', limit: 300 })]).then(([b, s]) => { setBoard(b); setSheets(s.sheets); }).catch((e) => showError(e.message)), []);
  useEffect(() => { fetchLogisticsMe().then(setMe).catch((e) => showError(e.message)); load(); }, [load]);
  // se refresca solo cada 30 s mientras la pestaña está a la vista
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && !openId && !wizard) load(); }, 30000);
    return () => clearInterval(t);
  }, [load, openId, wizard]);

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = useMemo(() => {
    const t = filters.q.trim().toLowerCase();
    return (sheets ?? []).filter((s) => (!t || [s.sheet_number, s.full_name, s.phone].some((v) => String(v ?? '').toLowerCase().includes(t)))
      && (!filters.mode || s.payment_mode === filters.mode) && (!filters.status || s.status === filters.status)
      && (!filters.mine || s.actionable) && (!filters.overdue || s.sla.overdue || s.sla.statusOverdue));
  }, [sheets, filters]);
  const boardSheets = useMemo(() => filtered.filter((s) => s.status !== 'BORRADOR'), [filtered]);

  if (!me) return <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-8"><Skeleton className="h-10 w-64" /><div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-[76px]" />)}</div></div>;
  const k = board?.kpis;

  return (
    <div className="mx-auto max-w-[1500px] p-4 md:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Logística</h1>
          <p className="mt-1 text-sm text-greige-ink">Desde que el pago está aprobado hasta que el cliente confirma que recibió su pedido.</p>
        </div>
        <PrimaryBtn onClick={() => setWizard(true)}><Plus size={16} />Nueva ficha</PrimaryBtn>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {!k ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-[76px]" />) : <>
          <Kpi icon={Boxes} label="Pedidos en proceso" value={k.active} hint={q(k.activeValue)} />
          <Kpi icon={Zap} label="Te tocan" value={k.queue} hint="Con un paso tuyo pendiente" onClick={() => { setView('board'); set('mine', !filters.mine); }} active={filters.mine} />
          <Kpi icon={AlertTriangle} tone="danger" label="Con plazo vencido" value={board.overdue} onClick={() => { setView('board'); set('overdue', !filters.overdue); }} active={filters.overdue} />
          <Kpi icon={Clock} tone="warn" label="Vencen en 24 h" value={board.dueSoon} />
          <Kpi icon={PackageCheck} tone="success" label="Entregados (7 días)" value={k.delivered7d} hint={k.onTimePct != null ? `${k.onTimePct}% a tiempo` : 'Sin datos aún'} />
          <Kpi icon={Timer} tone="purple" label="Ciclo promedio" value={k.avgCycleDays != null ? `${k.avgCycleDays} d` : '—'} hint={`Meta: ${board.config.totalBusinessDays} días hábiles`} />
        </>}
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" className="flex gap-1 rounded-xl border border-line bg-paper p-1">
          {VIEWS.filter(([, , , adminOnly]) => !adminOnly || user.role === 'admin').map(([key, label, Icon]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${view === key ? 'bg-accent text-white shadow-sm' : 'text-greige-ink hover:text-ink'}`}><Icon size={15} />{label}</button>
          ))}
        </div>
        {(view === 'board' || view === 'list') && <Toolbar filters={filters} set={set} withStatus={view === 'list'} me={me} />}
      </div>

      {view === 'board' && (sheets === null ? <div className="flex gap-4 overflow-hidden">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-80 w-[300px] shrink-0" />)}</div>
        : <Board sheets={boardSheets} columns={board.columns} filters={filters} onOpen={setOpenId} goList={(status) => { set('status', status); setView('list'); }} />)}
      {view === 'list' && (sheets === null ? <Skeleton className="h-64" /> : <ListView sheets={filtered} onOpen={setOpenId} />)}
      {view === 'process' && <Process me={me} />}
      {view === 'config' && <Config me={me} />}

      <AnimatePresence>{wizard && <SheetWizard key="wizard" onClose={(id) => { setWizard(false); load(); if (id) setOpenId(id); }} />}</AnimatePresence>
      <AnimatePresence>{openId && <SheetDrawer key={openId} sheetId={openId} me={me} onClose={() => setOpenId(null)} onChanged={load} />}</AnimatePresence>
    </div>
  );
}
