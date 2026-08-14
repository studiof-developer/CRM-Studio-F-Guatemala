import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';

const router = Router();
const VALID_ROLES = ['asesor', 'supervisor', 'admin'];
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, username, email, role, zone, created_at FROM users ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { full_name, username, email, password, role, zone } = req.body ?? {};
    if (!full_name || !username || !password || !role) {
      return res.status(400).json({ error: 'full_name, username, password and role are required' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username must be 3-32 characters: lowercase letters, numbers, dots, dashes or underscores' });
    }
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, username, email, password_hash, role, zone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, full_name, username, email, role, zone, created_at`,
      [full_name, username, email || null, hash, role, role === 'asesor' ? zone ?? null : null]
    );
    logAccess(req.user, null, 'user_created');
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username or email already in use' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { full_name, username, email, role, zone, password } = req.body ?? {};
    if (username !== undefined && !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username must be 3-32 characters: lowercase letters, numbers, dots, dashes or underscores' });
    }
    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;

    const { rows } = await pool.query(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         username = COALESCE($2, username),
         email = CASE WHEN $3 THEN $4 ELSE email END,
         role = COALESCE($5, role),
         zone = CASE WHEN COALESCE($5, role) IN ('supervisor', 'admin') THEN NULL ELSE COALESCE($6, zone) END,
         password_hash = COALESCE($7, password_hash)
       WHERE id = $8
       RETURNING id, full_name, username, email, role, zone, created_at`,
      [full_name ?? null, username ?? null, email !== undefined, email || null, role ?? null, zone ?? null, passwordHash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    logAccess(req.user, null, 'user_updated');
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username or email already in use' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'cannot delete your own account' });
    }
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    logAccess(req.user, null, 'user_deleted');
    res.status(204).end();
  } catch (err) {
    // Deleting a user who has audit history would orphan those log rows —
    // Postgres correctly refuses via the FK constraint; surface that clearly
    // instead of a generic 500.
    if (err.code === '23503') {
      return res.status(409).json({ error: 'no se puede eliminar: este usuario tiene historial de auditoría asociado' });
    }
    next(err);
  }
});

export default router;
