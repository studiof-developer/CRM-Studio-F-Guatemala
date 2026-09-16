// "Costo por mensaje" — Meta moved WhatsApp billing from per-conversation to
// per-message on 2025-07-01; the field that replaced the now-deprecated
// conversation_analytics is pricing_analytics on the WhatsApp Business Account node.
// Confirmed against Studio F's own WABA (2026-09-13): each data_point carries
// {start, end, pricing_category, volume, cost} — SERVICE (a normal reply inside the
// customer-opened 24h window) always costs 0; MARKETING is the category that's
// actually billed, at a flat per-message rate (confirmed 0.074/msg across every row
// seen). No currency field anywhere in the response — Meta's WhatsApp Business
// Platform bills in USD by default (unlike Ads, which reports in the ad account's own
// currency); converted to COP below (2026-09-16 request) so it reads consistently
// alongside "Costo de conversión", which is already COP from the ad account itself.
import { getActiveCredentials } from './whatsapp.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const DISPLAY_CURRENCY = 'COP';
// Only used if the live rate below can't be reached at all (first call after a restart,
// no network) — a rough recent USD/COP level, not meant to stay accurate over time.
const FALLBACK_USD_TO_COP = 4000;
const RATE_TTL_MS = 6 * 60 * 60 * 1000; // a reporting figure doesn't need a live rate every popup open
let cachedRate = null;
let cachedRateAt = 0;

async function getUsdToCopRate() {
  if (cachedRate && Date.now() - cachedRateAt < RATE_TTL_MS) return cachedRate;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const body = await res.json();
    const rate = body?.rates?.[DISPLAY_CURRENCY];
    if (rate) {
      cachedRate = rate;
      cachedRateAt = Date.now();
      return rate;
    }
  } catch {
    // fall through to whatever we've got
  }
  return cachedRate ?? FALLBACK_USD_TO_COP;
}

async function graphGet(path, token) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `WhatsApp API ${res.status}`);
  return body;
}

// Total + per-category message cost over [since, until] (YYYY-MM-DD each, Guatemala
// calendar days). Array-type Graph API params want a JSON-encoded array, not repeated
// key=value pairs (same convention metaAds.js's time_range needs for an object).
export async function fetchMessageCost(since, until) {
  const creds = await getActiveCredentials().catch(() => null);
  if (!creds?.wabaId) return null;
  const start = Math.floor(new Date(`${since}T00:00:00-06:00`).getTime() / 1000);
  const end = Math.floor(new Date(`${until}T23:59:59-06:00`).getTime() / 1000);
  const params = new URLSearchParams({
    start: String(start),
    end: String(end),
    granularity: 'DAILY',
    metric_types: JSON.stringify(['COST', 'VOLUME']),
    dimensions: JSON.stringify(['PRICING_CATEGORY']),
  });
  const body = await graphGet(`${creds.wabaId}/pricing_analytics?${params}`, creds.token);
  const points = body.data?.[0]?.data_points ?? [];

  let totalCost = 0;
  let billableVolume = 0;
  const byCategory = {};
  for (const p of points) {
    const cost = p.cost ?? 0;
    const volume = p.volume ?? 0;
    totalCost += cost;
    if (cost > 0) billableVolume += volume;
    const entry = byCategory[p.pricing_category] ?? { volume: 0, cost: 0 };
    entry.volume += volume;
    entry.cost += cost;
    byCategory[p.pricing_category] = entry;
  }

  const rate = await getUsdToCopRate();
  const totalCostCop = totalCost * rate;
  return {
    currency: DISPLAY_CURRENCY,
    totalCost: totalCostCop,
    billableVolume,
    avgCostPerMessage: billableVolume > 0 ? totalCostCop / billableVolume : null,
    byCategory: Object.entries(byCategory).map(([category, { volume, cost }]) => ({
      category,
      volume,
      cost: cost * rate,
      costPerMessage: cost > 0 && volume > 0 ? (cost * rate) / volume : 0,
    })),
  };
}
