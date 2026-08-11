import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSessionId } from './conversations.js';

test('strips the memory node suffix from a session id', () => {
  assert.equal(
    cleanSessionId('7d2b60411f004392b3edce8fa92d69d0__Postgres_Chat_Memory'),
    '7d2b60411f004392b3edce8fa92d69d0'
  );
});

test('leaves a plain session id unchanged', () => {
  assert.equal(cleanSessionId('abc123'), 'abc123');
});
