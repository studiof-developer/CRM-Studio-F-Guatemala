// Thin wrapper over Meta's WhatsApp Cloud API for outbound sends. The bot's own
// replies go through n8n directly — this is only for messages the CRM itself
// originates (an advisor typing/attaching something in Conversations).
import { pool } from './db.js';
import { decryptToken } from './tokenCrypto.js';
import { broadcast } from './events.js';

const GRAPH_BASE = process.env.GRAPH_BASE_URL || 'https://graph.facebook.com/v20.0';

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
// Exported for whatsappPricing.js — "costo por mensaje" reads the same active
// number/token this file already sends messages with, rather than asking for a
// second, separate WhatsApp credential the admin would have to keep in sync.
export async function getActiveCredentials(toPhone, lineId) {
  let wId = lineId ? Number(lineId) : undefined;
  if (!wId && toPhone) {
    const { rows: tRows } = await pool.query(
      `SELECT t.whatsapp_number_id 
       FROM tickets t 
       JOIN customers c ON c.id = t.customer_id 
       WHERE c.whatsapp_number = $1 
       ORDER BY t.created_at DESC LIMIT 1`, [toPhone]
    );
    if (tRows.length && tRows[0].whatsapp_number_id) {
      wId = tRows[0].whatsapp_number_id;
    }
  }

  let query = `SELECT id, waba_id, phone_number_id, access_token_enc FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1`;
  let params = [];
  if (wId) {
    query = `SELECT id, waba_id, phone_number_id, access_token_enc FROM whatsapp_numbers WHERE id = $1`;
    params = [wId];
  }

  const { rows } = await pool.query(query, params);
  if (rows.length && rows[0].access_token_enc) {
    try {
      const token = decryptToken(rows[0].access_token_enc);
      return { id: rows[0].id, wabaId: rows[0].waba_id, phoneNumberId: rows[0].phone_number_id, token };
    } catch (err) {
      console.error(`Failed to decrypt token for line ${rows[0].id}:`, err);
      if (wId) {
        throw new Error(`No se pudo descifrar el token de acceso para la línea seleccionada (ID: ${rows[0].id})`);
      }
    }
  }
  if (wId) {
    throw new Error(`La línea seleccionada (ID: ${wId}) no existe o no tiene token configurado en Configuración.`);
  }
  if (ENV_TOKEN && ENV_PHONE_NUMBER_ID) {
    return { id: null, wabaId: ENV_WABA_ID ?? null, phoneNumberId: ENV_PHONE_NUMBER_ID, token: ENV_TOKEN };
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

// Meta responde 131042 cuando la cuenta de WhatsApp Business no puede enviar por un problema de pago: se anota (para la alerta
// de facturación) y se avisa en vivo a las pantallas abiertas.
function noteIfPaymentBlocked(body, path) {
  if (!/"code"\s*:\s*131042/.test(body)) return;
  // El primer tramo de la ruta es el número (envíos) o la cuenta de WhatsApp Business: de ahí sale la línea afectada.
  pool.query('SELECT id FROM whatsapp_numbers WHERE phone_number_id = $1 OR waba_id = $1 LIMIT 1', [String(path).split(/[/?]/)[0]])
    .then(({ rows }) => rows[0] && pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('meta_billing_blocked_at', jsonb_build_object($1::text, now()::text), now())
      ON CONFLICT (key) DO UPDATE SET value = (CASE WHEN jsonb_typeof(app_settings.value) = 'object' THEN app_settings.value ELSE '{}'::jsonb END) || jsonb_build_object($1::text, now()::text), updated_at = now()`, [String(rows[0].id)]))
    .then((r) => r && broadcast('billing_alert', '{}'))
    .catch((err) => console.error('could not record payment block', err.message));
}

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
    noteIfPaymentBlocked(body, path);
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`WhatsApp API ${res.status}: ${body}`);
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
}

// Used by the Configuración "probar conexión" flow to validate a number/token
// pair before it's ever saved — separate from the active-credentials path above
// since the number being tested usually isn't the active one yet.
export async function verifyNumber(phoneNumberId, token, wabaId) {
  const info = await graphFetch(`${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`, { method: 'GET' }, token);
  if (wabaId && wabaId !== 'default') {
    try {
      await graphFetch(`${wabaId}?fields=id,name`, { method: 'GET' }, token);
    } catch (err) {
      throw new Error(`El token no tiene permisos sobre la cuenta de WhatsApp Business (WABA ID: ${wabaId}). En Meta Business Suite, debes asignar este activo al usuario del sistema con permisos de administración/mensajería: ${err.message}`);
    }
  }
  return info;
}

// contextMessageId, when given the wamid of an earlier message, makes WhatsApp show
// this as a native quoted reply on the customer's side — not just inside the CRM.
export async function sendText(toPhone, body, contextMessageId, lineId) {
  const creds = await getActiveCredentials(toPhone, lineId);
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
export async function sendTemplate(toPhone, templateName, languageCode, bodyParams = [], headerMediaId, headerFormat = 'IMAGE', headerFilename, lineId) {
  const creds = await getActiveCredentials(toPhone, lineId);
  const headerMediaParam = headerFormat === 'DOCUMENT'
    ? { type: 'document', document: { id: headerMediaId, filename: headerFilename || 'documento.pdf' } }
    : headerFormat === 'VIDEO'
      ? { type: 'video', video: { id: headerMediaId } }
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

async function templateCreds(lineId) {
  const creds = await getActiveCredentials(undefined, lineId);
  if (!creds.wabaId) {
    throw new Error('Falta el ID de la cuenta de WhatsApp Business (waba_id) — configúralo en Configuración.');
  }
  return creds;
}

// Live from Meta rather than mirrored in our own DB — a template's approval status
// changes on Meta's side (review, reclassification, pause) and a stale local copy is
// exactly how a campaign could try to send with a template that no longer works.
// Sigue la paginación de Meta (hasta 1000 plantillas) y pide también la calidad y los cambios de categoría; si Meta
// rechazara alguno de esos campos extra para esta cuenta, repite con los básicos en vez de dejar la lista vacía.
const TEMPLATE_FIELDS_BASE = 'id,name,status,category,language,components,rejected_reason';
const TEMPLATE_FIELDS_FULL = `${TEMPLATE_FIELDS_BASE},quality_score,correct_category,previous_category`;
export async function listTemplates(lineId) {
  const creds = await templateCreds(lineId);
  const readAll = async (fields) => {
    const all = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const { data, paging } = await graphFetch(
        `${creds.wabaId}/message_templates?fields=${fields}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        { method: 'GET' },
        creds.token
      );
      all.push(...(data ?? []));
      after = paging?.next ? paging?.cursors?.after : null;
      if (!after) break;
    }
    return all;
  };
  try { return await readAll(TEMPLATE_FIELDS_FULL); } catch (err) {
    if (!/\(#100\)|nonexisting field|Unsupported get request/i.test(String(err.message))) throw err;
    return readAll(TEMPLATE_FIELDS_BASE);
  }
}

// `components` ya viene armado y validado (whatsappTemplates.js buildComponents). Una plantilla nueva queda PENDING hasta
// que Meta la revisa (minutos a ~1 día); listTemplates() es la forma de ver su estado real.
export async function createTemplate({ name, category, language, components, lineId }) {
  const creds = await templateCreds(lineId);
  return graphFetch(`${creds.wabaId}/message_templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language, category, components }),
  }, creds.token);
}

// Editar una plantilla ya creada (aprobada, rechazada o pausada). Meta limita las ediciones de una aprobada (1 por día y
// 10 por mes) y no deja cambiar su categoría; una rechazada se corrige y se vuelve a enviar a revisión.
export async function updateTemplate({ templateId, components, category, lineId }) {
  const creds = await templateCreds(lineId);
  return graphFetch(`${templateId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ components, ...(category ? { category } : {}) }),
  }, creds.token);
}

// Con hsmId borra solo ese idioma; sin él, Meta borra todos los idiomas de ese nombre.
export async function deleteTemplate(name, lineId, hsmId) {
  const creds = await templateCreds(lineId);
  return graphFetch(`${creds.wabaId}/message_templates?name=${encodeURIComponent(name)}${hsmId ? `&hsm_id=${encodeURIComponent(hsmId)}` : ''}`, { method: 'DELETE' }, creds.token);
}

// Meta pide un archivo de ejemplo para el encabezado de imagen / video / documento, y solo acepta un "handle" de su API de
// carga reanudable (no un media id de los envíos). Hace falta el ID de la app: META_APP_ID, o se lee del propio token.
let cachedAppId = null;
async function appIdFor(token) {
  if (process.env.META_APP_ID) return process.env.META_APP_ID;
  if (cachedAppId) return cachedAppId;
  const info = await graphFetch(`debug_token?input_token=${encodeURIComponent(token)}`, { method: 'GET' }, token);
  if (!info?.data?.app_id) throw new Error('No se pudo saber el ID de la app de Meta. Agrega la variable META_APP_ID en Dokploy.');
  cachedAppId = String(info.data.app_id);
  return cachedAppId;
}

export async function uploadTemplateSample(buffer, mimeType, filename, lineId) {
  const creds = await templateCreds(lineId);
  const appId = await appIdFor(creds.token);
  const session = await graphFetch(
    `${appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mimeType)}&file_name=${encodeURIComponent(filename || 'ejemplo')}`,
    { method: 'POST' }, creds.token
  );
  const uploaded = await graphFetch(session.id, { method: 'POST', headers: { Authorization: `OAuth ${creds.token}`, file_offset: '0' }, body: buffer }, creds.token, UPLOAD_TIMEOUT_MS);
  if (!uploaded?.h) throw new Error('Meta no devolvió el identificador del archivo de ejemplo');
  return uploaded.h;
}

export async function uploadMedia(buffer, mimeType, toPhone, lineId, filename) {
  const creds = await getActiveCredentials(toPhone, lineId);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  const safeFilename = filename || (mimeType.startsWith('image/') ? 'image.jpg' : (mimeType.startsWith('audio/') ? 'audio.mp3' : 'document.pdf'));
  form.append('file', new Blob([buffer], { type: mimeType }), safeFilename);
  form.append('type', mimeType);
  const { id } = await graphFetch(`${creds.phoneNumberId}/media`, { method: 'POST', body: form }, creds.token, UPLOAD_TIMEOUT_MS);
  return id;
}

export async function sendMedia(toPhone, kind, mediaId, filename, caption, lineId) {
  const creds = await getActiveCredentials(toPhone, lineId);
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

export async function downloadMedia(mediaId, token) {
  const meta = await graphFetch(`${mediaId}`, { method: 'GET' }, token);
  if (!meta?.url) {
    throw new Error('Meta no devolvió la URL de descarga para el archivo adjunto');
  }
  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Error descargando archivo de Meta (${res.status}): ${await res.text().catch(() => '')}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: meta.mime_type || res.headers.get('content-type') || 'application/octet-stream',
    fileSize: meta.file_size,
  };
}

export async function subscribeWaba(wabaId, token) {
  return graphFetch(`${wabaId}/subscribed_apps`, { method: 'POST' }, token);
}

export async function registerNumber(phoneNumberId, pin, token) {
  return graphFetch(`${phoneNumberId}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      pin: String(pin),
    }),
  }, token);
}

