// Outbound Messenger + Instagram DM sends — same shape as whatsapp.js on purpose (a
// graphFetch-style retry/timeout wrapper, credentials read via the same tokenCrypto.js
// helpers), just for the second, unrelated Meta App (see settings.js's meta_page_*
// entries) added for the social inbox (2026-09-14).
import { pool } from './db.js';
import { getSetting } from './routes/settings.js';
import { decryptToken } from './tokenCrypto.js';
import { saveAttachment } from './attachmentStorage.js';
import { broadcast } from './events.js';

// v20.0 venció el 24-sep-2026 (Meta reenvía esas llamadas a una versión vieja) y Instagram solo acepta PDF por la API desde dic-2025:
// con la versión vieja el cliente recibe el PDF como un enlace que no abre. v25.0 es estable y no trae los cambios de v26.
const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
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
      body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'messaging_referrals', 'message_reactions', 'message_echoes'] }),
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

    // 3. Check story
    const story = data?.story;
    if (!imageUrl && (story?.url || story?.mention?.link)) {
      imageUrl = story.url || story.mention?.link || null;
      title = story.title || 'Historia';
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

// Queries Meta Graph API for historical messages of a conversation (e.g. sent from Meta Business Suite)
export async function syncConversationFromGraph(contactId) {
  const creds = await getSocialCredentials();
  if (!creds?.token) throw new Error('Credenciales de Meta no configuradas');

  const { rows: contactRows } = await pool.query(
    `SELECT id, provider, external_id, customer_id FROM social_contacts WHERE id = $1`,
    [contactId]
  );
  if (!contactRows.length) throw new Error('Contacto no encontrado');
  const contact = contactRows[0];
  const { provider, external_id: externalId, customer_id: customerId } = contact;

  const targetId = (provider === 'instagram' && creds.igBusinessId) ? creds.igBusinessId : creds.pageId;
  if (!targetId) throw new Error('ID de página o cuenta de Instagram no disponible');

  let convData = null;
  try {
    convData = await graphFetch(
      `${targetId}/conversations?user_id=${externalId}&fields=id,messages.limit(50){id,message,created_time,from,to,attachments{id,mime_type,name,size,image_data,video_data,file_url}}`,
      { method: 'GET' },
      creds.token
    );
  } catch (err) {
    console.warn(`[syncConversationFromGraph] user_id lookup failed for ${externalId}:`, err.message);
  }

  if (!convData?.data?.length) {
    try {
      const listData = await graphFetch(
        `${targetId}/conversations?fields=id,participants,messages.limit(50){id,message,created_time,from,to,attachments{id,mime_type,name,size,image_data,video_data,file_url}}&limit=25`,
        { method: 'GET' },
        creds.token
      );
      const matched = listData?.data?.find((c) => c.participants?.data?.some((p) => p.id === externalId));
      if (matched) convData = { data: [matched] };
    } catch (listErr) {
      console.warn(`[syncConversationFromGraph] fallback list failed:`, listErr.message);
    }
  }

  const messages = convData?.data?.[0]?.messages?.data || [];
  if (!messages.length) return { syncedCount: 0 };

  messages.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));

  let inserted = 0;
  for (const m of messages) {
    const { rows: exists } = await pool.query(
      `SELECT id FROM social_messages WHERE external_message_id = $1 OR (contact_id = $2 AND body = $3 AND created_at = $4::timestamptz)`,
      [m.id, contact.id, m.message || '', m.created_time]
    );
    if (exists.length) continue;

    const direction = m.from?.id === externalId ? 'in' : 'out';
    const body = m.message || (m.attachments?.data?.length ? '[Archivo]' : '');

    const { rows: insRows } = await pool.query(
      `INSERT INTO social_messages (contact_id, direction, body, raw_payload, external_message_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz) RETURNING id`,
      [contact.id, direction, body, JSON.stringify(m), m.id, m.created_time]
    );
    const newMsgId = insRows[0]?.id;
    inserted++;

    const atts = m.attachments?.data || [];
    for (const att of atts) {
      const attUrl = att.image_data?.url || att.video_data?.url || att.file_url;
      if (attUrl && newMsgId) {
        try {
          const dlRes = await fetch(attUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Authorization': `Bearer ${creds.token}`,
            },
            signal: AbortSignal.timeout(15000),
          });
          if (dlRes.ok) {
            const buf = Buffer.from(await dlRes.arrayBuffer());
            const mime = dlRes.headers.get('content-type') || att.mime_type || 'image/jpeg';
            const kind = mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : 'image');
            const savedId = await saveAttachment({
              n8nMessageId: null,
              kind,
              filename: att.name || (kind === 'image' ? 'imagen.jpg' : 'archivo'),
              mimeType: mime,
              buffer: buf,
            });
            await pool.query(
              `UPDATE message_attachments SET social_message_id = $1 WHERE id = $2`,
              [newMsgId, savedId]
            );
          }
        } catch (attErr) {
          console.warn('[sync] failed to download attachment:', attErr.message);
        }
      }
    }
  }

  if (inserted > 0) {
    const latest = messages[messages.length - 1];
    const latestDirection = latest.from?.id === externalId ? 'in' : 'out';
    const latestText = latest.message || '[Archivo]';

    await pool.query(
      `UPDATE social_contacts SET last_message_at = GREATEST(last_message_at, $2::timestamptz),
                                  unread_count = CASE WHEN $3 = 'out' THEN 0 ELSE social_contacts.unread_count END
       WHERE id = $1`,
      [contact.id, latest.created_time, latestDirection]
    );

    if (customerId) {
      await pool.query(
        `UPDATE customers SET last_message_at = GREATEST(last_message_at, $2::timestamptz),
                             last_message = $3,
                             awaiting_reply = CASE WHEN $4 = 'out' THEN false ELSE true END,
                             has_unread = CASE WHEN $4 = 'out' THEN false ELSE has_unread END
         WHERE id = $1`,
        [customerId, latest.created_time, latestText, latestDirection]
      );
      if (latestDirection === 'out') {
        await pool.query(
          `UPDATE tickets SET status = 'en_atencion', awaiting_reply = false, last_message = $2, last_message_at = $3::timestamptz, updated_at = now()
           WHERE customer_id = $1 AND status != 'resuelto'`,
          [customerId, latestText, latest.created_time]
        );
      }
    }

    broadcast('social_message_changes', JSON.stringify({
      contactId: contact.id,
      provider: contact.provider,
    }));
    broadcast('message_changes', JSON.stringify({
      session_id: `social:${contact.id}`,
      phone: `social:${contact.id}`,
    }));
  }

  return { syncedCount: inserted };
}

