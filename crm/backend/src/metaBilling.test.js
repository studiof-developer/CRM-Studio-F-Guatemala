import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingLevel } from './metaBilling.js';

test('niveles de alerta según lo que falta para el cobro automático', () => {
  assert.equal(billingLevel({ remaining: 20 }), 'ok');
  assert.equal(billingLevel({ remaining: 7 }), 'warn'); // $7: alerta normal
  assert.equal(billingLevel({ remaining: 5.5 }), 'warn');
  assert.equal(billingLevel({ remaining: 4 }), 'critical'); // $4: alerta fuerte
  assert.equal(billingLevel({ remaining: -1 }), 'critical'); // ya pasó el umbral y no se ha cobrado
  assert.equal(billingLevel({ remaining: null }), 'unknown');
});

test('un bloqueo real gana sobre cualquier estimación; los umbrales se pueden cambiar', () => {
  assert.equal(billingLevel({ remaining: 30, blocked: true }), 'blocked');
  assert.equal(billingLevel({ remaining: null, blocked: true }), 'blocked');
  assert.equal(billingLevel({ remaining: 12, warnAt: 15, criticalAt: 10 }), 'warn');
});
