import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptContainsAmount, guessPaidMethod } from './ocrPayment.js';

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
