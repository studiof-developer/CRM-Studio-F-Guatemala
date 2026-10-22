import { pool } from './db.js';
import { buildEpisodes, receiptAmountInText, givesPaymentInfo, isPaymentInfoImageText, PAYMENT_IMAGE_MARKER, PAYINFO_FRESH_MS } from './salesRules.js';

// Carga el hilo de UN cliente en UNA línea y lo convierte en ventas (episodios). Lo usan el
// motor en vivo, la auditoría y el análisis histórico: una sola definición de "qué es una venta".
const DAY = 86400000;

export async function defaultLineId() {
  const { rows } = await pool.query('SELECT id FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1');
  return rows[0]?.id ?? 1;
}

// SQL para los mensajes de una línea: el session_id lleva "__line_N"; los viejos, sin ese sufijo, son de la línea por defecto
// (la misma regla que usa Conversaciones). Agrega los parámetros a `params`; sin línea devuelve ''.
export function lineSessionSql(lineId, defaultLine, params, alias) {
  if (!lineId) return '';
  params.push(String(lineId));
  const a = params.length;
  params.push(Number(lineId) === Number(defaultLine));
  const b = params.length;
  return ` AND (${alias}.session_id ~ ('__line_' || $${a}::text || '(__|$)') OR ($${b}::boolean AND ${alias}.session_id !~ '__line_'))`;
}

export function lineFromSession(sessionId) {
  const m = /__line_(\d+)/.exec(sessionId ?? '');
  return m ? Number(m[1]) : null;
}

function toChatEvent(row) {
  const m = row.message ?? {};
  const kw = m.additional_kwargs ?? {};
  const role = m.type === 'human' ? 'customer' : (m.type === 'ai' && kw.sentBy === 'advisor' ? 'advisor' : 'bot');
  const text = m.content ?? '';
  const stored = Number(kw.ocrAmount);
  const fromText = role === 'customer' && !(stored > 0) ? receiptAmountInText(text) : null;
  return {
    id: Number(row.id), at: row.created_at, role, advisor: kw.advisorName ?? null, text,
    ocrAmount: stored > 0 ? stored : fromText, via: stored > 0 ? (kw.ocrKind ?? 'imagen') : (fromText ? 'texto' : null),
    voucher: kw.ocrVoucher === true,
  };
}

// Mensajes de UN hilo (cliente + línea). El hilo de la línea por defecto también incluye los
// session_id viejos sin "__line_" — misma regla que usa Conversaciones.
export async function loadEvents({ phone, customerId, lineId, from, to }) {
  if (String(phone ?? '').startsWith('social:')) {
    const { rows } = await pool.query(
      `SELECT sm.id, sm.created_at, sm.direction, sm.body, sm.advisor_name
       FROM social_contacts sc JOIN social_messages sm ON sm.contact_id = sc.id
       WHERE sc.customer_id = $1 AND sm.created_at >= $2 AND sm.created_at <= $3
       ORDER BY sm.created_at, sm.id`,
      [customerId, from, to]
    );
    return rows.map((r) => {
      const role = r.direction === 'in' ? 'customer' : 'advisor';
      const text = r.body ?? '';
      const amount = role === 'customer' ? receiptAmountInText(text) : null;
      return { id: Number(r.id), at: r.created_at, role, advisor: r.advisor_name ?? null, text, ocrAmount: amount, via: amount ? 'texto' : null, voucher: false };
    });
  }
  const isDefault = Number(lineId) === Number(await defaultLineId());
  const { rows } = await pool.query(
    `SELECT h.id, h.created_at, h.message
     FROM n8n_chat_histories h
     WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '\\_\\_%')
       AND (h.session_id ~ ('__line_' || $2::text || '(__|$)') OR ($3::boolean AND h.session_id !~ '__line_'))
       AND h.created_at >= $4 AND h.created_at <= $5
     ORDER BY h.created_at, h.id`,
    [phone, String(lineId), isDefault, from, to]
  );
  return rows.map(toChatEvent);
}

// El nombre del chat es el full_name con el que la asesora inició sesión; si es un nombre
// corto/antiguo ("Leydi") se acepta solo si identifica a una única usuaria.
export async function resolveAdvisor(name) {
  const exact = await pool.query(
    'SELECT id, full_name FROM users WHERE lower(full_name) = lower($1) OR lower(username) = lower($1) LIMIT 2', [name]
  );
  if (exact.rows.length === 1) return { id: exact.rows[0].id, name: exact.rows[0].full_name };
  const prefix = await pool.query(`SELECT id, full_name FROM users WHERE lower(full_name) LIKE lower($1) || ' %' LIMIT 2`, [name]);
  if (prefix.rows.length === 1) return { id: prefix.rows[0].id, name: prefix.rows[0].full_name };
  return { id: null, name };
}

export function nameResolver() {
  const cache = new Map();
  return async (name) => {
    if (!name) return null;
    if (!cache.has(name)) cache.set(name, (await resolveAdvisor(name)).name);
    return cache.get(name);
  };
}

export async function threadLines(phone) {
  if (String(phone).startsWith('social:')) return [null];
  const { rows } = await pool.query(
    `SELECT DISTINCT session_id FROM n8n_chat_histories WHERE session_id = $1 OR session_id LIKE $1 || '\\_\\_%'`, [phone]
  );
  const fallback = await defaultLineId();
  return [...new Set(rows.map((r) => lineFromSession(r.session_id) ?? fallback))];
}

// Marca los mensajes del cliente que traen un adjunto (imagen o PDF) y le pone su monto/voucher
// leído. Sin `ocr`, solo usa lo ya guardado (chat y caché); con `ocr` lee los adjuntos nuevos,
// pero únicamente los que llegaron después de que la asesora dio medios de pago: lo anterior
// no puede ser la prueba de esta compra y leerlo sería trabajo perdido.
async function applyAttachments(events, ocr) {
  // Sin monto leído, o con un monto entero de una imagen/PDF (el OCR de antes redondeaba los centavos).
  const candidates = events.filter((e) => e.role === 'customer' && (!e.ocrAmount || (e.via && e.via !== 'texto' && Number.isInteger(e.ocrAmount))));
  if (!candidates.length) return;
  const { rows } = await pool.query(
    `SELECT a.id, a.n8n_message_id, a.mime_type, a.file_path, o.amount, o.voucher AS cached_voucher,
            (o.attachment_id IS NOT NULL) AS cached
     FROM message_attachments a LEFT JOIN attachment_ocr o ON o.attachment_id = a.id
     WHERE a.n8n_message_id = ANY($1::int[]) AND (a.kind = 'image' OR a.mime_type = 'application/pdf')
     ORDER BY a.id`,
    [candidates.map((e) => e.id)]
  );
  if (!rows.length) return;
  const byMessage = new Map();
  for (const r of rows) byMessage.set(Number(r.n8n_message_id), [...(byMessage.get(Number(r.n8n_message_id)) ?? []), r]);
  const firstPayInfo = events.find((e) => e.role === 'advisor' && givesPaymentInfo(e.text));
  // Los medios de pago casi siempre llegan como la tarjeta "MEDIOS DE PAGO" (imagen sin texto): todavía no se sabe que lo son (eso se lee
  // después), así que cuenta como posible tarjeta lo que la asesora mandó tras elegir el cliente cómo pagar, en las 24 h previas.
  const cardBefore = (e) => events.some((x) => x.role === 'advisor' && x.id > 0 && +new Date(x.at) < +new Date(e.at)
    && +new Date(e.at) - +new Date(x.at) <= PAYINFO_FRESH_MS && followsPaymentChoice(events, x));

  for (const e of candidates) {
    const atts = byMessage.get(e.id);
    if (!atts) continue;
    e.image = true;
    for (const att of atts.slice(0, 2)) {
      let amount = att.cached ? Number(att.amount) : null;
      let voucher = att.cached ? att.cached_voucher : false;
      if (!att.cached && ocr && ((firstPayInfo && +new Date(e.at) > +new Date(firstPayInfo.at)) || cardBefore(e))) {
        const read = await ocr.run(att);
        if (!read.skipped) ({ amount, voucher } = read);
      }
      if (voucher) e.voucher = true;
      if (amount > 0) {
        if (!e.ocrAmount) { e.ocrAmount = amount; e.via = att.mime_type === 'application/pdf' ? 'pdf' : 'imagen'; }
        else if (Math.abs(amount - e.ocrAmount) <= 1) e.ocrAmount = amount; // misma cifra, ahora con centavos
      }
    }
  }
}

// Imágenes que mandó la asesora sin texto (típico: la tarjeta "MEDIOS DE PAGO"). Solo se miran las de las 24 h previas a
// un comprobante del cliente o al final del hilo (cierre / pendientes): son las que pueden ser los medios de pago de esa
// compra. Si la imagen dice "medios de pago" o nombra un banco, el evento cuenta como que la asesora dio los medios de pago.
// La tarjeta de medios de pago se manda justo después de que el cliente elige cómo pagar ("transferencia", "link") o de que la
// asesora lo pregunta. Mirar solo esas imágenes evita gastar lecturas OCR en cada foto de catálogo del día (en el cierre del
// 19 de oct. el tope se agotaba con 547 chats y los medios de pago en imagen de varias ventas quedaban sin leer).
const PAYMENT_CHOICE_RE = /(transfer|dep[oó]sito|\blink\b|enlace|tarjeta|cuenta)/i;
const ASKED_PAYMENT_RE = /link\s+o\s+transferencia|c[oó]mo\s+(deseas|quieres|prefieres)\s+pagar/i;
function followsPaymentChoice(events, e) {
  const t = +new Date(e.at);
  return events.some((x) => +new Date(x.at) < t && +new Date(x.at) >= t - 45 * 60000
    && ((x.role === 'customer' && PAYMENT_CHOICE_RE.test(x.text ?? '')) || (x.role === 'advisor' && ASKED_PAYMENT_RE.test(x.text ?? ''))));
}

async function applyAdvisorImages(events, ocr, windowMs = PAYINFO_FRESH_MS) {
  const anchors = events.filter((e) => e.role === 'customer' && (e.ocrAmount || e.voucher)).map((e) => +new Date(e.at));
  if (events.length) anchors.push(+new Date(events[events.length - 1].at));
  const near = (t) => anchors.some((a) => t <= a && a - t <= windowMs);
  const candidates = events.filter((e) => e.role === 'advisor' && e.id > 0 && !givesPaymentInfo(e.text) && near(+new Date(e.at)) && followsPaymentChoice(events, e));
  if (!candidates.length) return;
  const { rows } = await pool.query(
    `SELECT a.id, a.n8n_message_id, a.mime_type, a.file_path, o.snippet, (o.attachment_id IS NOT NULL) AS cached
     FROM message_attachments a LEFT JOIN attachment_ocr o ON o.attachment_id = a.id
     WHERE a.n8n_message_id = ANY($1::int[]) AND a.kind = 'image' ORDER BY a.id`,
    [candidates.map((e) => e.id)]
  );
  const byMessage = new Map();
  for (const r of rows) byMessage.set(Number(r.n8n_message_id), [...(byMessage.get(Number(r.n8n_message_id)) ?? []), r]);
  for (const e of candidates) {
    for (const att of (byMessage.get(e.id) ?? []).slice(0, 2)) {
      let snippet = att.cached ? att.snippet : null;
      if (!att.cached && ocr) {
        const read = await ocr.run(att);
        if (!read.skipped) snippet = read.snippet;
      }
      if (isPaymentInfoImageText(snippet)) { e.text = `${e.text ?? ''} ${PAYMENT_IMAGE_MARKER}`.trim(); break; }
    }
  }
}

// Hilo completo (o la ventana from..to) de un cliente en una línea, ya convertido en ventas.
// asOf = "como estaba el chat a esa hora": solo cuenta lo que ya había ocurrido (comprobantes, confirmaciones, medios de pago).
export async function buildThread(customer, lineId, { from = new Date(0), to = new Date(Date.now() + DAY), ocr = null, asOf = null, pendingMs = PAYINFO_FRESH_MS } = {}) {
  if (asOf) to = new Date(asOf);
  const events = await loadEvents({ phone: customer.whatsapp_number, customerId: customer.id, lineId, from, to });
  if (lineId !== null) { await applyAttachments(events, ocr); await applyAdvisorImages(events, ocr, pendingMs); }
  // Las cotizaciones formales del Cotizador (la tarjeta PNG con precios) son precios ofrecidos
  // igual que los que la asesora escribe en el chat.
  const { rows: quotes } = await pool.query(
    `SELECT q.id, q.created_at, q.grand_total, u.full_name
     FROM quotes q LEFT JOIN users u ON u.id = q.advisor_user_id
     WHERE q.customer_id = $1 AND q.grand_total > 0 AND q.created_at >= $2 AND q.created_at <= $3
       AND ($4::int IS NULL OR q.whatsapp_number_id IS NULL OR q.whatsapp_number_id = $4::int)`,
    [customer.id, from, to, lineId]
  );
  for (const q of quotes) {
    events.push({ id: -q.id, at: q.created_at, role: 'advisor', advisor: q.full_name ?? null, text: `Cotización formal. Total Q${q.grand_total}`, ocrAmount: null, via: null, voucher: false });
  }
  return { events, ...buildEpisodes(events, { asOf, pendingMs }) };
}

// Todas las ventas reconstruidas de un cliente (todas sus líneas), con los nombres de asesora
// normalizados al usuario del CRM.
export async function analyzeCustomer(customer, { canonical = nameResolver(), ocr = null, asOf = null, pendingMs = PAYINFO_FRESH_MS } = {}) {
  const rows = [];
  const pending = [];
  const orphans = [];
  let resentReceipts = 0;
  for (const line of await threadLines(customer.whatsapp_number)) {
    const t = await buildThread(customer, line, { ocr, asOf, pendingMs });
    resentReceipts += t.resentReceipts;
    if (t.pending) {
      pending.push({
        ...t.pending, advisor: await canonical(t.pending.advisor), customerId: customer.id, customer: customer.full_name || customer.whatsapp_number,
        phone: customer.whatsapp_number, last4: customer.whatsapp_number.slice(-4), line,
      });
    }
    for (const o of t.orphanReceipts) orphans.push({ ...o, line, customerId: customer.id, customer: customer.full_name || customer.whatsapp_number, phone: customer.whatsapp_number });
    for (const ep of t.episodes) {
      rows.push({
        at: ep.at, eventId: ep.eventId, customerId: customer.id, customer: customer.full_name || customer.whatsapp_number,
        phone: customer.whatsapp_number, last4: customer.whatsapp_number.slice(-4), line,
        currentStatus: customer.manual_status ?? null, type: ep.type, via: ep.via, amount: ep.amount, quote: ep.quote,
        advisor: await canonical(ep.advisor), rule: ep.rule, paymentInfoBy: await canonical(ep.paymentInfoBy), paymentInfoId: ep.paymentInfoId,
        medium: ep.medium, voucher: ep.voucher, shift: ep.shift, touchedBy: await Promise.all(ep.touchedBy.map(canonical)),
        confirmedBy: await canonical(ep.confirmedBy), confirmedAt: ep.confirmedAt ?? null,
        attributionUncertain: ep.attributionUncertain, quotedAmounts: ep.quotedAmounts, amountBasis: ep.amountBasis, priceApprovedByCustomer: ep.priceApprovedByCustomer,
        verified: ep.verified, status: ep.status, imagesWithoutAmount: ep.imagesWithoutAmount, issues: ep.issues,
      });
    }
  }
  return { rows, orphans, resentReceipts, pending };
}
