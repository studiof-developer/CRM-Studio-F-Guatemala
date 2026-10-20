import { useEffect, useState, useCallback, useMemo } from 'react';
import { Plus, Search, RefreshCw, Trash2, Pencil, Copy, BarChart3, Info, Loader2, Image as ImageIcon, Video, FileText, Phone, Link2, MessageSquareReply, ArrowUp, ArrowDown, X, ArrowLeft } from 'lucide-react';
import {
  fetchTemplatesManage, createWhatsappTemplate, updateWhatsappTemplate, deleteWhatsappTemplate, uploadTemplateSample,
  fetchTemplateStats, fetchTemplateStatsDetail, fetchTemplateEvents, fetchWhatsappNumbers,
} from './api.js';
import { useLiveEvent } from './lib/liveEvents.js';
import Select from './components/Select.jsx';
import Badge from './components/Badge.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

// Marketing > Plantillas: administra las plantillas de WhatsApp de Meta sin entrar a Meta — lista con filtros, estado y
// calidad, vista previa, crear / editar / duplicar / eliminar con encabezado, pie y botones, rendimiento en las difusiones
// de este CRM y aviso de los cambios que Meta hace (aprobada, rechazada, pausada…). Las reglas de validación viven en el
// servidor (whatsappTemplates.js); aquí solo se arma el formulario y se muestran sus mensajes.
const STATUS_META = {
  APPROVED: { variant: 'success', label: 'Aprobada' },
  PENDING: { variant: 'warning', label: 'En revisión' },
  REJECTED: { variant: 'danger', label: 'Rechazada' },
  PAUSED: { variant: 'warning', label: 'Pausada' },
  DISABLED: { variant: 'danger', label: 'Deshabilitada' },
  FLAGGED: { variant: 'warning', label: 'Marcada' },
  IN_APPEAL: { variant: 'info', label: 'En apelación' },
  PENDING_DELETION: { variant: 'neutral', label: 'Eliminándose' },
  LIMIT_EXCEEDED: { variant: 'warning', label: 'Límite excedido' },
};
const QUALITY_META = { GREEN: { variant: 'success', label: 'Calidad alta' }, YELLOW: { variant: 'warning', label: 'Calidad media' }, RED: { variant: 'danger', label: 'Calidad baja' } };
const EVENT_LABEL = {
  APPROVED: 'fue aprobada', REJECTED: 'fue rechazada', PENDING: 'está en revisión', PAUSED: 'fue pausada', DISABLED: 'fue deshabilitada', FLAGGED: 'fue marcada',
  REINSTATED: 'fue reactivada', PENDING_DELETION: 'se está eliminando', IN_APPEAL: 'está en apelación', QUALITY_UPDATE: 'cambió de calidad', CATEGORY_UPDATE: 'cambió de categoría',
};
const CATEGORY_LABEL = { MARKETING: 'Marketing', UTILITY: 'Utilidad', AUTHENTICATION: 'Autenticación' };
const NOT_EDITABLE = ['PENDING', 'PENDING_DELETION', 'DELETED'];
const HEADER_OPTIONS = [
  { value: '', label: 'Sin encabezado' }, { value: 'TEXT', label: 'Texto' }, { value: 'IMAGE', label: 'Imagen' }, { value: 'VIDEO', label: 'Video' }, { value: 'DOCUMENT', label: 'Documento (PDF)' },
];
const SAMPLE_ACCEPT = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: 'application/pdf' };
const BUTTON_TYPES = { QUICK_REPLY: { label: 'Respuesta rápida', icon: MessageSquareReply }, URL: { label: 'Enlace', icon: Link2 }, PHONE_NUMBER: { label: 'Llamar', icon: Phone } };

const input = 'w-full rounded-lg border border-line bg-paper px-3.5 py-2.5 text-sm text-ink outline-none transition-colors focus:border-accent';
const paramNumbers = (text) => [...new Set([...String(text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
const maxParam = (text) => Math.max(0, ...paramNumbers(text));
const fill = (text, examples) => String(text ?? '').replace(/\{\{(\d+)\}\}/g, (_, n) => (examples?.[Number(n) - 1] ? examples[Number(n) - 1] : `{{${n}}}`));
const pct = (a, b) => (b ? `${Math.round((a * 100) / b)}%` : '—');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('es-GT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// Vista previa con la forma de un mensaje de WhatsApp.
function Bubble({ header, body, bodyExamples, footer, buttons }) {
  const MediaIcon = { IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText }[header?.format];
  return (
    <div className="w-full max-w-[320px] rounded-2xl rounded-tl-sm bg-[#e7f7d9] p-2.5 text-[13.5px] leading-snug text-[#1b1b1b] shadow-sm dark:bg-[#1f3a2d] dark:text-[#eaf4ec]">
      {header?.format === 'TEXT' && header.text && <p className="mb-1 font-semibold">{fill(header.text, [header.example])}</p>}
      {MediaIcon && <div className="mb-1.5 flex h-28 items-center justify-center rounded-lg bg-black/10 text-black/40 dark:bg-white/10 dark:text-white/50"><MediaIcon size={32} /></div>}
      <p className="whitespace-pre-wrap break-words">{fill(body, bodyExamples) || <span className="opacity-50">El mensaje aparecerá aquí…</span>}</p>
      {footer && <p className="mt-1.5 text-[11.5px] opacity-60">{footer}</p>}
      {buttons?.length > 0 && (
        <div className="mt-2 grid gap-1">
          {buttons.map((b, i) => {
            const Icon = BUTTON_TYPES[b.type]?.icon ?? MessageSquareReply;
            return <div key={i} className="flex items-center justify-center gap-1.5 rounded-lg bg-white/80 py-1.5 text-[13px] font-medium text-[#0a7cff] dark:bg-black/25 dark:text-[#6cb4ff]"><Icon size={13} />{b.text || 'Botón'}</div>;
          })}
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM = { name: '', language: 'es', category: 'MARKETING', header: { format: '', text: '', example: '', handle: '', fileName: '' }, body: '', examples: [], footer: '', buttons: [] };

function formFromTemplate(t, { copy = false } = {}) {
  const h = t.header;
  return {
    name: copy ? `${t.name}_copia` : t.name, language: t.language, category: t.category === 'AUTHENTICATION' ? 'UTILITY' : t.category,
    header: h ? { format: h.format, text: h.text ?? '', example: h.format === 'TEXT' ? (h.example ?? '') : '', handle: h.format === 'TEXT' ? '' : (h.example ?? ''), fileName: h.format === 'TEXT' ? '' : 'archivo de ejemplo actual' } : EMPTY_FORM.header,
    body: t.body, examples: [...(t.bodyExamples ?? [])], footer: t.footer ?? '',
    buttons: t.buttons.map((b) => ({ type: b.type, text: b.text, url: b.url ?? '', phone: b.phone ?? '' })),
  };
}

function specFromForm(f) {
  const n = maxParam(f.body);
  const h = f.header;
  return {
    name: f.name, language: f.language, category: f.category,
    header: !h.format ? null : h.format === 'TEXT' ? { format: 'TEXT', text: h.text, example: h.example } : { format: h.format, handle: h.handle },
    body: { text: f.body, examples: Array.from({ length: n }, (_, i) => f.examples[i] ?? '') },
    footer: f.footer,
    buttons: f.buttons.map((b) => (b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url } : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone: b.phone } : { type: 'QUICK_REPLY', text: b.text })),
  };
}

function TemplateForm({ initial, editing, lineId, languages, categories, onCancel, onSaved }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setHeader = (patch) => setForm((f) => ({ ...f, header: { ...f.header, ...patch } }));
  const bodyParams = maxParam(form.body);
  const headerHasVar = form.header.format === 'TEXT' && /\{\{1\}\}/.test(form.header.text);
  const lockCategory = editing && editing.status === 'APPROVED';

  async function handleSample(file) {
    if (!file) return;
    setUploading(true); setError(null);
    try {
      const { handle } = await uploadTemplateSample(file, lineId);
      setHeader({ handle, fileName: file.name });
    } catch (err) { setError(err.message); } finally { setUploading(false); }
  }
  const setButton = (i, patch) => set({ buttons: form.buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const moveButton = (i, d) => { const a = [...form.buttons]; [a[i], a[i + d]] = [a[i + d], a[i]]; set({ buttons: a }); };

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const spec = { ...specFromForm(form), lineId };
      if (editing) await updateWhatsappTemplate(editing.id, { ...spec, ...(lockCategory ? { category: undefined } : {}) });
      else await createWhatsappTemplate(spec);
      showSuccess(editing ? 'Cambios enviados a revisión de Meta' : 'Plantilla enviada a revisión de Meta');
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  const previewHeader = form.header.format ? { format: form.header.format, text: form.header.text, example: form.header.example } : null;
  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid gap-5 rounded-2xl border border-line bg-paper p-5 md:p-7">
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={onCancel} className="inline-flex items-center gap-1.5 text-sm font-medium text-greige-ink hover:text-ink"><ArrowLeft size={15} /> Volver a la lista</button>
          <h2 className="text-lg font-semibold text-ink">{editing ? `Editar "${editing.name}"` : 'Nueva plantilla'}</h2>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-line-soft bg-black/[0.02] p-3 text-xs text-greige-ink dark:bg-white/[0.03]">
          <Info size={14} className="mt-0.5 shrink-0 text-accent" />
          <span>Toda plantilla nueva o editada pasa por la revisión de Meta (minutos a ~1 día). Una plantilla aprobada se puede editar 1 vez al día y hasta 10 al mes, y no cambia de categoría. El CRM avisa aquí mismo cuando Meta responde.</span>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="md:col-span-1">
            <label className="mb-1.5 block text-sm font-medium text-ink">Nombre</label>
            <input value={form.name} disabled={!!editing} required placeholder="promo_octubre" className={`${input} disabled:opacity-60`}
              onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
            <p className="mt-1 text-xs text-greige">Minúsculas, números y guion bajo.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Categoría</label>
            <Select value={form.category} onChange={(category) => set({ category })} disabled={lockCategory} options={categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Idioma</label>
            <Select value={form.language} onChange={(language) => set({ language })} disabled={!!editing} options={languages} />
          </div>
        </div>

        <div className="grid gap-3 rounded-xl border border-line p-4">
          <label className="text-sm font-medium text-ink">Encabezado <span className="font-normal text-greige">(opcional)</span></label>
          <Select value={form.header.format} onChange={(format) => setHeader({ format, handle: '', fileName: '' })} options={HEADER_OPTIONS} className="max-w-xs" />
          {form.header.format === 'TEXT' && (
            <div className="grid gap-2">
              <input value={form.header.text} maxLength={60} placeholder="Ej. Nueva colección {{1}}" className={input} onChange={(e) => setHeader({ text: e.target.value })} />
              {headerHasVar && <input value={form.header.example} placeholder="Ejemplo para {{1}}" className={input} onChange={(e) => setHeader({ example: e.target.value })} />}
              <p className="text-xs text-greige">Hasta 60 caracteres y una sola variable ({'{{1}}'}).</p>
            </div>
          )}
          {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(form.header.format) && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
                {uploading ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                {uploading ? 'Subiendo…' : form.header.handle ? 'Cambiar archivo de ejemplo' : 'Subir archivo de ejemplo'}
                <input type="file" accept={SAMPLE_ACCEPT[form.header.format]} className="hidden" onChange={(e) => handleSample(e.target.files?.[0])} />
              </label>
              {form.header.fileName && <span className="truncate text-xs text-greige-ink">{form.header.fileName}</span>}
              <p className="w-full text-xs text-greige">Meta pide un archivo de ejemplo para revisar la plantilla. Al enviar la difusión se sube el archivo real.</p>
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium text-ink">Mensaje</label>
            <button type="button" onClick={() => setForm((f) => ({ ...f, body: `${f.body}{{${maxParam(f.body) + 1}}}` }))} className="text-xs font-semibold text-accent hover:underline">+ Variable {`{{${bodyParams + 1}}}`}</button>
          </div>
          <textarea value={form.body} onChange={(e) => set({ body: e.target.value })} required rows={6} maxLength={1024} placeholder="Hola {{1}}, tenemos nueva colección…" className={`${input} resize-y`} />
          <p className="mt-1 text-xs text-greige"><code>{'{{1}}'}</code> es siempre el nombre del cliente; <code>{'{{2}}'}</code>, <code>{'{{3}}'}</code>… son valores por cliente (ej. un número de guía) que se piden al armar la difusión. {form.body.length}/1024.</p>
          {bodyParams > 0 && (
            <div className="mt-3 grid gap-2">
              <p className="text-xs font-medium text-ink">Meta pide un ejemplo por variable:</p>
              {Array.from({ length: bodyParams }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-xs font-medium text-greige-ink">{`{{${i + 1}}}`}</span>
                  <input value={form.examples[i] ?? ''} required placeholder={i === 0 ? 'María' : 'GUIA-00123'} className={input}
                    onChange={(e) => { const ex = [...form.examples]; ex[i] = e.target.value; set({ examples: ex }); }} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink">Pie de página <span className="font-normal text-greige">(opcional)</span></label>
          <input value={form.footer} maxLength={60} placeholder="Studio F · Guatemala" className={input} onChange={(e) => set({ footer: e.target.value })} />
        </div>

        <div className="grid gap-3 rounded-xl border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm font-medium text-ink">Botones <span className="font-normal text-greige">(hasta 10; 2 de enlace y 1 de llamada)</span></label>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(BUTTON_TYPES).map(([type, { label, icon: Icon }]) => (
                <button key={type} type="button" disabled={form.buttons.length >= 10} onClick={() => setForm((f) => ({ ...f, buttons: [...f.buttons, { type, text: '', url: '', phone: '' }] }))}
                  className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.05]"><Icon size={12} /> {label}</button>
              ))}
            </div>
          </div>
          {form.buttons.map((b, i) => (
            <div key={i} className="grid gap-2 rounded-lg bg-black/[0.02] p-3 dark:bg-white/[0.03] md:grid-cols-[130px_1fr_auto]">
              <span className="self-center text-xs font-semibold text-greige-ink">{BUTTON_TYPES[b.type].label}</span>
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={b.text} maxLength={25} placeholder="Texto del botón" required className={input} onChange={(e) => setButton(i, { text: e.target.value })} />
                {b.type === 'URL' && <input value={b.url} placeholder="https://studiof.gt/catalogo" required className={input} onChange={(e) => setButton(i, { url: e.target.value })} />}
                {b.type === 'PHONE_NUMBER' && <input value={b.phone} placeholder="+50255551234" required className={input} onChange={(e) => setButton(i, { phone: e.target.value })} />}
              </div>
              <div className="flex items-center gap-1">
                <button type="button" disabled={i === 0} onClick={() => moveButton(i, -1)} aria-label="Subir" className="rounded p-1.5 text-greige hover:text-ink disabled:opacity-30"><ArrowUp size={14} /></button>
                <button type="button" disabled={i === form.buttons.length - 1} onClick={() => moveButton(i, 1)} aria-label="Bajar" className="rounded p-1.5 text-greige hover:text-ink disabled:opacity-30"><ArrowDown size={14} /></button>
                <button type="button" onClick={() => set({ buttons: form.buttons.filter((_, j) => j !== i) })} aria-label="Quitar botón" className="rounded p-1.5 text-danger hover:bg-danger/10"><X size={14} /></button>
              </div>
            </div>
          ))}
          {form.buttons.length > 0 && <p className="text-xs text-greige">Las respuestas rápidas van juntas, antes o después de los demás botones. Las direcciones con variable aún no se pueden enviar desde el CRM.</p>}
        </div>

        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={saving || uploading} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
            {saving && <Loader2 size={14} className="animate-spin" />} {editing ? 'Guardar y enviar a revisión' : 'Enviar a revisión'}
          </button>
          <button type="button" onClick={onCancel} className="rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">Cancelar</button>
        </div>
      </div>

      <aside className="h-fit rounded-2xl border border-line bg-paper p-5 lg:sticky lg:top-4">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-greige">Vista previa</p>
        <Bubble header={previewHeader} body={form.body} bodyExamples={form.examples} footer={form.footer} buttons={form.buttons} />
      </aside>
    </form>
  );
}

export default function Templates() {
  const [lines, setLines] = useState([]);
  const [lineId, setLineId] = useState('');
  const [data, setData] = useState({ templates: [], languages: [], categories: ['MARKETING', 'UTILITY'] });
  const [stats, setStats] = useState({});
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ q: '', status: '', category: '', language: '', quality: '' });
  const [limit, setLimit] = useState(40);
  const [editor, setEditor] = useState(null); // { initial, editing }
  const [toDelete, setToDelete] = useState(null);
  const [deleteScope, setDeleteScope] = useState('one');
  const [deleting, setDeleting] = useState(false);
  const [detail, setDetail] = useState(null); // { name, stats | null }
  const [showAllEvents, setShowAllEvents] = useState(false);

  useEffect(() => {
    fetchWhatsappNumbers().then((wns) => { setLines(wns); if (wns.length) setLineId(String(wns[0].id)); }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!lineId) return;
    setLoading(true); setError(null);
    fetchTemplatesManage(Number(lineId)).then(setData).catch((err) => setError(err.message)).finally(() => setLoading(false));
    fetchTemplateStats().then(setStats).catch(() => {});
    fetchTemplateEvents().then(setEvents).catch(() => {});
  }, [lineId]);
  useEffect(() => { load(); }, [load]);

  // Meta avisa por webhook cuando cambia una plantilla: recargar la lista y avisar.
  useLiveEvent('template_changes', useCallback(() => { load(); showSuccess('Meta actualizó una plantilla — revisa la lista'); }, [load]));

  const counts = useMemo(() => {
    const by = (fn) => data.templates.filter(fn).length;
    return { all: data.templates.length, ok: by((t) => t.status === 'APPROVED'), review: by((t) => t.status === 'PENDING'), rejected: by((t) => t.status === 'REJECTED'), paused: by((t) => ['PAUSED', 'DISABLED', 'FLAGGED'].includes(t.status)) };
  }, [data.templates]);

  const list = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return data.templates.filter((t) => (!filters.status || t.status === filters.status) && (!filters.category || t.category === filters.category)
      && (!filters.language || t.language === filters.language) && (!filters.quality || t.quality === filters.quality)
      && (!q || `${t.name} ${t.body}`.toLowerCase().includes(q)));
  }, [data.templates, filters]);

  async function confirmDelete() {
    setDeleting(true);
    try {
      const t = toDelete;
      await deleteWhatsappTemplate(t.name, Number(lineId), deleteScope === 'one' ? { hsmId: t.id, language: t.language } : {});
      showSuccess('Plantilla eliminada');
      setToDelete(null); load();
    } catch (err) { showError(err.message); } finally { setDeleting(false); }
  }

  async function openDetail(t) {
    setDetail({ name: t.name, stats: null });
    try { setDetail({ name: t.name, stats: await fetchTemplateStatsDetail(t.name) }); } catch (err) { setDetail(null); showError(err.message); }
  }

  if (editor) {
    return <TemplateForm initial={editor.initial} editing={editor.editing} lineId={Number(lineId)} languages={data.languages} categories={data.categories}
      onCancel={() => setEditor(null)} onSaved={() => { setEditor(null); load(); }} />;
  }

  const siblings = toDelete ? data.templates.filter((t) => t.name === toDelete.name) : [];
  const set = (patch) => { setFilters({ ...filters, ...patch }); setLimit(40); };
  const sel = (key, all, options) => <Select value={filters[key]} onChange={(v) => set({ [key]: v })} options={[{ value: '', label: all }, ...options]} className="w-44" />;
  const recent = showAllEvents ? events : events.slice(0, 4);

  return (
    <div className="grid gap-5">
      <section className="rounded-2xl border border-line bg-paper p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-greige-ink">Línea de WhatsApp:</label>
            {lines.length > 0 && <Select value={lineId} onChange={setLineId} options={lines.map((l) => ({ value: String(l.id), label: l.label || `Línea ${l.id}` }))} className="w-48" />}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={load} className="flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 text-xs font-medium text-greige-ink hover:text-ink"><RefreshCw size={12} /> Actualizar</button>
            <button type="button" onClick={() => setEditor({ initial: EMPTY_FORM, editing: null })} className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"><Plus size={14} /> Nueva plantilla</button>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-5">
          {[['Total', counts.all, ''], ['Aprobadas', counts.ok, 'APPROVED'], ['En revisión', counts.review, 'PENDING'], ['Rechazadas', counts.rejected, 'REJECTED'], ['Pausadas o deshabilitadas', counts.paused, 'PAUSED']].map(([label, n, st]) => (
            <button key={label} type="button" onClick={() => set({ status: filters.status === st ? '' : st })} aria-pressed={filters.status === st && st !== ''}
              className={`rounded-xl border p-3 text-left transition ${filters.status === st && st ? 'border-accent bg-accent text-white' : 'border-line hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'}`}>
              <div className="text-xl font-bold">{n}</div><div className="text-[11px] font-semibold opacity-80">{label}</div>
            </button>
          ))}
        </div>

        {events.length > 0 && (
          <div className="mb-4 rounded-xl border border-line bg-black/[0.02] p-3 dark:bg-white/[0.03]">
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-greige">Cambios recientes de Meta</p>
            <ul className="grid gap-1 text-sm">
              {recent.map((e) => (
                <li key={e.id} className="text-ink"><span className="text-xs text-greige">{fmtDate(e.at)} · </span><strong>{e.name}</strong> ({e.language}) {EVENT_LABEL[e.event] ?? e.event}{e.detail ? <span className="text-greige-ink"> — {e.detail}</span> : null}</li>
              ))}
            </ul>
            {events.length > 4 && <button type="button" onClick={() => setShowAllEvents(!showAllEvents)} className="mt-1.5 text-xs font-semibold text-accent hover:underline">{showAllEvents ? 'Ver menos' : `Ver los ${events.length} últimos`}</button>}
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-greige" />
            <input value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Buscar por nombre o texto…" className={`${input} pl-9`} />
          </div>
          {sel('category', 'Todas las categorías', data.categories.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c })))}
          {sel('language', 'Todos los idiomas', data.languages)}
          {sel('quality', 'Toda calidad', [{ value: 'GREEN', label: 'Alta' }, { value: 'YELLOW', label: 'Media' }, { value: 'RED', label: 'Baja' }])}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        {loading && <p className="py-8 text-center text-sm text-greige-ink">Cargando plantillas de Meta…</p>}
        {!loading && !error && !list.length && <p className="py-8 text-center text-sm text-greige-ink">{data.templates.length ? 'Ninguna plantilla coincide con el filtro.' : 'Sin plantillas todavía en esta línea.'}</p>}

        <div className="grid gap-3 xl:grid-cols-2">
          {list.slice(0, limit).map((t) => {
            const st = STATUS_META[t.status] ?? { variant: 'neutral', label: t.status };
            const q = QUALITY_META[t.quality];
            const s = stats[t.name];
            return (
              <article key={`${t.name}__${t.language}`} className="grid gap-3 rounded-xl border border-line p-4 md:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink"><span className="truncate">{t.name}</span><Badge variant={st.variant}>{st.label}</Badge>{q && <Badge variant={q.variant}>{q.label}</Badge>}</p>
                  <p className="mt-1 text-xs text-greige">{CATEGORY_LABEL[t.category] ?? t.category} · {data.languages.find((l) => l.value === t.language)?.label ?? t.language}
                    {t.correctCategory && t.correctCategory !== t.category ? ` · Meta sugiere ${CATEGORY_LABEL[t.correctCategory] ?? t.correctCategory}` : ''}</p>
                  {t.status === 'REJECTED' && t.rejectedReason && <p className="mt-1.5 text-xs text-danger">Motivo de Meta: {t.rejectedReason}</p>}
                  {s && s.sent > 0 && <p className="mt-2 text-xs text-greige-ink">Enviada {s.sent} · entregada {pct(s.delivered, s.sent)} · leída {pct(s.read, s.sent)} · {s.campaigns} difusión{s.campaigns === 1 ? '' : 'es'}</p>}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <button type="button" disabled={NOT_EDITABLE.includes(t.status)} title={NOT_EDITABLE.includes(t.status) ? 'Espera a que Meta termine la revisión' : undefined}
                      onClick={() => setEditor({ initial: formFromTemplate(t), editing: t })} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-black/[0.03] disabled:opacity-40 dark:hover:bg-white/[0.05]"><Pencil size={12} /> Editar</button>
                    <button type="button" onClick={() => setEditor({ initial: formFromTemplate(t, { copy: true }), editing: null })} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"><Copy size={12} /> Duplicar</button>
                    <button type="button" onClick={() => openDetail(t)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"><BarChart3 size={12} /> Rendimiento</button>
                    <button type="button" onClick={() => { setDeleteScope('one'); setToDelete(t); }} className="inline-flex items-center gap-1 rounded-lg border border-danger/30 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"><Trash2 size={12} /> Eliminar</button>
                  </div>
                </div>
                <Bubble header={t.header} body={t.body} bodyExamples={t.bodyExamples} footer={t.footer} buttons={t.buttons} />
              </article>
            );
          })}
        </div>
        {list.length > limit && <button type="button" onClick={() => setLimit(limit + 40)} className="mx-auto mt-4 block text-sm font-semibold text-accent hover:underline">Mostrar más ({list.length - limit})</button>}
      </section>

      <ConfirmDialog
        open={!!toDelete}
        title="Eliminar plantilla"
        message={toDelete ? `"${toDelete.name}" dejará de estar disponible para nuevos envíos; los mensajes ya enviados no se ven afectados. Esta acción no se puede deshacer.` : ''}
        confirmLabel="Eliminar" danger busy={deleting} onConfirm={confirmDelete} onCancel={() => setToDelete(null)}
      >
        {siblings.length > 1 && (
          <div className="grid gap-2 text-sm text-ink">
            <label className="flex items-center gap-2"><input type="radio" checked={deleteScope === 'one'} onChange={() => setDeleteScope('one')} /> Solo el idioma {toDelete.language}</label>
            <label className="flex items-center gap-2"><input type="radio" checked={deleteScope === 'all'} onChange={() => setDeleteScope('all')} /> Todos los idiomas ({siblings.length})</label>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!detail}
        title={detail ? `Rendimiento de "${detail.name}"` : ''}
        message="Lo que esta plantilla ha hecho en las difusiones enviadas desde este CRM."
        confirmLabel="Cerrar" onConfirm={() => setDetail(null)} onCancel={() => setDetail(null)}
      >
        {detail && !detail.stats && <p className="text-sm text-greige-ink">Calculando…</p>}
        {detail?.stats && (detail.stats.sent === 0
          ? <p className="text-sm text-greige-ink">Todavía no se ha enviado en ninguna difusión.</p>
          : (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {[['Difusiones', detail.stats.campaigns], ['Enviados', detail.stats.sent], ['Entregados', `${detail.stats.delivered} (${pct(detail.stats.delivered, detail.stats.sent)})`], ['Leídos', `${detail.stats.read} (${pct(detail.stats.read, detail.stats.sent)})`],
                ['Respondieron en 72 h', `${detail.stats.replied} (${pct(detail.stats.replied, detail.stats.sent)})`], ['Fallidos', detail.stats.failed]].map(([k, v]) => (
                <div key={k}><dt className="text-[11px] font-bold uppercase tracking-wide text-greige">{k}</dt><dd className="text-ink">{v}</dd></div>
              ))}
            </dl>
          ))}
      </ConfirmDialog>
    </div>
  );
}
