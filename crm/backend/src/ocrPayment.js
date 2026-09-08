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
export function receiptContainsAmount(ocrText, expectedAmount) {
  if (!ocrText || !Number.isFinite(expectedAmount)) return false;
  if (!RECEIPT_KEYWORDS.test(ocrText)) return false;
  const numbers = ocrText.match(/\d[\d.,]*/g) ?? [];
  return numbers.some((n) => parseAmount(n) === Math.round(expectedAmount));
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
