import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Checklist de la página /auditoria.html (solo administradores). Devuelve el estado de cada pendiente y las últimas marcas.
router.get('/', async (req, res, next) => {
  try {
    const [items, log] = await Promise.all([
      pool.query('SELECT item_key, done, done_by_name, done_at FROM audit_checklist'),
      pool.query('SELECT item_key, done, user_name, at FROM audit_checklist_log ORDER BY id DESC LIMIT 40'),
    ]);
    res.json({
      items: Object.fromEntries(items.rows.map((r) => [r.item_key, { done: r.done, by: r.done_by_name, at: r.done_at }])),
      log: log.rows.map((r) => ({ key: r.item_key, done: r.done, by: r.user_name, at: r.at })),
    });
  } catch (err) { next(err); }
});

// body: { done: boolean } — marca o desmarca un pendiente y deja la huella en el historial.
router.put('/:key', async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!/^[a-z0-9_-]{1,40}$/.test(key) || typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'dato inválido' });
    const done = req.body.done;
    const name = req.user.fullName || 'Administrador';
    await pool.query(
      `INSERT INTO audit_checklist (item_key, done, done_by, done_by_name, done_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (item_key) DO UPDATE SET done = $2, done_by = $3, done_by_name = $4, done_at = now()`,
      [key, done, req.user.id, name]
    );
    await pool.query('INSERT INTO audit_checklist_log (item_key, done, user_id, user_name) VALUES ($1, $2, $3, $4)', [key, done, req.user.id, name]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
