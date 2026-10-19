import { pool } from './db.js';
import { buildEpisodes, guatemalaParts } from './salesRules.js';
import { loadEvents, defaultLineId, lineFromSession, resolveAdvisor } from './salesAttribution.js';

// Análisis histórico (solo lectura): recorre el chat completo de cada cliente que compró
// ("Pagado", "Por despacho" o con ventas registradas) y reconstruye cada venta con su
// comprobante, quién dio los medios de pago, cuánto se cotizó y quién la atendía. No
// escribe nada en ventas ni en clientes: solo guarda el informe en sales_analysis_runs.
const STALE_MS = 5 * 60 * 1000;

async function threadLines(phone) {
  if (phone.startsWith('social:')) return [null];
  const { rows } = await pool.query(
    `SELECT DISTINCT session_id FROM n8n_chat_histories WHERE session_id = $1 OR session_id LIKE $1 || '\\_\\_%'`, [phone]
  );
  const fallback = await defaultLineId();
  return [...new Set(rows.map((r) => lineFromSession(r.session_id) ?? fallback))];
}

function nameResolver() {
  const cache = new Map();
  return async (name) => {
    if (!name) return null;
    if (!cache.has(name)) cache.set(name, (await resolveAdvisor(name)).name);
    return cache.get(name);
  };
}

export async function analyzeCustomer(customer, canonical = nameResolver()) {
  const rows = [];
  let resentReceipts = 0;
  for (const line of await threadLines(customer.whatsapp_number)) {
    const events = await loadEvents({
      phone: customer.whatsapp_number, customerId: customer.id, lineId: line,
      from: new Date(0), to: new Date(Date.now() + 86400000),
    });
    if (line !== null) {
      const ids = events.filter((e) => e.role === 'customer' && !e.ocrAmount).map((e) => e.id);
      if (ids.length) {
        const { rows: imgs } = await pool.query(
          `SELECT DISTINCT n8n_message_id FROM message_attachments WHERE kind = 'image' AND n8n_message_id = ANY($1::int[])`, [ids]
        );
        const withImage = new Set(imgs.map((r) => Number(r.n8n_message_id)));
        for (const e of events) if (withImage.has(e.id)) e.image = true;
      }
    }
    const built = buildEpisodes(events);
    resentReceipts += built.resentReceipts;
    for (const ep of built.episodes) {
      rows.push({
        at: ep.at, customerId: customer.id, customer: customer.full_name || customer.whatsapp_number,
        phone: customer.whatsapp_number, last4: customer.whatsapp_number.slice(-4), line,
        currentStatus: customer.manual_status ?? null, type: ep.type, amount: ep.amount, quote: ep.quote,
        advisor: await canonical(ep.advisor), rule: ep.rule, paymentInfoBy: await canonical(ep.paymentInfoBy),
        medium: ep.medium, shift: ep.shift, touchedBy: await Promise.all(ep.touchedBy.map(canonical)),
        confirmedBy: await canonical(ep.confirmedBy), imagesWithoutAmount: ep.imagesWithoutAmount, issues: ep.issues,
      });
    }
  }
  return { rows, resentReceipts };
}

function summarize(rows, withoutEvidence, resentReceipts, customersAnalyzed) {
  const by = {};
  const quality = { sinMediosDePagoEnChat: 0, montoNoLeido: 0, montoDistintoACotizacion: 0, variasAsesoras: 0, sinAsesora: 0, imagenesSinMonto: 0 };
  for (const r of rows) {
    const a = (by[r.advisor ?? 'Sin atribuir'] ??= { advisor: r.advisor ?? 'Sin atribuir', ventas: 0, total: 0, sinMonto: 0, porTurno: {}, porMedio: {}, porRegla: {} });
    a.ventas++;
    if (r.amount) a.total += r.amount; else a.sinMonto++;
    a.porTurno[r.shift] = (a.porTurno[r.shift] ?? 0) + (r.amount ?? 0);
    a.porMedio[r.medium ?? 'sin_dato'] = (a.porMedio[r.medium ?? 'sin_dato'] ?? 0) + 1;
    a.porRegla[r.rule ?? 'sin_atribuir'] = (a.porRegla[r.rule ?? 'sin_atribuir'] ?? 0) + 1;
    if (r.issues.includes('sin_medios_de_pago_en_chat')) quality.sinMediosDePagoEnChat++;
    if (r.issues.includes('monto_no_leido')) quality.montoNoLeido++;
    if (r.issues.includes('monto_distinto_a_cotizacion')) quality.montoDistintoACotizacion++;
    if (r.issues.includes('varias_asesoras')) quality.variasAsesoras++;
    if (r.issues.includes('sin_asesora')) quality.sinAsesora++;
    quality.imagenesSinMonto += r.imagesWithoutAmount;
  }
  return {
    generatedAt: new Date().toISOString(), customersAnalyzed, ventas: rows.length,
    totalQuetzales: rows.reduce((s, r) => s + (r.amount ?? 0), 0), comprobantesReenviados: resentReceipts,
    clientesSinEvidencia: withoutEvidence.length, quality,
    byAdvisor: Object.values(by).sort((x, y) => y.total - x.total),
    rows, withoutEvidence,
  };
}

async function runAnalysis(runId) {
  const { rows: customers } = await pool.query(
    `SELECT c.id, c.whatsapp_number, c.full_name, c.manual_status FROM customers c
     WHERE c.manual_status IN ('pagado', 'despacho') OR c.paid_locked
        OR EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id)
     ORDER BY c.id`
  );
  await pool.query('UPDATE sales_analysis_runs SET total = $2, updated_at = now() WHERE id = $1', [runId, customers.length]);
  const canonical = nameResolver();
  const rows = [];
  const withoutEvidence = [];
  let resent = 0;
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    try {
      const r = await analyzeCustomer(c, canonical);
      resent += r.resentReceipts;
      if (r.rows.length) rows.push(...r.rows);
      else withoutEvidence.push({ customerId: c.id, customer: c.full_name || c.whatsapp_number, phone: c.whatsapp_number, last4: c.whatsapp_number.slice(-4), currentStatus: c.manual_status });
    } catch (err) {
      console.error(`analysis: customer ${c.id} failed`, err.message);
    }
    if ((i + 1) % 20 === 0) await pool.query('UPDATE sales_analysis_runs SET progress = $2, updated_at = now() WHERE id = $1', [runId, i + 1]);
  }
  rows.sort((a, b) => +new Date(a.at) - +new Date(b.at));
  await pool.query(
    `UPDATE sales_analysis_runs SET status = 'done', progress = $2, result = $3::jsonb, updated_at = now() WHERE id = $1`,
    [runId, customers.length, JSON.stringify(summarize(rows, withoutEvidence, resent, customers.length))]
  );
}

export async function startAnalysisRun(userId) {
  const { rows: running } = await pool.query(
    `SELECT id FROM sales_analysis_runs WHERE status = 'running' AND updated_at > now() - ($1::int * interval '1 millisecond') LIMIT 1`, [STALE_MS]
  );
  if (running.length) return { id: running[0].id, alreadyRunning: true };
  const { rows } = await pool.query('INSERT INTO sales_analysis_runs (created_by) VALUES ($1) RETURNING id', [userId ?? null]);
  const id = rows[0].id;
  // Corre en segundo plano: el informe puede tardar minutos con miles de chats.
  setImmediate(() => runAnalysis(id).catch(async (err) => {
    console.error('sales analysis failed', err);
    await pool.query(`UPDATE sales_analysis_runs SET status = 'error', error = $2, updated_at = now() WHERE id = $1`, [id, String(err.message).slice(0, 500)]);
  }));
  return { id };
}

export async function getAnalysisRun(id, { full = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, status, progress, total, error, created_at, updated_at, ${full ? 'result' : 'NULL::jsonb AS result'},
            (status = 'running' AND updated_at < now() - ($2::int * interval '1 millisecond')) AS stalled
     FROM sales_analysis_runs WHERE ${id ? 'id = $1' : '$1::int IS NULL'} ORDER BY id DESC LIMIT 1`,
    [id ?? null, STALE_MS]
  );
  return rows[0] ?? null;
}

// --- Contraste con los cuadernos de las asesoras -------------------------------------------
// entry: { date?: 'YYYY-MM-DD', advisor?: string, ref: '4947' | 'Marina Reyes', medium?: 'link'|'transferencia', amount?: number }
async function findCustomers(ref) {
  const t = String(ref ?? '').trim();
  if (/^\d{4}$/.test(t)) {
    return (await pool.query(`SELECT id, whatsapp_number, full_name, manual_status FROM customers WHERE whatsapp_number LIKE $1 LIMIT 6`, [`%${t}`])).rows;
  }
  const tokens = t.split(/\s+/).filter((x) => x.length > 1);
  if (!tokens.length) return [];
  return (await pool.query(
    `SELECT id, whatsapp_number, full_name, manual_status FROM customers WHERE ${tokens.map((_, i) => `full_name ILIKE $${i + 1}`).join(' AND ')} LIMIT 6`,
    tokens.map((x) => `%${x}%`)
  )).rows;
}

const firstToken = (s) => String(s ?? '').trim().toLowerCase().split(/\s+/)[0];
const dayDiff = (a, b) => Math.abs((+new Date(`${a}T00:00:00Z`) - +new Date(`${b}T00:00:00Z`)) / 86400000);

export async function crossCheckNotebook(entries) {
  const canonical = nameResolver();
  const out = [];
  for (const entry of entries.slice(0, 200)) {
    const customers = await findCustomers(entry.ref);
    const base = { entry, matches: customers.map((c) => ({ customerId: c.id, customer: c.full_name || c.whatsapp_number, phone: c.whatsapp_number, status: c.manual_status })) };
    if (!customers.length) { out.push({ ...base, verdict: 'cliente_no_encontrado' }); continue; }
    const candidates = [];
    for (const c of customers) {
      const { rows } = await analyzeCustomer(c, canonical);
      for (const r of rows) {
        if (!entry.date || dayDiff(guatemalaParts(r.at).ymd, entry.date) <= 1) candidates.push(r);
      }
    }
    if (!candidates.length) { out.push({ ...base, verdict: 'sin_venta_en_chat' }); continue; }
    // Si el cuaderno trae monto, se prefiere la venta que coincide; si no, la más cercana a la fecha.
    const pick = candidates.find((r) => entry.amount && r.amount && Math.abs(r.amount - entry.amount) < 0.5) ?? candidates[0];
    const diffs = [];
    if (entry.advisor && firstToken(pick.advisor) !== firstToken(entry.advisor)) diffs.push('asesora_distinta');
    if (entry.amount && (!pick.amount || Math.abs(pick.amount - entry.amount) >= 0.5)) diffs.push('monto_distinto');
    if (entry.medium && pick.medium && pick.medium !== entry.medium) diffs.push('medio_distinto');
    out.push({
      ...base, verdict: diffs.length ? 'con_diferencias' : 'coincide', diffs,
      sale: { at: pick.at, advisor: pick.advisor, amount: pick.amount, medium: pick.medium, paymentInfoBy: pick.paymentInfoBy, shift: pick.shift, type: pick.type, rule: pick.rule },
      otherSales: candidates.length - 1,
    });
  }
  return out;
}
