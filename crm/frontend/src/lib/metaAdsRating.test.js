import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateCpr, rateConv, executiveReading } from './metaAdsRating.js';

test('costo por conversación: bueno hasta 1.200, regular hasta 2.500, malo arriba (los umbrales del traficker)', () => {
  assert.equal(rateCpr(1200), 'good');
  assert.equal(rateCpr(1200.5), 'regular');
  assert.equal(rateCpr(2500), 'regular');
  assert.equal(rateCpr(2500.5), 'bad');
  assert.equal(rateCpr(null), null);
});

test('conversión clic → mensaje: buena sobre 25%, regular sobre 20%, a revisar debajo', () => {
  assert.equal(rateConv(25.01), 'good');
  assert.equal(rateConv(25), 'regular');
  assert.equal(rateConv(20.1), 'regular');
  assert.equal(rateConv(20), 'bad');
  assert.equal(rateConv(null), null);
});

test('la lectura ejecutiva reproduce la del informe del 19 al 21 de octubre', () => {
  const daily = [{ date: '2026-10-19', conversations: 150, costPerConversation: 2493 }, { date: '2026-10-20', conversations: 230, costPerConversation: 1926 }, { date: '2026-10-21', conversations: 142, costPerConversation: 1635 }];
  const rows = [{ name: 'E33 / 19.10', conversations: 168, costPerConversation: 1069 }, { name: 'Relanzamiento / 18.10', conversations: 103, costPerConversation: 2384 }, { name: 'Rebajas / 13.10', conversations: 38, costPerConversation: 3179 }];
  const totals = { conversations: 522, costPerConversation: 2010, conversionPct: 26.5 };
  const fmt = (n) => `$${Math.round(n)}`;
  const r = executiveReading({ daily, rows, totals, fmt, pct: (n) => `${n.toFixed(2)}%` });
  assert.match(r[0].title, /Mejor día: 20 de octubre/);
  assert.match(r[0].text, /230 conversaciones/);
  assert.match(r[1].title, /Principal generadora: E33/);
  assert.match(r[2].text, /rango regular/);
  assert.match(r[2].text, /supera el 25%/);
  assert.match(r[2].text, /Rebajas \/ 13\.10/);
});

test('un solo día no inventa "mejor día" y sin conversaciones no hay lectura de eficiencia', () => {
  const r = executiveReading({ daily: [], rows: [], totals: { conversations: 0, costPerConversation: null, conversionPct: null }, fmt: String, pct: String });
  assert.deepEqual(r, []);
});
