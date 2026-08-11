import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-secret-for-unit-tests';

const { signSession, requireAuth, requireRole } = await import('./auth.js');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requireAuth rejects requests with no session cookie', () => {
  const req = { cookies: {} };
  const res = fakeRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth accepts a valid signed session and attaches req.user', () => {
  const token = signSession({ id: 1, full_name: 'Ana', role: 'asesor', zone: 'capital' });
  const req = { cookies: { studio_f_session: token } };
  const res = fakeRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user.role, 'asesor');
  assert.equal(req.user.zone, 'capital');
});

test('requireAuth rejects a tampered token', () => {
  const token = signSession({ id: 1, full_name: 'Ana', role: 'asesor', zone: 'capital' });
  const req = { cookies: { studio_f_session: `${token}tampered` } };
  const res = fakeRes();
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireRole blocks a user with the wrong role', () => {
  const req = { user: { role: 'asesor' } };
  const res = fakeRes();
  let nextCalled = false;
  requireRole('supervisor')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireRole allows a user with the matching role', () => {
  const req = { user: { role: 'supervisor' } };
  const res = fakeRes();
  let nextCalled = false;
  requireRole('supervisor')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
