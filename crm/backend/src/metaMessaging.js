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
async function sendViaMessagesApi(recipientId, text, token, pageId = null) {
  const endpoint = pageId ? `${pageId}/messages` : 'me/messages';
  return graphFetch(endpoint, {
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
  return sendViaMessagesApi(psid, text, creds.token, creds.pageId);
}

export async function sendInstagramText(igsid, text) {
  const creds = await getSocialCredentials();
  if (!creds) throw new Error('Redes sociales no está configurado — completa Configuración > Redes sociales');
  return sendViaMessagesApi(igsid, text, creds.token, creds.pageId);
}

export async function sendSocialAttachment({ recipientId, fileBuffer, filename, mimeType }) {
  const creds = await getSocialCredentials();
  if (!creds) throw new Error('Redes sociales no está configurado — completa Configuración > Redes sociales');

  const form = new FormData();
  form.append('recipient', JSON.stringify({ id: recipientId }));
  const type = mimeType.startsWith('image/') ? 'image' : (mimeType.startsWith('audio/') ? 'audio' : 'file');
  form.append('message', JSON.stringify({
    attachment: {
      type,
      payload: { is_reusable: true }
    }
  }));
  const blob = new Blob([fileBuffer], { type: mimeType });
  form.append('filedata', blob, filename || 'archivo');

  const endpoint = creds.pageId ? `${creds.pageId}/messages` : 'me/messages';
  return graphFetch(endpoint, {
    method: 'POST',
    body: form,
  }, creds.token);
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
      body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'messaging_referrals', 'message_reactions'] }),
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

// Queries Meta Graph API for attachments, shares or story associated with a message
export async function fetchMessageMediaFromGraph(messageId) {
  if (!messageId) return null;
  const creds = await getSocialCredentials();
  if (!creds?.token) return null;
  try {
    const data = await graphFetch(`${messageId}?fields=id,message,attachments,shares,story`, { method: 'GET' }, creds.token);
    let imageUrl = null;
    let title = null;
    let link = null;

    // 1. Check attachments
    const att = data?.attachments?.data?.[0];
    if (att?.image_data?.url) {
      imageUrl = att.image_data.url;
      title = att.name || null;
    }

    // 2. Check shares (Facebook post / photo / catalog item)
    const share = data?.shares?.data?.[0];
    if (!imageUrl && (share?.picture || share?.link)) {
      imageUrl = share.picture || null;
      title = share.name || share.description || null;
      link = share.link || null;
    }

    return { imageUrl, title, link, raw: data };
  } catch (err) {
    console.warn(`[metaMessaging] fetchMessageMediaFromGraph failed for ${messageId}:`, err.message);
    return null;
  }
}

// Queries Meta Graph API for the ad creative image if referral ad_id was provided
export async function fetchAdCreative(adId) {
  if (!adId) return null;
  const creds = await getSocialCredentials();
  if (!creds?.token) return null;
  try {
    const data = await graphFetch(`${adId}?fields=id,name,creative{id,name,title,body,image_url,thumbnail_url}`, { method: 'GET' }, creds.token);
    const cr = data?.creative;
    const imageUrl = cr?.image_url || cr?.thumbnail_url || null;
    const title = cr?.title || cr?.name || data?.name || null;
    const body = cr?.body || null;
    return { imageUrl, title, body };
  } catch (err) {
    console.warn(`[metaMessaging] fetchAdCreative failed for ${adId}:`, err.message);
    return null;
  }
}

