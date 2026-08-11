import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidStatus } from './ticketStatus.js';

test('accepts known statuses', () => {
  assert.equal(isValidStatus('esperando_asesor'), true);
  assert.equal(isValidStatus('resuelto'), true);
});

test('rejects unknown statuses', () => {
  assert.equal(isValidStatus('inventado'), false);
  assert.equal(isValidStatus(''), false);
  assert.equal(isValidStatus(undefined), false);
});
