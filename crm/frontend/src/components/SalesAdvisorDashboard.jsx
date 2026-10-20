import { useEffect, useState, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import {
  Trophy, CircleDollarSign, Users, ShoppingBag, TrendingUp,
  Download, RefreshCw, Calendar, ArrowRight, MessageCircle,
  FileSpreadsheet, Filter, ChevronDown, ChevronUp, Pencil, X, Check,
  Copy, CheckCircle2, AlertCircle, Eye, ExternalLink, Sparkles, FileText, LayoutGrid, Table2
} from 'lucide-react';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { fetchSalesByAdvisor, fetchWhatsappNumbers, updateSale, rebuildSales, validateSaleAmount, fetchMe, fetchSalesGoals, saveSalesGoal } from '../api.js';
import ReassignAdvisor from './ReassignAdvisor.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import { showError, showSuccess } from './Toast.jsx';
import { guatemalaToday } from '../lib/pipelinePeriod.js';
import { PAID_METHOD_LABELS } from '../lib/paymentMethods.js';
import Badge from './Badge.jsx';
import SalesAnalysisModal from './SalesAnalysisModal.jsx';
import SalesCloseModal from './SalesCloseModal.jsx';
import SalesToolsMenu from './SalesToolsMenu.jsx';
import SalesHeadline from './SalesHeadline.jsx';
import AdvisorCards from './AdvisorCards.jsx';
import SalesGoalsPanel from './SalesGoalsPanel.jsx';
import SoldItemsModal from './SoldItemsModal.jsx';
import SalesInsights from './SalesInsights.jsx';
import { periodRange, previousPeriod, sumUntil, periodTitle } from '../lib/salesCompare.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

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

function renderChannelBadge(channel) {
  const ch = String(channel || 'whatsapp').toLowerCase();
  if (ch === 'instagram') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-purple-500/15 via-pink-500/15 to-orange-500/15 px-2 py-0.5 text-[10px] font-bold text-pink-600 dark:text-pink-400">
        Instagram
      </span>
    );
  }
  if (ch === 'messenger') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-bold text-blue-600 dark:text-blue-400">
        Messenger
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
      WhatsApp
    </span>
  );
}

function renderStatusBadge(status) {
  if (status === 'revisar') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-bold text-warn" title="Monto en Q0 o requiere validación de comprobante">
        <AlertCircle size={10} />
        Por revisar
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[10px] font-bold text-success">
      <CheckCircle2 size={10} />
      Confirmada
    </span>
  );
}

export default function SalesAdvisorDashboard() {
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
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [selectedAdvisorDetail, setSelectedAdvisorDetail] = useState(null);
  const [advisorDetailFilter, setAdvisorDetailFilter] = useState('todas');
  // Vista gerencial: tarjetas por asesora (por defecto) o la tabla completa con su gráfica. Se recuerda por navegador.
  const [viewMode, setViewMode] = useState(() => { try { return localStorage.getItem('sales:view') || 'tarjetas'; } catch { return 'tarjetas'; } });
  function changeView(v) { setViewMode(v); try { localStorage.setItem('sales:view', v); } catch { /* sin almacenamiento: no se recuerda */ } }
  const [previous, setPrevious] = useState(null); // { label, total, loading } — el período contra el que se compara
  const [updatedAt, setUpdatedAt] = useState(null);
  const [goalsData, setGoalsData] = useState(null); // { goals: [...] } — cumplimiento del mes por línea con meta
  const [itemsOpen, setItemsOpen] = useState(false);
  const [goalEdit, setGoalEdit] = useState(null); // { lineId, monthly, error } — ventana "Meta mensual"

  // Auditoría de ventas contra el chat (reemplaza al "Re-analizar chats" y a la auditoría del 14/10)
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditApplying, setAuditApplying] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  // Solo administradores y supervisores pueden corregir a mano la asesora de una venta.
  const [canManage, setCanManage] = useState(false);
  useEffect(() => { fetchMe().then((u) => setCanManage(['admin', 'supervisor'].includes(u?.role))).catch(() => {}); }, []);
  const [auditData, setAuditData] = useState(null);
  const [auditTab, setAuditTab] = useState('corregir');
  const [copiedAudit, setCopiedAudit] = useState(false);

  // Mismo periodo que muestra el ranking, expresado como fechas (el servidor admite hasta 31 días).
  function auditRange() {
    return periodRange(period, from, to, guatemalaToday());
  }

  async function handleOpenAudit() {
    if (auditLoading) return;
    setAuditLoading(true);
    try {
      setAuditData(await rebuildSales({ ...auditRange(), lineId, apply: false }));
      setAuditTab('corregir');
    } catch (err) {
      showError(err.message || 'Error al auditar las ventas');
    } finally {
      setAuditLoading(false);
    }
  }

  async function handleApplyAudit() {
    if (auditApplying || !auditData) return;
    setAuditApplying(true);
    try {
      setAuditData(await rebuildSales({ from: auditData.from, to: auditData.to, lineId, apply: true }));
      loadData();
    } catch (err) {
      showError(err.message || 'Error al aplicar las correcciones');
    } finally {
      setAuditApplying(false);
    }
  }

  function handleDownloadAuditTxt() {
    if (!auditData?.txtContent) return;
    const blob = new Blob([auditData.txtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditoria_ventas_${auditData.from}_${auditData.to}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleCopyAuditTxt() {
    if (!auditData?.txtContent) return;
    navigator.clipboard.writeText(auditData.txtContent);
    setCopiedAudit(true);
    setTimeout(() => setCopiedAudit(false), 3000);
  }

  async function handleSaveAmount(saleId) {
    const num = Number(editAmountVal);
    if (isNaN(num) || num < 0) return;
    setEditBusy(true);
    try {
      await updateSale(saleId, { amount: num, status: num > 0 ? 'confirmada' : 'revisar' });
      setEditingSaleId(null);
      setEditAmountVal('');
      loadData();
    } catch (err) {
      showError(err.message);
    } finally {
      setEditBusy(false);
    }
  }

  // El pago por link no deja el monto en el chat: se usó el último precio aprobado por el cliente y
  // un supervisor/administrador confirma que coincide con lo depositado (o lo corrige).
  const [validating, setValidating] = useState(null); // { sale, value, error } — ventana "Validar monto"
  function handleValidateAmount(t) { setValidating({ sale: t, value: String(t.amount), error: null }); }
  async function confirmValidateAmount() {
    const amount = Number(String(validating.value).replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) { setValidating((v) => ({ ...v, error: 'Escribe un monto válido, mayor que cero.' })); return; }
    try {
      await validateSaleAmount(validating.sale.id, amount);
      showSuccess('Monto validado');
      setValidating(null);
      loadData();
    } catch (err) {
      setValidating((v) => ({ ...v, error: err.message }));
    }
  }

  async function handleUpdateSaleStatus(saleId, newStatus) {
    try {
      await updateSale(saleId, { status: newStatus });
      loadData();
    } catch (err) {
      showError(err.message);
    }
  }

  function copySummaryToClipboard() {
    if (!salesData) return;
    const periodLabel = PERIOD_OPTIONS.find((p) => p.value === period)?.label || period;
    const dateStr = period === 'personalizado' ? `${from} al ${to}` : guatemalaToday();
    const sum = salesData.summary || { totalQuetzales: 0, totalVentas: 0, totalClientes: 0, ticketPromedio: 0 };
    const advs = salesData.advisors || [];

    let text = `📊 *REPORTE DE VENTAS POR ASESORAS*\n`;
    text += `🗓 *Período:* ${periodLabel} (${dateStr})\n`;
    text += `💰 *Total Vendido:* Q ${Number(sum.totalQuetzales || 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}\n`;
    text += `🛍 *Total Ventas:* ${sum.totalVentas} órdenes cerradas\n`;
    text += `👥 *Clientes Únicos:* ${sum.totalClientes}\n`;
    text += `🎯 *Ticket Promedio:* Q ${Number(sum.ticketPromedio || 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}\n\n`;

    text += `🏆 *RANKING DE VENTAS:*\n`;
    if (advs.length === 0) {
      text += `_Sin ventas registradas en este período_\n`;
    } else {
      advs.forEach((a) => {
        const medal = a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : '▫️';
        text += `${medal} *${a.advisorName}*: ${a.cantidadVentas} ventas | *Q ${Number(a.totalQuetzales || 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })}* (${a.porcentajeDelTotal}%)\n`;
      });
    }

    if (salesData.paymentMethods && salesData.paymentMethods.length > 0) {
      text += `\n💳 *MEDIOS DE PAGO:*\n`;
      salesData.paymentMethods.forEach((m) => {
        const label = PAID_METHOD_LABELS[m.method] || m.method;
        text += `• ${label}: ${m.count} ventas (Q ${Number(m.totalQuetzales || 0).toLocaleString('es-GT', { minimumFractionDigits: 2 })})\n`;
      });
    }

    text += `\n_Reporte generado en CRM Studio F_`;

    navigator.clipboard.writeText(text).then(() => {
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2500);
    });
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
        setUpdatedAt(new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit' }));
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

  const loadGoals = useCallback(() => { fetchSalesGoals().then(setGoalsData).catch(() => setGoalsData(null)); }, []);
  useEffect(() => { loadGoals(); }, [loadGoals, salesData]); // se refresca junto con las ventas

  function openGoalEdit(goal) {
    setGoalEdit({ lineId: String(goal?.lineId ?? lineId ?? whatsappNumbers[0]?.id ?? ''), monthly: String(goal?.monthly ?? 77500), error: null });
  }
  async function confirmGoal() {
    try {
      await saveSalesGoal(Number(goalEdit.lineId), goalEdit.monthly.trim() === '' ? 0 : Number(goalEdit.monthly.replace(',', '.')));
      showSuccess('Meta guardada');
      setGoalEdit(null);
      loadGoals();
    } catch (err) {
      setGoalEdit((g) => ({ ...g, error: err.message }));
    }
  }

  // Contra qué va el total: ayer a esta misma hora, la semana pasada, el mes pasado… (ver lib/salesCompare.js)
  useEffect(() => {
    if (!salesData) return undefined;
    let cancelled = false;
    const range = periodRange(period, from, to, guatemalaToday());
    const prev = previousPeriod(period, range, new Date(Date.now() - 6 * 3600000).toISOString().slice(11, 16));
    setPrevious({ label: prev.label, total: null, loading: true });
    fetchSalesByAdvisor({ period: 'personalizado', from: prev.from, to: prev.to, ...(lineId ? { lineId } : {}) })
      .then((d) => { if (!cancelled) setPrevious({ label: prev.label, total: prev.untilTime ? sumUntil(d.transactions, prev.untilTime) : d.summary.totalQuetzales, loading: false }); })
      .catch(() => { if (!cancelled) setPrevious(null); });
    return () => { cancelled = true; };
  }, [salesData]); // eslint-disable-line react-hooks/exhaustive-deps

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


  const summary = salesData?.summary || { totalQuetzales: 0, totalClientes: 0, totalVentas: 0, ticketPromedio: 0 };
  const advisors = salesData?.advisors || [];
  const transactions = salesData?.transactions || [];

  return (
    <div className="mb-8 rounded-3xl border border-line bg-paper p-5 shadow-sm md:p-6">
      <>
          {/* Encabezado y Filtros */}
          <div className="flex flex-col gap-4 border-b border-line pb-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success-bg text-success">
                  <Trophy size={20} />
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink">
                  Ventas del equipo
                </h2>
              </div>
              <p className="mt-1 text-xs text-greige-ink">
                Cuánto se vendió, quién lo vendió y cómo va frente al período anterior. Se calcula de los pagos que aparecen en los chats.
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
              className="rounded-xl border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink focus:border-accent focus:outline-none"
            >
              <option value="">Todas las líneas</option>
              {whatsappNumbers.map((num) => (
                <option key={num.id} value={num.id}>
                  {num.label || num.display_phone_number || num.phone_number}
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

          <button
            onClick={() => setCloseOpen(true)}
            title="Pagado y pendiente de cada asesora en un día, hasta la hora de corte (4 pm, 9 pm…), leído de los chats"
            className="flex items-center gap-1.5 rounded-xl border border-success/40 bg-success/10 px-3 py-1.5 text-xs font-semibold text-success transition-all hover:bg-success hover:text-white"
          >
            <CheckCircle2 size={13} />
            <span>Cierre del día</span>
          </button>

          <SalesToolsMenu
            items={[
              { label: copiedSummary ? '¡Copiado!' : 'Copiar resumen para WhatsApp', hint: 'Listo para pegar en el grupo', icon: copiedSummary ? Check : Copy, onClick: copySummaryToClipboard, disabled: !salesData },
              { label: 'Descargar Excel', hint: 'Esta tabla de rendimiento', icon: Download, onClick: exportToExcel, disabled: advisors.length === 0 },
              { label: 'Analizar chats vendidos', hint: 'Reconstruye las ventas leyendo los chats; exporta los chats a texto', icon: FileText, onClick: () => setAnalysisOpen(true) },
              { label: auditLoading ? 'Auditando…' : 'Auditar ventas', hint: 'Compara comprobantes del chat con lo registrado y corrige', icon: Sparkles, onClick: handleOpenAudit, disabled: auditLoading, busy: auditLoading },
            ]}
          />
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-4 text-xs font-medium text-danger">
          Error al cargar datos de ventas: {error}
        </div>
      )}

      {/* Arriba, lado a lado: el general (izquierda) y las asesoras (derecha). Abajo: la meta y el apoyo (medios de pago, ventas por día) */}
      <div className="mt-6 grid gap-6">
        <div className={`grid gap-6 ${viewMode === 'tarjetas' ? 'xl:grid-cols-12' : ''}`}>
          <div className={`min-w-0 ${viewMode === 'tarjetas' ? 'xl:col-span-5' : ''}`}>
      {/* Tarjeta principal: total del período y comparación */}
      <SalesHeadline
        title={periodTitle(period, periodRange(period, from, to, guatemalaToday()))}
        summary={summary}
        previous={previous}
        porValidarTotal={advisors.reduce((n, a) => n + (a.porValidarTotal || 0), 0)}
        porValidarCount={advisors.reduce((n, a) => n + (a.porValidar || 0), 0)}
        updatedAt={updatedAt}
        onShowItems={() => setItemsOpen(true)}
      />


          </div>
          <div className={`min-w-0 space-y-6 ${viewMode === 'tarjetas' ? 'xl:col-span-7' : ''}`}>
      {/* Resultado por asesora: tarjetas (por defecto) o tabla completa */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-ink">Resultado por asesora</h3>
        <div className="inline-flex rounded-xl border border-line bg-paper p-1 text-xs" role="group" aria-label="Forma de ver el resultado">
          {[['tarjetas', 'Tarjetas', LayoutGrid], ['tabla', 'Tabla', Table2]].map(([key, label, Icon]) => (
            <button key={key} type="button" aria-pressed={viewMode === key} onClick={() => changeView(key)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-all ${viewMode === key ? 'bg-accent text-white shadow-xs' : 'text-greige-ink hover:text-ink'}`}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      </div>
      {viewMode === 'tarjetas' ? (
        <div className="mt-3">
          <AdvisorCards advisors={advisors} onOpen={(a, filter) => { setSelectedAdvisorDetail(a); setAdvisorDetailFilter(filter); }} />
        </div>
      ) : (
        <>
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
                      <th className="pb-2 text-center">Por revisar</th>
                      <th className="pb-2 text-right">Part. %</th>
                      <th className="pb-2 pr-2 text-center">Detalle</th>
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
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedAdvisorDetail(a);
                                setAdvisorDetailFilter('todas');
                              }}
                              className="group flex items-center gap-1.5 text-left font-semibold text-ink hover:text-accent transition-colors"
                              title="Ver todas las ventas de este asesor"
                            >
                              <span>{a.advisorName}</span>
                              <Eye size={12} className="opacity-0 group-hover:opacity-100 text-accent transition-opacity" />
                            </button>
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
                            {a.turnos && (
                              <div className="mt-0.5 text-[10px] font-normal text-greige-ink">
                                {[['Mañana', a.turnos.manana], ['Tarde', a.turnos.tarde], ['Domingo', a.turnos.domingo], ['Fuera de turno', a.turnos.fuera]]
                                  .filter(([, v]) => v > 0)
                                  .map(([label, v]) => `${label} Q${Math.round(v).toLocaleString('es-GT')}`)
                                  .join(' · ')}
                              </div>
                            )}
                            {a.porValidar > 0 && (
                              <div className="mt-0.5 text-[10px] font-normal text-warning">Q{Math.round(a.porValidarTotal).toLocaleString('es-GT')} por validar ({a.porValidar})</div>
                            )}
                          </td>
                          <td className="py-3 text-right font-medium text-ink">
                            Q {a.ticketPromedio.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                          </td>
                          <td className="py-3 text-center">
                            {a.porRevisar > 0 ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedAdvisorDetail(a);
                                  setAdvisorDetailFilter('revisar');
                                }}
                                className="rounded-full bg-warn/15 px-2 py-0.5 font-semibold text-warn hover:bg-warn/25 transition-colors cursor-pointer"
                                title="Clic para filtrar ventas por revisar de este asesor"
                              >
                                {a.porRevisar}
                              </button>
                            ) : (
                              <span className="text-greige">—</span>
                            )}
                          </td>
                          <td className="py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-semibold text-ink">{a.porcentajeDelTotal}%</span>
                              <div className="h-1.5 w-10 overflow-hidden rounded-full bg-line">
                                <div
                                  className="h-full bg-success"
                                  style={{ width: `${Math.min(100, a.porcentajeDelTotal)}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td className="py-3 pr-2 text-center">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedAdvisorDetail(a);
                                setAdvisorDetailFilter('todas');
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-line bg-paper px-2 py-1 text-[11px] font-semibold text-greige-ink hover:border-accent hover:text-accent transition-colors shadow-2xs"
                              title="Ver detalle transaccional de este asesor"
                            >
                              <Eye size={12} />
                              <span>Ver</span>
                            </button>
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

        </>
      )}

          </div>
        </div>
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <div className="min-w-0">
      {/* Cumplimiento del mes contra la meta (solo las líneas que tienen meta) */}
      {(() => {
        const visible = (goalsData?.goals ?? []).filter((g) => !lineId || String(g.lineId) === String(lineId));
        if (visible.length) return <SalesGoalsPanel goals={visible} canEdit={canManage} onEdit={openGoalEdit} />;
        if (canManage && goalsData && !(goalsData.goals ?? []).length && whatsappNumbers.length) {
          return (
            <button type="button" onClick={() => openGoalEdit(null)} className="w-full rounded-2xl border border-dashed border-line p-4 text-center text-sm font-semibold text-accent hover:bg-accent-soft">
              Definir la meta mensual por asesora
            </button>
          );
        }
        return null;
      })()}


          </div>
          <div className="min-w-0 space-y-6">
          <SalesInsights daily={salesData?.daily ?? []} methods={salesData?.paymentMethods ?? []} total={summary.totalQuetzales} />
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
                      <th className="pb-2">Canal</th>
                      <th className="pb-2">Asesor</th>
                      <th className="pb-2">Cliente</th>
                      <th className="pb-2">Monto (Q)</th>
                      <th className="pb-2">Estado</th>
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
                        <td className="py-2.5 whitespace-nowrap">
                          {renderChannelBadge(t.channel)}
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
                          {canManage && <ReassignAdvisor saleId={t.id} current={t.advisorName} overridden={t.advisorOverridden} options={advisors.map((a) => a.advisorName)} onDone={loadData} />}
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
                          {(t.amountBasis === 'precio_aprobado' || t.attributionUncertain) && (
                            <div className="mt-1 flex items-center gap-1">
                              {t.validated ? (
                                <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">Monto validado</span>
                              ) : (
                                <>
                                  <span title={t.attributionUncertain ? 'Otra asesora tomó el chat después de los medios de pago: un supervisor confirma de quién es la venta' : 'El pago por link no trae monto: se usó el último precio aprobado por el cliente'} className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">Por validar</span>
                                  <button type="button" onClick={() => handleValidateAmount(t)} className="rounded-lg border border-line px-2 py-0.5 text-[10px] font-semibold text-ink hover:bg-muted">Validar</button>
                                </>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 whitespace-nowrap">
                          {renderStatusBadge(t.status)}
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

      {/* Modal de Detalle Transaccional por Asesora */}
      {selectedAdvisorDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="relative max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-3xl border border-line bg-paper shadow-2xl flex flex-col">
            {/* Header Modal */}
            <div className="flex items-center justify-between border-b border-line p-5 bg-paper">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 text-accent font-bold text-lg">
                  {selectedAdvisorDetail.advisorName.charAt(0)}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-ink">
                      Ventas de {selectedAdvisorDetail.advisorName}
                    </h3>
                    <span className="rounded-full bg-success-bg px-2.5 py-0.5 text-xs font-bold text-success">
                      Q {selectedAdvisorDetail.totalQuetzales.toLocaleString('es-GT', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <p className="text-xs text-greige-ink">
                    {selectedAdvisorDetail.cantidadVentas} ventas cerradas ({selectedAdvisorDetail.clientesVendidos} clientes) • Ticket prom: Q {selectedAdvisorDetail.ticketPromedio.toLocaleString('es-GT', { minimumFractionDigits: 2 })} • {selectedAdvisorDetail.porcentajeDelTotal}% del total
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAdvisorDetail(null)}
                className="rounded-xl p-2 text-greige-ink hover:bg-muted hover:text-ink transition-colors"
                title="Cerrar ventana"
              >
                <X size={18} />
              </button>
            </div>

            {/* Filtros dentro del Modal */}
            <div className="flex flex-wrap items-center justify-between border-b border-line bg-muted/40 px-5 py-2.5 gap-2">
              <div className="flex items-center gap-2">
                {['todas', 'revisar', 'confirmada'].map((f) => {
                  const count = (transactions || []).filter(
                    (t) => t.advisorName === selectedAdvisorDetail.advisorName && (f === 'todas' || t.status === f)
                  ).length;
                  const labels = { todas: 'Todas', revisar: 'Por revisar', confirmada: 'Confirmadas' };
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setAdvisorDetailFilter(f)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
                        advisorDetailFilter === f
                          ? 'bg-ink text-paper shadow-xs'
                          : 'text-greige-ink hover:text-ink hover:bg-paper'
                      }`}
                    >
                      {labels[f]} ({count})
                    </button>
                  );
                })}
              </div>
              <span className="text-[11px] text-greige-ink">
                Período: <strong>{PERIOD_OPTIONS.find((p) => p.value === period)?.label || period}</strong>
              </span>
            </div>

            {/* Lista de Transacciones de esta asesora */}
            <div className="flex-1 overflow-y-auto p-5 bg-paper">
              {(() => {
                const advisorTransactions = (transactions || []).filter(
                  (t) =>
                    t.advisorName === selectedAdvisorDetail.advisorName &&
                    (advisorDetailFilter === 'todas' || t.status === advisorDetailFilter)
                );

                if (advisorTransactions.length === 0) {
                  return (
                    <div className="flex flex-col items-center justify-center py-12 text-center text-greige-ink">
                      <ShoppingBag size={28} className="mb-2 opacity-40" />
                      <p className="text-xs font-medium">No hay ventas en esta categoría para este período.</p>
                    </div>
                  );
                }

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-line text-[11px] uppercase tracking-wider text-greige-ink">
                          <th className="pb-2">Fecha</th>
                          <th className="pb-2">Canal</th>
                          <th className="pb-2">Cliente</th>
                          <th className="pb-2">Monto (Q)</th>
                          <th className="pb-2">Cotizado / Recibo</th>
                          <th className="pb-2">Estado</th>
                          <th className="pb-2">Medio</th>
                          <th className="pb-2 pr-2 text-right">Acción</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line/60">
                        {advisorTransactions.map((t) => (
                          <tr key={t.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                            <td className="py-2.5 text-greige-ink whitespace-nowrap">
                              {new Date(t.createdAt).toLocaleDateString('es-GT', {
                                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Guatemala'
                              })}
                            </td>
                            <td className="py-2.5 whitespace-nowrap">
                              {renderChannelBadge(t.channel)}
                            </td>
                            <td className="py-2.5">
                              <a
                                href={`/conversations?phone=${t.customerPhone}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-semibold text-ink hover:text-accent hover:underline flex items-center gap-1"
                              >
                                <span>{t.customerName}</span>
                                <ExternalLink size={10} className="text-greige-ink" />
                              </a>
                              <p className="text-[11px] text-greige-ink">{t.customerPhone}</p>
                          {canManage && <ReassignAdvisor saleId={t.id} current={t.advisorName} overridden={t.advisorOverridden} options={advisors.map((a) => a.advisorName)} onDone={loadData} />}
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
                                    title="Editar monto"
                                    className="rounded p-0.5 text-greige-ink transition-opacity hover:text-accent group-hover:opacity-100"
                                  >
                                    <Pencil size={11} />
                                  </button>
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 text-greige-ink text-[11px] whitespace-nowrap">
                              {t.quotedAmount || t.receiptAmount ? (
                                <div className="flex flex-col">
                                  {t.quotedAmount && <span>Cotizado: Q {t.quotedAmount.toFixed(2)}</span>}
                                  {t.receiptAmount && <span>Recibo OCR: Q {t.receiptAmount.toFixed(2)}</span>}
                                </div>
                              ) : (
                                <span>—</span>
                              )}
                              {(t.amountBasis === 'precio_aprobado' || t.attributionUncertain) && (
                                <div className="mt-1 flex items-center gap-1">
                                  {t.validated ? (
                                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">Monto validado</span>
                                  ) : (
                                    <>
                                      <span title={t.attributionUncertain ? 'Otra asesora tomó el chat después de los medios de pago: un supervisor confirma de quién es la venta' : 'El pago por link no trae monto: se usó el último precio aprobado por el cliente'} className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">Por validar</span>
                                      <button type="button" onClick={() => handleValidateAmount(t)} className="rounded-lg border border-line px-2 py-0.5 text-[10px] font-semibold text-ink hover:bg-muted">Validar</button>
                                    </>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 whitespace-nowrap">
                              {renderStatusBadge(t.status)}
                            </td>
                            <td className="py-2.5 whitespace-nowrap">
                              <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-greige-ink">
                                {PAID_METHOD_LABELS[t.paymentMethod] || t.paymentMethod}
                              </span>
                            </td>
                            <td className="py-2.5 pr-2 text-right whitespace-nowrap">
                              {t.status === 'revisar' ? (
                                <button
                                  type="button"
                                  onClick={() => handleUpdateSaleStatus(t.id, 'confirmada')}
                                  className="inline-flex items-center gap-1 rounded-lg bg-success-bg px-2 py-1 text-[11px] font-bold text-success hover:bg-success hover:text-white transition-colors cursor-pointer"
                                  title="Marcar como confirmada"
                                >
                                  <Check size={11} />
                                  <span>Confirmar</span>
                                </button>
                              ) : (
                                <span className="text-[11px] text-greige-ink">OK</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Modal de Auditoría Forense de Chats del 14 de Octubre */}
      <ConfirmDialog
        open={!!validating}
        title="Validar el monto de la venta"
        message={validating ? `Confirma el monto realmente depositado o validado en el banco. Monto actual: Q${Number(validating.sale.amount).toFixed(2)}` : ''}
        confirmLabel="Validar monto"
        onConfirm={confirmValidateAmount}
        onCancel={() => setValidating(null)}
      >
        {validating && (
          <div>
            <label className="text-xs font-medium text-greige-ink">Monto (Q)</label>
            <input
              type="number" step="0.01" min="0" autoFocus value={validating.value}
              onChange={(e) => setValidating((v) => ({ ...v, value: e.target.value, error: null }))}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmValidateAmount(); }}
              className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
            {validating.error && <p className="mt-1 text-xs font-medium text-danger">{validating.error}</p>}
          </div>
        )}
      </ConfirmDialog>
      <SoldItemsModal
        open={itemsOpen}
        onClose={() => setItemsOpen(false)}
        title={periodTitle(period, periodRange(period, from, to, guatemalaToday())) + (lineId ? ` · ${whatsappNumbers.find((n) => String(n.id) === String(lineId))?.label ?? 'línea'}` : ' · todas las líneas')}
        filters={{ period, ...(period === 'personalizado' ? { from, to } : {}), ...(lineId ? { lineId } : {}) }}
      />
      <ConfirmDialog
        open={!!goalEdit}
        title="Meta mensual por asesora"
        message="Cuánto debe vender cada asesora de esa línea al mes. Se compara con lo vendido en el mes corrido."
        confirmLabel="Guardar meta"
        onConfirm={confirmGoal}
        onCancel={() => setGoalEdit(null)}
      >
        {goalEdit && (
          <div className="grid gap-3">
            <div>
              <label className="text-xs font-medium text-greige-ink">Línea</label>
              <select value={goalEdit.lineId} onChange={(e) => setGoalEdit((g) => ({ ...g, lineId: e.target.value }))} className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent">
                {whatsappNumbers.map((n) => <option key={n.id} value={n.id}>{n.label || n.display_phone_number || `Línea ${n.id}`}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-greige-ink">Meta mensual por asesora (Q)</label>
              <input
                type="number" min="0" step="100" autoFocus value={goalEdit.monthly}
                onChange={(e) => setGoalEdit((g) => ({ ...g, monthly: e.target.value, error: null }))}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmGoal(); }}
                className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              />
              <p className="mt-1 text-[11px] text-greige">Déjalo vacío para quitar la meta de esa línea.</p>
              {goalEdit.error && <p className="mt-1 text-xs font-medium text-danger">{goalEdit.error}</p>}
            </div>
          </div>
        )}
      </ConfirmDialog>
      <SalesAnalysisModal open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
      <SalesCloseModal open={closeOpen} onClose={() => setCloseOpen(false)} />

      {auditData && (() => {
        const STATUS = {
  ok: ['Correcta', 'bg-success/10 text-success'],
  sin_venta: ['Falta la venta', 'bg-danger/10 text-danger'],
  asesor_distinto: ['Asesora distinta', 'bg-warning/15 text-warning'],
  fecha_distinta: ['Fecha distinta', 'bg-warning/15 text-warning'],
  monto_distinto: ['Monto distinto', 'bg-warning/15 text-warning'],
  confirmacion_pendiente: ['Lista para confirmar', 'bg-success/10 text-success'],
  sin_contexto: ['Sin medios de pago ni confirmación', 'bg-secondary text-greige-ink'],
  sin_evidencia: ['Sin comprobante', 'bg-danger/10 text-danger'],
  duplicada: ['Duplicada', 'bg-danger/10 text-danger'],
  reenviado: ['Comprobante reenviado', 'bg-secondary text-greige-ink'],
  bloqueada: ['Bloqueada (calibrada a mano)', 'bg-secondary text-greige-ink'],
  historico_bloqueado: ['Histórico (antes del 16/10)', 'bg-secondary text-greige-ink'],
};
        const NEEDS_ACTION = ['sin_venta', 'asesor_distinto', 'fecha_distinta', 'monto_distinto', 'confirmacion_pendiente', 'sin_evidencia', 'duplicada'];
        const rows = (auditData.items || []).filter((i) => (auditTab === 'corregir' ? NEEDS_ACTION.includes(i.status) : true));
        const pending = Object.values(auditData.plan || {}).reduce((a, b) => a + b, 0);
        const fmtDate = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
        const SHIFT = { manana: 'Mañana', tarde: 'Tarde', domingo: 'Domingo', fuera_de_turno: 'Fuera de turno' };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setAuditData(null)}>
            <div className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-line bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between gap-3 border-b border-line p-5">
                <div>
                  <h3 className="text-base font-bold text-ink">Auditoría de ventas contra el chat</h3>
                  <p className="mt-0.5 text-xs text-greige-ink">
                    {auditData.from} al {auditData.to} · la venta se acredita a quien dio los medios de pago (o atendía al pagar) y toma la fecha del comprobante
                  </p>
                </div>
                <button type="button" onClick={() => setAuditData(null)} className="rounded-xl p-2 text-greige-ink transition-colors hover:bg-muted hover:text-ink" title="Cerrar">
                  <X size={20} />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
                {Object.entries(auditData.counts || {}).map(([k, v]) => (
                  <span key={k} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${(STATUS[k] || ['', 'bg-secondary text-ink'])[1]}`}>
                    {(STATUS[k] || [k])[0]}: {v}
                  </span>
                ))}
                <div className="ml-auto flex gap-1 rounded-xl bg-secondary p-1 text-xs font-semibold">
                  {[['corregir', 'Por corregir'], ['todo', 'Todo']].map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setAuditTab(k)} className={`rounded-lg px-3 py-1 transition-colors ${auditTab === k ? 'bg-paper text-ink shadow-xs' : 'text-greige-ink hover:text-ink'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="min-h-[200px] flex-1 overflow-auto px-5 py-3">
                {rows.length === 0 ? (
                  <p className="py-12 text-center text-sm text-greige-ink">
                    {auditTab === 'corregir' ? 'Todo coincide con el chat en este periodo.' : 'No hay comprobantes en este periodo.'}
                  </p>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-line text-[11px] uppercase tracking-wide text-greige-ink">
                        <th className="py-2 pr-3">Estado</th>
                        <th className="py-2 pr-3">Fecha / turno</th>
                        <th className="py-2 pr-3">Cliente</th>
                        <th className="py-2 pr-3 text-right">Monto</th>
                        <th className="py-2 pr-3">Debería ser</th>
                        <th className="py-2">Registrada a</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((i, idx) => (
                        <tr key={`${i.receiptId ?? 's'}-${i.saleId ?? idx}-${idx}`} className="border-b border-line-soft align-top">
                          <td className="py-2 pr-3">
                            <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${(STATUS[i.status] || ['', 'bg-secondary text-ink'])[1]}`}>
                              {(STATUS[i.status] || [i.status])[0]}
                            </span>
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 text-ink">{fmtDate(i.at)}<div className="text-[10px] text-greige-ink">{SHIFT[i.shift] || i.shift}</div>{i.confirmedAt && <div className="text-[10px] text-greige-ink">Confirmó {i.confirmedBy ?? 'la asesora'} · {fmtDate(i.confirmedAt)}</div>}</td>
                          <td className="py-2 pr-3 text-ink">{i.customer}<div className="text-[10px] text-greige-ink">{i.phone}</div></td>
                          <td className="whitespace-nowrap py-2 pr-3 text-right font-semibold text-ink">Q {Number(i.amount).toLocaleString('es-GT', { minimumFractionDigits: 2 })}</td>
                          <td className="py-2 pr-3 text-ink">{i.duplicateOf ? (<>Es la misma venta del {fmtDate(i.duplicateOf.at)}<div className="text-[10px] text-greige-ink">{i.duplicateOf.advisor} · Q {Number(i.duplicateOf.amount).toLocaleString('es-GT', { minimumFractionDigits: 2 })}</div></>) : (<>{i.expectedAdvisor || '—'}{i.rule && <div className="text-[10px] text-greige-ink">{i.rule.replace(/_/g, ' ')}</div>}{i.via && <div className="text-[10px] text-greige-ink">leído de {i.via}{i.voucher ? ' + voucher' : ''}</div>}</>)}</td>
                          <td className="py-2 text-ink">{i.recordedAdvisor || '—'}{i.recordedAt && <div className="text-[10px] text-greige-ink">{fmtDate(i.recordedAt)}</div>}{i.recordedAmount != null && i.status === 'monto_distinto' && <div className="text-[10px] font-semibold text-warning">Q {Number(i.recordedAmount).toLocaleString('es-GT', { minimumFractionDigits: 2 })} registrado</div>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4">
                <div className="text-xs text-greige-ink">
                  {auditData.applied
                    ? <span className="font-semibold text-success">Correcciones aplicadas. Las ventas sin comprobante quedaron "por revisar" (no suman al total).</span>
                    : pending > 0
                      ? <span>Al aplicar: <strong>{auditData.plan.insertar}</strong> ventas nuevas · <strong>{auditData.plan.reasignar}</strong> corregidas · <strong>{auditData.plan.promover}</strong> se confirman · <strong>{auditData.plan.marcarRevisar}</strong> pasan a "por revisar". No se borra nada.</span>
                      : <span>No hay nada que corregir.</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={handleCopyAuditTxt} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-muted">
                    {copiedAudit ? <Check size={13} /> : <Copy size={13} />}<span>{copiedAudit ? 'Copiado' : 'Copiar'}</span>
                  </button>
                  <button type="button" onClick={handleDownloadAuditTxt} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-muted">
                    <Download size={13} /><span>Descargar .txt</span>
                  </button>
                  {!auditData.applied && pending > 0 && (
                    <button type="button" onClick={handleApplyAudit} disabled={auditApplying} className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                      {auditApplying ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                      <span>{auditApplying ? 'Aplicando...' : 'Aplicar correcciones'}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
