import { test } from 'node:test';
import assert from 'node:assert/strict';
import { givesPaymentInfo, isPaymentInfoImageText, PAYMENT_IMAGE_MARKER, buildEpisodes } from './salesRules.js';

const gt = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00-06:00`);
let n = 1000;
const adv = (at, advisor, text) => ({ id: ++n, at, role: 'advisor', advisor, text, ocrAmount: null });
const proof = (at, ocrAmount) => ({ id: ++n, at, role: 'customer', advisor: null, text: '', ocrAmount, image: true });

test('el texto leído de la tarjeta de medios de pago se reconoce; una foto de producto no', () => {
  assert.equal(isPaymentInfoImageText('MEDIOS DE PAGO BANRURAL Cuenta Monetaria'), true);
  assert.equal(isPaymentInfoImageText('Banco Industrial BAC'), true);
  assert.equal(isPaymentInfoImageText('BLUSA TALLA M COLOR AZUL'), false);
  assert.equal(isPaymentInfoImageText(null), false);
});

test('el marcador de imagen de medios de pago cuenta como que la asesora los dio', () => {
  assert.equal(givesPaymentInfo(PAYMENT_IMAGE_MARKER), true);
  const eventos = [
    adv(gt('17', '10:21'), 'Luisa', 'https://pay.neolink.com.gt/VEL1'),
    adv(gt('17', '16:30'), 'Aura', PAYMENT_IMAGE_MARKER), // la imagen sin texto
    proof(gt('17', '16:38'), 349.5),
    adv(gt('17', '16:55'), 'Aura', 'Gracias por elegir a STUDIO F! tu pedido ya esta en proceso de alistamiento'),
  ];
  const [ep] = buildEpisodes(eventos).episodes;
  assert.equal(ep.advisor, 'Aura'); // la última en dar los medios de pago (la imagen), aunque Luisa mandó un link antes
  assert.equal(ep.rule, 'dio_medios_de_pago');
  assert.equal(ep.attributionUncertain, true); // dos asesoras dieron medios de pago: un supervisor lo confirma
});

test('cambio de turno: los medios de pago los dio Leydi (26 h antes), Aura solo recibe el comprobante: es de Leydi', () => {
  const eventos = [
    adv(gt('18', '13:30'), 'Leydi', PAYMENT_IMAGE_MARKER),
    adv(gt('19', '15:36'), 'Aura', 'Quedo atenta al comprobante para separarte de una vez'),
    proof(gt('19', '15:47'), 988),
    adv(gt('19', '15:55'), 'Aura', 'Gracias por elegir a STUDIO F! tu pedido ya esta en proceso de alistamiento'),
  ];
  const [ep] = buildEpisodes(eventos).episodes;
  assert.equal(ep.advisor, 'Leydi');
  assert.equal(ep.rule, 'dio_medios_de_pago');
  assert.equal(ep.attributionUncertain, false);
});

test('dos asesoras dieron medios de pago: gana la última pero queda por validar; con más de 3 días ya no cuenta', () => {
  const dos = buildEpisodes([
    adv(gt('17', '10:21'), 'Luisa', 'https://pay.neolink.com.gt/VEL1'),
    adv(gt('17', '16:30'), 'Aura', PAYMENT_IMAGE_MARKER),
    proof(gt('17', '16:38'), 349.5),
    adv(gt('17', '16:55'), 'Aura', 'Gracias por elegir a STUDIO F! tu pedido ya esta en proceso de alistamiento'),
  ]).episodes[0];
  assert.equal(dos.advisor, 'Aura');
  assert.equal(dos.attributionUncertain, true);

  const vieja = buildEpisodes([
    adv(gt('10', '10:00'), 'Luisa', 'Cuenta Banrural 4012345678 total Q350'),
    adv(gt('17', '16:36'), 'Aura', 'Lo agregamos?'),
    proof(gt('17', '16:38'), 349.5),
    adv(gt('17', '16:55'), 'Aura', 'Gracias por elegir a STUDIO F! tu pedido ya esta en proceso de alistamiento'),
  ]).episodes[0];
  assert.equal(vieja.advisor, 'Aura');
});
