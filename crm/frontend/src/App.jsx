import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Toaster } from 'react-hot-toast';
import { LayoutDashboard, Inbox, MessagesSquare, Users as UsersIcon, UserCog, ShoppingBag, ShieldCheck, LogOut, Menu, X } from 'lucide-react';
import { fetchMe, logout, fetchTickets, fetchConversations } from './api.js';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';
import HandoffQueue from './HandoffQueue.jsx';
import Conversations from './Conversations.jsx';
import Customers from './Customers.jsx';
import Users from './Users.jsx';
import Catalog from './Catalog.jsx';
import Audit from './Audit.jsx';
import { Logo } from './components/Logo.jsx';
import { ThemeToggle } from './components/ThemeToggle.jsx';

// Visible to everyone: admin, supervisor, and asesor.
const BASE_TABS = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, Component: Dashboard },
  customers: { label: 'Clientes', icon: UsersIcon, Component: Customers },
  handoff: { label: 'Cola de Handoff', icon: Inbox, Component: HandoffQueue },
  conversations: { label: 'Conversaciones', icon: MessagesSquare, Component: Conversations },
  catalog: { label: 'Catálogo', icon: ShoppingBag, Component: Catalog },
};

// Admin and supervisor only.
const AUDIT_TABS = {
  audit: { label: 'Auditoría', icon: ShieldCheck, Component: Audit },
};

// Admin only.
const ADMIN_TABS = {
  users: { label: 'Usuarios', icon: UserCog, Component: Users },
};

const ROLE_LABELS = { admin: 'Admin', supervisor: 'Supervisor', asesor: 'Asesor de zona' };

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = logged out
  const [tab, setTab] = useState('dashboard');
  const [pendingCount, setPendingCount] = useState(0);
  const [unansweredCount, setUnansweredCount] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => { fetchMe().then(setUser); }, []);

  const loadPending = useCallback(() => {
    fetchTickets('esperando_asesor').then((rows) => setPendingCount(rows.length)).catch(() => {});
  }, []);

  // No stored "last seen" state needed — a thread whose last message is still from
  // the customer means nobody (bot or advisor) has answered it yet, full stop. That's
  // computable fresh on every poll instead of tracking per-user read state.
  const loadUnanswered = useCallback(() => {
    fetchConversations().then((rows) => {
      setUnansweredCount(rows.filter((r) => r.lastMessage?.type === 'human').length);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    loadPending();
    loadUnanswered();
    const id = setInterval(() => { loadPending(); loadUnanswered(); }, 15000);
    return () => clearInterval(id);
  }, [user, loadPending, loadUnanswered]);

  if (user === undefined) return null;
  if (!user) return <Login onLoggedIn={setUser} />;

  const tabs = {
    ...BASE_TABS,
    ...(user.role === 'admin' || user.role === 'supervisor' ? AUDIT_TABS : {}),
    ...(user.role === 'admin' ? ADMIN_TABS : {}),
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
            {Object.entries(tabs).map(([key, { label, icon: Icon }]) => {
              const active = key === tab;
              return (
                <button
                  key={key}
                  onClick={() => {
                    setTab(key);
                    setMobileNavOpen(false);
                  }}
                  className="relative text-left"
                >
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
                      {key === 'handoff' && pendingCount > 0 && (
                        <span className="relative z-10 ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-xs font-medium text-white">
                          {pendingCount}
                        </span>
                      )}
                      {key === 'conversations' && unansweredCount > 0 && (
                        <span className="relative z-10 ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-xs font-medium text-white">
                          {unansweredCount}
                        </span>
                      )}
                    </span>
                  </motion.div>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="border-t border-line-soft p-4">
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
            <Component user={user} />
          </motion.div>
        </main>
      </div>
    </div>
  );
}
