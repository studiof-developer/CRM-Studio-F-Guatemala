import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Toaster } from 'react-hot-toast';
import { LayoutDashboard, Inbox, MessagesSquare, Users as UsersIcon, UserCog, ShoppingBag, ShieldCheck, LogOut, Menu, X, Zap, Smartphone, Megaphone } from 'lucide-react';
import { fetchMe, logout, fetchTickets, fetchConversations } from './api.js';
import { useLiveEvent } from './lib/liveEvents.js';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';
import HandoffQueue from './HandoffQueue.jsx';
import Conversations from './Conversations.jsx';
import Customers from './Customers.jsx';
import Users from './Users.jsx';
import Catalog from './Catalog.jsx';
import Audit from './Audit.jsx';
import QuickReplies from './QuickReplies.jsx';
import Campaigns from './Campaigns.jsx';
import WhatsappNumbers from './WhatsappNumbers.jsx';
import { Logo } from './components/Logo.jsx';
import { ThemeToggle } from './components/ThemeToggle.jsx';

// Visible to everyone: admin, supervisor, and asesor.
const BASE_TABS = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, Component: Dashboard },
  customers: { label: 'Clientes', icon: UsersIcon, Component: Customers },
  handoff: { label: 'Cola de Handoff', icon: Inbox, Component: HandoffQueue },
  conversations: { label: 'Conversaciones', icon: MessagesSquare, Component: Conversations },
  catalog: { label: 'Catálogo', icon: ShoppingBag, Component: Catalog },
  quickReplies: { label: 'Respuestas rápidas', icon: Zap, Component: QuickReplies },
};

// Admin and supervisor only.
const AUDIT_TABS = {
  audit: { label: 'Auditoría', icon: ShieldCheck, Component: Audit },
};

// Admin and supervisor only — a broadcast reaches many customers at once and costs real
// money per message, so it's held to the same bar as auditoría rather than open to
// every asesor. Matches the backend's own requireRole('admin', 'supervisor') on
// /api/campaigns.
const CAMPAIGN_TABS = {
  campaigns: { label: 'Difusión', icon: Megaphone, Component: Campaigns },
};

// Admin only.
const ADMIN_TABS = {
  users: { label: 'Usuarios', icon: UserCog, Component: Users },
};

// Admin only — kept out of ADMIN_TABS and rendered in its own section at the
// bottom of the sidebar, below a divider, since it's system configuration
// rather than a day-to-day page like the rest of the nav.
const SETTINGS_TABS = {
  whatsappNumbers: { label: 'Configuración', icon: Smartphone, Component: WhatsappNumbers },
};

const ROLE_LABELS = { admin: 'Admin', supervisor: 'Supervisor', asesor: 'Asesor de zona' };

function NavButton({ tabKey, label, Icon, active, badge, onClick }) {
  return (
    <button onClick={onClick} className="relative w-full text-left">
      <motion.div
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={`flex items-center gap-3 whitespace-nowrap rounded-xl px-4 py-3 text-sm font-medium transition-colors duration-300 ${
          active ? 'text-white' : 'text-greige hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink'
        }`}
      >
        {active && (
          <motion.div
            layoutId="activeTab"
            className="absolute inset-0 rounded-xl bg-accent shadow-md shadow-accent/20"
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
        )}
        <span className="relative z-10 flex w-full items-center gap-3">
          <Icon size={18} strokeWidth={2} />
          {label}
          {badge > 0 && (
            <span className="relative z-10 ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-xs font-medium text-white">
              {badge}
            </span>
          )}
        </span>
      </motion.div>
    </button>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = logged out
  const [tab, setTab] = useState('dashboard');
  const [pendingCount, setPendingCount] = useState(0);
  const [unansweredCount, setUnansweredCount] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openConversationId, setOpenConversationId] = useState(null);
  const handleOpenConversation = useCallback((phone) => {
    setOpenConversationId(phone);
    setTab('conversations');
  }, []);
  const handleOpenedConversation = useCallback(() => setOpenConversationId(null), []);

  useEffect(() => { fetchMe().then(setUser); }, []);

  const loadPending = useCallback(() => {
    fetchTickets('esperando_asesor').then((rows) => setPendingCount(rows.length)).catch(() => {});
  }, []);

  // Read state lives on the server now (per phone, shared by the whole team) — the
  // badge is just a count of threads the API already flags as unread, so it stays
  // correct across tabs, reloads, and different advisors without any local bookkeeping.
  const loadUnanswered = useCallback(async () => {
    try {
      const rows = await fetchConversations();
      setUnansweredCount(rows.filter((r) => r.unreadCount > 0).length);
    } catch { /* leave the last known count showing rather than flash to 0 */ }
  }, []);

  useEffect(() => {
    if (!user) return;
    loadPending();
    loadUnanswered();
    // SSE (below) carries the instant path — this is just a safety net.
    const id = setInterval(() => { loadPending(); loadUnanswered(); }, 60000);
    return () => clearInterval(id);
  }, [user, loadPending, loadUnanswered]);

  useLiveEvent('ticket_changes', loadPending);
  useLiveEvent('ticket_changes', loadUnanswered);
  useLiveEvent('message_changes', loadUnanswered);
  useLiveEvent('read_changes', loadUnanswered);

  if (user === undefined) return null;
  if (!user) return <Login onLoggedIn={setUser} />;

  const tabs = {
    ...BASE_TABS,
    ...(user.role === 'admin' || user.role === 'supervisor' ? AUDIT_TABS : {}),
    ...(user.role === 'admin' || user.role === 'supervisor' ? CAMPAIGN_TABS : {}),
    ...(user.role === 'admin' ? ADMIN_TABS : {}),
    ...(user.role === 'admin' ? SETTINGS_TABS : {}),
  };
  const { Component } = tabs[tab] ?? tabs.dashboard;

  async function handleLogout() {
    await logout();
    setUser(null);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Toast visuals live in components/Toast.jsx (showSuccess/showError) — this
          just mounts the portal and positions it. */}
      <Toaster position="top-right" toastOptions={{ duration: 3500 }} />
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <motion.aside
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className={`glass-card fixed inset-y-0 left-0 z-50 m-4 flex h-[calc(100vh-2rem)] w-64 shrink-0 flex-col justify-between rounded-3xl transition-transform duration-300 md:sticky md:top-4 md:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-[calc(100%+2rem)] md:translate-x-0'
        }`}
      >
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="relative flex items-center justify-center border-b border-line-soft px-4 py-8">
            <Logo className="w-52 mx-auto" />
            <button
              onClick={() => setMobileNavOpen(false)}
              className="absolute right-4 top-4 rounded-lg p-1.5 text-greige hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink md:hidden"
            >
              <X size={18} />
            </button>
          </div>

          <nav className="flex flex-col gap-2 p-4">
            {Object.entries(tabs).filter(([key]) => !(key in SETTINGS_TABS)).map(([key, { label, icon: Icon }]) => (
              <NavButton
                key={key}
                tabKey={key}
                label={label}
                Icon={Icon}
                active={key === tab}
                badge={key === 'handoff' ? pendingCount : key === 'conversations' ? unansweredCount : 0}
                onClick={() => { setTab(key); setMobileNavOpen(false); }}
              />
            ))}
          </nav>
        </div>

        <div>
          {user.role === 'admin' && (
            <div className="border-t border-line-soft p-4 pb-2">
              {Object.entries(SETTINGS_TABS).map(([key, { label, icon: Icon }]) => (
                <NavButton
                  key={key}
                  tabKey={key}
                  label={label}
                  Icon={Icon}
                  active={key === tab}
                  badge={0}
                  onClick={() => { setTab(key); setMobileNavOpen(false); }}
                />
              ))}
            </div>
          )}

          <div className={`p-4 ${user.role === 'admin' ? 'pt-2' : 'border-t border-line-soft'}`}>
            <div className="relative rounded-xl bg-black/5 dark:bg-white/5 p-4 backdrop-blur-sm">
              <div className="absolute right-4 top-4 hidden md:block">
                <ThemeToggle />
              </div>
              <div className="mb-1 truncate pr-8 text-sm font-semibold text-ink">{user.fullName}</div>
              <div className="mb-4 text-[11px] font-bold uppercase tracking-wider text-accent">
                {ROLE_LABELS[user.role]}{user.zone ? ` · ${user.zone}` : ''}
              </div>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleLogout}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-paper-soft py-2 text-xs font-semibold text-danger shadow-sm transition-colors hover:bg-danger hover:text-white"
              >
                <LogOut size={14} />
                Cerrar sesión
              </motion.button>
            </div>
          </div>
        </div>
      </motion.aside>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-paper/80 px-4 py-3 backdrop-blur-xl md:hidden">
          <Logo className="w-32 ml-1" />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={() => setMobileNavOpen(true)}
              className="rounded-lg p-2 text-greige hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
            >
              <Menu size={20} />
            </button>
          </div>
        </div>

        <main className="h-full w-full min-w-0 flex-1 overflow-hidden px-4 pb-8 md:p-5 md:py-8 md:pl-2 md:pr-8">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="h-[calc(100vh-4rem)] w-full overflow-y-auto overflow-x-hidden rounded-3xl border border-line bg-paper shadow-sm"
          >
            <Component
              user={user}
              onOpenConversation={handleOpenConversation}
              openSessionId={openConversationId}
              onOpenedConversation={handleOpenedConversation}
            />
          </motion.div>
        </main>
      </div>
    </div>
  );
}
