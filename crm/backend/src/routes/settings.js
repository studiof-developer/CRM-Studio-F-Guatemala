import { Router } from 'express';
import { pool } from '../db.js';
import { requireRole } from '../auth.js';
import { PIPELINE_COLUMNS } from './tickets.js';

const router = Router();

// Selectable in the Pipeline-columns editor — kept to a fixed whitelist (rather than
// any lucide icon name) so a bad PUT can't ask the board to render an icon that
// doesn't exist. iconography already used on the board today plus a handful of spares.
const PIPELINE_ICONS = ['Clock', 'Snowflake', 'Thermometer', 'Flame', 'CircleDollarSign', 'MessageSquareWarning', 'CheckCircle2', 'Star', 'Zap', 'AlertTriangle', 'Tag', 'Package'];
// Same 5 tokens Badge.jsx already exposes — reusing the app's existing palette instead
// of inventing new color names an admin would have to guess the meaning of.
const PIPELINE_COLORS = ['warning', 'info', 'danger', 'success', 'purple'];

// Cosmetics + display order only — `key` must stay one of the 7 fixed pipeline stages
// (temperature/ticket_status already decide which contact lands in which one, all over
// the OCR/regex automation built this session) so this can never add, remove, or
// silently rename which stage a customer is actually in, only how it's labeled and shown.
function isValidPipelineColumns(v) {
  if (!Array.isArray(v) || v.length !== PIPELINE_COLUMNS.length) return false;
  const seenKeys = new Set();
  for (const col of v) {
    if (!col || typeof col !== 'object') return false;
    if (!PIPELINE_COLUMNS.includes(col.key) || seenKeys.has(col.key)) return false;
    seenKeys.add(col.key);
    if (typeof col.label !== 'string' || !col.label.trim() || col.label.length > 40) return false;
    if (!PIPELINE_ICONS.includes(col.icon)) return false;
    if (!PIPELINE_COLORS.includes(col.color)) return false;
  }
  return true;
}

// Every setting this app currently exposes as admin-editable. Keeps the API from
// reading/writing an arbitrary key, and gives each one a shape check before it's
// trusted.
const SETTINGS = {
  ocr_context_hours: {
    label: 'Ventana de contexto para el OCR de pagos',
    description: 'Cuántas horas hacia atrás revisa el chat en busca de un precio cotizado o una señal de pago antes de leer una foto de comprobante.',
    validate: (v) => Number.isFinite(v) && v > 0 && v <= 24,
  },
  pipeline_columns: {
    label: 'Columnas del Pipeline',
    description: 'Nombre, ícono, color y orden de las columnas del tablero. Las 7 columnas en sí no se pueden agregar ni quitar desde aquí.',
    validate: isValidPipelineColumns,
  },
};

// Read by every logged-in role (the Pipeline board itself needs pipeline_columns to
// render for asesores/supervisores, not just admins) — only writing is admin-only.
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

router.put('/:key', requireRole('admin'), async (req, res, next) => {
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
