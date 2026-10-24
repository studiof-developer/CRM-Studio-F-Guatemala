import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X, Check, Pencil, Plus, Trash2, Zap, Lock, Wallet, ShieldCheck, Send, MessageSquare, MapPin, Phone, Mail, User, Hash, FileText, CircleDot, CheckCircle2, AlertTriangle, PauseCircle, Ban, Clock, StickyNote, Store, Truck,
} from 'lucide-react';
import Avatar from '../Avatar.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import { showSuccess, showError } from '../Toast.jsx';
import { fetchSheet, removeSheetPayment, addSheetNote, deleteTestSheet } from '../../api.js';
import { StepDialog, PaymentDialog, AuditDialog } from './StepDialogs.jsx';
import SheetWizard from './SheetWizard.jsx';
import {
  Drawer, Panel, StatusBadge, ModeBadge, SlaChip, TestBadge, ProofThumb, AuditPill, PrimaryBtn, GhostBtn, DangerBtn, Skeleton, CopyText, STAGES, stageIndex, SOFT, inputCls, q, fmtDT, fmtDay, METHOD_LABELS,
} from '../../lib/logisticsUi.jsx';

const EVENT_LABELS = { create: 'Ficha creada', edit: 'Ficha editada', add_payment: 'Pago agregado', remove_payment: 'Pago retirado', audit_payment: 'Pago auditado', auto_status: 'Cambio automático', note: 'Nota', submit: 'Enviada a auditoría de pago' };
const EVENT_ICONS = { create: Plus, edit: Pencil, add_payment: Wallet, remove_payment: Trash2, audit_payment: ShieldCheck, auto_status: Zap, note: MessageSquare, submit: Send };
const SKIP = new Set(['codigo']);
const KEY_LABELS = { payment_id: 'pago', declared_amount: 'declarado', approved_amount: 'aprobado', bank_reference: 'ref. banco', result: 'resultado', total: 'total', items: 'prendas', payments: 'pagos', amount: 'monto', method: 'forma', bank: 'banco', reference_number: 'referencia', paid_at: 'fecha' };

function summarize(e) {
  const d = e.data ?? {};
  if (e.action === 'edit') { const keys = [...Object.keys(d.cambios ?? {}), ...(d.prendas ? ['prendas'] : [])]; return keys.length ? [`Cambió: ${keys.join(', ')}`] : []; }
  return Object.entries(d).filter(([k, v]) => !SKIP.has(k) && v !== null && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${KEY_LABELS[k] ?? k.replace(/_/g, ' ')}: ${typeof v === 'boolean' ? (v ? 'sí' : 'no') : v}`);
}

function Stepper({ sheet }) {
  const current = stageIndex(sheet);
  const closed = sheet.status === 'CERRADO';
  return (
    <ol className="flex items-start overflow-x-auto pb-1" aria-label="Progreso del pedido">
      {STAGES.map((st, i) => {
        const done = closed || i < current;
        const now = !closed && i === current;
        const Icon = st.icon;
        return (
          <li key={st.key} className="relative flex min-w-[68px] flex-1 flex-col items-center gap-1.5 text-center" aria-current={now ? 'step' : undefined}>
            {i > 0 && <span className={`absolute right-1/2 top-4 h-0.5 w-full ${i <= current || closed ? 'bg-success' : 'bg-line'}`} />}
            <span className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 transition ${done ? 'border-success bg-success text-white' : now ? 'border-accent bg-accent text-white ring-4 ring-accent/20' : 'border-line bg-paper text-greige'}`}>
              {done ? <Check size={15} strokeWidth={3} /> : <Icon size={14} />}
            </span>
            <span className={`text-[10px] font-semibold leading-tight ${now ? 'text-accent' : done ? 'text-ink' : 'text-greige'}`}>{st.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const Row = ({ icon: Icon, label, children }) => (
  <div className="flex gap-3">
    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${SOFT} text-greige-ink`}><Icon size={15} /></span>
    <div className="min-w-0"><div className="text-[11px] font-medium text-greige">{label}</div><div className="break-words text-sm text-ink">{children || <span className="text-greige">—</span>}</div></div>
  </div>
);

function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-paper p-1">
      {tabs.map(([key, label, count]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} onClick={() => onChange(key)}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${value === key ? 'bg-accent text-white shadow-sm' : 'text-greige-ink hover:text-ink'}`}>
          {label}{count != null && <span className={`rounded-full px-1.5 text-[10px] font-bold ${value === key ? 'bg-white/25' : SOFT}`}>{count}</span>}
        </button>
      ))}
    </div>
  );
}

export default function SheetDrawer({ sheetId, me, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState('resumen');
  const [note, setNote] = useState('');

  const load = useCallback(() => fetchSheet(sheetId).then(setDetail).catch((e) => setError(e.message)), [sheetId]);
  useEffect(() => { load(); }, [load]);
  const refresh = () => { setDialog(null); load(); onChanged?.(); };

  const captured = useMemo(() => {
    if (!detail) return [];
    return Object.entries(detail.sheet.step_data ?? {}).map(([key, d]) => {
      const meta = me?.steps?.[key];
      const fields = (meta?.fields ?? []).filter((f) => d[f.key] !== undefined && d[f.key] !== '' && d[f.key] !== true).map((f) => [f.label, String(d[f.key])]);
      return { key, label: meta?.label ?? key, at: d.at, by: d.by, fields };
    }).filter((s) => s.fields.length).sort((a, b) => new Date(a.at) - new Date(b.at));
  }, [detail, me]);

  if (error) return <Drawer onClose={onClose}><div className="p-8"><p className="text-sm text-danger">{error}</p><GhostBtn className="mt-4" onClick={onClose}>Cerrar</GhostBtn></div></Drawer>;
  if (!detail) {
    return <Drawer onClose={onClose}><div className="flex flex-col gap-4 p-6"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-16" /><Skeleton className="h-32" /><Skeleton className="h-64" /></div></Drawer>;
  }

  const { sheet, customer, items, payments, events, paid, actions, canAudit, editable, canDeleteTest, missing } = detail;
  const allowed = actions.filter((a) => a.allowed);
  const waiting = actions.filter((a) => !a.allowed && !['hold', 'cancel', 'resume'].includes(a.key));
  const exceptional = allowed.filter((a) => ['hold', 'cancel', 'resume'].includes(a.key));
  const main = allowed.filter((a) => !['hold', 'cancel', 'resume'].includes(a.key));
  const eventLabel = (a) => EVENT_LABELS[a] ?? me?.steps?.[a]?.label ?? a;
  const pct = paid.required > 0 ? Math.min(100, Math.round((paid.approved / paid.required) * 100)) : 0;
  const covered = paid.approved + 0.001 >= paid.required;
  const terminal = ['CERRADO', 'CANCELADA'].includes(sheet.status);

  async function remove() {
    try { await removeSheetPayment(sheet.id, removing.id); showSuccess('Pago retirado'); setRemoving(null); refresh(); } catch (e) { showError(e.message); setRemoving(null); }
  }
  async function removeTest() {
    try { await deleteTestSheet(sheet.id); showSuccess('Ficha de prueba eliminada'); setDeleting(false); onChanged?.(); onClose(); } catch (e) { showError(e.message); setDeleting(false); }
  }
  async function saveNote() {
    try { await addSheetNote(sheet.id, note); setNote(''); load(); } catch (e) { showError(e.message); }
  }

  return (
    <>
      <Drawer onClose={onClose} locked={!!dialog || !!removing || deleting || editing}>
        <header className="shrink-0 border-b border-line bg-paper px-6 pb-3 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold tracking-tight text-ink tabular-nums">{sheet.sheet_number}</h2>
                <StatusBadge status={sheet.status} label={sheet.statusLabel} /><ModeBadge mode={sheet.payment_mode} />{sheet.is_test && <TestBadge />}<SlaChip sla={sheet.sla} status={sheet.status} />
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-greige-ink">
                <span className="font-medium text-ink">{customer?.full_name ?? sheet.full_name}</span><span>·</span>
                <span className="flex items-center gap-1.5"><Avatar name={sheet.advisor_name} size={18} />{sheet.advisor_name}</span>
                {sheet.payment_approved_at && <><span>·</span><span>Pago aprobado {fmtDT(sheet.payment_approved_at)}</span></>}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canDeleteTest && <GhostBtn className="!px-3 !py-2 !text-danger" onClick={() => setDeleting(true)}><Trash2 size={14} />Eliminar prueba</GhostBtn>}
              {editable && <GhostBtn className="!px-3 !py-2" onClick={() => setEditing(true)}><Pencil size={14} />Editar</GhostBtn>}
              <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-2 text-greige hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]"><X size={20} /></button>
            </div>
          </div>
          {!['CANCELADA', 'BORRADOR'].includes(sheet.status) && <div className="mt-4"><Stepper sheet={sheet} /></div>}
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {sheet.notes && <Banner tone="note" icon={StickyNote} title="Observaciones del cliente">{sheet.notes}</Banner>}
          {sheet.status === 'OBSERVADA' && sheet.observation && <Banner tone="danger" icon={AlertTriangle} title="Debe corregirse">{sheet.observation}</Banner>}
          {sheet.status === 'PAUSADA' && <Banner tone="warn" icon={PauseCircle} title="Pedido pausado">{sheet.hold_reason}</Banner>}
          {sheet.status === 'CANCELADA' && <Banner tone="neutral" icon={Ban} title="Pedido cancelado">{sheet.hold_reason}</Banner>}
          {editable && missing.length > 0 && <Banner tone="warn" icon={AlertTriangle} title="Antes de enviar a auditoría falta">{missing.join(' · ')}</Banner>}

          {!terminal && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`rounded-2xl border p-5 ${main.length ? 'border-accent/40 bg-accent-soft' : 'border-line bg-paper'}`}>
              <div className="flex items-center gap-2 text-sm font-semibold text-ink">{main.length ? <><Zap size={16} className="text-accent" />Te toca</> : <><Clock size={16} className="text-greige" />Siguiente paso</>}</div>
              {main.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">{main.map((a, i) => <PrimaryBtn key={a.key} className={i > 0 ? '!bg-paper !text-ink !shadow-none border border-line hover:!bg-black/[0.04]' : ''} onClick={() => setDialog({ type: 'step', action: a })}>{a.label}</PrimaryBtn>)}</div>
              ) : <p className="mt-1.5 text-sm text-greige-ink">Por ahora no tienes pasos en esta ficha.</p>}
              {waiting.length > 0 && (
                <ul className="mt-3 space-y-1.5 border-t border-line-soft pt-3 text-xs text-greige-ink">
                  {waiting.map((a) => <li key={a.key} className="flex items-start gap-1.5"><Lock size={11} className="mt-0.5 shrink-0" /><span><b className="text-ink">{a.label}</b> — {a.roles.join(' / ')}. {a.reason}</span></li>)}
                </ul>
              )}
            </motion.div>
          )}

          <Tabs value={tab} onChange={setTab} tabs={[['resumen', 'Resumen'], ['pagos', 'Pagos', payments.length], ['prendas', 'Prendas', items.length], ['historial', 'Historial', events.length]]} />

          {tab === 'resumen' && (
            <div className="space-y-4">
              <Panel title="Cliente y entrega" icon={User}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Row icon={User} label="Nombre"><CopyText text={sheet.full_name} /></Row>
                  <Row icon={Phone} label="Celular"><CopyText text={sheet.phone} />{sheet.phone_alt && <span className="text-greige"> · {sheet.phone_alt}</span>}</Row>
                  <Row icon={Mail} label="Correo"><CopyText text={sheet.email} /></Row>
                  <Row icon={Hash} label="DPI · factura">{[sheet.dpi, [sheet.invoice_name, sheet.invoice_nit].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</Row>
                  {sheet.delivery_type === 'tienda' ? (
                    <Row icon={Store} label="Recoge en tienda"><b>{sheet.pickup_store}</b></Row>
                  ) : (
                  <Row icon={MapPin} label={sheet.delivery_type === 'agencia' ? 'Entrega en agencia' : 'Dirección de entrega'}>
                    <CopyText text={[sheet.address, sheet.address_ref, sheet.city, sheet.department].filter(Boolean).join(', ')}>{sheet.address}<span className="block text-xs text-greige-ink">{[sheet.address_ref, sheet.city, sheet.department].filter(Boolean).join(' · ')}</span></CopyText>
                    {sheet.receiver_name && <span className="block text-xs text-greige-ink">Recibe: {sheet.receiver_name}</span>}
                  </Row>
                  )}
                  {sheet.delivery_type !== 'tienda' && <Row icon={Truck} label="Flete (aparte del total)">{q(sheet.shipping)} · {sheet.shipping_payment === 'al_recibir' ? <b className="text-warning">se cobra al recibir</b> : 'ya pagado'}</Row>}
                  <Row icon={FileText} label={`Origen → despacho · ${detail.transfers.length} TR`}>{(sheet.origin_warehouses ?? []).join(', ') || '—'} → {sheet.dispatch_warehouse}{sheet.advisor_code && <span className="block text-xs text-greige-ink">Código de vendedora: {sheet.advisor_code}</span>}{sheet.campaign && <span className="block text-xs text-greige-ink">Campaña: {sheet.campaign}</span>}</Row>
                </div>
              </Panel>
              {captured.length > 0 && (
                <Panel title="Datos del proceso" icon={CircleDot}>
                  <ul className="space-y-3">
                    {captured.map((s) => (
                      <li key={s.key} className="rounded-xl border border-line-soft p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-ink"><span className="flex items-center gap-1.5"><CheckCircle2 size={14} className="text-success" />{s.label}</span><span className="text-[11px] font-normal text-greige">{s.by} · {fmtDT(s.at)}</span></div>
                        <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">{s.fields.map(([k, v]) => <div key={k}><dt className="text-[11px] text-greige">{k}</dt><dd className="break-words text-sm text-ink">{v}</dd></div>)}</dl>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
              {exceptional.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {exceptional.map((a) => (a.key === 'resume' ? <GhostBtn key={a.key} onClick={() => setDialog({ type: 'step', action: a })}>{a.label}</GhostBtn> : <DangerBtn key={a.key} onClick={() => setDialog({ type: 'step', action: a })}>{a.label}</DangerBtn>))}
                </div>
              )}
            </div>
          )}

          {tab === 'pagos' && (
            <div className="space-y-4">
              <Panel>
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div><div className="text-[11px] font-medium text-greige">Pago aprobado{sheet.payment_mode === 'contraentrega' ? ` (anticipo ${detail.config.codAdvancePct}%)` : ''}</div><div className="text-2xl font-bold tabular-nums text-ink">{q(paid.approved)} <span className="text-sm font-medium text-greige">de {q(paid.required)}</span></div></div>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${covered ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning'}`}>{covered ? 'Cubierto' : `Faltan ${q(paid.required - paid.approved)}`}</span>
                </div>
                <div className={`mt-3 h-2 overflow-hidden rounded-full ${SOFT}`}><motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} className={`h-full rounded-full ${covered ? 'bg-success' : 'bg-accent'}`} /></div>
              </Panel>
              <div className="grid gap-3 sm:grid-cols-2">
                {payments.map((p) => (
                  <div key={p.id} className="flex gap-3 rounded-2xl border border-line bg-paper p-3.5 shadow-sm">
                    {p.attachment_id && <ProofThumb id={p.attachment_id} mime={p.mime_type} filename={p.filename} size="h-28 w-24" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-1.5"><b className="text-base tabular-nums text-ink">{q(p.amount)}</b><AuditPill status={p.audit_status} /></div>
                      <p className="mt-1 text-xs text-greige-ink">{METHOD_LABELS[p.method]}{p.bank ? ` · ${p.bank}` : ''}</p>
                      <p className="break-all font-mono text-[11px] text-greige-ink">ref. {p.reference_number}{p.paid_at ? ` · ${p.paid_at.slice(0, 10)}` : ''}</p>
                      <p className="mt-1 text-[11px] text-greige">Cargó {p.added_by_name}</p>
                      {p.audited_at && <p className="mt-1.5 rounded-lg bg-black/[0.03] p-2 text-[11px] text-greige-ink dark:bg-white/[0.04]">{p.audited_by_name} · {fmtDT(p.audited_at)}{p.audit_bank_reference ? ` · banco ${p.audit_bank_reference}` : ''}{p.audit_amount != null ? ` · ${q(p.audit_amount)}` : ''}{p.audit_note ? ` · ${p.audit_note}` : ''}</p>}
                      {p.audit_evidence_id && <div className="mt-1.5"><ProofThumb id={p.audit_evidence_id} mime={p.audit_evidence_mime} filename="Captura del banco" size="h-12 w-16" /></div>}
                      <div className="mt-2 flex items-center gap-3">
                        {canAudit && p.audit_status === 'pendiente' && <PrimaryBtn className="!px-3 !py-1.5 text-xs" onClick={() => setDialog({ type: 'audit', payment: p })}><ShieldCheck size={13} />Auditar</PrimaryBtn>}
                        {editable && p.audit_status !== 'aprobado' && <button type="button" onClick={() => setRemoving(p)} className="inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline"><Trash2 size={12} />Retirar</button>}
                      </div>
                    </div>
                  </div>
                ))}
                {editable && (
                  <button type="button" onClick={() => setDialog({ type: 'payment' })} className="flex min-h-[132px] flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-line text-sm font-medium text-greige-ink transition hover:border-accent hover:text-accent">
                    <Plus size={20} />Agregar pago
                  </button>
                )}
              </div>
              {!payments.length && !editable && <p className="text-sm text-greige-ink">No hay pagos cargados.</p>}
            </div>
          )}

          {tab === 'prendas' && (
            <Panel pad={false}>
              <ul className="divide-y divide-line-soft">
                {items.map((i) => (
                  <li key={i.id} className="flex items-center gap-4 px-5 py-3.5">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold tabular-nums ${SOFT} text-ink`}>{i.quantity}×</span>
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-ink">{i.reference}{i.description && <span className="font-normal text-greige-ink"> · {i.description}</span>}</div><div className="text-xs text-greige-ink">Talla {i.size} · {i.color}{i.origin_warehouse ? ` · ${i.origin_warehouse}` : ''}</div></div>
                    <div className="text-right"><div className="text-sm font-bold tabular-nums text-ink">{q(Number(i.final_price) * i.quantity)}</div>{Number(i.discount_pct) > 0 && <div className="text-[11px] text-greige line-through">{q(Number(i.unit_price) * i.quantity)}</div>}</div>
                  </li>
                ))}
                {!items.length && <li className="px-5 py-8 text-center text-sm text-greige-ink">Todavía no hay prendas.</li>}
              </ul>
              <dl className="space-y-1 border-t border-line-soft px-5 py-4 text-sm">
                <div className="flex justify-between text-greige-ink"><dt>Subtotal</dt><dd className="tabular-nums">{q(sheet.subtotal)}</dd></div>
                <div className="flex justify-between text-greige-ink"><dt>Descuento</dt><dd className="tabular-nums">−{q(sheet.discount_total)}</dd></div>
                <div className="flex justify-between border-t border-line-soft pt-2 text-base font-bold text-ink"><dt>Total del pedido</dt><dd className="tabular-nums">{q(sheet.total)}</dd></div>
                <div className="flex justify-between text-xs text-greige"><dt>Flete (aparte){sheet.shipping_payment === 'al_recibir' ? ' · se cobra al recibir' : sheet.shipping_payment === 'pagado' ? ' · ya pagado' : ''}</dt><dd className="tabular-nums">{q(sheet.shipping)}</dd></div>
              </dl>
            </Panel>
          )}

          {tab === 'historial' && (
            <Panel title="Historial sellado" icon={Lock} right={<span className="text-[11px] text-greige">No se edita ni se borra</span>}>
              <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-line">
                {[...events].reverse().map((e) => {
                  const Icon = EVENT_ICONS[e.action] ?? CheckCircle2;
                  const chips = summarize(e);
                  return (
                    <li key={e.id} className="relative flex gap-3.5">
                      <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-paper ${EVENT_ICONS[e.action] ? 'text-greige-ink' : 'text-success'}`}><Icon size={14} /></span>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="flex flex-wrap items-baseline gap-x-2"><b className="text-sm text-ink">{eventLabel(e.action)}</b>{e.to_status && e.from_status !== e.to_status && <span className="text-xs text-greige-ink">→ {me?.statusLabels?.[e.to_status] ?? e.to_status}</span>}</div>
                        <p className="text-xs text-greige">{e.actor_name}{e.actor_roles?.length ? ` · ${e.actor_roles.map((r) => me?.roleLabels?.[r] ?? r).join(', ')}` : ''} · {fmtDT(e.at)}{e.data?.codigo ? ` · ${e.data.codigo}` : ''}</p>
                        {chips.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{chips.map((c) => <span key={c} className={`rounded-md px-1.5 py-0.5 text-[11px] text-greige-ink ${SOFT}`}>{c}</span>)}</div>}
                        {e.note && <p className="mt-1.5 rounded-lg border-l-2 border-accent bg-accent-soft px-3 py-1.5 text-sm text-ink">{e.note}</p>}
                        {e.evidence?.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{e.evidence.map((ev) => <ProofThumb key={ev.id} id={ev.id} mime={ev.mime} filename={ev.filename} size="h-16 w-16" />)}</div>}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-6 flex gap-2 border-t border-line-soft pt-4">
                <input className={inputCls} placeholder="Agregar una nota al historial…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) saveNote(); }} />
                <GhostBtn disabled={!note.trim()} onClick={saveNote}>Guardar</GhostBtn>
              </div>
            </Panel>
          )}
        </div>
      </Drawer>

      <AnimatePresence>
        {dialog?.type === 'step' && <StepDialog key="step" sheetId={sheet.id} action={dialog.action} onClose={() => setDialog(null)} onDone={refresh} />}
        {dialog?.type === 'payment' && <PaymentDialog key="pay" sheet={sheet} onClose={() => setDialog(null)} onDone={refresh} />}
        {dialog?.type === 'audit' && <AuditDialog key="audit" sheetId={sheet.id} payment={dialog.payment} onClose={() => setDialog(null)} onDone={refresh} />}
      </AnimatePresence>
      {editing && <SheetWizard sheetId={sheet.id} onClose={() => { setEditing(false); refresh(); }} />}
      <ConfirmDialog open={deleting} danger title="¿Eliminar esta ficha de prueba?" message={`${sheet.sheet_number} se borra por completo con sus pagos y su historial. Los comprobantes del chat no se tocan. No se puede deshacer.`} confirmLabel="Eliminar" onConfirm={removeTest} onCancel={() => setDeleting(false)} />
      <ConfirmDialog open={!!removing} danger title="¿Retirar este pago?" message={removing ? `${q(removing.amount)} · ref. ${removing.reference_number}. Queda registrado en el historial.` : ''} confirmLabel="Retirar" onConfirm={remove} onCancel={() => setRemoving(null)} />
    </>
  );
}

function Banner({ tone, icon: Icon, title, children }) {
  const cls = { note: 'border-yellow-400/50 bg-yellow-300/25 text-ink', danger: 'border-danger/30 bg-danger-bg text-danger', warn: 'border-warning/30 bg-warning/10 text-warning', neutral: `border-line ${SOFT} text-greige-ink` }[tone];
  return (
    <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${cls}`}>
      <Icon size={18} className="mt-0.5 shrink-0" />
      <div><p className="font-semibold">{title}</p><p className="mt-0.5 opacity-90">{children}</p></div>
    </div>
  );
}
