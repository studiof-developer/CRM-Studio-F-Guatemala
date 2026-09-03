import { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Send, Headset, MessageCircle, Info, X, Paperclip, SquarePen, Pencil, Reply, Bot, Clock,
  MapPin, ShoppingBag, CircleDollarSign, AlertTriangle, CheckCircle2, FileText, Download,
  Megaphone, Mail, Loader2, ArrowLeft,
} from 'lucide-react';
import {
  fetchConversations, fetchConversation, sendConversationMessage, sendConversationAttachment,
  attachmentUrl, attachmentDownloadUrl, updateTicket, updateCustomerTags, startConversation,
  fetchQuickReplies, markConversationUnread, takeConversation, searchConversation, fetchMessageByWamid, searchAllConversations,
  fetchMessageDistance, retryFailedMessage, fetchPresenceSnapshot, sendPresenceHeartbeat, leavePresence,
} from './api.js';
import { formatListTime, formatBubbleTime, groupByDay } from './lib/chatTime.js';
import { TEMP_META, BUCKET_ORDER } from './lib/temperature.js';
import { PAID_METHOD_LABELS, PAID_METHOD_ICONS, PAID_METHOD_ORDER } from './lib/paymentMethods.js';
import { useLiveEvent, onLiveEvent } from './lib/liveEvents.js';
import { colorFor, hexToRgba } from './lib/avatarColor.js';
import Avatar from './components/Avatar.jsx';
import Select from './components/Select.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import EditCustomerModal from './components/EditCustomerModal.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

// Same icon/color pairing as the ticket-status pills in the list and header below —
// kept here once so the filter dropdown matches them instead of drifting apart.
const TICKET_STATUS_META = {
  bot: { label: 'Agente', icon: Bot, iconClassName: 'text-greige-ink' },
  esperando_asesor: { label: 'Pendiente', icon: AlertTriangle, iconClassName: 'text-warn' },
  en_atencion: { label: 'Asesor', icon: Headset, iconClassName: 'text-accent' },
  resuelto: { label: 'Resuelto', icon: CheckCircle2, iconClassName: 'text-ok' },
};
// Not a real ticket status — unreadCount is a client-side flag already on every row,
// so this option never reaches the backend as a ticketStatus (see load() below).
const UNREAD_FILTER = 'no_leido';
const TICKET_STATUS_FILTER_OPTIONS = [
  { value: '', label: 'Todos los estados' },
  { value: UNREAD_FILTER, label: 'No leído', icon: Mail, iconClassName: 'text-accent' },
  ...Object.entries(TICKET_STATUS_META).map(([value, meta]) => ({ value, ...meta })),
];
const TEMP_FILTER_OPTIONS = [
  { value: '', label: 'Todas las temperaturas' },
  ...BUCKET_ORDER.map((k) => ({ value: k, label: TEMP_META[k].label, icon: TEMP_META[k].icon, iconClassName: TEMP_META[k].iconText })),
];
const PAID_METHOD_OPTIONS = PAID_METHOD_ORDER.map((k) => ({
  value: k, label: PAID_METHOD_LABELS[k], icon: PAID_METHOD_ICONS[k], iconClassName: 'text-greige-ink',
}));

// Turns a message into what its quote preview should show — a document shows its
// filename (not a generic "Adjunto"), an image shows nothing here since the preview
// renders an actual thumbnail instead, audio gets a plain label.
// One place that turns an attachment into readable text, so a photo sent with no
// caption reads the same in the conversation list, in a reply quote, and anywhere else
// a message has to be summarised in a single line. Prefers the real filename — that's
// what tells an advisor which file it was — and falls back to the kind when WhatsApp
// gave us no name, which is common for photos taken in the app.
// Wraps every occurrence of the search term in a highlighted span, like WhatsApp's own
// global search does — lets an advisor scan a page of results for the match instead of
// reading each snippet in full.
function highlightMatch(text, query) {
  if (!query?.trim()) return text;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = String(text ?? '').split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.trim().toLowerCase()
      ? <mark key={i} className="rounded bg-accent-soft px-0.5 font-semibold text-accent">{part}</mark>
      : part
  );
}

// Same breakpoint Tailwind's `md:` uses everywhere else in this file — the info panel
// is a real third column on desktop (fine to default open) but a full-screen overlay on
// mobile (must stay closed until the advisor actually asks for it, or it buries the chat
// they just opened).
function isDesktopViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

export function describeAttachment(attachment) {
  if (!attachment) return '';
  const icon = attachment.kind === 'image' ? '📷' : attachment.kind === 'audio' ? '🎵' : '📄';
  const fallback = attachment.kind === 'image' ? 'Foto' : attachment.kind === 'audio' ? 'Audio' : 'Documento';
  return `${icon} ${attachment.filename || fallback}`;
}

// A ticket-less thread whose last message is an unreplied broadcast has no agent (bot or
// human) actually doing anything — nobody has engaged since it went out. Showing it as
// "Agente activo" implied otherwise; this tells those two states apart using data the
// list/thread responses already carry, no extra query needed.
function isUnansweredBroadcast(message) {
  return message?.type === 'ai' && message?.additional_kwargs?.sentBy === 'campaign';
}

function describeQuoted(msg, from) {
  const att = msg.attachment;
  const content = msg.content?.trim() || describeAttachment(att);
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

// Lucide's Check/CheckCheck are 24px stroke icons — squeezed down to bubble-tick size
// (~12px) the two strokes of CheckCheck sit almost on top of each other and read as a
// smudge instead of a clean double tick. This is WhatsApp's own compact glyph (a filled
// shape, not a stroke), which stays crisp that small.
function MessageTicks({ status, statusError, onRetry, retrying }) {
  // The actual WhatsApp send happens in the background after the message already shows
  // as "sent" here — if that fails (customer outside the 24h window, expired token,
  // Meta rate limit...) this is the only place it becomes visible to the advisor. Unlike
  // a hung/orphaned send, a "failed" one is never auto-retried — a transient blip
  // reaching Meta's API (confirmed 2026-08-31) otherwise left it stuck until someone
  // retyped the whole message from scratch, so this is a one-click way to just try again.
  if (status === 'failed') {
    return (
      <span title={statusError || 'No se pudo enviar por WhatsApp'} className="flex items-center gap-1 font-semibold text-red-200">
        <AlertTriangle size={11} /> no se envió
        {onRetry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            disabled={retrying}
            className="underline decoration-dotted underline-offset-2 hover:text-white disabled:opacity-60"
          >
            {retrying ? 'reintentando…' : 'reintentar'}
          </button>
        )}
      </span>
    );
  }
  // Written while WhatsApp's 24h window was shut. Nothing is lost — it goes out on its
  // own the moment the customer answers the reactivation template.
  if (status === 'queued') {
    return (
      <span
        title="En espera: sale automáticamente cuando el cliente responda"
        className="flex items-center gap-0.5 font-medium text-white/90"
      >
        <Clock size={11} /> en espera
      </span>
    );
  }
  const color = status === 'read' ? '#34b7f1' : 'currentColor';
  const doubleTick = status === 'read' || status === 'delivered';
  return (
    <svg width="14" height="14" viewBox="0 0 16 15" fill={color} style={{ flexShrink: 0 }}>
      {doubleTick && (
        <path d="M11.671 3.316l-.478-.372a.365.365 0 0 0-.51.063L5.327 9.879a.32.32 0 0 1-.484.033L2.324 7.443a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.373-8.183a.365.365 0 0 0-.063-.512z" />
      )}
      <path d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.064-.512z" />
    </svg>
  );
}

export default function Conversations({ user, openSessionId, onOpenedConversation }) {
  const [conversations, setConversations] = useState([]);
  const [search, setSearch] = useState('');
  // "Buscar en todos los chats" — matches WhatsApp's own global search, distinct from
  // the name/phone filter above (search) and from the in-chat search built earlier.
  const [globalResults, setGlobalResults] = useState([]);
  const [globalSearching, setGlobalSearching] = useState(false);
  const [temperature, setTemperature] = useState('');
  const [ticketStatusFilter, setTicketStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  // Who (if anyone) currently has each chat open — { sessionId: { userId, fullName } }.
  // Populated once from a snapshot on mount, kept current from live presence_changes
  // events after that (see the effects below, near where selectedId's own heartbeat lives).
  const [presenceBySession, setPresenceBySession] = useState({});
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Separate from `error` above (which is the conversation LIST's own load failure,
  // rendered in the sidebar) — this used to share that same state, so a single chat
  // failing to load showed "Error al cargar la conversación" inside the list itself,
  // sitting there indefinitely since only the list's own reload cleared it.
  const [threadError, setThreadError] = useState(null);
  const [draft, setDraft] = useState('');
  // Keyed by sessionId rather than a plain boolean, so a slow send in one chat doesn't
  // lock the compose box in every other chat — that "everything is stuck" feeling was
  // exactly what pushed advisors to switch chats mid-send in the first place.
  // Optimistic sends, keyed by sessionId — a locally-created "sending…" bubble that
  // appears the instant you hit send and resolves itself once the network request
  // actually completes, instead of the compose box sitting blocked the whole time.
  // The slow part was never the backend (it inserts the row and responds before the
  // real WhatsApp call even happens) — it's the advisor's own upload of a large
  // attachment to our server, which used to freeze the input for however long that
  // took (up to 50s for a 20MB PDF on a modest connection). Real WhatsApp doesn't wait
  // either: it shows "sending" and lets you keep typing.
  const [pendingSends, setPendingSends] = useState({});
  const [retryingId, setRetryingId] = useState(null);
  async function handleRetry(messageId) {
    if (!selectedId) return;
    setRetryingId(messageId);
    try {
      await retryFailedMessage(selectedId, messageId);
      loadThread();
    } catch (err) {
      showError(err.message);
    } finally {
      setRetryingId(null);
    }
  }
  const [actionBusy, setActionBusy] = useState(false);
  const [infoOpen, setInfoOpen] = useState(isDesktopViewport);
  // Attach several files, then send them together — instead of each one going out the
  // instant it's picked. { file, id, previewUrl (images only) }.
  const [stagedFiles, setStagedFiles] = useState([]);
  const textareaRef = useRef(null);
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

  // WhatsApp only accepts free-form messages within 24h of the customer's last inbound
  // message; outside that window Meta rejects the send outright and the customer never
  // gets it. That rejection used to be invisible on both ends — the advisor saw a normal
  // checkmark and the customer saw nothing — so warn before they type, not after.
  const lastInboundAt = thread?.messages?.reduce(
    (acc, m) => (m.type === 'human' && m.createdAt ? m.createdAt : acc),
    null
  );
  const windowClosed = !!lastInboundAt && Date.now() - new Date(lastInboundAt).getTime() > 24 * 60 * 60 * 1000;
  // A broadcast (or the reactivation template itself) already prompted the customer in
  // this same dormant stretch — the backend won't fire another one on top of it (see
  // reactivationAlreadySent), so the banner shouldn't claim it's about to.
  const templateAlreadySent = thread?.messages?.some((m) =>
    (m.additional_kwargs?.reactivationTemplate === true || m.additional_kwargs?.sentBy === 'campaign') &&
    (!lastInboundAt || new Date(m.createdAt) > new Date(lastInboundAt))
  );

  function applyQuickReply(item) {
    setDraft(item.content);
    setSlashIndex(0);
  }

  function handleDraftKeyDown(e) {
    if (slashResults.length) {
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
      return;
    }
    // Plain Enter sends, same as before (the box used to be a single-line input that
    // couldn't hold a newline at all). Ctrl+Enter or Shift+Enter falls through to the
    // textarea's own default behavior and inserts a line break instead — asked for by
    // the advisors so a multi-line message can be composed before sending.
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Grows with the content (up to a cap, then scrolls) instead of staying a fixed
  // single line — re-runs on every draft change, typed or programmatic (e.g. cleared
  // after sending), so it also snaps back to one line once the message goes out.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

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
  const selectedIdRef = useRef(null); // read (not subscribed) inside load, so selecting a
  // conversation doesn't change load's identity and re-trigger the mount/interval effects
  // below with showLoading=true — that was what made the list flash "Cargando..." and jump.
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // Loading all 1000+ threads at once was what made the list feel heavy — start with the
  // most recently active PAGE_SIZE and grow it as the advisor scrolls. Live refreshes
  // (SSE/poll) re-fetch this same growing count, not a fixed page, so scrolling down
  // doesn't get silently truncated back to the top page on the next update.
  const PAGE_SIZE = 50;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const isUnreadFilter = ticketStatusFilter === UNREAD_FILTER;
      // Unread is fetched whole, never paginated — it's always a small slice, and
      // capping it the same way as the plain list silently hid real unread threads
      // that fell outside the recency window (the bug reported 2026-08-26).
      const data = isUnreadFilter
        ? await fetchConversations(search, temperature, '', undefined, true)
        : await fetchConversations(search, temperature, ticketStatusFilter, visibleCount);
      setConversations(data);
      setHasMore(isUnreadFilter ? false : data.length >= visibleCount);
    } catch (err) {
      setError(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [search, temperature, ticketStatusFilter, visibleCount]);

  // A new search/filter is a fresh list — start back at one page of it.
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, temperature, ticketStatusFilter]);

  useEffect(() => { load(); }, [load]);

  // Global message search — every chat, not just the one open. Separate from the
  // name/phone filter above; both run off the same search box, shown as two sections.
  useEffect(() => {
    const q = search.trim();
    if (!q) { setGlobalResults([]); return; }
    let cancelled = false;
    setGlobalSearching(true);
    const t = setTimeout(() => {
      searchAllConversations(q)
        .then((rows) => { if (!cancelled) setGlobalResults(rows); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setGlobalSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);

  function jumpToGlobalResult(result) {
    setSearch('');
    if (result.sessionId === selectedId) {
      jumpToMessage(result.id, result.distanceFromLatest);
    } else {
      pendingJumpRef.current = { id: result.id, distanceFromLatest: result.distanceFromLatest };
      setSelectedId(result.sessionId);
    }
  }

  const loadQuiet = useCallback(() => load(false), [load]);
  useLiveEvent('message_changes', loadQuiet);
  useLiveEvent('ticket_changes', loadQuiet);
  // Another advisor opening this same thread marks it read for the whole team —
  // this is what keeps everyone's unread badges in sync in real time.
  useLiveEvent('read_changes', loadQuiet);

  // SSE (above) is the fast path — this is just a safety net in case that connection
  // silently drops, so it doesn't need to be nearly as tight as before.
  useEffect(() => {
    const id = setInterval(() => load(false), 30000);
    return () => clearInterval(id);
  }, [load]);

  // Coming from "Tomar" in the Pipeline board — jump straight to that chat
  // instead of leaving the advisor to hunt for it in the list.
  useEffect(() => {
    if (!openSessionId) return;
    setSelectedId(openSessionId);
    onOpenedConversation?.();
  }, [openSessionId, onOpenedConversation]);

  // A long thread used to load in full on every open, every 15s poll, and every live
  // event — same "loads everything, gets slower as it grows" problem as the list.
  // Starts at the most recent THREAD_PAGE_SIZE and grows when the advisor scrolls up.
  const THREAD_PAGE_SIZE = 50;
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE_SIZE);
  const loadingOlderRef = useRef(false);
  const scrollRestoreRef = useRef(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const searchJumpRef = useRef(null);
  // Set right before switching to a chat opened from a global search result — read once
  // by the [selectedId] reset effect below, so the very first fetch for that chat is
  // already sized to include the target message instead of a second grow-and-refetch.
  const pendingJumpRef = useRef(null);
  // A customer's native WhatsApp quote-reply that points at a message older than the
  // loaded page — fetched one at a time and cached here so the preview can still show
  // what they replied to instead of rendering the reply as a context-less fragment.
  const quoteFetchedRef = useRef(new Set());
  const [quoteCache, setQuoteCache] = useState({});
  // The advisor's own reply button snapshots the quoted content at send time — nothing
  // to fetch to render it, only how far back it is, to size the window before jumping.
  const distanceFetchedRef = useRef(new Set());
  const [distanceCache, setDistanceCache] = useState({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const loadThread = useCallback(() => {
    if (!selectedId) { setThread(null); return; }
    fetchConversation(selectedId, threadLimit)
      .then((t) => { setThread(t); setThreadError(null); })
      .catch((err) => setThreadError(err.message));
  }, [selectedId, threadLimit]);

  useEffect(() => {
    // Clears the PREVIOUS chat's messages immediately, before the new one's have even
    // started loading — the compose box only renders when `thread` is set, so this is
    // what makes it disappear the instant you switch chats instead of staying up (still
    // showing the old conversation, still accepting input) until the new fetch resolves.
    // Under real lag that gap was long enough for an advisor to type a reply while still
    // looking at the previous customer's messages and send it to whoever was newly
    // selected instead — this closes that window at the root instead of just making
    // loads faster (2026-08-31).
    setThread(null);
    // A global search result for a chat that wasn't already open sets this before
    // switching — sized here instead of the default page, so the target message is
    // already inside the first fetch instead of needing a second grow-and-refetch.
    const pending = pendingJumpRef.current;
    pendingJumpRef.current = null;
    if (pending) {
      setThreadLimit(Math.max(THREAD_PAGE_SIZE, pending.distanceFromLatest + 10));
      searchJumpRef.current = pending.id;
    } else {
      setThreadLimit(THREAD_PAGE_SIZE);
    }
    // Stays open across chats on desktop — closing it every switch meant re-opening it by
    // hand on almost every chat, since checking the customer's info is normal, not
    // exceptional. On mobile it's a full-screen overlay, not a side column, so opening it
    // automatically would bury the chat the advisor just tapped into — stays opt-in there.
    setInfoOpen(isDesktopViewport());
    setReplyingTo(null);
    setThreadError(null);
    // Left uncleared before, this was a real mis-send risk: an advisor types for
    // customer A, the send is slow, they switch to customer B while it's in flight —
    // the leftover text was still sitting in B's compose box and could get sent to B
    // by mistake. Wiping it on every switch is the only way to guarantee that never
    // happens, even at the cost of losing an unsent draft when you switch away.
    setDraft('');
    // Same reasoning as the draft above — staged-but-unsent attachments must not
    // silently ride along to whatever chat is open when they'd otherwise have been sent.
    setStagedFiles((prev) => { for (const f of prev) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); return []; });
    lastMessageIdRef.current = null; // switching threads always scrolls to bottom once, below
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    quoteFetchedRef.current = new Set();
    setQuoteCache({});
    distanceFetchedRef.current = new Set();
    setDistanceCache({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => { loadThread(); }, [loadThread]);

  // Presence: a snapshot once on mount (SSE only carries FUTURE events, so a tab opened
  // after others already have chats up needs this to know current state), then kept
  // current from live presence_changes pushes — no re-fetching, just applying each delta,
  // since this can fire often (every advisor's heartbeat) and a full reload per event
  // would be wasteful for what's just "highlight/un-highlight one row".
  useEffect(() => {
    let cancelled = false;
    fetchPresenceSnapshot().then((rows) => {
      if (cancelled) return;
      const map = {};
      for (const r of rows) map[r.sessionId] = { userId: r.userId, fullName: r.fullName };
      setPresenceBySession(map);
    }).catch(() => {});
    const unsubscribe = onLiveEvent('presence_changes', (data) => {
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      const { sessionId, userId, fullName } = payload;
      setPresenceBySession((prev) => {
        const next = { ...prev };
        if (userId) next[sessionId] = { userId, fullName };
        else delete next[sessionId];
        return next;
      });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // Heartbeat while a chat is open — tells everyone else's list to highlight it. Renewed
  // every 20s (server treats anything older than 45s as stale and clears it on its own,
  // covering a crashed tab or lost connection); an explicit leave fires immediately on
  // switching away or closing, so the highlight doesn't linger for the ~45s window that
  // safety-net sweep exists for.
  useEffect(() => {
    if (!selectedId) return;
    sendPresenceHeartbeat(selectedId).catch(() => {});
    const interval = setInterval(() => sendPresenceHeartbeat(selectedId).catch(() => {}), 20000);
    return () => {
      clearInterval(interval);
      leavePresence(selectedId).catch(() => {});
    };
  }, [selectedId]);

  // Fetches, one time each, the original message behind any quote-reply that isn't in
  // the currently-loaded page — a ref (not quoteCache itself) tracks "already tried" so
  // this doesn't refetch on every poll/live refresh of the thread.
  useEffect(() => {
    if (!thread || !selectedId) return;
    const localWamids = new Set(thread.messages.map((m) => m.additional_kwargs?.wamid).filter(Boolean));
    const missing = [...new Set(
      thread.messages
        .map((m) => m.additional_kwargs?.replyToWamid)
        .filter((w) => w && !localWamids.has(w) && !quoteFetchedRef.current.has(w))
    )];
    for (const wamid of missing) {
      quoteFetchedRef.current.add(wamid);
      fetchMessageByWamid(selectedId, wamid)
        .then((orig) => setQuoteCache((prev) => ({ ...prev, [wamid]: orig })))
        .catch(() => {});
    }
  }, [thread, selectedId]);

  // Same idea for the advisor's own reply-button quotes — the content is already in
  // additional_kwargs.replyTo, only the distance needs fetching, and only when the
  // target isn't already loaded (jumpToMessage would find it locally otherwise).
  useEffect(() => {
    if (!thread || !selectedId) return;
    const localIds = new Set(thread.messages.map((m) => m.id));
    const missing = [...new Set(
      thread.messages
        .map((m) => m.additional_kwargs?.replyTo?.id)
        .filter((id) => id != null && !localIds.has(id) && !distanceFetchedRef.current.has(id))
    )];
    for (const id of missing) {
      distanceFetchedRef.current.add(id);
      fetchMessageDistance(selectedId, id)
        .then(({ distanceFromLatest }) => setDistanceCache((prev) => ({ ...prev, [id]: distanceFromLatest })))
        .catch(() => {});
    }
  }, [thread, selectedId]);

  // Searches the whole thread server-side, not just the currently-loaded page.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !selectedId) { setSearchResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchConversation(selectedId, q)
        .then((rows) => { if (!cancelled) setSearchResults(rows); })
        .catch((err) => { if (!cancelled) showError(err.message); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [searchQuery, selectedId]);

  // Shared by search results and quote-preview clicks: a target older than what's
  // currently loaded needs a bigger window before it exists in the DOM to scroll to —
  // grown here, then jumped to once that reload lands (see the [thread] effect above).
  function jumpToMessage(id, distanceFromLatest) {
    if (thread?.messages.some((m) => m.id === id)) {
      scrollToMessage(id);
      return;
    }
    if (distanceFromLatest == null) return; // no way to size the window — nothing to do
    searchJumpRef.current = id;
    setThreadLimit(distanceFromLatest + 10);
  }

  function jumpToSearchResult(result) {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    jumpToMessage(result.id, result.distanceFromLatest);
  }

  // Scrolling near the top asks for an older page instead of relying on the poll/live
  // refresh, which only ever re-fetches the currently-loaded window.
  function handleThreadScroll(e) {
    const el = e.currentTarget;
    if (el.scrollTop < 100 && thread?.hasMoreOlder && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      scrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
      setThreadLimit((n) => n + THREAD_PAGE_SIZE);
    }
  }

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
    const container = scrollContainerRef.current;

    // This update just grew the window to fit a search result found further back than
    // what was loaded — jump straight to it instead of running the usual first-load or
    // new-message scroll logic.
    if (searchJumpRef.current != null) {
      const targetId = searchJumpRef.current;
      searchJumpRef.current = null;
      lastMessageIdRef.current = lastId;
      setTimeout(() => scrollToMessage(targetId), 50);
      setTimeout(() => scrollToMessage(targetId), 350);
      return;
    }

    // This update just prepended an older page the advisor asked for by scrolling up —
    // restore the exact spot they were looking at instead of jumping anywhere.
    if (loadingOlderRef.current) {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      lastMessageIdRef.current = lastId;
      const restore = scrollRestoreRef.current;
      if (container && restore) {
        container.scrollTop = container.scrollHeight - restore.height + restore.top;
      }
      return;
    }

    if (lastId === lastMessageIdRef.current) return;
    const isFirstLoadForThread = lastMessageIdRef.current === null;
    const nearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    lastMessageIdRef.current = lastId;

    // Direct scrollTop instead of scrollIntoView, reapplied after paint and again
    // shortly after — attachment images finish loading late and grow the container,
    // which otherwise leaves the view sitting above the true bottom.
    const scrollToBottom = () => {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    };

    if (isFirstLoadForThread) {
      // Opening a chat with unread messages waiting should land right on the first one
      // of those, not dump the advisor at the newest message assuming they'll scroll up
      // to find where they left off.
      const unreadCount = selected?.unreadCount ?? 0;
      const humanMessages = thread.messages.filter((m) => m.type === 'human');
      const firstUnread = unreadCount > 0 ? humanMessages[Math.max(0, humanMessages.length - unreadCount)] : null;
      if (firstUnread) {
        setTimeout(() => scrollToMessage(firstUnread.id), 50);
        setTimeout(() => scrollToMessage(firstUnread.id), 350);
        return;
      }
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      setTimeout(scrollToBottom, 300);
    } else if (nearBottom) {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      setTimeout(scrollToBottom, 300);
    }
  }, [thread]);

  // Fires the actual network request for one optimistic entry, entirely in the
  // background — nothing in the compose box is waiting on this. Success removes the
  // local bubble (the real message is already in the DB by the time our request
  // resolves, so the next loadThread() picks it up); failure leaves it in place marked
  // failed, with its content intact, so "reintentar" can fire the exact same request
  // again without the advisor having to retype anything.
  async function sendPendingEntry(targetId, entry) {
    try {
      if (entry.file) {
        await sendConversationAttachment(targetId, entry.file, entry.caption);
      } else {
        await sendConversationMessage(targetId, entry.content, entry.replyTo ?? undefined);
      }
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      setPendingSends((prev) => ({ ...prev, [targetId]: (prev[targetId] ?? []).filter((p) => p.localId !== entry.localId) }));
      if (selectedId === targetId) loadThread();
    } catch (err) {
      setPendingSends((prev) => ({
        ...prev,
        [targetId]: (prev[targetId] ?? []).map((p) => (p.localId === entry.localId ? { ...p, status: 'failed', error: err.message } : p)),
      }));
    }
  }

  function retryPendingEntry(targetId, entry) {
    setPendingSends((prev) => ({
      ...prev,
      [targetId]: (prev[targetId] ?? []).map((p) => (p.localId === entry.localId ? { ...p, status: 'sending', error: null } : p)),
    }));
    sendPendingEntry(targetId, entry);
  }

  function dismissPendingEntry(targetId, localId) {
    setPendingSends((prev) => {
      const list = prev[targetId] ?? [];
      const entry = list.find((p) => p.localId === localId);
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      return { ...prev, [targetId]: list.filter((p) => p.localId !== localId) };
    });
  }

  function handleSend(e) {
    e?.preventDefault();
    const targetId = selectedId;
    const content = draft.trim();
    const target = replyingTo;
    const files = stagedFiles;
    if (!content && !files.length) return;

    // The compose box clears and refocuses immediately — it never waits for the send
    // to actually complete, so the advisor can keep typing the next message right away
    // (only for the chat currently open — switching away wipes the draft anyway, same
    // mis-send protection as before).
    if (selectedId === targetId) {
      setDraft('');
      setReplyingTo(null);
      setStagedFiles([]);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }

    const entries = files.length
      // Whatever's typed rides along as the caption on the first file — same gesture
      // as WhatsApp itself (write, then attach several, sends as one batch). Each file
      // is its own bubble/message, same as the backend already treats them.
      ? files.map((f, i) => ({
          localId: `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
          file: f.file,
          previewUrl: f.previewUrl,
          caption: i === 0 ? (content || undefined) : undefined,
          status: 'sending',
        }))
      : [{
          localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          content,
          replyTo: target,
          status: 'sending',
        }];

    setPendingSends((prev) => ({ ...prev, [targetId]: [...(prev[targetId] ?? []), ...entries] }));
    for (const entry of entries) sendPendingEntry(targetId, entry);
  }

  async function handleTake() {
    if (!thread) return;
    setActionBusy(true);
    try {
      if (thread.ticketId) {
        await updateTicket(thread.ticketId, { status: 'en_atencion', assigned_advisor: user.fullName });
      } else {
        // Bot state — no ticket exists yet at all (handoff never fired, or never needed
        // to). Opens one straight into en_atencion so the advisor can respond.
        await takeConversation(selectedId);
      }
      await loadThread();
      load(false);
      showSuccess('Conversación asignada a ti');
    } catch (err) {
      showError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleMarkUnread() {
    if (!selectedId) return;
    setActionBusy(true);
    try {
      await markConversationUnread(selectedId);
      // Close the thread — staying on it would poll GET /:sessionId again within
      // seconds and immediately re-mark it read, undoing this.
      setSelectedId(null);
      load(false);
      showSuccess('Marcado como no leído');
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

  // Adds files to the staging strip instead of sending immediately — lets an advisor
  // attach several photos or documents and send them together as one batch.
  function stageFiles(files) {
    const staged = files.map((file) => ({
      file,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));
    setStagedFiles((prev) => [...prev, ...staged]);
  }

  function removeStagedFile(id) {
    setStagedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  }

  function handleFileSelected(e) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) stageFiles(files);
  }

  // Lets an advisor Ctrl+V a copied screenshot/image straight into the chat,
  // same as WhatsApp Web — no need to save it to disk first just to attach it.
  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          stageFiles([file]);
        }
        return;
      }
    }
  }

  async function handleSetStatus(value) {
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

  // "False alarm" for the payment-suggestion banner — the customer said something that
  // matched the trigger's keywords but wasn't actually a payment. Doesn't touch
  // paidLocked at all, just clears the flag so the banner stops showing.
  async function handleDismissPaymentSuggestion() {
    if (!thread?.customerId) return;
    try {
      await updateCustomerTags(thread.customerId, { dismissPaymentSuggestion: true });
      await loadThread();
    } catch (err) {
      showError(err.message);
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
    <div className="flex h-full min-w-0 overflow-hidden md:rounded-3xl">
      {/* Conversation list — mirrors WhatsApp's left rail. On mobile there's no room for
          this next to the thread at the same time, so it's the whole screen until a chat
          is opened, then it hides entirely (selecting a chat is the "navigate" action) —
          same one-pane-at-a-time pattern WhatsApp's own mobile app uses. */}
      <div className={`w-full md:w-[380px] md:max-w-[45vw] shrink-0 flex-col border-r border-line ${selectedId ? 'hidden md:flex' : 'flex'}`}>
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
          <Select value={temperature} onChange={setTemperature} options={TEMP_FILTER_OPTIONS} />
          <Select
            value={ticketStatusFilter}
            onChange={setTicketStatusFilter}
            options={TICKET_STATUS_FILTER_OPTIONS}
            className="mt-2"
          />
        </div>

        <div
          className="relative flex-1 overflow-y-auto"
          onScroll={(e) => {
            if (!hasMore || loading) return;
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
              setVisibleCount((n) => n + 10);
            }
          }}
        >
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
          {search.trim() && (globalResults.length > 0 || globalSearching) && (
            <div className="border-b border-line-soft">
              <p className="px-4 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-greige-ink">
                Mensajes {globalSearching && <Loader2 size={10} className="ml-1 inline animate-spin" />}
              </p>
              {globalResults.map((r) => (
                <button
                  key={r.id}
                  onClick={() => jumpToGlobalResult(r)}
                  className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                >
                  <Avatar name={r.customerName || r.phone} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-ink">{r.customerName || r.phone}</p>
                      <span className="shrink-0 text-[11px] text-greige-ink">{formatListTime(r.createdAt)}</span>
                    </div>
                    <p className="truncate text-xs text-greige-ink">{highlightMatch(r.content, search)}</p>
                  </div>
                </button>
              ))}
              {!globalSearching && globalResults.length === 0 && (
                <p className="px-4 pb-2 text-xs text-greige-ink">Sin mensajes que coincidan.</p>
              )}
            </div>
          )}
          {search.trim() && conversations.length > 0 && (
            <p className="px-4 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-greige-ink">Chats</p>
          )}
          {!loading && conversations.length === 0 && globalResults.length === 0 && !globalSearching && (
            <p className="p-4 text-sm text-greige-ink">Sin conversaciones.</p>
          )}
          {conversations.map((c) => {
            const name = c.customerName || c.phone || c.sessionId.slice(0, 12);
            const unread = c.unreadCount ?? 0;
            // Someone (possibly me, on another tab/device) currently has this chat open —
            // see the presence effects above. Local selection always wins visually; my own
            // presence elsewhere gets a neutral dark tint, everyone else gets their own
            // avatar color, low-opacity so the text underneath stays readable.
            const presence = presenceBySession[c.sessionId];
            const isMyPresence = presence?.userId === user.id;
            const isSelected = c.sessionId === selectedId;
            return (
              <button
                key={c.sessionId}
                onClick={() => {
                  setSelectedId(c.sessionId);
                  // Optimistic — the server marks it read as soon as the thread loads,
                  // this just avoids a visible lag before that round-trip lands.
                  if (unread > 0) {
                    setConversations((prev) => prev.map((x) => (x.sessionId === c.sessionId ? { ...x, unreadCount: 0 } : x)));
                  }
                }}
                title={presence && !isSelected ? `${presence.fullName || 'Alguien'} tiene este chat abierto` : undefined}
                className={`flex w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left transition-colors ${
                  isSelected
                    ? 'bg-accent-soft'
                    : isMyPresence
                      ? 'bg-black/10 dark:bg-white/15'
                      : presence
                        ? ''
                        : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'
                }`}
                style={presence && !isMyPresence && !isSelected ? { backgroundColor: hexToRgba(colorFor(presence.fullName), 0.14) } : undefined}
              >
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink">{name}</p>
                    <span className="shrink-0 text-[11px] text-greige">{formatListTime(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className={`truncate text-xs ${unread ? 'font-semibold text-ink' : 'text-greige-ink'}`}>
                      {(typeof c.lastMessage?.content === 'string' && c.lastMessage.content.trim())
                        || describeAttachment(c.lastAttachment)}
                    </p>
                    <div className="flex shrink-0 items-center gap-1">
                    {unread > 0 && (
                      <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                    {c.paymentSuggested && !c.paidLocked && (
                      <span title="Posible pago detectado" className="flex shrink-0 items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-semibold text-success">
                        <CircleDollarSign size={10} /> pago?
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
                      c.assignedAdvisor ? (
                        // Whoever actually took the ticket, by name and in their own
                        // color — permanent (from the ticket record), unlike the row
                        // tint above which is only live "someone's looking at it now".
                        <span
                          className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          style={{ backgroundColor: hexToRgba(colorFor(c.assignedAdvisor), 0.16), color: colorFor(c.assignedAdvisor) }}
                        >
                          <Headset size={10} /> {c.assignedAdvisor.split(' ')[0]}
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent">
                          <Headset size={10} /> asesor
                        </span>
                      )
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
                    {!c.ticketStatus && isUnansweredBroadcast(c.lastMessage) && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-cyan-bg px-2 py-0.5 text-[10px] font-semibold text-cyan">
                        <Megaphone size={10} /> difusión
                      </span>
                    )}
                    {!c.ticketStatus && !isUnansweredBroadcast(c.lastMessage) && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-greige-ink">
                        <Bot size={10} /> agente
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

      {/* Thread — the mirror of the list's rule above: full screen once a chat is open,
          hidden on mobile otherwise (the empty state has nothing useful to say twice). */}
      <div className={`min-w-0 flex-1 flex-col bg-black/[0.015] dark:bg-white/[0.02] ${selectedId ? 'flex' : 'hidden md:flex'}`}>
        {!thread && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-greige-ink">
            {threadError ? (
              <>
                <p className="text-danger">Error al cargar la conversación</p>
                <button onClick={loadThread} className="text-xs font-semibold text-accent hover:underline">
                  Reintentar
                </button>
              </>
            ) : selectedId ? (
              <>
                <Loader2 size={28} strokeWidth={1.5} className="animate-spin text-greige" />
                Cargando conversación…
              </>
            ) : (
              <>
                <MessageCircle size={32} strokeWidth={1.5} className="text-greige" />
                Selecciona una conversación para ver los mensajes.
              </>
            )}
          </div>
        )}
        {thread && (
          <>
            <button
              onClick={() => setInfoOpen((v) => !v)}
              className="flex w-full flex-col gap-2 border-b border-line bg-paper px-5 py-3 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
            >
              {/* Row 1: identity + always-available actions — never wraps, so it never
                  competes for space with the status pills below. */}
              <div className="flex items-center gap-3">
                {/* Mobile-only: WhatsApp-style back arrow to return to the chat list */}
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); setSelectedId(null); }}
                  className="-ml-1 flex shrink-0 items-center justify-center rounded-full p-1.5 text-greige-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] md:hidden"
                >
                  <ArrowLeft size={18} />
                </span>
                <Avatar name={thread.customerName || thread.phone} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">
                    {thread.customerName || thread.phone || selected?.sessionId.slice(0, 12)}
                  </p>
                  <p className="text-xs text-greige-ink">{thread.phone}</p>
                </div>
                <span
                  role="button"
                  title="Buscar en la conversación"
                  onClick={(e) => { e.stopPropagation(); setSearchOpen((v) => !v); }}
                  className="flex shrink-0 items-center rounded-full p-1.5 text-greige transition-colors hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.06]"
                >
                  <Search size={15} />
                </span>
                <Info size={16} className="shrink-0 text-greige" />
              </div>

              {/* Row 2: ticket-status pill + advisor actions — wraps freely, so a long
                  label (e.g. "Difusión enviada — sin respuesta") next to "Tomar
                  conversación" never overflows a narrow phone screen. */}
              <div className="flex flex-wrap items-center gap-2 pl-0 md:pl-[52px]">
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
                  <>
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
                  </>
                )}
                {thread.ticketStatus === 'resuelto' && (
                  <span className="flex items-center gap-1.5 rounded-full bg-ok/10 px-2.5 py-1 text-xs font-medium text-ok">
                    <CheckCircle2 size={12} /> Resuelto — puedes seguir escribiendo
                  </span>
                )}
                {!thread.ticketStatus && (
                  <>
                    {isUnansweredBroadcast(thread.messages[thread.messages.length - 1]) ? (
                      <span className="flex items-center gap-1.5 rounded-full bg-cyan-bg px-2.5 py-1 text-xs font-medium text-cyan">
                        <Megaphone size={12} /> Difusión enviada — sin respuesta
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-greige-ink">
                        <Bot size={12} /> Agente activo
                      </span>
                    )}
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); handleTake(); }}
                      className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white shadow-md shadow-accent/20 transition-opacity hover:opacity-90"
                    >
                      <Headset size={12} /> {actionBusy ? '...' : 'Tomar conversación'}
                    </span>
                  </>
                )}
                {thread.messages[thread.messages.length - 1]?.type === 'human' && (
                  <span
                    role="button"
                    title="Marcar como no leído"
                    onClick={(e) => { e.stopPropagation(); handleMarkUnread(); }}
                    className="flex items-center gap-1.5 rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-greige-ink transition-colors hover:bg-accent hover:text-white"
                  >
                    <Mail size={12} /> Marcar como no leído
                  </span>
                )}
              </div>
            </button>

            {searchOpen && (
              <div className="relative border-b border-line bg-paper px-5 py-2.5" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2">
                  <Search size={14} className="shrink-0 text-greige" />
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Buscar mensajes en este chat…"
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-greige"
                  />
                  {searching && <Loader2 size={13} className="shrink-0 animate-spin text-greige" />}
                  <button onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }} className="shrink-0 text-greige hover:text-ink">
                    <X size={14} />
                  </button>
                </div>
                {searchQuery.trim() && !searching && searchResults.length === 0 && (
                  <p className="mt-2 text-xs text-greige-ink">Sin resultados.</p>
                )}
                {searchResults.length > 0 && (
                  <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {searchResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => jumpToSearchResult(r)}
                        className="rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                      >
                        <span className="text-greige-ink">{formatBubbleTime(r.createdAt)} · </span>
                        <span className="text-ink">{r.content ? highlightMatch(r.content.slice(0, 120), searchQuery) : '(sin texto)'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {thread.paymentSuggestedAt && !thread.paidLocked && (
              // Set by a Postgres trigger watching for confirmation phrases/a customer
              // photo (db/init/032) — a suggestion only, never auto-marks paid_locked.
              <div className="flex flex-wrap items-center gap-2.5 border-b border-success-bg bg-success-bg/40 px-5 py-2.5">
                <CircleDollarSign size={15} className="shrink-0 text-success" />
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink">
                  <span className="font-semibold">Posible pago detectado.</span>{' '}
                  {thread.paymentSuggestionReason}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setPaidMethod(thread.paymentSuggestionMethod || ''); setConfirmPaidOpen(true); }}
                    className="rounded-full bg-success px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    Marcar como Pagado
                  </button>
                  <button
                    type="button"
                    onClick={handleDismissPaymentSuggestion}
                    className="rounded-full px-2.5 py-1.5 text-xs font-medium text-greige-ink transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              <div ref={scrollContainerRef} onScroll={handleThreadScroll} className="flex-1 space-y-1 overflow-y-auto px-6 py-4">
                {loadingOlder && (
                  <p className="py-2 text-center text-xs text-greige-ink">Cargando mensajes anteriores…</p>
                )}
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
                        ? (fromAdvisor ? m.additional_kwargs.advisorName : 'Studio F (Agente)')
                        : (thread.customerName || thread.phone);
                      // Two ways a message can be "a reply": the advisor composed it with
                      // our reply button (snapshot already stored in additional_kwargs.replyTo),
                      // or the customer used WhatsApp's own quote feature — in that case we only
                      // got the wamid of the original, so look it up in this same thread by the
                      // wamid we stamped on our own outgoing messages (or captured on theirs).
                      const quotePreview = m.additional_kwargs?.replyTo
                        ? { ...m.additional_kwargs.replyTo, distanceFromLatest: distanceCache[m.additional_kwargs.replyTo.id] }
                        : (() => {
                        const targetWamid = m.additional_kwargs?.replyToWamid;
                        if (!targetWamid) return null;
                        const orig = thread.messages.find((x) => x.additional_kwargs?.wamid === targetWamid) ?? quoteCache[targetWamid];
                        if (!orig) return null;
                        const origOutgoing = orig.type === 'ai';
                        const origFromAdvisor = orig.additional_kwargs?.sentBy === 'advisor';
                        const origFrom = origOutgoing ? (origFromAdvisor ? orig.additional_kwargs.advisorName : 'Studio F (Agente)') : (thread.customerName || thread.phone);
                        return { ...describeQuoted(orig, origFrom), id: orig.id, distanceFromLatest: orig.distanceFromLatest };
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
                                <p className="mb-0.5 text-[11px] font-semibold text-white">
                                  {m.additional_kwargs.advisorName}
                                </p>
                              )}
                              {m.additional_kwargs?.referral && (
                                <a
                                  href={m.additional_kwargs.referral.source_url || undefined}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`mb-2 block w-64 max-w-full overflow-hidden rounded-xl border ${
                                    outgoing ? 'border-white/30 bg-white/10' : 'border-line-soft bg-black/[0.03] dark:bg-white/[0.05]'
                                  }`}
                                >
                                  {/* When the message also carries a real attachment (WhatsApp
                                      often re-delivers the ad's own photo as the actual attached
                                      image on the first ad-referred message), skip the thumbnail
                                      here — showing it twice back to back reads as one duplicated,
                                      overlapping photo. The card below still renders it as the
                                      full attachment. */}
                                  {(m.additional_kwargs.referral.thumbnail_url || m.additional_kwargs.referral.image_url) && !m.attachment ? (
                                    <img
                                      src={m.additional_kwargs.referral.thumbnail_url || m.additional_kwargs.referral.image_url}
                                      alt=""
                                      loading="lazy"
                                      decoding="async"
                                      className="aspect-square w-full object-cover"
                                    />
                                  ) : (
                                    <span className={`flex aspect-square w-full items-center justify-center ${outgoing ? 'bg-white/15' : 'bg-black/5 dark:bg-white/10'}`}>
                                      <Megaphone size={22} />
                                    </span>
                                  )}
                                  <div className="px-3 py-2.5">
                                    <p className={`mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${outgoing ? 'text-white' : 'text-accent'}`}>
                                      <Megaphone size={12} />
                                      Anuncio de {/instagram\.com/i.test(m.additional_kwargs.referral.source_url || '') ? 'Instagram' : 'Facebook'}
                                    </p>
                                    <p className={`text-sm font-semibold leading-snug ${outgoing ? 'text-white' : 'text-ink'}`}>
                                      {m.additional_kwargs.referral.headline || 'Publicidad de Meta'}
                                    </p>
                                    {m.additional_kwargs.referral.body && (
                                      <p className={`mt-0.5 line-clamp-2 text-xs leading-snug ${outgoing ? 'text-white/90' : 'text-greige-ink'}`}>
                                        {m.additional_kwargs.referral.body}
                                      </p>
                                    )}
                                  </div>
                                </a>
                              )}
                              {quotePreview && (
                                <div
                                  onClick={() => quotePreview.id != null && jumpToMessage(quotePreview.id, quotePreview.distanceFromLatest)}
                                  className={`mb-1.5 flex items-center gap-2 rounded-md border-l-[3px] px-2.5 py-1.5 text-xs leading-snug ${
                                    quotePreview.id != null ? 'cursor-pointer' : ''
                                  } ${outgoing ? 'border-white/70 bg-white/10' : 'border-accent bg-black/[0.04] dark:bg-white/[0.06]'}`}
                                >
                                  {quotePreview.attachmentKind === 'image' && quotePreview.attachmentId && (
                                    <img
                                      src={attachmentUrl(quotePreview.attachmentId)}
                                      alt=""
                                      loading="lazy"
                                      decoding="async"
                                      className="h-9 w-9 shrink-0 rounded object-cover"
                                    />
                                  )}
                                  <div className="min-w-0">
                                    <p className={`font-semibold ${outgoing ? 'text-white' : 'text-accent'}`}>
                                      {quotePreview.from || '—'}
                                    </p>
                                    <p className={`truncate ${outgoing ? 'text-white/90' : 'text-greige-ink'}`}>
                                      {quotePreview.content || '📎 Adjunto'}
                                    </p>
                                  </div>
                                </div>
                              )}
                              {m.attachment && (
                                <AttachmentContent attachment={m.attachment} outgoing={outgoing} onImageClick={setLightboxUrl} />
                              )}
                              {m.content?.trim() && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
                              <span
                                className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] ${
                                  outgoing ? 'text-white/85' : 'text-greige'
                                }`}
                              >
                                {formatBubbleTime(m.createdAt)}
                                {outgoing && (
                                  <MessageTicks
                                    status={m.additional_kwargs?.status}
                                    statusError={m.additional_kwargs?.statusError}
                                    onRetry={() => handleRetry(m.id)}
                                    retrying={retryingId === m.id}
                                  />
                                )}
                              </span>
                            </div>
                          </div>
                          {!outgoing && replyButton}
                        </motion.div>
                      );
                    })}
                  </div>
                ))}
                {(pendingSends[selectedId] ?? []).map((entry) => (
                  <div key={entry.localId} className="mb-1.5 flex justify-end">
                    <div className="max-w-[70%] rounded-2xl rounded-tr-none px-3.5 py-2 text-sm leading-relaxed text-white shadow-sm" style={{ backgroundColor: 'var(--accent)', opacity: entry.status === 'failed' ? 1 : 0.7 }}>
                      {entry.file ? (
                        <p className="flex items-center gap-1.5">
                          {entry.previewUrl
                            ? <img src={entry.previewUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                            : <FileText size={14} className="shrink-0" />}
                          <span className="truncate">{entry.file.name}</span>
                        </p>
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{entry.content}</p>
                      )}
                      <span className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] text-white/90">
                        {entry.status === 'sending' ? (
                          <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> enviando…</span>
                        ) : (
                          <span className="flex items-center gap-1.5" title={entry.error}>
                            <AlertTriangle size={11} /> no se pudo enviar
                            <button
                              type="button"
                              onClick={() => retryPendingEntry(selectedId, entry)}
                              className="underline decoration-dotted underline-offset-2 hover:text-white"
                            >
                              reintentar
                            </button>
                            <button
                              type="button"
                              onClick={() => dismissPendingEntry(selectedId, entry.localId)}
                              className="hover:text-white"
                              aria-label="Descartar"
                            >
                              <X size={11} />
                            </button>
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              {infoOpen && (
                // Full screen on mobile — a partial-width panel with a backdrop reads as a
                // "floating window" rather than a real screen of the app, and clips its own
                // content against the edge. On desktop it's just the third column, as before.
                <div className="fixed inset-0 z-40 overflow-y-auto bg-paper p-5 md:static md:inset-auto md:z-auto md:w-72 md:shrink-0 md:border-l md:border-line">
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
                      <Select
                        value={thread.manualStatus ?? ''}
                        onChange={handleSetStatus}
                        options={[
                          { value: '', label: `Automático (${TEMP_META[thread.temperature]?.label ?? '—'})` },
                          ...BUCKET_ORDER.map((k) => ({
                            value: k, label: TEMP_META[k].label, icon: TEMP_META[k].icon, iconClassName: TEMP_META[k].iconText,
                          })),
                        ]}
                      />
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

                  {/* Only shows up when this phone matches a real purchase record in the
                      ERP — a brand-new WhatsApp lead with no store history just doesn't
                      get this section, same profile as before this existed. */}
                  {thread.erp && (
                    <div className="mt-6 border-t border-line-soft pt-5">
                      <div className="mb-3 flex items-center gap-1.5">
                        <span className="flex items-center gap-1 rounded-full bg-cyan-bg px-2 py-0.5 text-[10px] font-semibold text-cyan">
                          <CircleDollarSign size={10} /> Cliente ERP
                        </span>
                        <p className="truncate text-xs text-greige-ink">{thread.erp.nombre}</p>
                      </div>
                      <div className="flex flex-col gap-4">
                        <InfoRow icon={CircleDollarSign} label="Venta total histórica" value={thread.erp.ventaNetaTotal != null ? `Q${Number(thread.erp.ventaNetaTotal).toLocaleString('es-GT')}` : '—'} />
                        <InfoRow icon={ShoppingBag} label="Facturas / unidades" value={`${thread.erp.facturasTotales ?? 0} facturas · ${thread.erp.unidadesTotales ?? 0} unidades`} />
                        <InfoRow icon={Clock} label="Última compra" value={thread.erp.fechaUltimaCompra ? `${new Date(thread.erp.fechaUltimaCompra).toLocaleDateString('es-GT', { timeZone: 'UTC' })} (${thread.erp.diasSinCompra} días)` : '—'} />
                        <InfoRow icon={MapPin} label="Sucursal preferida" value={thread.erp.sucursalPreferida || '—'} />
                        <InfoRow
                          icon={ShoppingBag}
                          label="Interés por línea"
                          value={
                            [['Blusas', thread.erp.blusas], ['Jeans', thread.erp.jeans], ['Vestidos', thread.erp.vestidos], ['Pantalones', thread.erp.pantalones], ['Otros', thread.erp.otros]]
                              .filter(([, n]) => n > 0)
                              .sort((a, b) => b[1] - a[1])
                              .map(([label, n]) => `${label} (${n})`)
                              .join(', ') || '—'
                          }
                        />
                        {(thread.erp.tallaBlusa || thread.erp.tallaJean || thread.erp.tallaCalzado) && (
                          <InfoRow
                            icon={ShoppingBag}
                            label="Tallas (histórico ERP)"
                            value={[thread.erp.tallaBlusa && `Blusa ${thread.erp.tallaBlusa}`, thread.erp.tallaJean && `Jean ${thread.erp.tallaJean}`, thread.erp.tallaCalzado && `Calzado ${thread.erp.tallaCalzado}`].filter(Boolean).join(' · ')}
                          />
                        )}
                      </div>
                    </div>
                  )}

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
              {windowClosed && templateAlreadySent && (
                <div className="flex items-start gap-2.5 border-t border-cyan/30 bg-cyan-bg px-4 py-2.5">
                  <Megaphone size={15} className="mt-0.5 shrink-0 text-cyan" />
                  <p className="text-xs leading-relaxed text-ink">
                    <span className="font-semibold">Ya se envió una plantilla de WhatsApp a este cliente</span>{' '}
                    (difusión o reactivación) y sigue sin responder — no hace falta mandar otra.{' '}
                    <span className="font-semibold">Tu mensaje sale solo en cuanto responda.</span>
                  </p>
                </div>
              )}
              {windowClosed && !templateAlreadySent && (
                <div className="flex items-start gap-2.5 border-t border-warn/30 bg-warn/10 px-4 py-2.5">
                  <Clock size={15} className="mt-0.5 shrink-0 text-warn" />
                  <p className="text-xs leading-relaxed text-ink">
                    <span className="font-semibold">Pasaron más de 24 h desde el último mensaje del cliente.</span>{' '}
                    WhatsApp no deja escribirle directo, así que al enviar se le manda primero
                    una plantilla para reactivar el chat y{' '}
                    <span className="font-semibold">tu mensaje sale solo en cuanto responda</span>.
                    No se pierde nada, pero puede tardar.
                  </p>
                </div>
              )}
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
              {stagedFiles.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto border-t border-line bg-paper px-4 py-2.5">
                  {stagedFiles.map((f) => (
                    <div key={f.id} className="group relative shrink-0">
                      {f.previewUrl ? (
                        <img src={f.previewUrl} alt="" className="h-14 w-14 rounded-lg object-cover" />
                      ) : (
                        <div className="flex h-14 w-28 flex-col items-center justify-center gap-0.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-2">
                          <span className="text-base">{f.file.type.startsWith('audio/') ? '🎵' : '📄'}</span>
                          <span className="w-full truncate text-center text-[10px] text-greige-ink">{f.file.name}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => removeStagedFile(f.id)}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-paper shadow-sm transition-opacity hover:opacity-80"
                        aria-label="Quitar adjunto"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={handleSend} className="flex items-end gap-2 border-t border-line bg-paper p-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,audio/*,.pdf,.doc,.docx"
                  className="hidden"
                  onChange={handleFileSelected}
                />
                <button
                  type="button"
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
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPaste={handlePaste}
                    onKeyDown={handleDraftKeyDown}
                    placeholder={
                      stagedFiles.length
                        ? 'Agrega un mensaje (opcional)… Enter para enviar'
                        : 'Escribe tu respuesta como asesor… ( / para plantillas )'
                    }
                    className="max-h-[120px] w-full resize-none overflow-y-auto rounded-2xl border border-line bg-black/[0.03] dark:bg-white/[0.05] px-4 py-2.5 text-sm outline-none transition-colors focus:border-accent focus:bg-paper disabled:opacity-50"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!draft.trim() && !stagedFiles.length}
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
                  : 'El agente está atendiendo esta conversación con normalidad.'}
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
        <Select value={paidMethod} onChange={setPaidMethod} placeholder="Selecciona el medio de pago…" options={PAID_METHOD_OPTIONS} />
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
        <p className={`text-[10px] ${outgoing ? 'text-white/85' : 'text-greige'}`}>{formatSize(attachment.sizeBytes)}</p>
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
