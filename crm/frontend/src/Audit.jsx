import { useEffect, useState } from 'react';
import { Eye, Bot, AlertTriangle, LogIn, UserPlus, UserCog, UserMinus, CheckCircle2, PlugZap, SmartphoneNfc, PhoneOff, MailWarning, Copy, Download } from 'lucide-react';
import { fetchAccessAudit, fetchAiDecisions, fetchUnanswered } from './api.js';
import Badge from './components/Badge.jsx';
import Select from './components/Select.jsx';
import { showSuccess, showError } from './components/Toast.jsx';
import { formatWait } from './lib/sla.js';

// Data-access actions are tied to a customer record; account actions are not
// (their "Cliente" column shows an em dash) — grouped and color-coded so the
// two kinds of activity are easy to tell apart at a glance in the table.
const ACTION_META = {
  view_customer: { label: 'Vio perfil de cliente', variant: 'info', icon: Eye },
  view_ticket: { label: 'Vio ticket', variant: 'info', icon: Eye },
  view_conversation: { label: 'Vio conversación', variant: 'info', icon: Eye },
  login: { label: 'Inició sesión', variant: 'success', icon: LogIn },
  user_created: { label: 'Creó un usuario', variant: 'purple', icon: UserPlus },
  user_updated: { label: 'Editó un usuario', variant: 'warning', icon: UserCog },
  user_deleted: { label: 'Eliminó un usuario', variant: 'danger', icon: UserMinus },
  whatsapp_number_created: { label: 'Conectó un número de WhatsApp', variant: 'purple', icon: PlugZap },
  whatsapp_number_updated: { label: 'Editó un número de WhatsApp', variant: 'warning', icon: SmartphoneNfc },
  whatsapp_number_deleted: { label: 'Eliminó un número de WhatsApp', variant: 'danger', icon: PhoneOff },
};
const VARIANT_ICON_CLASS = { info: 'text-accent', success: 'text-ok', purple: 'text-purple', warning: 'text-warn', danger: 'text-danger' };

const ACTION_FILTER_OPTIONS = [
  { value: '', label: 'Todas las acciones' },
  ...['view_customer', 'view_ticket', 'view_conversation'].map((k) => ({
    value: k, label: ACTION_META[k].label, icon: ACTION_META[k].icon, iconClassName: VARIANT_ICON_CLASS[ACTION_META[k].variant], group: 'Acceso a datos',
  })),
  ...['login', 'user_created', 'user_updated', 'user_deleted'].map((k) => ({
    value: k, label: ACTION_META[k].label, icon: ACTION_META[k].icon, iconClassName: VARIANT_ICON_CLASS[ACTION_META[k].variant], group: 'Cuentas',
  })),
  ...['whatsapp_number_created', 'whatsapp_number_updated', 'whatsapp_number_deleted'].map((k) => ({
    value: k, label: ACTION_META[k].label, icon: ACTION_META[k].icon, iconClassName: VARIANT_ICON_CLASS[ACTION_META[k].variant], group: 'Configuración',
  })),
];

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' }) : '—';
}

// FASHION TIME promo tiers, keyed by the hour the customer's first message (the pauta
// click, for an ad-driven lead) came in — earlier in the day gets the bigger discount.
// Nothing after 21:00 has an assigned tier; shown as "—" rather than guessing one.
const DISCOUNT_TIERS = [
  { maxMinutes: 13 * 60, pct: 60 },
  { maxMinutes: 17 * 60, pct: 50 },
  { maxMinutes: 21 * 60, pct: 40 },
];
function discountFor(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return DISCOUNT_TIERS.find((t) => minutes <= t.maxMinutes)?.pct ?? null;
}

export default function Audit({ onOpenConversation }) {
  const [tab, setTab] = useState('access');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="sticky top-0 z-10 bg-paper px-4 pb-4 pt-8 md:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Auditoría</h1>
          <p className="mt-1 text-sm text-greige-ink">Trazabilidad de accesos a datos y de las decisiones que toma la IA.</p>
        </div>

        <div className="inline-flex flex-wrap rounded-xl border border-line bg-black/[0.03] dark:bg-white/[0.05] p-1">
          {[
            { key: 'access', label: 'Accesos a datos', icon: Eye },
            { key: 'ai', label: 'Decisiones de la IA', icon: Bot },
            { key: 'unanswered', label: 'Sin responder', icon: MailWarning },
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
        {tab === 'access' && <AccessTab />}
        {tab === 'ai' && <AiTab />}
        {tab === 'unanswered' && <UnansweredTab onOpenConversation={onOpenConversation} />}
      </div>
    </div>
  );
}

function AccessTab() {
  const [rows, setRows] = useState([]);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchAccessAudit({ action })
      .then(setRows)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [action]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={action} onChange={setAction} className="w-56" options={ACTION_FILTER_OPTIONS} />
        <span className="text-xs text-greige-ink">{rows.length} registros</span>
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="overflow-hidden rounded-2xl border border-line bg-paper">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-line bg-black/[0.02] dark:bg-white/[0.03] text-xs text-greige-ink">
            <tr>
              <th className="px-4 py-3 font-medium">Fecha</th>
              <th className="px-4 py-3 font-medium">Quién</th>
              <th className="px-4 py-3 font-medium">Acción</th>
              <th className="px-4 py-3 font-medium">Cliente</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className="px-4 py-8 text-center text-greige-ink">Cargando…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-greige-ink">Sin registros.</td></tr>
            )}
            {rows.map((r) => {
              const meta = ACTION_META[r.action];
              return (
                <tr key={r.id} className="border-b border-line-soft last:border-0 hover:bg-black/[0.015] dark:hover:bg-white/[0.02]">
                  <td className="whitespace-nowrap px-4 py-3 text-greige-ink">{formatDateTime(r.accessed_at)}</td>
                  <td className="px-4 py-3">
                    <span className="font-medium text-ink">{r.actor_name ?? r.actor}</span>
                    {r.actor_role && <span className="ml-1.5 text-xs text-greige">({r.actor_role})</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={meta?.variant ?? 'neutral'}>
                      {meta?.icon && <meta.icon size={11} />} {meta?.label ?? r.action}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-ink">{r.customer_name ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function AiTab() {
  const [rows, setRows] = useState([]);
  const [handedOff, setHandedOff] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchAiDecisions({ handedOff })
      .then(setRows)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [handedOff]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          value={handedOff}
          onChange={setHandedOff}
          className="w-56"
          options={[
            { value: '', label: 'Todas' },
            { value: 'true', label: 'Solo escaladas', icon: AlertTriangle, iconClassName: 'text-warn' },
            { value: 'false', label: 'Solo resueltas por el agente', icon: CheckCircle2, iconClassName: 'text-ok' },
          ]}
        />
        <span className="text-xs text-greige-ink">{rows.length} registros</span>
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}
      {!error && rows.length === 0 && !loading && (
        <p className="mb-4 rounded-xl border border-dashed border-line p-6 text-center text-sm text-greige-ink">
          Todavía no hay decisiones registradas — esto se llena cuando el nodo de log quede conectado en n8n.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {loading && <p className="text-sm text-greige-ink">Cargando…</p>}
        {rows.map((r) => (
          <div key={r.id} className="rounded-2xl border border-line bg-paper p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-greige-ink">{formatDateTime(r.created_at)}</span>
              <div className="flex items-center gap-2">
                {r.customerName && <Badge variant="neutral">{r.customerName}</Badge>}
                {r.handed_off && (
                  <Badge variant="warning"><AlertTriangle size={11} /> Escaló a humano</Badge>
                )}
              </div>
            </div>
            <p className="mb-2 text-sm"><span className="font-medium text-greige-ink">Cliente: </span>{r.message_in}</p>
            <p className="text-sm"><span className="font-medium text-greige-ink">Agente: </span>{r.response_out}</p>
            {r.rag_context && (
              <p className="mt-2 text-xs text-greige">Contexto usado: {r.rag_context}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Currently still unanswered (not "was unanswered at some point") and waiting more than
// 24h — this feeds sending these people a broadcast, so a customer who already got a
// late reply has already dropped off (see GET /api/audit/unanswered). message_count is
// shown, not filtered, so an admin can judge "poca conversación" case by case.
function UnansweredTab({ onOpenConversation }) {
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 2 * 86400000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchUnanswered(from, to)
      .then(setRows)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  function copyPhones() {
    const phones = rows.map((r) => r.phone).join('\n');
    navigator.clipboard.writeText(phones)
      .then(() => showSuccess(`${rows.length} número(s) copiado(s) — pegalos en Difusión → Nueva difusión`))
      .catch(() => showError('No se pudo copiar — tu navegador puede estar bloqueando el portapapeles'));
  }

  // A .csv opens straight in Excel (double-click, no import dialog) without needing an
  // xlsx-writing library in the bundle for what's otherwise a plain flat table.
  function downloadExcel() {
    const headers = ['Cliente', 'Teléfono', 'Hora de entrada', 'Descuento', 'Último mensaje', 'Esperando desde', 'Mensajes en el chat'];
    const lines = rows.map((r) => {
      const pct = discountFor(r.firstMessageAt);
      return [
        r.fullName ?? '',
        r.phone,
        formatTime(r.firstMessageAt),
        pct != null ? `${pct}%` : 'Por definir',
        r.lastMessage ?? '',
        formatWait(r.lastMessageAt),
        r.messageCount,
      ];
    });
    const csv = [headers, ...lines]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    // Leading BOM so Excel reads the UTF-8 accents/ñ correctly instead of guessing wrong.
    const blob = new Blob([String.fromCharCode(0xfeff) + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sin_responder_${from}_a_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-greige-ink">
          Desde
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-greige-ink">
          Hasta
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
        </label>
        <span className="text-xs text-greige-ink">{rows.length} clientes en Frío · más de 24h sin respuesta</span>
        {rows.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={downloadExcel}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
            >
              <Download size={12} /> Descargar Excel
            </button>
            <button
              type="button"
              onClick={copyPhones}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              <Copy size={12} /> Copiar números para difusión
            </button>
          </div>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}
      {!error && !loading && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-greige-ink">
          Nadie en Frío lleva más de 24h sin respuesta en ese rango de fechas.
        </p>
      )}

      {(loading || rows.length > 0) && (
        <div className="overflow-hidden rounded-2xl border border-line bg-paper">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-line bg-black/[0.02] dark:bg-white/[0.03] text-xs text-greige-ink">
                <tr>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">Teléfono</th>
                  <th className="px-4 py-3 font-medium">Hora de entrada</th>
                  <th className="px-4 py-3 font-medium">Descuento</th>
                  <th className="px-4 py-3 font-medium">Último mensaje del cliente</th>
                  <th className="px-4 py-3 font-medium">Esperando desde</th>
                  <th className="px-4 py-3 font-medium">Mensajes en el chat</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-greige-ink">Cargando…</td></tr>}
                {!loading && rows.map((r) => {
                  const pct = discountFor(r.firstMessageAt);
                  return (
                  <tr key={r.phone} className="border-b border-line-soft last:border-0 hover:bg-black/[0.015] dark:hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-ink">{r.fullName ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-greige-ink">{r.phone}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-greige-ink">{formatTime(r.firstMessageAt)}</td>
                    <td className="px-4 py-3">
                      {pct != null ? <Badge variant="success">{pct}% off</Badge> : <Badge variant="warning">Por definir</Badge>}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-greige-ink" title={r.lastMessage ?? ''}>{r.lastMessage ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-danger">{formatWait(r.lastMessageAt)}</td>
                    <td className="px-4 py-3 text-ink">{r.messageCount}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenConversation?.(r.phone)}
                        className="text-xs font-semibold text-accent hover:underline"
                      >
                        Ir al chat
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
