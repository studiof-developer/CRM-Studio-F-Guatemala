// Outbound Messenger + Instagram DM sends — same shape as whatsapp.js on purpose (a
// graphFetch-style retry/timeout wrapper, credentials read via the same tokenCrypto.js
// helpers), just for the second, unrelated Meta App (see settings.js's meta_page_*
// entries) added for the social inbox (2026-09-14).
import { pool } from './db.js';
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
    body: JSON.stringify({
      messaging_type: 'RESPONSE',
      recipient: { id: recipientId },
      message: { text },
    }),
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

// Looks up user profile for Instagram (IGSID) or Facebook Messenger (PSID).
// NOTE: Meta Graph API node types have strictly incompatible fields:
// - Instagram IGSID supports: name, username, profile_pic (never first_name/last_name)
// - Messenger PSID supports: name, first_name, last_name, profile_pic (never username)
// Querying non-existing fields causes Meta to return HTTP 400 (#100 Tried accessing nonexisting field).
export async function fetchProfileName(externalId, provider = null) {
  const creds = await getSocialCredentials();
  if (!creds) return null;

  // 1. Instagram: query name, username, profile_pic
  if (provider === 'instagram') {
    try {
      const result = await graphFetch(`${externalId}?fields=name,username,profile_pic`, { method: 'GET' }, creds.token);
      const username = result?.username ? `@${result.username.replace(/^@/, '')}` : null;
      const name = result?.name?.trim() || null;
      const displayName = (name && username) ? `${name} (${username})` : (username || name || null);
      if (displayName) {
        return { displayName, profilePicUrl: result?.profile_pic ?? null, username: result?.username ?? null };
      }
    } catch (err) {
      console.warn(`fetchProfileName instagram failed for ${externalId}:`, err.message);
      try {
        const result = await graphFetch(`${externalId}?fields=username`, { method: 'GET' }, creds.token);
        if (result?.username) {
          const username = `@${result.username.replace(/^@/, '')}`;
          return { displayName: username, profilePicUrl: null, username: result.username };
        }
      } catch {}
    }
  }

  // 2. Messenger: query name, first_name, last_name, profile_pic
  if (provider === 'messenger' || !provider) {
    try {
      const result = await graphFetch(`${externalId}?fields=name,first_name,last_name,profile_pic`, { method: 'GET' }, creds.token);
      const name = result?.name || [result?.first_name, result?.last_name].filter(Boolean).join(' ') || null;
      if (name) {
        return { displayName: name.trim(), profilePicUrl: result?.profile_pic ?? null, username: null };
      }
    } catch (err) {
      console.warn(`fetchProfileName messenger failed for ${externalId}:`, err.message);
    }
  }

  // 3. Fallback if provider was null/unknown and messenger attempt failed:
  if (!provider) {
    try {
      const result = await graphFetch(`${externalId}?fields=name,username,profile_pic`, { method: 'GET' }, creds.token);
      const username = result?.username ? `@${result.username.replace(/^@/, '')}` : null;
      const name = result?.name?.trim() || null;
      const displayName = (name && username) ? `${name} (${username})` : (username || name || null);
      if (displayName) {
        return { displayName, profilePicUrl: result?.profile_pic ?? null, username: result?.username ?? null };
      }
    } catch {}
  }

  return null;
}

// Confirms the saved Page Access Token is valid, verifies Facebook Page & linked Instagram account,
// auto-corrects meta_ig_business_id if mismatched/missing, and auto-subscribes webhooks.
export async function testSocialConnection() {
  const creds = await getSocialCredentials();
  if (!creds) throw new Error('Redes sociales no está configurado — completa Configuración > Redes sociales');

  const pageResult = await graphFetch(`${creds.pageId}?fields=id,name,instagram_business_account{id,username,name}`, { method: 'GET' }, creds.token);

  let igAccount = null;
  let igAutoUpdated = false;

  if (pageResult?.instagram_business_account) {
    igAccount = pageResult.instagram_business_account;
    if (!creds.igBusinessId || creds.igBusinessId === creds.pageId || creds.igBusinessId !== igAccount.id) {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('meta_ig_business_id', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
        [JSON.stringify(igAccount.id)]
      );
      igAutoUpdated = true;
    }
  }

  let subscribed = false;
  try {
    const subResult = await graphFetch(`${creds.pageId}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks'] }),
    }, creds.token);
    subscribed = subResult?.success === true;
  } catch (err) {
    console.warn('testSocialConnection: subscribed_apps failed:', err.message);
  }

  return {
    name: pageResult.name,
    pageName: pageResult.name,
    pageId: pageResult.id,
    igAccount: igAccount ? {
      id: igAccount.id,
      username: igAccount.username ? `@${igAccount.username}` : null,
      name: igAccount.name || null,
    } : null,
    igAutoUpdated,
    subscribed,
  };
}
