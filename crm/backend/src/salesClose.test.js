import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeClose, closeCutoff } from './salesClose.js';

const gt = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00-06:00`);
const row = (o) => ({ type: 'comprobante', verified: true, amountBasis: 'comprobante', advisor: 'Leydi', ...o });

test('pagado, por validar, sin confirmar y pendientes por asesora', () => {
  const r = summarizeClose({
    day: '2026-10-18', asOf: gt('18', '16:00').toISOString(),
    rows: [
      row({ at: gt('18', '10:00'), amount: 800 }),
      row({ at: gt('18', '11:00'), amount: 349.5, verified: false }), // comprobante sin confirmación todavía
      row({ at: gt('18', '12:00'), type: 'confirmacion', amount: 500, amountBasis: 'precio_aprobado' }),
      row({ at: gt('17', '12:00'), amount: 999 }), // otro día: no cuenta
      row({ at: gt('18', '13:00'), type: 'confirmacion', verified: false, amount: 400 }), // sin comprobante ni confirmación: no cuenta
    ],
    pending: [
      { advisor: 'Leydi', amount: 829, customerAccepted: true, customerReplied: true },
      { advisor: 'Leydi', amount: null, customerAccepted: false, customerReplied: true },
      { advisor: 'Leydi', amount: 300, customerAccepted: false, customerReplied: false }, // solo envió los medios
    ],
    sales: [{ created_at: gt('18', '10:05'), amount: 800, status: 'confirmada', advisor_name: 'Leydi' }, { created_at: gt('18', '17:00'), amount: 100, status: 'confirmada', advisor_name: 'Leydi' }],
  });
  const l = r.advisors.find((a) => a.advisor === 'Leydi');
  assert.equal(l.pagado, 1649.5);
  assert.equal(l.pagadoN, 3);
  assert.equal(l.porValidar, 500);
  assert.equal(l.sinConfirmarN, 1);
  assert.equal(l.pendienteN, 2);
  assert.equal(l.pendiente, 829);
  assert.equal(l.pendienteSinMontoN, 1);
  assert.equal(l.soloMediosN, 1);
  assert.equal(l.registrado, 800); // la venta de las 5 pm es posterior al corte de las 4 pm
  assert.equal(l.diferencia, 849.5);
});

test('hora de corte en Guatemala', () => {
  assert.equal(closeCutoff('2026-10-18', '16:00').toISOString(), '2026-10-18T22:00:59.999Z');
  assert.equal(closeCutoff('2026-10-17', null, new Date('2026-10-18T15:00:00Z')).toISOString(), '2026-10-18T05:59:59.999Z'); // fin del 17 en Guatemala
  assert.equal(closeCutoff('2026-10-18', null, new Date('2026-10-18T15:00:00Z')).toISOString(), '2026-10-18T15:00:00.000Z'); // hoy: ahora mismo
});
