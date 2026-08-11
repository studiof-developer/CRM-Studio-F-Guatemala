import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';

const router = Router();
const VALID_ROLES = ['asesor', 'supervisor'];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, role, zone, created_at FROM users ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { full_name, email, password, role, zone } = req.body ?? {};
    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: 'full_name, email, password and role are required' });
    }
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role, zone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, full_name, email, role, zone, created_at`,
      [full_name, email, hash, role, role === 'asesor' ? zone ?? null : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email already in use' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { full_name, role, zone, password } = req.body ?? {};
    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;

    const { rows } = await pool.query(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         role = COALESCE($2, role),
         zone = CASE WHEN $2 = 'supervisor' THEN NULL ELSE COALESCE($3, zone) END,
         password_hash = COALESCE($4, password_hash)
       WHERE id = $5
       RETURNING id, full_name, email, role, zone, created_at`,
      [full_name ?? null, role ?? null, zone ?? null, passwordHash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'cannot delete your own account' });
    }
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
