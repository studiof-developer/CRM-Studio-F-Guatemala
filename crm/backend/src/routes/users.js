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
      `SELECT u.id, u.full_name, u.username, u.email, u.role, u.zone, u.created_at,
         COALESCE(json_agg(uwn.whatsapp_number_id) FILTER (WHERE uwn.whatsapp_number_id IS NOT NULL), '[]') as assigned_lines
       FROM users u
       LEFT JOIN user_whatsapp_numbers uwn ON u.id = uwn.user_id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { full_name, username, email, password, role, zone, assigned_lines } = req.body ?? {};
    if (!full_name || !username || !password || !role) {
      return res.status(400).json({ error: 'full_name, username, password and role are required' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username must be 3-32 characters: lowercase letters, numbers, dots, dashes or underscores' });
    }
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      `INSERT INTO users (full_name, username, email, password_hash, role, zone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, full_name, username, email, role, zone, created_at`,
      [full_name, username, email || null, hash, role, role === 'asesor' ? (zone || null) : null]
    );
    const user = rows[0];

    if (Array.isArray(assigned_lines) && assigned_lines.length > 0) {
      for (const numberId of assigned_lines) {
        await client.query(
          'INSERT INTO user_whatsapp_numbers (user_id, whatsapp_number_id) VALUES ($1, $2)',
          [user.id, numberId]
        );
      }
    }
    user.assigned_lines = assigned_lines || [];

    await client.query('COMMIT');
    logAccess(req.user, null, 'user_created');
    res.status(201).json(user);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'username or email already in use' });
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { full_name, username, email, role, zone, password, assigned_lines } = req.body ?? {};
    if (username !== undefined && !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username must be 3-32 characters: lowercase letters, numbers, dots, dashes or underscores' });
    }
    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    
    await client.query('BEGIN');
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;

    const { rows } = await client.query(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         username = COALESCE($2, username),
         email = CASE WHEN $3 THEN $4 ELSE email END,
         role = COALESCE($5, role),
         zone = CASE WHEN COALESCE($5, role) IN ('supervisor', 'admin') THEN NULL ELSE COALESCE($6, zone) END,
         password_hash = COALESCE($7, password_hash)
       WHERE id = $8
       RETURNING id, full_name, username, email, role, zone, created_at`,
      [full_name ?? null, username ?? null, email !== undefined, email || null, role ?? null, zone || null, passwordHash, req.params.id]
    );
    
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    
    const user = rows[0];

    if (assigned_lines !== undefined) {
      await client.query('DELETE FROM user_whatsapp_numbers WHERE user_id = $1', [user.id]);
      if (Array.isArray(assigned_lines) && assigned_lines.length > 0) {
        for (const numberId of assigned_lines) {
          await client.query(
            'INSERT INTO user_whatsapp_numbers (user_id, whatsapp_number_id) VALUES ($1, $2)',
            [user.id, numberId]
          );
        }
      }
      user.assigned_lines = assigned_lines;
    }

    await client.query('COMMIT');
    logAccess(req.user, null, 'user_updated');
    res.json(user);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'username or email already in use' });
    next(err);
  } finally {
    client.release();
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
    if (err.code === '23503') {
      return res.status(409).json({ error: 'no se puede eliminar: este usuario tiene historial de auditoría asociado' });
    }
    next(err);
  }
});

export default router;
