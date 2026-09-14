// Outbound Messenger + Instagram DM sends — same shape as whatsapp.js on purpose (a
// graphFetch-style retry/timeout wrapper, credentials read via the same tokenCrypto.js
// helpers), just for the second, unrelated Meta App (see settings.js's meta_page_*
// entries) added for the social inbox (2026-09-14).
import { getSetting } from './routes/settings.js';
import { decryptToken } from './tokenCrypto.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 800;
const REQUEST_TIMEOUT_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getSocialCredentials() {
  const pageId = await getSetting('meta_page_id', null);
  const igBusinessId = await getSetting('meta_ig_business_id', null);
  const encToken = await getSetting('meta_page_access_token', null);
  if (!pageId || !encToken) return null;
  return { pageId, igBusinessId, token: decryptToken(encToken) };
}

async function graphFetch(path, options, token) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${GRAPH_BASE}/${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...options.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.text();
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`Meta API ${res.status}: ${body}`);
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
}

// Same Send API shape for both — the only difference is which platform's inbox the
// psid/igsid came from (Meta routes it correctly as long as the token has access to
// both, which a single Page token does — the Instagram professional account messages
// through its linked Page).
async function sendViaMessagesApi(recipientId, text, token) {
  return graphFetch('me/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  }, token);
}

export async function sendMessengerText(psid, text) {
  const creds = await getSocialCredentials();
  if (!creds) throw new Error('Redes sociales no está configurado — completa Configuración > Redes sociales');
  return sendViaMessagesApi(psid, text, creds.token);
}

export async function sendInstagramText(igsid, text) {
  const creds = await getSocialCredentials();
  if (!creds) throw new Error('Redes sociales no está configurado — completa Configuración > Redes sociales');
  return sendViaMessagesApi(igsid, text, creds.token);
}

// Meta doesn't push a contact's display name along with their first message — this
// looks it up once, right after a brand-new social_contacts row is created (see
// socialWebhook.js), so the CRM shows a real name instead of the raw "social:<id>"
// fallback. Best-effort: Graph API's available fields differ between a Messenger PSID
// and an Instagram IGSID, and neither is guaranteed while the App is still in
// Development mode — any failure here should never break webhook ingestion.
export async function fetchProfileName(externalId) {
  const creds = await getSocialCredentials();
  if (!creds) return null;
  try {
    const result = await graphFetch(`${externalId}?fields=name,username,first_name,last_name`, { method: 'GET' }, creds.token);
    return result?.name || result?.username || [result?.first_name, result?.last_name].filter(Boolean).join(' ') || null;
  } catch {
    return null;
  }
}

// Confirms the saved Page Access Token is actually valid and readable — same idea as
// metaAds.js's testMetaAdsConnection, just against the Page's own /me instead of an ad account.
export async function testSocialConnection() {
  const creds = await getSocialCredentials();
  if (!creds) throw new Error('Redes sociales no está configurado — completa Configuración > Redes sociales');
  const result = await graphFetch('me?fields=id,name', { method: 'GET' }, creds.token);
  return { name: result.name, id: result.id };
}
