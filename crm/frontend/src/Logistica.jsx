import { useEffect, useState } from 'react';
import { AlertTriangle, Clock } from 'lucide-react';
import { PageHeader } from './components/ui.jsx';
import { showError, showSuccess } from './components/Toast.jsx';
import SheetTable from './components/logistics/SheetTable.jsx';
import SheetDetail from './components/logistics/SheetDetail.jsx';
import { fetchLogisticsMe, fetchLogisticsBoard, fetchSheets, fetchLogisticsConfig, saveLogisticsConfig } from './api.js';
import { PrimaryBtn, FieldRow, inputCls } from './lib/logisticsUi.jsx';

const TABS = [['board', 'Tablero'], ['list', 'Fichas'], ['process', 'Proceso'], ['config', 'Configuración', true]];

function Board({ onPick }) {
  const [board, setBoard] = useState(null);
  useEffect(() => { fetchLogisticsBoard().then(setBoard).catch((e) => showError(e.message)); }, []);
  if (!board) return <p className="py-10 text-center text-sm text-greige-ink">Cargando…</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-3 py-1.5 font-semibold text-danger"><AlertTriangle size={14} />{board.overdue} con plazo vencido</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-3 py-1.5 font-semibold text-warning"><Clock size={14} />{board.dueSoon} vencen en 24 h</span>
        <span className="rounded-full bg-secondary px-3 py-1.5 text-greige-ink">Plazo: {board.config.totalBusinessDays} días hábiles desde que se aprueba el pago</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {board.columns.map((col) => (
          <div key={col.key} className="rounded-2xl border border-line bg-paper p-4">
            <h3 className="mb-2 text-sm font-semibold text-ink">{col.label}</h3>
            <ul className="space-y-1">
              {col.statuses.map((s) => (
                <li key={s.status}>
                  <button type="button" onClick={() => onPick(s.status)} className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                    <span className="text-greige-ink">{s.label}</span>
                    <span className="flex items-center gap-1.5">{s.overdue > 0 && <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-bold text-danger">{s.overdue} vencidas</span>}<b className={`tabular-nums ${s.count ? 'text-ink' : 'text-greige'}`}>{s.count}</b></span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function List({ me, initialStatus, onOpen, refreshKey }) {
  const [filters, setFilters] = useState({ status: initialStatus ?? '', mode: '', q: '', overdue: false, scope: 'all' });
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const t = setTimeout(() => fetchSheets({ ...filters, overdue: filters.overdue ? '1' : '' }).then((r) => setRows(r.sheets)).catch((e) => showError(e.message)), 250);
    return () => clearTimeout(t);
  }, [filters, refreshKey]);
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <input className={`${inputCls} !w-56`} placeholder="Ficha, cliente o teléfono" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        <select className={`${inputCls} !w-64`} value={filters.status} onChange={(e) => set('status', e.target.value)}><option value="">Todos los estados</option>{Object.entries(me.statusLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className={`${inputCls} !w-40`} value={filters.mode} onChange={(e) => set('mode', e.target.value)}><option value="">Todo tipo de pago</option><option value="contado">Contado</option><option value="contraentrega">Contraentrega</option></select>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={filters.overdue} onChange={(e) => set('overdue', e.target.checked)} />Solo vencidas</label>
      </div>
      <SheetTable sheets={rows} onOpen={onOpen} showAdvisor />
    </div>
  );
}

// El proceso tal como está cargado en el sistema (cada paso con su código de la ficha técnica).
function Process({ me }) {
  const steps = Object.entries(me.steps).sort((a, b) => a[1].code.localeCompare(b[1].code));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-line bg-paper p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Pasos del flujo ({steps.length})</h3>
        <ol className="space-y-1.5 text-sm">{steps.map(([k, s]) => <li key={k} className="flex gap-2"><code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-greige-ink">{s.code}</code><span className="text-ink">{s.label}</span></li>)}</ol>
      </div>
      <div className="rounded-2xl border border-line bg-paper p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Roles de logística</h3>
        <ul className="space-y-1.5 text-sm">{Object.entries(me.roleLabels).map(([k, l]) => <li key={k} className={me.roles.includes(k) ? 'font-semibold text-accent' : 'text-ink'}>{l}{me.roles.includes(k) ? ' · tú' : ''}</li>)}</ul>
        <p className="mt-3 text-xs text-greige-ink">Quien hace un paso no puede hacer el que lo controla (separación de funciones). Cada paso exige sus variables y su evidencia, y queda sellado en el historial de la ficha.</p>
      </div>
    </div>
  );
}

function Config({ me }) {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchLogisticsConfig().then((c) => setCfg({ ...c, holidays: c.holidays.join('\n'), warehouses: c.warehouses.join('\n') })).catch((e) => showError(e.message)); }, []);
  if (!cfg) return <p className="py-10 text-center text-sm text-greige-ink">Cargando…</p>;
  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  async function save() {
    setBusy(true);
    try { await saveLogisticsConfig({ ...cfg, holidays: lines(cfg.holidays), warehouses: lines(cfg.warehouses) }); showSuccess('Configuración guardada'); } catch (e) { showError(e.message); } finally { setBusy(false); }
  }
  const num = (k, label, step = '1') => <FieldRow label={label}><input className={inputCls} type="number" min="0" step={step} value={cfg[k]} onChange={(e) => set(k, e.target.value)} /></FieldRow>;
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="rounded-lg bg-warning/15 px-4 py-3 text-sm text-warning">Estos parámetros son los puntos que todavía se están validando. Cambiarlos aplica a los pasos siguientes; lo ya sellado no se modifica.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {num('totalBusinessDays', 'Plazo total (días hábiles desde que se aprueba el pago)')}
        {num('amountToleranceQ', 'Diferencia de monto tolerada (Q)', '0.01')}
        {num('codAdvancePct', 'Anticipo de contraentrega (% del total)')}
        {num('codMaxAttempts', 'Intentos máximos de entrega (contraentrega)')}
        <FieldRow label="Bodega de despacho"><input className={inputCls} value={cfg.dispatchWarehouse} onChange={(e) => set('dispatchWarehouse', e.target.value)} /></FieldRow>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldRow label="Feriados (uno por línea, AAAA-MM-DD)"><textarea rows={4} className={inputCls} value={cfg.holidays} onChange={(e) => set('holidays', e.target.value)} /></FieldRow>
        <FieldRow label="Tiendas / bodegas de origen (una por línea)"><textarea rows={4} className={inputCls} value={cfg.warehouses} onChange={(e) => set('warehouses', e.target.value)} /></FieldRow>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink"><input type="checkbox" className="mt-0.5" checked={cfg.enforceSod} onChange={(e) => set('enforceSod', e.target.checked)} />Exigir separación de funciones (quien hace un paso no puede hacer el que lo controla)</label>
      <label className="flex items-start gap-2 text-sm text-ink"><input type="checkbox" className="mt-0.5" checked={cfg.adminAllRoles} onChange={(e) => set('adminAllRoles', e.target.checked)} />El administrador puede ejercer cualquier rol de logística</label>
      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink">Tiempo máximo en cada estado (horas, vacío = sin alerta)</h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {Object.entries(me.statusLabels).filter(([k]) => !['CERRADO', 'CANCELADA', 'BORRADOR'].includes(k)).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-xs text-greige-ink"><input className={`${inputCls} !w-16 !px-2 !py-1`} type="number" min="0" value={cfg.sla?.[k] ?? ''} onChange={(e) => set('sla', { ...cfg.sla, [k]: e.target.value })} /><span className="truncate" title={l}>{l}</span></label>
          ))}
        </div>
      </div>
      <div><PrimaryBtn onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Guardar configuración'}</PrimaryBtn></div>
    </div>
  );
}

export default function Logistica({ user }) {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState('board');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { fetchLogisticsMe().then(setMe).catch((e) => showError(e.message)); }, []);
  if (!me) return <p className="py-20 text-center text-sm text-greige-ink">Cargando…</p>;

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-8">
      <PageHeader title="Logística" subtitle="Desde que el pago está aprobado hasta que el cliente confirma que recibió su pedido." />
      <div className="mb-5 flex flex-wrap gap-1 border-b border-line">
        {TABS.filter(([, , adminOnly]) => !adminOnly || user.role === 'admin').map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${tab === key ? 'border-accent text-accent' : 'border-transparent text-greige-ink hover:text-ink'}`}>{label}</button>
        ))}
      </div>
      {tab === 'board' && <Board onPick={(s) => { setStatus(s); setTab('list'); }} />}
      {tab === 'list' && <List key={status} me={me} initialStatus={status} onOpen={setOpenId} refreshKey={tick} />}
      {tab === 'process' && <Process me={me} />}
      {tab === 'config' && <Config me={me} />}
      {openId && <SheetDetail sheetId={openId} me={me} onClose={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  );
}
