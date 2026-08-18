import { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Send, Headset, MessageCircle, Check, Info, X, Paperclip, SquarePen, Pencil, Reply, Bot,
  MapPin, ShoppingBag, CircleDollarSign, AlertTriangle, CheckCircle2, FileText, Download,
  Megaphone,
} from 'lucide-react';
import {
  fetchConversations, fetchConversation, sendConversationMessage, sendConversationAttachment,
  attachmentUrl, attachmentDownloadUrl, updateTicket, updateCustomerTags, startConversation,
  fetchQuickReplies,
} from './api.js';
import { formatListTime, formatBubbleTime, groupByDay } from './lib/chatTime.js';
import { TEMP_META, BUCKET_ORDER } from './lib/temperature.js';
import { PAID_METHOD_LABELS, PAID_METHOD_ORDER } from './lib/paymentMethods.js';
import { useLiveEvent } from './lib/liveEvents.js';
import Avatar from './components/Avatar.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import EditCustomerModal from './components/EditCustomerModal.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

// Turns a message into what its quote preview should show — a document shows its
// filename (not a generic "Adjunto"), an image shows nothing here since the preview
// renders an actual thumbnail instead, audio gets a plain label.
function describeQuoted(msg, from) {
  const att = msg.attachment;
  let content = msg.content?.trim() || '';
  if (!content && att) {
    content = att.kind === 'document' ? (att.filename || 'Documento') : att.kind === 'audio' ? '🎵 Audio' : '';
  }
  return { from, content, attachmentKind: att?.kind ?? null, attachmentId: att?.id ?? null };
}

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

export default function Conversations({ user, openSessionId, onOpenedConversation }) {
  const [conversations, setConversations] = useState([]);
  const [search, setSearch] = useState('');
  const [temperature, setTemperature] = useState('');
  const [ticketStatusFilter, setTicketStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmPaidOpen, setConfirmPaidOpen] = useState(false);
  const [paidMethod, setPaidMethod] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatBusy, setNewChatBusy] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState('');
  const [newChatName, setNewChatName] = useState('');
  const [newChatAddress, setNewChatAddress] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [confirmResolveOpen, setConfirmResolveOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState(null);
  const [quickReplies, setQuickReplies] = useState([]);
  const [slashIndex, setSlashIndex] = useState(0);

  useEffect(() => { fetchQuickReplies().then(setQuickReplies).catch(() => {}); }, []);

  // Only while the draft is *just* "/something" — a slash typed mid-sentence isn't a
  // command. Matches on shortcut prefix, personal and team templates mixed together.
  const slashMatch = /^\/(\S*)$/.exec(draft);
  const slashResults = slashMatch
    ? quickReplies.filter((q) => q.shortcut.startsWith(slashMatch[1].toLowerCase())).slice(0, 8)
    : [];

  function applyQuickReply(item) {
    setDraft(item.content);
    setSlashIndex(0);
  }

  function handleDraftKeyDown(e) {
    if (!slashResults.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIndex((i) => (i + 1) % slashResults.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIndex((i) => (i - 1 + slashResults.length) % slashResults.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyQuickReply(slashResults[slashIndex] ?? slashResults[0]);
    } else if (e.key === 'Escape') {
      setDraft('');
    }
  }

  // Tapping a quote preview jumps to (and briefly flashes) the original message,
  // same as WhatsApp itself — only works if that message is still loaded in this thread.
  function scrollToMessage(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(id);
    setTimeout(() => setHighlightedId((cur) => (cur === id ? null : cur)), 1500);
  }
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const lastMessageIdRef = useRef(null);
  const seenIdRef = useRef({}); // sessionId -> last lastId we've already accounted for
  const selectedIdRef = useRef(null); // read (not subscribed) inside load, so selecting a
  // conversation doesn't change load's identity and re-trigger the mount/interval effects
  // below with showLoading=true — that was what made the list flash "Cargando..." and jump.
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const data = await fetchConversations(search, temperature, ticketStatusFilter);
      setConversations(data);
      // Diff against what we last saw per thread — a new customer message on a thread
      // that isn't currently open bumps its badge. First sighting of a thread just
      // seeds the baseline, it doesn't retroactively flag old history as unread.
      setUnreadCounts((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const c of data) {
          const seen = seenIdRef.current[c.sessionId];
          seenIdRef.current[c.sessionId] = c.lastId;
          if (seen === undefined || c.lastId <= seen) continue;
          if (c.sessionId === selectedIdRef.current) continue;
          if (c.lastMessage?.type !== 'human') continue;
          next[c.sessionId] = (next[c.sessionId] ?? 0) + 1;
          changed = true;
        }
        return changed ? next : prev;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [search, temperature, ticketStatusFilter]);

  useEffect(() => { load(); }, [load]);

  const loadQuiet = useCallback(() => load(false), [load]);
  useLiveEvent('message_changes', loadQuiet);
  useLiveEvent('ticket_changes', loadQuiet);

  // SSE (above) is the fast path — this is just a safety net in case that connection
  // silently drops, so it doesn't need to be nearly as tight as before.
  useEffect(() => {
    const id = setInterval(() => load(false), 30000);
    return () => clearInterval(id);
  }, [load]);

  // Coming from "Tomar ticket" in Cola de Handoff — jump straight to that chat
  // instead of leaving the advisor to hunt for it in the list.
  useEffect(() => {
    if (!openSessionId) return;
    setSelectedId(openSessionId);
    onOpenedConversation?.();
  }, [openSessionId, onOpenedConversation]);

  const loadThread = useCallback(() => {
    if (!selectedId) { setThread(null); return; }
    fetchConversation(selectedId).then(setThread).catch((err) => setError(err.message));
  }, [selectedId]);

  useEffect(() => {
    loadThread();
    setInfoOpen(false);
    setReplyingTo(null);
    lastMessageIdRef.current = null; // switching threads always scrolls to bottom once, below
  }, [loadThread]);

  useLiveEvent('message_changes', loadThread);
  // Without this, another advisor taking/resolving the ticket you have open right now
  // (or a customer's reply changing SLA state) wouldn't show up until you reselected
  // the thread or reloaded — the list picked it up, but the open detail pane didn't.
  useLiveEvent('ticket_changes', loadThread);

  useEffect(() => {
    if (!selectedId) return;
    const id = setInterval(loadThread, 15000);
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
      // Direct scrollTop instead of scrollIntoView, reapplied after paint and again
      // shortly after — attachment images finish loading late and grow the container,
      // which otherwise leaves the view sitting above the true bottom.
      const scrollToBottom = () => {
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      };
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      setTimeout(scrollToBottom, 300);
    }
  }, [thread]);

  async function handleSend(e) {
    e.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await sendConversationMessage(selectedId, draft.trim(), replyingTo ?? undefined);
      setDraft('');
      setReplyingTo(null);
      loadThread();
    } catch (err) {
      showError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleTake() {
    if (!thread?.ticketId) return;
    setActionBusy(true);
    try {
      await updateTicket(thread.ticketId, { status: 'en_atencion', assigned_advisor: user.fullName });
      await loadThread();
      load(false);
      showSuccess('Conversación asignada a ti');
    } catch (err) {
      showError(err.message);
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
      setConfirmResolveOpen(false);
      showSuccess('Conversación resuelta — el chat sigue disponible para responder');
    } catch (err) {
      showError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function uploadFile(file) {
    setUploading(true);
    try {
      // Whatever's typed in the compose box rides along as the WhatsApp caption —
      // same gesture as WhatsApp itself (write, then attach, sends as one message).
      const caption = draft.trim();
      await sendConversationAttachment(selectedId, file, caption || undefined);
      if (caption) setDraft('');
      loadThread();
    } catch (err) {
      showError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await uploadFile(file);
  }

  // Lets an advisor Ctrl+V a copied screenshot/image straight into the chat,
  // same as WhatsApp Web — no need to save it to disk first just to attach it.
  function handlePaste(e) {
    if (uploading) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          uploadFile(file);
        }
        return;
      }
    }
  }

  async function handleSetStatus(e) {
    const value = e.target.value;
    if (!thread?.customerId) return;
    try {
      await updateCustomerTags(thread.customerId, { manualStatus: value || null });
      await loadThread();
      load(false);
      showSuccess(value ? `Estado cambiado a ${TEMP_META[value].label}` : 'Estado devuelto a automático');
    } catch (err) {
      showError(err.message);
    }
  }

  async function handleMarkPaid() {
    if (!thread?.customerId || !paidMethod) return;
    setActionBusy(true);
    try {
      await updateCustomerTags(thread.customerId, { paidLocked: true, paidMethod });
      await loadThread();
      load(false);
      showSuccess('Cliente marcado como Pagado');
    } catch (err) {
      showError(err.message);
    } finally {
      setActionBusy(false);
      setConfirmPaidOpen(false);
      setPaidMethod('');
    }
  }

  async function handleStartConversation() {
    setNewChatBusy(true);
    try {
      const { sessionId } = await startConversation({
        phone: newChatPhone.trim(), fullName: newChatName.trim(), address: newChatAddress.trim(),
      });
      setNewChatOpen(false);
      setNewChatPhone('');
      setNewChatName('');
      setNewChatAddress('');
      await load(false);
      setSelectedId(sessionId);
      showSuccess('Plantilla enviada, chat abierto');
    } catch (err) {
      showError(err.message);
    } finally {
      setNewChatBusy(false);
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
          <div className="mb-3 flex items-center justify-between px-1">
            <h1 className="text-lg font-semibold text-ink">Conversaciones</h1>
            <button
              onClick={() => setNewChatOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-greige transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-ink"
              aria-label="Nuevo chat"
              title="Nuevo chat"
            >
              <SquarePen size={17} />
            </button>
          </div>
          <div className="relative mb-2">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-greige" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o número"
              className="w-full rounded-full border border-line bg-black/[0.03] dark:bg-white/[0.05] py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent focus:bg-paper"
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
          <select
            value={ticketStatusFilter}
            onChange={(e) => setTicketStatusFilter(e.target.value)}
            className="mt-2 w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink outline-none focus:border-accent"
          >
            <option value="">Todos los estados</option>
            <option value="bot">Bot</option>
            <option value="esperando_asesor">Pendiente</option>
            <option value="en_atencion">Asesor</option>
            <option value="resuelto">Resuelto</option>
          </select>
        </div>

        <div className="relative flex-1 overflow-y-auto">
          {/* Overlaid, not in-flow — a loading blip here must never push the list around. */}
          <AnimatePresence>
            {loading && (
              <motion.span
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15 }}
                className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-line bg-paper px-3 py-1 text-[11px] font-medium text-greige-ink shadow-sm"
              >
                Cargando…
              </motion.span>
            )}
          </AnimatePresence>
          {error && <p className="p-4 text-sm text-danger">{error}</p>}
          {!loading && conversations.length === 0 && (
            <p className="p-4 text-sm text-greige-ink">Sin conversaciones.</p>
          )}
          {conversations.map((c) => {
            const name = c.customerName || c.phone || c.sessionId.slice(0, 12);
            const unread = unreadCounts[c.sessionId] ?? 0;
            return (
              <button
                key={c.sessionId}
                onClick={() => {
                  setSelectedId(c.sessionId);
                  setUnreadCounts((prev) => {
                    if (!prev[c.sessionId]) return prev;
                    const next = { ...prev };
                    delete next[c.sessionId];
                    return next;
                  });
                }}
                className={`flex w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left transition-colors ${
                  c.sessionId === selectedId ? 'bg-accent-soft' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'
                }`}
              >
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink">{name}</p>
                    <span className="shrink-0 text-[11px] text-greige">{formatListTime(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className={`truncate text-xs ${unread ? 'font-semibold text-ink' : 'text-greige-ink'}`}>
                      {typeof c.lastMessage?.content === 'string' ? c.lastMessage.content : ''}
                    </p>
                    <div className="flex shrink-0 items-center gap-1">
                    {unread > 0 && (
                      <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                    {c.temperature && (() => {
                      const { label, icon: Icon, iconText } = TEMP_META[c.temperature];
                      return (
                        <span className={`flex items-center gap-1 rounded-full bg-black/[0.03] dark:bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold ${iconText}`}>
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
                    {c.ticketStatus === 'resuelto' && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-ok/10 px-2 py-0.5 text-[10px] font-semibold text-ok">
                        <CheckCircle2 size={10} /> resuelto
                      </span>
                    )}
                    {!c.ticketStatus && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-greige-ink">
                        <Bot size={10} /> bot
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
      <div className="flex min-w-0 flex-1 flex-col bg-black/[0.015] dark:bg-white/[0.02]">
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
              className="flex items-center gap-3 border-b border-line bg-paper px-5 py-3 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
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
                    onClick={(e) => { e.stopPropagation(); setConfirmResolveOpen(true); }}
                    className="flex items-center gap-1.5 rounded-full bg-ok/10 px-3 py-1.5 text-xs font-semibold text-ok transition-colors hover:bg-ok hover:text-white"
                  >
                    <CheckCircle2 size={12} /> Resolver
                  </span>
                </div>
              )}
              {thread.ticketStatus === 'resuelto' && (
                <span className="flex items-center gap-1.5 rounded-full bg-ok/10 px-2.5 py-1 text-xs font-medium text-ok">
                  <CheckCircle2 size={12} /> Resuelto — puedes seguir escribiendo
                </span>
              )}
              {!thread.ticketStatus && (
                <span className="flex items-center gap-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-greige-ink">
                  <Bot size={12} /> Bot activo
                </span>
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
                    {group.items.map((m, i) => {
                      const fromAdvisor = m.additional_kwargs?.sentBy === 'advisor';
                      const outgoing = m.type === 'ai'; // Business side (bot or advisor) = outgoing = right, like WhatsApp Business.
                      const bg = outgoing ? 'var(--accent)' : 'var(--paper)';
                      // Same sender back-to-back (e.g. an advisor sending several photos)
                      // only gets the name label once, on the first bubble of the run —
                      // repeating it on every bubble reads as noisy/broken, not chat-like.
                      const prev = group.items[i - 1];
                      const prevSenderKey = prev && (prev.type === 'ai' ? (prev.additional_kwargs?.sentBy === 'advisor' ? prev.additional_kwargs.advisorName : '__bot__') : '__customer__');
                      const senderKey = outgoing ? (fromAdvisor ? m.additional_kwargs.advisorName : '__bot__') : '__customer__';
                      const isRunStart = !prev || prevSenderKey !== senderKey;
                      const replyLabel = outgoing
                        ? (fromAdvisor ? m.additional_kwargs.advisorName : 'Studio F (bot)')
                        : (thread.customerName || thread.phone);
                      // Two ways a message can be "a reply": the advisor composed it with
                      // our reply button (snapshot already stored in additional_kwargs.replyTo),
                      // or the customer used WhatsApp's own quote feature — in that case we only
                      // got the wamid of the original, so look it up in this same thread by the
                      // wamid we stamped on our own outgoing messages (or captured on theirs).
                      const quotePreview = m.additional_kwargs?.replyTo || (() => {
                        const targetWamid = m.additional_kwargs?.replyToWamid;
                        if (!targetWamid) return null;
                        const orig = thread.messages.find((x) => x.additional_kwargs?.wamid === targetWamid);
                        if (!orig) return null;
                        const origOutgoing = orig.type === 'ai';
                        const origFromAdvisor = orig.additional_kwargs?.sentBy === 'advisor';
                        const origFrom = origOutgoing ? (origFromAdvisor ? orig.additional_kwargs.advisorName : 'Studio F (bot)') : (thread.customerName || thread.phone);
                        return { ...describeQuoted(orig, origFrom), id: orig.id };
                      })();
                      // Only while the advisor actually has the chat — the reply
                      // compose bar itself is bot-handled/waiting chats can't use it anyway.
                      const replyButton = thread.enAtencion ? (
                        <button
                          type="button"
                          onClick={() => setReplyingTo({
                            id: m.id,
                            ...describeQuoted(m, replyLabel),
                            // Present on customer messages (n8n tags them) and on our own
                            // outgoing ones (stamped back after Meta confirms the send) —
                            // missing only for messages sent before this existed.
                            wamid: m.additional_kwargs?.wamid,
                          })}
                          className="flex h-7 w-7 shrink-0 scale-90 items-center justify-center rounded-full border border-line bg-paper text-greige opacity-0 shadow-sm transition-all hover:border-accent hover:text-accent group-hover:scale-100 group-hover:opacity-100"
                          aria-label="Responder"
                          title="Responder"
                        >
                          <Reply size={13} />
                        </button>
                      ) : null;
                      return (
                        <motion.div
                          key={m.id}
                          id={`msg-${m.id}`}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, ease: 'easeOut' }}
                          className={`group flex items-center gap-1 ${isRunStart ? 'mb-1.5' : 'mb-0.5'} ${outgoing ? 'justify-end' : 'justify-start'}`}
                        >
                          {outgoing && replyButton}
                          <div className="relative max-w-[70%]">
                            {isRunStart && <Tail side={outgoing ? 'right' : 'left'} color={bg} />}
                            <div
                              className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm transition-shadow duration-300 ${
                                outgoing
                                  ? `text-white ${isRunStart ? 'rounded-tr-none' : ''}`
                                  : `border border-line-soft text-ink ${isRunStart ? 'rounded-tl-none' : ''}`
                              } ${highlightedId === m.id ? 'ring-2 ring-accent ring-offset-2 ring-offset-paper' : ''}`}
                              style={{ backgroundColor: bg }}
                            >
                              {fromAdvisor && (
                                <p className="mb-0.5 text-[11px] font-semibold text-white/80">
                                  {m.additional_kwargs.advisorName}
                                </p>
                              )}
                              {m.additional_kwargs?.referral && (
                                <a
                                  href={m.additional_kwargs.referral.source_url || undefined}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`mb-2 block w-64 max-w-full overflow-hidden rounded-xl border ${
                                    outgoing ? 'border-white/25 bg-black/10' : 'border-line-soft bg-black/[0.03] dark:bg-white/[0.05]'
                                  }`}
                                >
                                  {(m.additional_kwargs.referral.thumbnail_url || m.additional_kwargs.referral.image_url) ? (
                                    <img
                                      src={m.additional_kwargs.referral.thumbnail_url || m.additional_kwargs.referral.image_url}
                                      alt=""
                                      className="aspect-square w-full object-cover"
                                    />
                                  ) : (
                                    <span className={`flex aspect-square w-full items-center justify-center ${outgoing ? 'bg-white/10' : 'bg-black/5 dark:bg-white/10'}`}>
                                      <Megaphone size={22} />
                                    </span>
                                  )}
                                  <div className="px-3 py-2.5">
                                    <p className={`mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${outgoing ? 'text-white/70' : 'text-accent'}`}>
                                      <Megaphone size={12} />
                                      Anuncio de {/instagram\.com/i.test(m.additional_kwargs.referral.source_url || '') ? 'Instagram' : 'Facebook'}
                                    </p>
                                    <p className={`text-sm font-semibold leading-snug ${outgoing ? 'text-white' : 'text-ink'}`}>
                                      {m.additional_kwargs.referral.headline || 'Publicidad de Meta'}
                                    </p>
                                    {m.additional_kwargs.referral.body && (
                                      <p className={`mt-0.5 line-clamp-2 text-xs leading-snug ${outgoing ? 'text-white/75' : 'text-greige-ink'}`}>
                                        {m.additional_kwargs.referral.body}
                                      </p>
                                    )}
                                  </div>
                                </a>
                              )}
                              {quotePreview && (
                                <div
                                  onClick={() => quotePreview.id != null && scrollToMessage(quotePreview.id)}
                                  className={`mb-1.5 flex items-center gap-2 rounded-md border-l-[3px] px-2.5 py-1.5 text-xs leading-snug ${
                                    quotePreview.id != null ? 'cursor-pointer' : ''
                                  } ${outgoing ? 'border-white/60 bg-black/10' : 'border-accent bg-black/[0.04] dark:bg-white/[0.06]'}`}
                                >
                                  {quotePreview.attachmentKind === 'image' && quotePreview.attachmentId && (
                                    <img
                                      src={attachmentUrl(quotePreview.attachmentId)}
                                      alt=""
                                      className="h-9 w-9 shrink-0 rounded object-cover"
                                    />
                                  )}
                                  <div className="min-w-0">
                                    <p className={`font-semibold ${outgoing ? 'text-white/90' : 'text-accent'}`}>
                                      {quotePreview.from || '—'}
                                    </p>
                                    <p className={`truncate ${outgoing ? 'text-white/70' : 'text-greige-ink'}`}>
                                      {quotePreview.attachmentKind === 'image'
                                        ? (quotePreview.content || '📷 Foto')
                                        : (quotePreview.content || '📎 Adjunto')}
                                    </p>
                                  </div>
                                </div>
                              )}
                              {m.attachment && (
                                <AttachmentContent attachment={m.attachment} outgoing={outgoing} onImageClick={setLightboxUrl} />
                              )}
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
                          {!outgoing && replyButton}
                        </motion.div>
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
                    <div className="flex items-center gap-1">
                      {thread.customerId && (
                        <button
                          onClick={() => setEditOpen(true)}
                          className="rounded-lg p-1 text-greige transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-ink"
                          aria-label="Editar cliente"
                          title="Editar cliente"
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                      <button onClick={() => setInfoOpen(false)} className="text-greige hover:text-ink">
                        <X size={16} />
                      </button>
                    </div>
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
                    {thread.paidLocked && thread.paidMethod && (
                      <p className="mt-1 text-[11px] text-greige-ink">
                        Pagó por {PAID_METHOD_LABELS[thread.paidMethod]}
                      </p>
                    )}
                  </div>

                  {thread.customerId && (
                    <div className="mt-5 flex flex-col gap-2 border-t border-line-soft pt-5">
                      <label className="text-xs font-medium text-greige-ink">Estado (control del asesor)</label>
                      <select
                        value={thread.manualStatus ?? ''}
                        onChange={handleSetStatus}
                        className="w-full rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-1.5 text-sm outline-none focus:border-accent focus:bg-paper"
                      >
                        <option value="">Automático ({TEMP_META[thread.temperature]?.label ?? '—'})</option>
                        {BUCKET_ORDER.map((k) => (
                          <option key={k} value={k}>{TEMP_META[k].label}</option>
                        ))}
                      </select>
                      {!thread.paidLocked && (
                        <button
                          onClick={() => setConfirmPaidOpen(true)}
                          className="mt-1 rounded-lg border border-success-bg bg-success-bg/50 px-3 py-1.5 text-xs font-semibold text-success transition-colors hover:bg-success-bg"
                        >
                          Marcar como Pagado (permanente)
                        </button>
                      )}
                    </div>
                  )}

                  <div className="mt-6 flex flex-col gap-4 border-t border-line-soft pt-5">
                    <InfoRow icon={MapPin} label="Departamento" value={thread.department || '—'} />
                    <InfoRow icon={MapPin} label="Municipio" value={thread.municipio || '—'} />
                    <InfoRow icon={MapPin} label="Dirección" value={thread.address || '—'} />
                    <InfoRow icon={ShoppingBag} label="Línea preferida" value={thread.preferredLine || '—'} />
                    <InfoRow icon={ShoppingBag} label="Talla" value={thread.preferredSize || '—'} />
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
              <>
              {replyingTo && (
                <div className="flex items-center gap-3 border-t border-line bg-accent-soft px-4 py-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper text-accent shadow-sm">
                    <Reply size={14} />
                  </span>
                  <div className="min-w-0 flex-1 border-l-2 border-accent/40 pl-2.5">
                    <p className="truncate text-xs font-semibold text-accent">{replyingTo.from}</p>
                    <p className="truncate text-xs text-greige-ink">{replyingTo.content || '📎 Adjunto'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReplyingTo(null)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-greige transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.1] hover:text-ink"
                    aria-label="Cancelar respuesta"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
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
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-greige transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-ink disabled:opacity-50"
                  aria-label="Adjuntar archivo"
                >
                  <Paperclip size={18} />
                </button>
                <div className="relative flex-1">
                  {slashResults.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-2 w-full max-w-sm overflow-hidden rounded-xl border border-line bg-paper shadow-lg">
                      {slashResults.map((item, i) => (
                        <button
                          type="button"
                          key={item.id}
                          onMouseDown={(e) => { e.preventDefault(); applyQuickReply(item); }}
                          onMouseEnter={() => setSlashIndex(i)}
                          className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs transition-colors ${
                            i === slashIndex ? 'bg-accent-soft' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'
                          }`}
                        >
                          <span className="font-semibold text-accent">/{item.shortcut}</span>
                          <span className="truncate text-greige-ink">{item.content}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPaste={handlePaste}
                    onKeyDown={handleDraftKeyDown}
                    placeholder={uploading ? 'Enviando archivo…' : 'Escribe tu respuesta como asesor… ( / para plantillas )'}
                    disabled={uploading}
                    className="w-full rounded-full border border-line bg-black/[0.03] dark:bg-white/[0.05] px-4 py-2.5 text-sm outline-none transition-colors focus:border-accent focus:bg-paper disabled:opacity-50"
                  />
                </div>
                <button
                  type="submit"
                  disabled={sending || uploading || !draft.trim()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-md shadow-accent/20 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
                  aria-label="Enviar"
                >
                  <Send size={16} />
                </button>
              </form>
              </>
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

      <ConfirmDialog
        open={confirmPaidOpen}
        title="Marcar como Pagado"
        message="Esto marca al cliente como Pagado de forma permanente — no se puede deshacer. Indica el medio de pago:"
        confirmLabel="Marcar como Pagado"
        busy={actionBusy}
        confirmDisabled={!paidMethod}
        onConfirm={handleMarkPaid}
        onCancel={() => { setConfirmPaidOpen(false); setPaidMethod(''); }}
      >
        <select
          value={paidMethod}
          onChange={(e) => setPaidMethod(e.target.value)}
          className="w-full rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm outline-none focus:border-accent focus:bg-paper"
        >
          <option value="">Selecciona el medio de pago…</option>
          {PAID_METHOD_ORDER.map((k) => (
            <option key={k} value={k}>{PAID_METHOD_LABELS[k]}</option>
          ))}
        </select>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmResolveOpen}
        title="Resolver conversación"
        message="¿Está seguro de resolver la conversación? Esto solo la marca como resuelta — el chat sigue disponible, el cliente puede seguir escribiendo y tú puedes seguir respondiendo con normalidad."
        confirmLabel="Resolver"
        busy={actionBusy}
        onConfirm={handleResolve}
        onCancel={() => setConfirmResolveOpen(false)}
      />

      <ConfirmDialog
        open={newChatOpen}
        title="Nuevo chat"
        message="Le llega un mensaje de plantilla pre-aprobada por WhatsApp para abrir la conversación. En cuanto responda, puedes escribirle libremente."
        confirmLabel="Enviar y abrir chat"
        busy={newChatBusy}
        confirmDisabled={!newChatPhone.trim() || !newChatName.trim() || !newChatAddress.trim()}
        onConfirm={handleStartConversation}
        onCancel={() => setNewChatOpen(false)}
      >
        <div className="flex flex-col gap-2.5">
          <input
            value={newChatPhone}
            onChange={(e) => setNewChatPhone(e.target.value)}
            placeholder="Número (ej. 50255551234)"
            className="w-full rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm outline-none focus:border-accent focus:bg-paper"
          />
          <input
            value={newChatName}
            onChange={(e) => setNewChatName(e.target.value)}
            placeholder="Nombre completo"
            className="w-full rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm outline-none focus:border-accent focus:bg-paper"
          />
          <input
            value={newChatAddress}
            onChange={(e) => setNewChatAddress(e.target.value)}
            placeholder="Dirección"
            className="w-full rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm outline-none focus:border-accent focus:bg-paper"
          />
        </div>
      </ConfirmDialog>

      <EditCustomerModal
        open={editOpen}
        customer={thread?.customerId ? {
          id: thread.customerId,
          full_name: thread.customerName,
          dpi: thread.dpi,
          email: thread.email,
          department: thread.department,
          municipio: thread.municipio,
          address: thread.address,
          preferred_line: thread.preferredLine,
          preferred_size: thread.preferredSize,
          birth_date: thread.birthDate,
        } : null}
        onCancel={() => setEditOpen(false)}
        onSaved={() => { setEditOpen(false); loadThread(); load(false); }}
      />

      <AnimatePresence>
        {lightboxUrl && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-6"
            onClick={() => setLightboxUrl(null)}
          >
            <button
              onClick={() => setLightboxUrl(null)}
              className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              aria-label="Cerrar"
            >
              <X size={20} />
            </button>
            <motion.img
              initial={{ scale: 0.96 }}
              animate={{ scale: 1 }}
              src={lightboxUrl}
              alt="Imagen ampliada"
              className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentContent({ attachment, outgoing, onImageClick }) {
  const url = attachmentUrl(attachment.id);
  const [loaded, setLoaded] = useState(false);
  if (attachment.kind === 'image') {
    return (
      <div className="relative mb-1 w-full max-h-64 min-h-[140px] overflow-hidden rounded-lg">
        {!loaded && <div className="absolute inset-0 animate-pulse bg-black/10 dark:bg-white/10" />}
        <img
          src={url}
          alt={attachment.filename ?? 'Imagen adjunta'}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onClick={() => onImageClick?.(url)}
          className={`max-h-64 w-full cursor-pointer rounded-lg object-cover transition-opacity duration-300 hover:opacity-90 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      </div>
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
        outgoing ? 'bg-white/10' : 'bg-black/[0.04] dark:bg-white/[0.06]'
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
