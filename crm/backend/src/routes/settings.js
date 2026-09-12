import { Router } from 'express';
import { pool } from '../db.js';
import { requireRole } from '../auth.js';
import { PIPELINE_COLUMNS } from './tickets.js';
import { encryptToken } from '../tokenCrypto.js';

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

// A list of plain phrases, not a regex — capped so the OR-list this ends up compiled
// into (SQL trigger or JS regex) stays small and each phrase stays skimmable in the
// editor. Each phrase itself is bounded so it reads as a real phrase, not an attempt to
// paste a whole paragraph or a regex pattern in disguise.
function isValidPhraseList(v) {
  if (!Array.isArray(v) || v.length > 20) return false;
  return v.every((p) => typeof p === 'string' && p.trim().length >= 3 && p.length <= 80);
}

// Every setting this app currently exposes as admin-editable. Keeps the API from
// reading/writing an arbitrary key, and gives each one a shape check before it's
// trusted.
const SETTINGS = {
  ocr_context_hours: {
    label: 'Ventana para combinar comprobantes divididos en el OCR',
    description: 'Si un cliente manda dos fotos de pago separadas para completar un mismo total (ej. pagó en dos partes), cuántas horas hacia atrás se suman entre sí. No afecta cuánto tarda un cliente en pagar después de que se le cotiza un precio — eso ya no tiene límite de tiempo.',
    validate: (v) => Number.isFinite(v) && v > 0 && v <= 24,
  },
  pipeline_columns: {
    label: 'Columnas del Pipeline',
    description: 'Nombre, ícono, color y orden de las columnas del tablero. Las 8 columnas en sí no se pueden agregar ni quitar desde aquí.',
    validate: isValidPipelineColumns,
  },
  sla_minutes: {
    label: 'Minutos para marcar "No atendidos" como atrasado',
    description: 'Cuánto puede esperar un ticket sin asesor asignado antes de marcarse en rojo como atrasado en el Pipeline.',
    validate: (v) => Number.isFinite(v) && v > 0 && v <= 1440,
  },
  awaiting_reply_overdue_minutes: {
    label: 'Minutos para marcar una conversación activa como atrasada',
    description: 'En las columnas donde ya hay un asesor asignado, cuánto puede esperar un cliente una respuesta antes de marcarse en rojo como atrasado.',
    validate: (v) => Number.isFinite(v) && v > 0 && v <= 1440,
  },
  broadcast_cooldown_hours: {
    label: 'Horas de espera entre difusiones al mismo cliente',
    description: 'Cuánto debe pasar desde la última difusión que recibió un cliente antes de que se le pueda enviar otra.',
    validate: (v) => Number.isFinite(v) && v > 0 && v <= 720,
  },
  extra_caliente_phrases: {
    label: 'Frases extra que mueven a un cliente a "Medio de pago" (Caliente)',
    description: 'Se suman (no reemplazan) a las frases ya incorporadas — úsalas si el equipo usa una manera de preguntar el medio de pago que el sistema no reconoce todavía.',
    validate: isValidPhraseList,
  },
  extra_receipt_keywords: {
    label: 'Palabras extra que confirman que una foto es un comprobante (OCR)',
    description: 'Se suman (no reemplazan) a las palabras ya incorporadas — útil para un banco o pasarela de pago nueva cuyo comprobante no trae ninguna de esas palabras.',
    validate: isValidPhraseList,
  },
  // "Costo de conversión" (2026-09-13): gasto en pauta ÷ clientes pagados en el mismo
  // periodo — el conteo de conversiones ya sale de nuestros propios datos, solo el gasto
  // viene de Meta. account_id no es secreto (solo un identificador); el token sí, así
  // que nunca vuelve en la respuesta de GET una vez guardado (ver `secret` abajo) —
  // mismo criterio que whatsapp_numbers.access_token_enc, solo que aquí es un único
  // valor global en vez de una fila por número.
  meta_ads_account_id: {
    label: 'ID de la cuenta publicitaria de Meta',
    description: 'El "Identificador" que aparece en Meta Business → Cuentas publicitarias, con o sin el prefijo "act_".',
    validate: (v) => typeof v === 'string' && /^(act_)?\d{5,20}$/.test(v.trim()),
  },
  meta_ads_access_token: {
    label: 'Token de acceso de Meta Ads (permiso ads_read)',
    description: 'Token de un usuario del sistema de Meta Business con permiso ads_read sobre esa cuenta — usado solo para leer el gasto en pauta.',
    secret: true,
    validate: (v) => typeof v === 'string' && v.trim().length > 20,
  },
};

// Read by every logged-in role (the Pipeline board itself needs pipeline_columns to
// render for asesores/supervisores, not just admins) — only writing is admin-only.
router.get('/', async (req, res, next) => {
  try {
    const keys = Object.keys(SETTINGS);
    const { rows } = await pool.query(`SELECT key, value, updated_at FROM app_settings WHERE key = ANY($1)`, [keys]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    res.json(keys.map((key) => {
      const spec = SETTINGS[key];
      const stored = byKey[key];
      return {
        key,
        label: spec.label,
        description: spec.description,
        secret: spec.secret ?? false,
        // A secret's real (encrypted) value never round-trips back out — just whether
        // one is currently set, same as whatsapp_numbers never returning the plaintext
        // token, only tokenLast4.
        value: spec.secret ? Boolean(stored?.value) : (stored?.value ?? null),
        updatedAt: stored?.updated_at ?? null,
      };
    }));
  } catch (err) { next(err); }
});

router.put('/:key', requireRole('admin'), async (req, res, next) => {
  try {
    const { key } = req.params;
    const spec = SETTINGS[key];
    if (!spec) return res.status(404).json({ error: 'unknown setting' });
    const { value } = req.body ?? {};
    if (!spec.validate(value)) return res.status(400).json({ error: 'invalid value' });
    const storedValue = spec.secret ? encryptToken(value.trim()) : value;
    const { rows } = await pool.query(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3
       RETURNING value, updated_at`,
      [key, JSON.stringify(storedValue), req.user.id]
    );
    res.json({ key, value: spec.secret ? true : rows[0].value, updatedAt: rows[0].updated_at });
  } catch (err) { next(err); }
});

export default router;

// Reads one setting's current value directly — for other backend routes that need it
// without round-tripping through the HTTP API (attachments.js's OCR gate).
export async function getSetting(key, fallback) {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : fallback;
}
