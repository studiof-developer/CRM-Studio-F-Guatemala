import { useEffect, useState, useCallback } from 'react';
import { Megaphone, Send, Search, X, Plus, Clock, ArrowDownWideNarrow, Users, Loader2, Image as ImageIcon, RotateCcw, FileText, Trash2, Info } from 'lucide-react';
import {
  fetchCampaignTemplates, searchCampaignAudience, fetchCampaigns, fetchCampaign, createCampaign,
  uploadCampaignHeaderMedia, retryCampaignFailed,
  fetchTemplatesManage, createWhatsappTemplate, deleteWhatsappTemplate,
} from './api.js';
import { TEMP_META, BUCKET_ORDER } from './lib/temperature.js';
import { useLiveEvent } from './lib/liveEvents.js';
import Select from './components/Select.jsx';
import Badge from './components/Badge.jsx';
import { Button } from './components/ui.jsx';
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

export default function Campaigns({ user }) {
  const [tab, setTab] = useState('difusion');
  const isAdmin = user?.role === 'admin';

  return (
    <div className="mx-auto max-w-6xl">
      <div className="sticky top-0 z-10 bg-paper px-4 pb-4 pt-8 md:px-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Marketing</h1>
            <p className="mt-1 text-sm text-greige-ink">Difusiones y plantillas de WhatsApp.</p>
          </div>
        </div>

        <div className="inline-flex flex-wrap rounded-xl border border-line bg-black/[0.03] dark:bg-white/[0.05] p-1">
          {[
            { key: 'difusion', label: 'Difusión', icon: Megaphone },
            ...(isAdmin ? [{ key: 'templates', label: 'Plantillas', icon: FileText }] : []),
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${
                tab === key ? 'bg-paper text-ink shadow-sm' : 'text-greige-ink hover:text-ink'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-8 md:px-8">
        {tab === 'difusion' && <DifusionTab />}
        {tab === 'templates' && isAdmin && <TemplatesTab />}
      </div>
    </div>
  );
}

function DifusionTab() {
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
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-greige-ink">Enviar una plantilla aprobada a varios clientes a la vez.</p>
        <button
          onClick={() => setNewOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={15} /> Nueva difusión
        </button>
      </div>

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
    </>
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
  // {{2}} and beyond — a tracking number, an order code — need a real value per
  // recipient (backend rejects a segment/existing-customer audience for these), so this
  // mode only offers the paste-a-list flow below, not "audiencia por temperatura" or
  // searching an existing customer.
  const extraParamCount = (template?.paramCount ?? 1) - 1;
  const needsExtraParams = extraParamCount > 0;

  function selectTemplate(key) {
    setTemplateKey(key);
    setHeaderMediaId(null);
    setHeaderImageToken(null);
    setHeaderPreviewUrl(null);
    setHeaderFilename(null);
    // Audience modes aren't compatible across a 1-variable vs. multi-variable template
    // (a segment/existing-customer pick has no {{2}}+ value to send) — start fresh.
    setTemperature('');
    setManualPicked([]);
    setManualQuery('');
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

  // "Envío de guías": each line brings its own extra value(s) — a tracking number, an
  // order code — beyond just the phone. Tab-separated matches a straight copy-paste of
  // multiple columns out of Excel; comma-separated covers a manually-typed list. An
  // already-known phone still resolves to that real customer server-side (their real
  // name fills {{1}}) — this only ever supplies {{2}} and up.
  function handleManualPasteWithParams(e) {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    const lines = text.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
    const known = new Set(manualPicked.map((p) => p.phone));
    const toAdd = [];
    const invalid = [];
    for (const raw of lines) {
      const cols = (raw.includes('\t') ? raw.split('\t') : raw.split(',')).map((s) => s.trim());
      const digits = (cols[0] ?? '').replace(/\D/g, '');
      const phone = digits.length === 8 ? `502${digits}` : digits;
      const params = cols.slice(1, 1 + extraParamCount);
      if (!PHONE_RE.test(phone) || params.length !== extraParamCount || params.some((v) => !v)) { invalid.push(raw); continue; }
      if (known.has(phone)) continue;
      known.add(phone);
      toAdd.push({ id: `new:${phone}`, phone, fullName: null, isNew: true, params });
    }
    if (toAdd.length) setManualPicked((prev) => [...prev, ...toAdd]);
    const parts = [];
    if (toAdd.length) parts.push(`${toAdd.length} agregado(s)`);
    if (invalid.length) parts.push(`${invalid.length} línea(s) con formato incorrecto (se esperaban ${1 + extraParamCount} columnas)`);
    if (invalid.length) showError(parts.join(' · '));
    else if (toAdd.length) showSuccess(parts.join(' · '));
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
        newRecipients: manualPicked.filter((p) => p.isNew).map((p) => ({ phone: p.phone, fullName: p.fullName, params: p.params })),
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

          {needsExtraParams ? (
            <div>
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-line-soft bg-black/[0.02] p-3 text-xs text-greige-ink dark:bg-white/[0.03]">
                <FileText size={14} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  Esta plantilla necesita {extraParamCount} valor{extraParamCount === 1 ? '' : 'es'} extra por cliente ({Array.from({ length: extraParamCount }, (_, i) => `{{${i + 2}}}`).join(', ')}) —
                  solo se puede enviar pegando la lista de destinatarios, no por segmento ni buscando un cliente existente.
                </span>
              </div>
              <label className="mb-1.5 block text-xs font-medium text-greige-ink">
                Pega tu lista (una por línea): teléfono{Array.from({ length: extraParamCount }, (_, i) => `, valor para {{${i + 2}}}`).join('')}
              </label>
              <textarea
                onPaste={handleManualPasteWithParams}
                placeholder={`50255529660${Array.from({ length: extraParamCount }, (_, i) => `, valor${i + 1}`).join('')}\n50255529661${Array.from({ length: extraParamCount }, (_, i) => `, valor${i + 1}`).join('')}`}
                rows={4}
                className="w-full resize-none rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
              />
              <p className="mt-1 text-xs text-greige">Copiado directo de Excel (varias columnas) también funciona.</p>
              {manualPicked.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {manualPicked.map((c) => (
                    <span key={c.id} className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
                      {c.phone}{c.params?.length ? ` — ${c.params.join(', ')}` : ''}
                      <button onClick={() => setManualPicked((prev) => prev.filter((p) => p.id !== c.id))} className="hover:opacity-70">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
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
            </>
          )}
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

const TEMPLATE_STATUS_META = {
  APPROVED: { variant: 'success', label: 'Aprobada' },
  PENDING: { variant: 'warning', label: 'En revisión' },
  REJECTED: { variant: 'danger', label: 'Rechazada' },
};
const TEMPLATE_CATEGORIES = [
  { value: 'MARKETING', label: 'Marketing' },
  { value: 'UTILITY', label: 'Utilidad' },
];
const EMPTY_TEMPLATE_FORM = { name: '', category: 'MARKETING', bodyText: '', examples: {} };

// How many {{n}} variables the body currently has — the highest number used, not just a
// count, so a template mid-edit (e.g. only {{1}} and {{3}} typed so far) still shows a
// box for {{2}} rather than silently skipping it. The backend enforces the real
// no-gaps rule (1, 2, 3… in order) on submit.
function detectParamCount(bodyText) {
  const matches = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return matches.length ? Math.max(...matches) : 0;
}

function TemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [form, setForm] = useState(EMPTY_TEMPLATE_FORM);
  const [formError, setFormError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchTemplatesManage().then(setTemplates).catch((err) => setListError(err.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const paramCount = detectParamCount(form.bodyText);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setFormError(null);
    try {
      const bodyExamples = Array.from({ length: paramCount }, (_, i) => form.examples[i + 1] ?? '');
      await createWhatsappTemplate({ name: form.name, category: form.category, bodyText: form.bodyText, bodyExamples });
      setForm(EMPTY_TEMPLATE_FORM);
      load();
      showSuccess('Plantilla enviada a revisión de Meta');
    } catch (err) {
      setFormError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteWhatsappTemplate(confirmDeleteName);
      load();
      showSuccess('Plantilla eliminada');
    } catch (err) {
      showError(err.message);
    } finally {
      setDeleting(false);
      setConfirmDeleteName(null);
    }
  }

  const previewBody = form.bodyText.replace(/\{\{(\d+)\}\}/g, (_, n) => form.examples[n] || `{{${n}}}`);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <section className="rounded-2xl border border-line bg-paper p-4 md:p-8">
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-line-soft bg-black/[0.02] p-3 text-xs text-greige-ink dark:bg-white/[0.03]">
          <Info size={14} className="mt-0.5 shrink-0 text-accent" />
          <span>
            Una vez que Meta aprueba una plantilla, su texto ya no se puede editar — solo eliminarla y crear una nueva.
            Una plantilla nueva queda "En revisión" hasta que Meta la aprueba (minutos a ~1 día).
          </span>
        </div>

        {listError && <p className="text-sm text-danger">{listError}</p>}
        {!loading && !listError && templates.length === 0 && (
          <p className="py-6 text-center text-sm text-greige-ink">Sin plantillas todavía.</p>
        )}

        <ul className="flex flex-col gap-2">
          {templates.map((t) => {
            const statusMeta = TEMPLATE_STATUS_META[t.status] ?? { variant: 'neutral', label: t.status };
            return (
              <li key={t.name} className="rounded-xl border border-line p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      <span className="truncate">{t.name}</span>
                      <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-greige-ink">{t.body}</p>
                    {t.status === 'REJECTED' && t.rejectedReason && (
                      <p className="mt-1.5 text-xs text-danger">Motivo de Meta: {t.rejectedReason}</p>
                    )}
                  </div>
                  <Button type="button" variant="danger" onClick={() => setConfirmDeleteName(t.name)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="h-fit rounded-2xl border border-line bg-paper p-4 md:p-6">
        <h2 className="text-lg font-semibold text-ink">Nueva plantilla</h2>
        <p className="mt-1 text-xs text-greige-ink">Solo texto por ahora (sin encabezado, botones ni pie).</p>

        <form onSubmit={handleCreate} className="mt-4">
          <label className="mb-1.5 block text-sm font-medium text-ink">Nombre</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
            placeholder="promo_septiembre"
            required
            className="w-full rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
          />
          <p className="mt-1 text-xs text-greige">Solo minúsculas, números y guion bajo — sin espacios.</p>

          <label className="mb-1.5 mt-4 block text-sm font-medium text-ink">Categoría</label>
          <Select value={form.category} onChange={(category) => setForm({ ...form, category })} options={TEMPLATE_CATEGORIES} />

          <label className="mb-1.5 mt-4 block text-sm font-medium text-ink">Mensaje</label>
          <textarea
            value={form.bodyText}
            onChange={(e) => setForm({ ...form, bodyText: e.target.value })}
            placeholder={'Hola {{1}}, tu guía es {{2}}…'}
            required
            rows={5}
            maxLength={1024}
            className="w-full resize-none rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
          />
          <p className="mt-1 text-xs text-greige">
            <code>{'{{1}}'}</code> es siempre el nombre del cliente. <code>{'{{2}}'}</code>, <code>{'{{3}}'}</code>… son valores distintos por cliente
            (ej. un número de guía) que se piden al armar la difusión — deben ir en orden, sin saltarse ninguno.
          </p>

          {paramCount > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-xs font-medium text-ink">Meta pide un valor de ejemplo por variable, para revisarla:</p>
              {Array.from({ length: paramCount }, (_, i) => i + 1).map((n) => (
                <div key={n} className="flex items-center gap-2">
                  <span className="w-9 shrink-0 text-xs font-medium text-greige-ink">{`{{${n}}}`}</span>
                  <input
                    value={form.examples[n] ?? ''}
                    onChange={(e) => setForm({ ...form, examples: { ...form.examples, [n]: e.target.value } })}
                    placeholder={n === 1 ? 'María' : 'GUIA-00123'}
                    required
                    className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
                  />
                </div>
              ))}
            </div>
          )}

          {form.bodyText && (
            <div className="mt-3 rounded-lg border border-dashed border-line-soft p-3 text-sm text-ink">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-greige">Vista previa</p>
              {previewBody}
            </div>
          )}

          {formError && <p className="mt-3 text-sm text-danger">{formError}</p>}

          <Button type="submit" disabled={creating} className="mt-4">
            {creating ? 'Enviando…' : 'Enviar a revisión'}
          </Button>
        </form>
      </section>

      <ConfirmDialog
        open={confirmDeleteName !== null}
        title="Eliminar plantilla"
        message={`Esta acción no se puede deshacer. "${confirmDeleteName}" dejará de estar disponible para nuevos envíos (los mensajes ya enviados no se ven afectados).`}
        confirmLabel="Eliminar"
        danger
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDeleteName(null)}
      />
    </div>
  );
}
