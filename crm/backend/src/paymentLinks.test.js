import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkAmount, linkUrls, fetchLinkAmount, _setFetchForTests } from './paymentLinks.js';

const LINK = 'https://pay.neolink.com.gt/VEL13032153o150jqhym/1634938639fe52450/166234316166ce4526777';

test('el monto sale del texto de la página de pago, en HTML o en markdown', () => {
  assert.equal(parseLinkAmount('<h3><strong>Monto:</strong></h3><h3><strong>Q1,461.00</strong></h3>'), 1461);
  assert.equal(parseLinkAmount('### **Monto:**\n\n### **Q1,461.00**'), 1461);
  assert.equal(parseLinkAmount('<div>Monto:&nbsp;Q 749.50</div>'), 749.5);
  assert.equal(parseLinkAmount('Monto: Q988'), 988);
  assert.equal(parseLinkAmount('Total del pedido Q1,000.00 (sin la palabra clave)'), null);
  assert.equal(parseLinkAmount('Monto: Q0.00'), null);
  assert.equal(parseLinkAmount(''), null);
});

test('solo se reconocen links de NeoLink por https, aunque vengan dentro de un mensaje', () => {
  assert.deepEqual(linkUrls(`Hola! Aquí tu link de pago 👇 ${LINK} Gracias`), [LINK]);
  assert.deepEqual(linkUrls(`${LINK} y otra vez ${LINK}`), [LINK]);
  assert.deepEqual(linkUrls('http://pay.neolink.com.gt/abc'), []);
  assert.deepEqual(linkUrls('https://pay.neolink.com.gt.evil.com/abc'), []);
  assert.deepEqual(linkUrls('https://otro.com/pay.neolink.com.gt/abc'), []);
});

test('la lectura del link no sigue redirecciones ni abre otras direcciones', async () => {
  const calls = [];
  _setFetchForTests(async (url, opts) => { calls.push([url, opts.redirect]); return { status: 200, text: async () => '<h3>Monto:</h3><h3>Q1,461.00</h3>' }; });
  assert.deepEqual(await fetchLinkAmount(LINK), { amount: 1461, error: null });
  assert.deepEqual(calls, [[LINK, 'manual']]);
  assert.equal((await fetchLinkAmount('https://evil.com/x')).error, 'dirección no permitida');
  assert.equal((await fetchLinkAmount('http://pay.neolink.com.gt/x')).error, 'dirección no permitida');
  assert.equal(calls.length, 1, 'no se pidió ninguna dirección ajena');
  _setFetchForTests(async () => ({ status: 302, text: async () => '' }));
  assert.match((await fetchLinkAmount(LINK)).error, /302/);
  _setFetchForTests(async () => ({ status: 200, text: async () => '<p>Página sin monto</p>' }));
  assert.equal((await fetchLinkAmount(LINK)).error, 'no se encontró el monto');
  _setFetchForTests(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); });
  assert.equal((await fetchLinkAmount(LINK)).error, 'la página tardó demasiado');
});
