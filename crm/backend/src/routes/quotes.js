import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Genera un correlativo único tipo COT-2026-0001 basado en el máximo actual (no en count(*))
async function generateQuoteNumber(dbClient = pool, offset = 0) {
  const year = new Date().getFullYear();
  const prefix = `COT-${year}-`;
  const { rows } = await dbClient.query(
    `SELECT COALESCE(MAX(
       CASE WHEN substring(quote_number FROM 10) ~ '^[0-9]+$'
            THEN substring(quote_number FROM 10)::int
            ELSE 0
       END
     ), 0) AS max_seq
     FROM quotes
     WHERE quote_number LIKE $1`,
    [`${prefix}%`]
  );
  const nextSeq = (rows[0]?.max_seq || 0) + 1 + offset;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

// POST /api/quotes
// Crea y guarda una cotización con sus ítems
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      customerId: rawCustomerId,
      whatsappNumber,
      whatsappNumberId: rawWhatsappNumberId,
      items,
      subtotal,
      discountTotal,
      grandTotal,
      notes,
    } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Debes agregar al menos una prenda a la cotización.' });
    }

    await client.query('BEGIN');

    // 1. Resolver customer_id de forma segura (verificando que exista en customers)
    let customerId = null;
    if (rawCustomerId && !Number.isNaN(Number(rawCustomerId))) {
      const { rows: existingCust } = await client.query(
        `SELECT id FROM customers WHERE id = $1 LIMIT 1`,
        [Number(rawCustomerId)]
      );
      customerId = existingCust[0]?.id ?? null;
    }

    const rawWa = String(whatsappNumber || '').trim();
    if (!customerId && rawWa.startsWith('social:')) {
      const socialId = Number(rawWa.replace('social:', ''));
      if (socialId && !Number.isNaN(socialId)) {
        const { rows: scRows } = await client.query(
          `SELECT c.id FROM social_contacts sc
           JOIN customers c ON c.id = sc.customer_id
           WHERE sc.id = $1 LIMIT 1`,
          [socialId]
        );
        customerId = scRows[0]?.id ?? null;
      }
    } else if (!customerId && rawWa) {
      const cleanPhone = rawWa.split('__')[0].replace(/\D/g, '');
      if (cleanPhone.length >= 7) {
        const { rows: cRows } = await client.query(
          `SELECT id FROM customers WHERE whatsapp_number = $1 LIMIT 1`,
          [cleanPhone]
        );
        customerId = cRows[0]?.id ?? null;
      }
    }

    // 2. Validar advisor_user_id y whatsapp_number_id para evitar violaciones de FK
    let advisorUserId = null;
    if (req.user?.id && !Number.isNaN(Number(req.user.id))) {
      const { rows: uRows } = await client.query(
        `SELECT id FROM users WHERE id = $1 LIMIT 1`,
        [Number(req.user.id)]
      );
      advisorUserId = uRows[0]?.id ?? null;
    }

    let whatsappNumberId = null;
    if (rawWhatsappNumberId && !Number.isNaN(Number(rawWhatsappNumberId))) {
      const { rows: wRows } = await client.query(
        `SELECT id FROM whatsapp_numbers WHERE id = $1 LIMIT 1`,
        [Number(rawWhatsappNumberId)]
      );
      whatsappNumberId = wRows[0]?.id ?? null;
    }

    let quoteNumber = await generateQuoteNumber(client, 0);

    if (!customerId) {
      // Cotización desde calculadora independiente o chat sin ficha en customers aún
      await client.query('COMMIT');
      return res.status(201).json({
        id: null,
        quoteNumber,
        grandTotal: Number(grandTotal) || 0,
        discountTotal: Number(discountTotal) || 0,
        createdAt: new Date().toISOString(),
      });
    }

    // 3. Insertar cotización con reintento automático si hubiera colisión concurrente de correlativo
    let quote = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      quoteNumber = await generateQuoteNumber(client, attempt);
      await client.query('SAVEPOINT insert_quote_sp');
      try {
        const { rows: quoteRows } = await client.query(
          `INSERT INTO quotes (
            quote_number, customer_id, advisor_user_id, whatsapp_number_id,
            subtotal, discount_total, grand_total, status, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'enviada', $8)
          RETURNING *`,
          [
            quoteNumber,
            customerId,
            advisorUserId,
            whatsappNumberId,
            Number(subtotal) || 0,
            Number(discountTotal) || 0,
            Number(grandTotal) || 0,
            notes || null,
          ]
        );
        quote = quoteRows[0];
        await client.query('RELEASE SAVEPOINT insert_quote_sp');
        break;
      } catch (insErr) {
        await client.query('ROLLBACK TO SAVEPOINT insert_quote_sp');
        if (insErr.code === '23505' && attempt < 4) {
          continue;
        }
        throw insErr;
      }
    }

    // 4. Insertar prendas validando product_id contra la tabla products
    for (const item of items) {
      const rawPid = item.productId && !Number.isNaN(Number(item.productId)) ? Number(item.productId) : null;
      await client.query(
        `INSERT INTO quote_items (
          quote_id, product_id, sku, name, size, color, quantity,
          unit_price, discount_pct, final_price
        ) VALUES (
          $1,
          (SELECT id FROM products WHERE id = $2 LIMIT 1),
          $3, $4, $5, $6, $7, $8, $9, $10
        )`,
        [
          quote.id,
          rawPid,
          String(item.sku || 'N/A').slice(0, 120),
          String(item.name || 'Prenda').slice(0, 255),
          item.size ? String(item.size).slice(0, 60) : null,
          item.color ? String(item.color).slice(0, 80) : null,
          Math.max(1, Math.round(Number(item.quantity) || 1)),
          Number(item.unitPrice) || 0,
          Math.min(100, Math.max(0, Number(item.discountPct) || 0)),
          Number(item.finalPrice) || 0,
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: quote.id,
      quoteNumber: quote.quote_number,
      grandTotal: Number(quote.grand_total),
      discountTotal: Number(quote.discount_total),
      createdAt: quote.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error creating quote:', err);
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
