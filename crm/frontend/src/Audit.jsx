import { useEffect, useState } from 'react';
import { Eye, Bot, AlertTriangle } from 'lucide-react';
import { fetchAccessAudit, fetchAiDecisions } from './api.js';
import Badge from './components/Badge.jsx';

const ACTION_LABELS = {
  view_customer: 'Vio perfil de cliente',
  view_ticket: 'Vio ticket',
  view_conversation: 'Vio conversación',
};

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function Audit() {
  const [tab, setTab] = useState('access');

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Auditoría</h1>
        <p className="mt-1 text-sm text-greige-ink">Trazabilidad de accesos a datos y de las decisiones que toma la IA.</p>
      </div>

      <div className="mb-6 inline-flex rounded-xl border border-line bg-black/[0.03] p-1">
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

      {tab === 'access' ? <AccessTab /> : <AiTab />}
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
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="">Todas las acciones</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <span className="text-xs text-greige-ink">{rows.length} registros</span>
      </div>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="overflow-hidden rounded-2xl border border-line bg-paper">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-black/[0.02] text-xs text-greige-ink">
            <tr>
              <th className="px-4 py-3 font-medium">Fecha</th>
              <th className="px-4 py-3 font-medium">Quién</th>
              <th className="px-4 py-3 font-medium">Acción</th>
              <th className="px-4 py-3 font-medium">Cliente consultado</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className="px-4 py-8 text-center text-greige-ink">Cargando…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-greige-ink">Sin registros.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line-soft last:border-0 hover:bg-black/[0.015]">
                <td className="whitespace-nowrap px-4 py-3 text-greige-ink">{formatDateTime(r.accessed_at)}</td>
                <td className="px-4 py-3">
                  <span className="font-medium text-ink">{r.actor_name ?? r.actor}</span>
                  {r.actor_role && <span className="ml-1.5 text-xs text-greige">({r.actor_role})</span>}
                </td>
                <td className="px-4 py-3 text-ink">{ACTION_LABELS[r.action] ?? r.action}</td>
                <td className="px-4 py-3 text-ink">{r.customer_name}</td>
              </tr>
            ))}
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
        <select
          value={handedOff}
          onChange={(e) => setHandedOff(e.target.value)}
          className="rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="">Todas</option>
          <option value="true">Solo escaladas</option>
          <option value="false">Solo resueltas por el bot</option>
        </select>
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
            <p className="text-sm"><span className="font-medium text-greige-ink">Bot: </span>{r.response_out}</p>
            {r.rag_context && (
              <p className="mt-2 text-xs text-greige">Contexto usado: {r.rag_context}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
