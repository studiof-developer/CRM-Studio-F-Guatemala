import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodRange, previousPeriod, sumUntil, deltaPct, periodTitle } from './salesCompare.js';

const today = '2026-10-21'; // miércoles

test('rangos de cada período (semana desde el lunes)', () => {
  assert.deepEqual(periodRange('hoy', null, null, today), { from: today, to: today });
  assert.deepEqual(periodRange('ayer', null, null, today), { from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(periodRange('esta_semana', null, null, today), { from: '2026-10-19', to: today });
  assert.deepEqual(periodRange('este_mes', null, null, today), { from: '2026-10-01', to: today });
  assert.deepEqual(periodRange('mes_anterior', null, null, today), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodRange('mes_anterior', null, null, '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(periodRange('personalizado', '2026-10-05', '2026-10-09', today), { from: '2026-10-05', to: '2026-10-09' });
});

test('con qué se compara cada período', () => {
  assert.deepEqual(previousPeriod('hoy', { from: today, to: today }, '13:45'), { from: '2026-10-20', to: '2026-10-20', untilTime: '13:45', label: 'ayer a esta misma hora' });
  assert.equal(previousPeriod('ayer', { from: '2026-10-20', to: '2026-10-20' }, '13:45').from, '2026-10-19');
  const w = previousPeriod('esta_semana', { from: '2026-10-19', to: today }, '13:45');
  assert.deepEqual([w.from, w.to], ['2026-10-12', '2026-10-14']); // lunes a miércoles de la semana pasada
  const m = previousPeriod('este_mes', { from: '2026-10-01', to: today }, '13:45');
  assert.deepEqual([m.from, m.to], ['2026-09-01', '2026-09-21']);
  const mm = previousPeriod('este_mes', { from: '2026-03-01', to: '2026-03-31' }, '13:45'); // febrero no tiene 31 días
  assert.deepEqual([mm.from, mm.to], ['2026-02-01', '2026-02-28']);
  const prev = previousPeriod('mes_anterior', { from: '2026-09-01', to: '2026-09-30' }, '13:45');
  assert.deepEqual([prev.from, prev.to], ['2026-08-01', '2026-08-31']);
  const c = previousPeriod('personalizado', { from: '2026-10-05', to: '2026-10-09' }, '13:45');
  assert.deepEqual([c.from, c.to], ['2026-09-30', '2026-10-04']); // 5 días antes
});

test('suma hasta cierta hora de Guatemala y solo ventas confirmadas', () => {
  const t = (hhmm, amount, status = 'confirmada') => ({ createdAt: `2026-10-20T${String(Number(hhmm.slice(0, 2)) + 6).padStart(2, '0')}:${hhmm.slice(3)}:00Z`, amount, status });
  const txs = [t('09:00', 500), t('13:30', 300), t('13:50', 700), t('16:00', 900), t('10:00', 400, 'revisar')];
  assert.equal(sumUntil(txs, '13:45'), 800);
  assert.equal(sumUntil(txs, null), 2400);
  assert.equal(sumUntil([], '13:45'), 0);
});

test('variación y títulos', () => {
  assert.equal(deltaPct(1575, 1500), 5);
  assert.equal(deltaPct(900, 1000), -10);
  assert.equal(deltaPct(500, 0), null);
  assert.equal(periodTitle('hoy', { from: today, to: today }), 'Hoy · miércoles, 21 de octubre');
  assert.equal(periodTitle('esta_semana', { from: '2026-10-19', to: today }), 'Semana del 19 al 21 de octubre');
  assert.equal(periodTitle('este_mes', { from: '2026-10-01', to: today }), 'Octubre de 2026 · hasta hoy');
});
