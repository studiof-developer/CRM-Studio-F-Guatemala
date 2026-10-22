import { useEffect } from 'react';
import { Clock, AlertTriangle, X, FileText, Film } from 'lucide-react';
import { logisticsFileUrl } from '../api.js';

// Piezas visuales compartidas del módulo de logística.
export const q = (n) => (n == null ? '—' : `Q ${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const fmtDT = (d) => (d ? new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('es-GT', { timeZone: 'America/Guatemala', weekday: 'short', day: '2-digit', month: 'short' }) : '—');

const TONES = {
  neutral: 'bg-secondary text-greige-ink',
  warn: 'bg-warning/15 text-warning',
  danger: 'bg-danger/10 text-danger',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success/10 text-success',
};
export const STATUS_TONE = {
  BORRADOR: 'neutral', EN_AUDITORIA_PAGO: 'warn', OBSERVADA: 'danger', NUEVO_PEDIDO: 'accent', EN_VERIFICACION: 'accent', VERIFICADA: 'accent', TRASLADO_SOLICITADO: 'accent', TRASLADO_AUTORIZADO: 'accent',
  RECIBIDO_BODEGA: 'accent', FALTANTE: 'warn', CONSOLIDADO: 'accent', PAGO_VALIDADO: 'accent', FACTURADO: 'accent', ANTICIPO_VALIDADO: 'accent', EMPACADO: 'accent', SELLADO: 'accent', GUIA_GENERADA: 'accent',
  DESPACHADO: 'accent', EN_RUTA: 'accent', ENTREGADO: 'success', DEVUELTO: 'danger', CLIENTE_CONTACTADO: 'warn', ACREDITACION_REPORTADA: 'accent', ACREDITACION_VERIFICADA: 'accent', CERRADO: 'success', PAUSADA: 'warn', CANCELADA: 'neutral',
};

export function StatusBadge({ status, label }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONES[STATUS_TONE[status] ?? 'neutral']}`}>{label ?? status}</span>;
}

export const ModeBadge = ({ mode }) => (
  <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${mode === 'contraentrega' ? 'bg-purple/10 text-purple' : 'bg-secondary text-greige-ink'}`}>{mode === 'contraentrega' ? 'Contraentrega' : 'Contado'}</span>
);

// Plazo de entrega (4 días hábiles) y tiempo en el estado actual.
export function SlaChip({ sla, status }) {
  if (!sla || ['CERRADO', 'CANCELADA'].includes(status)) return null;
  if (sla.overdue || sla.statusOverdue) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger"><AlertTriangle size={10} />{sla.overdue ? 'Plazo vencido' : `Más de ${sla.statusSlaHours} h aquí`}</span>;
  }
  if (!sla.deadlineAt) return null;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${sla.dueSoon ? 'bg-warning/15 text-warning' : 'bg-secondary text-greige-ink'}`}><Clock size={10} />Entrega antes del {fmtDay(sla.deadlineAt)}</span>;
}

export const inputCls = 'w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent';
export const labelCls = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-greige-ink';

export const METHOD_LABELS = { transferencia: 'Transferencia', deposito: 'Depósito', consignacion: 'Consignación', tarjeta_link: 'Tarjeta (link)', efectivo: 'Efectivo', otro: 'Otro' };
export const AUDIT_LABELS = { pendiente: 'Pendiente de auditar', aprobado: 'Aprobado', observado: 'Observado', rechazado: 'Rechazado' };
export const AUDIT_TONE = { pendiente: 'warn', aprobado: 'success', observado: 'danger', rechazado: 'danger' };

export function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-xl ${wide ? 'max-w-5xl' : 'max-w-xl'}`}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {subtitle && <div className="mt-1 text-sm text-greige-ink">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-1.5 text-greige hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export const PrimaryBtn = ({ className = '', ...p }) => <button type="button" {...p} className={`rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 ${className}`} />;
export const GhostBtn = ({ className = '', ...p }) => <button type="button" {...p} className={`rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-black/[0.04] disabled:opacity-50 dark:hover:bg-white/[0.08] ${className}`} />;

export function FieldRow({ label, children, className = '' }) {
  return <label className={`block ${className}`}><span className={labelCls}>{label}</span>{children}</label>;
}

// Miniatura de un comprobante o evidencia: imagen que abre completa, o enlace para PDF/video.
export function ProofThumb({ id, mime, filename, size = 'h-24 w-24' }) {
  const href = logisticsFileUrl(id);
  if (mime?.startsWith('image/')) {
    return <a href={href} target="_blank" rel="noreferrer" className={`block shrink-0 overflow-hidden rounded-lg border border-line bg-secondary ${size}`}><img src={href} alt={filename ?? 'Comprobante'} className="h-full w-full object-cover" loading="lazy" /></a>;
  }
  const Icon = mime?.startsWith('video/') ? Film : FileText;
  return <a href={href} target="_blank" rel="noreferrer" className={`flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-line bg-secondary p-2 text-center text-[10px] text-greige-ink hover:text-ink ${size}`}><Icon size={22} /><span className="line-clamp-2 break-all">{filename ?? 'Archivo'}</span></a>;
}
