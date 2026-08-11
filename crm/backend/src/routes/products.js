import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { pool } from '../db.js';
import { requireRole } from '../auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const REQUIRED_COLUMNS = ['sku', 'name', 'category', 'price'];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, sku, name, category, line, size, color, price, discount_pct, stock_quantity, active
       FROM products ORDER BY id DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/import', requireRole('supervisor'), upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  let records;
  try {
    records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: `CSV inválido: ${err.message}` });
  }
  if (records.length === 0) return res.status(400).json({ error: 'el archivo no tiene filas' });

  const missingColumns = REQUIRED_COLUMNS.filter((c) => !(c in records[0]));
  if (missingColumns.length) {
    return res.status(400).json({ error: `faltan columnas: ${missingColumns.join(', ')}` });
  }

  const client = await pool.connect();
  let imported = 0;
  const rowErrors = [];
  try {
    await client.query('BEGIN');
    for (const [i, row] of records.entries()) {
      const sku = row.sku?.trim();
      const name = row.name?.trim();
      const category = row.category?.trim();
      const price = Number(row.price);
      if (!sku || !name || !category || Number.isNaN(price)) {
        rowErrors.push(`fila ${i + 2}: sku/name/category/price inválidos`);
        continue;
      }
      await client.query(
        `INSERT INTO products (sku, name, category, line, size, color, price, discount_pct, stock_quantity, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (sku) DO UPDATE SET
           name = EXCLUDED.name, category = EXCLUDED.category, line = EXCLUDED.line,
           size = EXCLUDED.size, color = EXCLUDED.color, price = EXCLUDED.price,
           discount_pct = EXCLUDED.discount_pct, stock_quantity = EXCLUDED.stock_quantity,
           active = EXCLUDED.active`,
        [
          sku, name, category, row.line?.trim() || null,
          row.size?.trim() || null, row.color?.trim() || null, price,
          Number(row.discount_pct) || 0, Number(row.stock_quantity) || 0,
          row.active === undefined ? true : String(row.active).toLowerCase() !== 'false',
        ]
      );
      imported++;
    }
    await client.query('COMMIT');
    res.json({ imported, totalRows: records.length, errors: rowErrors });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

export default router;
