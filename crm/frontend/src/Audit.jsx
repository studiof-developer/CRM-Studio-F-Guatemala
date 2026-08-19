import { useEffect, useState } from 'react';
import { Eye, Bot, AlertTriangle, LogIn, UserPlus, UserCog, UserMinus, CheckCircle2, PlugZap, SmartphoneNfc, PhoneOff } from 'lucide-react';
import { fetchAccessAudit, fetchAiDecisions } from './api.js';
import Badge from './components/Badge.jsx';
import Select from './components/Select.jsx';

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

export default function Audit() {
  const [tab, setTab] = useState('access');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="sticky top-0 z-10 bg-paper px-8 pb-4 pt-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Auditoría</h1>
          <p className="mt-1 text-sm text-greige-ink">Trazabilidad de accesos a datos y de las decisiones que toma la IA.</p>
        </div>

        <div className="inline-flex rounded-xl border border-line bg-black/[0.03] dark:bg-white/[0.05] p-1">
          {[
            { key: 'access', label: 'Accesos a datos', icon: Eye },
            { key: 'ai', label: 'Decisiones de la IA', icon: Bot },
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

      <div className="px-8 pb-8">
        {tab === 'access' ? <AccessTab /> : <AiTab />}
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
      <div className="mb-4 flex items-center gap-3">
        <Select value={action} onChange={setAction} className="w-56" options={ACTION_FILTER_OPTIONS} />
        <span className="text-xs text-greige-ink">{rows.length} registros</span>
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="overflow-hidden rounded-2xl border border-line bg-paper">
        <table className="w-full text-left text-sm">
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
      <div className="mb-4 flex items-center gap-3">
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
            <div className="mb-3 flex items-center justify-between">
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
