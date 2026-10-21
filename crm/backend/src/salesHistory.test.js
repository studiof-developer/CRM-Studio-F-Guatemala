import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTotals, compareDay, listDays } from './salesHistory.js';

test('los días del rango, ambos extremos incluidos', () => {
  assert.deepEqual(listDays('2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(listDays('2026-10-01', '2026-10-19').length, 19);
  assert.deepEqual(listDays('2026-10-05', '2026-10-05'), ['2026-10-05']);
});

test('lo que dicen los chats: solo episodios verificados y con monto, por asesora', () => {
  const t = chatTotals([
    { type: 'comprobante', verified: true, amount: 829, expectedAdvisor: 'Leydi' },
    { type: 'comprobante', verified: true, amount: 500.5, expectedAdvisor: 'Leydi' },
    { type: 'confirmacion', verified: true, amount: 640, expectedAdvisor: 'Aura' },
    { type: 'comprobante', verified: false, amount: 900, expectedAdvisor: 'Aura' }, // sin confirmación de la asesora
    { type: 'comprobante', verified: true, amount: 0, expectedAdvisor: 'Aura' },
    { type: 'comprobante', verified: true, amount: 300, expectedAdvisor: null },
    { status: 'sin_evidencia', amount: 700 }, // venta registrada sin respaldo: no es un episodio del chat
  ]);
  assert.deepEqual(t.get('Leydi'), { total: 1329.5, count: 2 });
  assert.deepEqual(t.get('Aura'), { total: 640, count: 1 });
  assert.deepEqual(t.get('Sin Asignar'), { total: 300, count: 1 });
});

test('comparación del día: registrado contra chats, también cuando una asesora solo aparece de un lado', () => {
  const rows = compareDay(
    new Map([['Leydi', { total: 1575, count: 2 }], ['Aura', { total: 100, count: 1 }]]),
    new Map([['Leydi', { total: 2405, count: 3 }], ['Marisa', { total: 50, count: 1 }]])
  );
  assert.deepEqual(rows.map((r) => [r.name, r.registered, r.chat, r.diff]), [['Aura', 100, 0, -100], ['Leydi', 1575, 2405, 830], ['Marisa', 0, 50, 50]]);
});

test('retomar: los días ya completos se omiten y se sigue desde el primero que falta', async () => {
  const { splitDays } = await import('./salesHistory.js');
  const days = listDays('2026-10-01', '2026-10-05');
  assert.deepEqual(splitDays(days, ['2026-10-01', '2026-10-02', '2026-10-03']), { pending: ['2026-10-04', '2026-10-05'], skipped: ['2026-10-01', '2026-10-02', '2026-10-03'] });
  assert.deepEqual(splitDays(days, days).pending, []);
  assert.deepEqual(splitDays(days, ['2026-10-01'], true).pending, days); // --force: rehace todo
  assert.deepEqual(splitDays(days, []).pending, days);
});
