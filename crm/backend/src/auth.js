import jwt from 'jsonwebtoken';

// Read lazily (not at module load) so tests can set JWT_SECRET after import.
const getSecret = () => process.env.JWT_SECRET;
const COOKIE_NAME = 'studio_f_session';

export function signSession(user) {
  return jwt.sign(
    { id: user.id, fullName: user.full_name, role: user.role, zone: user.zone },
    getSecret(),
    { expiresIn: '8h' }
  );
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'not authenticated' });
  try {
    req.user = jwt.verify(token, getSecret());
    next();
  } catch {
    res.status(401).json({ error: 'invalid session' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// Admin and supervisor both get unrestricted (non-zone-scoped) access everywhere;
// only 'asesor' is limited to their own zone.
export const ELEVATED_ROLES = ['admin', 'supervisor'];

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}
