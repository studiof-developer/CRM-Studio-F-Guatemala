import { guatemalaParts } from './salesRules.js';

// Contrasta, día por día, lo que los chats comprueban (filas del motor) con lo que el CRM tenía
// registrado en la tabla de ventas (lo que reportan/marcan las asesoras). Función pura: no lee ni
// escribe en la base.
//   engineRows: filas de analyzeCustomer (at, customerId, amount, advisor, verified, amountBasis…)
//   sales:      ventas registradas (id, customer_id, created_at, amount, status, advisor, …)
// Una venta cuenta como registrada si está 'confirmada' y con monto, igual que en el dashboard.
const MATCH_MS = 36 * 3600000;
const lc = (s) => String(s ?? 'Sin atribuir').trim().toLowerCase();
const day = (d) => guatemalaParts(d).ymd;
const counted = (s) => s.status === 'confirmada' && Number(s.amount) > 0;
const porValidar = (r) => r.verified && (r.amountBasis === 'precio_aprobado' || r.attributionUncertain);

function daysBetween(from, to) {
  const out = [];
  for (let t = +new Date(`${from}T00:00:00Z`); t <= +new Date(`${to}T00:00:00Z`); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function compareWithRegistered({ engineRows, sales, from, to }) {
  const inRange = (d) => { const y = day(d); return y >= from && y <= to; };
  const engine = engineRows.filter((r) => inRange(r.at)).sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const byCustomer = new Map();
  for (const s of sales) (byCustomer.get(s.customer_id) ?? byCustomer.set(s.customer_id, []).get(s.customer_id)).push(s);

  // Empareja cada venta del chat con una registrada del mismo cliente (±36 h): primero la que tiene
  // el mismo monto (±Q1) y, con lo que sobra, cualquier otra; así una diferencia de monto se ve
  // como "monto distinto" y no como una venta que falta más otra que sobra.
  const claimed = new Set();
  const pairOf = new Map();
  const nearest = (r, ok) => (byCustomer.get(r.customerId) ?? [])
    .filter((s) => !claimed.has(s.id) && Math.abs(+new Date(s.created_at) - +new Date(r.at)) <= MATCH_MS && ok(s))
    .sort((a, b) => Math.abs(+new Date(a.created_at) - +new Date(r.at)) - Math.abs(+new Date(b.created_at) - +new Date(r.at)))[0];
  for (const pass of [(r, s) => r.amount != null && Math.abs(Number(s.amount) - r.amount) <= 1, () => true]) {
    for (const r of engine) {
      if (pairOf.has(r)) continue;
      const s = nearest(r, (x) => pass(r, x));
      if (s) { claimed.add(s.id); pairOf.set(r, s); }
    }
  }

  const items = [];
  for (const r of engine) {
    const s = pairOf.get(r);
    const base = { day: day(r.at), at: r.at, customer: r.customer, phone: r.phone, last4: r.last4, customerId: r.customerId, chatAmount: r.amount, chatAdvisor: r.advisor, verified: r.verified, amountBasis: r.amountBasis, via: r.via, issues: r.issues, quotedAmounts: r.quotedAmounts ?? [] };
    if (!s) { items.push({ ...base, status: 'solo_en_chat' }); continue; }
    const diffs = [];
    if (r.amount != null && Math.abs(Number(s.amount) - r.amount) >= 0.5) diffs.push('monto');
    if (r.advisor && lc(r.advisor) !== lc(s.advisorCanonical ?? s.advisor_name)) diffs.push('asesora');
    if (day(s.created_at) !== day(r.at)) diffs.push('dia');
    if (r.verified && !counted(s)) diffs.push('no_confirmada_en_crm');
    items.push({ ...base, status: diffs.length ? 'con_diferencias' : 'coincide', diffs, saleId: s.id, registeredAmount: Number(s.amount), registeredAdvisor: s.advisorCanonical ?? s.advisor_name, registeredAt: s.created_at, registeredStatus: s.status });
  }
  for (const s of sales) {
    if (claimed.has(s.id) || !inRange(s.created_at)) continue;
    items.push({ day: day(s.created_at), at: s.created_at, customer: s.customer_name, phone: s.phone, customerId: s.customer_id, status: 'solo_registrada', saleId: s.id, registeredAmount: Number(s.amount), registeredAdvisor: s.advisorCanonical ?? s.advisor_name, registeredAt: s.created_at, registeredStatus: s.status, locked: !!s.attribution_locked });
  }

  const zero = () => ({ registradoN: 0, registrado: 0, revisarN: 0, revisar: 0, chatN: 0, chat: 0, porValidar: 0, pendientesN: 0, pendientes: 0 });
  const daily = new Map(daysBetween(from, to).map((d) => [d, { day: d, ...zero() }]));
  const perAdvisor = new Map();
  const bump = (d, advisor, fn) => {
    fn(daily.get(d));
    const key = `${d}|${lc(advisor)}`;
    if (!perAdvisor.has(key)) perAdvisor.set(key, { day: d, advisor: advisor ?? 'Sin atribuir', ...zero() });
    fn(perAdvisor.get(key));
  };
  for (const s of sales) {
    if (!inRange(s.created_at)) continue;
    const a = s.advisorCanonical ?? s.advisor_name;
    if (counted(s)) bump(day(s.created_at), a, (x) => { x.registradoN++; x.registrado += Number(s.amount); });
    else if (Number(s.amount) > 0) bump(day(s.created_at), a, (x) => { x.revisarN++; x.revisar += Number(s.amount); });
  }
  for (const r of engine) {
    const amt = r.amount ?? 0;
    if (r.verified) bump(day(r.at), r.advisor, (x) => { x.chatN++; x.chat += amt; if (porValidar(r)) x.porValidar += amt; });
    else bump(day(r.at), r.advisor, (x) => { x.pendientesN++; x.pendientes += amt; });
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]));
  const withDiff = (o) => round({ ...o, diferencia: o.chat - o.registrado });
  const dailyRows = [...daily.values()].map(withDiff);
  const advisorDay = [...perAdvisor.values()].map(withDiff).sort((a, b) => a.day.localeCompare(b.day) || a.advisor.localeCompare(b.advisor));
  const totals = withDiff(dailyRows.reduce((t, d) => { for (const k of Object.keys(zero())) t[k] += d[k]; return t; }, zero()));
  const counts = items.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
  return { from, to, totals, counts, daily: dailyRows, advisorDay, items };
}
