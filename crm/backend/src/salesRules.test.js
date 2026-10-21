import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeAdvisor, latestQuote, startsNewCycle, isResentReceipt,
  shiftOf, quotedAmountIn, givesPaymentInfo, isConfirmationMessage, buildEpisodes, paymentMedium, receiptAmountInText, approvedQuote, acceptsOffer,
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

test('atribución: quien atendió mucho más el chat (el doble de mensajes, mínimo 3) se queda la venta aunque otra mande los medios de pago', () => {
  const events = [
    adv(gt('14', '09:00'), 'Leydi', 'Hola, ¿qué talla buscas?'),
    adv(gt('14', '09:05'), 'Leydi', 'Te cotizo Q539'),
    adv(gt('14', '09:30'), 'Leydi', 'Tenemos en negro y beige'),
    adv(gt('14', '10:00'), 'Aura', 'Te paso la cuenta: Banrural 4012345678'),
    adv(gt('14', '10:10'), 'Leydi', 'Avísame cuando hagas el pago'),
  ];
  const r = attributeAdvisor(events, gt('14', '11:00'));
  assert.equal(r.advisor, 'Leydi');
  assert.equal(r.rule, 'mayor_atencion');
  // con una diferencia menor al doble sigue mandando quien dio los medios de pago
  const parejo = [...events.slice(0, 2), events[3], adv(gt('14', '10:20'), 'Aura', 'Aquí te espero'), events[4]];
  assert.equal(attributeAdvisor(parejo, gt('14', '11:00')).advisor, 'Aura');
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

const img = (at, ocrAmount = null) => ({ id: ++n, at, role: 'customer', advisor: null, text: '', ocrAmount, image: true });

test('episodios: venta por transferencia con cambio de turno y seguimiento posterior', () => {
  const events = [
    adv(gt('14', '09:00'), 'Aura', 'Tu total es Q539'),
    adv(gt('14', '09:10'), 'Aura', 'Cuenta Banrural 4012345678'),
    adv(gt('14', '15:30'), 'Leydi', 'Hola, sigues interesada?'),
    img(gt('14', '16:00'), 539),
    adv(gt('14', '16:30'), 'Leydi', 'Tu pedido ya está en proceso de alistamiento Q539'),
  ];
  const { episodes } = buildEpisodes(events);
  assert.equal(episodes.length, 1);
  const [ep] = episodes;
  assert.equal(ep.advisor, 'Aura');
  assert.equal(ep.paymentInfoBy, 'Aura');
  assert.equal(ep.medium, 'transferencia');
  assert.equal(ep.amount, 539);
  assert.equal(ep.shift, 'tarde');
  assert.deepEqual(ep.touchedBy.sort(), ['Aura', 'Leydi']);
  assert.ok(ep.issues.includes('varias_asesoras'));
  assert.equal(ep.confirmedBy, 'Leydi'); // el "alistamiento" confirma, no crea otra venta
});

test('episodios: pago por link sin imagen se ancla en la confirmación y toma el monto cotizado', () => {
  const events = [
    adv(gt('14', '11:00'), 'Aura', 'El total es Q873'),
    adv(gt('14', '11:05'), 'Aura', 'Paga aquí https://neolink.example/abc'),
    adv(gt('14', '12:03'), 'Aura', 'Pago recibido, gracias por su compra'),
  ];
  const { episodes } = buildEpisodes(events);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].type, 'confirmacion');
  assert.equal(episodes[0].amount, 873);
  assert.equal(episodes[0].medium, 'link');
  assert.equal(episodes[0].advisor, 'Aura');
});

test('episodios: comprobante reenviado no duplica; compra nueva con otra cotización sí', () => {
  const events = [
    adv(gt('14', '09:10'), 'Aura', 'Cuenta Banrural 4012345678 total Q539'),
    img(gt('14', '10:00'), 539),
    img(gt('14', '10:05'), 539),
    adv(gt('16', '09:00'), 'Leydi', 'Nueva compra, total Q420. Cuenta Banrural 4012345678'),
    img(gt('16', '10:00'), 420),
  ];
  const { episodes, resentReceipts } = buildEpisodes(events);
  assert.equal(resentReceipts, 1);
  assert.deepEqual(episodes.map((e) => [e.amount, e.advisor]), [[539, 'Aura'], [420, 'Leydi']]);
});

test('episodios: la asesora confirma antes de que llegue la foto = una sola venta', () => {
  const events = [
    adv(gt('14', '09:00'), 'Aura', 'Total Q700 cuenta Banrural 4012345678'),
    adv(gt('14', '10:00'), 'Aura', 'Pago recibido'),
    img(gt('14', '10:20'), 700),
  ];
  const { episodes } = buildEpisodes(events);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].type, 'comprobante');
});

const voucher = (at) => ({ id: ++n, at, role: 'customer', advisor: null, text: '', ocrAmount: null, image: true, voucher: true });
const customerText = (at, text) => ({ id: ++n, at, role: 'customer', advisor: null, text, ocrAmount: receiptAmountInText(text) });
const CANONICA = 'Gracias por elegir a STUDIO F! tu pedido ya esta en proceso de alistamiento 📦\n\nEl tiempo estimado de entrega es de 3 a 4 dias habiles sin contar sabados, domingos ni feriados.';

test('episodios: un comprobante sin medios de pago ni confirmación no es venta (no es concluyente)', () => {
  const { episodes, orphanReceipts } = buildEpisodes([adv(gt('14', '09:00'), 'Aura', 'Hola'), img(gt('14', '09:40'), 350)]);
  assert.equal(episodes.length, 0);
  assert.equal(orphanReceipts.length, 1);
});

test('episodios: sin medios de pago en el chat, la confirmación de la asesora sí valida el comprobante', () => {
  const { episodes } = buildEpisodes([img(gt('14', '09:40'), 350), adv(gt('14', '10:00'), 'Aura', CANONICA)]);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].verified, true);
  assert.ok(episodes[0].issues.includes('sin_medios_de_pago_en_chat'));
});

test('episodios: comprobante con medios de pago pero sin confirmación queda pendiente, no verificado', () => {
  const { episodes } = buildEpisodes([adv(gt('14', '09:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539'), img(gt('14', '10:00'), 539)]);
  assert.equal(episodes[0].status, 'pendiente_de_confirmar');
  assert.equal(episodes[0].verified, false);
});

test('episodios: el mensaje real "Gracias por elegir a STUDIO F" verifica la venta', () => {
  assert.equal(isConfirmationMessage(CANONICA), true);
  const { episodes } = buildEpisodes([
    adv(gt('14', '09:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539'),
    img(gt('14', '10:00'), 539),
    adv(gt('14', '10:20'), 'Leydi', CANONICA),
  ]);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].status, 'verificada');
  assert.equal(episodes[0].confirmedBy, 'Leydi');
  assert.equal(episodes[0].advisor, 'Aura'); // quien dio los medios de pago; Leydi solo verificó
});

test('episodios: lo que el cliente manda ANTES de recibir los medios de pago no es la prueba de esta compra', () => {
  const eventos = [
    img(gt('10', '09:00'), 539), // comprobante de una compra vieja / otra referencia
    adv(gt('14', '09:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q420'),
    img(gt('14', '10:00'), 420),
    adv(gt('14', '10:30'), 'Aura', CANONICA),
  ];
  const { episodes, orphanReceipts } = buildEpisodes(eventos);
  assert.deepEqual(episodes.map((e) => e.amount), [420]);
  assert.equal(orphanReceipts.length, 1);
});

test('episodios: el SMS del banco pegado como texto cuenta como prueba con su monto', () => {
  const sms = 'Se realizo una compra con tu tarjeta de débito por Q 539.00 Monetaria ****4162 en UNIDAD DE TARJETA a las 14:02.';
  assert.equal(receiptAmountInText(sms), 539);
  const { episodes } = buildEpisodes([
    adv(gt('18', '13:55'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/VEL130101196vx1kqwcj'),
    customerText(gt('18', '14:03'), sms),
    adv(gt('18', '14:10'), 'Leydi', CANONICA),
  ]);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].amount, 539);
  assert.equal(episodes[0].medium, 'link');
  assert.equal(episodes[0].verified, true);
});

test('texto del cliente: solo vale con vocabulario bancario y monto', () => {
  assert.equal(receiptAmountInText('ya hice la transferencia por Q539'), null);
  assert.equal(receiptAmountInText('Transferencia realizada Monto Q 1,286.00'), 1286);
  assert.equal(receiptAmountInText('Se realizó una compra por Q 80000'), null); // fuera de rango retail
  assert.equal(receiptAmountInText('Hola buenas tardes'), null);
});

test('episodios: pago por link con voucher "Aprobada" del cliente queda respaldado; sin él se marca', () => {
  const base = [
    adv(gt('18', '13:00'), 'Leydi', 'El total es Q823'),
    adv(gt('18', '13:05'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/abc'),
  ];
  const conVoucher = buildEpisodes([...base, voucher(gt('18', '13:30')), adv(gt('18', '13:40'), 'Leydi', CANONICA)]);
  assert.equal(conVoucher.episodes[0].amount, 823);
  assert.equal(conVoucher.episodes[0].voucher, true);
  assert.ok(!conVoucher.episodes[0].issues.includes('sin_prueba_del_cliente'));
  const sinNada = buildEpisodes([...base, adv(gt('18', '13:40'), 'Leydi', CANONICA)]);
  assert.ok(sinNada.episodes[0].issues.includes('sin_prueba_del_cliente'));
});

test('episodios: la segunda compra se atribuye con lo ocurrido desde la primera, no con medios de pago viejos', () => {
  const eventos = [
    adv(gt('14', '09:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539'),
    img(gt('14', '10:00'), 539),
    adv(gt('14', '10:20'), 'Aura', CANONICA),
    adv(gt('16', '15:30'), 'Leydi', 'Para esta compra el total es Q420'),
    img(gt('16', '16:00'), 420),
    adv(gt('16', '16:10'), 'Leydi', CANONICA),
  ];
  const { episodes } = buildEpisodes(eventos);
  assert.deepEqual(episodes.map((e) => [e.amount, e.advisor, e.verified]), [[539, 'Aura', true], [420, 'Leydi', true]]);
});

test('medio de pago: link vs transferencia', () => {
  assert.equal(paymentMedium('Paga aquí https://x.co/1'), 'link');
  assert.equal(paymentMedium('Cuenta Banrural 4012345678'), 'transferencia');
  assert.equal(paymentMedium('Hola'), null);
});

const cm = (at, text) => ({ id: ++n, at, role: 'customer', advisor: null, text, ocrAmount: null });

test('precio aprobado: el cliente acepta lo cotizado y se usa ese total', () => {
  const eventos = [
    adv(gt('18', '10:00'), 'Leydi', 'El jean talla 8 queda en Q420'),
    cm(gt('18', '10:05'), 'Quiero entonces el jean talla 8 de la referencia'),
    adv(gt('18', '10:10'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/abc'),
  ];
  assert.deepEqual(approvedQuote(eventos, null, gt('18', '11:00')), { amount: 420, at: gt('18', '10:00'), approved: true });
});

test('precio aprobado: si pide algo más y la asesora vuelve a cotizar, vale la última cotización aprobada', () => {
  const eventos = [
    adv(gt('18', '10:00'), 'Leydi', 'El jean talla 8 queda en Q420'),
    cm(gt('18', '10:05'), 'Quiero ese. Y también la blusa'),
    adv(gt('18', '10:08'), 'Leydi', 'Con la blusa el total es Q650'),
    cm(gt('18', '10:10'), 'Listo, pásame el link'),
    adv(gt('18', '10:12'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/abc'),
  ];
  assert.equal(approvedQuote(eventos, null, gt('18', '11:00')).amount, 650);
});

test('precio aprobado: darle los medios de pago implica que el total estaba acordado', () => {
  const eventos = [adv(gt('18', '10:00'), 'Leydi', 'Total Q823'), adv(gt('18', '10:05'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/abc')];
  assert.equal(approvedQuote(eventos, null, gt('18', '11:00')).approved, true);
});

test('precio aprobado: sin aceptación ni medios de pago se usa la última cotización pero marcada como no aprobada', () => {
  const eventos = [adv(gt('18', '10:00'), 'Leydi', 'Total Q823'), cm(gt('18', '10:05'), 'Déjame pensarlo')];
  assert.deepEqual(approvedQuote(eventos, null, gt('18', '11:00')), { amount: 823, at: gt('18', '10:00'), approved: false });
  assert.equal(approvedQuote([], null, gt('18', '11:00')), null);
});

test('aceptación: "no quiero" no cuenta', () => {
  assert.equal(acceptsOffer('Quiero el jean'), true);
  assert.equal(acceptsOffer('no lo quiero, gracias'), false);
  assert.equal(acceptsOffer('Déjame pensarlo'), false);
});

test('episodios: pago por link sin monto en el chat usa el precio aprobado y queda por validar', () => {
  const eventos = [
    adv(gt('18', '13:00'), 'Leydi', 'El jean talla 8 queda en Q420'),
    cm(gt('18', '13:02'), 'Quiero entonces el jean talla 8 de la referencia'),
    adv(gt('18', '13:05'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/abc'),
    voucher(gt('18', '13:30')),
    adv(gt('18', '13:40'), 'Leydi', CANONICA),
  ];
  const { episodes } = buildEpisodes(eventos);
  const [ep] = episodes;
  assert.equal(ep.amount, 420);
  assert.equal(ep.amountBasis, 'precio_aprobado');
  assert.equal(ep.priceApprovedByCustomer, true);
  assert.ok(ep.issues.includes('monto_por_validar'));
  assert.ok(!ep.issues.includes('precio_sin_aprobacion_del_cliente'));
});

test('episodios: con comprobante que trae el monto, la base es el documento y no se pide validar', () => {
  const eventos = [adv(gt('18', '13:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539'), img(gt('18', '14:00'), 539), adv(gt('18', '14:10'), 'Aura', CANONICA)];
  const [ep] = buildEpisodes(eventos).episodes;
  assert.equal(ep.amountBasis, 'comprobante');
  assert.ok(!ep.issues.includes('monto_por_validar'));
});

test('medios de pago de hace días no cuentan: gana quien atendía al cliente al pagar', () => {
  const eventos = [
    adv(gt('14', '10:00'), 'Luisa', 'Cuenta Banrural 4012345678 total Q350'), // 3 días antes, compra que no se cerró
    adv(gt('17', '16:35'), 'Luisa', 'Bota recta'),
    adv(gt('17', '16:36'), 'Aura', '¿Lo agregamos?'),
    img(gt('17', '16:38'), 349.5),
    adv(gt('17', '16:55'), 'Aura', CANONICA),
  ];
  const [ep] = buildEpisodes(eventos).episodes;
  assert.equal(ep.advisor, 'Aura');
  assert.equal(ep.rule, 'ultimo_asesor_antes_del_pago');
  assert.equal(ep.amount, 349.5);
});

test('medios de pago del mismo día siguen mandando (cambio de turno)', () => {
  const eventos = [
    adv(gt('17', '09:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539'),
    adv(gt('17', '15:30'), 'Leydi', 'Hola, sigues interesada?'),
    img(gt('17', '16:00'), 539),
  ];
  assert.equal(buildEpisodes(eventos).episodes[0]?.advisor, 'Aura');
});

test('otra asesora solo conversa después de los medios de pago: la venta sigue siendo de quien los dio', () => {
  const eventos = [
    adv(gt('17', '10:21'), 'Luisa', 'https://pay.neolink.com.gt/VEL130042900'),
    adv(gt('17', '16:30'), 'Aura', 'Quedo atenta al comprobante'),
    img(gt('17', '16:38'), 349.5),
    adv(gt('17', '16:55'), 'Aura', CANONICA),
  ];
  const [ep] = buildEpisodes(eventos).episodes;
  assert.equal(ep.advisor, 'Luisa');
  assert.equal(ep.attributionUncertain, false);
});

test('una sola asesora de principio a fin no queda por validar', () => {
  const eventos = [
    adv(gt('17', '09:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539'),
    img(gt('17', '10:00'), 539),
    adv(gt('17', '10:20'), 'Aura', CANONICA),
  ];
  assert.equal(buildEpisodes(eventos).episodes[0]?.attributionUncertain, false);
});

test('varias prendas cotizadas y confirmación sin comprobante: se listan las cifras y queda por validar', () => {
  const eventos = [
    adv(gt('18', '11:55'), 'Leydi', 'Q749 HOY Q374'),
    adv(gt('18', '11:55'), 'Leydi', 'Q699 HOY Q349'),
    adv(gt('18', '12:20'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/VEL1'),
    adv(gt('18', '13:00'), 'Leydi', CANONICA),
  ];
  const [ep] = buildEpisodes(eventos).episodes;
  assert.deepEqual(ep.quotedAmounts, [374, 349]);
  assert.ok(ep.issues.includes('varias_cotizaciones'));
});

test('el total de la cotización se lee aunque traiga (N prendas) y el ahorro después', () => {
  assert.equal(quotedAmountIn('🛍️ *Total a pagar (1 prenda): Q802.17*\n🎉 *¡Te ahorras Q152.83!*'), 802.17);
  assert.equal(quotedAmountIn('━━━\n🚚 Envío a domicilio: Q56.00\n🛍️ *Total a pagar (3 prendas): Q2297.00*'), 2297);
});

test('venta pendiente: medios de pago entregados sin comprobante ni confirmación', () => {
  const eventos = [
    adv(gt('18', '11:55'), 'Leydi', 'Q749 HOY Q374'),
    adv(gt('18', '11:56'), 'Leydi', '¿Deseas llevarlo?'),
    { id: ++n, at: gt('18', '12:05'), role: 'customer', advisor: null, text: 'Si lo quiero, transferencia', ocrAmount: null },
    adv(gt('18', '12:10'), 'Leydi', 'Paga aquí https://pay.neolink.com.gt/VEL1'),
  ];
  const r = buildEpisodes(eventos, { asOf: gt('18', '16:00') });
  assert.equal(r.episodes.length, 0);
  assert.equal(r.pending.advisor, 'Leydi');
  assert.equal(r.pending.medium, 'link');
  assert.equal(r.pending.amount, 374);
  assert.equal(r.pending.customerAccepted, true);
});

test('el pendiente se vuelve pagado cuando llega el comprobante, y a las 4 pm todavía era pendiente', () => {
  const eventos = [
    adv(gt('18', '12:10'), 'Leydi', 'Total Q374. Cuenta Banrural 4012345678'),
    img(gt('18', '17:30'), 374),
    adv(gt('18', '17:40'), 'Leydi', CANONICA),
  ];
  const a4pm = buildEpisodes(eventos.filter((e) => +new Date(e.at) <= +gt('18', '16:00')), { asOf: gt('18', '16:00') });
  assert.equal(a4pm.episodes.length, 0);
  assert.ok(a4pm.pending);
  const cierre = buildEpisodes(eventos, { asOf: gt('18', '21:00') });
  assert.equal(cierre.episodes.length, 1);
  assert.equal(cierre.episodes[0].amount, 374);
  assert.equal(cierre.pending, null);
});

test('medios de pago de hace más de 24 h no son una venta pendiente', () => {
  const eventos = [adv(gt('16', '10:00'), 'Aura', 'Cuenta Banrural 4012345678 total Q539')];
  assert.equal(buildEpisodes(eventos, { asOf: gt('18', '10:00') }).pending, null);
});
