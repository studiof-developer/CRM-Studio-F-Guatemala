import { useEffect, useState } from 'react';
import { runSheetStep, addSheetPayment, auditSheetPayment, fetchChatProofs } from '../../api.js';
import { showSuccess, showError } from '../Toast.jsx';
import { Modal, PrimaryBtn, GhostBtn, FieldRow, ProofThumb, inputCls, METHOD_LABELS, q, fmtDT } from '../../lib/logisticsUi.jsx';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' });

function Errors({ error }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      <p className="font-semibold">{error.message}</p>
      {error.missing?.length > 1 && <ul className="mt-1 list-disc pl-5">{error.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  );
}

function FileInput({ label, required, multiple, onFiles }) {
  return (
    <FieldRow label={`${label}${required ? ' *' : ''}`}>
      <input type="file" multiple={multiple} accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf" onChange={(e) => onFiles([...e.target.files])}
        className="block w-full text-sm text-greige-ink file:mr-3 file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-sm file:font-semibold file:text-accent" />
    </FieldRow>
  );
}

// Paso genérico del flujo: pinta los campos que declara el servidor (action.fields) y la evidencia que exige.
export function StepDialog({ sheetId, action, onClose, onDone }) {
  const [values, setValues] = useState(() => Object.fromEntries(action.fields.map((f) => [f.key, f.type === 'date' ? today() : f.type === 'bool' ? false : ''])));
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  async function run() {
    setBusy(true); setError(null);
    try {
      const sheet = await runSheetStep(sheetId, action.key, values, note, files);
      showSuccess(`Listo: ${action.label}`);
      onDone(sheet);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Modal title={action.label} subtitle={`Paso ${action.code} · ${action.roles.join(' / ')}`} onClose={onClose}
      footer={<><GhostBtn onClick={onClose} disabled={busy}>Cancelar</GhostBtn><PrimaryBtn onClick={run} disabled={busy}>{busy ? 'Un momento…' : 'Confirmar paso'}</PrimaryBtn></>}>
      <div className="flex flex-col gap-3">
        {action.fields.map((f) => (
          f.type === 'bool' ? (
            <label key={f.key} className="flex items-start gap-2 text-sm text-ink"><input type="checkbox" checked={values[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} className="mt-0.5" />{f.label}</label>
          ) : f.type === 'select' ? (
            <FieldRow key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}><select className={inputCls} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)}><option value="">Elegir…</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</select></FieldRow>
          ) : (
            <FieldRow key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}><input className={inputCls} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step={f.type === 'number' ? '0.01' : undefined} min={f.type === 'number' ? '0' : undefined} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} /></FieldRow>
          )
        ))}
        {action.evidence && <FileInput label={action.evidence.label} required={action.evidence.required} multiple onFiles={setFiles} />}
        {!action.evidence && <FileInput label="Evidencia (opcional)" multiple onFiles={setFiles} />}
        <FieldRow label="Nota (opcional)"><textarea rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></FieldRow>
        <Errors error={error} />
        <p className="text-xs text-greige">Este paso queda sellado en el historial con tu nombre, la hora y la evidencia. No se puede editar después.</p>
      </div>
    </Modal>
  );
}

// Agrega un pago a la ficha: archivo nuevo o un comprobante que el cliente ya mandó por el chat.
export function PaymentDialog({ sheet, onClose, onDone }) {
  const [form, setForm] = useState({ method: 'transferencia', amount: '', bank: '', reference_number: '', paid_at: today() });
  const [file, setFile] = useState(null);
  const [chatId, setChatId] = useState(null);
  const [proofs, setProofs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  useEffect(() => { fetchChatProofs(sheet.customer_id).then((r) => setProofs(r.proofs)).catch(() => {}); }, [sheet.customer_id]);

  async function save() {
    setBusy(true); setError(null);
    try {
      await addSheetPayment(sheet.id, { ...form, ...(chatId ? { attachmentId: chatId } : {}) }, chatId ? null : file);
      showSuccess('Pago agregado a la ficha');
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Modal title="Agregar pago" subtitle="Cada pago lleva su comprobante y su número de referencia. La suma de los pagos debe cubrir el total." onClose={onClose}
      footer={<><GhostBtn onClick={onClose} disabled={busy}>Cancelar</GhostBtn><PrimaryBtn onClick={save} disabled={busy || (!file && !chatId)}>{busy ? 'Guardando…' : 'Agregar pago'}</PrimaryBtn></>}>
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Forma de pago *"><select className={inputCls} value={form.method} onChange={(e) => set('method', e.target.value)}>{Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></FieldRow>
        <FieldRow label="Monto (Q) *"><input className={inputCls} type="number" step="0.01" min="0" value={form.amount} onChange={(e) => set('amount', e.target.value)} /></FieldRow>
        <FieldRow label="Banco"><input className={inputCls} value={form.bank} onChange={(e) => set('bank', e.target.value)} /></FieldRow>
        <FieldRow label="No. de referencia *"><input className={inputCls} value={form.reference_number} onChange={(e) => set('reference_number', e.target.value)} /></FieldRow>
        <FieldRow label="Fecha del pago"><input className={inputCls} type="date" value={form.paid_at} onChange={(e) => set('paid_at', e.target.value)} /></FieldRow>
      </div>
      <div className="mt-4 flex flex-col gap-3">
        <FileInput label="Subir comprobante" onFiles={(f) => { setFile(f[0] ?? null); setChatId(null); }} />
        {proofs.length > 0 && (
          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-greige-ink">…o elegir uno del chat (últimos 30 días)</span>
            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {proofs.map((p) => (
                <button type="button" key={p.id} onClick={() => { setChatId(p.id); setFile(null); }} className={`relative rounded-lg ring-2 ${chatId === p.id ? 'ring-accent' : 'ring-transparent'}`} title={fmtDT(p.created_at)}>
                  <ProofThumb id={p.id} mime={p.mime_type} filename={p.filename} size="h-20 w-20" />
                  {p.ocr_amount != null && <span className="absolute bottom-0 left-0 right-0 rounded-b-lg bg-black/60 text-[10px] font-semibold text-white">{q(p.ocr_amount)}</span>}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-greige">El monto bajo la miniatura es lo que leyó el sistema; confírmalo contra el comprobante.</p>
          </div>
        )}
        <Errors error={error} />
      </div>
    </Modal>
  );
}

// Auditoría de un pago: lo hace quien tiene el rol de auditor/a de ingresos y no cargó el pago.
export function AuditDialog({ sheetId, payment, onClose, onDone }) {
  const [result, setResult] = useState('aprobado');
  const [form, setForm] = useState({ bank_reference: payment.reference_number ?? '', approved_amount: payment.amount, note: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  async function save() {
    setBusy(true); setError(null);
    try {
      await auditSheetPayment(sheetId, payment.id, { result, ...form }, file);
      showSuccess(`Pago ${result}`);
      onDone();
    } catch (err) { setError(err); showError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Auditar pago" subtitle={`Declarado: ${q(payment.amount)} · ${METHOD_LABELS[payment.method]} · ref. ${payment.reference_number}`} onClose={onClose}
      footer={<><GhostBtn onClick={onClose} disabled={busy}>Cancelar</GhostBtn><PrimaryBtn onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Registrar auditoría'}</PrimaryBtn></>}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          {['aprobado', 'observado', 'rechazado'].map((r) => (
            <button type="button" key={r} onClick={() => setResult(r)} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold capitalize ${result === r ? 'border-accent bg-accent-soft text-accent' : 'border-line text-greige-ink'}`}>{r}</button>
          ))}
        </div>
        {result === 'aprobado' ? (
          <>
            <FieldRow label="Referencia bancaria verificada *"><input className={inputCls} value={form.bank_reference} onChange={(e) => set('bank_reference', e.target.value)} /></FieldRow>
            <FieldRow label="Valor aprobado (Q) *"><input className={inputCls} type="number" step="0.01" min="0" value={form.approved_amount} onChange={(e) => set('approved_amount', e.target.value)} /></FieldRow>
          </>
        ) : (
          <FieldRow label="Motivo *"><textarea rows={3} className={inputCls} value={form.note} onChange={(e) => set('note', e.target.value)} /></FieldRow>
        )}
        <FileInput label="Captura del movimiento bancario" required={result === 'aprobado'} onFiles={(f) => setFile(f[0] ?? null)} />
        <Errors error={error} />
        <p className="text-xs text-greige">Si ya hay otro pago con la misma referencia, el sistema lo rechaza al cargarlo. Aprobar sin captura del banco no es posible.</p>
      </div>
    </Modal>
  );
}
