import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowMetrics, totalsOf, previousRange, observations, validRange, fillDaily, DEFAULT_THRESHOLDS } from './metaAdsReport.js';

const row = (name, spend, conv, clicks, ctr, id = name) => ({ campaign_id: id, campaign_name: name, spend: String(spend), impressions: '10000', reach: '8000', frequency: '1.2', inline_link_clicks: String(clicks), inline_link_click_ctr: String(ctr), cpm: '500', actions: conv == null ? [] : [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(conv) }] });
const money = (n) => `$${Math.round(n)}`;

test('las métricas salen igual que en el Administrador de anuncios (captura del 20 de octubre: $47.071, 41 conversaciones, 141 clics)', () => {
  const m = rowMetrics(row('JD - Fase 2 / E33', 47071, 41, 141, 2.61));
  assert.equal(Math.round(m.costPerConversation), 1148);
  assert.equal(m.conversionPct.toFixed(2), '29.08');
  assert.equal(Math.round(m.cpc), 334);
  assert.equal(m.ctr, 2.61);
});

test('sin conversaciones no hay costo por conversación ni división entre cero', () => {
  const m = rowMetrics(row('Alcance', 30000, null, 3, 0));
  assert.equal(m.conversations, 0);
  assert.equal(m.costPerConversation, null);
  assert.equal(rowMetrics(row('Sin clics', 100, 2, 0, 0)).conversionPct, null);
});

test('los totales recalculan los costos con las sumas (no promedian porcentajes)', () => {
  const t = totalsOf([rowMetrics(row('A', 47071, 41, 141, 2.6)), rowMetrics(row('B', 34994, 19, 47, 1.8))]);
  assert.equal(t.spend, 82065);
  assert.equal(t.conversations, 60);
  assert.equal(Math.round(t.costPerConversation), 1368);
  assert.equal(t.conversionPct.toFixed(2), '31.91');
});

test('el período anterior tiene la misma longitud y termina el día antes', () => {
  assert.deepEqual(previousRange('2026-10-20', '2026-10-20'), { since: '2026-10-19', until: '2026-10-19' });
  assert.deepEqual(previousRange('2026-10-01', '2026-10-07'), { since: '2026-09-24', until: '2026-09-30' });
});

test('observaciones: CTR, costo que sube, gasto sin conversaciones y la más barata', () => {
  const rows = [rowMetrics(row('E32', 27977, 9, 11, 1.02)), rowMetrics(row('E33', 47071, 41, 141, 2.61)), rowMetrics(row('Alcance', 30000, null, 3, 0))];
  const previous = [rowMetrics(row('E32', 20000, 9, 11, 1.1))];
  const text = observations({ rows, previous, totals: totalsOf(rows), since: '2026-10-20', until: '2026-10-20', fmt: money }).join('\n');
  assert.match(text, /CTR de 1 campaña está por encima de 2% ✅/);
  assert.match(text, /CTR por debajo de 2%: E32 \(1\.02%\), Alcance/);
  assert.match(text, /E32: el costo por conversación subió de \$2222 a \$3109/);
  assert.match(text, /Alcance gastó \$30000 y no trajo conversaciones/);
  assert.match(text, /La más barata: E33 a \$1148/);
  assert.equal(observations({ rows: [], previous: [], totals: totalsOf([]), since: '2026-10-20', until: '2026-10-20', fmt: money })[0], 'No hubo gasto en este período.');
});

test('el rango de fechas que manda la pantalla (un día o varios) es válido; basura o al revés, no', () => {
  assert.equal(validRange('2026-10-21', '2026-10-21'), true);
  assert.equal(validRange('2026-10-16', '2026-10-22'), true);
  assert.equal(validRange('2026-10-22', '2026-10-16'), false);
  assert.equal(validRange('ayer', '2026-10-16'), false);
  assert.equal(validRange(undefined, undefined), false);
});

test('la serie por día trae todos los días del período, con ceros donde no hubo gasto', () => {
  const d = fillDaily([{ date: '2026-10-20', spend: 100, conversations: 2, costPerConversation: 50, linkClicks: 9, impressions: 500 }], '2026-10-19', '2026-10-21');
  assert.deepEqual(d.map((x) => [x.date, x.spend, x.conversations]), [['2026-10-19', 0, 0], ['2026-10-20', 100, 2], ['2026-10-21', 0, 0]]);
  assert.equal(d[0].costPerConversation, null);
});

test('la serie por día calcula la conversión, el CPC y el CTR de cada día con las sumas del día', () => {
  const d = fillDaily([{ date: '2026-10-20', spend: 443030, conversations: 230, costPerConversation: 1926.2, linkClicks: 840, impressions: 40000 }], '2026-10-20', '2026-10-21');
  assert.equal(d[0].conversionPct.toFixed(2), '27.38');
  assert.equal(Math.round(d[0].cpc), 527);
  assert.equal(d[0].ctr.toFixed(2), '2.10');
  assert.equal(d[1].conversionPct, null);
  assert.equal(d[1].cpc, null);
});

test('los umbrales de calificación traen los valores del traficker por defecto', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, { cprGood: 1200, cprRegular: 2500, convGood: 25, convRegular: 20 });
});
