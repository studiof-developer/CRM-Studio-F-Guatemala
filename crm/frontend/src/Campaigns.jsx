import { useEffect, useState, useCallback } from 'react';
import { Megaphone, Send, Search, X, Plus, Clock, ArrowDownWideNarrow, Users, Loader2, Image as ImageIcon, RotateCcw, FileText } from 'lucide-react';
import {
  fetchCampaignTemplates, searchCampaignAudience, fetchCampaigns, fetchCampaign, createCampaign,
  uploadCampaignHeaderMedia, retryCampaignFailed,
} from './api.js';
import { TEMP_META, BUCKET_ORDER } from './lib/temperature.js';
import { useLiveEvent } from './lib/liveEvents.js';
import Select from './components/Select.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

// "Todas las temperaturas" would read here the way it does everywhere else in this
// app — "no filter, show everyone" — but in a broadcast that's the opposite of safe:
// it's really "no bulk group selected", so leaving it as-is (with only a manual pick
// added) sends to nobody extra. Named for what it actually does in this one screen,
// since blasting the whole customer base by misreading a label is not a small mistake.
const TEMP_OPTIONS = [
  { value: '', label: 'Sin envío masivo (solo clientes puntuales)' },
  ...BUCKET_ORDER.map((k) => ({ value: k, label: TEMP_META[k].label, icon: TEMP_META[k].icon, iconClassName: TEMP_META[k].iconText })),
];

// Same 7-15 digit rule the backend uses to recognise a phone (see campaigns.js).
const PHONE_RE = /^\d{7,15}$/;

const STATUS_META = {
  sent: { label: 'Enviado', className: 'text-greige-ink' },
  delivered: { label: 'Recibido', className: 'text-ink' },
  read: { label: 'Leído', className: 'text-accent' },
  failed: { label: 'Falló', className: 'text-danger' },
};

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-GT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchCampaigns().then(setCampaigns).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDetail = useCallback(() => {
    if (!openId) { setDetail(null); return; }
    fetchCampaign(openId).then(setDetail).catch((err) => showError(err.message));
  }, [openId]);

  useEffect(() => { loadDetail(); }, [loadDetail]);
  // A retry batch updates recipient rows one at a time in the background — this is what
  // makes each one flip from "Falló" to its real status live instead of needing to
  // reopen the modal.
  useLiveEvent('message_changes', loadDetail);

  const failedCount = detail?.recipients.filter((r) => r.status === 'failed').length ?? 0;

  async function handleRetryFailed() {
    setRetrying(true);
    try {
      const res = await retryCampaignFailed(openId);
      showSuccess(`Reintentando ${res.retrying} envío(s) fallido(s)`);
      load();
    } catch (err) {
      showError(err.message);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="sticky top-0 z-10 bg-paper px-4 pb-4 pt-8 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Difusión</h1>
            <p className="mt-1 text-sm text-greige-ink">Enviar una plantilla aprobada a varios clientes a la vez.</p>
          </div>
          <button
            onClick={() => setNewOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={15} /> Nueva difusión
          </button>
        </div>
      </div>

      <div className="px-4 pb-8 md:px-8">
        {error && <p className="mb-4 text-sm text-danger">{error}</p>}
        {loading && <p className="text-sm text-greige-ink">Cargando…</p>}
        {!loading && campaigns.length === 0 && (
          <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-greige-ink">
            Todavía no se ha enviado ninguna difusión.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {campaigns.map((c) => (
            <button
              key={c.id}
              onClick={() => setOpenId(c.id)}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-paper p-4 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                    <Megaphone size={13} />
                  </span>
                  <p className="truncate text-sm font-semibold text-ink">{c.templateName}</p>
                  {c.status === 'sending' && (
                    <span className="flex items-center gap-1 text-xs font-medium text-warn"><Loader2 size={11} className="animate-spin" /> enviando</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-greige-ink">
                  {c.temperature ? TEMP_META[c.temperature]?.label : 'Sin filtro de temperatura'} · {c.recipientCount} destinatarios · {formatDateTime(c.createdAt)} · {c.createdBy}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <span className="text-ink">{c.sentCount} enviados</span>
                <span className="text-accent">{c.readCount} leídos</span>
                {c.failedCount > 0 && <span className="text-danger">{c.failedCount} fallidos</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4" onClick={() => setOpenId(null)}>
          <div
            className="glass-card max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink" title={detail.templateName}>{detail.templateName}</h3>
                <p className="mt-0.5 text-xs text-greige-ink">{detail.recipientCount} destinatarios · {formatDateTime(detail.createdAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {failedCount > 0 && (
                  <button
                    onClick={handleRetryFailed}
                    disabled={retrying}
                    className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                  >
                    {retrying ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                    Reintentar {failedCount} fallido{failedCount === 1 ? '' : 's'}
                  </button>
                )}
                <button onClick={() => setOpenId(null)} className="text-greige hover:text-ink"><X size={16} /></button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {detail.recipients.map((r, i) => {
                const meta = STATUS_META[r.status] ?? STATUS_META.sent;
                return (
                  <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2 text-sm">
                    <span className="truncate text-ink">{r.customerName || r.phone}</span>
                    <span className={`shrink-0 text-xs font-medium ${meta.className}`} title={r.statusError || ''}>{meta.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {newOpen && (
        <NewCampaignModal
          onClose={() => setNewOpen(false)}
          onSent={() => { setNewOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function NewCampaignModal({ onClose, onSent }) {
  const [templates, setTemplates] = useState(null);
  const [templatesError, setTemplatesError] = useState(null);
  const [templateKey, setTemplateKey] = useState('');
  const [temperature, setTemperature] = useState('');
  const [order, setOrder] = useState('recent');
  const [count, setCount] = useState(50);
  const [audienceCount, setAudienceCount] = useState(null);
  const [manualQuery, setManualQuery] = useState('');
  const [manualResults, setManualResults] = useState([]);
  const [manualPicked, setManualPicked] = useState([]);
  const [newRecipientName, setNewRecipientName] = useState('');
  const [headerMediaId, setHeaderMediaId] = useState(null);
  const [headerImageToken, setHeaderImageToken] = useState(null);
  const [headerPreviewUrl, setHeaderPreviewUrl] = useState(null);
  const [headerFilename, setHeaderFilename] = useState(null);
  const [headerUploading, setHeaderUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchCampaignTemplates().then(setTemplates).catch((err) => setTemplatesError(err.message));
  }, []);

  useEffect(() => {
    if (!temperature) { setAudienceCount(null); return; }
    let cancelled = false;
    searchCampaignAudience(temperature).then((rows) => { if (!cancelled) setAudienceCount(rows.length); }).catch(() => {});
    return () => { cancelled = true; };
  }, [temperature]);

  useEffect(() => {
    if (!manualQuery.trim()) { setManualResults([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      searchCampaignAudience('', manualQuery.trim()).then((rows) => { if (!cancelled) setManualResults(rows); }).catch(() => {});
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [manualQuery]);

  const template = templates?.find((t) => `${t.name}__${t.language}` === templateKey);
  const pickedIds = new Set(manualPicked.map((p) => p.id));
  const SUPPORTED_HEADER_FORMATS = ['IMAGE', 'DOCUMENT'];
  const headerUnsupported = template?.headerFormat && !SUPPORTED_HEADER_FORMATS.includes(template.headerFormat);
  const headerIsDocument = template?.headerFormat === 'DOCUMENT';
  const headerNeedsMedia = template?.headerFormat === 'IMAGE' || headerIsDocument;

  function selectTemplate(key) {
    setTemplateKey(key);
    setHeaderMediaId(null);
    setHeaderImageToken(null);
    setHeaderPreviewUrl(null);
    setHeaderFilename(null);
  }

  async function handleHeaderFile(file) {
    if (!file) return;
    setHeaderFilename(file.name);
    // A document doesn't get a thumbnail preview — just its filename (below) — so
    // there's no point creating a throwaway blob URL for it.
    if (!headerIsDocument) setHeaderPreviewUrl(URL.createObjectURL(file));
    setHeaderUploading(true);
    try {
      const { mediaId, headerImageToken: token } = await uploadCampaignHeaderMedia(file);
      setHeaderMediaId(mediaId);
      setHeaderImageToken(token);
    } catch (err) {
      showError(err.message);
      setHeaderPreviewUrl(null);
      setHeaderFilename(null);
    } finally {
      setHeaderUploading(false);
    }
  }

  function addManual(customer) {
    if (pickedIds.has(customer.id)) return;
    setManualPicked((prev) => [...prev, customer]);
    setManualQuery('');
    setManualResults([]);
  }

  // A number nobody has talked to yet — same 7-15 digit rule the backend already uses
  // to recognise a phone. Kept separate from addManual: this one doesn't exist as a
  // customer, so it's added with a synthetic id and created for real only on send.
  const trimmedQuery = manualQuery.trim();
  const queryIsPhone = PHONE_RE.test(trimmedQuery);
  const queryAlreadyPicked = pickedIds.has(`new:${trimmedQuery}`) || manualResults.some((r) => r.phone === trimmedQuery);

  // Pasting a whole column copied from Excel — one number per line (sometimes with a
  // trailing comma/semicolon if it came out of a CSV instead). A single-value paste
  // still goes through the normal input so the existing search-as-you-type flow isn't
  // disturbed; this only takes over once there's clearly more than one number involved.
  // No existence check against current customers here — createCampaign's newRecipients
  // already upserts by phone (see backend), so an already-known number just resolves to
  // its real customer server-side, same as if it had been found and clicked here.
  function handleManualPaste(e) {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    const lines = text.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length < 2) return; // let the browser's default single-value paste happen

    e.preventDefault();
    const known = new Set(manualPicked.map((p) => p.phone));
    const toAdd = [];
    let duplicates = 0;
    const invalid = [];
    for (const raw of lines) {
      const digits = raw.replace(/\D/g, '');
      // A bare 8-digit number is the local Guatemala convention (no country code) — every
      // number in this app otherwise carries the 502 prefix, so that's what WhatsApp needs.
      const phone = digits.length === 8 ? `502${digits}` : digits;
      if (!PHONE_RE.test(phone)) { invalid.push(raw); continue; }
      if (known.has(phone)) { duplicates++; continue; }
      known.add(phone);
      toAdd.push({ id: `new:${phone}`, phone, fullName: null, isNew: true });
    }
    if (toAdd.length) setManualPicked((prev) => [...prev, ...toAdd]);
    setManualQuery('');
    setManualResults([]);
    const parts = [];
    if (toAdd.length) parts.push(`${toAdd.length} número(s) agregado(s)`);
    if (duplicates) parts.push(`${duplicates} ya estaba(n) en la lista`);
    if (invalid.length) parts.push(`${invalid.length} no se reconoció(eron): ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}`);
    if (invalid.length) showError(parts.join(' · '));
    else if (toAdd.length) showSuccess(parts.join(' · '));
  }

  function addNewPhone(phone, fullName) {
    setManualPicked((prev) => [...prev, { id: `new:${phone}`, phone, fullName: fullName.trim() || null, isNew: true }]);
    setManualQuery('');
    setNewRecipientName('');
    setManualResults([]);
  }

  const totalRecipients = (temperature ? Math.min(count, audienceCount ?? count) : 0) + manualPicked.length;
  const canSend = !!template && !headerUnsupported && (!headerNeedsMedia || (headerMediaId && !headerUploading))
    && (temperature || manualPicked.length > 0) && totalRecipients > 0;

  async function handleSend() {
    setBusy(true);
    try {
      const res = await createCampaign({
        templateName: template.name,
        templateLanguage: template.language,
        temperature: temperature || undefined,
        count: temperature ? count : undefined,
        order,
        customerIds: manualPicked.filter((p) => !p.isNew).map((p) => p.id),
        newRecipients: manualPicked.filter((p) => p.isNew).map((p) => ({ phone: p.phone, fullName: p.fullName })),
        headerMediaId: headerMediaId || undefined,
        headerImageToken: headerImageToken || undefined,
      });
      showSuccess(`Difusión en marcha — ${res.recipientCount} destinatarios`);
      if (res.skippedCooldown?.length) {
        showError(
          `${res.skippedCooldown.length} número(s) omitido(s) por cooldown de 42h: ` +
          res.skippedCooldown.map((s) => s.fullName || s.phone).join(', ')
        );
      }
      onSent();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4" onClick={onClose}>
      <div
        className="glass-card max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">Nueva difusión</h3>
          <button onClick={onClose} className="text-greige hover:text-ink"><X size={16} /></button>
        </div>

        <div className="flex flex-col gap-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-greige-ink">Plantilla de Meta</label>
            {templatesError && <p className="text-xs text-danger">{templatesError}</p>}
            {!templatesError && !templates && <p className="text-xs text-greige-ink">Cargando plantillas de WhatsApp Manager…</p>}
            {templates && templates.length === 0 && <p className="text-xs text-greige-ink">No hay plantillas activas en este momento.</p>}
            {templates && templates.length > 0 && (
              <Select
                value={templateKey}
                onChange={selectTemplate}
                placeholder="Elegir plantilla…"
                options={templates.map((t) => ({ value: `${t.name}__${t.language}`, label: t.name, meta: t.category }))}
              />
            )}
            {template && (
              <p className="mt-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-xs leading-relaxed text-greige-ink">
                {template.body}
              </p>
            )}
            {headerUnsupported && (
              <p className="mt-2 text-xs font-medium text-danger">
                Esta plantilla tiene un encabezado de tipo {template.headerFormat} — todavía no está soportado, solo imágenes y documentos.
              </p>
            )}
            {headerNeedsMedia && (
              <div className="mt-2">
                <label className="mb-1 block text-xs font-medium text-greige-ink">
                  {headerIsDocument ? 'Documento del encabezado (obligatorio)' : 'Imagen del encabezado (obligatoria)'}
                </label>
                <div className="flex items-center gap-3">
                  {headerIsDocument ? (
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-greige">
                      <FileText size={18} />
                    </span>
                  ) : headerPreviewUrl ? (
                    <img src={headerPreviewUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-greige">
                      <ImageIcon size={18} />
                    </span>
                  )}
                  <div className="flex flex-col gap-1">
                    <label className="flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
                      {headerUploading ? <Loader2 size={13} className="animate-spin" /> : headerIsDocument ? <FileText size={13} /> : <ImageIcon size={13} />}
                      {headerUploading
                        ? 'Subiendo…'
                        : headerMediaId
                          ? (headerIsDocument ? 'Cambiar documento' : 'Cambiar imagen')
                          : (headerIsDocument ? 'Subir documento (PDF)' : 'Subir imagen')}
                      <input
                        type="file"
                        accept={headerIsDocument ? '.pdf,application/pdf' : 'image/*'}
                        className="hidden"
                        onChange={(e) => handleHeaderFile(e.target.files?.[0])}
                      />
                    </label>
                    {headerIsDocument && headerFilename && (
                      <span className="truncate text-[11px] text-greige-ink">{headerFilename}</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-greige-ink">Audiencia masiva por temperatura</label>
            <Select value={temperature} onChange={setTemperature} options={TEMP_OPTIONS} />
            {temperature && (
              <div className="mt-2.5 flex items-center gap-2.5">
                <input
                  type="number"
                  min={1}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
                  className="w-24 rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
                />
                <span className="text-xs text-greige-ink">
                  de {audienceCount ?? '…'} disponibles con esa temperatura
                </span>
              </div>
            )}
            {temperature && (
              <div className="mt-2 inline-flex rounded-lg border border-line p-0.5 text-xs">
                <button
                  onClick={() => setOrder('recent')}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 font-medium transition-colors ${order === 'recent' ? 'bg-accent text-white' : 'text-greige-ink hover:text-ink'}`}
                >
                  <ArrowDownWideNarrow size={12} /> Más recientes primero
                </button>
                <button
                  onClick={() => setOrder('oldest')}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 font-medium transition-colors ${order === 'oldest' ? 'bg-accent text-white' : 'text-greige-ink hover:text-ink'}`}
                >
                  <Clock size={12} /> Más antiguos primero
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-greige-ink">
              Agregar clientes puntuales (por nombre o teléfono) — o pega una columna de números copiada de Excel
            </label>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-greige" />
              <input
                value={manualQuery}
                onChange={(e) => setManualQuery(e.target.value)}
                onPaste={handleManualPaste}
                placeholder="ej. 50255529660, Erika, o pega una columna de números"
                className="w-full rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] py-2 pl-9 pr-3 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
              />
            </div>
            {manualResults.length > 0 && (
              <div className="mt-1.5 flex flex-col gap-1 rounded-lg border border-line bg-paper p-1.5 shadow-sm">
                {manualResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => addManual(c)}
                    disabled={pickedIds.has(c.id) || !!c.cooldownUntil}
                    title={c.cooldownUntil ? `Ya recibió una difusión — disponible de nuevo el ${formatDateTime(c.cooldownUntil)}` : undefined}
                    className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-40"
                  >
                    <span className="truncate text-ink">{c.fullName || c.phone}</span>
                    {c.cooldownUntil ? (
                      <span className="shrink-0 text-xs font-medium text-amber-600">En cooldown</span>
                    ) : (
                      <span className="shrink-0 text-xs text-greige-ink">{c.phone}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {/* No customer with this number exists yet — offer to add it fresh instead
                of only ever searching who's already in the system. */}
            {queryIsPhone && !queryAlreadyPicked && (
              <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-dashed border-line p-2">
                <input
                  value={newRecipientName}
                  onChange={(e) => setNewRecipientName(e.target.value)}
                  placeholder="Nombre (opcional)"
                  className="min-w-0 flex-1 rounded-md border border-line bg-black/[0.03] dark:bg-white/[0.05] px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent focus:bg-paper"
                />
                <button
                  onClick={() => addNewPhone(trimmedQuery, newRecipientName)}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2.5 py-1.5 text-xs font-medium text-accent hover:opacity-80"
                >
                  <Plus size={12} /> Agregar {trimmedQuery} como nuevo
                </button>
              </div>
            )}
            {manualPicked.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {manualPicked.map((c) => (
                  <span key={c.id} className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
                    {c.fullName || c.phone}
                    <button onClick={() => setManualPicked((prev) => prev.filter((p) => p.id !== c.id))} className="hover:opacity-70">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Users size={14} className="text-greige" /> {totalRecipients} destinatario{totalRecipients === 1 ? '' : 's'}
          </p>
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={!canSend}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Send size={14} /> Enviar difusión
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Confirmar difusión"
        message={`Se va a enviar la plantilla "${template?.name}" a ${totalRecipients} clientes. Esto no se puede deshacer y cada mensaje tiene costo real en tu cuenta de Meta.`}
        confirmLabel={busy ? 'Enviando…' : 'Sí, enviar'}
        busy={busy}
        danger
        onConfirm={handleSend}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
