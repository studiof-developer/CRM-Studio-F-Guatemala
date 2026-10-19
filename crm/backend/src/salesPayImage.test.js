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
  assert.equal(ep.advisor, 'Aura');
  assert.equal(ep.rule, 'dio_medios_de_pago');
  assert.equal(ep.attributionUncertain, false);
});
