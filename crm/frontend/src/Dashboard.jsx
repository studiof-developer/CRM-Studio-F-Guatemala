import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import { DollarSign, ShoppingCart, Users, LifeBuoy, Timer, CheckCircle2 } from 'lucide-react';
import { fetchDashboard } from './api.js';
import Badge from './components/Badge.jsx';

const TEMP_COLORS = {
  caliente: '#b91c1c',
  tibio: '#b45309',
  frio: '#1d4ed8',
  pagado: '#15803d',
  pqrs: '#7e22ce',
};
const TEMP_LABELS = { caliente: 'Caliente', tibio: 'Tibio', frio: 'Frío', pagado: 'Pagado', pqrs: 'PQRS' };

const ORDER_STATUS_META = {
  carrito: { label: 'Carrito', variant: 'neutral' },
  pendiente_pago: { label: 'Pendiente de pago', variant: 'warning' },
  pagado: { label: 'Pagado', variant: 'success' },
  enviado: { label: 'Enviado', variant: 'info' },
  entregado: { label: 'Entregado', variant: 'info' },
  cancelado: { label: 'Cancelado', variant: 'danger' },
};

function formatQ(n) {
  return 'Q' + Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
  const revenueRef = useRef(null);
  const productsRef = useRef(null);

  useEffect(() => {
    fetchDashboard().then(setData).catch((err) => setError(err.message));
  }, []);

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

  useChart(revenueRef, () => {
    return {
      type: 'line',
      data: {
        labels: data.revenueByDay.map((r) => new Date(r.day).toLocaleDateString('es-GT', { day: '2-digit', month: 'short' })),
        datasets: [{
          data: data.revenueByDay.map((r) => r.total),
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
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => formatQ(ctx.parsed.y) } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { callback: (v) => 'Q' + v } },
        },
      },
    };
  }, [data]);

  useChart(productsRef, () => {
    return {
      type: 'bar',
      data: {
        labels: data.topProducts.map((p) => p.name),
        datasets: [{
          data: data.topProducts.map((p) => p.units),
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

  if (error) return <div className="mx-auto max-w-6xl px-8 py-8 text-sm text-danger">{error}</div>;
  if (!data) return <div className="mx-auto max-w-6xl px-8 py-8 text-sm text-muted-foreground">Cargando…</div>;

  const { kpis } = data;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Panorama general de Studio F.</p>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <MetricCard icon={DollarSign} label="Ingresos totales" value={formatQ(kpis.ingresosTotales)} featured />
        <MetricCard icon={ShoppingCart} label="Pedidos este mes" value={kpis.pedidosMes} />
        <MetricCard icon={Users} label="Clientes totales" value={kpis.clientesTotales} />
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

        <ChartCard title="Ingresos, últimos 14 días">
          <div style={{ position: 'relative', height: 200 }}>
            <canvas
              ref={revenueRef}
              role="img"
              aria-label="Gráfico de línea de ingresos diarios en los últimos 14 días"
            />
          </div>
        </ChartCard>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-6">
        <ChartCard title="Productos más vendidos">
          <div style={{ position: 'relative', height: Math.max(160, data.topProducts.length * 40) }}>
            <canvas
              ref={productsRef}
              role="img"
              aria-label={`Productos más vendidos: ${data.topProducts.map((p) => `${p.name} ${p.units} unidades`).join(', ')}`}
            />
          </div>
        </ChartCard>

        <div className="rounded-2xl border border-border bg-white p-6">
          <h3 className="mb-4 text-sm font-medium text-muted-foreground">Pedidos recientes</h3>
          {data.recentOrders.length === 0 && (
            <p className="text-sm text-muted-foreground">Todavía no hay pedidos.</p>
          )}
          <div className="flex flex-col divide-y divide-border">
            {data.recentOrders.map((o) => (
              <div key={o.ticketCode} className="flex items-center justify-between py-3 text-sm first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate font-medium">{o.customerName}</p>
                  <p className="text-xs text-muted-foreground">{o.ticketCode}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-medium">{o.total !== null ? formatQ(o.total) : '—'}</span>
                  <Badge variant={ORDER_STATUS_META[o.status]?.variant ?? 'neutral'}>
                    {ORDER_STATUS_META[o.status]?.label ?? o.status}
                  </Badge>
                </div>
              </div>
            ))}
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
    <div className="rounded-2xl border border-border bg-white p-5">
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
    <div className="rounded-2xl border border-border bg-white p-6">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
