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

let cachedPriceMaps = { exactMap: new Map(), baseMap: new Map() };
let lastPriceSyncAt = 0;
let inflightPriceSync = null;

function parseErpPriceValue(val) {
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : null;
  if (typeof val === 'string') {
    const cleaned = val.replace(/[^0-9.-]/g, '');
    const num = Number(cleaned);
    return Number.isFinite(num) && num > 0 ? num : null;
  }
  return null;
}

function normalizeRefExact(rawRef) {
  return String(rawRef ?? '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

function normalizeRefBase(exactRef) {
  return exactRef.replace(/[A-Z]+$/, '');
}

function buildReferencePriceMap(refPriceRows) {
  const exactMap = new Map();
  const baseMap = new Map();
  for (const r of refPriceRows || []) {
    if (!r || typeof r !== 'object') continue;
    const rawRef =
      r.Referencia ?? r.referencia ?? r.Ref ?? r.ref ?? r.Codigo ?? r.codigo ?? r.Estilo ?? r.estilo ?? '';
    const exactRef = normalizeRefExact(rawRef);
    const priceVal = parseErpPriceValue(
      r.Precio ?? r.precio ?? r.PrecioVenta ?? r.PrecioPublico ?? r.Valor ?? r.PVP ?? r.Tarifa
    );
    if (!exactRef || !priceVal) continue;
    exactMap.set(exactRef, priceVal);
    const baseRef = normalizeRefBase(exactRef);
    if (baseRef && !baseMap.has(baseRef)) {
      baseMap.set(baseRef, priceVal);
    }
  }
  return { exactMap, baseMap };
}

export function lookupReferencePrice(priceMaps, rawRef) {
  const maps = priceMaps || cachedPriceMaps;
  if (!rawRef || !maps) return null;
  const clean = normalizeRefExact(rawRef);
  if (!clean) return null;
  if (maps.exactMap?.has(clean)) return maps.exactMap.get(clean);
  const base = normalizeRefBase(clean);
  if (base && maps.exactMap?.has(base)) return maps.exactMap.get(base);
  if (base && maps.baseMap?.has(base)) return maps.baseMap.get(base);
  return null;
}

export function lookupCachedReferencePrice(rawRef) {
  return lookupReferencePrice(cachedPriceMaps, rawRef);
}

async function applyReferencePricesToExistingProducts(priceMaps) {
  const entries = [...(priceMaps?.exactMap?.entries() || [])];
  if (!entries.length) return 0;

  const exactRefs = [];
  const baseRefs = [];
  const prices = [];

  for (const [exactRef, price] of entries) {
    exactRefs.push(exactRef);
    baseRefs.push(normalizeRefBase(exactRef));
    prices.push(price);
  }

  const res = await pool.query(
    `WITH ref_prices AS (
       SELECT
         unnest($1::text[]) AS exact_ref,
         unnest($2::text[]) AS base_ref,
         unnest($3::numeric[]) AS price
     ),
     exact_lookup AS (
       SELECT DISTINCT ON (exact_ref) exact_ref, price
       FROM ref_prices
       WHERE exact_ref <> ''
     ),
     base_lookup AS (
       SELECT DISTINCT ON (base_ref) base_ref, price
       FROM ref_prices
       WHERE base_ref <> ''
     )
     UPDATE products p
     SET price = COALESCE(e.price, b.price)
     FROM (
       SELECT
         p2.id,
         REGEXP_REPLACE(UPPER(TRIM(COALESCE(NULLIF(p2.reference, ''), SPLIT_PART(p2.sku, '_', 1)))), '[\\s-]+', '', 'g') AS prod_exact_ref,
         REGEXP_REPLACE(REGEXP_REPLACE(UPPER(TRIM(COALESCE(NULLIF(p2.reference, ''), SPLIT_PART(p2.sku, '_', 1)))), '[\\s-]+', '', 'g'), '[A-Z]+$', '') AS prod_base_ref
       FROM products p2
     ) norm
     LEFT JOIN exact_lookup e ON e.exact_ref = norm.prod_exact_ref
     LEFT JOIN base_lookup b ON b.base_ref = norm.prod_base_ref
     WHERE p.id = norm.id
       AND COALESCE(e.price, b.price) IS NOT NULL
       AND p.price IS DISTINCT FROM COALESCE(e.price, b.price)`,
    [exactRefs, baseRefs, prices]
  );

  return res.rowCount || 0;
}

export async function syncErpReferencePrices() {
  const refPriceRows = await fetchErpReferencePrices();
  const priceMaps = buildReferencePriceMap(refPriceRows);
  if (priceMaps.exactMap.size > 0) {
    cachedPriceMaps = priceMaps;
    lastPriceSyncAt = Date.now();
  }
  const updatedCount = await applyReferencePricesToExistingProducts(priceMaps);
  return {
    refPricesCount: priceMaps.exactMap.size,
    updatedCount,
  };
}

export async function ensureErpPricesSynced(maxAgeMs = 2 * 60 * 1000) {
  if (Date.now() - lastPriceSyncAt < maxAgeMs && cachedPriceMaps.exactMap.size > 0) {
    return { refPricesCount: cachedPriceMaps.exactMap.size, updatedCount: 0, cached: true };
  }
  if (inflightPriceSync) return inflightPriceSync;
  inflightPriceSync = syncErpReferencePrices()
    .catch((err) => {
      console.error('ensureErpPricesSynced failed:', err.message);
      return { refPricesCount: cachedPriceMaps.exactMap.size, updatedCount: 0, error: err.message };
    })
    .finally(() => {
      inflightPriceSync = null;
    });
  return inflightPriceSync;
}

async function syncErpInventory() {
  let priceMaps = cachedPriceMaps;
  if (!priceMaps || priceMaps.exactMap.size === 0) {
    try {
      const refPriceRows = await fetchErpReferencePrices();
      priceMaps = buildReferencePriceMap(refPriceRows);
      if (priceMaps.exactMap.size > 0) {
        cachedPriceMaps = priceMaps;
        lastPriceSyncAt = Date.now();
      }
    } catch (err) {
      console.error('ERP ref-precio sync warning:', err.message);
    }
  }

  const rows = await fetchErpInventory();

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
      const price = refPrice ?? inlinePrice ?? null;
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
      'price = CASE WHEN EXCLUDED.price IS NOT NULL AND EXCLUDED.price > 0 THEN EXCLUDED.price ELSE products.price END',
    ],
    products,
    (p) => [p.sku, p.reference, p.barcode, p.erp_article_id, p.name, p.category, p.line, p.size, p.color, p.price, 0, p.stock, true]
  );

  const extraPriceUpdates = await applyReferencePricesToExistingProducts(priceMaps);
  return { productsCount: products.length, refPricesCount: priceMaps.exactMap.size, extraPriceUpdates };
}

export async function runErpSync() {
  try {
    const priceRes = await syncErpReferencePrices();
    console.log(`ERP sync (ref-precio): ${priceRes.refPricesCount} referencias leídas, ${priceRes.updatedCount} productos actualizados con precio`);
  } catch (err) {
    console.error('ERP ref-precio sync failed', err);
  }
  try {
    const res = await syncErpInventory();
    console.log(`ERP sync (inventario): ${res.productsCount} productos actualizados (${res.extraPriceUpdates} precios adicionales sincronizados)`);
  } catch (err) {
    console.error('ERP inventory sync failed', err);
  }
  try {
    const n = await syncErpCustomers();
    console.log(`ERP sync (clientes): ${n} clientes actualizados`);
  } catch (err) {
    console.error('ERP customers sync failed', err);
  }
}

