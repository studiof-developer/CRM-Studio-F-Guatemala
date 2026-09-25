import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addClient, removeClient, broadcast } from './events.js';

test('broadcasts payload to registered clients', () => {
  const written = [];
  const fakeRes = { write: (chunk) => written.push(chunk) };
  addClient(fakeRes);
  broadcast('test_channel', 'hello');
  removeClient(fakeRes);
  assert.deepEqual(written, ['event: test_channel\ndata: hello\n\n']);
});

test('does not notify removed clients', () => {
  const written = [];
  const fakeRes = { write: (chunk) => written.push(chunk) };
  addClient(fakeRes);
  removeClient(fakeRes);
  broadcast('test_channel', 'hello');
  assert.deepEqual(written, []);
});
