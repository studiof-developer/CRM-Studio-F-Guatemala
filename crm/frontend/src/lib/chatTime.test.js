import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay, formatDateSeparator } from './chatTime.js';

test('formatDateSeparator labels today as Hoy', () => {
  assert.equal(formatDateSeparator(new Date().toISOString()), 'Hoy');
});

test('groupByDay keeps same-day messages in one group', () => {
  const now = new Date().toISOString();
  const messages = [
    { id: 1, createdAt: now },
    { id: 2, createdAt: now },
  ];
  const groups = groupByDay(messages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
});

test('groupByDay splits messages from different days', () => {
  const today = new Date().toISOString();
  const oldDay = new Date('2020-01-01T10:00:00Z').toISOString();
  const groups = groupByDay([{ id: 1, createdAt: oldDay }, { id: 2, createdAt: today }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items[0].id, 1);
  assert.equal(groups[1].items[0].id, 2);
});
