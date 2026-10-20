import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paceStatus, buildGoalRows, monthClock } from './salesGoals.js';
import { aggregateItems } from './salesItems.js';

test('ritmo contra la meta del mes', () => {
  // día 10 de 31: lo esperado es 77,500 × 10/31 = 25,000
  const base = { goal: 77500, day: 10, days: 31 };
  assert.equal(Math.round(paceStatus({ ...base, total: 25000 }).expected), 25000);
  assert.equal(paceStatus({ ...base, total: 30000 }).status, 'ahead');
  assert.equal(paceStatus({ ...base, total: 24000 }).status, 'on_track');
  assert.equal(paceStatus({ ...base, total: 15000 }).status, 'behind');
  assert.equal(paceStatus({ ...base, total: 80000 }).status, 'met');
  const p = paceStatus({ ...base, total: 31000 });
  assert.equal(Math.round(p.projected), 96100); // 31,000 por día 10 llevado a 31 días
  assert.equal(Math.round(p.pct), 40);
  assert.equal(p.remaining, 46500);
});

test('filas de la meta: asesoras de la línea, quien vendió y ventas sin asesora', () => {
  const r = buildGoalRows({
    advisors: [{ name: 'Leydi Laura Mosquera' }, { name: 'Aura Pérez' }],
    totals: [{ name: 'leydi laura mosquera', total: '1575.00', count: 2 }, { name: 'Mauricio Rodriguez', total: '500', count: 1 }, { name: 'Sin Asignar', total: '300', count: 1 }],
    goal: 77500, day: 20, days: 31,
  });
  assert.deepEqual(r.advisors.map((a) => [a.name, a.total]), [['Leydi Laura Mosquera', 1575], ['Mauricio Rodriguez', 500], ['Aura Pérez', 0]]);
  assert.equal(r.unassigned, 300);
  assert.equal(r.team.total, 2075);
  assert.equal(r.team.goal, 77500 * 3); // la meta del equipo es la suma de las individuales
});

test('reloj del mes en hora de Guatemala', () => {
  assert.deepEqual(monthClock(new Date('2026-10-21T03:00:00Z')), { month: '2026-10', day: 20, days: 31 }); // 9 pm del 20 en Guatemala
  assert.deepEqual(monthClock(new Date('2026-02-28T20:00:00Z')), { month: '2026-02', day: 28, days: 28 });
});

test('prendas vendidas por referencia, con tallas y ventas sin cotización', () => {
  const row = (sale_id, o = {}) => ({ sale_id, amount: 500, quote_id: 1, grand_total: 500, sku: 'S741228B', name: 'Blusa', size: 'm', quantity: 1, final_price: 250, ...o });
  const r = aggregateItems([
    row(1), row(1, { sku: 'S085061A', name: 'Pantalón', size: 'L' }),
    row(2, { size: 'S', quantity: 2, final_price: 200, grand_total: 400, amount: 400 }),
    row(3, { quote_id: null, grand_total: null, sku: null, name: null, size: null, quantity: null, final_price: null }),
    row(4, { amount: 900, grand_total: 500 }), // cotización distinta a lo cobrado
  ]);
  assert.equal(r.groups[0].sku, 'S741228B');
  assert.equal(r.groups[0].units, 4);
  assert.deepEqual(r.groups[0].sizes, { M: 2, S: 2 });
  assert.equal(r.groups[0].total, 250 + 400 + 250);
  assert.equal(r.groups[0].sales, 3);
  assert.equal(r.totalUnits, 5);
  assert.deepEqual([r.salesTotal, r.salesWithItems, r.salesWithoutItems, r.salesMismatch], [4, 3, 1, 1]);
});
