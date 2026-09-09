import { createWorker } from 'tesseract.js';
import { UPLOAD_DIR } from './attachmentStorage.js';

// Reads whatever text Tesseract can find in a receipt photo/screenshot. Runs against
// the same (already-compressed) buffer saved to disk — good enough for the clean
// screenshots this business mostly gets (Neolink, bank app receipts); a blurry phone
// photo of a printed slip may come back empty, which just means no auto-match below.
// cachePath reuses the same persistent uploads volume attachmentStorage.js already
// writes to — without it, Tesseract defaults to the process's cwd and re-downloads its
// ~3MB Spanish model on every container restart instead of once.
export async function extractText(buffer) {
  const worker = await createWorker('spa', 1, { cachePath: UPLOAD_DIR });
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
function matchesReceiptKeywords(ocrText, extraKeywords = []) {
  if (RECEIPT_KEYWORDS.test(ocrText)) return true;
  const lower = ocrText.toLowerCase();
  return extraKeywords.some((kw) => kw && lower.includes(kw.toLowerCase()));
}

// Parses a number as printed on a receipt, which is formatted either the US way
// (1,390.00 — comma thousands, dot decimal) or the way some Guatemalan bank apps print
// it (1.390,00 — dot thousands, comma decimal). Whichever separator appears LAST is the
// decimal point; any earlier one is a thousands separator and gets dropped.
function parseAmount(raw) {
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  const normalized = lastComma > lastDot
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
  return Math.round(parseFloat(normalized));
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
const MONTO_AMOUNT_RE = /(?:monto|por\s+un\s+valor\s+de)[^\d]{0,25}(\d[\d.,]*\d|\d)/i;
export function extractReceiptAmount(ocrText, extraKeywords = []) {
  if (!ocrText || !matchesReceiptKeywords(ocrText, extraKeywords)) return null;
  const labeled = ocrText.match(MONTO_AMOUNT_RE);
  if (labeled) return parseAmount(labeled[1]);
  // No explicit "Monto" label — prefer a number that looks like a currency amount (has
  // cents, e.g. "899.00" or "2,668.00") over a bare integer. Reference/audit/
  // authorization codes on a real receipt are usually long bare integers that would
  // otherwise swamp the actual total under a plain "biggest number wins" heuristic.
  const decimals = (ocrText.match(/\d[\d.,]*[.,]\d{2}\b/g) ?? []).map(parseAmount).filter((n) => Number.isFinite(n) && n > 0);
  if (decimals.length) return Math.max(...decimals);
  const numbers = (ocrText.match(/\d[\d.,]*/g) ?? []).map(parseAmount).filter((n) => Number.isFinite(n) && n > 0);
  return numbers.length ? Math.max(...numbers) : null;
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
