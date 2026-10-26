import { pool } from './db.js';
import { getSetting } from './routes/settings.js';

// Conversaciones del CRM día por día para las Estadísticas del Pipeline.
// Un día que ya terminó no cambia: se calcula UNA vez (stats_conv_days / stats_hour_days) y las consultas siguientes solo leen esas tablas.
// Hoy se calcula en vivo cada vez. Si cambia la regla de qué difusiones cuentan, los días guardados se recalculan solos.
const TZ = 'America/Guatemala';
export const gtToday = () => new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
export const addDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const CHUNK_DAYS = 10;

// Difusiones que NO son de marketing (avisos de servicio: guías, novedades, seguimiento): no cuentan como difusión. Lista editable en el ajuste stats_service_templates.
export async function servicePattern() {
  const raw = await getSetting('stats_service_templates', 'novedad_pedido,seguimiento_asesor,new_chat').catch(() => 'novedad_pedido,seguimiento_asesor,new_chat');
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((s) => String(s).toLowerCase().replace(/[^a-z0-9_ -]/g, '').trim()).filter(Boolean);
  return list.map((s) => s.replace(/[_ -]+/g, '[ _-]*')).join('|');
}
export const notService = (alias, pattern) => (pattern
  ? ` AND NOT EXISTS (SELECT 1 FROM campaigns ca WHERE ca.id::text = ${alias}.message->'additional_kwargs'->>'campaignId' AND ca.template_name ~* '${pattern}')`
  : '');

// El rango de días (hora de Guatemala) que pide una consulta: from/to, o since/until, o hoy.
export function dayRange(query) {
  const gt = (iso) => new Date(new Date(iso).getTime() - 6 * 3600000).toISOString().slice(0, 10);
  const from = query.from ?? (query.since ? gt(query.since) : gtToday());
  const to = query.to ?? (query.until ? gt(new Date(Date.parse(query.until) - 1).toISOString()) : from);
  return { from, to };
}

const START = (p) => `${p}::date::timestamp AT TIME ZONE '${TZ}'`;
const END = (p) => `(${p}::date + 1)::timestamp AT TIME ZONE '${TZ}'`;

// Calcula las conversaciones (cliente × día × línea × canal) y las horas de [a, b]. No guarda nada.
async function computeRange(a, b, pattern) {
  const [wa, soc, hwa, hsoc] = await Promise.all([
    pool.query(`
      WITH wa AS (
        SELECT split_part(h.session_id, '__', 1) AS ref, COALESCE((regexp_match(h.session_id, '__line_(\\d+)'))[1]::int, h.whatsapp_number_id, 1) AS line,
               (h.created_at AT TIME ZONE '${TZ}')::date AS day,
               bool_or(h.message->'additional_kwargs'->'referral' IS NOT NULL OR h.message->'additional_kwargs'->>'ad_id' IS NOT NULL) AS ad,
               min(h.created_at) AS first_at, count(*) AS msgs
        FROM n8n_chat_histories h
        WHERE h.message->>'type' = 'human' AND h.created_at >= ${START('$1')} AND h.created_at < ${END('$2')}
        GROUP BY 1, 2, 3
      ), sends AS (
        SELECT split_part(s.session_id, '__', 1) AS ref, s.created_at AS at FROM n8n_chat_histories s
        WHERE s.message->'additional_kwargs'->>'campaignId' IS NOT NULL${notService('s', pattern)}
          AND s.created_at >= ${START('$1')} - interval '24 hours' AND s.created_at < ${END('$2')}
      )
      SELECT to_char(wa.day, 'YYYY-MM-DD') AS day, wa.line, 'whatsapp' AS channel, wa.ref, wa.ad, wa.msgs,
             COALESCE((c.created_at AT TIME ZONE '${TZ}')::date = wa.day, false) AS is_new,
             (NOT wa.ad AND EXISTS (SELECT 1 FROM sends s WHERE s.ref = wa.ref AND s.at >= wa.first_at - interval '24 hours' AND s.at < wa.first_at)) AS broadcast
      FROM wa LEFT JOIN customers c ON c.whatsapp_number = wa.ref`, [a, b]),
    pool.query(`
      SELECT to_char((sm.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, 1 AS line, sc.provider AS channel, 'social:' || sc.id AS ref, false AS ad, count(*) AS msgs,
             COALESCE(bool_or((c.created_at AT TIME ZONE '${TZ}')::date = (sm.created_at AT TIME ZONE '${TZ}')::date), false) AS is_new, false AS broadcast
      FROM social_messages sm JOIN social_contacts sc ON sc.id = sm.contact_id LEFT JOIN customers c ON c.id = sc.customer_id
      WHERE sm.direction = 'in' AND sm.created_at >= ${START('$1')} AND sm.created_at < ${END('$2')}
      GROUP BY 1, 3, sc.id`, [a, b]),
    pool.query(`
      SELECT to_char((h.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, COALESCE((regexp_match(h.session_id, '__line_(\\d+)'))[1]::int, h.whatsapp_number_id, 1) AS line,
             extract(hour FROM h.created_at AT TIME ZONE '${TZ}')::int AS hour, count(DISTINCT h.session_id) AS n
      FROM n8n_chat_histories h WHERE h.message->>'type' = 'human' AND h.created_at >= ${START('$1')} AND h.created_at < ${END('$2')} GROUP BY 1, 2, 3`, [a, b]),
    pool.query(`
      SELECT to_char((sm.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, 1 AS line, extract(hour FROM sm.created_at AT TIME ZONE '${TZ}')::int AS hour, count(DISTINCT sm.contact_id) AS n
      FROM social_messages sm WHERE sm.direction = 'in' AND sm.created_at >= ${START('$1')} AND sm.created_at < ${END('$2')} GROUP BY 1, 3`, [a, b]),
  ]);
  return { conv: [...wa.rows, ...soc.rows].map((r) => ({ ...r, line: Number(r.line), msgs: Number(r.msgs) })), hours: [...hwa.rows, ...hsoc.rows].map((r) => ({ ...r, line: Number(r.line), n: Number(r.n) })) };
}

const inflight = new Map();

// Guarda en las tablas los días ya cerrados de [from, to] que todavía no están (o que se calcularon con otra regla de difusiones).
export async function ensureDays(from, to) {
  const end = to < addDay(gtToday(), -1) ? to : addDay(gtToday(), -1);
  if (from > end) return;
  const pattern = await servicePattern();
  const { rows } = await pool.query('SELECT to_char(day, \'YYYY-MM-DD\') AS day FROM stats_days_done WHERE day BETWEEN $1 AND $2 AND rules = $3', [from, end, pattern]);
  const done = new Set(rows.map((r) => r.day));
  const missing = [];
  for (let d = from; d <= end; d = addDay(d, 1)) if (!done.has(d)) missing.push(d);
  // tramos de días seguidos, de a CHUNK_DAYS como máximo (una consulta enorme no es mejor que varias)
  const ranges = [];
  for (const d of missing) {
    const last = ranges[ranges.length - 1];
    if (last && addDay(last.b, 1) === d && last.n < CHUNK_DAYS) { last.b = d; last.n += 1; } else ranges.push({ a: d, b: d, n: 1 });
  }
  for (const { a, b } of ranges) {
    const key = `${a}|${b}|${pattern}`;
    if (!inflight.has(key)) inflight.set(key, persist(a, b, pattern).finally(() => inflight.delete(key)));
    await inflight.get(key);
  }
}

async function persist(a, b, pattern) {
  const { conv, hours } = await computeRange(a, b, pattern);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM stats_conv_days WHERE day BETWEEN $1 AND $2', [a, b]);
    await client.query('DELETE FROM stats_hour_days WHERE day BETWEEN $1 AND $2', [a, b]);
    for (let i = 0; i < conv.length; i += 4000) {
      const p = conv.slice(i, i + 4000);
      await client.query(
        `INSERT INTO stats_conv_days (day, line, channel, ref, ad, broadcast, is_new, msgs)
         SELECT * FROM unnest($1::date[], $2::int[], $3::text[], $4::text[], $5::bool[], $6::bool[], $7::bool[], $8::int[]) ON CONFLICT DO NOTHING`,
        [p.map((r) => r.day), p.map((r) => r.line), p.map((r) => r.channel), p.map((r) => r.ref), p.map((r) => r.ad), p.map((r) => r.broadcast), p.map((r) => r.is_new), p.map((r) => r.msgs)]
      );
    }
    if (hours.length) {
      await client.query('INSERT INTO stats_hour_days (day, line, hour, n) SELECT * FROM unnest($1::date[], $2::int[], $3::int[], $4::int[]) ON CONFLICT DO NOTHING',
        [hours.map((r) => r.day), hours.map((r) => r.line), hours.map((r) => r.hour), hours.map((r) => r.n)]);
    }
    await client.query(`INSERT INTO stats_days_done (day, rules) SELECT d::date, $3 FROM generate_series($1::date, $2::date, interval '1 day') d
      ON CONFLICT (day) DO UPDATE SET rules = EXCLUDED.rules, computed_at = now()`, [a, b, pattern]);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
}

// Mantiene al día los últimos días en segundo plano, para que abrir las Estadísticas no tenga que calcularlos.
export function startStatsWarmup() {
  const run = () => ensureDays(addDay(gtToday(), -45), addDay(gtToday(), -1)).catch((err) => console.error('[stats] warmup:', err.message));
  setTimeout(run, 30000);
  setInterval(run, 60 * 60 * 1000);
}

async function loadRows(from, to) {
  const today = gtToday();
  await ensureDays(from, to);
  const pastEnd = to < today ? to : addDay(today, -1);
  const conv = []; const hours = [];
  if (from <= pastEnd) {
    const [c, h] = await Promise.all([
      pool.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, line, channel, ref, ad, broadcast, is_new, msgs FROM stats_conv_days WHERE day BETWEEN $1 AND $2", [from, pastEnd]),
      pool.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, line, hour, n FROM stats_hour_days WHERE day BETWEEN $1 AND $2", [from, pastEnd]),
    ]);
    conv.push(...c.rows); hours.push(...h.rows);
  }
  if (from <= today && to >= today) {
    const live = await computeRange(today, today, await servicePattern());
    conv.push(...live.conv); hours.push(...live.hours);
  }
  return { conv, hours };
}

// Lo que usa el modal: por día (canal, origen), resumen del periodo y conversaciones por hora. lineIds vacío = todas las líneas.
export async function loadConversationStats({ from, to, lineIds }) {
  const { conv, hours } = await loadRows(from, to);
  const lineOk = (l) => !lineIds?.length || lineIds.includes(Number(l));
  // Con varias líneas, el mismo cliente el mismo día cuenta una sola vez.
  const merged = new Map();
  for (const r of conv.filter((x) => lineOk(x.line))) {
    const k = `${r.day}|${r.ref}|${r.channel}`;
    const m = merged.get(k);
    if (!m) merged.set(k, { ...r });
    else { m.ad = m.ad || r.ad; m.broadcast = m.broadcast || r.broadcast; m.is_new = m.is_new || r.is_new; m.msgs += r.msgs; }
  }
  const daily = new Map();
  const people = new Map();
  for (const r of merged.values()) {
    const origin = r.channel !== 'whatsapp' ? 'social' : r.ad ? 'ads' : r.broadcast ? 'broadcast' : 'organic';
    const d = daily.get(r.day) ?? { day: r.day, total: 0, messages: 0, whatsapp: 0, instagram: 0, messenger: 0, ads: 0, broadcast: 0, organic: 0, social: 0 };
    d.messages += Number(r.msgs) || 0;
    d.total += 1; d[r.channel] = (d[r.channel] ?? 0) + 1; d[origin] += 1;
    daily.set(r.day, d);
    const p = people.get(r.ref) ?? { channel: r.channel, origin: 'organic', isNew: false };
    if (origin === 'ads' || (origin === 'broadcast' && p.origin !== 'ads')) p.origin = origin;
    p.isNew = p.isNew || !!r.is_new;
    people.set(r.ref, p);
  }
  const list = [...people.values()];
  const count = (fn) => list.filter(fn).length;
  // Total gerencial (como lo arma el trafficker): anuncios de WhatsApp + respuestas a difusión + Instagram + Messenger. No incluye el orgánico de WhatsApp.
  const days = [...daily.values()].map((d) => ({ ...d, managerTotal: d.ads + d.broadcast + d.social })).sort((a, b) => a.day.localeCompare(b.day));
  const sum = (k) => days.reduce((n, d) => n + (d[k] ?? 0), 0);
  const byHour = {};
  for (const h of hours.filter((x) => lineOk(x.line))) byHour[h.hour] = (byHour[h.hour] ?? 0) + Number(h.n);
  return {
    daily: days,
    byHour,
    summary: {
      // Conversaciones = clientes por día, sumados (como cuentan Meta y el Excel gerencial); "clientes distintos" es aparte.
      conversations: sum('total'), messages: sum('messages'),
      byChannel: { whatsapp: sum('whatsapp'), instagram: sum('instagram'), messenger: sum('messenger') },
      byOrigin: { ads: sum('ads'), broadcast: sum('broadcast'), organic: sum('organic'), social: sum('social') }, managerTotal: sum('managerTotal'),
      people: list.length, newPeople: count((p) => p.isNew), returning: count((p) => !p.isNew),
    },
  };
}
