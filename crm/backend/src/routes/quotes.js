import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Genera un correlativo único tipo COT-2026-0001
async function generateQuoteNumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM quotes WHERE quote_number LIKE $1`,
    [`COT-${year}-%`]
  );
  const nextSeq = (rows[0]?.count || 0) + 1;
  return `COT-${year}-${String(nextSeq).padStart(4, '0')}`;
}

// POST /api/quotes
// Crea y guarda una cotización con sus ítems
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      customerId,
      whatsappNumberId,
      items,
      subtotal,
      discountTotal,
      grandTotal,
      notes,
    } = req.body ?? {};

    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array cannot be empty' });
    }

    await client.query('BEGIN');

    const quoteNumber = await generateQuoteNumber();

    const { rows: quoteRows } = await client.query(
      `INSERT INTO quotes (
        quote_number, customer_id, advisor_user_id, whatsapp_number_id,
        subtotal, discount_total, grand_total, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'enviada', $8)
      RETURNING *`,
      [
        quoteNumber,
        customerId,
        req.user?.id || null,
        whatsappNumberId || null,
        Number(subtotal) || 0,
        Number(discountTotal) || 0,
        Number(grandTotal) || 0,
        notes || null,
      ]
    );

    const quote = quoteRows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO quote_items (
          quote_id, product_id, sku, name, size, color, quantity,
          unit_price, discount_pct, final_price
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          quote.id,
          item.productId || null,
          item.sku || 'N/A',
          item.name || 'Prenda',
          item.size || null,
          item.color || null,
          Math.max(1, Number(item.quantity) || 1),
          Number(item.unitPrice) || 0,
          Number(item.discountPct) || 0,
          Number(item.finalPrice) || 0,
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: quote.id,
      quoteNumber: quote.quote_number,
      grandTotal: quote.grand_total,
      discountTotal: quote.discount_total,
      createdAt: quote.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/quotes/customer/:customerId
// Retorna las cotizaciones previas del cliente
router.get('/customer/:customerId', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.*, 
              u.full_name AS advisor_name,
              json_agg(qi.*) AS items
       FROM quotes q
       LEFT JOIN users u ON u.id = q.advisor_user_id
       LEFT JOIN quote_items qi ON qi.quote_id = q.id
       WHERE q.customer_id = $1
       GROUP BY q.id, u.full_name
       ORDER BY q.created_at DESC
       LIMIT 50`,
      [req.params.customerId]
    );

    res.json(rows.map((r) => ({
      id: r.id,
      quoteNumber: r.quote_number,
      customerId: r.customer_id,
      advisorName: r.advisor_name,
      subtotal: Number(r.subtotal),
      discountTotal: Number(r.discount_total),
      grandTotal: Number(r.grand_total),
      status: r.status,
      notes: r.notes,
      createdAt: r.created_at,
      items: (r.items || []).filter(Boolean),
    })));
  } catch (err) {
    next(err);
  }
});

export default router;
