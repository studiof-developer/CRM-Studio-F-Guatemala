import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Search, Send, Headset, MessageCircle, Check, Info, X, Paperclip,
  MapPin, ShoppingBag, CircleDollarSign, AlertTriangle, CheckCircle2, FileText, Download,
} from 'lucide-react';
import {
  fetchConversations, fetchConversation, sendConversationMessage, sendConversationAttachment,
  attachmentUrl, updateTicket, updateCustomerTags,
} from './api.js';
import { formatListTime, formatBubbleTime, groupByDay } from './lib/chatTime.js';
import { TEMP_META, BUCKET_ORDER } from './lib/temperature.js';
import Avatar from './components/Avatar.jsx';

function Tail({ side, color }) {
  // Small CSS-triangle "tail" on the bubble's outer top corner, the classic WhatsApp cue.
  const style = {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    borderTop: `8px solid ${color}`,
    ...(side === 'right'
      ? { right: -7, borderLeft: '8px solid transparent' }
      : { left: -7, borderRight: '8px solid transparent' }),
  };
  return <span style={style} />;
}

export default function Conversations() {
  const [conversations, setConversations] = useState([]);
  const [search, setSearch] = useState('');
  const [temperature, setTemperature] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const lastMessageIdRef = useRef(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setConversations(await fetchConversations(search, temperature));
    } catch (err) {
      setError(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [search, temperature]);

  useEffect(() => { load(); }, [load]);

  // n8n owns this table directly, so we poll instead of wiring a trigger onto it.
  useEffect(() => {
    const id = setInterval(() => load(false), 5000);
    return () => clearInterval(id);
  }, [load]);

  const loadThread = useCallback(() => {
    if (!selectedId) { setThread(null); return; }
    fetchConversation(selectedId).then(setThread).catch((err) => setError(err.message));
  }, [selectedId]);

  useEffect(() => {
    loadThread();
    setInfoOpen(false);
    lastMessageIdRef.current = null; // switching threads always scrolls to bottom once, below
  }, [loadThread]);

  useEffect(() => {
    if (!selectedId) return;
    const id = setInterval(loadThread, 4000);
    return () => clearInterval(id);
  }, [selectedId, loadThread]);

  // Polling refreshes `thread` every few seconds even with no new messages — only
  // autoscroll when the last message actually changed, and only if the advisor
  // hadn't scrolled up to read history (don't yank them back down mid-read).
  useEffect(() => {
    if (!thread) return;
    const lastId = thread.messages[thread.messages.length - 1]?.id ?? null;
    if (lastId === lastMessageIdRef.current) return;
    const isFirstLoadForThread = lastMessageIdRef.current === null;
    const container = scrollContainerRef.current;
    const nearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    lastMessageIdRef.current = lastId;
    if (isFirstLoadForThread || nearBottom) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [thread]);

  async function handleSend(e) {
    e.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await sendConversationMessage(selectedId, draft.trim());
      setDraft('');
      loadThread();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleTake() {
    const advisor = window.prompt('Tu nombre para asignarte esta conversación:');
    if (!advisor || !thread?.ticketId) return;
    setActionBusy(true);
    try {
      await updateTicket(thread.ticketId, { status: 'en_atencion', assigned_advisor: advisor });
      await loadThread();
      load(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleResolve() {
    if (!thread?.ticketId) return;
    setActionBusy(true);
    try {
      await updateTicket(thread.ticketId, { status: 'resuelto' });
      await loadThread();
      load(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      await sendConversationAttachment(selectedId, file);
      loadThread();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleSetStatus(e) {
    const value = e.target.value;
    if (!thread?.customerId) return;
    try {
      await updateCustomerTags(thread.customerId, { manualStatus: value || null });
      await loadThread();
      load(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleMarkPaid() {
    if (!thread?.customerId) return;
    if (!window.confirm('Esto marca al cliente como Pagado de forma permanente — no se puede deshacer. ¿Continuar?')) return;
    try {
      await updateCustomerTags(thread.customerId, { paidLocked: true });
      await loadThread();
      load(false);
    } catch (err) {
      setError(err.message);
    }
  }

  const selected = conversations.find((c) => c.sessionId === selectedId);
  const visibleMessages = thread?.messages.filter(
    (m) => (m.type === 'human' || m.type === 'ai') && ((typeof m.content === 'string' && m.content.trim()) || m.attachment)
  ) ?? [];
  const dayGroups = groupByDay(visibleMessages);

  return (
    <div className="flex h-full min-w-0 overflow-hidden rounded-3xl">
      {/* Conversation list — mirrors WhatsApp's left rail */}
      <div className="flex w-[380px] max-w-[45vw] shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-4">
          <h1 className="mb-3 px-1 text-lg font-semibold text-ink">Conversaciones</h1>
          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-greige" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o número"
              className="w-full rounded-full border border-line bg-black/[0.03] py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent focus:bg-paper"
            />
          </div>
          <select
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink outline-none focus:border-accent"
          >
            <option value="">Todas las temperaturas</option>
            {BUCKET_ORDER.map((k) => (
              <option key={k} value={k}>{TEMP_META[k].label}</option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <p className="p-4 text-sm text-danger">{error}</p>}
          {loading && <p className="p-4 text-sm text-greige-ink">Cargando…</p>}
          {!loading && conversations.length === 0 && (
            <p className="p-4 text-sm text-greige-ink">Sin conversaciones.</p>
          )}
          {conversations.map((c) => {
            const name = c.customerName || c.phone || c.sessionId.slice(0, 12);
            return (
              <button
                key={c.sessionId}
                onClick={() => setSelectedId(c.sessionId)}
                className={`flex w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left transition-colors ${
                  c.sessionId === selectedId ? 'bg-accent-soft' : 'hover:bg-black/[0.03]'
                }`}
              >
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink">{name}</p>
                    <span className="shrink-0 text-[11px] text-greige">{formatListTime(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs text-greige-ink">
                      {typeof c.lastMessage?.content === 'string' ? c.lastMessage.content : ''}
                    </p>
                    <div className="flex shrink-0 items-center gap-1">
                    {c.temperature && (() => {
                      const { label, icon: Icon, iconText } = TEMP_META[c.temperature];
                      return (
                        <span className={`flex items-center gap-1 rounded-full bg-black/[0.03] px-2 py-0.5 text-[10px] font-semibold ${iconText}`}>
                          <Icon size={10} /> {label}
                        </span>
                      );
                    })()}
                    {c.ticketStatus === 'en_atencion' && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent">
                        <Headset size={10} /> asesor
                      </span>
                    )}
                    {c.ticketStatus === 'esperando_asesor' && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-[10px] font-semibold text-warn">
                        <AlertTriangle size={10} /> pendiente
                      </span>
                    )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Thread */}
      <div className="flex min-w-0 flex-1 flex-col bg-black/[0.015]">
        {!thread && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-greige-ink">
            <MessageCircle size={32} strokeWidth={1.5} className="text-greige" />
            Selecciona una conversación para ver los mensajes.
          </div>
        )}
        {thread && (
          <>
            <button
              onClick={() => setInfoOpen((v) => !v)}
              className="flex items-center gap-3 border-b border-line bg-paper px-5 py-3 text-left transition-colors hover:bg-black/[0.02]"
            >
              <Avatar name={thread.customerName || thread.phone} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">
                  {thread.customerName || thread.phone || selected?.sessionId.slice(0, 12)}
                </p>
                <p className="text-xs text-greige-ink">{thread.phone}</p>
              </div>

              {thread.ticketStatus === 'esperando_asesor' && (
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); handleTake(); }}
                  className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white shadow-md shadow-accent/20 transition-opacity hover:opacity-90"
                >
                  <Headset size={12} /> {actionBusy ? '...' : 'Tomar conversación'}
                </span>
              )}
              {thread.ticketStatus === 'en_atencion' && (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
                    <Headset size={12} /> Asesor en control
                  </span>
                  <span
                    role="button"
                    onClick={(e) => { e.stopPropagation(); handleResolve(); }}
                    className="flex items-center gap-1.5 rounded-full bg-ok/10 px-3 py-1.5 text-xs font-semibold text-ok transition-colors hover:bg-ok hover:text-white"
                  >
                    <CheckCircle2 size={12} /> {actionBusy ? '...' : 'Resolver'}
                  </span>
                </div>
              )}
              <Info size={16} className="shrink-0 text-greige" />
            </button>

            <div className="flex min-h-0 flex-1">
              <div ref={scrollContainerRef} className="flex-1 space-y-1 overflow-y-auto px-6 py-4">
                {dayGroups.map((group) => (
                  <div key={group.label}>
                    <div className="sticky top-0 z-10 my-3 flex justify-center">
                      <span className="rounded-full bg-paper px-3 py-1 text-[11px] font-medium text-greige-ink shadow-sm">
                        {group.label}
                      </span>
                    </div>
                    {group.items.map((m) => {
                      const fromAdvisor = m.additional_kwargs?.sentBy === 'advisor';
                      const outgoing = m.type === 'ai'; // Business side (bot or advisor) = outgoing = right, like WhatsApp Business.
                      const bg = outgoing ? '#4338ca' : '#ffffff';
                      return (
                        <div key={m.id} className={`mb-1.5 flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
                          <div className="relative max-w-[70%]">
                            <Tail side={outgoing ? 'right' : 'left'} color={bg} />
                            <div
                              className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm ${
                                outgoing ? 'rounded-tr-none text-white' : 'rounded-tl-none border border-line-soft text-ink'
                              }`}
                              style={{ backgroundColor: bg }}
                            >
                              {fromAdvisor && (
                                <p className="mb-0.5 text-[11px] font-semibold text-white/80">
                                  {m.additional_kwargs.advisorName}
                                </p>
                              )}
                              {m.attachment && <AttachmentContent attachment={m.attachment} outgoing={outgoing} />}
                              {m.content?.trim() && <p className="whitespace-pre-wrap">{m.content}</p>}
                              <span
                                className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] ${
                                  outgoing ? 'text-white/70' : 'text-greige'
                                }`}
                              >
                                {formatBubbleTime(m.createdAt)}
                                {outgoing && <Check size={12} />}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              {infoOpen && (
                <div className="w-72 shrink-0 overflow-y-auto border-l border-line bg-paper p-5">
                  <div className="mb-5 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">Info del cliente</h3>
                    <button onClick={() => setInfoOpen(false)} className="text-greige hover:text-ink">
                      <X size={16} />
                    </button>
                  </div>
                  <div className="flex flex-col items-center text-center">
                    <Avatar name={thread.customerName || thread.phone} size={64} />
                    <p className="mt-3 text-sm font-semibold text-ink">{thread.customerName || 'Sin nombre'}</p>
                    <p className="text-xs text-greige-ink">{thread.phone}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                      {thread.temperature && (() => {
                        const { label, icon: Icon, iconBg, iconText } = TEMP_META[thread.temperature];
                        return (
                          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${iconBg} ${iconText}`}>
                            <Icon size={12} /> {label}
                          </span>
                        );
                      })()}
                      {thread.paidLocked && thread.temperature !== 'pagado' && (() => {
                        const { label, icon: Icon, iconBg, iconText } = TEMP_META.pagado;
                        return (
                          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${iconBg} ${iconText}`}>
                            <Icon size={12} /> {label}
                          </span>
                        );
                      })()}
                    </div>
                  </div>

                  {thread.customerId && (
                    <div className="mt-5 flex flex-col gap-2 border-t border-line-soft pt-5">
                      <label className="text-xs font-medium text-greige-ink">Estado (control del asesor)</label>
                      <select
                        value={thread.manualStatus ?? ''}
                        onChange={handleSetStatus}
                        className="w-full rounded-lg border border-line bg-black/[0.03] px-3 py-1.5 text-sm outline-none focus:border-accent focus:bg-paper"
                      >
                        <option value="">Automático ({TEMP_META[thread.temperature]?.label ?? '—'})</option>
                        {BUCKET_ORDER.map((k) => (
                          <option key={k} value={k}>{TEMP_META[k].label}</option>
                        ))}
                      </select>
                      {!thread.paidLocked && (
                        <button
                          onClick={handleMarkPaid}
                          className="mt-1 rounded-lg border border-success-bg bg-success-bg/50 px-3 py-1.5 text-xs font-semibold text-success transition-colors hover:bg-success-bg"
                        >
                          Marcar como Pagado (permanente)
                        </button>
                      )}
                    </div>
                  )}

                  <div className="mt-6 flex flex-col gap-4 border-t border-line-soft pt-5">
                    <InfoRow icon={MapPin} label="Departamento" value={thread.department || '—'} />
                    <InfoRow icon={MapPin} label="Dirección" value={thread.address || '—'} />
                    <InfoRow icon={ShoppingBag} label="Línea preferida" value={thread.preferredLine || '—'} />
                    <InfoRow icon={CircleDollarSign} label="Compras totales" value={thread.purchaseFrequency ?? '—'} />
                  </div>

                  {thread.handoffReason && (
                    <div className="mt-6 border-t border-line-soft pt-5">
                      <p className="mb-1.5 text-xs font-medium text-greige-ink">Motivo del handoff</p>
                      <p className="text-sm text-ink">{thread.handoffReason}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {thread.enAtencion ? (
              <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-line bg-paper p-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,audio/*,.pdf,.doc,.docx"
                  className="hidden"
                  onChange={handleFileSelected}
                />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-greige transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-50"
                  aria-label="Adjuntar archivo"
                >
                  <Paperclip size={18} />
                </button>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={uploading ? 'Enviando archivo…' : 'Escribe tu respuesta como asesor…'}
                  disabled={uploading}
                  className="flex-1 rounded-full border border-line bg-black/[0.03] px-4 py-2.5 text-sm outline-none transition-colors focus:border-accent focus:bg-paper disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={sending || uploading || !draft.trim()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-md shadow-accent/20 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
                  aria-label="Enviar"
                >
                  <Send size={16} />
                </button>
              </form>
            ) : (
              <div className="border-t border-line bg-paper px-5 py-3 text-center text-xs text-greige-ink">
                {thread.ticketStatus === 'esperando_asesor'
                  ? 'Este cliente está esperando un asesor — tómalo desde el botón de arriba para poder responder.'
                  : 'El bot está atendiendo esta conversación con normalidad.'}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentContent({ attachment, outgoing }) {
  const url = attachmentUrl(attachment.id);
  if (attachment.kind === 'image') {
    return (
      <img
        src={url}
        alt={attachment.filename ?? 'Imagen adjunta'}
        className="mb-1 max-h-64 w-full rounded-lg object-cover"
      />
    );
  }
  if (attachment.kind === 'audio') {
    return <audio src={url} controls className="mb-1 w-64 max-w-full" />;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`mb-1 flex items-center gap-2.5 rounded-lg px-3 py-2 ${
        outgoing ? 'bg-white/10' : 'bg-black/[0.04]'
      }`}
    >
      <FileText size={22} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{attachment.filename ?? 'Documento'}</p>
        <p className={`text-[10px] ${outgoing ? 'text-white/70' : 'text-greige'}`}>{formatSize(attachment.sizeBytes)}</p>
      </div>
      <Download size={14} className="shrink-0" />
    </a>
  );
}

function InfoRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={15} className="mt-0.5 shrink-0 text-greige" />
      <div>
        <p className="text-xs text-greige-ink">{label}</p>
        <p className="text-sm font-medium text-ink">{value}</p>
      </div>
    </div>
  );
}
