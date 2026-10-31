import { pool } from './db.js';
import { getSetting } from './routes/settings.js';
import { getActiveCredentials } from './whatsapp.js';
import { fetchMessageCostUsd } from './whatsappPricing.js';

// Facturación de la API de WhatsApp (Meta). Meta cobra a la tarjeta cuando lo acumulado llega a un umbral; si el cobro
// falla, la cuenta queda restringida y no sale ningún mensaje. Meta no entrega por API el "saldo actual" del Centro de
// facturación, así que se estima: el último saldo que un administrador anotó (lo que dice Meta ese día) + el costo de los
// mensajes desde entonces (pricing_analytics). Dos señales reales sin estimar: el estado de envío de la cuenta
// (health_status) y el error 131042 que devuelve un envío rechazado por pago (lo anota whatsapp.js).
export const DEFAULTS = { threshold: 35, warnAt: 7, criticalAt: 4 };
const BLOCK_TTL_MS = 6 * 3600000; // un error 131042 reciente cuenta como bloqueo vigente
const CACHE_MS = 2 * 60000;
let cache = null;

// remaining = lo que falta para el cobro automático. blocked tiene prioridad sobre todo.
export function billingLevel({ remaining, blocked, warnAt = DEFAULTS.warnAt, criticalAt = DEFAULTS.criticalAt }) {
  if (blocked) return 'blocked';
  if (remaining == null) return 'unknown';
  if (remaining <= criticalAt) return 'critical';
  if (remaining <= warnAt) return 'warn';
  return 'ok';
}

async function upsertSetting(key, value, userId = null) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3`,
    [key, JSON.stringify(value), userId]
  );
  cache = null;
}

const gtDay = (d) => new Date(+new Date(d) - 6 * 3600000).toISOString().slice(0, 10);

async function accountHealth(lineId) {
  const creds = await getActiveCredentials(undefined, lineId).catch(() => null);
  if (!creds?.wabaId) return { error: 'No hay cuenta de WhatsApp Business configurada' };
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${creds.wabaId}?fields=health_status`, {
      headers: { Authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15000),
    });
    const body = await res.json();
    if (!res.ok) return { error: body?.error?.message ?? `Meta ${res.status}` };
    const hs = body.health_status ?? {};
    const errors = (hs.entities ?? []).flatMap((e) => e.errors ?? []).map((e) => `${e.error_description ?? ''} ${e.possible_solution ?? ''}`.trim()).filter(Boolean);
    return { canSend: hs.can_send_message ?? null, errors };
  } catch (err) {
    return { error: err.message };
  }
}

const RANK = { blocked: 4, critical: 3, warn: 2, unknown: 1, ok: 0 };

// Cada línea de WhatsApp tiene su propia cuenta de Meta (WABA) y su propio saldo: el estado se calcula por línea.
async function lineStatus(line, cfg, blockedAt) {
  const base = cfg.lines?.[line.id] ?? null;
  const health = await accountHealth(line.id);
  let estimatedOwed = null;
  let estimateError = null;
  if (base?.baselineAt != null && base.baselineOwed != null) {
    try {
      // Desde el día de la anotación (inclusive): sobrestima un poco ese día, que es el lado seguro para una alerta.
      const usd = await fetchMessageCostUsd(gtDay(base.baselineAt), gtDay(new Date()), line.id);
      if (usd != null) estimatedOwed = Math.round((Number(base.baselineOwed) + usd) * 100) / 100;
    } catch (err) {
      estimateError = err.message;
    }
  }
  const remaining = estimatedOwed == null ? null : Math.round((cfg.threshold - estimatedOwed) * 100) / 100;
  const recentFailure = blockedAt && Date.now() - +new Date(blockedAt) < BLOCK_TTL_MS && (!base?.baselineAt || +new Date(blockedAt) > +new Date(base.baselineAt));
  const healthPayment = health.canSend === 'BLOCKED' || (health.errors ?? []).some((e) => /pago|payment|billing|factura|saldo/i.test(e));
  const blocked = Boolean(recentFailure || healthPayment);
  return {
    lineId: line.id, label: line.label,
    level: billingLevel({ remaining, blocked, warnAt: cfg.warnAt, criticalAt: cfg.criticalAt }),
    blocked, blockedAt: recentFailure ? blockedAt : null,
    health: { canSend: health.canSend ?? null, errors: health.errors ?? [], error: health.error ?? null },
    estimatedOwed, remaining, estimateError,
    baseline: base?.baselineAt ? { owed: base.baselineOwed, at: base.baselineAt } : null,
  };
}

// El saldo anotado antes de separar por línea era el de la primera línea activa (la que usaba el CRM sin elegir).
function configWithLegacy(cfg, firstLineId) {
  if (cfg.baselineAt == null || firstLineId == null || cfg.lines?.[firstLineId]) return cfg;
  return { ...cfg, lines: { ...cfg.lines, [firstLineId]: { baselineOwed: cfg.baselineOwed, baselineAt: cfg.baselineAt } } };
}

async function activeLines() {
  const { rows } = await pool.query('SELECT id, label FROM whatsapp_numbers WHERE is_active = true ORDER BY id');
  return rows;
}

export async function getBillingStatus({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const lines = await activeLines();
  const cfg = configWithLegacy({ ...DEFAULTS, ...((await getSetting('meta_billing', {})) ?? {}) }, lines[0]?.id);
  const blockedMap = await getSetting('meta_billing_blocked_at', null);
  const blockedOf = (id) => (blockedMap && typeof blockedMap === 'object' ? blockedMap[id] ?? null : null);
  const perLine = await Promise.all(lines.map((l) => lineStatus(l, cfg, blockedOf(l.id))));
  const worst = perLine.reduce((w, l) => (RANK[l.level] > RANK[w] ? l.level : w), 'ok');
  const value = {
    level: worst, lines: perLine,
    threshold: cfg.threshold, warnAt: cfg.warnAt, criticalAt: cfg.criticalAt,
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}

const num = (v, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : undefined);

// Un administrador anota el saldo que muestra Meta hoy para una línea ("Saldo actual"), o 0 al pagar; también puede ajustar los
// umbrales (valen para todas las líneas). Anotar un saldo limpia el bloqueo registrado de esa línea: lo que falla es el cobro, y eso ya se atendió.
export async function saveBilling(input, userId) {
  const lines = await activeLines();
  const cur = configWithLegacy((await getSetting('meta_billing', {})) ?? {}, lines[0]?.id);
  const next = { ...cur, lines: { ...cur.lines } };
  delete next.baselineOwed; delete next.baselineAt;
  const owed = num(input.owed, 0, 100000);
  if (owed !== undefined) {
    const lineId = Number(input.lineId);
    if (!lines.some((l) => l.id === lineId)) throw Object.assign(new Error('Elige la línea a la que corresponde el saldo'), { status: 400 });
    next.lines[lineId] = { baselineOwed: owed, baselineAt: new Date().toISOString() };
    const blocked = await getSetting('meta_billing_blocked_at', null);
    if (blocked && typeof blocked === 'object') { const { [lineId]: _drop, ...rest } = blocked; await upsertSetting('meta_billing_blocked_at', rest, userId); }
  }
  for (const k of ['threshold', 'warnAt', 'criticalAt']) {
    const v = num(input[k], 0.01, 100000);
    if (v !== undefined) next[k] = v;
  }
  if (next.criticalAt != null && next.warnAt != null && next.criticalAt > next.warnAt) throw Object.assign(new Error('La alerta fuerte debe ser menor que la normal'), { status: 400 });
  await upsertSetting('meta_billing', next, userId);
  return getBillingStatus({ fresh: true });
}
