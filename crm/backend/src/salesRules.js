// Reglas puras (sin base de datos) del motor de ventas por asesora. Todo lo que decide
// "a quién se le acredita una venta, de qué día es y si es una compra nueva" vive aquí
// para poder probarlo con casos reales sin tocar Postgres.
//
// Regla de negocio (2026-10-18): la venta se acredita a la asesora que atendía al cliente
// hasta el momento en que le dio los medios de pago o el cliente envió su comprobante. La
// fecha y el monto salen del comprobante (o de la confirmación del asesor), nunca de la
// hora en que alguien abrió el chat o hizo clic después.
import { parseAmountExact as parseAmount } from './ocrPayment.js';

const GT_OFFSET_MS = -6 * 3600 * 1000; // Guatemala no tiene horario de verano

export const RETAIL_MIN = 50;
export const RETAIL_MAX = 10000;

// Mensajes de la asesora que confirman un pago ya recibido. Varios (alistamiento, "ya
// está en proceso") se escriben DESPUÉS de la venta, así que por sí solos nunca bastan
// para crear una venta nueva: ver startsNewCycle.
export const CONFIRMATION_PHRASES_REGEX = /\b(gracias\s+por\s+(su|tu)\s+compra|pago\s+(recibido|confirmado|verificado|acreditado)|comprobante\s+(recibido|verificado|confirmado)|pedido\s+(confirmado|registrado)|hemos\s+recibido\s+(su|tu)\s+pago|confirmamos\s+(su|tu)\s+pago|ya\s+qued[oó]\s+registrad[ao]|pago\s+con\s+[eé]xito|muchas\s+gracias\s+por\s+(su|tu)\s+pago|gracias\s+por\s+elegir\s+a\s+studio\s*f|proceso\s+de\s+alistamiento|pedido\s+ya\s+est[aá]\s+en\s+proceso|agregado\s+a\s+la\s+compra)\b/i;

export function isConfirmationMessage(text) {
  if (!text || typeof text !== 'string') return false;
  return CONFIRMATION_PHRASES_REGEX.test(text.trim());
}

// Entregar medios de pago = dar datos concretos (cuenta, link, "puedes pagar por X").
// Preguntar "¿cómo quiere pagar?" NO cuenta, igual que en el trigger de Caliente.
const PAYMENT_INFO_RE = /(n[uú]mero\s+de\s+cuenta|cuenta\s+(monetaria|de\s+ahorros?|corriente)|\bcta\.?\s*(no\.?|#)?\s*\d|https?:\/\/|puedes?\s+pagar\s+(por|con)|a\s+nombre\s+de|banrural|banco\s+industrial|\bbac\b|neolink|\b\d{8,}\b|\[medios-de-pago\])/i;

// Imagen que la asesora manda con los medios de pago (la tarjeta "MEDIOS DE PAGO" con las cuentas): no trae texto en
// el chat, así que se reconoce por lo que dice la imagen (OCR) y se marca con [medios-de-pago] en el texto del evento.
const PAYMENT_IMAGE_RE = /(medios\s+de\s+pago|n[uú]mero\s+de\s+cuenta|cuenta\s+monetaria|banrural|banco\s+industrial|\bbac\b|credomatic)/i;
export const PAYMENT_IMAGE_MARKER = '[medios-de-pago]';
export function isPaymentInfoImageText(ocrText) {
  return PAYMENT_IMAGE_RE.test(ocrText ?? '');
}

export function givesPaymentInfo(text) {
  return PAYMENT_INFO_RE.test(text ?? '');
}

const GENERIC_ADVISOR_NAMES = new Set(['', 'asesor', 'bot', 'sistema', 'automático', 'automatico']);

export function inRetailRange(n) {
  return Number.isFinite(n) && n >= RETAIL_MIN && n <= RETAIL_MAX;
}

// El cliente acepta lo cotizado ("quiero el jean talla 8", "listo", "pásame el link").
const ACCEPT_RE = /(\bquiero\b|\bme\s+(lo|la|los|las)\s+(llevo|quedo)\b|\bs[ií]\b|\bdale\b|\blisto\b|\bperfecto\b|\bde\s+acuerdo\b|\best[aá]\s+bien\b|\bok(ay)?\b|\bconfirmo\b|\bprocedamos\b|\benv[ií]a(me)?\s+(el\s+)?(link|enlace|cuenta|datos)|\bp[aá]same\s+(el\s+)?(link|enlace|cuenta)|\bc[oó]mo\s+(pago|cancelo|hago\s+el\s+pago)\b)/i;

export function acceptsOffer(text) {
  const t = text ?? '';
  if (/\bno\s+(lo\s+|la\s+|los\s+|las\s+)?(quiero|me\s+(lo|la)\s+(llevo|quedo))\b/i.test(t)) return false;
  return ACCEPT_RE.test(t);
}

// Un monto cotizado por la asesora en texto libre: "Total Q539", "son Q1,930", "Q 890".
export function quotedAmountIn(text) {
  // El mensaje de la cotización trae "Total a pagar (3 prendas): Q2297.00" y, a veces, "¡Te ahorras Q152.83!" después: el
  // número entre paréntesis no es el monto y lo ahorrado no es el total.
  const t = String(text ?? '').replace(/\(\s*\d+\s*prendas?\s*\)/gi, '').split(/ahorras/i)[0];
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

// El cliente a veces pega el SMS/correo del banco en vez de mandar una foto ("Se realizó una
// compra con tu tarjeta de débito por Q539.00 ..."). Solo cuenta si el texto trae
// vocabulario de confirmación bancaria Y un monto; "ya hice la transferencia" no es prueba.
const BANK_TEXT_RE = /(se\s+realiz[oó]\s+(una\s+)?(compra|transferencia|pago|dep[oó]sito)|compra\s+con\s+(tu\s+)?tarjeta|transferencia\s+(realizada|exitosa|enviada)|dep[oó]sito\s+(realizado|exitoso)|pago\s+(exitoso|aprobado|realizado)|comprobante\s+de\s+(pago|transferencia|dep[oó]sito))/i;
export function receiptAmountInText(text) {
  const t = text ?? '';
  if (!BANK_TEXT_RE.test(t)) return null;
  const m = t.match(/(?:por|monto|valor|total)\s*(?:de\s*)?Q\.?\s*(\d[\d.,]*\d|\d)/i) ?? t.match(/Q\.?\s*(\d[\d.,]*\d|\d)/i);
  if (!m) return null;
  const v = parseAmount(m[1]);
  return inRetailRange(v) ? v : null;
}

export function guatemalaParts(date) {
  const g = new Date(new Date(date).getTime() + GT_OFFSET_MS);
  return { ymd: g.toISOString().slice(0, 10), hour: g.getUTCHours(), minute: g.getUTCMinutes(), dow: g.getUTCDay() };
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
// Medios de pago "recientes": una cuenta o link enviado hace días (de una compra que no se cerró)
// no hace dueña de la venta a quien lo mandó si otra asesora fue quien atendió al cliente al pagar.
export const PAYINFO_FRESH_MS = 24 * 3600000;

const isSeller = (name) => { const n = String(name ?? '').trim().toLowerCase(); return !!n && !GENERIC_ADVISOR_NAMES.has(n); };

// Si una asesora escribió al menos el doble de mensajes que cualquier otra en la compra (y 3 o más), la atendió ella aunque otra haya
// mandado los medios de pago o confirmado: la venta es suya.
const MAJORITY_MIN_MESSAGES = 3;
function majorityAdvisor(before) {
  const counts = new Map();
  for (const e of before) counts.set(e.advisor, (counts.get(e.advisor) ?? 0) + 1);
  const [top, second] = [...counts].sort((a, b) => b[1] - a[1]);
  if (!top || top[1] < MAJORITY_MIN_MESSAGES || top[1] < 2 * (second?.[1] ?? 0)) return null;
  return [...before].reverse().find((e) => e.advisor === top[0]);
}

export function attributeAdvisor(events, atTime, { lookbackMs = 7 * 86400000, graceMs = 2 * 3600000, freshMs = PAYINFO_FRESH_MS } = {}) {
  const t = +new Date(atTime);
  const advisorEvents = sortedByTime(events).filter((e) => e.role === 'advisor' && isSeller(e.advisor));
  const before = advisorEvents.filter((e) => +new Date(e.at) <= t && +new Date(e.at) >= t - lookbackMs);
  const gave = [...before].reverse().find((e) => +new Date(e.at) >= t - freshMs && givesPaymentInfo(e.text));
  const last = before[before.length - 1];
  const by = gave ?? last;
  const most = majorityAdvisor(before);
  if (most && most.advisor !== by?.advisor) return { advisor: most.advisor, rule: 'mayor_atencion', eventId: most.id };
  if (gave) return { advisor: gave.advisor, rule: 'dio_medios_de_pago', eventId: gave.id };
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

// El precio de una venta cuando NO hay comprobante con monto (típico del pago por link: la
// pantalla de NeoLink no lo muestra): el último precio que el cliente aprobó. Una cotización
// cuenta como aprobada si el cliente la aceptó después, o si la asesora le dio los medios de pago
// después (se emite el link/cuenta para un total ya acordado). Si el cliente pide algo más, la
// asesora vuelve a cotizar y manda la última cotización aprobada. Si ninguna está aprobada se
// usa la última dicha, marcada como no aprobada explícitamente.
export function approvedQuote(events, after, before) {
  const a = after ? +new Date(after) : -Infinity;
  const b = +new Date(before);
  const inCycle = sortedByTime(events).filter((e) => +new Date(e.at) > a && +new Date(e.at) <= b);
  const quotes = inCycle
    .filter((e) => e.role === 'advisor' && !isConfirmationMessage(e.text))
    .map((e) => ({ at: e.at, amount: quotedAmountIn(e.text) }))
    .filter((q) => q.amount != null);
  if (!quotes.length) return null;
  const approved = (q) => inCycle.some((e) => +new Date(e.at) > +new Date(q.at) && (
    (e.role === 'customer' && acceptsOffer(e.text)) || (e.role === 'advisor' && givesPaymentInfo(e.text))
  ));
  for (let i = quotes.length - 1; i >= 0; i--) {
    if (approved(quotes[i])) return { amount: quotes[i].amount, at: quotes[i].at, approved: true };
  }
  const last = quotes[quotes.length - 1];
  return { amount: last.amount, at: last.at, approved: false };
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

// --- Reconstrucción de las ventas de UN hilo completo (análisis histórico) ---------------

// 'link' = pago con tarjeta por enlace (NeoLink); 'transferencia' = cuenta bancaria.
export function paymentMedium(text) {
  if (/https?:\/\/|neolink/i.test(text ?? '')) return 'link';
  if (givesPaymentInfo(text)) return 'transferencia';
  return null;
}

const DAY_MS = 86400000;

// Una venta (episodio) sigue SIEMPRE este orden dentro del chat, y solo cuenta lo que lo respeta:
//   1. la asesora entrega los medios de pago (cuenta o link);
//   2. DESPUÉS de eso el cliente manda su prueba: foto/PDF con monto leído, voucher, o el
//      texto del banco. Lo que manda antes de recibir los medios de pago es otra cosa
//      (una referencia, un comprobante viejo) y no es prueba de esta compra;
//   3. la asesora verifica y confirma ("Gracias por elegir a STUDIO F, tu pedido ya está en
//      proceso de alistamiento"). Eso es lo que da por pagada la venta al 100%.
// Una prueba sin confirmación queda como "pendiente_de_confirmar" (no suma a lo verificado)
// y una prueba sin medios de pago ni confirmación se descarta como "orphan" (sin contexto).
// events: ordenados o no; los del cliente traen ocrAmount (foto/PDF/texto con monto) y/o
// voucher:true (comprobante reconocido sin monto) e image:true (adjunto sin monto leído).
export function buildEpisodes(events, { lookbackMs = 7 * DAY_MS, asOf = null } = {}) {
  const sorted = sortedByTime(events);
  const episodes = [];
  const orphans = [];
  let resent = 0;

  const describe = (anchor, type, amount) => {
    const prevAt = episodes.length ? +new Date(episodes[episodes.length - 1].at) : null;
    const t = +new Date(anchor.at);
    const windowStart = prevAt ?? t - lookbackMs;
    const cycle = sorted.filter((e) => +new Date(e.at) > windowStart && +new Date(e.at) <= t);
    const payInfo = [...cycle].reverse().find((e) => e.role === 'advisor' && +new Date(e.at) >= t - PAYINFO_FRESH_MS && givesPaymentInfo(e.text));
    // Quién la atendía se decide con lo ocurrido desde la venta anterior; solo si ahí no hay
    // nadie se recurre a todo el historial reciente.
    const attribution = attributeAdvisor(cycle, anchor.at) ?? attributeAdvisor(sorted, anchor.at);
    const touched = [...new Set(cycle.filter((e) => e.role === 'advisor' && isSeller(e.advisor)).map((e) => e.advisor))];
    const quote = latestQuote(sorted, prevAt, anchor.at);
    const approvedPrice = approvedQuote(sorted, prevAt, anchor.at);
    const proof = cycle.filter((e) => e.role === 'customer');
    const imagesWithoutAmount = proof.filter((e) => e.image && !e.ocrAmount).length;
    const voucher = proof.some((e) => e.voucher);
    // Montos distintos que la asesora cotizó en las últimas 48 h: si el cliente se lleva varias prendas y no hay
    // comprobante, el total no está en el chat y se muestra cada cifra para que un supervisor decida.
    const quotedAmounts = [...new Set(cycle.filter((e) => e.role === 'advisor' && +new Date(e.at) >= t - 2 * DAY_MS).map((e) => quotedAmountIn(e.text)).filter((v) => v != null))].slice(-6);
    const issues = [];
    if (!payInfo) issues.push('sin_medios_de_pago_en_chat');
    if (type === 'confirmacion' && quotedAmounts.length > 1) issues.push('varias_cotizaciones');
    if (amount == null) issues.push('monto_no_leido');
    if (type === 'confirmacion' && amount != null) issues.push('monto_por_validar');
    if (type === 'confirmacion' && approvedPrice && !approvedPrice.approved) issues.push('precio_sin_aprobacion_del_cliente');
    if (amount != null && quote != null && Math.abs(amount - quote) >= 0.5) issues.push('monto_distinto_a_cotizacion');
    if (touched.length > 1) issues.push('varias_asesoras');
    // Dos asesoras distintas dieron medios de pago en esta compra (ej. el link de la mañana y la tarjeta de la tarde): se
    // acredita a la última, pero queda por validar. Si solo una los dio, la venta es suya aunque otra reciba el comprobante.
    const handoff = !!payInfo && cycle.some((e) => e.role === 'advisor' && isSeller(e.advisor) && e.advisor !== payInfo.advisor && +new Date(e.at) >= t - PAYINFO_FRESH_MS && givesPaymentInfo(e.text));
    if (handoff) issues.push('asesora_por_validar');
    if (!attribution) issues.push('sin_asesora');
    if (type === 'confirmacion' && !voucher && !proof.some((e) => e.image || e.ocrAmount)) issues.push('sin_prueba_del_cliente');
    return {
      type, at: anchor.at, eventId: anchor.id, amount, quote, via: anchor.via ?? null,
      // Cómo se obtuvo el monto: leído de un documento (imagen/PDF/texto del banco) o inferido del precio aprobado.
      amountBasis: amount == null ? null : (type === 'comprobante' ? 'comprobante' : 'precio_aprobado'),
      priceApprovedByCustomer: type === 'confirmacion' ? (approvedPrice?.approved ?? null) : null,
      advisor: attribution?.advisor ?? null, rule: attribution?.rule ?? null, attributionUncertain: handoff, quotedAmounts,
      paymentInfoBy: payInfo?.advisor ?? null, paymentInfoAt: payInfo?.at ?? null,
      medium: payInfo ? paymentMedium(payInfo.text) : null, voucher,
      touchedBy: touched, shift: shiftOf(anchor.at), imagesWithoutAmount, issues,
    };
  };

  for (const e of sorted) {
    const last = episodes[episodes.length - 1];
    if (e.role === 'customer' && inRetailRange(e.ocrAmount)) {
      // La asesora ya había confirmado antes de que llegara la prueba: es la misma venta y la
      // prueba es la cifra real.
      if (last && last.type === 'confirmacion' && +new Date(e.at) - +new Date(last.at) <= 2 * DAY_MS) {
        episodes.pop();
        episodes.push({ ...describe(e, 'comprobante', e.ocrAmount), confirmedAt: last.at, confirmedBy: last.confirmedBy });
        continue;
      }
      const recent = episodes.filter((x) => x.amount).map((x) => ({ at: x.at, amount: x.amount }));
      if (isResentReceipt({ amount: e.ocrAmount, recentSales: recent, events: sorted, atTime: e.at })) { resent++; continue; }
      const ep = describe(e, 'comprobante', e.ocrAmount);
      ep.provisional = !ep.paymentInfoAt; // sin medios de pago antes: solo vale si la asesora lo confirma después
      episodes.push(ep);
    } else if (e.role === 'advisor' && isConfirmationMessage(e.text)) {
      // Verifica una prueba que llegó antes (hasta 7 días): no es otra venta.
      if (last && !last.confirmedAt && last.type === 'comprobante' && +new Date(e.at) - +new Date(last.at) <= 7 * DAY_MS) {
        last.confirmedAt = e.at;
        last.confirmedBy = e.advisor;
        continue;
      }
      if (startsNewCycle(sorted, last?.at ?? null, e.at)) {
        const ep = describe(e, 'confirmacion', approvedQuote(sorted, last?.at ?? null, e.at)?.amount ?? null);
        ep.confirmedAt = e.at;
        ep.confirmedBy = e.advisor;
        episodes.push(ep);
      }
    }
  }

  const kept = [];
  for (const ep of episodes) {
    if (ep.provisional && !ep.confirmedAt) { orphans.push({ at: ep.at, amount: ep.amount, eventId: ep.eventId }); continue; }
    delete ep.provisional;
    ep.verified = !!ep.confirmedAt;
    ep.status = ep.verified ? 'verificada' : 'pendiente_de_confirmar';
    kept.push(ep);
  }
  return { episodes: kept, resentReceipts: resent, orphanReceipts: orphans, pending: findPending(sorted, kept, asOf) };
}

// Venta PENDIENTE: la asesora entregó los medios de pago hace menos de 24 h y desde entonces no hay comprobante ni
// confirmación. Es lo que las asesoras anotan como venta (link enviado) y todavía no está pagado. `asOf` es el corte:
// el llamador ya recortó los eventos a esa hora; sin él se usa el último mensaje del hilo.
function findPending(sorted, episodes, asOf) {
  if (!sorted.length) return null;
  const cutoff = asOf ? +new Date(asOf) : +new Date(sorted[sorted.length - 1].at);
  const lastDone = episodes.reduce((m, ep) => Math.max(m, +new Date(ep.at), ep.confirmedAt ? +new Date(ep.confirmedAt) : 0), 0);
  const payInfo = [...sorted].reverse().find((e) => e.role === 'advisor' && +new Date(e.at) <= cutoff
    && cutoff - +new Date(e.at) <= PAYINFO_FRESH_MS && givesPaymentInfo(e.text));
  if (!payInfo || +new Date(payInfo.at) <= lastDone) return null;
  const since = lastDone || null;
  const price = approvedQuote(sorted, since, payInfo.at);
  const cycle = sorted.filter((e) => +new Date(e.at) > lastDone && +new Date(e.at) <= +new Date(payInfo.at));
  const quotedAmounts = cycle.filter((e) => e.role === 'advisor').map((e) => quotedAmountIn(e.text)).filter((v) => v != null).slice(-8);
  const quotedAt = price?.at ? +new Date(price.at) : null;
  // el último total que la asesora dijo DESPUÉS de entregar los medios de pago ("Total Q1.576, por favor mándeme el comprobante"):
  // si lo hay, es el monto que se espera cobrar
  const quotedAfter = sorted.filter((e) => e.role === 'advisor' && +new Date(e.at) > +new Date(payInfo.at) && +new Date(e.at) <= cutoff && !isConfirmationMessage(e.text))
    .map((e) => quotedAmountIn(e.text)).filter((v) => v != null).pop() ?? null;
  return {
    at: payInfo.at, eventId: payInfo.id, advisor: payInfo.advisor, medium: paymentMedium(payInfo.text),
    amount: price?.amount ?? null, quotedAfter, quotedAmounts,
    // "intención": el cliente aceptó explícitamente una cotización antes de recibir los medios de pago
    customerAccepted: quotedAt != null && cycle.some((e) => e.role === 'customer' && +new Date(e.at) > quotedAt && acceptsOffer(e.text)),
    customerReplied: sorted.some((e) => e.role === 'customer' && +new Date(e.at) > +new Date(payInfo.at) && +new Date(e.at) <= cutoff),
  };
}
