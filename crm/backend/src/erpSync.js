import { pool } from './db.js';
import { fetchErpCustomers, fetchErpInventory, fetchErpReferencePrices } from './erpClient.js';

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
       ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updateColumns.map((c) => c.includes('=') ? c : `${c} = EXCLUDED.${c}`).join(', ')}`,
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

function buildReferencePriceMap(refPriceRows) {
  const exactMap = new Map();
  const baseMap = new Map();
  for (const r of refPriceRows || []) {
    const rawRef = String(r?.Referencia ?? r?.referencia ?? '').trim().toUpperCase();
    const priceVal = Number(r?.Precio ?? r?.precio ?? r?.PrecioVenta ?? r?.Valor);
    if (!rawRef || !Number.isFinite(priceVal) || priceVal <= 0) continue;
    exactMap.set(rawRef, priceVal);
    const baseRef = rawRef.replace(/[A-Z]$/, '');
    if (baseRef && baseRef !== rawRef && !baseMap.has(baseRef)) {
      baseMap.set(baseRef, priceVal);
    }
  }
  return { exactMap, baseMap };
}

function lookupReferencePrice({ exactMap, baseMap }, rawRef) {
  if (!rawRef) return null;
  const clean = String(rawRef).trim().toUpperCase();
  if (!clean) return null;
  if (exactMap.has(clean)) return exactMap.get(clean);
  const base = clean.replace(/[A-Z]$/, '');
  if (base && exactMap.has(base)) return exactMap.get(base);
  if (base && baseMap.has(base)) return baseMap.get(base);
  return null;
}

async function applyReferencePricesToExistingProducts(exactMap) {
  const entries = [...exactMap.entries()];
  if (!entries.length) return 0;
  let updatedTotal = 0;
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const values = [];
    const tuples = chunk.map(([ref, price], idx) => {
      values.push(ref, price);
      const base = idx * 2;
      return `($${base + 1}::text, $${base + 2}::numeric)`;
    }).join(',');

    const res = await pool.query(
      `UPDATE products p
       SET price = v.price
       FROM (VALUES ${tuples}) AS v(ref, price)
       WHERE (
         UPPER(TRIM(p.reference)) = v.ref
         OR REGEXP_REPLACE(UPPER(TRIM(COALESCE(p.reference, ''))), '[A-Z]$', '') = v.ref
         OR SPLIT_PART(UPPER(TRIM(p.sku)), '_', 1) = v.ref
       )
       AND (p.price IS DISTINCT FROM v.price)`,
      values
    );
    updatedTotal += res.rowCount || 0;
  }
  return updatedTotal;
}

async function syncErpInventory() {
  const [rows, refPriceRows] = await Promise.all([
    fetchErpInventory(),
    fetchErpReferencePrices().catch((err) => {
      console.error('ERP ref-precio sync warning:', err.message);
      return [];
    }),
  ]);

  const priceMaps = buildReferencePriceMap(refPriceRows);

  // One existencia row per sucursal — collapsed here into one row per sellable item
  // (CodBarras or Referencia+Talla+Color), summing available stock across
  // every sucursal that isn't the defects warehouse. Name/line/size/color are the same
  // across every row for a given CodBarras, so the first one seen is as good as any.
  const bySku = new Map();
  for (const r of rows) {
    if (!r.CodBarras && !r.Referencia) continue;
    const skuKey = r.CodBarras || `${r.Referencia}_${r.Talla || 'U'}_${r.Color || r.ColorSF || 'U'}`;
    let p = bySku.get(skuKey);
    if (!p) {
      const refPrice = lookupReferencePrice(priceMaps, r.Referencia);
      const inlinePriceVal = Number(r.Precio || r.PrecioVenta || r.PrecioPublico || r.PrecioLista || r.Valor || r.PVP || r.PrecioFinal || r.PrecioUnitario);
      const inlinePrice = Number.isFinite(inlinePriceVal) && inlinePriceVal > 0 ? inlinePriceVal : null;
      const price = refPrice ?? inlinePrice ?? 0;
      p = {
        sku: skuKey,
        reference: r.Referencia ? String(r.Referencia).trim() : null,
        barcode: r.CodBarras ? String(r.CodBarras).trim() : null,
        erp_article_id: Number(r.idArticulo) || null,
        name: r.DescripcionArticulo || r.NombreTallaColor || r.Referencia || skuKey,
        category: r.DescripTipoPrenda || 'Sin categoría',
        line: r.Linea || null,
        size: r.Talla || null,
        color: r.Color || r.ColorSF || null,
        price,
        stock: 0,
      };
      bySku.set(skuKey, p);
    }
    if (isSellableSucursal(r.Sucursal)) p.stock += Number(r.ExistenciaDisponible) || 0;
  }

  const products = [...bySku.values()];
  await bulkUpsert(
    'products',
    ['sku', 'reference', 'barcode', 'erp_article_id', 'name', 'category', 'line', 'size', 'color', 'price', 'discount_pct', 'stock_quantity', 'active'],
    'sku',
    [
      'reference', 'barcode', 'erp_article_id', 'name', 'category', 'line', 'size', 'color', 'stock_quantity',
      'price = CASE WHEN EXCLUDED.price > 0 THEN EXCLUDED.price ELSE COALESCE(products.price, 0) END',
    ],
    products,
    (p) => [p.sku, p.reference, p.barcode, p.erp_article_id, p.name, p.category, p.line, p.size, p.color, p.price, 0, p.stock, true]
  );

  // Also ensure any existing products in DB not in today's existencia rows get their reference price synced
  const extraPriceUpdates = await applyReferencePricesToExistingProducts(priceMaps.exactMap);
  return { productsCount: products.length, refPricesCount: priceMaps.exactMap.size, extraPriceUpdates };
}

export async function runErpSync() {
  try {
    const n = await syncErpCustomers();
    console.log(`ERP sync: ${n} clientes actualizados`);
  } catch (err) {
    console.error('ERP customers sync failed', err);
  }
  try {
    const res = await syncErpInventory();
    console.log(`ERP sync: ${res.productsCount} productos actualizados (${res.refPricesCount} precios por referencia desde /api/data/ref-precio, ${res.extraPriceUpdates} adicionales sincronizados)`);
  } catch (err) {
    console.error('ERP inventory sync failed', err);
  }
}

