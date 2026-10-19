// Reglas puras (sin base de datos) del motor de ventas por asesora. Todo lo que decide
// "a quién se le acredita una venta, de qué día es y si es una compra nueva" vive aquí
// para poder probarlo con casos reales sin tocar Postgres.
//
// Regla de negocio (2026-10-18): la venta se acredita a la asesora que atendía al cliente
// hasta el momento en que le dio los medios de pago o el cliente envió su comprobante. La
// fecha y el monto salen del comprobante (o de la confirmación del asesor), nunca de la
// hora en que alguien abrió el chat o hizo clic después.
import { parseAmount } from './ocrPayment.js';

const GT_OFFSET_MS = -6 * 3600 * 1000; // Guatemala no tiene horario de verano

export const RETAIL_MIN = 50;
export const RETAIL_MAX = 10000;

// Mensajes de la asesora que confirman un pago ya recibido. Varios (alistamiento, "ya
// está en proceso") se escriben DESPUÉS de la venta, así que por sí solos nunca bastan
// para crear una venta nueva: ver startsNewCycle.
export const CONFIRMATION_PHRASES_REGEX = /\b(gracias\s+por\s+(su|tu)\s+compra|pago\s+(recibido|confirmado|verificado|acreditado)|comprobante\s+(recibido|verificado|confirmado)|pedido\s+(confirmado|registrado)|hemos\s+recibido\s+(su|tu)\s+pago|confirmamos\s+(su|tu)\s+pago|ya\s+qued[oó]\s+registrad[ao]|pago\s+con\s+[eé]xito|muchas\s+gracias\s+por\s+(su|tu)\s+pago|proceso\s+de\s+alistamiento|pedido\s+ya\s+est[aá]\s+en\s+proceso|agregado\s+a\s+la\s+compra)\b/i;

export function isConfirmationMessage(text) {
  if (!text || typeof text !== 'string') return false;
  return CONFIRMATION_PHRASES_REGEX.test(text.trim());
}

// Entregar medios de pago = dar datos concretos (cuenta, link, "puedes pagar por X").
// Preguntar "¿cómo quiere pagar?" NO cuenta, igual que en el trigger de Caliente.
const PAYMENT_INFO_RE = /(n[uú]mero\s+de\s+cuenta|cuenta\s+(monetaria|de\s+ahorros?|corriente)|\bcta\.?\s*(no\.?|#)?\s*\d|https?:\/\/|puedes?\s+pagar\s+(por|con)|a\s+nombre\s+de|banrural|banco\s+industrial|\bbac\b|neolink|\b\d{8,}\b)/i;

export function givesPaymentInfo(text) {
  return PAYMENT_INFO_RE.test(text ?? '');
}

const GENERIC_ADVISOR_NAMES = new Set(['', 'asesor', 'bot', 'sistema', 'automático', 'automatico']);

export function inRetailRange(n) {
  return Number.isFinite(n) && n >= RETAIL_MIN && n <= RETAIL_MAX;
}

// Un monto cotizado por la asesora en texto libre: "Total Q539", "son Q1,930", "Q 890".
export function quotedAmountIn(text) {
  const t = text ?? '';
  const amount = '(\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{2})?|\\d{2,5}(?:[.,]\\d{2})?)';
  const labeled = t.match(new RegExp(`(?:total|son|ser[ií]an|depositar|cancelar|pagar|queda\\s+(?:hoy\\s+)?en)[^\\d]{0,15}Q?\\.?\\s*${amount}`, 'i'));
  if (labeled) {
    const v = parseAmount(labeled[1]);
    if (inRetailRange(v)) return v;
  }
  const all = [...t.matchAll(new RegExp(`Q\\.?\\s*${amount}`, 'gi'))];
  if (all.length) {
    const v = parseAmount(all[all.length - 1][1]);
    if (inRetailRange(v)) return v;
  }
  return null;
}

export function guatemalaParts(date) {
  const g = new Date(new Date(date).getTime() + GT_OFFSET_MS);
  return { ymd: g.toISOString().slice(0, 10), hour: g.getUTCHours(), dow: g.getUTCDay() };
}

// Turnos reales: 8am–3pm y 3pm–9pm de lunes a sábado; el domingo atiende una sola persona.
export function shiftOf(date) {
  const { hour, dow } = guatemalaParts(date);
  if (hour < 8 || hour >= 21) return 'fuera_de_turno';
  if (dow === 0) return 'domingo';
  return hour < 15 ? 'manana' : 'tarde';
}

function sortedByTime(events) {
  return [...events].sort((a, b) => (+new Date(a.at) - +new Date(b.at)) || (Number(a.id) - Number(b.id)));
}

// events: [{ id, at, role: 'customer'|'advisor'|'bot', advisor, text, ocrAmount }]
// Orden de decisión: (1) quien dio los medios de pago más recientemente antes del pago,
// (2) si nadie los dio, quien escribió por última vez antes del pago, (3) si el cliente
// pagó fuera de horario, quien le respondió primero en las siguientes 2 h.
export function attributeAdvisor(events, atTime, { lookbackMs = 7 * 86400000, graceMs = 2 * 3600000 } = {}) {
  const t = +new Date(atTime);
  const advisorEvents = sortedByTime(events).filter(
    (e) => e.role === 'advisor' && e.advisor && !GENERIC_ADVISOR_NAMES.has(String(e.advisor).trim().toLowerCase())
  );
  const before = advisorEvents.filter((e) => +new Date(e.at) <= t && +new Date(e.at) >= t - lookbackMs);
  const gave = [...before].reverse().find((e) => givesPaymentInfo(e.text));
  if (gave) return { advisor: gave.advisor, rule: 'dio_medios_de_pago', eventId: gave.id };
  const last = before[before.length - 1];
  if (last) return { advisor: last.advisor, rule: 'ultimo_asesor_antes_del_pago', eventId: last.id };
  const after = advisorEvents.find((e) => +new Date(e.at) > t && +new Date(e.at) <= t + graceMs);
  if (after) return { advisor: after.advisor, rule: 'primer_asesor_despues_del_pago', eventId: after.id };
  return null;
}

// Última cotización que la asesora escribió entre dos instantes (sin contar mensajes de
// confirmación: "tu pedido de Q539 ya está en proceso" no es una cotización nueva).
export function latestQuote(events, after, before) {
  const a = after ? +new Date(after) : -Infinity;
  const b = +new Date(before);
  const candidates = sortedByTime(events).filter(
    (e) => e.role === 'advisor' && +new Date(e.at) > a && +new Date(e.at) <= b && !isConfirmationMessage(e.text)
  );
  for (let i = candidates.length - 1; i >= 0; i--) {
    const v = quotedAmountIn(candidates[i].text);
    if (v != null) return v;
  }
  return null;
}

// ¿Empezó un ciclo de compra nuevo desde la última venta del cliente? Solo si la asesora
// volvió a cotizar o a dar medios de pago. Sin eso, un "proceso de alistamiento" o un
// comprobante reenviado es seguimiento de la venta que ya existe, no una venta nueva.
export function startsNewCycle(events, lastSaleAt, atTime) {
  if (!lastSaleAt) return true;
  const a = +new Date(lastSaleAt);
  const b = +new Date(atTime);
  return events.some(
    (e) => e.role === 'advisor' && +new Date(e.at) > a && +new Date(e.at) <= b
      && !isConfirmationMessage(e.text)
      && (quotedAmountIn(e.text) != null || givesPaymentInfo(e.text))
  );
}

// Un comprobante con el mismo monto que una venta de los últimos 3 días, sin una
// cotización nueva desde la ÚLTIMA venta, es ese mismo pago reenviado por la clienta. La
// referencia es la última venta (no la que coincide en monto): una cotización que ya se
// convirtió en otra venta no vuelve a contar como "compra nueva".
export function isResentReceipt({ amount, recentSales = [], events, atTime }) {
  const inWindow = recentSales.filter((s) => {
    const ageMs = +new Date(atTime) - +new Date(s.at);
    return ageMs >= 0 && ageMs <= 3 * 86400000;
  });
  if (!inWindow.some((s) => Math.abs(Number(s.amount) - Number(amount)) < 0.5)) return false;
  const latestAt = new Date(Math.max(...inWindow.map((s) => +new Date(s.at))));
  return !startsNewCycle(events, latestAt, atTime);
}
