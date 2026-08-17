import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

const ELEVATED_ROLES = ['admin', 'supervisor'];

// Anyone can create a global one (it's a shared team resource), but only its author
// or an admin/supervisor can edit/delete it, so one advisor can't wipe out something
// the whole team relies on. Personal ones are only ever touched by their owner.
function canManage(row, user) {
  if (row.scope === 'personal') return row.owner_user_id === user.id;
  return row.owner_user_id === user.id || ELEVATED_ROLES.includes(user.role);
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT qr.id, qr.shortcut, qr.content, qr.scope, qr.owner_user_id, u.full_name AS owner_name
       FROM quick_replies qr
       JOIN users u ON u.id = qr.owner_user_id
       WHERE qr.scope = 'global' OR qr.owner_user_id = $1
       ORDER BY qr.shortcut ASC`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({
      id: r.id,
      shortcut: r.shortcut,
      content: r.content,
      scope: r.scope,
      ownerUserId: r.owner_user_id,
      ownerName: r.owner_name,
      canManage: canManage(r, req.user),
    })));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { shortcut, content, scope } = req.body ?? {};
    const cleanShortcut = (shortcut ?? '').trim().toLowerCase().replace(/^\/+/, '');
    if (!cleanShortcut || !content?.trim()) return res.status(400).json({ error: 'shortcut and content required' });
    if (!['personal', 'global'].includes(scope)) return res.status(400).json({ error: 'invalid scope' });

    const { rows } = await pool.query(
      `INSERT INTO quick_replies (shortcut, content, scope, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, shortcut, content, scope, owner_user_id`,
      [cleanShortcut, content.trim(), scope, req.user.id]
    );
    res.status(201).json({ ...rows[0], ownerUserId: rows[0].owner_user_id, ownerName: req.user.fullName, canManage: true });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM quick_replies WHERE id = $1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });
    if (!canManage(existing[0], req.user)) return res.status(403).json({ error: 'forbidden' });

    const { shortcut, content } = req.body ?? {};
    const cleanShortcut = shortcut !== undefined ? shortcut.trim().toLowerCase().replace(/^\/+/, '') : undefined;
    if (cleanShortcut !== undefined && !cleanShortcut) return res.status(400).json({ error: 'shortcut required' });
    if (content !== undefined && !content.trim()) return res.status(400).json({ error: 'content required' });

    const { rows } = await pool.query(
      `UPDATE quick_replies SET
         shortcut = COALESCE($1, shortcut),
         content = COALESCE($2, content),
         updated_at = now()
       WHERE id = $3
       RETURNING id, shortcut, content, scope, owner_user_id`,
      [cleanShortcut ?? null, content?.trim() ?? null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM quick_replies WHERE id = $1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });
    if (!canManage(existing[0], req.user)) return res.status(403).json({ error: 'forbidden' });

    await pool.query(`DELETE FROM quick_replies WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
