import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { pool } from '../db.js';
import { requireRole } from '../auth.js';
import { PRODUCT_IMAGES_DIR, listImageFiles, findBestImageMatch, syncProductImages } from '../productImageSync.js';
import { isErpConfigured, fetchErpPathSafe } from '../erpClient.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const REQUIRED_COLUMNS = ['sku', 'name', 'category', 'price'];

router.get('/', async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (q) {
      const { rows } = await pool.query(
        `SELECT id, sku, reference, barcode, erp_article_id, name, category, line, size, color, price, discount_pct, stock_quantity, active, image_url
         FROM products
         WHERE sku ILIKE $1 OR reference ILIKE $1 OR barcode ILIKE $1 OR name ILIKE $1 OR color ILIKE $1
         ORDER BY id DESC
         LIMIT 50`,
        [`%${q}%`]
      );

      // Si algún producto no tiene foto vinculada aún, busca coincidencia en tiempo real
      for (const row of rows) {
        if (!row.image_url) {
          const matched = await findBestImageMatch(row);
          if (matched) {
            row.image_url = matched.url;
            pool.query('UPDATE products SET image_url = $1 WHERE id = $2', [matched.url, row.id]).catch(() => {});
          }
        }
      }

      return res.json(rows);
    }

    const { rows } = await pool.query(
      `SELECT id, sku, reference, barcode, erp_article_id, name, category, line, size, color, price, discount_pct, stock_quantity, active, image_url
       FROM products ORDER BY id DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Endpoint de diagnóstico e inspección del ERP para administradores/supervisores
router.get('/erp-inspect', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    if (!isErpConfigured()) {
      return res.json({
        configured: false,
        message: 'Las credenciales del ERP (ERP_API_KEY / ERP_CERT_FINGERPRINT) no están configuradas en este entorno.',
      });
    }

    // 1. Si se solicita sondear múltiples endpoints candidatos
    if (req.query.probe === 'endpoints' || req.query.testEndpoints === 'true') {
      const candidates = [
        '/api/data/existencia',
        '/api/data/cliente-resumen-crm',
        '/api/data/articulos',
        '/api/data/articulo',
        '/api/data/productos',
        '/api/data/producto',
        '/api/data/precios',
        '/api/data/precio',
        '/api/data/lista-precios',
        '/api/data/listas-precios',
        '/api/data/catalogo',
        '/api/data/referencias',
        '/api/data/estilos',
        '/api/data',
        '/api',
      ];

      const probeResults = [];
      for (const p of candidates) {
        const probeRes = await fetchErpPathSafe(p);
        if (probeRes.ok) {
          const raw = probeRes.data;
          const rows = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : null);
          const sample = rows ? rows[0] : raw;
          probeResults.push({
            path: p,
            ok: true,
            hasData: Boolean(rows ? rows.length : sample),
            rowCount: rows ? rows.length : (sample ? 1 : 0),
            columns: sample && typeof sample === 'object' ? Object.keys(sample) : [],
            sample: sample ? [sample] : [],
          });
        } else {
          probeResults.push({
            path: p,
            ok: false,
            error: probeRes.error,
          });
        }
      }

      return res.json({
        configured: true,
        probedAt: new Date().toISOString(),
        results: probeResults,
      });
    }

    // 2. Consulta y análisis de un endpoint específico (por defecto /api/data/existencia)
    const targetPath = (req.query.path || '/api/data/existencia').trim();
    const erpRes = await fetchErpPathSafe(targetPath);

    if (!erpRes.ok) {
      return res.status(502).json({
        configured: true,
        ok: false,
        path: targetPath,
        error: erpRes.error,
      });
    }

    const raw = erpRes.data;
    const rows = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);

    const columnsSet = new Set();
    for (const r of rows.slice(0, 100)) {
      if (r && typeof r === 'object') {
        Object.keys(r).forEach((k) => columnsSet.add(k));
      }
    }
    const columns = Array.from(columnsSet);

    // Búsqueda de referencia o término (ej: 'S176012A' o 'S')
    const q = req.query.q?.trim().toLowerCase();
    const matches = [];
    const columnMatchCounts = {};

    if (q) {
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const matchedCols = [];
        for (const [k, v] of Object.entries(r)) {
          if (v !== null && v !== undefined && String(v).toLowerCase().includes(q)) {
            matchedCols.push(k);
            columnMatchCounts[k] = (columnMatchCounts[k] || 0) + 1;
          }
        }
        if (matchedCols.length > 0) {
          matches.push({
            matchedColumns: matchedCols,
            data: r,
          });
          if (matches.length >= 30) break;
        }
      }
    }

    // Análisis automático de columnas identificadoras y de precio
    const identifierCandidates = columns.filter((c) => /id|cod|sku|ref|estilo|articulo|producto|barras/i.test(c));
    const priceCandidates = columns.filter((c) => /precio|valor|costo|pvp|tarifa|monto/i.test(c));
    const descriptionCandidates = columns.filter((c) => /desc|nombre|detalle|prenda/i.test(c));

    // Verificación de imágenes SFTP para la búsqueda
    const imageFiles = await listImageFiles();
    let bestImage = null;
    if (q) {
      bestImage = await findBestImageMatch({ reference: q, sku: q });
    }

    res.json({
      configured: true,
      ok: true,
      path: targetPath,
      totalRows: rows.length,
      columns,
      fieldAnalysis: {
        identifierCandidates,
        priceCandidates,
        descriptionCandidates,
      },
      images: {
        totalFilesOnServer: imageFiles.length,
        match: bestImage,
        sampleFiles: imageFiles.slice(0, 8),
      },
      search: q
        ? {
            query: req.query.q,
            totalFound: matches.length,
            columnMatchCounts,
            matches,
          }
        : null,
      sampleRows: rows.slice(0, 2),
    });
  } catch (err) {
    next(err);
  }
});

// Busca la imagen más similar para una referencia/color en tiempo real
router.get('/images/lookup', async (req, res, next) => {
  try {
    const ref = (req.query.ref || req.query.q || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref or q is required' });
    const match = await findBestImageMatch({
      reference: ref,
      sku: req.query.sku,
      barcode: req.query.barcode,
      color: req.query.color,
    });
    res.json({ ref, match });
  } catch (err) {
    next(err);
  }
});

// Sincronización manual de imágenes en segundo plano
router.post('/sync-images', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    syncProductImages().catch((err) => console.error('Error in manual syncProductImages:', err));
    res.json({ ok: true, message: 'Sincronización de fotos iniciada' });
  } catch (err) {
    next(err);
  }
});

// Sincronización manual del ERP en segundo plano
router.post('/sync-erp', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { runErpSync } = await import('../erpSync.js');
    runErpSync().catch((err) => console.error('Error in manual runErpSync:', err));
    res.json({ ok: true, message: 'Sincronización de ERP iniciada' });
  } catch (err) {
    next(err);
  }
});

// Serves a file straight out of the SFTP drop-off folder (see productImageSync.js) —
// path.basename strips any directory component a crafted filename might carry, so this
// can never be walked outside PRODUCT_IMAGES_DIR regardless of what's in the URL.
router.get('/images/:filename', (req, res) => {
  const filePath = path.join(PRODUCT_IMAGES_DIR, path.basename(req.params.filename));
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
  });
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
