import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComponents, validateNew, describeTemplate, sequentialParamCount } from './whatsappTemplates.js';

const body = (text, examples) => ({ text, examples });
const fails = (fn, re) => assert.throws(fn, (e) => e.status === 400 && re.test(e.message));

test('variables en orden y con ejemplo', () => {
  assert.equal(sequentialParamCount('Hola {{1}}, tu guía {{2}}'), 2);
  assert.equal(sequentialParamCount('Hola'), 0);
  assert.equal(sequentialParamCount('Hola {{1}} {{3}}'), -1);
  assert.deepEqual(buildComponents({ body: body('Hola {{1}}', ['María']) }), [{ type: 'BODY', text: 'Hola {{1}}', example: { body_text: [['María']] } }]);
  fails(() => buildComponents({ body: body('Hola {{1}}', []) }), /valor de ejemplo/);
  fails(() => buildComponents({ body: body('Hola {{2}}', ['x']) }), /en orden/);
  fails(() => buildComponents({ body: body('', []) }), /obligatorio/);
  fails(() => buildComponents({ body: body('x'.repeat(1025), []) }), /1024/);
});

test('encabezado de texto (una variable) y de medios (con archivo de ejemplo)', () => {
  const h = buildComponents({ header: { format: 'TEXT', text: 'Oferta {{1}}', example: 'Ana' }, body: body('Hola', []) })[0];
  assert.deepEqual(h, { type: 'HEADER', format: 'TEXT', text: 'Oferta {{1}}', example: { header_text: ['Ana'] } });
  fails(() => buildComponents({ header: { format: 'TEXT', text: 'A {{1}} {{2}}', example: 'x' }, body: body('Hola', []) }), /una variable/);
  fails(() => buildComponents({ header: { format: 'TEXT', text: 'x'.repeat(61) }, body: body('Hola', []) }), /60/);
  const img = buildComponents({ header: { format: 'IMAGE', handle: '4::abc' }, body: body('Hola', []) })[0];
  assert.deepEqual(img, { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::abc'] } });
  fails(() => buildComponents({ header: { format: 'VIDEO' }, body: body('Hola', []) }), /archivo de ejemplo/);
});

test('pie de página', () => {
  assert.deepEqual(buildComponents({ body: body('Hola', []), footer: ' Studio F ' }).at(-1), { type: 'FOOTER', text: 'Studio F' });
  fails(() => buildComponents({ body: body('Hola', []), footer: 'x'.repeat(61) }), /60/);
  fails(() => buildComponents({ body: body('Hola', []), footer: 'Hola {{1}}' }), /variables/);
});

test('botones: tipos, límites y orden de las respuestas rápidas', () => {
  const ok = buildComponents({ body: body('Hola', []), buttons: [{ type: 'URL', text: 'Ver catálogo', url: 'https://studiof.gt/catalogo' }, { type: 'PHONE_NUMBER', text: 'Llamar', phone: '+502 5555-1234' }] });
  assert.deepEqual(ok.at(-1), { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver catálogo', url: 'https://studiof.gt/catalogo' }, { type: 'PHONE_NUMBER', text: 'Llamar', phone_number: '+50255551234' }] });
  const mk = (buttons) => () => buildComponents({ body: body('Hola', []), buttons });
  fails(mk([{ type: 'URL', text: 'x', url: 'studiof.gt' }]), /https/);
  fails(mk([{ type: 'URL', text: 'x', url: 'https://a.gt/{{1}}' }]), /variable/);
  fails(mk([{ type: 'PHONE_NUMBER', text: 'x', phone: '55551234' }]), /código de país/);
  fails(mk([{ type: 'QUICK_REPLY', text: 'x'.repeat(26) }]), /25/);
  fails(mk([1, 2, 3].map((n) => ({ type: 'URL', text: `b${n}`, url: 'https://a.gt' }))), /2 botones de enlace|Máximo 2/);
  fails(mk([{ type: 'QUICK_REPLY', text: 'a' }, { type: 'URL', text: 'b', url: 'https://a.gt' }, { type: 'QUICK_REPLY', text: 'c' }]), /juntas/);
  assert.ok(mk([{ type: 'URL', text: 'b', url: 'https://a.gt' }, { type: 'QUICK_REPLY', text: 'a' }, { type: 'QUICK_REPLY', text: 'c' }])());
  fails(mk(Array.from({ length: 11 }, (_, i) => ({ type: 'QUICK_REPLY', text: `r${i}` }))), /10/);
});

test('nombre, categoría e idioma', () => {
  assert.doesNotThrow(() => validateNew({ name: 'promo_octubre', category: 'MARKETING', language: 'es' }));
  fails(() => validateNew({ name: 'Promo Octubre', category: 'MARKETING', language: 'es' }), /minúsculas/);
  fails(() => validateNew({ name: 'promo', category: 'AUTHENTICATION', language: 'es' }), /Categoría/);
  fails(() => validateNew({ name: 'promo', category: 'MARKETING', language: 'xx' }), /Idioma/);
});

test('describeTemplate vuelve a la forma simple de la pantalla', () => {
  const d = describeTemplate({
    id: '123', name: 'promo', language: 'es', category: 'MARKETING', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', quality_score: { score: 'GREEN' },
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent/x.jpg'] } },
      { type: 'BODY', text: 'Hola {{1}}', example: { body_text: [['Ana']] } },
      { type: 'FOOTER', text: 'Studio F' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://a.gt' }] },
    ],
  });
  assert.equal(d.rejectedReason, 'INVALID_FORMAT');
  assert.equal(d.quality, 'GREEN');
  assert.deepEqual(d.header, { format: 'IMAGE', text: null, example: 'https://scontent/x.jpg' });
  assert.deepEqual(d.bodyExamples, ['Ana']);
  assert.deepEqual(d.buttons, [{ type: 'URL', text: 'Ver', url: 'https://a.gt', phone: null }]);
  assert.equal(describeTemplate({ name: 'x', language: 'es', rejected_reason: 'NONE', components: [] }).rejectedReason, null);
});
