// Thin wrapper over Meta's Marketing API — read-only (ads_read), used only for
// "costo de conversión": ad spend for a period ÷ customers who reached "Pagado" in
// that same period (the conversion count comes from our own data, not Meta's).
import { getSetting } from './routes/settings.js';
import { decryptToken } from './tokenCrypto.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

// Reads the encrypted credentials Configuración > Meta Ads stores (settings.js's
// `secret: true` handling) — null when either half is missing, so callers can tell
// "not configured yet" apart from "the API call itself failed".
export async function getMetaAdsCredentials() {
  const accountId = await getSetting('meta_ads_account_id', null);
  const encToken = await getSetting('meta_ads_access_token', null);
  if (!accountId || !encToken) return null;
  return { accountId: accountId.replace(/^act_/, ''), token: decryptToken(encToken) };
}

async function graphGet(path, token) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  // Meta's own error shape ({error: {message, code, ...}}) is far more useful here than
  // a bare status code — this is what actually shows up in the "Probar conexión" button
  // when the token lacks ads_read, or points at an account the token can't see.
  if (!res.ok) throw new Error(body?.error?.message ?? `Meta Ads API ${res.status}`);
  return body;
}

// Used by Configuración's "Probar conexión" button — confirms the stored account
// id/token pair actually resolves to a real, readable ad account before anything tries
// to build a metric on top of it.
export async function testMetaAdsConnection() {
  const creds = await getMetaAdsCredentials();
  if (!creds) throw new Error('Meta Ads no está configurado — guarda el ID de cuenta y el token primero');
  const account = await graphGet(`act_${creds.accountId}?fields=name,currency,account_status`, creds.token);
  return { name: account.name, currency: account.currency, accountStatus: account.account_status };
}

// Total spend (in the ad account's own currency) over [since, until] — YYYY-MM-DD each.
export async function fetchAdSpend(since, until) {
  const creds = await getMetaAdsCredentials();
  if (!creds) return null;
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const body = await graphGet(`act_${creds.accountId}/insights?fields=spend&time_range=${timeRange}`, creds.token);
  const row = body.data?.[0];
  return row ? Number(row.spend) : 0;
}
