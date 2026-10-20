import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChat } from './chatAnalysis.js';

const gt = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00-06:00`);
const win = { from: gt('19', '21:00'), to: gt('20', '13:45') };
const msg = (at, role, text, o = {}) => ({ at, inWindow: +at >= +win.from, role, text, referral: null, ...o });
const chat = (messages, o = {}) => ({ firstMessageAt: messages[0].at, firstReferral: null, messages, ...o });

test('pauta de nueva colección y de referencia puntual por el anuncio', () => {
  const ref = { source_id: 'ad-777', headline: 'Nueva colección', body: 'Descubre lo nuevo' };
  const k = classifyChat(chat([msg(gt('20', '09:00'), 'customer', 'Hola, quiero las referencias S741228B', { referral: ref })], { firstReferral: ref }), win);
  assert.ok(k.viaAd && k.isNew);
  assert.deepEqual(k.adIds, ['ad-777']);
  assert.deepEqual(k.refCodes, ['S741228B']);
  assert.ok(k.cats.includes('col') && k.cats.includes('ref'));
});

test('pauta con porcentaje de descuento: por anuncio o por el primer mensaje, no por una charla cualquiera', () => {
  const ad = classifyChat(chat([msg(gt('20', '10:00'), 'customer', 'Hola', { referral: { source_id: '1', headline: '50% OFF solo hoy' } })], { firstReferral: { source_id: '1', headline: '50% OFF solo hoy' } }), win);
  assert.deepEqual(ad.pcts, [50]);
  assert.ok(ad.cats.includes('desc'));
  const texto = classifyChat(chat([msg(gt('20', '10:00'), 'customer', 'Quiero las referencias con el 30% OFF')]), win);
  assert.ok(texto.cats.includes('desc'));
  const ruido = classifyChat(chat([msg(gt('20', '10:00'), 'customer', 'Ya pagué el 50% del pedido')]), win);
  assert.ok(!ruido.cats.includes('desc'));
});

test('guía y cambio de talla solo cuentan si el cliente lo escribió dentro del período', () => {
  const guia = classifyChat(chat([msg(gt('20', '11:00'), 'customer', 'Buenos días, ¿me da el número de guía de mi pedido?')]), win);
  assert.ok(guia.cats.includes('guia'));
  const cambio = classifyChat(chat([msg(gt('20', '11:00'), 'customer', 'Quiero cambiar la talla de la blusa que compré')]), win);
  assert.ok(cambio.cats.includes('cambio'));
  const viejo = classifyChat(chat([msg(gt('19', '10:00'), 'customer', 'Quiero cambiar la talla de la blusa')]), win);
  assert.ok(!viejo.cats.includes('cambio'));
  const otro = classifyChat(chat([msg(gt('20', '11:00'), 'customer', 'Hola, ¿qué tallas tienen?')]), win);
  assert.deepEqual(otro.cats, []);
});

test('atendido ayer que escribe hoy retoma; atendido hoy mismo no', () => {
  const retoma = classifyChat(chat([msg(gt('19', '15:00'), 'customer', 'Hola'), msg(gt('19', '15:05'), 'advisor', 'Buenas'), msg(gt('20', '11:00'), 'customer', 'Sigo interesada')]), win);
  assert.ok(retoma.cats.includes('retomo'));
  const hoy = classifyChat(chat([msg(gt('20', '09:00'), 'customer', 'Hola'), msg(gt('20', '09:05'), 'advisor', 'Buenas')]), win);
  assert.ok(!hoy.cats.includes('retomo'));
  const sinAtender = classifyChat(chat([msg(gt('19', '15:00'), 'customer', 'Hola'), msg(gt('20', '11:00'), 'customer', 'Hola otra vez')]), win);
  assert.ok(!sinAtender.cats.includes('retomo'));
});
