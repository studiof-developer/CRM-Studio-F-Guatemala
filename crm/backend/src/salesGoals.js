import { pool } from './db.js';
import { getSetting } from './routes/settings.js';

// Meta mensual de ventas por asesora, definida por línea (hoy: Studio F, Q77,500 al mes cada una). Se guarda en app_settings
// ('sales_goals' = { "<lineId>": { monthly } }) para que administración la cambie sin tocar código.
const KEY = 'sales_goals';

export async function getGoals() {
  return (await getSetting(KEY, {})) ?? {};
}

// monthly vacío o 0 quita la meta de esa línea.
export async function saveGoal(lineId, monthly, userId) {
  const id = Number(lineId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Línea inválida'), { status: 400 });
  const amount = monthly === '' || monthly == null ? 0 : Number(monthly);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) throw Object.assign(new Error('Escribe una meta válida, en quetzales'), { status: 400 });
  const goals = { ...(await getGoals()) };
  if (amount > 0) goals[id] = { monthly: amount }; else delete goals[id];
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3`,
    [KEY, JSON.stringify(goals), userId ?? null]
  );
  return goals;
}

// Cómo va una asesora contra su meta, a la mitad del mes: lo esperado a hoy es proporcional a los días transcurridos, y la
// proyección es el ritmo actual llevado al mes completo.
export function paceStatus({ total, goal, day, days }) {
  const expected = (goal * day) / days;
  const projected = day > 0 ? (total / day) * days : 0;
  const status = total >= goal ? 'met' : total >= expected * 1.05 ? 'ahead' : total >= expected * 0.9 ? 'on_track' : 'behind';
  return { pct: goal > 0 ? (total / goal) * 100 : 0, expected, projected, remaining: Math.max(0, goal - total), status };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

// advisors: [{ name }] (asesoras asignadas a la línea); totals: [{ name, total, count }] (ventas del mes en esa línea).
// Aparecen las asesoras de la línea y cualquiera que haya vendido en ella; las ventas sin asesora van aparte.
export function buildGoalRows({ advisors, totals, goal, day, days }) {
  const byName = new Map();
  for (const a of advisors) byName.set(norm(a.name), { name: a.name, total: 0, count: 0 });
  let unassigned = 0;
  for (const t of totals) {
    if (norm(t.name) === 'sin asignar') { unassigned += Number(t.total); continue; }
    const cur = byName.get(norm(t.name)) ?? { name: t.name, total: 0, count: 0 };
    cur.total += Number(t.total); cur.count += Number(t.count);
    byName.set(norm(t.name), cur);
  }
  const rows = [...byName.values()].map((r) => ({ ...r, ...paceStatus({ total: r.total, goal, day, days }) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const teamTotal = rows.reduce((n, r) => n + r.total, 0);
  const teamGoal = goal * rows.length;
  return { advisors: rows, unassigned, team: { total: teamTotal, goal: teamGoal, ...paceStatus({ total: teamTotal, goal: teamGoal, day, days }) } };
}

// Día del mes y días del mes en hora de Guatemala.
export function monthClock(now = new Date()) {
  const gt = new Date(+now - 6 * 3600000);
  return { month: gt.toISOString().slice(0, 7), day: gt.getUTCDate(), days: new Date(Date.UTC(gt.getUTCFullYear(), gt.getUTCMonth() + 1, 0)).getUTCDate() };
}
