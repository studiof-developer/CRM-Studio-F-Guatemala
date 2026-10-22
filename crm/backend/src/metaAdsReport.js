import { getMetaAdsCredentials, graphGet } from './metaAds.js';

// Informe de anuncios de Meta (solo lectura, ads_read): las mismas columnas que el Administrador de anuncios usa en los reportes de
// la pauta (gasto, conversaciones con mensajes, costo por conversación, % de conversión, clics en el enlace, CPC y CTR) por campaña,
// conjunto o anuncio, comparado con el período anterior, más un texto con lo que llama la atención. Todo en la moneda de la cuenta.
const CONVERSATION = 'onsite_conversion.messaging_conversation_started_7d';
const LEVELS = {
  campaign: { fields: ['campaign_id', 'campaign_name'], idKey: 'campaign_id', nameKey: 'campaign_name', edge: 'campaigns' },
  adset: { fields: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'], idKey: 'adset_id', nameKey: 'adset_name', edge: 'adsets' },
  ad: { fields: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'], idKey: 'ad_id', nameKey: 'ad_name', edge: 'ads' },
};
const METRICS = ['spend', 'impressions', 'reach', 'frequency', 'inline_link_clicks', 'inline_link_click_ctr', 'cpm', 'actions'];
const CTR_GOAL = 2; // % de CTR sobre el enlace que se considera sano (el que usan en los reportes diarios)
const COST_UP = 0.15; // un costo por conversación que sube más de 15% contra el período anterior se avisa

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const div = (a, b) => (b > 0 ? a / b : null);

// Una fila de la API de Meta -> las métricas del informe.
export function rowMetrics(r, level = 'campaign') {
  const L = LEVELS[level];
  const spend = num(r.spend);
  const impressions = num(r.impressions);
  const linkClicks = num(r.inline_link_clicks);
  const conversations = num((r.actions ?? []).find((a) => a.action_type === CONVERSATION)?.value);
  return {
    id: r[L.idKey], name: r[L.nameKey] ?? '(sin nombre)', campaign: r.campaign_name ?? null, adset: r.adset_name ?? null,
    spend, impressions, reach: num(r.reach), frequency: num(r.frequency), linkClicks, conversations,
    costPerConversation: div(spend, conversations), conversionPct: linkClicks > 0 ? (conversations / linkClicks) * 100 : null,
    cpc: div(spend, linkClicks), ctr: r.inline_link_click_ctr != null ? num(r.inline_link_click_ctr) : (impressions > 0 ? (linkClicks / impressions) * 100 : null),
    cpm: r.cpm != null ? num(r.cpm) : (impressions > 0 ? (spend / impressions) * 1000 : null),
  };
}

// Suma de las filas (los porcentajes y costos se recalculan con las sumas, no se promedian).
export function totalsOf(rows) {
  const t = rows.reduce((a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, linkClicks: a.linkClicks + r.linkClicks, conversations: a.conversations + r.conversations, reach: a.reach + r.reach }),
    { spend: 0, impressions: 0, linkClicks: 0, conversations: 0, reach: 0 });
  return {
    ...t, costPerConversation: div(t.spend, t.conversations), conversionPct: t.linkClicks > 0 ? (t.conversations / t.linkClicks) * 100 : null,
    cpc: div(t.spend, t.linkClicks), ctr: t.impressions > 0 ? (t.linkClicks / t.impressions) * 100 : null, cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null,
  };
}

const daysBetween = (since, until) => Math.round((+new Date(`${until}T12:00:00Z`) - +new Date(`${since}T12:00:00Z`)) / 86400000) + 1;
export const previousRange = (since, until) => {
  const n = daysBetween(since, until);
  const shift = (d, k) => new Date(+new Date(`${d}T12:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
  return { since: shift(since, -n), until: shift(since, -1) };
};

// Lo que llama la atención, en el tono de los reportes diarios. fmt(n) da el monto con la moneda de la cuenta.
export function observations({ rows, previous, totals, since, until, fmt }) {
  const out = [];
  const days = daysBetween(since, until);
  const active = rows.filter((r) => r.spend > 0);
  if (!active.length) return ['No hubo gasto en este período.'];
  out.push(`Gasto total ${fmt(totals.spend)}${days > 1 ? ` (${fmt(totals.spend / days)} por día)` : ''} · ${totals.conversations} conversaciones${totals.costPerConversation ? ` a ${fmt(totals.costPerConversation)} cada una` : ''}.`);

  const good = active.filter((r) => r.ctr != null && r.ctr >= CTR_GOAL);
  const bad = active.filter((r) => r.ctr != null && r.ctr < CTR_GOAL);
  if (good.length === active.length) out.push(`El CTR de todas las campañas está por encima de ${CTR_GOAL}% ✅`);
  else {
    if (good.length) out.push(`El CTR de ${good.length} ${good.length === 1 ? 'campaña está' : 'campañas están'} por encima de ${CTR_GOAL}% ✅`);
    if (bad.length) out.push(`CTR por debajo de ${CTR_GOAL}%: ${bad.map((r) => `${r.name} (${r.ctr.toFixed(2)}%)`).join(', ')}`);
  }

  const prevById = new Map((previous ?? []).map((r) => [r.id, r]));
  for (const r of active) {
    const p = prevById.get(r.id);
    if (r.conversations === 0) out.push(`${r.name} gastó ${fmt(r.spend)} y no trajo conversaciones`);
    else if (p?.costPerConversation && r.costPerConversation > p.costPerConversation * (1 + COST_UP)) out.push(`${r.name}: el costo por conversación subió de ${fmt(p.costPerConversation)} a ${fmt(r.costPerConversation)}`);
    else if (p?.costPerConversation && r.costPerConversation < p.costPerConversation * (1 - COST_UP)) out.push(`${r.name}: el costo por conversación bajó de ${fmt(p.costPerConversation)} a ${fmt(r.costPerConversation)} ✅`);
  }
  if (totals.costPerConversation) {
    const costly = active.filter((r) => r.conversations > 0 && r.costPerConversation >= totals.costPerConversation * 1.5);
    if (costly.length) out.push(`Las más caras contra el promedio (${fmt(totals.costPerConversation)}): ${costly.map((r) => `${r.name} ${fmt(r.costPerConversation)}`).join(', ')}`);
    const best = active.filter((r) => r.conversations > 0).sort((a, b) => a.costPerConversation - b.costPerConversation)[0];
    if (best) out.push(`La más barata: ${best.name} a ${fmt(best.costPerConversation)} por conversación`);
  }
  return out;
}

async function insights(creds, level, since, until) {
  const L = LEVELS[level];
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  const fields = [...L.fields, ...METRICS].join(',');
  const rows = [];
  let after = '';
  for (let page = 0; page < 5; page++) {
    const body = await graphGet(`act_${creds.accountId}/insights?level=${level}&fields=${fields}&time_range=${range}&limit=200${after}`, creds.token);
    rows.push(...(body.data ?? []));
    const cursor = body.paging?.cursors?.after;
    if (!body.paging?.next || !cursor) break;
    after = `&after=${encodeURIComponent(cursor)}`;
  }
  return rows.map((r) => rowMetrics(r, level));
}

// Estado de entrega (activa / desactivada…) de cada campaña, conjunto o anuncio.
async function statuses(creds, level) {
  const body = await graphGet(`act_${creds.accountId}/${LEVELS[level].edge}?fields=id,effective_status&limit=500`, creds.token);
  return new Map((body.data ?? []).map((x) => [x.id, x.effective_status]));
}

export async function fetchReport({ since, until, level = 'campaign', fmt }) {
  if (!LEVELS[level]) throw Object.assign(new Error('Nivel no válido'), { status: 400 });
  const creds = await getMetaAdsCredentials();
  if (!creds) throw Object.assign(new Error('Meta Ads no está configurado — guarda el ID de cuenta y el token en Configuración'), { status: 409 });
  const prevRange = previousRange(since, until);
  const [current, previous, status, account] = await Promise.all([
    insights(creds, level, since, until), insights(creds, level, prevRange.since, prevRange.until), statuses(creds, level).catch(() => new Map()),
    graphGet(`act_${creds.accountId}?fields=name,currency`, creds.token),
  ]);
  const rows = current.map((r) => ({ ...r, status: status.get(r.id) ?? null })).sort((a, b) => b.spend - a.spend);
  const totals = totalsOf(rows);
  const prevTotals = totalsOf(previous);
  // Como lo muestra el Administrador de anuncios: $47.071 (punto de miles) en pesos; otra moneda lleva su código.
  const dots = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const money = fmt ?? ((n) => (account.currency === 'COP' ? `$${dots(n)}` : `${account.currency} ${dots(n)}`));
  return {
    since, until, level, currency: account.currency, accountName: account.name, days: daysBetween(since, until), previousRange: prevRange,
    rows, totals, previousTotals: prevTotals, observations: observations({ rows, previous, totals, since, until, fmt: money }),
  };
}
