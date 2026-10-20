import { pool } from './db.js';
import { guatemalaParts } from './salesRules.js';
import { analyzeCustomer, nameResolver } from './salesThreads.js';
import { createLazyOcrRunner } from './ocrRunner.js';

// CIERRE DEL DÍA: lo que cada asesora lleva vendido en un día "hasta una hora" (corte). Se calcula leyendo los
// chats como estaban a esa hora: Pagado = comprobante del cliente (monto exacto) o confirmación de la asesora;
// Pendiente = medios de pago entregados, todavía sin comprobante ni confirmación. A las 4 pm una venta con link
// enviado es pendiente; si el cliente paga a las 6 pm, el cierre de las 9 pm la cuenta como pagada.
//
// Función pura (sin base de datos), probada en salesClose.test.js.
const round2 = (n) => Math.round(n * 100) / 100;
const porValidar = (r) => r.amountBasis === 'precio_aprobado' || r.attributionUncertain;

export function summarizeClose({ day, asOf, rows, pending, sales }) {
  const by = new Map();
  const get = (name) => {
    const key = name ?? 'Sin atribuir';
    if (!by.has(key)) {
      by.set(key, { advisor: key, pagado: 0, pagadoN: 0, manana: 0, tarde: 0, domingo: 0, fueraDeTurno: 0, porValidar: 0, porValidarN: 0, sinConfirmarN: 0, pendiente: 0, pendienteN: 0, pendienteSinMontoN: 0, soloMediosN: 0, registrado: 0, registradoN: 0 });
    }
    return by.get(key);
  };

  const paid = [];
  for (const r of rows) {
    if (guatemalaParts(r.at).ymd !== day) continue;
    // Un comprobante cuenta apenas llega; una confirmación sin comprobante cuenta con el precio aprobado (por validar).
    const counts = r.type === 'comprobante' || r.verified;
    if (!counts) continue;
    const a = get(r.advisor);
    const amount = r.amount ?? 0;
    a.pagado += amount; a.pagadoN++;
    const turno = { manana: 'manana', tarde: 'tarde', domingo: 'domingo' }[r.shift] ?? 'fueraDeTurno';
    a[turno] += amount;
    if (porValidar(r)) { a.porValidar += amount; a.porValidarN++; }
    if (r.type === 'comprobante' && !r.verified) a.sinConfirmarN++;
    paid.push(r);
  }

  const pend = [];
  for (const p of pending) {
    // "Pendiente" real: el cliente aceptó lo cotizado o respondió después de recibir los medios de pago.
    const real = p.customerAccepted || p.customerReplied;
    const a = get(p.advisor);
    if (real) { a.pendienteN++; if (p.amount != null) a.pendiente += p.amount; else a.pendienteSinMontoN++; }
    else a.soloMediosN++;
    pend.push({ ...p, real });
  }

  for (const s of sales) {
    if (guatemalaParts(s.created_at).ymd !== day || +new Date(s.created_at) > +new Date(asOf)) continue;
    if (s.status !== 'confirmada' || !(Number(s.amount) > 0)) continue;
    const a = get(s.advisorCanonical ?? s.advisor_name);
    a.registrado += Number(s.amount); a.registradoN++;
  }

  const advisors = [...by.values()].map((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'number' ? round2(v) : v])))
    .map((a) => ({ ...a, diferencia: round2(a.pagado - a.registrado) }))
    .sort((x, y) => y.pagado - x.pagado);
  const sum = (k) => round2(advisors.reduce((t, a) => t + a[k], 0));
  return {
    day, asOf,
    totals: Object.fromEntries(['pagado', 'pagadoN', 'manana', 'tarde', 'domingo', 'fueraDeTurno', 'porValidar', 'porValidarN', 'sinConfirmarN', 'pendiente', 'pendienteN', 'pendienteSinMontoN', 'soloMediosN', 'registrado', 'registradoN', 'diferencia'].map((k) => [k, sum(k)])),
    advisors, paid, pending: pend,
  };
}

// Hora de corte en Guatemala: "16:00" del día dado, o el fin del día; si es hoy y no se pide hora, ahora mismo.
export function closeCutoff(day, hhmm = null, now = new Date()) {
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:59.999-06:00`);
  }
  const endOfDay = new Date(`${day}T23:59:59.999-06:00`);
  return guatemalaParts(now).ymd === day ? now : endOfDay;
}

export async function computeClose({ day, asOf: hhmm = null, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw Object.assign(new Error('La fecha debe ser AAAA-MM-DD'), { status: 400 });
  const asOf = closeCutoff(day, hhmm, now);
  const start = new Date(`${day}T00:00:00-06:00`);
  // Clientes con algún mensaje desde el día anterior hasta el corte (los medios de pago pudieron enviarse la noche anterior).
  const { rows: customers } = await pool.query(
    `SELECT DISTINCT c.id, c.whatsapp_number, c.full_name, c.manual_status
     FROM n8n_chat_histories h JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
     WHERE h.created_at >= $1 AND h.created_at <= $2`,
    [new Date(+start - 24 * 3600000), asOf]
  );
  const canonical = nameResolver();
  const ocr = createLazyOcrRunner({ maxReads: 100 });
  const rows = [];
  const pending = [];
  try {
    for (const c of customers) {
      try {
        const r = await analyzeCustomer(c, { canonical, ocr, asOf });
        rows.push(...r.rows);
        pending.push(...r.pending);
      } catch (err) {
        console.error(`close: customer ${c.id} failed`, err.message);
      }
    }
  } finally {
    await ocr.close();
  }
  const { rows: sales } = await pool.query(
    `SELECT id, customer_id, created_at, amount, status, advisor_name FROM sales WHERE created_at >= $1 AND created_at <= $2`, [start, asOf]
  );
  for (const s of sales) s.advisorCanonical = (await canonical(s.advisor_name)) ?? s.advisor_name;
  return { ...summarizeClose({ day, asOf: asOf.toISOString(), rows, pending, sales }), customersAnalyzed: customers.length, generatedAt: new Date().toISOString() };
}

export async function saveClose({ day, asOf, label = null, userId = null }) {
  const result = await computeClose({ day, asOf });
  const { rows } = await pool.query(
    'INSERT INTO sales_closes (day, as_of, label, result, created_by) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id, created_at',
    [day, result.asOf, label, JSON.stringify(result), userId]
  );
  return { id: rows[0].id, createdAt: rows[0].created_at, ...result };
}

export async function listCloses(day = null) {
  const { rows } = await pool.query(
    `SELECT id, day::text AS day, as_of, label, created_at, (result->'totals') AS totals FROM sales_closes
     WHERE ($1::date IS NULL OR day = $1::date) ORDER BY id DESC LIMIT 60`, [day]
  );
  return rows;
}

export async function getClose(id) {
  const { rows } = await pool.query('SELECT id, day::text AS day, as_of, label, created_at, result FROM sales_closes WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// Cierres automáticos: 4 pm y 9 pm de Guatemala (cada uno se guarda una sola vez al día).
const AUTO_CLOSES = [{ hhmm: '16:00', label: 'Corte automático 4 pm' }, { hhmm: '21:00', label: 'Corte automático 9 pm' }];
export function startCloseScheduler() {
  setInterval(async () => {
    try {
      const gt = guatemalaParts(new Date());
      const nowHm = `${String(gt.hour).padStart(2, '0')}:${String(gt.minute).padStart(2, '0')}`;
      for (const c of AUTO_CLOSES) {
        // Una ventana de 10 min tras la hora, por si el servidor estaba reiniciándose justo a las 4:00.
        const [h, m] = c.hhmm.split(':').map(Number);
        const mins = gt.hour * 60 + gt.minute;
        if (mins < h * 60 + m || mins >= h * 60 + m + 10) continue;
        const { rows } = await pool.query('SELECT 1 FROM sales_closes WHERE day = $1 AND label = $2 LIMIT 1', [gt.ymd, c.label]);
        if (rows.length) continue;
        await saveClose({ day: gt.ymd, asOf: c.hhmm, label: c.label });
        console.log(`close: ${c.label} guardado para ${gt.ymd} (${nowHm})`);
      }
    } catch (err) {
      console.error('close scheduler failed', err.message);
    }
  }, 60 * 1000).unref();
}
