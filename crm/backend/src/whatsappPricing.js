// "Costo por mensaje" (2026-09-13, still in discovery) — Meta moved WhatsApp billing
// from per-conversation to per-message on 2025-07-01; the field that replaced the now-
// deprecated conversation_analytics is pricing_analytics on the WhatsApp Business
// Account node. Its outer request shape is documented (start/end as unix timestamps,
// granularity, metric_types, dimensions, pricing_categories — see
// developers.facebook.com/docs/graph-api/reference/whats-app-business-account/pricing_analytics),
// but the actual per-row field names in the response aren't spelled out anywhere public,
// so this starts as a raw pass-through against the real account instead of code written
// blind against a guessed shape — see testPricingAnalytics's route in settings.js.
import { getActiveCredentials } from './whatsapp.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

// Same reasoning as metaAds.js's graphGet — Meta's own {error:{message}} beats a bare
// status code for figuring out what a real WABA/token is missing.
async function graphGet(path, token) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `WhatsApp API ${res.status}`);
  return body;
}

// Raw response, deliberately unparsed — read via Configuración's discovery test until
// the real field names are confirmed against Studio F's own WABA, then this becomes the
// basis for a real fetchMessageCost()-style function next to metaAds.js's fetchAdSpend.
export async function testPricingAnalytics(days = 7) {
  const creds = await getActiveCredentials();
  if (!creds.wabaId) throw new Error('Falta el waba_id del número activo — revisa Configuración > Números de WhatsApp');
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  // Array-type Graph API params want a JSON-encoded array, not repeated key=value pairs
  // (metaAds.js's time_range needed the same JSON-string treatment for an object) — the
  // first attempt at this used repeated params and got volume back with no cost field
  // at all, which is what asking for an array parameter the wrong way looks like here.
  const params = new URLSearchParams({
    start: String(start),
    end: String(end),
    granularity: 'DAILY',
    metric_types: JSON.stringify(['COST', 'VOLUME']),
    dimensions: JSON.stringify(['PRICING_CATEGORY']),
  });
  return graphGet(`${creds.wabaId}/pricing_analytics?${params}`, creds.token);
}
