import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStoreStock } from './erpSync.js';

const row = (Sucursal, ExistenciaDisponible, extra = {}) => ({ CodBarras: '7703882706345', Referencia: 'S076864', Talla: '10', Color: 'NEGRO', Sucursal, ExistenciaDisponible, ...extra });

test('desglosa la existencia por sucursal y suma las filas repetidas de una misma sucursal', () => {
  const out = collectStoreStock([row('Oakland', 3), row('Majadas', 2), row('Naranjos', 1), row('Naranjos', 2)]);
  assert.deepEqual(out.map((e) => [e.sucursal, e.quantity]).sort(), [['Majadas', 2], ['Naranjos', 3], ['Oakland', 3]]);
  assert.ok(out.every((e) => e.sku === '7703882706345'));
});

test('no cuenta imperfectos, existencias en cero o negativas, ni filas sin sucursal', () => {
  assert.deepEqual(collectStoreStock([row('Bod. Imperfectos', 5), row('Oakland', 0), row('Majadas', -2), row('', 4), row(undefined, 4)]), []);
});

test('sin código de barras la llave es referencia, talla y color, igual que en products.sku', () => {
  const [e] = collectStoreStock([row('Oakland', 1, { CodBarras: null })]);
  assert.equal(e.sku, 'S076864_10_NEGRO');
});
