import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdleDays, erpBuyerSql } from './erpAudience.js';

test('los días sin comprar solo admiten 10, 15, 20, 25 y 30', () => {
  assert.equal(parseIdleDays(undefined), null);
  assert.equal(parseIdleDays(''), null);
  assert.equal(parseIdleDays('15'), 15);
  assert.equal(parseIdleDays(30), 30);
  for (const bad of [5, 12, 35, '10; DROP TABLE x', 'abc']) assert.throws(() => parseIdleDays(bad), /de 5 en 5/);
});

test('sin días: basta con haber comprado en el ERP; con días: la última compra (ERP y CRM) debe ser más vieja', () => {
  assert.doesNotMatch(erpBuyerSql(), /interval/);
  const sql = erpBuyerSql(20);
  assert.match(sql, /::date - 20/);
  assert.match(sql, /interval '20 days'/);
  assert.match(sql, /FROM sales s/);
});
