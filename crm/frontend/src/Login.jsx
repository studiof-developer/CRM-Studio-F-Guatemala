import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Lock, Eye, EyeOff, Loader2, AlertTriangle, MessagesSquare, Inbox, Truck, BarChart3, ArrowRight } from 'lucide-react';
import { login } from './api.js';
import { Logo } from './components/Logo.jsx';
import { ThemeToggle } from './components/ThemeToggle.jsx';

const HIGHLIGHTS = [
  { icon: MessagesSquare, title: 'Todas las conversaciones', text: 'WhatsApp, Instagram y Messenger en una sola bandeja, con el historial de cada cliente.' },
  { icon: Inbox, title: 'Pipeline de ventas', text: 'De la primera pregunta al pago, con cada cliente en su etapa y su asesora.' },
  { icon: Truck, title: 'Pedidos y logística', soon: true, text: 'Fichas, auditoría de pagos y seguimiento hasta que el cliente recibe.' },
  { icon: BarChart3, title: 'Ventas y pauta', text: 'Resultados por asesora, por día y por campaña, sin armar reportes a mano.' },
];

// Marca: formas entrelazadas como las flechas del logo, solo como textura de fondo.
function BrandTexture() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="login-glow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0.35" />
          <stop offset="1" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#login-glow)" strokeWidth="1.5">
        <rect x="-60" y="420" width="360" height="360" rx="72" transform="rotate(18 120 600)" />
        <rect x="140" y="520" width="360" height="360" rx="72" transform="rotate(18 320 700)" />
        <rect x="320" y="-120" width="320" height="320" rx="64" transform="rotate(-14 480 40)" />
        <rect x="180" y="-40" width="320" height="320" rx="64" transform="rotate(-14 340 120)" />
      </g>
    </svg>
  );
}

export default function Login({ onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      onLoggedIn(user);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  const inputCls = 'peer w-full rounded-xl border border-line bg-paper py-3 pl-11 pr-4 text-[15px] text-ink shadow-sm outline-none transition placeholder:text-greige hover:border-greige focus:border-accent focus:ring-4 focus:ring-accent/15';

  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(420px,5fr)_6fr]">
      <main className="relative flex flex-col justify-center px-6 py-10 sm:px-12 lg:px-16 xl:px-24">
        <div className="absolute right-5 top-5"><ThemeToggle /></div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: 'easeOut' }} className="mx-auto w-full max-w-sm">
          <Logo className="mb-10 w-56" />

          <h1 className="text-3xl font-bold tracking-tight text-ink">Bienvenido de nuevo</h1>
          <p className="mt-2 text-sm text-greige-ink">Ingresa con tu usuario para entrar al CRM.</p>

          <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-5">
            <div>
              <label htmlFor="login-user" className="mb-1.5 block text-[13px] font-medium text-greige-ink">Usuario</label>
              <div className="relative">
                <input id="login-user" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="tu.usuario" className={inputCls} />
                <User size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-greige transition-colors peer-focus:text-accent" />
              </div>
            </div>

            <div>
              <label htmlFor="login-pass" className="mb-1.5 block text-[13px] font-medium text-greige-ink">Contraseña</label>
              <div className="relative">
                <input id="login-pass" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" placeholder="Tu contraseña" className={`${inputCls} pr-12 [&::-ms-reveal]:hidden`} />
                <Lock size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-greige transition-colors peer-focus:text-accent" />
                <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-greige transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div aria-live="polite">
              {error && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-bg px-3.5 py-3 text-sm text-danger">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </motion.div>
              )}
            </div>

            <button type="submit" disabled={loading || !username || !password}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-[15px] font-semibold text-white shadow-md shadow-accent/25 transition hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60">
              {loading ? <><Loader2 size={18} className="animate-spin" />Ingresando…</> : <>Ingresar<ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" /></>}
            </button>
          </form>

          <p className="mt-8 text-xs leading-relaxed text-greige">¿No puedes entrar? Pide a un administrador que revise tu usuario o restablezca tu contraseña.</p>
        </motion.div>
      </main>

      <aside className="relative hidden overflow-hidden bg-[#0b1437] lg:flex lg:flex-col lg:justify-between lg:p-14 xl:p-20" aria-label="Qué puedes hacer en el CRM">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(56,189,248,0.22),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(99,102,241,0.35),transparent_60%)]" />
        <BrandTexture />

        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300/80">Bagneres CRM</p>
          <h2 className="mt-4 max-w-md text-4xl font-bold leading-tight tracking-tight text-white [text-wrap:balance]">Cada cliente, cada pago y cada entrega, en un solo lugar.</h2>
        </div>

        <ul className="relative mt-12 grid max-w-xl gap-5 xl:grid-cols-2">
          {HIGHLIGHTS.map(({ icon: Icon, title, text, soon }, i) => (
            <motion.li key={title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.07, duration: 0.4, ease: 'easeOut' }} className="relative rounded-2xl border border-white/10 bg-white/[0.05] p-5 backdrop-blur-sm">
              <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-sky-300"><Icon size={18} /></span>
              {soon && <span className="absolute right-4 top-5 rounded-full bg-amber-400/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-300">En desarrollo</span>}
              <h3 className="text-sm font-semibold text-white">{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-300">{text}</p>
            </motion.li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
