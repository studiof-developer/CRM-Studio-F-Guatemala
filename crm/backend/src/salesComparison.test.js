import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareWithRegistered } from './salesComparison.js';

const gt = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00-06:00`);
const eng = (o) => ({ customerId: 1, customer: 'Cliente', phone: '502', last4: '0001', verified: true, amountBasis: 'comprobante', issues: [], ...o });
const sale = (o) => ({ id: 1, customer_id: 1, status: 'confirmada', advisorCanonical: 'Aura', ...o });
const range = { from: '2026-10-17', to: '2026-10-18' };

test('coincide, monto distinto, solo en el chat y solo registrada', () => {
  const r = compareWithRegistered({
    ...range,
    engineRows: [
      eng({ customerId: 1, at: gt('17', '16:38'), amount: 349.5, advisor: 'Aura' }),
      eng({ customerId: 2, at: gt('17', '10:00'), amount: 510, advisor: 'Aura' }),
      eng({ customerId: 3, at: gt('18', '09:00'), amount: 800, advisor: 'Leydi' }),
    ],
    sales: [
      sale({ id: 1, customer_id: 1, created_at: gt('17', '16:40'), amount: 349.5 }),
      sale({ id: 2, customer_id: 2, created_at: gt('17', '10:30'), amount: 56 }),
      sale({ id: 9, customer_id: 9, created_at: gt('18', '12:00'), amount: 200, advisorCanonical: 'Leydi' }),
    ],
  });
  const by = (n) => r.items.filter((i) => i.status === n);
  assert.equal(by('coincide').length, 1);
  assert.deepEqual(by('con_diferencias')[0].diffs, ['monto']); // Q510 en el chat contra Q56 registrados
  assert.equal(by('solo_en_chat')[0].chatAmount, 800);
  assert.equal(by('solo_registrada')[0].saleId, 9);
});

test('totales por día: lo registrado, lo que dice el chat y la diferencia', () => {
  const r = compareWithRegistered({
    ...range,
    engineRows: [eng({ at: gt('17', '16:38'), amount: 349.5, advisor: 'Aura' }), eng({ customerId: 2, at: gt('17', '19:00'), amount: 100, advisor: 'Aura', verified: false })],
    sales: [sale({ created_at: gt('17', '16:40'), amount: 350 }), sale({ id: 2, customer_id: 5, created_at: gt('18', '08:00'), amount: 600, status: 'revisar' })],
  });
  const d17 = r.daily.find((d) => d.day === '2026-10-17');
  assert.equal(d17.registrado, 350);
  assert.equal(d17.chat, 349.5);
  assert.equal(d17.diferencia, -0.5);
  assert.equal(d17.pendientes, 100);
  assert.equal(r.daily.find((d) => d.day === '2026-10-18').revisar, 600);
  assert.equal(r.daily.length, 2);
});

test('la fecha cuenta en hora de Guatemala: 9 pm del 17 sigue siendo el 17', () => {
  const r = compareWithRegistered({ ...range, engineRows: [eng({ at: gt('17', '21:24'), amount: 734.3, advisor: 'Aura' })], sales: [] });
  assert.equal(r.items[0].day, '2026-10-17');
});
