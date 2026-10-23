import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Clock, AlertTriangle, X, FileText, Film, UploadCloud, Wallet, ShieldCheck, ClipboardCheck, Send, Warehouse, Receipt, PackageCheck, Truck, MapPinned, PartyPopper, Download, ExternalLink,
} from 'lucide-react';
import { logisticsFileUrl } from '../api.js';

// Sistema visual compartido del módulo de logística: tokens de estado, etapas del proceso, paneles, formularios y visor de comprobantes.
export const q = (n) => (n == null ? '—' : `Q ${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const fmtDT = (d) => (d ? new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('es-GT', { timeZone: 'America/Guatemala', weekday: 'short', day: '2-digit', month: 'short' }) : '—');

export const SOFT = 'bg-black/[0.04] dark:bg-white/[0.06]';
export const inputCls = 'w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-sm text-ink shadow-sm outline-none transition placeholder:text-greige hover:border-greige focus:border-accent focus:ring-4 focus:ring-accent/15 disabled:opacity-60';
export const labelCls = 'mb-1.5 block text-[12px] font-medium text-greige-ink';

// — estados —
const TONES = {
  neutral: { pill: 'bg-black/[0.05] text-greige-ink dark:bg-white/[0.08]', dot: 'bg-greige' },
  warn: { pill: 'bg-warning/15 text-warning', dot: 'bg-warning' },
  danger: { pill: 'bg-danger/10 text-danger', dot: 'bg-danger' },
  accent: { pill: 'bg-accent-soft text-accent', dot: 'bg-accent' },
  success: { pill: 'bg-success/10 text-success', dot: 'bg-success' },
  purple: { pill: 'bg-purple/10 text-purple', dot: 'bg-purple' },
};
export const STATUS_TONE = {
  BORRADOR: 'neutral', EN_AUDITORIA_PAGO: 'warn', OBSERVADA: 'danger', NUEVO_PEDIDO: 'accent', EN_VERIFICACION: 'accent', VERIFICADA: 'accent', TRASLADO_SOLICITADO: 'purple', TRASLADO_AUTORIZADO: 'purple',
  RECIBIDO_BODEGA: 'purple', FALTANTE: 'warn', CONSOLIDADO: 'purple', PAGO_VALIDADO: 'accent', FACTURADO: 'accent', ANTICIPO_VALIDADO: 'accent', EMPACADO: 'warn', SELLADO: 'accent', GUIA_GENERADA: 'accent', LISTO_RECOGER: 'purple',
  DESPACHADO: 'accent', EN_RUTA: 'accent', ENTREGADO: 'success', DEVUELTO: 'danger', CLIENTE_CONTACTADO: 'warn', ACREDITACION_REPORTADA: 'accent', ACREDITACION_VERIFICADA: 'accent', CERRADO: 'success', PAUSADA: 'warn', CANCELADA: 'neutral',
};
export const toneOf = (status) => TONES[STATUS_TONE[status] ?? 'neutral'];

export function StatusBadge({ status, label }) {
  const t = toneOf(status);
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${t.pill}`}><span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />{label ?? status}</span>;
}

export const ModeBadge = ({ mode }) => (
  <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${mode === 'contraentrega' ? 'bg-purple/10 text-purple' : 'bg-accent-soft text-accent'}`}>{mode === 'contraentrega' ? 'Contraentrega' : 'Contado'}</span>
);

// Plazo de entrega (días hábiles) y tiempo en el estado actual.
export function SlaChip({ sla, status, compact = false }) {
  if (!sla || ['CERRADO', 'CANCELADA', 'BORRADOR'].includes(status)) return null;
  if (sla.overdue || sla.statusOverdue) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger"><AlertTriangle size={10} />{sla.overdue ? 'Plazo vencido' : `+${sla.statusSlaHours} h aquí`}</span>;
  }
  if (!sla.deadlineAt) return null;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${sla.dueSoon ? 'bg-warning/15 text-warning' : `${SOFT} text-greige-ink`}`}><Clock size={10} />{compact ? fmtDay(sla.deadlineAt) : `Entrega antes del ${fmtDay(sla.deadlineAt)}`}</span>;
}

// — etapas del proceso (para la línea de progreso) —
export const STAGES = [
  { key: 'pago', label: 'Pago', icon: Wallet, statuses: ['BORRADOR', 'EN_AUDITORIA_PAGO', 'OBSERVADA'] },
  { key: 'verificacion', label: 'Verificación', icon: ClipboardCheck, statuses: ['NUEVO_PEDIDO', 'EN_VERIFICACION', 'VERIFICADA'] },
  { key: 'traslado', label: 'Traslado', icon: Send, statuses: ['TRASLADO_SOLICITADO', 'TRASLADO_AUTORIZADO'] },
  { key: 'bodega', label: 'Bodega', icon: Warehouse, statuses: ['RECIBIDO_BODEGA', 'FALTANTE', 'CONSOLIDADO'] },
  { key: 'facturacion', label: 'Facturación', icon: Receipt, statuses: ['PAGO_VALIDADO', 'FACTURADO', 'ANTICIPO_VALIDADO'] },
  { key: 'empaque', label: 'Empaque', icon: PackageCheck, statuses: ['EMPACADO', 'SELLADO'] },
  { key: 'despacho', label: 'Despacho', icon: Truck, statuses: ['GUIA_GENERADA', 'LISTO_RECOGER', 'DESPACHADO'] },
  { key: 'ruta', label: 'En ruta', icon: MapPinned, statuses: ['EN_RUTA', 'DEVUELTO', 'CLIENTE_CONTACTADO'] },
  { key: 'entrega', label: 'Entrega', icon: ShieldCheck, statuses: ['ENTREGADO', 'ACREDITACION_REPORTADA', 'ACREDITACION_VERIFICADA'] },
  { key: 'cierre', label: 'Cierre', icon: PartyPopper, statuses: ['CERRADO'] },
];
export const stageIndex = (sheet) => {
  const status = sheet.status === 'PAUSADA' ? sheet.hold_prev_status : sheet.status;
  return STAGES.findIndex((s) => s.statuses.includes(status));
};

// — contenedores —
export function Panel({ title, icon: Icon, right, children, className = '', pad = true }) {
  return (
    <section className={`rounded-2xl border border-line bg-paper shadow-sm ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-3.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">{Icon && <Icon size={16} className="text-accent" />}{title}</h3>
          {right}
        </header>
      )}
      <div className={pad ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function Kpi({ icon: Icon, label, value, hint, tone = 'accent', onClick, active }) {
  const t = TONES[tone];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`group flex items-center gap-3.5 rounded-2xl border bg-paper p-4 text-left shadow-sm transition ${active ? 'border-accent ring-4 ring-accent/10' : 'border-line'} ${onClick ? 'hover:border-greige' : ''}`}>
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${t.pill}`}><Icon size={20} /></span>
      <span className="min-w-0">
        <span className="block text-2xl font-bold leading-none tracking-tight text-ink tabular-nums">{value}</span>
        <span className="mt-1 block text-xs font-medium leading-tight text-greige-ink">{label}</span>
        {hint && <span className="block truncate text-[11px] text-greige">{hint}</span>}
      </span>
    </Tag>
  );
}

export const Skeleton = ({ className = '' }) => <div className={`animate-pulse rounded-xl ${SOFT} ${className}`} />;

export function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-paper-soft px-6 py-14 text-center">
      {Icon && <span className={`mb-3 flex h-12 w-12 items-center justify-center rounded-2xl ${SOFT} text-greige`}><Icon size={22} /></span>}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-greige-ink">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// — botones —
export const PrimaryBtn = ({ className = '', ...p }) => <button type="button" {...p} className={`inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-accent/20 transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 ${className}`} />;
export const GhostBtn = ({ className = '', ...p }) => <button type="button" {...p} className={`inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-paper px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-black/[0.04] disabled:opacity-50 dark:hover:bg-white/[0.08] ${className}`} />;
export const DangerBtn = ({ className = '', ...p }) => <button type="button" {...p} className={`inline-flex items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm font-semibold text-danger transition hover:bg-danger hover:text-white disabled:opacity-50 ${className}`} />;

export function FieldRow({ label, children, className = '', hint }) {
  return <label className={`block ${className}`}><span className={labelCls}>{label}</span>{children}{hint && <span className="mt-1 block text-[11px] text-greige">{hint}</span>}</label>;
}

export const METHOD_LABELS = { transferencia: 'Transferencia', deposito: 'Depósito', consignacion: 'Consignación', tarjeta_link: 'Tarjeta (link)', efectivo: 'Efectivo', otro: 'Otro' };
export const AUDIT_LABELS = { pendiente: 'Por auditar', aprobado: 'Aprobado', observado: 'Observado', rechazado: 'Rechazado' };
export const AUDIT_TONE = { pendiente: 'warn', aprobado: 'success', observado: 'danger', rechazado: 'danger' };
export const AuditPill = ({ status }) => <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONES[AUDIT_TONE[status]].pill}`}><span className={`h-1.5 w-1.5 rounded-full ${TONES[AUDIT_TONE[status]].dot}`} />{AUDIT_LABELS[status]}</span>;

// — ventanas —
// Escape cierra solo la ventana de más arriba (un diálogo sobre el panel no cierra el panel también).
const escStack = [];
function useEscape(onClose, enabled = true) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!enabled) return undefined;
    const token = {};
    escStack.push(token);
    const onKey = (e) => { if (e.key === 'Escape' && escStack[escStack.length - 1] === token) latest.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); escStack.splice(escStack.indexOf(token), 1); };
  }, [enabled]);
}

// Ventana centrada (formularios cortos y confirmaciones de paso).
export function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  useEscape(onClose);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[110] flex items-end justify-center bg-black/45 backdrop-blur-sm sm:items-center sm:px-4" onClick={onClose}>
      <motion.div role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', bounce: 0.1, duration: 0.3 }}
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-line bg-paper shadow-2xl sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}>
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-greige-ink">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-1.5 text-greige hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line-soft bg-paper-soft px-6 py-3.5">{footer}</div>}
      </motion.div>
    </motion.div>
  );
}

// Panel lateral que desliza desde la derecha (detalle de la ficha, asistente).
export function Drawer({ open = true, onClose, width = 'max-w-[780px]', locked = false, children }) {
  useEscape(onClose, open && !locked);
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={locked ? undefined : onClose}>
          <motion.aside role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} initial={{ x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 48, opacity: 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
            className={`flex h-full w-full ${width} flex-col border-l border-line bg-background shadow-2xl`}>
            {children}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// — archivos —
export function Lightbox({ id, mime, filename, onClose }) {
  useEscape(onClose);
  const href = logisticsFileUrl(id);
  const isImg = mime?.startsWith('image/');
  const isVideo = mime?.startsWith('video/');
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[130] flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="truncate text-sm font-medium">{filename ?? 'Archivo'}</span>
        <span className="flex items-center gap-1">
          <a href={href} target="_blank" rel="noreferrer" className="rounded-lg p-2 hover:bg-white/10" aria-label="Abrir en otra pestaña"><ExternalLink size={18} /></a>
          <a href={href} download className="rounded-lg p-2 hover:bg-white/10" aria-label="Descargar"><Download size={18} /></a>
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Cerrar"><X size={20} /></button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        {isImg ? <img src={href} alt={filename ?? 'Comprobante'} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
          : isVideo ? <video src={href} controls className="max-h-full max-w-full rounded-lg" />
            : <iframe title={filename ?? 'Documento'} src={href} className="h-full w-full max-w-4xl rounded-lg bg-white" />}
      </div>
    </motion.div>
  );
}

// Miniatura de un comprobante o evidencia: al tocarla abre el visor.
export function ProofThumb({ id, mime, filename, size = 'h-24 w-24', label }) {
  const [open, setOpen] = useState(false);
  const href = logisticsFileUrl(id);
  const Icon = mime?.startsWith('video/') ? Film : FileText;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={filename ?? label ?? 'Ver archivo'} className={`group relative block shrink-0 overflow-hidden rounded-xl border border-line ${SOFT} ${size}`}>
        {mime?.startsWith('image/')
          ? <img src={href} alt={filename ?? 'Comprobante'} className="h-full w-full object-cover transition group-hover:scale-105" loading="lazy" />
          : <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-[10px] text-greige-ink"><Icon size={22} /><span className="line-clamp-2 break-all">{filename ?? 'Archivo'}</span></span>}
        {label && <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-white">{label}</span>}
      </button>
      <AnimatePresence>{open && <Lightbox id={id} mime={mime} filename={filename} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

// Zona para soltar o elegir archivos, con vista previa de lo elegido.
export function Dropzone({ label, required, multiple = false, files, onChange, hint }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);
  const [urls, setUrls] = useState([]);
  useEffect(() => {
    const next = files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null));
    setUrls(next);
    return () => next.forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);
  const take = (list) => { const arr = [...list]; if (arr.length) onChange(multiple ? [...files, ...arr] : [arr[0]]); };
  return (
    <div>
      <span className={labelCls}>{label}{required && <span className="text-danger"> *</span>}</span>
      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        onClick={() => ref.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') ref.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-center transition ${over ? 'border-accent bg-accent-soft' : 'border-line hover:border-greige'}`}>
        <UploadCloud size={22} className="text-accent" />
        <span className="text-sm font-medium text-ink">Arrastra {multiple ? 'archivos' : 'el archivo'} o haz clic para elegir</span>
        <span className="text-[11px] text-greige">{hint ?? 'Imagen, PDF o video (mp4, mov, webm) · hasta 60 MB'}</span>
        <input ref={ref} type="file" multiple={multiple} hidden accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf" onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      </div>
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className={`relative flex items-center gap-2 rounded-xl border border-line py-1.5 pl-1.5 pr-8 ${SOFT}`}>
              {urls[i] ? <img src={urls[i]} alt="" className="h-9 w-9 rounded-lg object-cover" /> : <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-paper text-greige"><FileText size={16} /></span>}
              <span className="max-w-[160px] truncate text-xs text-ink">{f.name}</span>
              <button type="button" aria-label="Quitar archivo" onClick={(e) => { e.stopPropagation(); onChange(files.filter((_, n) => n !== i)); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-greige hover:text-danger"><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Copia un dato (teléfono, dirección) con un clic.
export function CopyText({ text, children }) {
  const [done, setDone] = useState(false);
  if (!text) return <span className="text-greige">—</span>;
  return (
    <button type="button" title="Copiar" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {}); }} className="text-left text-ink hover:text-accent">
      {children ?? text}{done && <span className="ml-1.5 text-[10px] font-semibold text-success">copiado</span>}
    </button>
  );
}
