import { pool } from './db.js';
import { guatemalaParts } from './salesRules.js';
import { analyzeCustomer, nameResolver } from './salesThreads.js';
import { createLazyOcrRunner } from './ocrRunner.js';
import { compareWithRegistered } from './salesComparison.js';

// Análisis histórico (solo lectura): recorre el chat completo de cada cliente que compró
// ("Pagado", "Por despacho" o con ventas registradas) y reconstruye cada venta con la MISMA
// definición que usa el motor en vivo (buildEpisodes): medios de pago → prueba del cliente →
// confirmación de la asesora. No escribe nada en ventas ni en clientes: guarda el informe en
// sales_analysis_runs y el resultado de leer cada adjunto en attachment_ocr (caché).
const STALE_MS = 5 * 60 * 1000;

// Por defecto: desde el día 1 del mes pasado hasta hoy (hora de Guatemala).
export function defaultPeriod(now = new Date()) {
  const to = guatemalaParts(now).ymd;
  const [y, m] = to.split('-').map(Number);
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  return { from: `${prev[0]}-${String(prev[1]).padStart(2, '0')}-01`, to };
}

function summarize({ rows, orphans, withoutEvidence, resent, customersAnalyzed, period, comparison }) {
  const by = {};
  const quality = {
    pendientesDeConfirmar: 0, montoPorValidar: 0, comprobantesSinContexto: orphans.length, sinMediosDePagoEnChat: 0, montoNoLeido: 0,
    montoDistintoACotizacion: 0, variasAsesoras: 0, asesoraPorValidar: 0, sinAsesora: 0, sinPruebaDelCliente: 0, precioSinAprobacion: 0, imagenesSinMonto: 0,
  };
  const advisorOf = (r) => r.advisor ?? 'Sin atribuir';
  for (const r of rows) {
    const a = (by[advisorOf(r)] ??= { advisor: advisorOf(r), ventas: 0, total: 0, sinMonto: 0, pendientes: 0, pendienteTotal: 0, porValidar: 0, porValidarTotal: 0, porTurno: {}, porMedio: {}, porRegla: {} });
    if (r.verified) {
      a.ventas++;
      if (r.amount) a.total += r.amount; else a.sinMonto++;
      a.porTurno[r.shift] = (a.porTurno[r.shift] ?? 0) + (r.amount ?? 0);
      a.porMedio[r.medium ?? 'sin_dato'] = (a.porMedio[r.medium ?? 'sin_dato'] ?? 0) + 1;
      a.porRegla[r.rule ?? 'sin_atribuir'] = (a.porRegla[r.rule ?? 'sin_atribuir'] ?? 0) + 1;
      if (r.amountBasis === 'precio_aprobado' || r.attributionUncertain) { a.porValidar++; a.porValidarTotal += r.amount ?? 0; quality.montoPorValidar++; }
    } else {
      a.pendientes++;
      a.pendienteTotal += r.amount ?? 0;
      quality.pendientesDeConfirmar++;
    }
    for (const [issue, key] of [['sin_medios_de_pago_en_chat', 'sinMediosDePagoEnChat'], ['monto_no_leido', 'montoNoLeido'], ['monto_distinto_a_cotizacion', 'montoDistintoACotizacion'], ['varias_asesoras', 'variasAsesoras'], ['asesora_por_validar', 'asesoraPorValidar'], ['sin_asesora', 'sinAsesora'], ['sin_prueba_del_cliente', 'sinPruebaDelCliente'], ['precio_sin_aprobacion_del_cliente', 'precioSinAprobacion']]) {
      if (r.issues.includes(issue)) quality[key]++;
    }
    quality.imagenesSinMonto += r.imagesWithoutAmount;
  }
  const verified = rows.filter((r) => r.verified);
  return {
    generatedAt: new Date().toISOString(), customersAnalyzed, period, comparison,
    ventas: verified.length, ventasPendientes: rows.length - verified.length,
    totalQuetzales: verified.reduce((s, r) => s + (r.amount ?? 0), 0), comprobantesReenviados: resent,
    clientesSinEvidencia: withoutEvidence.length, quality,
    byAdvisor: Object.values(by).sort((x, y) => y.total - x.total),
    rows, orphans, withoutEvidence,
  };
}

async function runAnalysis(runId, period) {
  const { rows: customers } = await pool.query(
    `SELECT c.id, c.whatsapp_number, c.full_name, c.manual_status FROM customers c
     WHERE c.manual_status IN ('pagado', 'despacho') OR c.paid_locked
        OR EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id)
     ORDER BY c.id`
  );
  await pool.query('UPDATE sales_analysis_runs SET total = $2, updated_at = now() WHERE id = $1', [runId, customers.length]);
  const canonical = nameResolver();
  const ocr = createLazyOcrRunner();
  const rows = [];
  const orphans = [];
  const withoutEvidence = [];
  let resent = 0;
  try {
    for (let i = 0; i < customers.length; i++) {
      const c = customers[i];
      try {
        const r = await analyzeCustomer(c, { canonical, ocr });
        resent += r.resentReceipts;
        orphans.push(...r.orphans);
        if (r.rows.length) rows.push(...r.rows);
        else withoutEvidence.push({ customerId: c.id, customer: c.full_name || c.whatsapp_number, phone: c.whatsapp_number, last4: c.whatsapp_number.slice(-4), currentStatus: c.manual_status });
      } catch (err) {
        console.error(`analysis: customer ${c.id} failed`, err.message);
      }
      if ((i + 1) % 10 === 0) await pool.query('UPDATE sales_analysis_runs SET progress = $2, updated_at = now() WHERE id = $1', [runId, i + 1]);
    }
  } finally {
    await ocr.close();
  }
  rows.sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const inPeriod = (d) => { const y = guatemalaParts(d).ymd; return y >= period.from && y <= period.to; };
  const periodRows = rows.filter((r) => inPeriod(r.at));
  const periodOrphans = orphans.filter((o) => inPeriod(o.at));
  const { rows: sales } = await pool.query(
    `SELECT s.id, s.customer_id, s.created_at, s.amount, s.status, s.advisor_name, s.attribution_locked, c.full_name AS customer_name, c.whatsapp_number AS phone
     FROM sales s JOIN customers c ON c.id = s.customer_id
     WHERE s.created_at >= $1::timestamptz - interval '2 days' AND s.created_at <= $2::timestamptz + interval '3 days'`,
    [`${period.from}T00:00:00-06:00`, `${period.to}T23:59:59-06:00`]
  );
  for (const s of sales) s.advisorCanonical = (await canonical(s.advisor_name)) ?? s.advisor_name;
  const comparison = compareWithRegistered({ engineRows: rows, sales, from: period.from, to: period.to });
  await pool.query(
    `UPDATE sales_analysis_runs SET status = 'done', progress = $2, result = $3::jsonb, updated_at = now() WHERE id = $1`,
    [runId, customers.length, JSON.stringify(summarize({ rows: periodRows, orphans: periodOrphans, withoutEvidence, resent, customersAnalyzed: customers.length, period, comparison }))]
  );
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function startAnalysisRun(userId, range = {}) {
  const def = defaultPeriod();
  const period = { from: YMD.test(range.from ?? '') ? range.from : def.from, to: YMD.test(range.to ?? '') ? range.to : def.to };
  const { rows: running } = await pool.query(
    `SELECT id FROM sales_analysis_runs WHERE status = 'running' AND updated_at > now() - ($1::int * interval '1 millisecond') LIMIT 1`, [STALE_MS]
  );
  if (running.length) return { id: running[0].id, alreadyRunning: true };
  const { rows } = await pool.query('INSERT INTO sales_analysis_runs (created_by) VALUES ($1) RETURNING id', [userId ?? null]);
  const id = rows[0].id;
  // Corre en segundo plano: leer miles de chats y adjuntos puede tardar de minutos a horas.
  setImmediate(() => runAnalysis(id, period).catch(async (err) => {
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
    return (await pool.query('SELECT id, whatsapp_number, full_name, manual_status FROM customers WHERE whatsapp_number LIKE $1 LIMIT 6', [`%${t}`])).rows;
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
      const { rows } = await analyzeCustomer(c, { canonical });
      for (const r of rows) {
        if (!entry.date || dayDiff(guatemalaParts(r.at).ymd, entry.date) <= 1) candidates.push(r);
      }
    }
    if (!candidates.length) { out.push({ ...base, verdict: 'sin_venta_en_chat' }); continue; }
    // Si el cuaderno trae monto, se prefiere la venta que coincide; si no, la primera de esa fecha.
    const pick = candidates.find((r) => entry.amount && r.amount && Math.abs(r.amount - entry.amount) < 0.5) ?? candidates[0];
    const diffs = [];
    if (entry.advisor && firstToken(pick.advisor) !== firstToken(entry.advisor)) diffs.push('asesora_distinta');
    if (entry.amount && (!pick.amount || Math.abs(pick.amount - entry.amount) >= 0.5)) diffs.push('monto_distinto');
    if (entry.medium && pick.medium && pick.medium !== entry.medium) diffs.push('medio_distinto');
    out.push({
      ...base, verdict: diffs.length ? 'con_diferencias' : 'coincide', diffs,
      sale: { at: pick.at, advisor: pick.advisor, amount: pick.amount, medium: pick.medium, paymentInfoBy: pick.paymentInfoBy, shift: pick.shift, type: pick.type, rule: pick.rule, verified: pick.verified, confirmedBy: pick.confirmedBy, voucher: pick.voucher, amountBasis: pick.amountBasis },
      otherSales: candidates.length - 1,
    });
  }
  return out;
}
