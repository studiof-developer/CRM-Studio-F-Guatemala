import { useEffect, useState, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import {
  Trophy, CircleDollarSign, Users, ShoppingBag, TrendingUp,
  Download, RefreshCw, Calendar, ArrowRight, MessageCircle,
  FileSpreadsheet, Filter, ChevronDown, ChevronUp, Pencil, X, Check
} from 'lucide-react';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { fetchSalesByAdvisor, fetchWhatsappNumbers, updateSale, fetchDailySalesBreakdown } from '../api.js';
import { PAID_METHOD_LABELS } from '../lib/paymentMethods.js';
import Badge from './Badge.jsx';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

function guatemalaToday() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const gt = new Date(utc - 6 * 3600000);
  return gt.toISOString().slice(0, 10);
}

function formatDayLabel(dayStr) {
  if (!dayStr) return '—';
  const dateOnly = String(dayStr).slice(0, 10);
  const [y, m, d] = dateOnly.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString('es-GT', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

const PERIOD_OPTIONS = [
  { value: 'hoy', label: 'Hoy' },
  { value: 'ayer', label: 'Ayer' },
  { value: 'esta_semana', label: 'Esta semana' },
  { value: 'este_mes', label: 'Este mes' },
  { value: 'mes_anterior', label: 'Mes anterior' },
  { value: 'personalizado', label: 'Personalizado' },
];

const DAILY_RANGE_OPTIONS = [
  { value: 'sep_oct', label: 'Septiembre y Octubre' },
  { value: 'septiembre', label: 'Septiembre 2026' },
  { value: 'octubre', label: 'Octubre 2026' },
  { value: 'personalizado', label: 'Personalizado' },
];

export default function SalesAdvisorDashboard() {
  const [activeTab, setActiveTab] = useState('ranking'); // 'ranking' | 'daily'
  const [period, setPeriod] = useState('hoy');
  const [from, setFrom] = useState(guatemalaToday());
  const [to, setTo] = useState(guatemalaToday());
  const [lineId, setLineId] = useState('');
  const [whatsappNumbers, setWhatsappNumbers] = useState([]);
  const [salesData, setSalesData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showTransactions, setShowTransactions] = useState(false);
  const [editingSaleId, setEditingSaleId] = useState(null);
  const [editAmountVal, setEditAmountVal] = useState('');
  const [editBusy, setEditBusy] = useState(false);

  // Estados para la comparativa diaria Leydi vs Aura
  const [dailyRange, setDailyRange] = useState('sep_oct');
  const [dailyFrom, setDailyFrom] = useState('2026-09-01');
  const [dailyTo, setDailyTo] = useState('2026-10-31');
  const [dailyData, setDailyData] = useState(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState(null);

  async function handleSaveAmount(saleId) {
    const num = Number(editAmountVal);
    if (isNaN(num) || num < 0) return;
    setEditBusy(true);
    try {
      await updateSale(saleId, { amount: num });
      setEditingSaleId(null);
      setEditAmountVal('');
      loadData();
    } catch (err) {
      alert(err.message);
    } finally {
      setEditBusy(false);
    }
  }

  const chartCanvasRef = useRef(null);
  const chartInstanceRef = useRef(null);

  // Carga líneas disponibles
  useEffect(() => {
    fetchWhatsappNumbers().then(setWhatsappNumbers).catch(() => {});
  }, []);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    const filters = { period };
    if (period === 'personalizado') {
      filters.from = from;
      filters.to = to;
    }
    if (lineId) filters.lineId = lineId;

    fetchSalesByAdvisor(filters)
      .then((data) => {
        setSalesData(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [period, from, to, lineId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Dibuja gráfico de barras de ventas por asesor
  useEffect(() => {
    if (!chartCanvasRef.current || !salesData || salesData.advisors.length === 0) return;

    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
    }

    const advisors = salesData.advisors;
    const ctx = chartCanvasRef.current.getContext('2d');

    chartInstanceRef.current = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: advisors.map((a) => a.advisorName),
        datasets: [
          {
            label: 'Total Vendido (Q)',
            data: advisors.map((a) => a.totalQuetzales),
            backgroundColor: '#15803d',
            borderRadius: 6,
            barThickness: 24,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => `Q ${Number(item.raw).toLocaleString('es-GT', { minimumFractionDigits: 2 })}`,
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: '#e4e4e7' },
            ticks: {
              callback: (v) => `Q${Number(v).toLocaleString('es-GT')}`,
            },
          },
          y: {
            grid: { display: false },
          },
        },
      },
    });

    return () => {
      if (chartInstanceRef.current) chartInstanceRef.current.destroy();
    };
  }, [salesData]);

  // Exportar a Excel con 2 hojas: Ranking de Asesores y Detalle de Transacciones
  function exportToExcel() {
    if (!salesData) return;

    const wb = XLSX.utils.book_new();

    // 1. Hoja de Ranking de Asesores
    const advisorHeaders = ['Ranking', 'Asesor', 'Clientes Atendidos', 'Cantidad Ventas', 'Total Vendido (Q)', 'Ticket Promedio (Q)', 'Participación (%)'];
    const advisorRows = salesData.advisors.map((a) => [
      a.rank,
      a.advisorName,
      a.clientesVendidos,
      a.cantidadVentas,
      a.totalQuetzales,
      a.ticketPromedio,
      `${a.porcentajeDelTotal}%`,
    ]);

    const advisorWs = XLSX.utils.aoa_to_sheet([advisorHeaders, ...advisorRows]);
    advisorWs['!cols'] = [{ wch: 10 }, { wch: 26 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, advisorWs, 'Resumen por Asesor');

    // 2. Hoja de Transacciones Detalladas
    const transHeaders = ['ID', 'Fecha y Hora', 'Asesor', 'Cliente', 'Teléfono', 'Monto (Q)', 'Medio de Pago', 'Notas'];
    const transRows = (salesData.transactions || []).map((t) => [
      t.id,
      new Date(t.createdAt).toLocaleString('es-GT', { timeZone: 'America/Guatemala' }),
      t.advisorName,
      t.customerName,
      t.customerPhone,
      t.amount,
      PAID_METHOD_LABELS[t.paymentMethod] || t.paymentMethod,
      t.notes || '',
    ]);

    const transWs = XLSX.utils.aoa_to_sheet([transHeaders, ...transRows]);
    transWs['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 24 }, { wch: 26 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 35 }];
    XLSX.utils.book_append_sheet(wb, transWs, 'Detalle de Ventas');

    const fileName = `reporte_ventas_asesor_${period}_${guatemalaToday()}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  const loadDailyData = useCallback(() => {
    setDailyLoading(true);
    setDailyError(null);
    let f = dailyFrom;
    let t = dailyTo;
    if (dailyRange === 'septiembre') {
      f = '2026-09-01';
      t = '2026-09-30';
    } else if (dailyRange === 'octubre') {
      f = '2026-10-01';
      t = '2026-10-31';
    } else if (dailyRange === 'sep_oct') {
      f = '2026-09-01';
      t = '2026-10-31';
    }
    const filters = { from: f, to: t };
    if (lineId) filters.lineId = lineId;

    fetchDailySalesBreakdown(filters)
      .then((data) => {
        setDailyData(data);
        setDailyLoading(false);
      })
      .catch((err) => {
        setDailyError(err.message);
        setDailyLoading(false);
      });
  }, [dailyRange, dailyFrom, dailyTo, lineId]);

  useEffect(() => {
    if (activeTab === 'daily') {
      loadDailyData();
    }
  }, [activeTab, loadDailyData]);

  function exportDailyToExcel() {
    if (!dailyData || !dailyData.daily || dailyData.daily.length === 0) return;

    const wb = XLSX.utils.book_new();
    const headers = [
      'Fecha',
      'Ventas Leydi',
      'Total Leydi (Q)',
      'Ventas Aura',
      'Total Aura (Q)',
      'Otras Ventas',
      'Otros Monto (Q)',
      'Total Ventas',
      'Total Monto (Q)',
    ];

    const rows = dailyData.daily.map((d) => [
      String(d.day).slice(0, 10),
      d.leydi.ventas,
      d.leydi.monto,
      d.aura.ventas,
      d.aura.monto,
      d.otros.ventas,
      d.otros.monto,
      d.total.ventas,
      d.total.monto,
    ]);

    const sum = dailyData.summary;
    rows.push([
      'TOTAL CONSOLIDADO',
      sum?.leydi?.ventas || 0,
      sum?.leydi?.monto || 0,
      sum?.aura?.ventas || 0,
      sum?.aura?.monto || 0,
      '',
      '',
      sum?.totalVentas || 0,
      sum?.totalMonto || 0,
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [
      { wch: 14 },
      { wch: 14 },
      { wch: 18 },
      { wch: 14 },
      { wch: 18 },
      { wch: 14 },
      { wch: 16 },
      { wch: 14 },
      { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Comparativa Diaria');

    const fileName = `ventas_diarias_leydi_vs_aura_${dailyData.from}_al_${dailyData.to}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  const summary = salesData?.summary || { totalQuetzales: 0, totalClientes: 0, totalVentas: 0, ticketPromedio: 0 };
  const advisors = salesData?.advisors || [];
  const transactions = salesData?.transactions || [];

  return (
    <div className="mb-8 rounded-3xl border border-line bg-surface p-5 shadow-sm md:p-6">
      {/* Selector de Pestaña Principal */}
      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-line pb-4">
        <button
          onClick={() => setActiveTab('ranking')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
            activeTab === 'ranking'
              ? 'bg-ink text-paper shadow-sm'
              : 'text-greige-ink hover:bg-paper hover:text-ink'
          }`}
        >
          <Trophy size={15} />
          <span>Rendimiento por Asesor</span>
        </button>
        <button
          onClick={() => setActiveTab('daily')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
            activeTab === 'daily'
              ? 'bg-accent text-white shadow-sm'
              : 'text-greige-ink hover:bg-paper hover:text-ink'
          }`}
        >
          <Calendar size={15} />
          <span>Comparativa Diaria (Leydi vs Aura)</span>
        </button>
      </div>

      {activeTab === 'daily' ? (
        <div>
          {/* Header & Filtros Comparativa Diaria */}
          <div className="flex flex-col gap-4 border-b border-line pb-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Calendar size={20} />
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink">
                  Comparativa Diaria de Ventas — Leydi vs Aura
                </h2>
              </div>
              <p className="mt-1 text-xs text-greige-ink">
                Desglose día a día de ventas atribuidas según las conversaciones activas de WhatsApp para Septiembre y Octubre.
              </p>
            </div>

            {/* Barra de Filtros Diaria */}
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex rounded-xl border border-line bg-paper p-1 text-xs">
                {DAILY_RANGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDailyRange(opt.value)}
                    className={`rounded-lg px-3 py-1.5 font-medium transition-all ${
                      dailyRange === opt.value
                        ? 'bg-accent text-white shadow-xs'
                        : 'text-greige-ink hover:text-ink'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {dailyRange === 'personalizado' && (
                <div className="flex items-center gap-1.5 rounded-xl border border-line bg-paper px-2.5 py-1 text-xs">
                  <Calendar size={13} className="text-greige-ink" />
                  <input
                    type="date"
                    value={dailyFrom}
                    onChange={(e) => setDailyFrom(e.target.value)}
                    className="bg-transparent text-xs text-ink focus:outline-none"
                  />
                  <span className="text-greige-ink">—</span>
                  <input
                    type="date"
                    value={dailyTo}
                    onChange={(e) => setDailyTo(e.target.value)}
                    className="bg-transparent text-xs text-ink focus:outline-none"
                  />
                </div>
              )}

              {whatsappNumbers.length > 0 && (
                <select
                  value={lineId}
                  onChange={(e) => setLineId(e.target.value)}
                  className="rounded-xl border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink focus:border-accent focus:outline-none"
                >
                  <option value="">Todas las líneas</option>
                  {whatsappNumbers.map((num) => (
                    <option key={num.id} value={num.id}>
                      {num.label || num.phone_number}
                    </option>
                  ))}
                </select>
              )}

              <button
                onClick={loadDailyData}
                disabled={dailyLoading}
                title="Actualizar datos"
                className="flex items-center justify-center rounded-xl border border-line bg-paper p-2 text-greige-ink transition-colors hover:bg-muted hover:text-ink disabled:opacity-50"
              >
                <RefreshCw size={14} className={dailyLoading ? 'animate-spin' : ''} />
              </button>

              <button
                onClick={exportDailyToExcel}
                disabled={!dailyData?.daily?.length}
                className="flex items-center gap-1.5 rounded-xl bg-success px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-opacity hover:opacity-95 disabled:opacity-50"
              >
                <Download size={13} />
                <span>Exportar Excel</span>
              </button>
            </div>
          </div>

          {dailyError && (
            <div className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-4 text-xs font-medium text-danger">
              Error al cargar comparativa diaria: {dailyError}
            </div>
          )}

          {/* KPI Cards Leydi vs Aura */}
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* Tarjeta Leydi */}
            <div className="rounded-2xl border border-blue-500/30 bg-gradient-to-br from-blue-500/10 to-transparent p-4">
              <div className="flex items-center justify-between text-blue-600 dark:text-blue-400">
                <span className="text-[11px] font-bold uppercase tracking-wider">Leydi Laura Mosquera</span>
                <span className="rounded-lg bg-blue-500/10 px-2 py-0.5 text-xs font-bold">
                  {dailyData?.summary?.leydi?.ventas ?? 0} ventas
                </span>
              </div>
              <p className="mt-3 text-2xl font-bold tracking-tight text-ink">
                Q {(dailyData?.summary?.leydi?.monto ?? 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}
              </p>
              <p className="mt-1 text-[11px] text-greige-ink">
                Total ventas registradas en sus turnos
              </p>
            </div>

            {/* Tarjeta Aura */}
            <div className="rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 to-transparent p-4">
              <div className="flex items-center justify-between text-purple-600 dark:text-purple-400">
                <span className="text-[11px] font-bold uppercase tracking-wider">Aura</span>
                <span className="rounded-lg bg-purple-500/10 px-2 py-0.5 text-xs font-bold">
                  {dailyData?.summary?.aura?.ventas ?? 0} ventas
                </span>
              </div>
              <p className="mt-3 text-2xl font-bold tracking-tight text-ink">
                Q {(dailyData?.summary?.aura?.monto ?? 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}
              </p>
              <p className="mt-1 text-[11px] text-greige-ink">
                Total ventas registradas en sus turnos
              </p>
            </div>

            {/* Tarjeta Total General */}
            <div className="rounded-2xl border border-success-bg/80 bg-gradient-to-br from-success-bg/40 to-success-bg/10 p-4">
              <div className="flex items-center justify-between text-success">
                <span className="text-[11px] font-bold uppercase tracking-wider">Total Consolidado</span>
                <span className="rounded-lg bg-success-bg px-2 py-0.5 text-xs font-bold">
                  {dailyData?.summary?.totalVentas ?? 0} ventas
                </span>
              </div>
              <p className="mt-3 text-2xl font-bold tracking-tight text-success">
                Q {(dailyData?.summary?.totalMonto ?? 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}
              </p>
              <p className="mt-1 text-[11px] text-greige-ink">
                Suma global de ambos turnos y asesoras
              </p>
            </div>
          </div>

          {/* Tabla Comparativa Día por Día */}
          <div className="mt-6 rounded-2xl border border-line bg-paper p-4 md:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-ink">Tabla Comparativa Día por Día</h3>
                <p className="text-[11px] text-greige-ink">
                  Comparación directa entre Leydi y Aura para cada fecha de Septiembre y Octubre
                </p>
              </div>
              <span className="text-xs font-medium text-greige-ink">
                {dailyData?.daily?.length || 0} días registrados
              </span>
            </div>

            {dailyLoading ? (
              <div className="flex items-center justify-center py-12 text-xs text-greige-ink">
                <RefreshCw size={18} className="mr-2 animate-spin text-accent" />
                Cargando datos diarios...
              </div>
            ) : !dailyData?.daily || dailyData.daily.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-greige-ink">
                <Calendar size={32} className="mb-2 opacity-40" />
                <p className="text-sm font-medium">No hay registros de ventas para el rango seleccionado.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-greige-ink">
                      <th className="pb-2.5 pl-2">Fecha</th>
                      <th className="pb-2.5 text-center text-blue-600 dark:text-blue-400">Leydi Ventas</th>
                      <th className="pb-2.5 text-right text-blue-600 dark:text-blue-400">Leydi Total (Q)</th>
                      <th className="pb-2.5 text-center text-purple-600 dark:text-purple-400">Aura Ventas</th>
                      <th className="pb-2.5 text-right text-purple-600 dark:text-purple-400">Aura Total (Q)</th>
                      <th className="pb-2.5 text-center">Total Ventas</th>
                      <th className="pb-2.5 pr-2 text-right">Monto Total (Q)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {dailyData.daily.map((d) => (
                      <tr key={d.day} className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                        <td className="py-2.5 pl-2 font-medium text-ink whitespace-nowrap">
                          {formatDayLabel(d.day)}
                        </td>
                        <td className="py-2.5 text-center font-semibold text-blue-600 dark:text-blue-400">
                          {d.leydi.ventas > 0 ? (
                            <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-bold">
                              {d.leydi.ventas}
                            </span>
                          ) : (
                            <span className="text-greige-ink font-normal">0</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-medium text-ink whitespace-nowrap">
                          Q {d.leydi.monto.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-2.5 text-center font-semibold text-purple-600 dark:text-purple-400">
                          {d.aura.ventas > 0 ? (
                            <span className="rounded-full bg-purple-500/10 px-2 py-0.5 font-bold">
                              {d.aura.ventas}
                            </span>
                          ) : (
                            <span className="text-greige-ink font-normal">0</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-medium text-ink whitespace-nowrap">
                          Q {d.aura.monto.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-2.5 text-center font-bold text-ink">
                          <span className="rounded-full bg-secondary px-2.5 py-0.5">
                            {d.total.ventas}
                          </span>
                        </td>
                        <td className="py-2.5 pr-2 text-right font-bold text-success whitespace-nowrap">
                          Q {d.total.monto.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-line bg-secondary/30 font-bold text-ink">
                      <td className="py-3 pl-2 uppercase tracking-wide text-xs">
                        TOTALES
                      </td>
                      <td className="py-3 text-center text-blue-600 dark:text-blue-400 text-sm">
                        {dailyData.summary?.leydi?.ventas ?? 0}
                      </td>
                      <td className="py-3 text-right text-blue-600 dark:text-blue-400 text-sm whitespace-nowrap">
                        Q {(dailyData.summary?.leydi?.monto ?? 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 text-center text-purple-600 dark:text-purple-400 text-sm">
                        {dailyData.summary?.aura?.ventas ?? 0}
                      </td>
                      <td className="py-3 text-right text-purple-600 dark:text-purple-400 text-sm whitespace-nowrap">
                        Q {(dailyData.summary?.aura?.monto ?? 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 text-center text-sm">
                        {dailyData.summary?.totalVentas ?? 0}
                      </td>
                      <td className="py-3 pr-2 text-right text-success text-sm whitespace-nowrap">
                        Q {(dailyData.summary?.totalMonto ?? 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Encabezado y Filtros */}
          <div className="flex flex-col gap-4 border-b border-line pb-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success-bg text-success">
                  <Trophy size={20} />
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink">
                  Rendimiento de Ventas por Asesor
                </h2>
              </div>
              <p className="mt-1 text-xs text-greige-ink">
                Medición de ventas en Quetzales (Q), clientes únicos cerrados y ticket promedio por cada asesor.
              </p>
            </div>

        {/* Barra de Filtros */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Selector de período */}
          <div className="flex rounded-xl border border-line bg-paper p-1 text-xs">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`rounded-lg px-3 py-1.5 font-medium transition-all ${
                  period === opt.value
                    ? 'bg-accent text-white shadow-xs'
                    : 'text-greige-ink hover:text-ink'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Rango de fechas para personalizado */}
          {period === 'personalizado' && (
            <div className="flex items-center gap-1.5 rounded-xl border border-line bg-paper px-2.5 py-1 text-xs">
              <Calendar size={13} className="text-greige-ink" />
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="bg-transparent text-xs text-ink focus:outline-none"
              />
              <span className="text-greige-ink">—</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="bg-transparent text-xs text-ink focus:outline-none"
              />
            </div>
          )}

          {/* Selector de línea */}
          {whatsappNumbers.length > 0 && (
            <select
              value={lineId}
              onChange={(e) => setLineId(e.target.value)}
              className="rounded-xl border border-line bg-paper px-3 py-1.5 text-xs font-medium text-ink focus:border-accent focus:outline-none"
            >
              <option value="">Todas las líneas</option>
              {whatsappNumbers.map((num) => (
                <option key={num.id} value={num.id}>
                  {num.label || num.phone_number}
                </option>
              ))}
            </select>
          )}

          {/* Botón Refrescar */}
          <button
            onClick={loadData}
            disabled={loading}
            title="Actualizar métricas en tiempo real"
            className="flex items-center justify-center rounded-xl border border-line bg-paper p-2 text-greige-ink transition-colors hover:bg-muted hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>

          {/* Botón Exportar a Excel */}
          <button
            onClick={exportToExcel}
            disabled={advisors.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-success px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-opacity hover:opacity-95 disabled:opacity-50"
          >
            <Download size={13} />
            <span>Excel</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-4 text-xs font-medium text-danger">
          Error al cargar datos de ventas: {error}
        </div>
      )}

      {/* Tarjetas KPI de Resumen General */}
      <div className="mt-6 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {/* Total Quetzales */}
        <div className="rounded-2xl border border-success-bg/80 bg-gradient-to-br from-success-bg/40 to-success-bg/10 p-4 text-ink">
          <div className="flex items-center justify-between text-success">
            <span className="text-[11px] font-semibold uppercase tracking-wider">Total Vendido</span>
            <CircleDollarSign size={18} />
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-success">
            Q {summary.totalQuetzales.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
          </p>
          <p className="mt-1 text-[11px] text-greige-ink">
            Suma neta del período seleccionado
          </p>
        </div>

        {/* Clientes Únicos Cerrados */}
        <div className="rounded-2xl border border-line bg-paper p-4 text-ink">
          <div className="flex items-center justify-between text-greige-ink">
            <span className="text-[11px] font-semibold uppercase tracking-wider">Clientes Cerrados</span>
            <Users size={18} />
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
            {summary.totalClientes}
          </p>
          <p className="mt-1 text-[11px] text-greige-ink">
            Clientes únicos con compra
          </p>
        </div>

        {/* Total Transacciones */}
        <div className="rounded-2xl border border-line bg-paper p-4 text-ink">
          <div className="flex items-center justify-between text-greige-ink">
            <span className="text-[11px] font-semibold uppercase tracking-wider">Ventas Realizadas</span>
            <ShoppingBag size={18} />
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
            {summary.totalVentas}
          </p>
          <p className="mt-1 text-[11px] text-greige-ink">
            Total órdenes / compras cerradas
          </p>
        </div>

        {/* Ticket Promedio */}
        <div className="rounded-2xl border border-line bg-paper p-4 text-ink">
          <div className="flex items-center justify-between text-greige-ink">
            <span className="text-[11px] font-semibold uppercase tracking-wider">Ticket Promedio</span>
            <TrendingUp size={18} />
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
            Q {summary.ticketPromedio.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
          </p>
          <p className="mt-1 text-[11px] text-greige-ink">
            Promedio generado por venta
          </p>
        </div>
      </div>

      {/* Leaderboard y Gráfico */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Tabla Ranking de Asesores */}
        <div className="lg:col-span-7">
          <div className="rounded-2xl border border-line bg-paper p-4 md:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-ink">Tabla de Rendimiento por Asesor</h3>
                <p className="text-[11px] text-greige-ink">Ordenado por monto total vendido en Quetzales</p>
              </div>
              <span className="text-xs font-semibold text-greige-ink">
                {advisors.length} asesor{advisors.length === 1 ? '' : 'es'} con ventas
              </span>
            </div>

            {advisors.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-greige-ink">
                <ShoppingBag size={32} className="mb-2 opacity-40" />
                <p className="text-sm font-medium">No se registraron ventas en este período.</p>
                <p className="text-xs text-greige-ink">
                  Cuando los asesores marquen compras o registren pagos en los chats, aparecerán aquí en vivo.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-greige-ink">
                      <th className="pb-2 pl-2">#</th>
                      <th className="pb-2">Asesor</th>
                      <th className="pb-2 text-center">Clientes</th>
                      <th className="pb-2 text-center">Ventas</th>
                      <th className="pb-2 text-right">Total Vendido (Q)</th>
                      <th className="pb-2 text-right">Ticket Prom.</th>
                      <th className="pb-2 pr-2 text-right">Part. %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {advisors.map((a) => {
                      const medal =
                        a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : null;
                      return (
                        <tr key={a.advisorName} className="transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                          <td className="py-3 pl-2 font-bold text-ink">
                            {medal ? (
                              <span className="text-base" title={`Puesto ${a.rank}`}>{medal}</span>
                            ) : (
                              <span className="text-greige-ink">{a.rank}</span>
                            )}
                          </td>
                          <td className="py-3 font-semibold text-ink">
                            {a.advisorName}
                          </td>
                          <td className="py-3 text-center">
                            <span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-ink">
                              {a.clientesVendidos} {a.clientesVendidos === 1 ? 'cliente' : 'clientes'}
                            </span>
                          </td>
                          <td className="py-3 text-center font-medium text-greige-ink">
                            {a.cantidadVentas}
                          </td>
                          <td className="py-3 text-right font-bold text-success">
                            Q {a.totalQuetzales.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                          </td>
                          <td className="py-3 text-right font-medium text-ink">
                            Q {a.ticketPromedio.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                          </td>
                          <td className="py-3 pr-2 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-semibold text-ink">{a.porcentajeDelTotal}%</span>
                              <div className="h-1.5 w-12 overflow-hidden rounded-full bg-line">
                                <div
                                  className="h-full bg-success"
                                  style={{ width: `${Math.min(100, a.porcentajeDelTotal)}%` }}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Gráfico Comparativo */}
        <div className="lg:col-span-5">
          <div className="flex h-full flex-col justify-between rounded-2xl border border-line bg-paper p-4 md:p-5">
            <div>
              <h3 className="text-sm font-bold text-ink">Comparativa Visual de Ventas (Q)</h3>
              <p className="text-[11px] text-greige-ink">Ingresos generados por cada asesor</p>
            </div>

            <div className="my-auto pt-4" style={{ position: 'relative', minHeight: 200, height: Math.max(200, advisors.length * 48) }}>
              {advisors.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-greige-ink">
                  Sin datos para graficar en este período
                </div>
              ) : (
                <canvas ref={chartCanvasRef} />
              )}
            </div>

            <div className="mt-3 border-t border-line pt-3 text-[11px] text-greige-ink flex justify-between items-center">
              <span>Líder en ventas: <strong>{advisors[0]?.advisorName || '—'}</strong></span>
              <span className="font-semibold text-success">Q {advisors[0]?.totalQuetzales.toLocaleString('es-GT', { minimumFractionDigits: 2 }) || '0.00'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Detalle Transaccional de Ventas (Auditoría Gerencial) */}
      <div className="mt-6 rounded-2xl border border-line bg-paper p-4 md:p-5">
        <button
          onClick={() => setShowTransactions(!showTransactions)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent" />
            <h3 className="text-sm font-bold text-ink">
              Registro Detallado de Transacciones ({transactions.length})
            </h3>
          </div>
          <span className="flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
            {showTransactions ? 'Ocultar detalle' : 'Ver transacciones'}
            {showTransactions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>

        {showTransactions && (
          <div className="mt-4 border-t border-line pt-4">
            {transactions.length === 0 ? (
              <p className="py-4 text-center text-xs text-greige-ink">No hay transacciones registradas en este período.</p>
            ) : (
              <div className="max-h-96 overflow-y-auto overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-line text-[11px] uppercase tracking-wider text-greige-ink">
                      <th className="pb-2">Fecha y Hora</th>
                      <th className="pb-2">Asesor</th>
                      <th className="pb-2">Cliente</th>
                      <th className="pb-2">Monto (Q)</th>
                      <th className="pb-2">Medio</th>
                      <th className="pb-2">Notas / Prenda</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {transactions.map((t) => (
                      <tr key={t.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                        <td className="py-2.5 text-greige-ink whitespace-nowrap">
                          {new Date(t.createdAt).toLocaleDateString('es-GT', {
                            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Guatemala'
                          })}
                        </td>
                        <td className="py-2.5 font-semibold text-ink whitespace-nowrap">
                          {t.advisorName}
                        </td>
                        <td className="py-2.5">
                          <a
                            href={`/conversations?phone=${t.customerPhone}`}
                            className="font-medium text-ink hover:text-accent hover:underline flex items-center gap-1"
                          >
                            <span>{t.customerName}</span>
                            <ArrowRight size={10} className="text-greige-ink" />
                          </a>
                          <p className="text-[11px] text-greige-ink">{t.customerPhone}</p>
                        </td>
                        <td className="py-2.5 font-bold text-success whitespace-nowrap">
                          {editingSaleId === t.id ? (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                handleSaveAmount(t.id);
                              }}
                              className="flex items-center gap-1"
                            >
                              <span className="text-xs font-semibold text-greige-ink">Q</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                autoFocus
                                value={editAmountVal}
                                onChange={(e) => setEditAmountVal(e.target.value)}
                                className="w-20 rounded border border-accent bg-paper px-1.5 py-0.5 text-xs font-bold text-ink focus:outline-none"
                              />
                              <button
                                type="submit"
                                disabled={editBusy}
                                className="rounded p-1 text-success hover:bg-success-bg"
                              >
                                <Check size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSaleId(null)}
                                className="rounded p-1 text-greige-ink hover:bg-muted"
                              >
                                <X size={13} />
                              </button>
                            </form>
                          ) : (
                            <div className="flex items-center gap-1.5 group">
                              <span className={Number(t.amount) === 0 ? 'text-warn font-semibold' : ''}>
                                Q {Number(t.amount).toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSaleId(t.id);
                                  setEditAmountVal(String(t.amount || ''));
                                }}
                                title="Editar monto en Quetzales"
                                className="rounded p-0.5 text-greige-ink transition-opacity hover:text-accent group-hover:opacity-100"
                              >
                                <Pencil size={11} />
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 whitespace-nowrap">
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-greige-ink">
                            {PAID_METHOD_LABELS[t.paymentMethod] || t.paymentMethod}
                          </span>
                        </td>
                        <td className="py-2.5 text-greige-ink max-w-xs truncate">
                          {t.notes || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
