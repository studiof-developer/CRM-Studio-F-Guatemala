import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePending } from './pendingPayments.js';

const at = (h) => new Date(Date.UTC(2026, 9, 20, 18, 0) - h * 3600000).toISOString();
const chat = (phone, o = {}) => ({ source: 'chat', customerId: 1, phone, customerName: phone, line: 1, medium: 'transferencia', amount: 1576, sentAt: at(1), advisorName: 'Leydi Laura Mosquera', url: null, ...o });
const link = (phone, o = {}) => ({ source: 'link', id: 7, phone, customerName: phone, line: 1, medium: 'link', amount: 1461, sentAt: at(2), advisorName: 'Aura Cristina', url: 'https://pay.neolink.com.gt/x', ...o });

test('resumen: total, cantidad, por asesora y los que no tienen monto', () => {
  const r = mergePending({ links: [link('A')], chats: [chat('B'), chat('C', { amount: null })] });
  assert.equal(r.count, 3);
  assert.equal(r.total, 1461 + 1576);
  assert.equal(r.unknownCount, 1);
  assert.deepEqual(r.byAdvisor['Leydi Laura Mosquera'], { total: 1576, count: 2 });
  assert.deepEqual(r.byAdvisor['Aura Cristina'], { total: 1461, count: 1 });
  assert.deepEqual(r.items.map((i) => i.phone), ['B', 'C', 'A']); // el más reciente primero
});

test('un cliente con link y con medios de pago por chat cuenta una sola vez: manda el monto del link', () => {
  const r = mergePending({ links: [link('A', { amount: 1461 })], chats: [chat('A', { amount: 1400 })] });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].amount, 1461);
  assert.equal(r.items[0].medium, 'link');
});

test('si el link no se pudo leer se conserva el monto que cotizó la asesora', () => {
  const r = mergePending({ links: [link('A', { amount: null })], chats: [chat('A', { amount: 1400 })] });
  assert.equal(r.items[0].amount, 1400);
  assert.equal(r.unknownCount, 0);
});

test('el filtro por línea deja solo los de esa línea', () => {
  const r = mergePending({ links: [link('A', { line: 2 })], chats: [chat('B', { line: 1 }), chat('C', { line: 2 })], lineId: 2 });
  assert.deepEqual(r.items.map((i) => i.phone).sort(), ['A', 'C']);
  assert.equal(mergePending({ links: [], chats: [chat('B', { line: 1 })], lineId: 2 }).count, 0);
});
