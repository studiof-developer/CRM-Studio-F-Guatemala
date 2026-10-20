import { useCallback, useEffect, useState } from 'react';
import { fetchSalesByAdvisor, fetchSalesGoals } from '../api.js';
import { guatemalaToday } from './pipelinePeriod.js';
import { periodRange, previousPeriod, sumUntil } from './salesCompare.js';

// Datos del reporte de ventas del Dashboard: filtros (período, fechas, línea), las ventas del período, contra qué se compara
// (ayer a esta misma hora, la semana pasada…) y el cumplimiento de las metas del mes. El componente solo decide cómo acomodarlos.
export default function useSalesReport() {
  const [period, setPeriod] = useState('hoy');
  const [from, setFrom] = useState(guatemalaToday());
  const [to, setTo] = useState(guatemalaToday());
  const [lineId, setLineId] = useState(''); // '' = todas las líneas
  const [salesData, setSalesData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [previous, setPrevious] = useState(null); // { label, total, loading }
  const [goalsData, setGoalsData] = useState(null); // { goals: [...] }

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    const filters = { period };
    if (period === 'personalizado') { filters.from = from; filters.to = to; }
    if (lineId) filters.lineId = lineId;
    fetchSalesByAdvisor(filters)
      .then((data) => {
        setSalesData(data);
        setUpdatedAt(new Date().toLocaleTimeString('es-GT', { timeZone: 'America/Guatemala', hour: '2-digit', minute: '2-digit' }));
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [period, from, to, lineId]);
  useEffect(() => { loadData(); }, [loadData]);

  const loadGoals = useCallback(() => { fetchSalesGoals().then(setGoalsData).catch(() => setGoalsData(null)); }, []);
  useEffect(() => { loadGoals(); }, [loadGoals, salesData]); // se refresca junto con las ventas

  // Contra qué va el total (ver lib/salesCompare.js)
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

  return { period, setPeriod, from, setFrom, to, setTo, lineId, setLineId, salesData, loading, error, updatedAt, previous, goalsData, loadData, loadGoals };
}
