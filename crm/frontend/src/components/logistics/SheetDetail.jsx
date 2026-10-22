import { useCallback, useEffect, useState } from 'react';
import { Trash2, ChevronDown, Lock } from 'lucide-react';
import { fetchSheet, removeSheetPayment, addSheetNote } from '../../api.js';
import { showSuccess, showError } from '../Toast.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import SheetForm from './SheetForm.jsx';
import { StepDialog, PaymentDialog, AuditDialog } from './StepDialogs.jsx';
import {
  Modal, StatusBadge, ModeBadge, SlaChip, ProofThumb, PrimaryBtn, GhostBtn, inputCls, q, fmtDT, fmtDay, METHOD_LABELS, AUDIT_LABELS, AUDIT_TONE,
} from '../../lib/logisticsUi.jsx';

const TONE_CLS = { warn: 'bg-warning/15 text-warning', success: 'bg-success/10 text-success', danger: 'bg-danger/10 text-danger' };
const BUILTIN_EVENTS = { create: 'Ficha creada', edit: 'Ficha editada', add_payment: 'Pago agregado', remove_payment: 'Pago retirado', audit_payment: 'Pago auditado', auto_status: 'Cambio automático', note: 'Nota', submit: 'Enviada a auditoría de pago' };
const SKIP_KEYS = new Set(['codigo']);

function summarize(e) {
  const d = e.data ?? {};
  if (e.action === 'edit') return Object.keys(d.cambios ?? {}).length || d.prendas ? `Cambió: ${[...Object.keys(d.cambios ?? {}), ...(d.prendas ? ['prendas'] : [])].join(', ')}` : '';
  return Object.entries(d)
    .filter(([k, v]) => !SKIP_KEYS.has(k) && v !== null && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'boolean' ? (v ? 'sí' : 'no') : v}`).join(' · ');
}

function Section({ title, children, right }) {
  return (
    <section className="rounded-xl border border-line p-4">
      <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-ink">{title}</h3>{right}</div>
      {children}
    </section>
  );
}

const KV = ({ k, v }) => <div><div className="text-[10px] font-semibold uppercase tracking-wide text-greige-ink">{k}</div><div className="text-sm text-ink">{v || '—'}</div></div>;

export default function SheetDetail({ sheetId, me, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // { type: 'step'|'payment'|'audit', ... }
  const [removing, setRemoving] = useState(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(() => fetchSheet(sheetId).then(setDetail).catch((e) => setError(e.message)), [sheetId]);
  useEffect(() => { load(); }, [load]);
  const refresh = () => { setDialog(null); load(); onChanged?.(); };

  if (error) return <Modal title="Ficha" onClose={onClose}><p className="text-sm text-danger">{error}</p></Modal>;
  if (!detail) return <Modal title="Ficha" onClose={onClose}><p className="py-10 text-center text-sm text-greige-ink">Cargando…</p></Modal>;

  const { sheet, customer, items, payments, events, paid, actions, canAudit, editable, missing } = detail;
  const eventLabel = (a) => BUILTIN_EVENTS[a] ?? me?.steps?.[a]?.label ?? a;
  const allowed = actions.filter((a) => a.allowed);
  const blocked = actions.filter((a) => !a.allowed);
  const covered = paid.approved + 0.001 >= paid.required;

  async function remove() {
    try { await removeSheetPayment(sheet.id, removing.id); showSuccess('Pago retirado'); setRemoving(null); refresh(); } catch (e) { showError(e.message); setRemoving(null); }
  }
  async function saveNote() {
    try { await addSheetNote(sheet.id, note); setNote(''); load(); } catch (e) { showError(e.message); }
  }

  return (
    <>
      <Modal wide onClose={dialog || removing ? () => {} : onClose} title={<span className="flex flex-wrap items-center gap-2">{sheet.sheet_number}<StatusBadge status={sheet.status} label={sheet.statusLabel} /><ModeBadge mode={sheet.payment_mode} /><SlaChip sla={sheet.sla} status={sheet.status} /></span>}
        subtitle={<>{customer?.full_name ?? sheet.full_name} · Asesora: {sheet.advisor_name}{sheet.payment_approved_at && <> · Pago aprobado {fmtDT(sheet.payment_approved_at)} · entrega antes del {fmtDay(sheet.deadline_at)}</>}</>}>
        <div className="flex flex-col gap-4">
          {sheet.observation && sheet.status === 'OBSERVADA' && <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"><b>Debe corregirse:</b> {sheet.observation}</div>}
          {sheet.status === 'PAUSADA' && <div className="rounded-lg bg-warning/15 px-4 py-3 text-sm text-warning"><b>Pausada:</b> {sheet.hold_reason}</div>}
          {editable && missing.length > 0 && <div className="rounded-lg bg-warning/15 px-4 py-3 text-sm text-warning"><b>Antes de enviar falta:</b> {missing.join(' · ')}</div>}

          {actions.length > 0 && (
            <Section title="Qué sigue">
              <div className="flex flex-wrap gap-2">
                {allowed.map((a) => (
                  <PrimaryBtn key={a.key} onClick={() => setDialog({ type: 'step', action: a })} className={a.key === 'cancel' || a.key === 'hold' ? '!bg-danger/90' : ''}>{a.label}</PrimaryBtn>
                ))}
                {!allowed.length && <p className="text-sm text-greige-ink">No tienes pasos disponibles en esta ficha.</p>}
              </div>
              {blocked.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-greige-ink">
                  {blocked.filter((a) => !['hold', 'cancel'].includes(a.key)).map((a) => <li key={a.key} className="flex items-start gap-1.5"><Lock size={11} className="mt-0.5 shrink-0" /><span><b>{a.label}</b> ({a.code}) — {a.roles.join(' / ')}. {a.reason}</span></li>)}
                </ul>
              )}
            </Section>
          )}

          <Section title="Pagos y comprobantes" right={<span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${covered ? TONE_CLS.success : TONE_CLS.warn}`}>Aprobado {q(paid.approved)} de {q(paid.required)}{sheet.payment_mode === 'contraentrega' ? ` (anticipo ${detail.config.codAdvancePct}%)` : ''}</span>}>
            <div className="grid gap-3 sm:grid-cols-2">
              {payments.map((p) => (
                <div key={p.id} className="flex gap-3 rounded-xl border border-line-soft p-3">
                  {p.attachment_id && <ProofThumb id={p.attachment_id} mime={p.mime_type} filename={p.filename} />}
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><b className="tabular-nums text-ink">{q(p.amount)}</b><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${TONE_CLS[AUDIT_TONE[p.audit_status]]}`}>{AUDIT_LABELS[p.audit_status]}</span></div>
                    <p className="text-xs text-greige-ink">{METHOD_LABELS[p.method]}{p.bank ? ` · ${p.bank}` : ''} · ref. {p.reference_number}{p.paid_at ? ` · ${p.paid_at.slice(0, 10)}` : ''}</p>
                    <p className="text-xs text-greige">Cargó {p.added_by_name}</p>
                    {p.audited_at && <p className="mt-1 text-xs text-greige-ink">Auditó {p.audited_by_name} · {fmtDT(p.audited_at)}{p.audit_bank_reference ? ` · banco ref. ${p.audit_bank_reference}` : ''}{p.audit_amount != null ? ` · ${q(p.audit_amount)}` : ''}{p.audit_note ? ` · ${p.audit_note}` : ''}</p>}
                    {p.audit_evidence_id && <div className="mt-1.5"><ProofThumb id={p.audit_evidence_id} mime={p.audit_evidence_mime} filename="Captura del banco" size="h-12 w-12" /></div>}
                    <div className="mt-2 flex gap-2">
                      {canAudit && p.audit_status === 'pendiente' && <PrimaryBtn className="!px-3 !py-1 text-xs" onClick={() => setDialog({ type: 'audit', payment: p })}>Auditar</PrimaryBtn>}
                      {editable && p.audit_status !== 'aprobado' && <button type="button" onClick={() => setRemoving(p)} className="inline-flex items-center gap-1 text-xs text-danger hover:underline"><Trash2 size={12} />Retirar</button>}
                    </div>
                  </div>
                </div>
              ))}
              {!payments.length && <p className="text-sm text-greige-ink">Todavía no hay pagos cargados.</p>}
            </div>
            {editable && <GhostBtn className="mt-3 !py-1.5 text-xs" onClick={() => setDialog({ type: 'payment' })}>Agregar pago</GhostBtn>}
          </Section>

          <Section title="Cliente y entrega">
            <div className="grid gap-3 sm:grid-cols-3">
              <KV k="Nombre" v={sheet.full_name} /><KV k="Celular" v={sheet.phone} /><KV k="Correo" v={sheet.email} />
              <KV k="Dirección" v={sheet.address} /><KV k="Ciudad / Depto." v={[sheet.city, sheet.department].filter(Boolean).join(', ')} /><KV k="Referencia" v={sheet.address_ref} />
              <KV k="Entrega" v={sheet.delivery_type === 'agencia' ? 'En agencia' : 'A domicilio'} /><KV k="Recibe" v={sheet.receiver_name} /><KV k="Campaña" v={sheet.campaign} />
              <KV k="Origen" v={`${sheet.origin_mode === 'multiple' ? 'Varias' : 'Una'}: ${(sheet.origin_warehouses ?? []).join(', ') || '—'}`} /><KV k="Despacho" v={sheet.dispatch_warehouse} /><KV k="Factura" v={[sheet.invoice_name, sheet.invoice_nit].filter(Boolean).join(' · ')} />
            </div>
          </Section>

          <Section title="Prendas" right={<b className="tabular-nums text-ink">{q(sheet.total)}</b>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-greige-ink"><th className="pb-1">Referencia</th><th className="pb-1">Talla</th><th className="pb-1">Color</th><th className="pb-1 text-right">Cant.</th><th className="pb-1 text-right">Precio final</th></tr></thead>
                <tbody>{items.map((i) => <tr key={i.id} className="border-t border-line-soft"><td className="py-1.5 text-ink">{i.reference}<div className="text-xs text-greige-ink">{i.description}</div></td><td>{i.size}</td><td>{i.color}</td><td className="text-right tabular-nums">{i.quantity}</td><td className="text-right tabular-nums">{q(i.final_price)}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-greige-ink">Subtotal {q(sheet.subtotal)} · descuento {q(sheet.discount_total)} · envío {q(sheet.shipping)}</p>
          </Section>

          {editable && (
            <Section title="Editar datos y prendas" right={<button type="button" onClick={() => setEditing((v) => !v)} className="inline-flex items-center gap-1 text-xs font-semibold text-accent">{editing ? 'Ocultar' : 'Abrir'}<ChevronDown size={14} className={editing ? 'rotate-180' : ''} /></button>}>
              {editing ? <SheetForm detail={detail} onSaved={() => { setEditing(false); load(); onChanged?.(); }} /> : <p className="text-sm text-greige-ink">Solo quien creó la ficha (o un administrador) puede editarla mientras está en borrador u observada.</p>}
            </Section>
          )}

          <Section title="Historial sellado">
            <ol className="space-y-3">
              {events.map((e) => (
                <li key={e.id} className="border-l-2 border-line pl-3">
                  <div className="flex flex-wrap items-center gap-x-2 text-sm"><b className="text-ink">{eventLabel(e.action)}</b>{e.to_status && e.from_status !== e.to_status && <span className="text-xs text-greige-ink">{e.from_status ? `${me?.statusLabels?.[e.from_status] ?? e.from_status} → ` : ''}{me?.statusLabels?.[e.to_status] ?? e.to_status}</span>}</div>
                  <p className="text-xs text-greige-ink">{e.actor_name}{e.actor_roles?.length ? ` (${e.actor_roles.map((r) => me?.roleLabels?.[r] ?? r).join(', ')})` : ''} · {fmtDT(e.at)}{e.data?.codigo ? ` · ${e.data.codigo}` : ''}</p>
                  {summarize(e) && <p className="text-xs text-greige">{summarize(e)}</p>}
                  {e.note && <p className="text-sm text-ink">“{e.note}”</p>}
                  {e.evidence?.length > 0 && <div className="mt-1 flex flex-wrap gap-2">{e.evidence.map((ev) => <ProofThumb key={ev.id} id={ev.id} mime={ev.mime} filename={ev.filename} size="h-14 w-14" />)}</div>}
                </li>
              ))}
            </ol>
            <div className="mt-4 flex gap-2"><input className={inputCls} placeholder="Agregar una nota al historial…" value={note} onChange={(e) => setNote(e.target.value)} /><GhostBtn disabled={!note.trim()} onClick={saveNote}>Guardar nota</GhostBtn></div>
          </Section>
        </div>
      </Modal>

      {dialog?.type === 'step' && <StepDialog sheetId={sheet.id} action={dialog.action} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'payment' && <PaymentDialog sheet={sheet} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'audit' && <AuditDialog sheetId={sheet.id} payment={dialog.payment} onClose={() => setDialog(null)} onDone={refresh} />}
      <ConfirmDialog open={!!removing} danger title="¿Retirar este pago?" message={removing ? `${q(removing.amount)} · ref. ${removing.reference_number}. Queda registrado en el historial.` : ''} confirmLabel="Retirar" onConfirm={remove} onCancel={() => setRemoving(null)} />
    </>
  );
}
