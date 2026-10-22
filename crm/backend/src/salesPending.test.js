import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEpisodes } from './salesRules.js';

const gt = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00-06:00`);
let n = 0;
const adv = (at, advisor, text) => ({ id: ++n, at, role: 'advisor', advisor, text, ocrAmount: null });
const cust = (at, text = '', ocrAmount = null) => ({ id: ++n, at, role: 'customer', advisor: null, text, ocrAmount, image: ocrAmount != null });
const CONFIRMA = 'Gracias por elegir a STUDIO F! tu pedido ya esta en proceso de alistamiento';

test('venta pendiente: medios de pago entregados sin comprobante ni confirmación', () => {
  const eventos = [
    adv(gt('18', '11:55'), 'Leydi', 'Q749 HOY Q374'),
    adv(gt('18', '11:56'), 'Leydi', '¿Deseas llevarlo?'),
    cust(gt('18', '12:05'), 'Si lo quiero, transferencia'),
    adv(gt('18', '12:10'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/VEL1'),
  ];
  const r = buildEpisodes(eventos, { asOf: gt('18', '16:00') });
  assert.equal(r.episodes.length, 0);
  assert.equal(r.pending.advisor, 'Leydi');
  assert.equal(r.pending.medium, 'link');
  assert.equal(r.pending.amount, 374);
  assert.equal(r.pending.customerAccepted, true);
});

test('a las 4 pm era pendiente y al cierre de las 9 pm ya es una venta pagada', () => {
  const eventos = [
    adv(gt('18', '12:10'), 'Leydi', 'Total Q374. Cuenta Banrural 4012345678'),
    cust(gt('18', '17:30'), '', 374),
    adv(gt('18', '17:40'), 'Leydi', CONFIRMA),
  ];
  const a4pm = buildEpisodes(eventos.filter((e) => +new Date(e.at) <= +gt('18', '16:00')), { asOf: gt('18', '16:00') });
  assert.equal(a4pm.episodes.length, 0);
  assert.ok(a4pm.pending);
  const cierre = buildEpisodes(eventos, { asOf: gt('18', '21:00') });
  assert.equal(cierre.episodes.length, 1);
  assert.equal(cierre.episodes[0].amount, 374);
  assert.equal(cierre.pending, null);
});

test('medios de pago de hace más de 24 h no son una venta pendiente', () => {
  const eventos = [adv(gt('16', '10:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539')];
  assert.equal(buildEpisodes(eventos, { asOf: gt('18', '10:00') }).pending, null);
});

test('pendiente con varias prendas cotizadas por separado: lista cada cifra, también las repetidas (Joana: 449 + 449 + 412)', () => {
  const eventos = [
    adv(gt('19', '09:06'), 'Leydi', 'Q899 HOY Q449'),
    adv(gt('19', '09:07'), 'Leydi', 'Q899 HOY Q449'),
    adv(gt('19', '12:52'), 'Leydi', 'Q549 HOY Q412'),
    cust(gt('19', '12:55'), 'Si, transferencia'),
    adv(gt('19', '13:00'), 'Leydi', 'Cuenta Banrural 4012345678'),
  ];
  const { pending } = buildEpisodes(eventos, { asOf: gt('19', '21:00') });
  assert.deepEqual(pending.quotedAmounts, [449, 449, 412]);
  assert.equal(pending.quotedAmounts.reduce((a, b) => a + b, 0), 1310);
});

test('lista en vivo: los medios de pago de hace 2 días siguen pendientes con la ventana de 72 h, y no con la de 24 h', () => {
  const { PENDING_FRESH_MS } = { PENDING_FRESH_MS: 72 * 3600000 };
  const eventos = [adv(gt('18', '10:00'), 'Leydi', 'Total Q449. Cuenta Banrural 4012345678')];
  const ahora = gt('20', '09:00'); // 47 h después
  assert.equal(buildEpisodes(eventos, { asOf: ahora }).pending, null); // la regla de 24 h (cierres, atribución) no cambia
  const vivo = buildEpisodes(eventos, { asOf: ahora, pendingMs: PENDING_FRESH_MS });
  assert.equal(vivo.pending?.advisor, 'Leydi');
  assert.equal(vivo.pending?.amount, 449);
  assert.equal(buildEpisodes(eventos, { asOf: gt('21', '11:00'), pendingMs: PENDING_FRESH_MS }).pending, null); // 73 h: ya sale
});
