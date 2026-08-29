import { Router } from 'express';
import { pool } from '../db.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';

const router = Router();

function requireAgentSecret(req, res, next) {
  // Without this check, an unset AGENT_TOOLS_SECRET (undefined) would match a request
  // with no header at all (also undefined) — a misconfiguration silently becoming no
  // protection at all, instead of a loud, obvious failure.
  if (!process.env.AGENT_TOOLS_SECRET) {
    return res.status(503).json({ error: 'AGENT_TOOLS_SECRET no está configurado' });
  }
  if (req.headers['x-agent-secret'] !== process.env.AGENT_TOOLS_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
router.use(requireAgentSecret);

// Called by the n8n AI Agent as a tool — free-text search over the catalog synced from
// the ERP (name/line/category/color/size), so "¿hay blusas talla M en rojo?" resolves
// against real stock instead of the model guessing. Only active, in-stock items by
// default — a customer doesn't care about a discontinued or sold-out reference.
router.get('/inventory', async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const { rows } = await pool.query(
      `SELECT sku, name, category, line, size, color, price, discount_pct, stock_quantity
       FROM products
       WHERE active
         AND stock_quantity > 0
         AND (name ILIKE $1 OR category ILIKE $1 OR line ILIKE $1 OR color ILIKE $1 OR size ILIKE $1)
       ORDER BY stock_quantity DESC
       LIMIT 15`,
      [`%${q}%`]
    );
    res.json(rows.map((r) => ({
      sku: r.sku,
      nombre: r.name,
      categoria: r.category,
      linea: r.line,
      talla: r.size,
      color: r.color,
      precio: r.price,
      descuentoPct: r.discount_pct,
      stock: r.stock_quantity,
    })));
  } catch (err) { next(err); }
});

// Called by the n8n AI Agent as a tool — the same enrichment shown in the CRM's own
// Conversations/Clientes panels, so the agent knows if it's talking to a Q40,000
// lifetime customer or someone who's never bought anything, and can shape tone/urgency
// accordingly (see the conversations.js/customers.js findCustomerByPhone queries this
// mirrors). No match just means a brand-new lead — not an error.
router.get('/customer', async (req, res, next) => {
  try {
    const phone = req.query.phone?.trim();
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const { rows } = await pool.query(
      `SELECT c.full_name, c.preferred_line, c.preferred_size, ${EFFECTIVE_STATUS_SQL} AS temperature,
              e.nombre AS erp_nombre, e.venta_neta_total, e.facturas_totales, e.unidades_totales,
              e.fecha_ultima_compra, e.dias_sin_compra, e.segmento_sin_compra, e.sucursal_preferida,
              e.blusas, e.jeans, e.vestidos, e.pantalones, e.otros,
              e.talla_blusa, e.talla_jean, e.talla_calzado
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT * FROM erp_customers WHERE right($1::text, 8) IN (telefono, celular)
         ORDER BY venta_neta_total DESC NULLS LAST LIMIT 1
       ) e ON true
       WHERE c.whatsapp_number = $1`,
      [phone]
    );
    // No customers row at all (a phone that's never messaged before, e.g. testing a
    // number that only exists as a real ERP purchase) still needs the erp_customers
    // side — the query above can only find it via a customers row to join FROM.
    let r = rows[0];
    if (!r) {
      const erp = await pool.query(
        `SELECT * FROM erp_customers WHERE right($1::text, 8) IN (telefono, celular)
         ORDER BY venta_neta_total DESC NULLS LAST LIMIT 1`,
        [phone]
      );
      r = erp.rows[0] ? {
        full_name: null, preferred_line: null, preferred_size: null, temperature: null,
        erp_nombre: erp.rows[0].nombre, venta_neta_total: erp.rows[0].venta_neta_total,
        facturas_totales: erp.rows[0].facturas_totales, unidades_totales: erp.rows[0].unidades_totales,
        fecha_ultima_compra: erp.rows[0].fecha_ultima_compra, dias_sin_compra: erp.rows[0].dias_sin_compra,
        segmento_sin_compra: erp.rows[0].segmento_sin_compra, sucursal_preferida: erp.rows[0].sucursal_preferida,
        blusas: erp.rows[0].blusas, jeans: erp.rows[0].jeans, vestidos: erp.rows[0].vestidos,
        pantalones: erp.rows[0].pantalones, otros: erp.rows[0].otros,
        talla_blusa: erp.rows[0].talla_blusa, talla_jean: erp.rows[0].talla_jean, talla_calzado: erp.rows[0].talla_calzado,
      } : null;
    }

    if (!r) return res.json({ esClienteNuevo: true });
    res.json({
      esClienteNuevo: false,
      nombreCRM: r.full_name,
      lineaPreferidaCRM: r.preferred_line,
      tallaPreferidaCRM: r.preferred_size,
      temperatura: r.temperature,
      tieneHistorialERP: r.erp_nombre != null,
      nombreERP: r.erp_nombre,
      ventaTotalHistorica: r.venta_neta_total,
      facturasTotales: r.facturas_totales,
      unidadesTotales: r.unidades_totales,
      ultimaCompra: r.fecha_ultima_compra,
      diasSinComprar: r.dias_sin_compra,
      segmento: r.segmento_sin_compra,
      sucursalPreferida: r.sucursal_preferida,
      interesPorLinea: { blusas: r.blusas, jeans: r.jeans, vestidos: r.vestidos, pantalones: r.pantalones, otros: r.otros },
      tallas: { blusa: r.talla_blusa, jean: r.talla_jean, calzado: r.talla_calzado },
    });
  } catch (err) { next(err); }
});

export default router;
