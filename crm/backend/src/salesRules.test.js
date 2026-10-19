import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeAdvisor, latestQuote, startsNewCycle, isResentReceipt,
  shiftOf, quotedAmountIn, givesPaymentInfo, isConfirmationMessage,
} from './salesRules.js';

// Helper: hora de Guatemala (UTC-6) -> instante UTC.
const gt = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00-06:00`);
let n = 0;
const adv = (at, advisor, text) => ({ id: ++n, at, role: 'advisor', advisor, text, ocrAmount: null });
const cust = (at, text = '') => ({ id: ++n, at, role: 'customer', advisor: null, text, ocrAmount: null });

test('turnos: mañana, tarde, domingo y fuera de horario', () => {
  assert.equal(shiftOf(gt('14', '08:00')), 'manana');
  assert.equal(shiftOf(gt('14', '14:59')), 'manana');
  assert.equal(shiftOf(gt('14', '15:00')), 'tarde');
  assert.equal(shiftOf(gt('14', '20:59')), 'tarde');
  assert.equal(shiftOf(gt('14', '21:00')), 'fuera_de_turno');
  assert.equal(shiftOf(gt('14', '07:30')), 'fuera_de_turno');
  assert.equal(shiftOf(gt('18', '10:00')), 'domingo'); // 18/10/2026 es domingo
});

test('el turno se calcula en hora de Guatemala, no UTC', () => {
  // 20:30 en Guatemala ya es el día siguiente en UTC.
  assert.equal(shiftOf(new Date('2026-10-15T02:30:00Z')), 'tarde');
});

test('atribución: la que dio los medios de pago se queda la venta aunque otra abra el chat después', () => {
  const events = [
    adv(gt('14', '09:00'), 'Aura', 'Tu total es Q539'),
    adv(gt('14', '09:10'), 'Aura', 'Puedes pagar por transferencia a la cuenta Banrural 4012345678'),
    adv(gt('14', '16:00'), 'Leydi', 'Hola, ¿sigues interesada?'),
    cust(gt('14', '16:20'), '[comprobante]'),
  ];
  const r = attributeAdvisor(events, gt('14', '16:20'));
  assert.equal(r.advisor, 'Aura');
  assert.equal(r.rule, 'dio_medios_de_pago');
});

test('atribución: si la primera solo cotizó y la segunda dio los medios de pago, gana la segunda', () => {
  const events = [
    adv(gt('14', '09:00'), 'Aura', 'Tu total es Q539'),
    adv(gt('14', '16:00'), 'Leydi', 'Te paso la cuenta: Banrural 4012345678'),
  ];
  assert.equal(attributeAdvisor(events, gt('14', '16:30')).advisor, 'Leydi');
});

test('atribución: sin medios de pago, gana la última que escribió antes del pago', () => {
  const events = [
    adv(gt('14', '09:00'), 'Aura', 'Tu total es Q539'),
    adv(gt('14', '15:30'), 'Leydi', '¿Cómo quieres pagar?'),
  ];
  const r = attributeAdvisor(events, gt('14', '16:00'));
  assert.equal(r.advisor, 'Leydi');
  assert.equal(r.rule, 'ultimo_asesor_antes_del_pago');
});

test('atribución: preguntar cómo quiere pagar no cuenta como dar medios de pago', () => {
  assert.equal(givesPaymentInfo('¿Cómo quieres pagar?'), false);
  assert.equal(givesPaymentInfo('Avísame para preparar el enlace de pago seguro'), false);
  assert.equal(givesPaymentInfo('Aquí tu link https://pago.example.com/x'), true);
});

test('atribución: mensajes posteriores al pago no le quitan la venta a quien atendía', () => {
  const events = [
    adv(gt('14', '09:00'), 'Aura', 'Cuenta Banrural 4012345678'),
    cust(gt('14', '10:00'), '[comprobante]'),
    adv(gt('14', '15:30'), 'Leydi', 'Tu pedido ya está en proceso de alistamiento'),
  ];
  assert.equal(attributeAdvisor(events, gt('14', '10:00')).advisor, 'Aura');
});

test('atribución: pago fuera de horario se acredita a quien responde primero dentro de 2 h', () => {
  const events = [adv(gt('15', '08:10'), 'Luisa', 'Buen día, recibimos tu comprobante')];
  const r = attributeAdvisor(events, gt('15', '07:30'));
  assert.equal(r.advisor, 'Luisa');
  assert.equal(r.rule, 'primer_asesor_despues_del_pago');
});

test('atribución: sin asesora en 7 días o con nombres genéricos no se inventa a nadie', () => {
  assert.equal(attributeAdvisor([], gt('14', '10:00')), null);
  assert.equal(attributeAdvisor([adv(gt('14', '09:00'), 'bot', 'hola')], gt('14', '10:00')), null);
  const viejo = [adv(gt('01', '09:00'), 'Aura', 'Cuenta Banrural 4012345678')];
  assert.equal(attributeAdvisor(viejo, gt('14', '10:00')), null);
});

test('montos cotizados con coma, punto y sin separador', () => {
  assert.equal(quotedAmountIn('Tu total es Q1,930'), 1930);
  assert.equal(quotedAmountIn('son Q1.930'), 1930);
  assert.equal(quotedAmountIn('Total Q539'), 539);
  assert.equal(quotedAmountIn('Q 890.00 con envío'), 890);
  assert.equal(quotedAmountIn('Hola, buen día'), null);
  assert.equal(quotedAmountIn('Q30000 no es retail'), null);
});

test('última cotización ignora mensajes de confirmación', () => {
  const events = [
    adv(gt('14', '09:00'), 'Aura', 'Total Q539'),
    adv(gt('14', '12:00'), 'Aura', 'Tu pedido de Q539 ya está en proceso de alistamiento'),
    adv(gt('14', '12:05'), 'Aura', 'Agregado a la compra Q649'),
  ];
  assert.equal(latestQuote(events, null, gt('14', '13:00')), 539);
});

test('seguimiento posterior a la venta NO es un ciclo nuevo; una cotización nueva sí', () => {
  const venta = gt('14', '10:00');
  const seguimiento = [adv(gt('15', '09:00'), 'Leydi', 'Tu pedido ya está en proceso de alistamiento Q539')];
  assert.equal(startsNewCycle(seguimiento, venta, gt('15', '09:01')), false);
  const nueva = [...seguimiento, adv(gt('17', '11:00'), 'Leydi', 'Para esta nueva compra el total es Q420')];
  assert.equal(startsNewCycle(nueva, venta, gt('17', '15:00')), true);
  assert.equal(startsNewCycle([], null, gt('17', '15:00')), true);
});

test('comprobante reenviado con el mismo monto no duplica; con cotización nueva sí es otra venta', () => {
  const recentSales = [{ at: gt('14', '10:00'), amount: 539 }];
  assert.equal(isResentReceipt({ amount: 539, recentSales, events: [], atTime: gt('15', '09:00') }), true);
  const nueva = [adv(gt('15', '08:00'), 'Aura', 'Total Q539 otra vez')];
  assert.equal(isResentReceipt({ amount: 539, recentSales, events: nueva, atTime: gt('15', '09:00') }), false);
  assert.equal(isResentReceipt({ amount: 700, recentSales, events: [], atTime: gt('15', '09:00') }), false);
  assert.equal(isResentReceipt({ amount: 539, recentSales, events: [], atTime: gt('20', '09:00') }), false);
});

test('un comprobante viejo reenviado después de OTRA compra también es reenvío', () => {
  const recentSales = [{ at: gt('14', '18:00'), amount: 420 }, { at: gt('14', '10:00'), amount: 539 }];
  const eventos = [adv(gt('14', '17:00'), 'Leydi', 'Para esta nueva compra el total es Q420')];
  assert.equal(isResentReceipt({ amount: 539, recentSales, events: eventos, atTime: gt('15', '09:00') }), true);
});

test('frases de confirmación', () => {
  assert.equal(isConfirmationMessage('Gracias por su compra'), true);
  assert.equal(isConfirmationMessage('¿Cómo quieres pagar?'), false);
});
