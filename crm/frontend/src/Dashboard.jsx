import { useEffect, useRef, useState, useCallback } from 'react';
import Chart from 'chart.js/auto';
import { Users, LifeBuoy, Timer, CheckCircle2, UserPlus, CircleDollarSign, Headset, AlertTriangle } from 'lucide-react';
import { fetchDashboard } from './api.js';
import Badge from './components/Badge.jsx';
import { PAID_METHOD_LABELS } from './lib/paymentMethods.js';
import { useLiveEvent } from './lib/liveEvents.js';

const PAID_METHOD_COLORS = { tarjeta: '#4338ca', efectivo: '#15803d', transferencia: '#b45309', deposito: '#0891b2' };

const TEMP_COLORS = {
  caliente: '#b91c1c',
  tibio: '#b45309',
  frio: '#1d4ed8',
  pagado: '#15803d',
  pqrs: '#7e22ce',
};
const TEMP_LABELS = { caliente: 'Caliente', tibio: 'Tibio', frio: 'Frío', pagado: 'Pagado', pqrs: 'PQRS' };

const TICKET_STATUS_META = {
  esperando_asesor: { label: 'Pendiente', color: '#b45309', variant: 'warning', icon: AlertTriangle },
  en_atencion: { label: 'Asesor', color: '#4338ca', variant: 'info', icon: Headset },
  resuelto: { label: 'Resuelto', color: '#15803d', variant: 'success', icon: CheckCircle2 },
};

function formatMinutes(m) {
  if (m === null) return 'Sin datos';
  if (m < 60) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

function useChart(canvasRef, buildConfig, deps) {
  useEffect(() => {
    if (!canvasRef.current) return;
    // StrictMode mounts effects twice in dev; without this a stale chart can
    // still be attached to the canvas when the second mount tries to draw.
    Chart.getChart(canvasRef.current)?.destroy();
    const chart = new Chart(canvasRef.current, buildConfig());
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const pipelineRef = useRef(null);
  const ticketStatusRef = useRef(null);
  const conversationsRef = useRef(null);
  const pautaRef = useRef(null);
  const advisorRef = useRef(null);
  const paidMethodRef = useRef(null);

  const loadDashboard = useCallback(() => {
    fetchDashboard().then(setData).catch((err) => setError(err.message));
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // message_changes fires on every message across every conversation, for every advisor
  // — reloading (and every chart destroying/redrawing) on each one made the dashboard
  // look like it was constantly refreshing itself. Throttled so a burst of chat activity
  // collapses into at most one reload every 20s, with a trailing call so it still lands.
  const lastLoadRef = useRef(0);
  const pendingTimerRef = useRef(null);
  const REFRESH_MIN_INTERVAL_MS = 20000;
  const loadDashboardThrottled = useCallback(() => {
    const elapsed = Date.now() - lastLoadRef.current;
    clearTimeout(pendingTimerRef.current);
    if (elapsed >= REFRESH_MIN_INTERVAL_MS) {
      lastLoadRef.current = Date.now();
      loadDashboard();
    } else {
      pendingTimerRef.current = setTimeout(() => {
        lastLoadRef.current = Date.now();
        loadDashboard();
      }, REFRESH_MIN_INTERVAL_MS - elapsed);
    }
  }, [loadDashboard]);

  useLiveEvent('ticket_changes', loadDashboardThrottled);
  useLiveEvent('message_changes', loadDashboardThrottled);

  // Live events are the fast path, but there's no guarantee one fires soon after a day
  // rolls over — without this, a dashboard tab left open with no fresh activity nearby
  // keeps showing yesterday as the last point on every "by day" chart indefinitely.
  useEffect(() => {
    const id = setInterval(loadDashboard, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadDashboard]);

  useChart(pipelineRef, () => {
    const entries = Object.entries(data.pipeline);
    return {
      type: 'bar',
      data: {
        labels: entries.map(([k]) => TEMP_LABELS[k]),
        datasets: [{
          data: entries.map(([, v]) => v),
          backgroundColor: entries.map(([k]) => TEMP_COLORS[k]),
          borderRadius: 4,
          barThickness: 22,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
          y: { grid: { display: false } },
        },
      },
    };
  }, [data]);

  useChart(ticketStatusRef, () => {
    const entries = Object.entries(data.ticketStatus);
    return {
      type: 'doughnut',
      data: {
        labels: entries.map(([k]) => TICKET_STATUS_META[k].label),
        datasets: [{
          data: entries.map(([, v]) => v),
          backgroundColor: entries.map(([k]) => TICKET_STATUS_META[k].color),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 12, font: { size: 11 } } } },
      },
    };
  }, [data]);

  useChart(conversationsRef, () => {
    return {
      type: 'line',
      data: {
        labels: data.conversationsByDay.map((r) => new Date(r.day).toLocaleDateString('es-GT', { day: '2-digit', month: 'short' })),
        datasets: [{
          data: data.conversationsByDay.map((r) => r.count),
          borderColor: '#4338ca',
          backgroundColor: 'rgba(67,56,202,0.08)',
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#4338ca',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
        },
      },
    };
  }, [data]);

  // null (not an empty array) when the backend withheld this for the user's role —
  // useChart itself isn't called at all in that case, see the JSX below.
  useChart(pautaRef, () => {
    return {
      type: 'line',
      data: {
        labels: data.pautaByDay.map((r) => new Date(r.day).toLocaleDateString('es-GT', { day: '2-digit', month: 'short' })),
        datasets: [{
          data: data.pautaByDay.map((r) => r.count),
          borderColor: '#0891b2',
          backgroundColor: 'rgba(8,145,178,0.08)',
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#0891b2',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
        },
      },
    };
  }, [data]);

  useChart(advisorRef, () => {
    return {
      type: 'bar',
      data: {
        labels: data.advisorActivity.map((a) => a.advisor),
        datasets: [{
          data: data.advisorActivity.map((a) => a.count),
          backgroundColor: '#4338ca',
          borderRadius: 4,
          barThickness: 18,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
          y: { grid: { display: false } },
        },
      },
    };
  }, [data]);

  useChart(paidMethodRef, () => {
    const entries = data.paidMethods;
    return {
      type: 'doughnut',
      data: {
        labels: entries.map((p) => PAID_METHOD_LABELS[p.method] ?? p.method),
        datasets: [{
          data: entries.map((p) => p.count),
          backgroundColor: entries.map((p) => PAID_METHOD_COLORS[p.method] ?? '#6b7280'),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 12, font: { size: 11 } } } },
      },
    };
  }, [data]);

  if (error) return <div className="mx-auto max-w-6xl px-8 py-8 text-sm text-danger">{error}</div>;
  if (!data) return <div className="mx-auto max-w-6xl px-8 py-8 text-sm text-muted-foreground">Cargando…</div>;

  const { kpis } = data;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="sticky top-0 z-10 bg-paper px-8 pb-4 pt-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Panorama general de Studio F.</p>
      </div>

      <div className="px-8 pb-8">
      <div className="mb-6 grid grid-cols-4 gap-4">
        <MetricCard icon={Users} label="Clientes totales" value={kpis.clientesTotales} featured />
        <MetricCard icon={UserPlus} label="Registros esta semana" value={kpis.registrosSemana} />
        <MetricCard icon={CircleDollarSign} label="Clientes marcados como Pagado" value={kpis.clientesPagados} />
        <MetricCard icon={LifeBuoy} label="Tickets pendientes" value={kpis.ticketsPendientes} accent={kpis.ticketsPendientes > 0} />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <MetricCard icon={Timer} label="Tiempo de primera respuesta (30d)" value={formatMinutes(kpis.tiempoRespuestaMin)} />
        <MetricCard icon={CheckCircle2} label="Tiempo de resolución (30d)" value={formatMinutes(kpis.tiempoResolucionMin)} />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-6">
        <ChartCard title="Clientes por etapa">
          <div style={{ position: 'relative', height: 200 }}>
            <canvas
              ref={pipelineRef}
              role="img"
              aria-label={`Clientes por etapa: ${Object.entries(data.pipeline).map(([k, v]) => `${TEMP_LABELS[k]} ${v}`).join(', ')}`}
            />
          </div>
        </ChartCard>

        <ChartCard title="Tickets por estado">
          <div style={{ position: 'relative', height: 200 }}>
            <canvas
              ref={ticketStatusRef}
              role="img"
              aria-label={`Tickets por estado: ${Object.entries(data.ticketStatus).map(([k, v]) => `${TICKET_STATUS_META[k].label} ${v}`).join(', ')}`}
            />
          </div>
        </ChartCard>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-6">
        <ChartCard title="Conversaciones nuevas, últimos 14 días">
          <div style={{ position: 'relative', height: 200 }}>
            <canvas
              ref={conversationsRef}
              role="img"
              aria-label="Gráfico de línea de conversaciones nuevas por día en los últimos 14 días"
            />
          </div>
        </ChartCard>

        <ChartCard title="Tickets resueltos por asesor (30d)">
          {data.advisorActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay tickets resueltos en este período.</p>
          ) : (
            <div style={{ position: 'relative', height: Math.max(160, data.advisorActivity.length * 40) }}>
              <canvas
                ref={advisorRef}
                role="img"
                aria-label={`Tickets resueltos por asesor: ${data.advisorActivity.map((a) => `${a.advisor} ${a.count}`).join(', ')}`}
              />
            </div>
          )}
        </ChartCard>
      </div>

      {data.pautaByDay && (
        <div className="mb-6 grid grid-cols-1 gap-6">
          <ChartCard title="Mensajes por pauta, últimos 14 días">
            {data.pautaByDay.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no ha llegado ningún mensaje desde un anuncio en este período.</p>
            ) : (
              <div style={{ position: 'relative', height: 200 }}>
                <canvas
                  ref={pautaRef}
                  role="img"
                  aria-label="Gráfico de línea de mensajes recibidos por anuncio de Meta por día en los últimos 14 días"
                />
              </div>
            )}
          </ChartCard>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-6">
        <ChartCard title="Medio de pago (clientes marcados como Pagado)">
          {data.paidMethods.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay clientes marcados como Pagado con medio registrado.</p>
          ) : (
            <div style={{ position: 'relative', height: 200 }}>
              <canvas
                ref={paidMethodRef}
                role="img"
                aria-label={`Medio de pago: ${data.paidMethods.map((p) => `${PAID_METHOD_LABELS[p.method] ?? p.method} ${p.count}`).join(', ')}`}
              />
            </div>
          )}
        </ChartCard>

        <div className="rounded-2xl border border-border bg-paper p-6">
          <h3 className="mb-4 text-sm font-medium text-muted-foreground">Motivos de handoff más comunes (30d)</h3>
          {data.handoffReasons.length === 0 && (
            <p className="text-sm text-muted-foreground">Todavía no hay tickets en este período.</p>
          )}
          <div className="flex flex-col divide-y divide-border">
            {data.handoffReasons.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-4 py-2.5 text-sm first:pt-0 last:pb-0">
                <p className="line-clamp-2 text-foreground">{r.reason}</p>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{r.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-paper p-6">
        <h3 className="mb-4 text-sm font-medium text-muted-foreground">Tickets recientes</h3>
        {data.recentTickets.length === 0 && (
          <p className="text-sm text-muted-foreground">Todavía no hay tickets.</p>
        )}
        <div className="flex flex-col divide-y divide-border">
          {data.recentTickets.map((t) => {
            const meta = TICKET_STATUS_META[t.status];
            const Icon = meta?.icon;
            return (
              <div key={t.id} className="flex items-center justify-between py-3 text-sm first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.customerName}</p>
                  <p className="truncate text-xs text-muted-foreground">{t.handoffReason || '—'}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {t.assignedAdvisor && <span className="text-xs text-muted-foreground">{t.assignedAdvisor}</span>}
                  <Badge variant={meta?.variant ?? 'neutral'}>
                    {Icon && <Icon size={11} className="mr-1 inline" />}
                    {meta?.label ?? t.status}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, accent, featured }) {
  if (featured) {
    return (
      <div className="rounded-2xl bg-primary p-5 text-primary-foreground">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-medium text-primary-foreground/80">{label}</p>
          <Icon size={16} className="text-primary-foreground/80" />
        </div>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-paper p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Icon size={16} className={accent ? 'text-warning' : 'text-muted-foreground'} />
      </div>
      <p className="text-2xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="rounded-2xl border border-border bg-paper p-6">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
