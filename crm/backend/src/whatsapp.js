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
// Optional — only listTemplates() (the campaign/broadcast picker) needs it. Sending a
// message never has, so this stayed unset with everything else working fine until the
// broadcast feature needed to ask Meta "which templates does this account have".
const ENV_WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

// Throws rather than returning null: every caller runs in a fire-and-forget background
// promise whose only failure signal is a rejection. Returning null there meant "no
// WhatsApp configured" resolved successfully, the caller saw no wamid and quietly gave
// up, and the advisor kept looking at a normal checkmark for a message that was never
// sent to anyone. A missing config is a send failure and has to be loud.
async function getActiveCredentials() {
  const { rows } = await pool.query(
    `SELECT waba_id, phone_number_id, access_token_enc FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1`
  );
  if (rows.length) {
    return { wabaId: rows[0].waba_id, phoneNumberId: rows[0].phone_number_id, token: decryptToken(rows[0].access_token_enc) };
  }
  if (ENV_TOKEN && ENV_PHONE_NUMBER_ID) {
    return { wabaId: ENV_WABA_ID ?? null, phoneNumberId: ENV_PHONE_NUMBER_ID, token: ENV_TOKEN };
  }
  throw new Error('WhatsApp no está configurado (no hay número activo en Configuración ni credenciales en el entorno)');
}

// A 4xx business error (bad template, invalid number, missing permission) fails again
// identically on retry — not worth the wait. Only Meta's own infra hiccups (5xx) or a
// short-lived throttle (429) are.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 800;
// Native fetch has no default timeout — a connection that stalls instead of erroring
// (common enough against Meta's API) used to hang this forever: no wamid, no error, the
// message just sat there until the orphan-recovery sweep caught it minutes later and
// resent it, which is how the same message could reach a customer twice. Media uploads
// get a longer allowance — a real, slow-but-working transfer of a large document
// shouldn't be mistaken for a stall the same way a tiny JSON send would be.
const REQUEST_TIMEOUT_MS = 20000;
const UPLOAD_TIMEOUT_MS = 90000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphFetch(path, options, token, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${GRAPH_BASE}/${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...options.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset, timeout) — no response at all,
      // same "might just be transient" logic applies as a 5xx.
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.text();
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`WhatsApp API ${res.status}: ${body}`);
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
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
// headerMediaId is required when the template's own header component is media — Meta
// rejects the send with "(#132012) ... expected IMAGE, received UNKNOWN" if a header the
// template defines is left out, not just if it's malformed. A DOCUMENT header additionally
// requires a filename in the parameter itself (image headers don't take one).
export async function sendTemplate(toPhone, templateName, languageCode, bodyParams = [], headerMediaId, headerFormat = 'IMAGE', headerFilename) {
  const creds = await getActiveCredentials();
  const headerMediaParam = headerFormat === 'DOCUMENT'
    ? { type: 'document', document: { id: headerMediaId, filename: headerFilename || 'documento.pdf' } }
    : { type: 'image', image: { id: headerMediaId } };
  const components = [
    ...(headerMediaId ? [{ type: 'header', parameters: [headerMediaParam] }] : []),
    ...(bodyParams.length ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }] : []),
  ];
  return graphFetch(`${creds.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components: components.length ? components : undefined },
    }),
  }, creds.token);
}

// Live from Meta rather than mirrored in our own DB — a template's approval status
// changes on Meta's side (review, reclassification, pause) and a stale local copy is
// exactly how a campaign could try to send with a template that no longer works.
export async function listTemplates() {
  const creds = await getActiveCredentials();
  if (!creds.wabaId) {
    throw new Error('Falta el ID de la cuenta de WhatsApp Business (waba_id) — configúralo en Configuración.');
  }
  const { data } = await graphFetch(
    `${creds.wabaId}/message_templates?fields=name,status,category,language,components&limit=100`,
    { method: 'GET' },
    creds.token
  );
  return data ?? [];
}

export async function uploadMedia(buffer, mimeType) {
  const creds = await getActiveCredentials();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }));
  form.append('type', mimeType);
  const { id } = await graphFetch(`${creds.phoneNumberId}/media`, { method: 'POST', body: form }, creds.token, UPLOAD_TIMEOUT_MS);
  return id;
}

export async function sendMedia(toPhone, kind, mediaId, filename, caption) {
  const creds = await getActiveCredentials();
  const payload ={ messaging_product: 'whatsapp', to: toPhone, type: kind, [kind]: { id: mediaId } };
  if (kind === 'document' && filename) payload.document.filename = filename;
  // WhatsApp doesn't support captions on audio — silently ignored there is fine.
  if (caption && kind !== 'audio') payload[kind].caption = caption;
  return graphFetch(`${creds.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, creds.token);
}
