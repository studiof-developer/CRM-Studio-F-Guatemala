// Thin wrapper over Meta's WhatsApp Cloud API for outbound sends. The bot's own
// replies go through n8n directly — this is only for messages the CRM itself
// originates (an advisor typing/attaching something in Conversations).
const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Both env vars are required for real delivery, but missing them shouldn't crash
// local/dev usage where there's no real WhatsApp number configured yet.
const configured = Boolean(TOKEN && PHONE_NUMBER_ID);

async function graphFetch(path, options) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${body}`);
  }
  return res.json();
}

// contextMessageId, when given the wamid of an earlier message, makes WhatsApp show
// this as a native quoted reply on the customer's side — not just inside the CRM.
export async function sendText(toPhone, body, contextMessageId) {
  if (!configured) {
    console.warn('WhatsApp not configured (WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID) — skipping real send');
    return null;
  }
  return graphFetch(`${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body },
      ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    }),
  });
}

// First-contact messages (customer never wrote in, or >24h since their last message)
// must use a pre-approved Meta template — free text gets rejected outright.
export async function sendTemplate(toPhone, templateName, languageCode, bodyParams = []) {
  if (!configured) {
    console.warn('WhatsApp not configured (WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID) — skipping real send');
    return null;
  }
  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
    : undefined;
  return graphFetch(`${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components },
    }),
  });
}

export async function uploadMedia(buffer, mimeType) {
  if (!configured) {
    console.warn('WhatsApp not configured (WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID) — skipping real upload');
    return null;
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }));
  form.append('type', mimeType);
  const { id } = await graphFetch(`${PHONE_NUMBER_ID}/media`, { method: 'POST', body: form });
  return id;
}

export async function sendMedia(toPhone, kind, mediaId, filename) {
  if (!configured) {
    console.warn('WhatsApp not configured (WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID) — skipping real send');
    return null;
  }
  const payload = { messaging_product: 'whatsapp', to: toPhone, type: kind, [kind]: { id: mediaId } };
  if (kind === 'document' && filename) payload.document.filename = filename;
  return graphFetch(`${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export const isConfigured = () => configured;
