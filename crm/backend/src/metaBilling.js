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

async function accountHealth() {
  const creds = await getActiveCredentials().catch(() => null);
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

export async function getBillingStatus({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const cfg = { ...DEFAULTS, ...((await getSetting('meta_billing', {})) ?? {}) };
  const blockedAt = await getSetting('meta_billing_blocked_at', null);
  const health = await accountHealth();

  let estimatedOwed = null;
  let estimateError = null;
  if (cfg.baselineAt != null && cfg.baselineOwed != null) {
    try {
      // Desde el día de la anotación (inclusive): sobrestima un poco ese día, que es el lado seguro para una alerta.
      const usd = await fetchMessageCostUsd(gtDay(cfg.baselineAt), gtDay(new Date()));
      if (usd != null) estimatedOwed = Math.round((Number(cfg.baselineOwed) + usd) * 100) / 100;
    } catch (err) {
      estimateError = err.message;
    }
  }
  const remaining = estimatedOwed == null ? null : Math.round((cfg.threshold - estimatedOwed) * 100) / 100;
  const recentFailure = blockedAt && Date.now() - +new Date(blockedAt) < BLOCK_TTL_MS && (!cfg.baselineAt || +new Date(blockedAt) > +new Date(cfg.baselineAt));
  const healthPayment = health.canSend === 'BLOCKED' || (health.errors ?? []).some((e) => /pago|payment|billing|factura|saldo/i.test(e));
  const blocked = Boolean(recentFailure || healthPayment);
  const value = {
    level: billingLevel({ remaining, blocked, warnAt: cfg.warnAt, criticalAt: cfg.criticalAt }),
    blocked, blockedAt: recentFailure ? blockedAt : null,
    health: { canSend: health.canSend ?? null, errors: health.errors ?? [], error: health.error ?? null },
    estimatedOwed, remaining, estimateError,
    threshold: cfg.threshold, warnAt: cfg.warnAt, criticalAt: cfg.criticalAt,
    baseline: cfg.baselineAt ? { owed: cfg.baselineOwed, at: cfg.baselineAt } : null,
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}

const num = (v, min, max) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : undefined);

// Un administrador/supervisor anota el saldo que muestra Meta hoy ("Saldo actual"), o 0 al pagar; también puede ajustar los
// umbrales. Anotar un saldo limpia el bloqueo registrado: lo que falla es el cobro, y eso ya se atendió.
export async function saveBilling(input, userId) {
  const cur = (await getSetting('meta_billing', {})) ?? {};
  const next = { ...cur };
  const owed = num(input.owed, 0, 100000);
  if (owed !== undefined) { next.baselineOwed = owed; next.baselineAt = new Date().toISOString(); await upsertSetting('meta_billing_blocked_at', null, userId); }
  for (const k of ['threshold', 'warnAt', 'criticalAt']) {
    const v = num(input[k], 0.01, 100000);
    if (v !== undefined) next[k] = v;
  }
  if (next.criticalAt != null && next.warnAt != null && next.criticalAt > next.warnAt) throw Object.assign(new Error('La alerta fuerte debe ser menor que la normal'), { status: 400 });
  await upsertSetting('meta_billing', next, userId);
  return getBillingStatus({ fresh: true });
}
