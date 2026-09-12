import { useEffect, useState } from 'react';
import { Calendar, LayoutGrid } from 'lucide-react';
import { fetchLastAdvisorActivity } from '../api.js';

// Guatemala never observes DST — a fixed -06 offset always gives today's real local
// calendar date regardless of the browser's own timezone, matching the same convention
// the "Sin responder" report and the backend's own pipeline date filter use.
export function guatemalaToday() {
  return new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
}
export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function monthBounds(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}
export const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const PERIOD_OPTIONS = [
  { value: 'todo', label: 'Todo', icon: LayoutGrid, iconClassName: 'text-greige-ink' },
  { value: 'hoy', label: 'Hoy', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'ayer', label: 'Ayer', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'semana', label: 'Última semana', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'mes', label: 'Mes', icon: Calendar, iconClassName: 'text-accent' },
  { value: 'personalizado', label: 'Periodo personalizado', icon: Calendar, iconClassName: 'text-accent' },
];

export const guatemalaMidnight = (dateStr) => `${dateStr}T00:00:00-06:00`;

// "Hoy"/"Ayer" don't cut at calendar midnight — they cut at the last moment staff
// (advisor/supervisor/admin, all tagged sentBy:'advisor') wrote before that day started,
// since a shift's leftover backlog from 11pm is "today's" work, not yesterday's. Fetched
// once per mount, not kept live — a fixed snapshot for the session.
export function useDayCutoffs(todayStr) {
  const [todayCutoff, setTodayCutoff] = useState(null);
  const [yesterdayCutoff, setYesterdayCutoff] = useState(null);
  useEffect(() => {
    fetchLastAdvisorActivity(guatemalaMidnight(todayStr)).then(({ timestamp }) => setTodayCutoff(timestamp)).catch(() => {});
    fetchLastAdvisorActivity(guatemalaMidnight(addDays(todayStr, -1))).then(({ timestamp }) => setYesterdayCutoff(timestamp)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { todayCutoff, yesterdayCutoff };
}
