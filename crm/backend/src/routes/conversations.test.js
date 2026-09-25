import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSessionId, parseThreadKey } from './conversations.js';

test('strips the memory node suffix from a session id', () => {
  assert.equal(
    cleanSessionId('7d2b60411f004392b3edce8fa92d69d0__Postgres_Chat_Memory'),
    '7d2b60411f004392b3edce8fa92d69d0'
  );
});

test('leaves a plain session id unchanged', () => {
  assert.equal(cleanSessionId('abc123'), 'abc123');
});

test('preserves line suffix in cleanSessionId', () => {
  assert.equal(cleanSessionId('50254874713__line_2'), '50254874713__line_2');
  assert.equal(cleanSessionId('50254874713__line_2__Postgres_Chat_Memory'), '50254874713__line_2');
});

test('parses threadKey into phone and lineId', () => {
  assert.deepEqual(parseThreadKey('50254874713__line_2'), { phone: '50254874713', lineId: 2 });
  assert.deepEqual(parseThreadKey('50254874713__line_2__Postgres_Chat_Memory'), { phone: '50254874713', lineId: 2 });
  assert.deepEqual(parseThreadKey('50254874713'), { phone: '50254874713', lineId: null });
  assert.deepEqual(parseThreadKey('50254874713__Postgres_Chat_Memory'), { phone: '50254874713', lineId: null });
});

test('regex correctly extracts line id from complex session id', () => {
  const match = '573151045201__line_2__Postgres_Chat_Memory'.match(/__line_([0-9]+)/);
  assert.ok(match);
  assert.equal(parseInt(match[1], 10), 2);
});

