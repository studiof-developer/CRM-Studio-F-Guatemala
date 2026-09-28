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
    // lineId filter: return replies for the given line + global (null line) + personal.
    // No lineId = return all, so the admin management panel still shows everything.
    const lineId = req.query.lineId ? Number(req.query.lineId) : null;
    const params = [req.user.id];
    const lineClause = lineId
      ? `AND (qr.whatsapp_number_id = $2 OR qr.whatsapp_number_id IS NULL)`
      : '';
    if (lineId) params.push(lineId);

    const { rows } = await pool.query(
      `SELECT qr.id, qr.shortcut, qr.content, qr.scope, qr.owner_user_id, qr.whatsapp_number_id,
              u.full_name AS owner_name,
              wn.label AS line_label
       FROM quick_replies qr
       JOIN users u ON u.id = qr.owner_user_id
       LEFT JOIN whatsapp_numbers wn ON wn.id = qr.whatsapp_number_id
       WHERE (qr.scope = 'global' OR qr.owner_user_id = $1)
         ${lineClause}
       ORDER BY qr.shortcut ASC`,
      params
    );
    res.json(rows.map((r) => ({
      id: r.id,
      shortcut: r.shortcut,
      content: r.content,
      scope: r.scope,
      ownerUserId: r.owner_user_id,
      ownerName: r.owner_name,
      whatsappNumberId: r.whatsapp_number_id,
      lineLabel: r.line_label ?? null,
      canManage: canManage(r, req.user),
    })));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { shortcut, content, scope, whatsappNumberId } = req.body ?? {};
    const cleanShortcut = (shortcut ?? '').trim().toLowerCase().replace(/^\/+/, '');
    if (!cleanShortcut || !content?.trim()) return res.status(400).json({ error: 'shortcut and content required' });
    if (!['personal', 'global'].includes(scope)) return res.status(400).json({ error: 'invalid scope' });
    const lineId = whatsappNumberId ? Number(whatsappNumberId) : null;

    const { rows } = await pool.query(
      `INSERT INTO quick_replies (shortcut, content, scope, owner_user_id, whatsapp_number_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, shortcut, content, scope, owner_user_id, whatsapp_number_id`,
      [cleanShortcut, content.trim(), scope, req.user.id, lineId]
    );
    const r = rows[0];
    let lineLabel = null;
    if (r.whatsapp_number_id) {
      const { rows: wn } = await pool.query(`SELECT label FROM whatsapp_numbers WHERE id = $1`, [r.whatsapp_number_id]);
      lineLabel = wn[0]?.label ?? null;
    }
    res.status(201).json({
      id: r.id, shortcut: r.shortcut, content: r.content, scope: r.scope,
      ownerUserId: r.owner_user_id, ownerName: req.user.fullName,
      whatsappNumberId: r.whatsapp_number_id, lineLabel,
      canManage: true,
    });
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
       RETURNING id, shortcut, content, scope, owner_user_id, whatsapp_number_id`,
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
