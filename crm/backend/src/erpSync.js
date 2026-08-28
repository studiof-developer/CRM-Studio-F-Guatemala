import { pool } from './db.js';
import { fetchErpCustomers, fetchErpInventory } from './erpClient.js';

// Postgres parses an ISO datetime string as a DATE just fine, but this makes the
// "no date given" case explicit instead of handing it an empty string.
function toDateOrNull(v) {
  return v ? v.slice(0, 10) : null;
}

// Bulk INSERT ... ON CONFLICT in chunks — 18k+ customers one row per round-trip would
// take minutes; a few hundred round trips of batched rows takes seconds. Only
// `updateColumns` get overwritten on conflict — any column in `columns` but not
// `updateColumns` (price, discount_pct, active on products) is set once on first
// insert and left alone after, so a manual edit in the CRM survives the next sync.
async function bulkUpsert(table, columns, conflictColumn, updateColumns, rows, mapRow) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((row, idx) => {
      values.push(...mapRow(row));
      const base = idx * columns.length;
      return `(${columns.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    await pool.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}
       ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updateColumns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
      values
    );
  }
}

const CUSTOMER_COLUMNS = [
  'numero_cliente', 'nit_dpi', 'nombre', 'telefono', 'celular', 'email', 'fecha_cumpleanos',
  'direccion', 'departamento', 'ciudad', 'fecha_ultima_compra', 'dias_sin_compra',
  'segmento_sin_compra', 'sucursal_preferida', 'sucursal_ultima_compra', 'numero_ultima_factura',
  'vendedor_ultima_factura', 'facturas_totales', 'unidades_totales', 'venta_neta_total',
  'unidades_full_precio', 'unidades_promocion', 'venta_full_precio', 'venta_promocion',
  'porcentaje_full_precio', 'blusas', 'jeans', 'vestidos', 'pantalones', 'otros',
  'talla_blusa', 'talla_jean', 'talla_calzado', 'synced_at',
];
// Every column updates on a resync except the primary key itself.
const CUSTOMER_UPDATE_COLUMNS = CUSTOMER_COLUMNS.filter((c) => c !== 'numero_cliente');

function mapCustomerRow(r) {
  return [
    r.NumeroCliente, r.NitDpi, r.Cliente, r.Telefono, r.Celular, r.Email, toDateOrNull(r.FechaCumpleanos),
    r.Direccion, r.Departamento, r.Ciudad, toDateOrNull(r.FechaUltimaCompra), r.DiasSinCompra,
    r.SegmentoSinCompra, r.SucursalPreferida, r.SucursalUltimaCompra, r.NumeroUltimaFactura,
    r.VendedorUltimaFactura, r.FacturasTotales, r.UnidadesTotales, r.VentaNetaTotal,
    r.UnidadesFullPrecio, r.UnidadesPromocion, r.VentaFullPrecio, r.VentaPromocion,
    r.PorcentajeFullPrecio, r.Blusas, r.Jeans, r.Vestidos, r.Pantalones, r.Otros,
    r.TallaBlusa, r.TallaJean, r.TallaCalzado, new Date(),
  ];
}

async function syncErpCustomers() {
  const rows = await fetchErpCustomers();
  await bulkUpsert('erp_customers', CUSTOMER_COLUMNS, 'numero_cliente', CUSTOMER_UPDATE_COLUMNS, rows, mapCustomerRow);
  return rows.length;
}

// "Bod. Imperfectos" (and similar) holds defective/returned pieces — never counted as
// sellable stock, or the bot/an advisor could offer a customer a defective unit as new.
function isSellableSucursal(sucursal) {
  return !/imperfecto/i.test(sucursal || '');
}

async function syncErpInventory() {
  const rows = await fetchErpInventory();

  // One existencia row per sucursal — collapsed here into one row per sellable item
  // (CodBarras, the real per-size-per-color barcode), summing available stock across
  // every sucursal that isn't the defects warehouse. Name/line/size/color are the same
  // across every row for a given CodBarras, so the first one seen is as good as any.
  const bySku = new Map();
  for (const r of rows) {
    if (!r.CodBarras) continue;
    let p = bySku.get(r.CodBarras);
    if (!p) {
      p = {
        sku: r.CodBarras,
        name: r.DescripcionArticulo || r.NombreTallaColor || r.CodBarras,
        category: r.DescripTipoPrenda || 'Sin categoría',
        line: r.Linea || null,
        size: r.Talla || null,
        color: r.Color || null,
        stock: 0,
      };
      bySku.set(r.CodBarras, p);
    }
    if (isSellableSucursal(r.Sucursal)) p.stock += Number(r.ExistenciaDisponible) || 0;
  }

  const products = [...bySku.values()];
  await bulkUpsert(
    'products',
    ['sku', 'name', 'category', 'line', 'size', 'color', 'price', 'discount_pct', 'stock_quantity', 'active'],
    'sku',
    ['name', 'category', 'line', 'size', 'color', 'stock_quantity'],
    products,
    (p) => [p.sku, p.name, p.category, p.line, p.size, p.color, null, 0, p.stock, true]
  );
  return products.length;
}

export async function runErpSync() {
  try {
    const n = await syncErpCustomers();
    console.log(`ERP sync: ${n} clientes actualizados`);
  } catch (err) {
    console.error('ERP customers sync failed', err);
  }
  try {
    const n = await syncErpInventory();
    console.log(`ERP sync: ${n} productos actualizados`);
  } catch (err) {
    console.error('ERP inventory sync failed', err);
  }
}
