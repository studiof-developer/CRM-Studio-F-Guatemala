import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { signSession, setSessionCookie, clearSessionCookie, requireAuth } from '../auth.js';

const router = Router();

// In-memory sliding window is enough for a single-process app this size — no new
// dependency for what's fundamentally "stop hammering /login". Resets on restart,
// which is fine: the threat here is scripted brute force, not a determined attacker
// who'd just wait out a redeploy anyway.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, attempts);
  return attempts.length >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  loginAttempts.get(ip)?.push(Date.now()) ?? loginAttempts.set(ip, [Date.now()]);
}

router.post('/login', async (req, res, next) => {
  try {
    if (isRateLimited(req.ip)) {
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }

    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      recordFailedAttempt(req.ip);
      return res.status(401).json({ error: 'invalid credentials' });
    }

    setSessionCookie(res, signSession(user));
    res.json({ id: user.id, fullName: user.full_name, role: user.role, zone: user.zone });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

export default router;
