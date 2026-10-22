import { pool } from './db.js';
import { getSetting } from './routes/settings.js';
import { saveAttachment } from './attachmentStorage.js';
import {
  TRANSITIONS, ROLES, STATUS, BOARD, TERMINAL, EDITABLE_STATUSES, LOGISTICS_DEFAULTS, stepsFor, allowedFor, validateFields, addBusinessDays, requiredPayment,
  sheetMissing, computeTotals, settleAudit, slaForStatus,
} from './logisticsFlow.js';

// Servicio del módulo logístico: fichas de pedido, auditoría de pagos y avance por el flujo. Cada cambio deja un sello inmutable en
// order_sheet_events (quién, cuándo, qué cambió, qué evidencia) y la ficha solo se mueve por los pasos que declara logisticsFlow.js.
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const r2 = (n) => Math.round(Number(n) * 100) / 100;

export async function getConfig() {
  const saved = (await getSetting('logistics_config', {})) ?? {};
  return { ...LOGISTICS_DEFAULTS, ...saved, sla: { ...LOGISTICS_DEFAULTS.sla, ...(saved.sla ?? {}) } };
}

const CONFIG_TYPES = { enforceSod: 'boolean', adminAllRoles: 'boolean', totalBusinessDays: 'int', holidays: 'dates', amountToleranceQ: 'number', codAdvancePct: 'number', codMaxAttempts: 'int', dispatchWarehouse: 'string', warehouses: 'strings', sla: 'sla' };
export async function saveConfig(patch, user) {
  const cur = await getConfig();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch ?? {})) {
    const t = CONFIG_TYPES[k];
    if (!t) continue;
    if (t === 'boolean') next[k] = v === true;
    else if (t === 'int' || t === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || (t === 'int' && !Number.isInteger(n))) throw fail(400, `Valor no válido en ${k}`);
      if (k === 'codAdvancePct' && n > 100) throw fail(400, 'El anticipo no puede pasar de 100%');
      next[k] = n;
    } else if (t === 'string') next[k] = String(v ?? '').trim().slice(0, 60) || cur[k];
    else if (t === 'strings') next[k] = [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
    else if (t === 'dates') {
      const list = (Array.isArray(v) ? v : []).map(String);
      if (list.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw fail(400, 'Los feriados deben ser fechas AAAA-MM-DD');
      next[k] = [...new Set(list)].sort();
    } else if (t === 'sla') {
      const sla = {};
      for (const [status, h] of Object.entries(v ?? {})) { if (STATUS[status] && Number(h) > 0) sla[status] = Number(h); }
      next.sla = sla;
    }
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('logistics_config', $1::jsonb, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now(), updated_by = $2`,
    [JSON.stringify(next), user?.id ?? null]
  );
  return next;
}

export async function userRoles(userId) {
  const { rows } = await pool.query('SELECT role FROM logistics_roles WHERE user_id = $1 ORDER BY role', [userId]);
  return rows.map((r) => r.role);
}

export async function listRoleAssignments() {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.role, COALESCE(array_agg(lr.role ORDER BY lr.role) FILTER (WHERE lr.role IS NOT NULL), '{}') AS logistics_roles
     FROM users u LEFT JOIN logistics_roles lr ON lr.user_id = u.id GROUP BY u.id ORDER BY u.full_name`
  );
  return rows;
}

export async function setUserRoles(userId, roles, grantedBy) {
  const list = [...new Set(roles ?? [])];
  if (list.some((r) => !ROLES[r])) throw fail(400, 'Rol de logística no válido');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!rows.length) throw fail(404, 'Usuario no encontrado');
    await client.query('DELETE FROM logistics_roles WHERE user_id = $1', [userId]);
    for (const role of list) await client.query('INSERT INTO logistics_roles (user_id, role, granted_by) VALUES ($1, $2, $3)', [userId, role, grantedBy ?? null]);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  return list;
}

// Quién puede ver toda la logística: administrador, supervisor y quien tenga algún rol de logística. Las asesoras ven solo sus fichas.
export async function viewerScope(user) {
  const roles = await userRoles(user.id);
  return { roles, seesAll: user.role === 'admin' || user.role === 'supervisor' || roles.length > 0 };
}

async function logEvent(db, { sheetId, user, roles = [], action, from = null, to = null, data = {}, note = null, evidence = [] }) {
  await db.query(
    `INSERT INTO order_sheet_events (sheet_id, actor_user_id, actor_name, actor_roles, action, from_status, to_status, data, note, evidence_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [sheetId, user?.id ?? null, user?.fullName ?? 'Sistema', roles, action, from, to, JSON.stringify(data), note, evidence]
  );
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
}

const isUniqueViolation = (err) => err?.code === '23505';

// — archivos (comprobantes y evidencias) —
const EVIDENCE_MIME = /^(image\/|video\/(mp4|quicktime|webm)$|application\/pdf$)/;
export async function saveEvidenceFile(file) {
  if (!file?.buffer?.length) throw fail(400, 'Archivo vacío');
  if (!EVIDENCE_MIME.test(file.mimetype)) throw fail(400, 'Solo se aceptan imágenes, PDF o video (mp4, mov, webm)');
  return saveAttachment({ n8nMessageId: null, kind: file.mimetype.startsWith('image/') ? 'image' : 'document', filename: file.originalname, mimeType: file.mimetype, buffer: file.buffer });
}

// — fichas —
const SHEET_FIELDS = ['payment_mode', 'delivery_type', 'campaign', 'full_name', 'phone', 'phone_alt', 'email', 'address', 'address_ref', 'city', 'department', 'receiver_name', 'invoice_name', 'invoice_nit',
  'origin_mode', 'origin_warehouses', 'dispatch_warehouse', 'notes'];
const SHEET_ENUMS = { payment_mode: ['contado', 'contraentrega'], delivery_type: ['domicilio', 'agencia'], origin_mode: ['unica', 'multiple'] };

function cleanSheetPatch(patch) {
  const out = {};
  for (const k of SHEET_FIELDS) {
    if (patch[k] === undefined) continue;
    if (k === 'origin_warehouses') out[k] = [...new Set((Array.isArray(patch[k]) ? patch[k] : []).map((x) => String(x).trim()).filter(Boolean))];
    else {
      const v = String(patch[k] ?? '').trim().slice(0, 500);
      if (SHEET_ENUMS[k] && !SHEET_ENUMS[k].includes(v)) throw fail(400, `Valor no válido en ${k}`);
      out[k] = v === '' && !SHEET_ENUMS[k] ? null : v;
    }
  }
  if (out.email && !/^\S+@\S+\.\S+$/.test(out.email)) throw fail(400, 'El correo no es válido');
  return out;
}

export function cleanItems(items) {
  if (!Array.isArray(items)) throw fail(400, 'Las prendas deben ser una lista');
  return items.map((i, n) => {
    const quantity = Number(i.quantity);
    const unit = Number(i.unit_price);
    const disc = Number(i.discount_pct ?? 0);
    if (!String(i.reference ?? '').trim()) throw fail(400, `Prenda ${n + 1}: falta la referencia`);
    if (!String(i.size ?? '').trim() || !String(i.color ?? '').trim()) throw fail(400, `Prenda ${n + 1}: falta talla o color`);
    if (!Number.isInteger(quantity) || quantity < 1) throw fail(400, `Prenda ${n + 1}: la cantidad debe ser un entero mayor a cero`);
    if (!Number.isFinite(unit) || unit < 0) throw fail(400, `Prenda ${n + 1}: precio no válido`);
    if (!Number.isFinite(disc) || disc < 0 || disc > 100) throw fail(400, `Prenda ${n + 1}: el descuento debe estar entre 0 y 100`);
    const final = i.final_price === undefined || i.final_price === null || i.final_price === '' ? r2(unit * (1 - disc / 100)) : r2(i.final_price);
    if (!Number.isFinite(final) || final < 0 || final > unit + 0.001) throw fail(400, `Prenda ${n + 1}: el precio final no puede ser mayor al precio completo`);
    return { product_id: i.product_id ?? null, reference: String(i.reference).trim().slice(0, 80), description: String(i.description ?? '').trim().slice(0, 200) || null, size: String(i.size).trim().slice(0, 20),
      color: String(i.color).trim().slice(0, 40), quantity, unit_price: r2(unit), discount_pct: r2(disc), final_price: final, origin_warehouse: String(i.origin_warehouse ?? '').trim().slice(0, 80) || null };
  });
}

async function insertItems(db, sheetId, items) {
  await db.query('DELETE FROM order_sheet_items WHERE sheet_id = $1', [sheetId]);
  for (const i of items) {
    await db.query(
      `INSERT INTO order_sheet_items (sheet_id, product_id, reference, description, size, color, quantity, unit_price, discount_pct, final_price, origin_warehouse)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [sheetId, i.product_id, i.reference, i.description, i.size, i.color, i.quantity, i.unit_price, i.discount_pct, i.final_price, i.origin_warehouse]
    );
  }
}

async function nextSheetNumber(db) {
  const { rows } = await db.query("SELECT nextval('order_sheet_seq') AS n");
  return `FIC-${new Date().getFullYear()}-${String(rows[0].n).padStart(5, '0')}`;
}

export async function createSheet({ customerId, quoteId = null, data = {}, items = null, user }) {
  const cfg = await getConfig();
  return withTx(async (db) => {
    const { rows: [c] } = await db.query('SELECT id, whatsapp_number, full_name, email, address, municipio, department FROM customers WHERE id = $1', [customerId]);
    if (!c) throw fail(404, 'Cliente no encontrado');
    let list = items;
    let quote = null;
    if (quoteId) {
      const { rows: [q] } = await db.query('SELECT id, customer_id, whatsapp_number_id FROM quotes WHERE id = $1', [quoteId]);
      if (!q || q.customer_id !== c.id) throw fail(400, 'Esa cotización no es de este cliente');
      quote = q;
      const { rows: qi } = await db.query('SELECT product_id, sku, name, size, color, quantity, unit_price, discount_pct, final_price FROM quote_items WHERE quote_id = $1 ORDER BY id', [quoteId]);
      list = qi.map((i) => ({ product_id: i.product_id, reference: i.sku, description: i.name, size: i.size || '', color: i.color || '', quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct, final_price: i.final_price }));
    }
    const clean = list?.length ? cleanItems(list) : [];
    const patch = cleanSheetPatch(data);
    const totals = computeTotals(clean, data.shipping ?? 0);
    const number = await nextSheetNumber(db);
    const phone = String(c.whatsapp_number).startsWith('social:') ? null : c.whatsapp_number;
    const { rows: [sheet] } = await db.query(
      `INSERT INTO order_sheets (sheet_number, customer_id, whatsapp_number_id, quote_id, created_by, advisor_name, payment_mode, delivery_type, campaign, full_name, phone, phone_alt, email, address, address_ref,
         city, department, receiver_name, invoice_name, invoice_nit, origin_mode, origin_warehouses, dispatch_warehouse, subtotal, discount_total, shipping, total, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING *`,
      [number, c.id, data.whatsapp_number_id ?? quote?.whatsapp_number_id ?? null, quote?.id ?? null, user.id, user.fullName, patch.payment_mode ?? 'contado', patch.delivery_type ?? 'domicilio', patch.campaign ?? null,
        patch.full_name ?? c.full_name, patch.phone ?? phone, patch.phone_alt ?? null, patch.email ?? c.email, patch.address ?? c.address, patch.address_ref ?? null, patch.city ?? c.municipio, patch.department ?? c.department,
        patch.receiver_name ?? null, patch.invoice_name ?? null, patch.invoice_nit ?? null, patch.origin_mode ?? 'unica', patch.origin_warehouses ?? [], patch.dispatch_warehouse ?? cfg.dispatchWarehouse,
        totals.subtotal, totals.discount_total, totals.shipping, totals.total, patch.notes ?? null]
    );
    await insertItems(db, sheet.id, clean);
    await logEvent(db, { sheetId: sheet.id, user, action: 'create', to: 'BORRADOR', data: { quote_id: quote?.id ?? null, items: clean.length, total: totals.total } });
    return sheet;
  });
}

async function loadSheet(db, id, { lock = false } = {}) {
  const { rows: [sheet] } = await db.query(`SELECT * FROM order_sheets WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!sheet) throw fail(404, 'Ficha no encontrada');
  return sheet;
}

async function canView(user, sheet) {
  const scope = await viewerScope(user);
  if (scope.seesAll) return scope;
  if (sheet.created_by !== user.id) throw fail(403, 'Esta ficha no es tuya');
  return scope;
}

const diff = (before, after) => Object.fromEntries(Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => [k, { de: before[k] ?? null, a: after[k] ?? null }]));

export async function updateSheet(id, { data = {}, items }, user) {
  return withTx(async (db) => {
    const sheet = await loadSheet(db, id, { lock: true });
    await canView(user, sheet);
    if (!EDITABLE_STATUSES.includes(sheet.status)) throw fail(409, `La ficha está en "${STATUS[sheet.status]}": ya no se edita. Una corrección va como observación del verificador.`);
    if (sheet.created_by !== user.id && user.role !== 'admin') throw fail(403, 'Solo quien creó la ficha puede editarla');
    const patch = cleanSheetPatch(data);
    let totals = {};
    let itemChange = null;
    if (items !== undefined) {
      const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM order_sheet_payments WHERE sheet_id = $1 AND audit_status = 'aprobado'", [id]);
      if (n > 0) throw fail(409, 'Ya hay un pago aprobado: las prendas y el total no se pueden cambiar. Si el cliente pide otra prenda, se crea otra ficha.');
      const clean = cleanItems(items);
      const { rows: before } = await db.query('SELECT reference, size, color, quantity, unit_price, final_price FROM order_sheet_items WHERE sheet_id = $1 ORDER BY id', [id]);
      await insertItems(db, id, clean);
      totals = computeTotals(clean, data.shipping ?? sheet.shipping);
      itemChange = { antes: before, ahora: clean.map(({ reference, size, color, quantity, unit_price, final_price }) => ({ reference, size, color, quantity, unit_price, final_price })) };
    } else if (data.shipping !== undefined) {
      const { rows: its } = await db.query('SELECT unit_price, quantity, final_price FROM order_sheet_items WHERE sheet_id = $1', [id]);
      totals = computeTotals(its, data.shipping);
    }
    const next = { ...patch, ...totals };
    const changes = diff(sheet, next);
    if (!Object.keys(changes).length && !itemChange) return sheet;
    const cols = Object.keys(next);
    const { rows: [updated] } = await db.query(
      `UPDATE order_sheets SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}${cols.length ? ',' : ''} updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...cols.map((c) => next[c])]
    );
    await logEvent(db, { sheetId: id, user, action: 'edit', from: sheet.status, to: sheet.status, data: { cambios: changes, prendas: itemChange } });
    return updated;
  });
}

// — pagos y comprobantes —
const PAYMENT_METHODS = ['transferencia', 'deposito', 'consignacion', 'tarjeta_link', 'efectivo', 'otro'];

async function chatAttachmentFor(db, customerId, attachmentId) {
  const { rows } = await db.query(
    `SELECT a.id FROM message_attachments a JOIN n8n_chat_histories h ON h.id = a.n8n_message_id JOIN customers c ON c.id = $1
     WHERE a.id = $2 AND split_part(h.session_id, '__', 1) = c.whatsapp_number AND (a.kind = 'image' OR a.mime_type = 'application/pdf')`,
    [customerId, attachmentId]
  );
  return rows[0]?.id ?? null;
}

function cleanPayment(p) {
  const amount = r2(p.amount);
  if (!PAYMENT_METHODS.includes(p.method)) throw fail(400, 'Forma de pago no válida');
  if (!(amount > 0)) throw fail(400, 'El monto del pago debe ser mayor a cero');
  const reference = String(p.reference_number ?? '').trim();
  if (!reference) throw fail(400, 'Falta el número de referencia del comprobante');
  if (p.paid_at && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.paid_at))) throw fail(400, 'La fecha del pago debe ser AAAA-MM-DD');
  return { method: p.method, amount, bank: String(p.bank ?? '').trim().slice(0, 60) || null, reference_number: reference.slice(0, 80), paid_at: p.paid_at || null };
}

export async function addPayment(sheetId, input, file, user) {
  return withTx(async (db) => {
    const sheet = await loadSheet(db, sheetId, { lock: true });
    await canView(user, sheet);
    if (!EDITABLE_STATUSES.includes(sheet.status)) throw fail(409, 'La ficha ya no acepta cambios en los pagos');
    const p = cleanPayment(input);
    let attachmentId = null;
    if (file) attachmentId = await saveEvidenceFile(file);
    else if (input.attachmentId) {
      attachmentId = await chatAttachmentFor(db, sheet.customer_id, Number(input.attachmentId));
      if (!attachmentId) throw fail(400, 'Ese archivo no es un comprobante de la conversación de este cliente');
    }
    if (!attachmentId) throw fail(400, 'Cada pago lleva su comprobante (sube el archivo o elige uno del chat)');
    try {
      const { rows: [pay] } = await db.query(
        `INSERT INTO order_sheet_payments (sheet_id, method, amount, bank, reference_number, paid_at, attachment_id, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [sheetId, p.method, p.amount, p.bank, p.reference_number, p.paid_at, attachmentId, user.id]
      );
      await logEvent(db, { sheetId, user, action: 'add_payment', from: sheet.status, to: sheet.status, data: { payment_id: pay.id, ...p }, evidence: [attachmentId] });
      return pay;
    } catch (err) {
      if (isUniqueViolation(err)) throw fail(409, 'Ese número de referencia ya respalda otro pago vigente (control contra comprobantes repetidos)');
      throw err;
    }
  });
}

export async function removePayment(sheetId, paymentId, user) {
  return withTx(async (db) => {
    const sheet = await loadSheet(db, sheetId, { lock: true });
    await canView(user, sheet);
    if (!EDITABLE_STATUSES.includes(sheet.status)) throw fail(409, 'La ficha ya no acepta cambios en los pagos');
    const { rows: [pay] } = await db.query('SELECT * FROM order_sheet_payments WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [paymentId, sheetId]);
    if (!pay) throw fail(404, 'Pago no encontrado');
    if (pay.audit_status === 'aprobado') throw fail(409, 'Un pago aprobado por la auditora no se puede retirar');
    await db.query('DELETE FROM order_sheet_payments WHERE id = $1', [paymentId]);
    await logEvent(db, { sheetId, user, action: 'remove_payment', from: sheet.status, to: sheet.status, data: { payment: pay }, evidence: pay.attachment_id ? [pay.attachment_id] : [] });
  });
}

// — enviar a auditoría —
export async function submitSheet(sheetId, user) {
  const cfg = await getConfig();
  return withTx(async (db) => {
    const sheet = await loadSheet(db, sheetId, { lock: true });
    const scope = await canView(user, sheet);
    const step = TRANSITIONS.submit;
    if (!step.from.includes(sheet.status)) throw fail(409, `Una ficha en "${STATUS[sheet.status]}" no se puede enviar a auditoría`);
    const done = await doneBy(db, sheetId, user.id);
    const ok = allowedFor({ step, sheet, userId: user.id, userRole: user.role, roles: scope.roles, done, cfg });
    if (!ok.ok) throw fail(403, ok.reason);
    const { rows: items } = await db.query('SELECT * FROM order_sheet_items WHERE sheet_id = $1', [sheetId]);
    const { rows: payments } = await db.query('SELECT * FROM order_sheet_payments WHERE sheet_id = $1 ORDER BY id', [sheetId]);
    const missing = sheetMissing(sheet, items, payments);
    if (missing.length) throw fail(422, 'La ficha está incompleta', { missing });
    const settled = settleAudit(sheet, payments, cfg);
    const to = settled.status;
    if (to === 'OBSERVADA') throw fail(422, settled.observation, { missing: [settled.observation] });
    const approvedNow = to === 'NUEVO_PEDIDO' && !sheet.payment_approved_at;
    const now = new Date();
    const { rows: [updated] } = await db.query(
      `UPDATE order_sheets SET status = $2, status_changed_at = now(), updated_at = now(), observation = NULL,
         payment_approved_at = CASE WHEN $3::boolean THEN now() ELSE payment_approved_at END,
         deadline_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE deadline_at END WHERE id = $1 RETURNING *`,
      [sheetId, to, approvedNow, addBusinessDays(now, cfg.totalBusinessDays, cfg.holidays)]
    );
    await logEvent(db, { sheetId, user, roles: scope.roles, action: 'submit', from: sheet.status, to, data: { items: items.length, payments: payments.length, total: Number(sheet.total) } });
    return updated;
  });
}

async function doneBy(db, sheetId, userId) {
  const { rows } = await db.query('SELECT DISTINCT action FROM order_sheet_events WHERE sheet_id = $1 AND actor_user_id = $2', [sheetId, userId]);
  const actions = rows.map((r) => r.action);
  // quien creó la ficha o cargó pagos "hizo" el envío; la auditoría del pago se separa de ellos aunque no haya pulsado enviar
  if (actions.includes('create') || actions.includes('add_payment')) actions.push('submit_side');
  return actions;
}

// — auditoría de un pago (quien audita no puede ser quien creó la ficha ni quien cargó el pago) —
export async function auditPayment(sheetId, paymentId, { result, note, bank_reference, approved_amount }, file, user) {
  const cfg = await getConfig();
  return withTx(async (db) => {
    const sheet = await loadSheet(db, sheetId, { lock: true });
    const scope = await viewerScope(user);
    if (!(scope.roles.includes('auditor_ingresos') || (cfg.adminAllRoles && user.role === 'admin'))) throw fail(403, 'No tienes el rol de auditor/a de ingresos');
    if (sheet.status !== 'EN_AUDITORIA_PAGO') throw fail(409, 'La ficha no está en auditoría de pago');
    const { rows: [pay] } = await db.query('SELECT * FROM order_sheet_payments WHERE id = $1 AND sheet_id = $2 FOR UPDATE', [paymentId, sheetId]);
    if (!pay) throw fail(404, 'Pago no encontrado');
    if (pay.audit_status !== 'pendiente') throw fail(409, 'Ese pago ya fue auditado');
    if (cfg.enforceSod && (sheet.created_by === user.id || pay.added_by === user.id)) throw fail(403, 'Separación de funciones: quien creó la ficha o cargó el pago no puede auditarlo');
    if (!['aprobado', 'observado', 'rechazado'].includes(result)) throw fail(400, 'El resultado debe ser aprobado, observado o rechazado');
    const evidenceId = file ? await saveEvidenceFile(file) : null;
    let amount = null;
    if (result === 'aprobado') {
      amount = r2(approved_amount);
      if (!String(bank_reference ?? '').trim()) throw fail(422, 'Falta la referencia bancaria con la que se verificó el pago');
      if (!(amount > 0)) throw fail(422, 'Falta el valor aprobado');
      if (!evidenceId) throw fail(422, 'Falta la captura del movimiento bancario (evidencia de la auditoría)');
    } else if (!String(note ?? '').trim()) throw fail(422, 'Explica por qué el pago queda observado o rechazado');
    await db.query(
      `UPDATE order_sheet_payments SET audit_status = $2, audited_by = $3, audited_at = now(), audit_note = $4, audit_bank_reference = $5, audit_amount = $6, audit_evidence_id = $7 WHERE id = $1`,
      [paymentId, result, user.id, String(note ?? '').trim() || null, String(bank_reference ?? '').trim() || null, amount, evidenceId]
    );
    await logEvent(db, { sheetId, user, roles: scope.roles, action: 'audit_payment', from: sheet.status, to: sheet.status, note: String(note ?? '').trim() || null,
      data: { payment_id: paymentId, result, bank_reference: bank_reference ?? null, approved_amount: amount, declared_amount: Number(pay.amount) }, evidence: evidenceId ? [evidenceId] : [] });
    const { rows: payments } = await db.query('SELECT * FROM order_sheet_payments WHERE sheet_id = $1 ORDER BY id', [sheetId]);
    const settled = settleAudit(sheet, payments, cfg);
    if (settled.status === sheet.status) return sheet;
    const approvedNow = settled.status === 'NUEVO_PEDIDO';
    const { rows: [updated] } = await db.query(
      `UPDATE order_sheets SET status = $2, status_changed_at = now(), updated_at = now(), observation = $3,
         payment_approved_at = CASE WHEN $4::boolean THEN now() ELSE payment_approved_at END,
         deadline_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE deadline_at END WHERE id = $1 RETURNING *`,
      [sheetId, settled.status, settled.observation ?? null, approvedNow, addBusinessDays(new Date(), cfg.totalBusinessDays, cfg.holidays)]
    );
    await logEvent(db, { sheetId, user: null, action: 'auto_status', from: sheet.status, to: settled.status, data: { observation: settled.observation ?? null }, note: 'Resultado de la auditoría de pagos' });
    return updated;
  });
}

// — avance por el flujo —
export async function advance(sheetId, key, { data = {}, note = null }, files, user) {
  const cfg = await getConfig();
  const step = TRANSITIONS[key];
  if (!step) throw fail(400, 'Paso desconocido');
  if (step.special === 'submit') return submitSheet(sheetId, user);
  return withTx(async (db) => {
    const sheet = await loadSheet(db, sheetId, { lock: true });
    const scope = await canView(user, sheet);
    if (!stepsFor(sheet).some((s) => s.key === key)) throw fail(409, `El paso "${step.label}" no está disponible con la ficha en "${STATUS[sheet.status]}" (${sheet.payment_mode})`);
    const done = await doneBy(db, sheetId, user.id);
    const earlyCancel = key === 'cancel' && sheet.created_by === user.id && ['BORRADOR', 'OBSERVADA', 'EN_AUDITORIA_PAGO'].includes(sheet.status);
    if (!earlyCancel) {
      const ok = allowedFor({ step, sheet, userId: user.id, userRole: user.role, roles: scope.roles, done, cfg });
      if (!ok.ok) throw fail(403, ok.reason);
    }
    const { data: clean, errors } = validateFields(step, data);
    if (errors.length) throw fail(422, errors[0], { missing: errors });
    if (step.evidence?.required && !(files?.length)) throw fail(422, `Falta la evidencia: ${step.evidence.label}`);

    // reglas propias de cada paso (estrictas a propósito: lo que no cuadra no avanza)
    const total = Number(sheet.total);
    if (key === 'validate_advance') {
      const need = requiredPayment(sheet, cfg);
      if (clean.advance_amount + cfg.amountToleranceQ + 0.001 < need) throw fail(422, `El anticipo (Q${clean.advance_amount.toFixed(2)}) no llega al mínimo de Q${need.toFixed(2)} (${cfg.codAdvancePct}% del total)`);
    }
    if (key === 'generate_guide') {
      const expectedType = sheet.payment_mode === 'contraentrega' ? 'xcobrar' : 'contado';
      if (clean.guide_type !== expectedType) throw fail(422, `Un pedido de ${sheet.payment_mode} lleva guía "${expectedType}"`);
      if (expectedType === 'xcobrar') {
        const { rows: [{ approved }] } = await db.query("SELECT COALESCE(sum(COALESCE(audit_amount, amount)), 0) AS approved FROM order_sheet_payments WHERE sheet_id = $1 AND audit_status = 'aprobado'", [sheetId]);
        const expected = r2(total - Number(approved));
        if (!(clean.amount_to_collect > 0)) throw fail(422, 'Falta el monto a cobrar al recibir');
        if (Math.abs(clean.amount_to_collect - expected) > cfg.amountToleranceQ + 0.001) throw fail(422, `El monto a cobrar (Q${clean.amount_to_collect.toFixed(2)}) no coincide con el saldo pendiente (Q${expected.toFixed(2)})`);
      }
    }
    if (key === 'verify_credit') {
      const reported = Number(sheet.step_data?.report_credit?.credit_amount);
      if (Number.isFinite(reported) && Math.abs(clean.verified_amount - reported) > cfg.amountToleranceQ + 0.001) throw fail(422, `El monto verificado (Q${clean.verified_amount.toFixed(2)}) no coincide con el reportado (Q${reported.toFixed(2)})`);
    }
    if (key === 'redispatch' && sheet.attempts >= cfg.codMaxAttempts) throw fail(409, `Ya se hicieron ${sheet.attempts} intentos (máximo ${cfg.codMaxAttempts}): decide el jefe de logística`);

    const evidence = [];
    for (const f of files ?? []) evidence.push(await saveEvidenceFile(f));

    let to = step.to;
    const sets = { observation: null };
    if (step.special === 'assign') sets.assigned_to = user.id;
    if (step.special === 'observe') { sets.observation = clean.observation; sets.assigned_to = null; }
    if (step.special === 'attempt') sets.attempts = sheet.attempts + 1;
    if (step.special === 'hold') { sets.hold_reason = clean.reason; sets.hold_prev_status = sheet.status; }
    if (step.special === 'resume') { to = sheet.hold_prev_status ?? 'NUEVO_PEDIDO'; sets.hold_reason = null; sets.hold_prev_status = null; }
    if (step.special === 'cancel') sets.hold_reason = clean.reason;
    if (step.special === 'nonconformity') sets.observation = `Auditoría de empaque no conforme: ${clean.nonconformity}`;

    const stepData = { ...(sheet.step_data ?? {}), [key]: { ...clean, at: new Date().toISOString(), by: user.fullName } };
    const cols = Object.keys(sets);
    const { rows: [updated] } = await db.query(
      `UPDATE order_sheets SET status = $2, status_changed_at = CASE WHEN $2 <> status THEN now() ELSE status_changed_at END, step_data = $3::jsonb, updated_at = now()
         ${cols.map((c, i) => `, ${c} = $${i + 4}`).join('')} WHERE id = $1 RETURNING *`,
      [sheetId, to, JSON.stringify(stepData), ...cols.map((c) => sets[c])]
    );
    await logEvent(db, { sheetId, user, roles: scope.roles.filter((r) => step.roles.includes(r)), action: key, from: sheet.status, to, data: { codigo: step.code, ...clean }, note: note ? String(note).slice(0, 500) : null, evidence });
    return updated;
  });
}

export async function addNote(sheetId, note, user) {
  if (!String(note ?? '').trim()) throw fail(400, 'Escribe la nota');
  return withTx(async (db) => {
    const sheet = await loadSheet(db, sheetId);
    const scope = await canView(user, sheet);
    await logEvent(db, { sheetId, user, roles: scope.roles, action: 'note', from: sheet.status, to: sheet.status, note: String(note).trim().slice(0, 1000) });
  });
}

// — consultas —
function slaInfo(sheet, cfg, now = new Date()) {
  const hours = slaForStatus(sheet.status, cfg);
  const inStatusH = (+now - +new Date(sheet.status_changed_at)) / 3600000;
  const deadline = sheet.deadline_at ? new Date(sheet.deadline_at) : null;
  const active = !TERMINAL.includes(sheet.status);
  return {
    deadlineAt: deadline, overdue: active && !!deadline && deadline < now, dueSoon: active && !!deadline && deadline >= now && +deadline - +now <= 24 * 3600000,
    statusHours: Math.round(inStatusH * 10) / 10, statusSlaHours: hours, statusOverdue: active && hours != null && inStatusH > hours,
  };
}

export async function listSheets({ user, scope = 'mine', status = null, q = '', mode = null, overdue = false, limit = 100 }) {
  const view = await viewerScope(user);
  const cfg = await getConfig();
  const params = [];
  const where = [];
  if (!view.seesAll || scope === 'mine') { params.push(user.id); where.push(`s.created_by = $${params.length}`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  if (mode) { params.push(mode); where.push(`s.payment_mode = $${params.length}`); }
  if (q) { params.push(`%${String(q).trim()}%`); where.push(`(s.sheet_number ILIKE $${params.length} OR s.full_name ILIKE $${params.length} OR s.phone ILIKE $${params.length})`); }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 300));
  const { rows } = await pool.query(
    `SELECT s.*, (SELECT count(*)::int FROM order_sheet_items i WHERE i.sheet_id = s.id) AS items_count,
            (SELECT count(*)::int FROM order_sheet_payments p WHERE p.sheet_id = s.id) AS payments_count
     FROM order_sheets s ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.status_changed_at DESC LIMIT $${params.length}`,
    params
  );
  const now = new Date();
  const out = rows.map((s) => ({ ...s, sla: slaInfo(s, cfg, now), statusLabel: STATUS[s.status] }));
  return overdue ? out.filter((s) => s.sla.overdue || s.sla.statusOverdue) : out;
}

export async function boardCounts(user) {
  const view = await viewerScope(user);
  if (!view.seesAll) throw fail(403, 'No tienes acceso al tablero de logística');
  const cfg = await getConfig();
  const { rows } = await pool.query('SELECT status, count(*)::int AS n, count(*) FILTER (WHERE deadline_at < now())::int AS overdue FROM order_sheets GROUP BY status');
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  const { rows: [t] } = await pool.query(
    "SELECT count(*) FILTER (WHERE deadline_at < now() AND status NOT IN ('CERRADO','CANCELADA'))::int AS overdue, count(*) FILTER (WHERE deadline_at >= now() AND deadline_at < now() + interval '24 hours' AND status NOT IN ('CERRADO','CANCELADA'))::int AS due_soon FROM order_sheets"
  );
  return {
    columns: BOARD.map((c) => ({ ...c, label: c.label, statuses: c.statuses.map((s) => ({ status: s, label: STATUS[s], count: by[s]?.n ?? 0, overdue: by[s]?.overdue ?? 0 })) })),
    overdue: t.overdue, dueSoon: t.due_soon, config: { totalBusinessDays: cfg.totalBusinessDays },
  };
}

export async function getSheet(id, user) {
  const cfg = await getConfig();
  const { rows: [sheet] } = await pool.query('SELECT * FROM order_sheets WHERE id = $1', [id]);
  if (!sheet) throw fail(404, 'Ficha no encontrada');
  const scope = await canView(user, sheet);
  const [items, payments, events, customer] = await Promise.all([
    pool.query('SELECT * FROM order_sheet_items WHERE sheet_id = $1 ORDER BY id', [id]),
    pool.query(
      `SELECT p.*, a.mime_type, a.filename, ea.mime_type AS audit_evidence_mime, ua.full_name AS audited_by_name, ub.full_name AS added_by_name
       FROM order_sheet_payments p LEFT JOIN message_attachments a ON a.id = p.attachment_id LEFT JOIN message_attachments ea ON ea.id = p.audit_evidence_id
       LEFT JOIN users ua ON ua.id = p.audited_by LEFT JOIN users ub ON ub.id = p.added_by WHERE p.sheet_id = $1 ORDER BY p.id`, [id]
    ),
    pool.query(
      `SELECT e.*, COALESCE((SELECT json_agg(json_build_object('id', a.id, 'mime', a.mime_type, 'filename', a.filename)) FROM message_attachments a WHERE a.id = ANY(e.evidence_ids)), '[]'::json) AS evidence
       FROM order_sheet_events e WHERE e.sheet_id = $1 ORDER BY e.at, e.id`, [id]
    ),
    pool.query('SELECT id, full_name, whatsapp_number FROM customers WHERE id = $1', [sheet.customer_id]),
  ]);
  const done = [...new Set(events.rows.filter((e) => e.actor_user_id === user.id).map((e) => e.action))];
  if (done.includes('create') || done.includes('add_payment')) done.push('submit_side');
  const approved = payments.rows.filter((p) => p.audit_status === 'aprobado').reduce((s, p) => s + Number(p.audit_amount ?? p.amount), 0);
  const actions = stepsFor(sheet).map((s) => {
    const early = s.key === 'cancel' && sheet.created_by === user.id && ['BORRADOR', 'OBSERVADA', 'EN_AUDITORIA_PAGO'].includes(sheet.status);
    const ok = early ? { ok: true } : allowedFor({ step: s, sheet, userId: user.id, userRole: user.role, roles: scope.roles, done, cfg });
    return { key: s.key, code: s.code, label: s.label, fields: s.fields, evidence: s.evidence, allowed: ok.ok, reason: ok.ok ? null : ok.reason, roles: s.roles.map((r) => (r === 'asesora' ? 'Asesora de la ficha' : ROLES[r])) };
  });
  const canAudit = sheet.status === 'EN_AUDITORIA_PAGO' && (scope.roles.includes('auditor_ingresos') || (cfg.adminAllRoles && user.role === 'admin'));
  return {
    sheet: { ...sheet, statusLabel: STATUS[sheet.status], sla: slaInfo(sheet, cfg) }, customer: customer.rows[0], items: items.rows, payments: payments.rows, events: events.rows,
    paid: { required: requiredPayment(sheet, cfg), approved: r2(approved) }, actions, canAudit, editable: EDITABLE_STATUSES.includes(sheet.status) && (sheet.created_by === user.id || user.role === 'admin'),
    missing: sheetMissing(sheet, items.rows, payments.rows), config: { codAdvancePct: cfg.codAdvancePct, warehouses: cfg.warehouses, dispatchWarehouse: cfg.dispatchWarehouse },
  };
}

// Comprobantes que el cliente mandó por el chat (imágenes y PDF recientes) para adjuntarlos a la ficha sin volver a subirlos.
export async function chatProofs(customerId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.kind, a.mime_type, a.filename, h.created_at, o.amount AS ocr_amount
     FROM customers c JOIN n8n_chat_histories h ON split_part(h.session_id, '__', 1) = c.whatsapp_number AND h.message->>'type' = 'human'
     JOIN message_attachments a ON a.n8n_message_id = h.id AND (a.kind = 'image' OR a.mime_type = 'application/pdf')
     LEFT JOIN attachment_ocr o ON o.attachment_id = a.id
     WHERE c.id = $1 AND h.created_at > now() - interval '30 days' ORDER BY h.created_at DESC LIMIT 30`, [customerId]
  );
  return rows;
}
