import { createWorker } from 'tesseract.js';
import { UPLOAD_DIR } from './attachmentStorage.js';

// Reads whatever text Tesseract can find in a receipt photo/screenshot. Runs against
// the same (already-compressed) buffer saved to disk — good enough for the clean
// screenshots this business mostly gets (Neolink, bank app receipts); a blurry phone
// photo of a printed slip may come back empty, which just means no auto-match below.
// cachePath reuses the same persistent uploads volume attachmentStorage.js already
// writes to — without it, Tesseract defaults to the process's cwd and re-downloads its
// ~3MB Spanish model on every container restart instead of once.
export const tesseractErrorHandler = (err) => console.error('tesseract worker error:', String(err).slice(0, 200));

export async function extractText(buffer) {
  const worker = await createWorker('spa', 1, { cachePath: UPLOAD_DIR, errorHandler: tesseractErrorHandler });
  try {
    const { data } = await worker.recognize(buffer);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

// A real receipt/transfer confirmation carries structural bank vocabulary that an
// ordinary sales chat message doesn't — "cuenta", "referencia", "autorización",
// "monto" (a receipt's own word for the total, distinct from how a person actually
// talks). Deliberately excludes generic words like "pago"/"total"/"transferencia" as
// nouns/verbs on their own: an advisor's normal quote ("tu total es Q899", "cómo vas a
// pagar", "puedes pagar por transferencia") already contains those, so using them here
// would let a screenshot of the advisor's OWN message pass as a receipt. Doesn't fully
// stop a determined customer from forging one (see the OCR security review,
// 2026-09-08) — it closes the trivial "any image with the right digits in it" case,
// not every case.
const RECEIPT_KEYWORDS = /(monto|cuenta|referencia|autorizaci[oó]n|recib[oí]|comprobante|dep[oó]sito|conforme|banrural|neolink)/i;

// Admin-added extra receipt vocabulary (Configuración > Detección) — a new bank/gateway
// showing up in receipts that don't match anything above (its name, a phrase its
// confirmation screen uses). Plain substring match, not regex — an admin typing a phrase
// here can't accidentally write a broken or overly-broad pattern the way editing the
// fixed regex above could.
// Pantallas de la pasarela que muestran la compra y el monto pero NO son un pago hecho: el código de verificación (OTP) que pide el banco, o
// el aviso de transacción rechazada. Traen "neolink" en la dirección y el monto de la compra, así que pasaban por comprobante.
const NOT_A_PAYMENT = /(est[aá]s|estas)\s+autorizando\s+la\s+compra|ingresa\s+el\s+c[oó]digo\s+de\s+verificaci[oó]n|m[aá]ximo\s+de\s+solicitudes|autorice\s+la\s+transacci[oó]n|(transacci[oó]n|pago|compra|tarjeta)\s+(fue\s+|ha\s+sido\s+)?(rechazad|declinad|denegad|fallid)|\bAUTENTICAR\b/i;
export const looksRejected = (ocrText) => NOT_A_PAYMENT.test(ocrText ?? '');

function matchesReceiptKeywords(ocrText, extraKeywords = []) {
  if (looksRejected(ocrText)) return false;
  if (RECEIPT_KEYWORDS.test(ocrText)) return true;
  const lower = ocrText.toLowerCase();
  return extraKeywords.some((kw) => kw && lower.includes(kw.toLowerCase()));
}

// Parses a number as printed on a receipt OR typed by an advisor in chat, formatted
// either the US way (1,390.00 — comma thousands, dot decimal), the way some Guatemalan
// bank apps print it (1.390,00 — dot thousands, comma decimal), or as a bare
// thousands-grouped whole number with no cents at all (an advisor typing "Q4.034" or
// "Q4,034" to mean four thousand thirty-four — 2026-09-10 report: this last case wasn't
// handled at all and silently parsed as ~4.03). Exactly 3 digits after the LAST
// separator is the tell for that case — real cents are always 2 digits — so it strips
// every separator instead of treating the last one as a decimal point. Otherwise,
// whichever separator appears LAST is the decimal point; any earlier one is a
// thousands separator and gets dropped.
function parseAmountCore(raw) {
  // Callers pass whole regex matches like "Q2.486,00"; a leading "Q"/"Q." made parseFloat
  // return NaN, which silently dropped every unlabeled Q-prefixed amount.
  raw = String(raw).replace(/^[^\d]+/, '');
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);
  if (lastSep !== -1 && raw.length - lastSep - 1 === 3) {
    return parseFloat(raw.replace(/[.,]/g, ''));
  }
  const normalized = lastComma > lastDot
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
  return parseFloat(normalized);
}

// Para comparar contra lo cotizado (que se escribe en quetzales enteros).
export function parseAmount(raw) {
  return Math.round(parseAmountCore(raw));
}

// Para guardar lo que dice un comprobante: con centavos (Q349.50 no es Q350). Una venta se
// verifica contra lo realmente depositado.
export function parseAmountExact(raw) {
  return Math.round(parseAmountCore(raw) * 100) / 100;
}

// Whether the amount the advisor quoted in chat shows up anywhere in the receipt's
// OCR text. Loose on formatting (commas, dots, a trailing ".00" — a bank slip prints
// cents, the advisor's "Q899" in chat never does) but strict on the number itself: this
// gates an irreversible "mark as Paid", so a near-miss must not count as a match.
export function receiptContainsAmount(ocrText, expectedAmount, extraKeywords = []) {
  if (!ocrText || !Number.isFinite(expectedAmount)) return false;
  if (!matchesReceiptKeywords(ocrText, extraKeywords)) return false;
  const numbers = ocrText.match(/\d[\d.,]*/g) ?? [];
  return numbers.some((n) => parseAmount(n) === Math.round(expectedAmount));
}

// The one number a receipt itself calls out as the amount — not "any number on the
// page" (a receipt is full of dates, masked card digits, reference/audit numbers that
// would collide with that approach). Prefers the value printed right after "Monto"
// (Neolink, most bank apps) or "Por un valor de" (a Banrural teller deposit slip,
// 2026-09-10 report — no "Monto" label at all, just this phrase); falls back to the
// largest number on the page for a format that doesn't label it, since an amount is
// more often the biggest figure than a reference/card/date fragment is. Used for the
// case a single receipt's total quote doesn't match on its own — a customer who split
// one payment across two transactions (attachments.js sums recent receipts by phone
// before giving up on that order).
const MONTO_AMOUNT_RE = /(?:monto|por\s+un\s+valor\s+de|total|importe|valor)[^\d]{0,25}(?:Q\.?\s*)?(\d[\d.,]*\d|\d)/i;
export function extractReceiptAmount(ocrText, extraKeywords = []) {
  if (!ocrText || !matchesReceiptKeywords(ocrText, extraKeywords)) return null;
  const labeled = ocrText.match(MONTO_AMOUNT_RE);
  if (labeled) {
    const val = parseAmountExact(labeled[1]);
    if (val > 0 && val <= 10000) return val;
  }
  // No explicit "Monto" label — prefer numbers with decimals or preceded by Q.
  // Cap at 10,000 Q (retail limit) to avoid mistaking bank authorization codes
  // (e.g. 91161), account numbers or document references for amounts.
  const decimals = (ocrText.match(/(?:Q\.?\s*)?\d[\d.,]*[.,]\d{2}\b/g) ?? [])
    .map(parseAmountExact)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 10000);
  if (decimals.length) return Math.max(...decimals);

  const qNumbers = (ocrText.match(/Q\.?\s*\d[\d.,]*/gi) ?? [])
    .map(parseAmountExact)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 10000);
  return qNumbers.length ? Math.max(...qNumbers) : null;
}

// Same bare keyword match db/init/032's SQL trigger already uses for the same
// question — kept consistent rather than inventing a second way to guess this.
// dep[oó]sito (not a plain "deposit") matches Guatemalan receipts that print the
// accented "DEPÓSITO" as well as the unaccented form banks also use.
export function guessPaidMethod(ocrText) {
  if (/transfer/i.test(ocrText)) return 'transferencia';
  if (/dep[oó]sito/i.test(ocrText)) return 'deposito';
  if (/efectivo/i.test(ocrText)) return 'efectivo';
  if (/tarjeta/i.test(ocrText)) return 'tarjeta';
  return 'transferencia';
}
