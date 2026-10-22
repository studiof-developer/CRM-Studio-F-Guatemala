import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSITIONS, STATUS, BOARD, stepsFor, allowedFor, validateFields, addBusinessDays, requiredPayment, sheetMissing, computeTotals, settleAudit, LOGISTICS_DEFAULTS, fromStatuses, TERMINAL,
} from './logisticsFlow.js';

test('toda transición apunta a un estado que existe y sale de estados que existen', () => {
  for (const [key, s] of Object.entries(TRANSITIONS)) {
    if (s.to) assert.ok(STATUS[s.to], `${key} → ${s.to}`);
    for (const f of fromStatuses(s)) assert.ok(STATUS[f], `${key} desde ${f}`);
    assert.ok(s.code.startsWith('LOG-'), key);
    assert.ok(s.roles.length, `${key} sin roles`);
  }
});

test('todos los estados aparecen en una columna del tablero (ninguno queda invisible)', () => {
  const inBoard = new Set(BOARD.flatMap((c) => c.statuses));
  const hidden = Object.keys(STATUS).filter((s) => !inBoard.has(s) && s !== 'BORRADOR');
  assert.deepEqual(hidden, []);
});

test('desde cualquier estado activo se puede avanzar o pausar: el proceso no tiene callejones sin salida', () => {
  for (const status of Object.keys(STATUS)) {
    if (TERMINAL.includes(status)) continue;
    for (const mode of ['contado', 'contraentrega']) {
      assert.ok(stepsFor({ status, payment_mode: mode }).length > 0, `${status} (${mode}) sin pasos`);
    }
  }
});

test('el camino de contado llega de nuevo pedido a cerrado y el de contraentrega también', () => {
  const walk = (mode, keys) => {
    let status = 'NUEVO_PEDIDO';
    for (const k of keys) {
      const step = stepsFor({ status, payment_mode: mode }).find((s) => s.key === k);
      assert.ok(step, `${mode}: ${k} no está disponible desde ${status}`);
      status = step.to;
    }
    return status;
  };
  const common = ['start_verification', 'verify_ok', 'request_transfer', 'authorize_transfer', 'receive_transfer', 'consolidate_complete'];
  const tail = ['pack', 'audit_pack', 'generate_guide', 'hand_over', 'send_guide', 'mark_delivered'];
  assert.equal(walk('contado', [...common, 'validate_cash', 'issue_invoice_cash', ...tail, 'confirm_received']), 'CERRADO');
  assert.equal(walk('contraentrega', [...common, 'validate_advance', ...tail, 'report_credit', 'verify_credit', 'invoice_cod']), 'CERRADO');
});

test('el paquete incompleto vuelve a recibirse y revalidarse (bucle de faltantes)', () => {
  assert.equal(stepsFor({ status: 'RECIBIDO_BODEGA', payment_mode: 'contado' }).find((s) => s.key === 'consolidate_incomplete').to, 'FALTANTE');
  assert.equal(stepsFor({ status: 'FALTANTE', payment_mode: 'contado' }).find((s) => s.key === 'receive_missing').to, 'RECIBIDO_BODEGA');
});

test('los pasos de contado no aparecen en contraentrega y viceversa', () => {
  const cod = stepsFor({ status: 'CONSOLIDADO', payment_mode: 'contraentrega' }).map((s) => s.key);
  assert.ok(cod.includes('validate_advance') && !cod.includes('validate_cash'));
  const cash = stepsFor({ status: 'CONSOLIDADO', payment_mode: 'contado' }).map((s) => s.key);
  assert.ok(cash.includes('validate_cash') && !cash.includes('validate_advance'));
});

test('separación de funciones: quien solicitó el traslado no lo autoriza; quien empacó no audita el empaque', () => {
  const step = TRANSITIONS.authorize_transfer;
  const base = { step, sheet: { created_by: 9 }, userId: 5, userRole: 'asesor', roles: ['autorizador'], cfg: LOGISTICS_DEFAULTS };
  assert.equal(allowedFor({ ...base, done: [] }).ok, true);
  const bad = allowedFor({ ...base, done: ['request_transfer'] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Separación de funciones/);
  assert.equal(allowedFor({ ...base, done: ['request_transfer'], cfg: { ...LOGISTICS_DEFAULTS, enforceSod: false } }).ok, true);
  assert.equal(allowedFor({ step: TRANSITIONS.audit_pack, sheet: {}, userId: 5, userRole: 'asesor', roles: ['auditor_empaque'], done: ['pack'] }).ok, false);
});

test('quien audita el pago no verifica ni factura la misma ficha', () => {
  assert.equal(allowedFor({ step: TRANSITIONS.verify_ok, sheet: {}, userId: 1, userRole: 'asesor', roles: ['verificador'], done: ['audit_payment'] }).ok, false);
  assert.equal(allowedFor({ step: TRANSITIONS.issue_invoice_cash, sheet: {}, userId: 1, userRole: 'asesor', roles: ['facturador'], done: ['audit_payment'] }).ok, false);
});

test('sin el rol no se puede; el administrador sí (sujeto a la separación de funciones); "asesora" es quien creó la ficha', () => {
  const sheet = { created_by: 3 };
  assert.equal(allowedFor({ step: TRANSITIONS.verify_ok, sheet, userId: 1, userRole: 'asesor', roles: [], done: [] }).ok, false);
  assert.equal(allowedFor({ step: TRANSITIONS.verify_ok, sheet, userId: 1, userRole: 'admin', roles: [], done: [] }).ok, true);
  assert.equal(allowedFor({ step: TRANSITIONS.verify_ok, sheet, userId: 1, userRole: 'admin', roles: [], done: ['audit_payment'] }).ok, false);
  assert.equal(allowedFor({ step: TRANSITIONS.submit, sheet, userId: 3, userRole: 'asesor', roles: [], done: [] }).ok, true);
  assert.equal(allowedFor({ step: TRANSITIONS.submit, sheet, userId: 4, userRole: 'asesor', roles: [], done: [] }).ok, false);
});

test('variables: faltantes, tipos y casillas que deben marcarse', () => {
  const step = TRANSITIONS.audit_pack;
  const incompleto = validateFields(step, { ref_ok: true, talla_ok: true });
  assert.ok(incompleto.errors.length >= 5);
  const todo = validateFields(step, { ref_ok: true, talla_ok: true, color_ok: true, cantidad_ok: true, estado_ok: true, etiqueta_ok: true, guia_ok: true, seal_number: 'S-100' });
  assert.deepEqual(todo.errors, []);
  assert.equal(todo.data.seal_number, 'S-100');
  assert.ok(validateFields(step, { ref_ok: false, talla_ok: true, color_ok: true, cantidad_ok: true, estado_ok: true, etiqueta_ok: true, guia_ok: true, seal_number: 'S' }).errors.some((e) => /Debe confirmarse/.test(e)));
  assert.ok(validateFields(TRANSITIONS.hand_over, { pickup_date: '22/10/2026', manifest_number: 'M1' }).errors.some((e) => /Fecha no válida/.test(e)));
  assert.ok(validateFields(TRANSITIONS.receive_transfer, { transfer_guide: 'G', packages_received: -2 }).errors.some((e) => /Número no válido/.test(e)));
  assert.ok(validateFields(TRANSITIONS.generate_guide, { guide_number: 'G1', guide_type: 'otra' }).errors.some((e) => /Valor no permitido/.test(e)));
});

test('4 días hábiles: paga el lunes, llega a más tardar el viernes (DEC-06)', () => {
  const lunes = new Date('2026-10-19T10:00:00-06:00');
  assert.equal(addBusinessDays(lunes, 4).toISOString(), new Date('2026-10-23T23:59:59-06:00').toISOString());
  // paga el jueves: salta el fin de semana → miércoles
  assert.equal(addBusinessDays(new Date('2026-10-22T10:00:00-06:00'), 4).toISOString(), new Date('2026-10-28T23:59:59-06:00').toISOString());
  // un feriado el viernes lo corre al lunes
  assert.equal(addBusinessDays(lunes, 4, ['2026-10-21']).toISOString(), new Date('2026-10-26T23:59:59-06:00').toISOString());
  // pago de noche (9 pm hora de Guatemala = día siguiente en UTC) cuenta como el mismo día
  assert.equal(addBusinessDays(new Date('2026-10-19T21:00:00-06:00'), 4).toISOString(), new Date('2026-10-23T23:59:59-06:00').toISOString());
});

test('pago requerido: el total en contado, el 25% en contraentrega; tolerancia y auditoría', () => {
  assert.equal(requiredPayment({ total: 1000, payment_mode: 'contado' }), 1000);
  assert.equal(requiredPayment({ total: 1000, payment_mode: 'contraentrega' }), 250);
  const sheet = { total: 1000, payment_mode: 'contado' };
  const p = (status, amount, extra = {}) => ({ id: 1, audit_status: status, amount, reference_number: 'R1', ...extra });
  assert.equal(settleAudit(sheet, [p('pendiente', 600), p('aprobado', 400)]).status, 'EN_AUDITORIA_PAGO');
  assert.equal(settleAudit(sheet, [p('aprobado', 600), p('aprobado', 400)]).status, 'NUEVO_PEDIDO');
  assert.equal(settleAudit(sheet, [p('aprobado', 600), p('observado', 400, { audit_note: 'no aparece' })]).status, 'OBSERVADA');
  const faltante = settleAudit(sheet, [p('aprobado', 900)]);
  assert.equal(faltante.status, 'OBSERVADA');
  assert.match(faltante.observation, /Falta pago/);
  assert.equal(settleAudit(sheet, [p('aprobado', 999)], { ...LOGISTICS_DEFAULTS, amountToleranceQ: 1 }).status, 'NUEVO_PEDIDO');
  assert.equal(settleAudit({ total: 1000, payment_mode: 'contraentrega' }, [p('aprobado', 250)]).status, 'NUEVO_PEDIDO');
  // el valor que aprobó la auditora manda sobre el que escribió la asesora
  assert.equal(settleAudit(sheet, [p('aprobado', 1000, { audit_amount: 800 })]).status, 'OBSERVADA');
});

test('totales de la ficha: el servidor suma prendas con descuento y flete', () => {
  const items = [{ unit_price: 449, quantity: 2, final_price: 349 }, { unit_price: 299, quantity: 1, final_price: 299 }];
  assert.deepEqual(computeTotals(items, 35), { subtotal: 1197, discount_total: 200, shipping: 35, total: 1032 });
});

test('la ficha no sale a auditoría con campos del PDF vacíos, sin comprobante o sin referencia', () => {
  const sheet = { campaign: 'NEWA', full_name: 'Ana', phone: '5000', email: 'a@b.c', address: 'Zona 1', city: 'Guatemala', department: 'Guatemala', total: 100 };
  const item = { reference: 'S1' };
  assert.deepEqual(sheetMissing(sheet, [item], [{ attachment_id: 1, reference_number: 'R1' }]), []);
  assert.ok(sheetMissing({ ...sheet, email: '' }, [item], [{ attachment_id: 1, reference_number: 'R1' }]).includes('Correo'));
  assert.ok(sheetMissing(sheet, [], [{ attachment_id: 1, reference_number: 'R1' }]).includes('Al menos una prenda'));
  assert.ok(sheetMissing(sheet, [item], []).includes('Al menos un pago con su comprobante'));
  assert.ok(sheetMissing(sheet, [item], [{ attachment_id: null, reference_number: 'R1' }]).includes('Cada pago debe llevar su comprobante'));
  assert.ok(sheetMissing(sheet, [item], [{ attachment_id: 1, reference_number: '' }]).includes('Cada pago necesita su número de referencia'));
});
