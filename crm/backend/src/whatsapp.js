// Thin wrapper over Meta's WhatsApp Cloud API for outbound sends. The bot's own
// replies go through n8n directly — this is only for messages the CRM itself
// originates (an advisor typing/attaching something in Conversations).
import { pool } from './db.js';
import { decryptToken } from './tokenCrypto.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

// Legacy env vars — kept as a fallback only, so an existing deployment keeps
// sending real messages right up until an admin adds a number in Configuración.
// Once whatsapp_numbers has an active row, that row always wins.
const ENV_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const ENV_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

async function getActiveCredentials() {
  const { rows } = await pool.query(
    `SELECT phone_number_id, access_token_enc FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1`
  );
  if (rows.length) {
    return { phoneNumberId: rows[0].phone_number_id, token: decryptToken(rows[0].access_token_enc) };
  }
  if (ENV_TOKEN && ENV_PHONE_NUMBER_ID) {
    return { phoneNumberId: ENV_PHONE_NUMBER_ID, token: ENV_TOKEN };
  }
  return null;
}

async function graphFetch(path, options, token) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${body}`);
  }
  return res.json();
}

// Used by the Configuración "probar conexión" flow to validate a number/token
// pair before it's ever saved — separate from the active-credentials path above
// since the number being tested usually isn't the active one yet.
export async function verifyNumber(phoneNumberId, token) {
  return graphFetch(`${phoneNumberId}?fields=display_phone_number,verified_name`, { method: 'GET' }, token);
}

// contextMessageId, when given the wamid of an earlier message, makes WhatsApp show
// this as a native quoted reply on the customer's side — not just inside the CRM.
export async function sendText(toPhone, body, contextMessageId) {
  const creds = await getActiveCredentials();
  if (!creds) {
    console.warn('WhatsApp not configured (no active number in Configuración, no env fallback) — skipping real send');
    return null;
  }
  return graphFetch(`${creds.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body },
      ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    }),
  }, creds.token);
}

// First-contact messages (customer never wrote in, or >24h since their last message)
// must use a pre-approved Meta template — free text gets rejected outright.
export async function sendTemplate(toPhone, templateName, languageCode, bodyParams = []) {
  const creds = await getActiveCredentials();
  if (!creds) {
    console.warn('WhatsApp not configured (no active number in Configuración, no env fallback) — skipping real send');
    return null;
  }
  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
    : undefined;
  return graphFetch(`${creds.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components },
    }),
  }, creds.token);
}

export async function uploadMedia(buffer, mimeType) {
  const creds = await getActiveCredentials();
  if (!creds) {
    console.warn('WhatsApp not configured (no active number in Configuración, no env fallback) — skipping real upload');
    return null;
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }));
  form.append('type', mimeType);
  const { id } = await graphFetch(`${creds.phoneNumberId}/media`, { method: 'POST', body: form }, creds.token);
  return id;
}

export async function sendMedia(toPhone, kind, mediaId, filename, caption) {
  const creds = await getActiveCredentials();
  if (!creds) {
    console.warn('WhatsApp not configured (no active number in Configuración, no env fallback) — skipping real send');
    return null;
  }
  const payload = { messaging_product: 'whatsapp', to: toPhone, type: kind, [kind]: { id: mediaId } };
  if (kind === 'document' && filename) payload.document.filename = filename;
  // WhatsApp doesn't support captions on audio — silently ignored there is fine.
  if (caption && kind !== 'audio') payload[kind].caption = caption;
  return graphFetch(`${creds.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, creds.token);
}
