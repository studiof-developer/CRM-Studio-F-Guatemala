import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptContainsAmount, guessPaidMethod, extractReceiptAmount } from './ocrPayment.js';

test('matches a bare integer against a receipt printing cents', () => {
  assert.equal(receiptContainsAmount('MONTO (Q) 1,390.00', 1390), true);
});

test('matches with no thousands separator', () => {
  assert.equal(receiptContainsAmount('Comprobante de pago: Q899.00', 899), true);
});

test('does not match a different amount', () => {
  assert.equal(receiptContainsAmount('MONTO (Q) 1,240.00', 1390), false);
});

test('does not match with no numbers at all', () => {
  assert.equal(receiptContainsAmount('Gracias por tu compra', 899), false);
});

test('rejects missing text or amount', () => {
  assert.equal(receiptContainsAmount('', 899), false);
  assert.equal(receiptContainsAmount('Q899.00', NaN), false);
  assert.equal(receiptContainsAmount(null, 899), false);
});

test('guesses payment method from receipt keywords', () => {
  assert.equal(guessPaidMethod('DEPOSITO MONETARIO'), 'deposito');
  assert.equal(guessPaidMethod('Transferencia realizada'), 'transferencia');
  assert.equal(guessPaidMethod('Pago con tarjeta'), 'tarjeta');
  assert.equal(guessPaidMethod('Pago en efectivo'), 'efectivo');
});

test('guesses deposito from the accented form too', () => {
  assert.equal(guessPaidMethod('DEPÓSITO MONETARIO'), 'deposito');
});

test('matches Latin-American dot-thousands/comma-decimal formatting', () => {
  assert.equal(receiptContainsAmount('Monto a transferir Q2.486,00', 2486), true);
});

test('still matches plain US formatting alongside the new parser', () => {
  assert.equal(receiptContainsAmount('Monto a transferir Q2,486.00', 2486), true);
});

// The exact forgery this feature has to resist: a screenshot of the advisor's own
// price-quote message contains the right number but nothing that looks like a receipt.
test('rejects a bare number with no receipt-like context', () => {
  assert.equal(receiptContainsAmount('Tu total queda en Q899, cuando gustes', 899), false);
});

// The real Neolink receipt format (2026-09-05 report) — a customer split one order into
// two separate card payments, each receipt showing only its own partial amount, neither
// of which alone matches the full quoted total.
const NEOLINK_RECEIPT_1 = `Neolink BAGNERES ESTUDIO F AF. 009101006 Guatemala C.A. 05/09/2026 10:14
  Audit: No. 052554 Numero de referencia: 624810052554 AUT: xxxxxxxxxx
  No. Tarjeta: **** **** **** 4340 EXP: **/** Medio de pago: Contado
  Monto: (Q) 35.00 (01): pagado electronicamente COPIA CLIENTE Gracias por tu compra!`;
const NEOLINK_RECEIPT_2 = `Neolink BAGNERES ESTUDIO F AF. 009101006 Guatemala C.A. 05/09/2026 09:41
  Audit: No. 052552 Numero de referencia: 624809052552 AUT: xxxxxxxxxx
  No. Tarjeta: **** **** **** 4340 EXP: **/** Medio de pago: Contado
  Monto: (Q) 2,668.00 (01): pagado electronicamente COPIA CLIENTE Gracias por tu compra!`;

test('extracts the labeled Monto amount, not a reference/audit/card number', () => {
  assert.equal(extractReceiptAmount(NEOLINK_RECEIPT_1), 35);
  assert.equal(extractReceiptAmount(NEOLINK_RECEIPT_2), 2668);
});

test('extractReceiptAmount rejects text with no receipt vocabulary', () => {
  assert.equal(extractReceiptAmount('Tu total queda en Q899, cuando gustes'), null);
});

test('extractReceiptAmount falls back to the largest number when nothing is labeled Monto', () => {
  // No "monto" label at all — still recognized as a receipt via "referencia". The
  // reference code (12345) is a bigger bare number than the real amount, so this only
  // works if the fallback prefers a number with cents over a plain integer.
  assert.equal(extractReceiptAmount('Referencia: 12345 Total pagado Q899.00'), 899);
});

test('extractReceiptAmount fallback handles Latin-American dot-thousands formatting too', () => {
  // No "monto" label here either — anchored by "comprobante" instead, so this exercises
  // the same cents-over-bare-integer fallback as the test above, not the labeled path.
  assert.equal(extractReceiptAmount('Comprobante de pago. Referencia: 987654321. Q2.486,00 pagado.'), 2486);
});

test('guesses tarjeta from a Neolink card receipt', () => {
  assert.equal(guessPaidMethod(NEOLINK_RECEIPT_1), 'tarjeta');
});
