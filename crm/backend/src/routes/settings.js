import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Every setting this app currently exposes as admin-editable. Keeps the API from
// reading/writing an arbitrary key, and gives each one a shape check before it's
// trusted — this list grows as more hardcoded numbers move here (Pipeline columns
// next), it's not meant to stay this short.
const SETTINGS = {
  ocr_context_hours: {
    label: 'Ventana de contexto para el OCR de pagos',
    description: 'Cuántas horas hacia atrás revisa el chat en busca de un precio cotizado o una señal de pago antes de leer una foto de comprobante.',
    validate: (v) => Number.isFinite(v) && v > 0 && v <= 24,
  },
};

router.get('/', async (req, res, next) => {
  try {
    const keys = Object.keys(SETTINGS);
    const { rows } = await pool.query(`SELECT key, value, updated_at FROM app_settings WHERE key = ANY($1)`, [keys]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    res.json(keys.map((key) => ({
      key,
      label: SETTINGS[key].label,
      description: SETTINGS[key].description,
      value: byKey[key]?.value ?? null,
      updatedAt: byKey[key]?.updated_at ?? null,
    })));
  } catch (err) { next(err); }
});

router.put('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const spec = SETTINGS[key];
    if (!spec) return res.status(404).json({ error: 'unknown setting' });
    const { value } = req.body ?? {};
    if (!spec.validate(value)) return res.status(400).json({ error: 'invalid value' });
    const { rows } = await pool.query(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3
       RETURNING value, updated_at`,
      [key, JSON.stringify(value), req.user.id]
    );
    res.json({ key, value: rows[0].value, updatedAt: rows[0].updated_at });
  } catch (err) { next(err); }
});

export default router;

// Reads one setting's current value directly — for other backend routes that need it
// without round-tripping through the HTTP API (attachments.js's OCR gate).
export async function getSetting(key, fallback) {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : fallback;
}
