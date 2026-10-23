import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Square, CheckSquare, Lock, Image as ImageIcon } from 'lucide-react';
import { runSheetStep, addSheetPayment, auditSheetPayment, fetchChatProofs, logisticsFileUrl } from '../../api.js';
import { showSuccess, showError } from '../Toast.jsx';
import { Modal, PrimaryBtn, GhostBtn, FieldRow, ProofThumb, Dropzone, inputCls, SOFT, METHOD_LABELS, q, fmtDT } from '../../lib/logisticsUi.jsx';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' });

function Errors({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-bg px-3.5 py-3 text-sm text-danger">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div><p className="font-semibold">{error.message}</p>{error.missing?.length > 1 && <ul className="mt-1 list-disc pl-4">{error.missing.map((m) => <li key={m}>{m}</li>)}</ul>}</div>
    </div>
  );
}

const Check = ({ checked, onChange, children }) => (
  <button type="button" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)}
    className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-sm transition ${checked ? 'border-success/40 bg-success/5 text-ink' : 'border-line text-greige-ink hover:border-greige'}`}>
    {checked ? <CheckSquare size={18} className="mt-px shrink-0 text-success" /> : <Square size={18} className="mt-px shrink-0 text-greige" />}
    <span>{children}</span>
  </button>
);

// Paso del flujo: pinta los campos que declara el servidor (action.fields) y la evidencia que exige.
export function StepDialog({ sheetId, action, onClose, onDone }) {
  const [values, setValues] = useState(() => Object.fromEntries(action.fields.map((f) => [f.key, f.type === 'date' ? today() : f.type === 'bool' ? false : ''])));
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));
  const bools = action.fields.filter((f) => f.type === 'bool');
  const others = action.fields.filter((f) => f.type !== 'bool');
  const destructive = ['cancel', 'hold', 'verify_observe', 'audit_pack_fail', 'return_to_hub'].includes(action.key);

  async function run() {
    setBusy(true); setError(null);
    try {
      const sheet = await runSheetStep(sheetId, action.key, values, note, files);
      showSuccess(action.label);
      onDone(sheet);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Modal title={action.label} subtitle={<span className="flex flex-wrap items-center gap-2"><code className={`rounded px-1.5 py-0.5 text-[11px] ${SOFT}`}>{action.code}</code>{action.roles.join(' · ')}</span>} onClose={onClose}
      footer={<><GhostBtn onClick={onClose} disabled={busy}>Cancelar</GhostBtn><PrimaryBtn onClick={run} disabled={busy} className={destructive ? '!bg-danger !shadow-danger/20 hover:!bg-danger/90' : ''}>{busy ? 'Guardando…' : 'Confirmar y sellar'}</PrimaryBtn></>}>
      <div className="flex flex-col gap-4">
        {bools.length > 0 && <div className="flex flex-col gap-2">{bools.map((f) => <Check key={f.key} checked={values[f.key] === true} onChange={(v) => set(f.key, v)}>{f.label}</Check>)}</div>}
        {others.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {others.map((f) => (
              <FieldRow key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} className={f.type === 'text' && f.label.length > 38 ? 'sm:col-span-2' : ''}>
                {f.type === 'select'
                  ? <select className={inputCls} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)}><option value="">Elegir…</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : <input className={inputCls} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step={f.type === 'number' ? '0.01' : undefined} min={f.type === 'number' ? '0' : undefined} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />}
              </FieldRow>
            ))}
          </div>
        )}
        <Dropzone multiple label={action.evidence ? action.evidence.label : 'Evidencia (opcional)'} required={action.evidence?.required} files={files} onChange={setFiles} />
        <FieldRow label="Nota (opcional)"><textarea rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Algo que el siguiente paso deba saber" /></FieldRow>
        <Errors error={error} />
        <p className="flex items-center gap-2 text-xs text-greige"><Lock size={12} />Queda sellado con tu nombre, la hora y la evidencia. No se puede editar después.</p>
      </div>
    </Modal>
  );
}

// Agrega un pago a la ficha: archivo nuevo o un comprobante que el cliente ya mandó por el chat.
export function PaymentDialog({ sheet, onClose, onDone }) {
  const [form, setForm] = useState({ method: 'transferencia', amount: '', bank: '', reference_number: '', paid_at: today() });
  const [files, setFiles] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [proofs, setProofs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  useEffect(() => { fetchChatProofs(sheet.customer_id).then((r) => setProofs(r.proofs)).catch(() => {}); }, [sheet.customer_id]);

  async function save() {
    setBusy(true); setError(null);
    try {
      await addSheetPayment(sheet.id, { ...form, ...(chatId ? { attachmentId: chatId } : {}) }, chatId ? null : files[0]);
      showSuccess('Pago agregado a la ficha');
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Modal title="Agregar pago" subtitle="Cada pago lleva su comprobante y su número de referencia. La suma de los pagos debe cubrir lo que exige la ficha." onClose={onClose}
      footer={<><GhostBtn onClick={onClose} disabled={busy}>Cancelar</GhostBtn><PrimaryBtn onClick={save} disabled={busy || (!files.length && !chatId)}>{busy ? 'Guardando…' : 'Agregar pago'}</PrimaryBtn></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Forma de pago *"><select className={inputCls} value={form.method} onChange={(e) => set('method', e.target.value)}>{Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FieldRow>
          <FieldRow label="Monto (Q) *"><input className={inputCls} type="number" step="0.01" min="0" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" /></FieldRow>
          <FieldRow label="Banco"><input className={inputCls} value={form.bank} onChange={(e) => set('bank', e.target.value)} placeholder="Ej. Banrural" /></FieldRow>
          <FieldRow label="No. de referencia *"><input className={inputCls} value={form.reference_number} onChange={(e) => set('reference_number', e.target.value)} /></FieldRow>
          <FieldRow label="Fecha del pago"><input className={inputCls} type="date" value={form.paid_at} onChange={(e) => set('paid_at', e.target.value)} /></FieldRow>
        </div>
        <Dropzone label="Comprobante" required files={files} onChange={(f) => { setFiles(f); setChatId(null); }} hint="Foto o PDF del comprobante" />
        {proofs.length > 0 && (
          <div>
            <span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-greige-ink"><ImageIcon size={13} />…o elige uno que el cliente mandó por el chat (últimos 30 días)</span>
            <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto p-1">
              {proofs.map((p) => (
                <div key={p.id} className="relative">
                  <button type="button" onClick={() => { setChatId(chatId === p.id ? null : p.id); setFiles([]); }} aria-pressed={chatId === p.id} title={fmtDT(p.created_at)} className={`block rounded-xl ring-2 transition ${chatId === p.id ? 'ring-accent' : 'ring-transparent hover:ring-line'}`}>
                    <ProofThumbStatic id={p.id} mime={p.mime_type} ocr={p.ocr_amount} />
                  </button>
                  {chatId === p.id && <CheckCircle2 size={18} className="absolute -right-1 -top-1 rounded-full bg-paper text-accent" />}
                </div>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-greige">El monto sobre la miniatura es lo que leyó el sistema; confírmalo contra el comprobante.</p>
          </div>
        )}
        <Errors error={error} />
      </div>
    </Modal>
  );
}

// Miniatura sin visor (la selección del chat usa el clic para elegir).
function ProofThumbStatic({ id, mime, ocr }) {
  return (
    <span className={`relative block h-20 w-20 overflow-hidden rounded-xl border border-line ${SOFT}`}>
      {mime?.startsWith('image/') ? <img src={logisticsFileUrl(id)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="flex h-full items-center justify-center text-[10px] text-greige-ink">PDF</span>}
      {ocr != null && <span className="absolute inset-x-0 bottom-0 bg-black/65 text-[10px] font-semibold text-white">{q(ocr)}</span>}
    </span>
  );
}

// Auditoría de un pago: lo hace quien tiene el rol de auditor/a de ingresos y no cargó el pago.
export function AuditDialog({ sheetId, payment, onClose, onDone }) {
  const [result, setResult] = useState('aprobado');
  const [form, setForm] = useState({ bank_reference: payment.reference_number ?? '', approved_amount: payment.amount, note: '' });
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));
  const tones = { aprobado: 'border-success bg-success/10 text-success', observado: 'border-warning bg-warning/15 text-warning', rechazado: 'border-danger bg-danger/10 text-danger' };

  async function save() {
    setBusy(true); setError(null);
    try {
      await auditSheetPayment(sheetId, payment.id, { result, ...form }, files[0]);
      showSuccess(`Pago ${result}`);
      onDone();
    } catch (err) { setError(err); showError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal wide title="Auditar pago" subtitle="Compara lo que declaró la asesora con el movimiento real en el banco." onClose={onClose}
      footer={<><GhostBtn onClick={onClose} disabled={busy}>Cancelar</GhostBtn><PrimaryBtn onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Registrar auditoría'}</PrimaryBtn></>}>
      <div className="grid gap-5 sm:grid-cols-[200px_1fr]">
        <div>
          {payment.attachment_id && <ProofThumb id={payment.attachment_id} mime={payment.mime_type} filename={payment.filename} size="h-52 w-full" label="Toca para ampliar" />}
          <dl className="mt-3 space-y-1.5 text-sm">
            <div><dt className="text-[11px] text-greige">Monto declarado</dt><dd className="text-lg font-bold tabular-nums text-ink">{q(payment.amount)}</dd></div>
            <div><dt className="text-[11px] text-greige">Forma · banco</dt><dd className="text-ink">{METHOD_LABELS[payment.method]}{payment.bank ? ` · ${payment.bank}` : ''}</dd></div>
            <div><dt className="text-[11px] text-greige">Referencia declarada</dt><dd className="break-all font-mono text-ink">{payment.reference_number}</dd></div>
            <div><dt className="text-[11px] text-greige">Cargado por</dt><dd className="text-ink">{payment.added_by_name}</dd></div>
          </dl>
        </div>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2">
            {['aprobado', 'observado', 'rechazado'].map((r) => (
              <button type="button" key={r} onClick={() => setResult(r)} aria-pressed={result === r} className={`rounded-xl border-2 px-3 py-2.5 text-sm font-semibold capitalize transition ${result === r ? tones[r] : 'border-line text-greige-ink hover:border-greige'}`}>{r}</button>
            ))}
          </div>
          {result === 'aprobado' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldRow label="Referencia verificada en el banco *"><input className={inputCls} value={form.bank_reference} onChange={(e) => set('bank_reference', e.target.value)} /></FieldRow>
              <FieldRow label="Valor aprobado (Q) *"><input className={inputCls} type="number" step="0.01" min="0" value={form.approved_amount} onChange={(e) => set('approved_amount', e.target.value)} /></FieldRow>
            </div>
          ) : (
            <FieldRow label="Motivo *"><textarea rows={3} className={inputCls} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Qué no cuadra y qué debe corregir la asesora" /></FieldRow>
          )}
          <Dropzone label="Captura del movimiento bancario" required={result === 'aprobado'} files={files} onChange={setFiles} hint="Imagen o PDF del banco que muestre la referencia y el monto" />
          <Errors error={error} />
        </div>
      </div>
    </Modal>
  );
}
