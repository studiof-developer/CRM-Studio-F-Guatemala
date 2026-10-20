import { pool } from './db.js';
import { lineFromSession, defaultLineId } from './salesThreads.js';

// Vista "Análisis": lee los chats que ya están guardados (n8n_chat_histories) y los clasifica en los casos que pide
// administración — pauta de nueva colección, pauta con % de descuento, preguntas por guía, cambios de talla o prenda,
// clientes atendidos ayer que retomaron hoy y pauta de una referencia puntual. No escribe nada. Solo WhatsApp: los chats de
// Instagram / Messenger viven en otras tablas.
const GT_MS = 6 * 3600000;
const phoneOf = (sessionId) => String(sessionId).split('__')[0];
const dayKey = (d) => new Date(+new Date(d) - GT_MS).toISOString().slice(0, 10);

const RE_COL = /nueva\s+colecci[oó]n/i;
const RE_PCT = /(\d{1,2})\s?%/g;
const RE_PROMO = /\d{1,2}\s?%\s?(off|de desc|desc|dcto)/i;
const RE_REF = /\b[A-Z]\d{5,7}[A-Z]?\b/g;
const RE_GUIA = /\bgu[ií]a\b|rastre|tracking|n[uú]mero de (env[ií]o|seguimiento)|d[oó]nde (va|est[aá]|viene) (mi )?(pedido|paquete|env[ií]o|compra)|cu[aá]ndo (me )?lleg/i;
const PRENDAS = '(talla|prenda|blusa|pantal[oó]n|vestido|camisa|camiseta|chaqueta|falda|jean|short|body|enterizo|conjunto|abrigo|su[eé]ter)';
const RE_CAMBIO = new RegExp(
  `(cambi(o|ar|arla|arlo|e)|devoluci[oó]n|devolver)\\b[^.\\n]{0,50}${PRENDAS}|${PRENDAS}[^.\\n]{0,50}(cambi(o|ar|e)|no me (qued|sirv|entr)|me qued[oó] (grande|peque|chica|ancha|apretada)|equivoc)|quiero (hacer )?(un )?cambio|solicitar (un )?cambio`,
  'i'
);

const uniq = (list) => [...new Set(list)];

// Mensajes de una línea: el session_id lleva "__line_N"; los viejos, sin ese sufijo, son de la línea por defecto (la misma
// regla que usa Conversaciones). Agrega los parámetros a `params` y devuelve el pedazo de SQL (vacío si no hay línea).
function lineCondition(lineId, defaultLine, params, alias) {
  if (!lineId) return '';
  params.push(String(lineId));
  const a = params.length;
  params.push(Number(lineId) === Number(defaultLine));
  const b = params.length;
  return ` AND (${alias}.session_id ~ ('__line_' || $${a}::text || '(__|$)') OR ($${b}::boolean AND ${alias}.session_id !~ '__line_'))`;
}

// chat = { firstMessageAt, firstReferral, messages: [{ at, inWindow, role, text, referral }] }; win = { from, to }.
export function classifyChat(chat, win) {
  const msgs = chat.messages ?? [];
  const cust = msgs.filter((m) => m.role === 'customer');
  const inWin = cust.filter((m) => m.inWindow);
  const refs = [chat.firstReferral, ...msgs.map((m) => m.referral)].filter(Boolean);
  const adText = refs.map((r) => [r.headline, r.body, r.title].filter(Boolean).join(' ')).join(' ').trim();
  const firstText = cust[0]?.text ?? '';
  const copy = `${adText} ${firstText}`;
  const viaAd = refs.length > 0;
  const adIds = uniq(refs.map((r) => r.source_id ?? r.ad_id ?? r.sourceId).filter(Boolean).map(String));
  const pcts = uniq([...copy.matchAll(RE_PCT)].map((m) => parseInt(m[1], 10)).filter((n) => n >= 5 && n <= 90)).sort((a, b) => b - a);
  const refCodes = uniq(copy.match(RE_REF) ?? []);

  const today = dayKey(win.to);
  const yesterday = dayKey(new Date(+new Date(win.to) - 86400000));
  const attendedYesterday = msgs.some((m) => m.role === 'advisor' && dayKey(m.at) === yesterday);
  const wroteToday = cust.some((m) => dayKey(m.at) === today);

  const cats = {};
  if (RE_COL.test(copy) && (viaAd || RE_COL.test(firstText))) cats.col = true;
  if (pcts.length && (viaAd || RE_PROMO.test(firstText))) cats.desc = true;
  if (inWin.some((m) => RE_GUIA.test(m.text ?? ''))) cats.guia = true;
  if (inWin.some((m) => RE_CAMBIO.test(m.text ?? ''))) cats.cambio = true;
  if (attendedYesterday && wroteToday) cats.retomo = true;
  if (refCodes.length || (viaAd && adIds.length)) cats.ref = true;

  return {
    viaAd, adIds, pcts, refCodes, adCopy: adText,
    isNew: !!chat.firstMessageAt && +new Date(chat.firstMessageAt) >= +new Date(win.from),
    cats: Object.keys(cats),
  };
}

// Carga los chats con mensajes en [from, to] (más el contexto desde ctxFrom, marcado inWindow = false). Con `phones` solo esos
// clientes y con `allHistory` todo su historial; con `light` omite adjuntos, tickets y ventas (la lista no los necesita).
async function loadChats({ from, to, ctxFrom, phones = null, allHistory = false, light = false, lineId = null }) {
  const defaultLine = await defaultLineId();
  const params = [to];
  let where = 'h.created_at <= $1';
  if (!allHistory) { params.push(ctxFrom); where += ` AND h.created_at >= $${params.length}`; }
  if (phones) { params.push(phones.map((p) => `${p}%`)); where += ` AND h.session_id LIKE ANY($${params.length}::text[])`; }
  where += lineCondition(lineId, defaultLine, params, 'h');
  const { rows: msgs } = await pool.query(
    `SELECT h.id, h.session_id, h.created_at, h.message FROM n8n_chat_histories h WHERE ${where} ORDER BY h.created_at, h.id`,
    params
  );

  const byPhone = new Map();
  for (const r of msgs) {
    const p = phoneOf(r.session_id);
    if (phones && !phones.includes(p)) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(r);
  }
  if (!phones) for (const [p, list] of byPhone) if (!list.some((r) => +r.created_at >= +from)) byPhone.delete(p);
  const keys = [...byPhone.keys()];
  if (!keys.length) return [];

  const patterns = keys.map((p) => `${p}%`);
  const ids = light ? [] : [...byPhone.values()].flat().map((r) => r.id);
  const empty = Promise.resolve({ rows: [] });
  const refParams = [patterns];
  const refLine = lineCondition(lineId, defaultLine, refParams, 'h');
  const seenParams = [patterns];
  const seenLine = lineCondition(lineId, defaultLine, seenParams, 'h');
  const [customers, tickets, sales, attachments, firstRef, firstSeen] = await Promise.all([
    pool.query(light ? 'SELECT id, whatsapp_number, full_name FROM customers WHERE whatsapp_number = ANY($1::text[])' : 'SELECT * FROM customers WHERE whatsapp_number = ANY($1::text[])', [keys]),
    light ? empty : pool.query(
      `SELECT t.customer_id, t.id, t.status, t.assigned_advisor, t.handoff_reason, t.whatsapp_number_id, t.created_at, t.updated_at, t.first_response_at
       FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE c.whatsapp_number = ANY($1::text[]) ORDER BY t.id DESC LIMIT 60`, [keys]),
    light ? empty : pool.query(
      `SELECT s.customer_id, s.amount, s.status, s.advisor_name, s.created_at, s.whatsapp_number_id
       FROM sales s JOIN customers c ON c.id = s.customer_id WHERE c.whatsapp_number = ANY($1::text[]) ORDER BY s.created_at DESC LIMIT 60`, [keys]),
    light ? empty : pool.query(
      `SELECT a.n8n_message_id, a.kind, a.mime_type, a.filename, o.amount, o.snippet
       FROM message_attachments a LEFT JOIN attachment_ocr o ON o.attachment_id = a.id WHERE a.n8n_message_id = ANY($1::int[]) ORDER BY a.id`, [ids]),
    pool.query(
      `SELECT DISTINCT ON (split_part(h.session_id, '__', 1)) split_part(h.session_id, '__', 1) AS phone, h.created_at, h.message->'additional_kwargs'->'referral' AS referral
       FROM n8n_chat_histories h WHERE h.session_id LIKE ANY($1::text[]) AND h.message->'additional_kwargs'->'referral' IS NOT NULL${refLine}
       ORDER BY split_part(h.session_id, '__', 1), h.id`, refParams),
    pool.query(
      `SELECT split_part(h.session_id, '__', 1) AS phone, min(h.created_at) AS first_at, count(*)::int AS total
       FROM n8n_chat_histories h WHERE h.session_id LIKE ANY($1::text[])${seenLine} GROUP BY 1`, seenParams),
  ]);

  const group = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  // con una línea elegida, los tickets y ventas también son solo de esa línea (sin línea guardada = la línea por defecto)
  const ofLine = (r) => !lineId || Number(r.whatsapp_number_id ?? defaultLine) === Number(lineId);
  const ticketsBy = group(tickets.rows.filter(ofLine), 'customer_id');
  const salesBy = group(sales.rows.filter(ofLine), 'customer_id');
  const attBy = group(attachments.rows, 'n8n_message_id');
  const refBy = new Map(firstRef.rows.map((r) => [r.phone, r]));
  const seenBy = new Map(firstSeen.rows.map((r) => [r.phone, r]));
  const custBy = new Map(customers.rows.map((c) => [c.whatsapp_number, c]));

  return keys.map((p) => {
    const c = custBy.get(p) ?? null;
    return {
      phone: p,
      customer: c,
      firstMessageAt: seenBy.get(p)?.first_at ?? null,
      totalMessagesEver: seenBy.get(p)?.total ?? null,
      firstReferral: refBy.get(p) ? { at: refBy.get(p).created_at, ...refBy.get(p).referral } : null,
      tickets: c ? (ticketsBy.get(c.id) ?? []).slice(0, 5) : [],
      sales: c ? (salesBy.get(c.id) ?? []).slice(0, 8) : [],
      messages: byPhone.get(p).map((r) => {
        const m = r.message ?? {};
        const kw = m.additional_kwargs ?? {};
        return {
          id: r.id, at: r.created_at, inWindow: +r.created_at >= +from,
          role: m.type === 'human' ? 'customer' : (m.type === 'ai' && kw.sentBy === 'advisor' ? 'advisor' : 'bot'),
          advisor: kw.advisorName ?? null, line: lineFromSession(r.session_id) ?? defaultLine, text: m.content ?? '',
          referral: kw.referral ?? null, campaignId: kw.campaignId ?? null,
          attachments: (attBy.get(r.id) ?? []).map((a) => ({ kind: a.kind, mime: a.mime_type, name: a.filename, amount: a.amount, text: a.snippet })),
        };
      }),
    };
  });
}

// Lista liviana: una fila por cliente con lo que se detectó. La conversación completa se pide aparte (chatDetail).
export async function analyzeWindow({ from, to, ctxFrom, lineId = null }) {
  const chats = await loadChats({ from, to, ctxFrom: ctxFrom < from ? ctxFrom : from, light: true, lineId });
  const win = { from, to };
  const items = chats.map((c) => {
    const k = classifyChat(c, win);
    const inWin = c.messages.filter((m) => m.inWindow);
    const last = inWin[inWin.length - 1] ?? c.messages[c.messages.length - 1];
    return {
      phone: c.phone, name: c.customer?.full_name ?? null, ...k,
      msgsInWindow: inWin.length, lastAt: last.at, lastRole: last.role, lastText: String(last.text ?? '').slice(0, 160),
      lines: uniq(inWin.map((m) => m.line)),
    };
  });
  items.sort((a, b) => +new Date(b.lastAt) - +new Date(a.lastAt));
  return { window: { from, to }, lineId, items };
}

export async function chatDetail({ phone, from, to, lineId = null }) {
  const [chat] = await loadChats({ from, to, ctxFrom: from, phones: [phone], allHistory: true, lineId });
  if (!chat) return null;
  return { ...chat, analysis: classifyChat(chat, { from, to }) };
}
