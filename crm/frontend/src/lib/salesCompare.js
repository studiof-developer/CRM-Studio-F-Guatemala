// Fechas y comparaciones de la vista gerencial de ventas. Sin dependencias de React ni de la API, para poder probarlo solo
// (salesCompare.test.js). Todas las fechas son AAAA-MM-DD en hora de Guatemala.
export const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const monthStart = (day) => `${day.slice(0, 8)}01`;
const prevMonthStart = (day) => {
  const [y, m] = day.split('-').map(Number);
  return `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`;
};
const monthEnd = (start) => {
  const [y, m] = start.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

// El mismo período que usa el servidor, expresado como fechas (la semana empieza el lunes).
export function periodRange(period, from, to, today) {
  if (period === 'personalizado') return { from, to: to || from };
  if (period === 'ayer') { const y = addDays(today, -1); return { from: y, to: y }; }
  if (period === 'esta_semana') return { from: addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)), to: today };
  if (period === 'este_mes') return { from: monthStart(today), to: today };
  if (period === 'mes_anterior') { const s = prevMonthStart(today); return { from: s, to: monthEnd(s) }; }
  return { from: today, to: today };
}

// Con qué comparar: el período equivalente anterior. "Hoy" se compara contra ayer HASTA esta misma hora (un día a medias
// contra uno entero siempre parecería una caída); semana y mes, contra los mismos días del anterior.
export function previousPeriod(period, range, nowTime) {
  if (period === 'hoy') { const y = addDays(range.from, -1); return { from: y, to: y, untilTime: nowTime, label: 'ayer a esta misma hora' }; }
  if (period === 'ayer') { const y = addDays(range.from, -1); return { from: y, to: y, untilTime: null, label: 'el día anterior' }; }
  if (period === 'esta_semana') return { from: addDays(range.from, -7), to: addDays(range.to, -7), untilTime: null, label: 'la semana pasada (mismos días)' };
  if (period === 'este_mes' || period === 'mes_anterior') {
    const start = prevMonthStart(range.from);
    if (period === 'mes_anterior') return { from: start, to: monthEnd(start), untilTime: null, label: 'el mes previo' };
    const to = addDays(start, daysBetween(range.from, range.to));
    const end = monthEnd(start);
    return { from: start, to: to < end ? to : end, untilTime: null, label: 'el mes pasado (mismos días)' };
  }
  const len = daysBetween(range.from, range.to) + 1;
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(len - 1)), to, untilTime: null, label: 'el período anterior' };
}

// Total de las ventas confirmadas hasta cierta hora del día (HH:MM, hora de Guatemala); sin hora, de todo el día.
export function sumUntil(transactions, untilTime) {
  return (transactions ?? [])
    .filter((t) => t.status === 'confirmada' && Number(t.amount) > 0)
    .filter((t) => !untilTime || new Date(+new Date(t.createdAt) - 6 * 3600000).toISOString().slice(11, 16) <= untilTime)
    .reduce((s, t) => s + Number(t.amount), 0);
}

// Variación en %; null si no hay con qué comparar.
export function deltaPct(current, previous) {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

const fmt = (day, opts) => new Date(`${day}T12:00:00Z`).toLocaleDateString('es-GT', { timeZone: 'UTC', ...opts });
// Título legible del período: "Hoy · martes 20 de octubre", "Semana del 19 al 20 de octubre"…
export function periodTitle(period, range) {
  const t = periodTitleRaw(period, range);
  return t[0].toUpperCase() + t.slice(1);
}
function periodTitleRaw(period, range) {
  const long = { weekday: 'long', day: 'numeric', month: 'long' };
  if (period === 'hoy') return `Hoy · ${fmt(range.from, long)}`;
  if (period === 'ayer') return `Ayer · ${fmt(range.from, long)}`;
  if (period === 'esta_semana') return `Semana del ${fmt(range.from, { day: 'numeric' })} al ${fmt(range.to, { day: 'numeric', month: 'long' })}`;
  if (period === 'este_mes') return `${fmt(range.from, { month: 'long', year: 'numeric' })} · hasta hoy`;
  if (period === 'mes_anterior') return fmt(range.from, { month: 'long', year: 'numeric' });
  return range.from === range.to ? fmt(range.from, long) : `Del ${fmt(range.from, { day: 'numeric', month: 'short' })} al ${fmt(range.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
