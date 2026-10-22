import { pool } from './db.js';
import { analyzeCustomer, nameResolver } from './salesThreads.js';
import { createLazyOcrRunner } from './ocrRunner.js';
import { pendingFromLinks } from './paymentLinks.js';
import { PENDING_HOURS, PENDING_FRESH_MS } from './salesRules.js';

// Pendiente de pago AHORA: ventas que la asesora ya dejó "cerradas" (entregó los medios de pago en las últimas 72 h, por cuenta o
// por link) y de las que todavía no hay comprobante ni venta registrada. Dos fuentes que se juntan por cliente:
//   - links de NeoLink: el monto sale de la página del link (paymentLinks.js);
//   - el chat: el mismo motor del Cierre del día (findPending), con el monto que la asesora cotizó.
// Si hay las dos para un mismo cliente se usa el link, que trae el monto exacto.
const CACHE_MS = 60000;
const MAX_CANDIDATES = 150; // la ventana pasó de 24 a 72 h: caben más clientes (la lista se recalcula como mucho cada minuto)
let cache = null; // { at, promise }

// Clientes a los que una asesora les mandó, en las últimas 72 h, algo que parece medios de pago: texto con cuenta, banco o link,
// o una imagen (la tarjeta de medios de pago se manda como imagen; el motor decide cuáles lo son leyéndolas, con caché).
const CANDIDATES_SQL = `
  SELECT DISTINCT c.id, c.whatsapp_number, c.full_name, c.manual_status
  FROM n8n_chat_histories h JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
  WHERE h.created_at >= now() - interval '${PENDING_HOURS} hours' AND h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
    AND h.message->'additional_kwargs'->>'campaignId' IS NULL
    AND (h.message->>'content' ~* '(https?://|neolink|banrural|banco industrial|\\mbac\\M|n[uú]mero de cuenta|cuenta (monetaria|de ahorros?|corriente)|a nombre de|puedes? pagar)'
         OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id AND a.kind = 'image'))
  LIMIT ${MAX_CANDIDATES}`;

async function pendingFromChats() {
  const { rows: customers } = await pool.query(CANDIDATES_SQL);
  const canonical = nameResolver();
  const ocr = createLazyOcrRunner({ maxReads: 8, throttle: false });
  const out = [];
  try {
    for (const c of customers) {
      try {
        const r = await analyzeCustomer(c, { canonical, ocr, asOf: new Date(), pendingMs: PENDING_FRESH_MS });
        for (const p of r.pending) {
          out.push({
            source: 'chat', customerId: c.id, phone: c.whatsapp_number, customerName: c.full_name ?? null, line: p.line, medium: p.medium ?? 'transferencia',
            amount: p.quotedAfter ?? p.amount ?? (p.quotedAmounts?.length ? p.quotedAmounts[p.quotedAmounts.length - 1] : null),
            sentAt: p.at, advisorName: p.advisor ?? 'Sin asignar', url: null,
          });
        }
      } catch (err) { console.error(`pending: cliente ${c.id}`, err.message); }
    }
  } finally {
    await ocr.close();
  }
  // si ya hay una venta registrada después de los medios de pago, ya no está pendiente
  if (!out.length) return out;
  const { rows } = await pool.query(
    `SELECT customer_id, max(created_at) AS at FROM sales WHERE status IN ('confirmada', 'revisar') AND customer_id = ANY($1::int[]) GROUP BY customer_id`,
    [out.map((p) => p.customerId)]
  );
  const lastSale = new Map(rows.map((r) => [r.customer_id, +new Date(r.at)]));
  return out.filter((p) => !(lastSale.get(p.customerId) >= +new Date(p.sentAt)));
}

// Une las dos fuentes (un pendiente por cliente y línea) y arma el resumen que muestra el Dashboard.
export function mergePending({ links, chats, lineId = null }) {
  const byKey = new Map();
  const key = (p) => `${p.phone}`;
  for (const p of chats) byKey.set(key(p), p);
  for (const l of links) {
    const prev = byKey.get(key(l));
    // el link manda si trae monto; si no se pudo leer, se conserva el monto que dijo la asesora en el chat
    byKey.set(key(l), prev && l.amount == null ? { ...l, amount: prev.amount, source: 'chat+link' } : { ...l, source: prev ? 'link+chat' : 'link' });
  }
  const items = [...byKey.values()]
    .filter((p) => !lineId || p.line == null || Number(p.line) === Number(lineId))
    .sort((a, b) => +new Date(b.sentAt) - +new Date(a.sentAt));
  const byAdvisor = {};
  for (const it of items) {
    const a = (byAdvisor[it.advisorName] ??= { total: 0, count: 0 });
    a.total += it.amount ?? 0; a.count += 1;
  }
  return { total: items.reduce((n, i) => n + (i.amount ?? 0), 0), count: items.length, unknownCount: items.filter((i) => i.amount == null).length, byAdvisor, items };
}

async function compute() {
  const [links, chats] = await Promise.all([pendingFromLinks(), pendingFromChats()]);
  return { links, chats };
}

// Con caché de un minuto (el cálculo lee chats y puede tardar unos segundos); el filtro por línea se aplica después.
export async function getPendingPayments({ lineId = null } = {}) {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const promise = compute();
    cache = { at: Date.now(), promise };
    promise.catch(() => { if (cache?.promise === promise) cache = null; });
  }
  const { links, chats } = await cache.promise;
  return mergePending({ links, chats, lineId });
}

export const _clearPendingCacheForTests = () => { cache = null; };
