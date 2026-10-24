import { getMetaAdsCredentials, graphGet } from './metaAds.js';
import { getSetting } from './routes/settings.js';

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
// Umbrales con los que el traficker califica la pauta (en la moneda de la cuenta); se pueden cambiar en app_settings.meta_ads_thresholds.
export const DEFAULT_THRESHOLDS = { cprGood: 1200, cprRegular: 2500, convGood: 25, convRegular: 20 };
const CACHE_MS = 60 * 1000; // varias personas mirando el informe no multiplican las llamadas a Meta
const cache = new Map();
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

export const validRange = (since, until) => /^\d{4}-\d{2}-\d{2}$/.test(since ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(until ?? '') && since <= until;

// Datos de toda la cuenta en el período: el alcance y la frecuencia únicos, y (con daily) un renglón por día para la gráfica.
async function accountInsights(creds, since, until, daily) {
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  const fields = ['date_start', ...METRICS].join(',');
  const body = await graphGet(`act_${creds.accountId}/insights?level=account&fields=${fields}&time_range=${range}${daily ? '&time_increment=1' : ''}&limit=100`, creds.token);
  return (body.data ?? []).map((r) => ({ ...rowMetrics({ ...r, campaign_id: 'account', campaign_name: 'Cuenta' }, 'campaign'), date: r.date_start }));
}

// Un renglón por cada día del período (con ceros donde Meta no devuelve nada), para que la gráfica no se salte días sin gasto.
export function fillDaily(rows, since, until) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  for (let d = since; d <= until; d = new Date(+new Date(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    const r = byDate.get(d);
    const spend = r?.spend ?? 0; const conversations = r?.conversations ?? 0; const linkClicks = r?.linkClicks ?? 0; const impressions = r?.impressions ?? 0;
    out.push({ date: d, spend, conversations, costPerConversation: r?.costPerConversation ?? null, linkClicks, impressions, conversionPct: linkClicks > 0 ? (conversations / linkClicks) * 100 : null, cpc: div(spend, linkClicks), ctr: impressions > 0 ? (linkClicks / impressions) * 100 : null });
  }
  return out;
}

const daysBetween =(since, until) => Math.round((+new Date(`${until}T12:00:00Z`) - +new Date(`${since}T12:00:00Z`)) / 86400000) + 1;
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

// daily = un renglón por cada día y cada campaña/conjunto/anuncio (para el detalle por día).
async function insights(creds, level, since, until, daily = false) {
  const L = LEVELS[level];
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  const fields = [...(daily ? ['date_start'] : []), ...L.fields, ...METRICS].join(',');
  const rows = [];
  let after = '';
  for (let page = 0; page < (daily ? 12 : 5); page++) {
    const body = await graphGet(`act_${creds.accountId}/insights?level=${level}&fields=${fields}&time_range=${range}${daily ? '&time_increment=1' : ''}&limit=200${after}`, creds.token);
    rows.push(...(body.data ?? []));
    const cursor = body.paging?.cursors?.after;
    if (!body.paging?.next || !cursor) break;
    after = `&after=${encodeURIComponent(cursor)}`;
  }
  return rows.map((r) => (daily ? { ...rowMetrics(r, level), date: r.date_start } : rowMetrics(r, level)));
}

// Estado de entrega (activa / desactivada…) de cada campaña, conjunto o anuncio.
async function statuses(creds, level) {
  const body = await graphGet(`act_${creds.accountId}/${LEVELS[level].edge}?fields=id,effective_status&limit=500`, creds.token);
  return new Map((body.data ?? []).map((x) => [x.id, x.effective_status]));
}

export async function fetchReport({ since, until, level = 'campaign', fmt }) {
  if (!LEVELS[level]) throw Object.assign(new Error('Nivel no válido'), { status: 400 });
  const key = `${since}|${until}|${level}`;
  const hit = cache.get(key);
  if (!fmt && hit && Date.now() - hit.at < CACHE_MS) return hit.report;
  const report = await buildReport({ since, until, level, fmt });
  if (!fmt) cache.set(key, { at: Date.now(), report });
  return report;
}

async function buildReport({ since, until, level, fmt }) {
  const creds = await getMetaAdsCredentials();
  if (!creds) throw Object.assign(new Error('Meta Ads no está configurado — guarda el ID de cuenta y el token en Configuración'), { status: 409 });
  const prevRange = previousRange(since, until);
  const multiDay = daysBetween(since, until) > 1;
  const [current, previous, status, account, accNow, accPrev, accDaily, dayRowsRaw, savedThresholds] = await Promise.all([
    insights(creds, level, since, until), insights(creds, level, prevRange.since, prevRange.until), statuses(creds, level).catch(() => new Map()),
    graphGet(`act_${creds.accountId}?fields=name,currency`, creds.token),
    accountInsights(creds, since, until, false).catch(() => []), accountInsights(creds, prevRange.since, prevRange.until, false).catch(() => []),
    multiDay ? accountInsights(creds, since, until, true).catch(() => []) : Promise.resolve([]),
    multiDay ? insights(creds, level, since, until, true).catch(() => []) : Promise.resolve([]),
    getSetting('meta_ads_thresholds', {}).catch(() => ({})),
  ]);
  const rows = current.map((r) => ({ ...r, status: status.get(r.id) ?? null })).sort((a, b) => b.spend - a.spend);
  const withAccount = (t, acc) => ({ ...t, reach: acc?.reach ?? null, frequency: acc?.frequency ?? null });
  const totals = withAccount(totalsOf(rows), accNow[0]);
  const prevTotals = withAccount(totalsOf(previous), accPrev[0]);
  // Como lo muestra el Administrador de anuncios: $47.071 (punto de miles) en pesos; otra moneda lleva su código.
  const dots = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const money = fmt ?? ((n) => (account.currency === 'COP' ? `$${dots(n)}` : `${account.currency} ${dots(n)}`));
  return {
    since, until, level, currency: account.currency, accountName: account.name, days: daysBetween(since, until), previousRange: prevRange,
    fetchedAt: new Date().toISOString(), thresholds: { ...DEFAULT_THRESHOLDS, ...(savedThresholds ?? {}) },
    dayRows: dayRowsRaw.filter((r) => r.spend > 0 || r.conversations > 0).map((r) => ({ ...r, status: status.get(r.id) ?? null })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.spend - a.spend)),
    rows, totals, previousTotals: prevTotals, daily: multiDay ? fillDaily(accDaily, since, until) : [], observations: observations({ rows, previous, totals, since, until, fmt: money }),
  };
}

// Imagen (y video, si lo hay) de un anuncio, leída en vivo de Meta: las URLs de Meta caducan, por eso no se guardan; solo se
// recuerdan 30 min para no repetir la llamada cada vez que alguien abre el informe.
const CREATIVE_MS = 30 * 60 * 1000;
const creativeCache = new Map();

export async function fetchAdCreative(adId) {
  if (!/^\d+$/.test(adId ?? '')) throw Object.assign(new Error('Anuncio no válido'), { status: 400 });
  const hit = creativeCache.get(adId);
  if (hit && Date.now() - hit.at < CREATIVE_MS) return hit.creative;
  const creds = await getMetaAdsCredentials();
  if (!creds) throw Object.assign(new Error('Meta Ads no está configurado — guarda el ID de cuenta y el token en Configuración'), { status: 409 });
  const ad = await graphGet(`${adId}?fields=creative{thumbnail_url,image_url,object_story_spec{video_data{video_id,image_url},link_data{picture},photo_data{url}}}`, creds.token);
  const c = ad.creative ?? {};
  const spec = c.object_story_spec ?? {};
  const videoId = spec.video_data?.video_id;
  // El MP4 exige un permiso extra: si falta, se muestra solo la imagen.
  const videoUrl = videoId ? (await graphGet(`${videoId}?fields=source`, creds.token).catch(() => null))?.source ?? null : null;
  const creative = {
    thumbnailUrl: c.thumbnail_url ?? null,
    imageUrl: c.image_url ?? spec.video_data?.image_url ?? spec.link_data?.picture ?? spec.photo_data?.url ?? null,
    videoUrl,
  };
  creativeCache.set(adId, { at: Date.now(), creative });
  return creative;
}
