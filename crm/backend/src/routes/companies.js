import { Router } from 'express';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.active, c.created_at, c.updated_at,
             COALESCE(
               json_agg(
                 json_build_object('id', b.id, 'name', b.name)
               ) FILTER (WHERE b.id IS NOT NULL),
               '[]'
             ) AS brands,
             COUNT(DISTINCT b.id)::int AS brand_count,
             COUNT(DISTINCT br.id)::int AS branch_count,
             COUNT(DISTINCT wn.id)::int AS line_count
      FROM companies c
      LEFT JOIN brands b ON b.company_id = c.id
      LEFT JOIN branches br ON br.brand_id = b.id
      LEFT JOIN whatsapp_numbers wn ON wn.branch_id = br.id
      GROUP BY c.id
      ORDER BY c.name ASC
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, active } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const { rows } = await pool.query(
      'INSERT INTO companies (name, active) VALUES ($1, $2) RETURNING *',
      [name.trim(), active !== false]
    );
    logAccess(req.user, null, 'company_created');
    res.status(201).json({
      ...rows[0],
      brands: [],
      brand_count: 0,
      branch_count: 0,
      line_count: 0,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Esa empresa ya existe' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { name, active } = req.body ?? {};
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
      params.push(name.trim());
      updates.push(`name = $${params.length}`);
    }

    if (active !== undefined) {
      params.push(Boolean(active));
      updates.push(`active = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'No se enviaron campos para actualizar' });

    updates.push('updated_at = now()');
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE companies SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
    logAccess(req.user, null, 'company_updated');
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Esa empresa ya existe' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
    logAccess(req.user, null, 'company_deleted');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Asignación exclusiva de marcas a una empresa
router.put('/:id/brands', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const companyId = Number(req.params.id);
    const { brandIds } = req.body ?? {};
    if (!Array.isArray(brandIds)) {
      return res.status(400).json({ error: 'brandIds debe ser un array' });
    }

    const { rows: companyRows } = await client.query('SELECT id, name FROM companies WHERE id = $1', [companyId]);
    if (!companyRows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
    const company = companyRows[0];

    const cleanBrandIds = brandIds.map(Number).filter(id => !isNaN(id) && id > 0);

    // Validar exclusividad: ninguna marca seleccionada debe pertenecer a OTRA empresa
    if (cleanBrandIds.length > 0) {
      const { rows: conflictingBrands } = await client.query(`
        SELECT b.id, b.name, b.company_id, c.name AS company_name
        FROM brands b
        LEFT JOIN companies c ON b.company_id = c.id
        WHERE b.id = ANY($1) AND b.company_id IS NOT NULL AND b.company_id != $2
      `, [cleanBrandIds, companyId]);

      if (conflictingBrands.length > 0) {
        const conflict = conflictingBrands[0];
        return res.status(409).json({
          error: `La marca "${conflict.name}" ya es propiedad de "${conflict.company_name}". Debes liberarla primero.`
        });
      }
    }

    await client.query('BEGIN');

    // Desvincular marcas que pertenecían a esta empresa pero ya no están en brandIds
    if (cleanBrandIds.length > 0) {
      await client.query(`
        UPDATE brands 
        SET company_id = NULL, updated_at = now() 
        WHERE company_id = $1 AND NOT (id = ANY($2))
      `, [companyId, cleanBrandIds]);

      // Vincular las marcas seleccionadas a esta empresa
      await client.query(`
        UPDATE brands 
        SET company_id = $1, updated_at = now() 
        WHERE id = ANY($2)
      `, [companyId, cleanBrandIds]);
    } else {
      // Si el array viene vacío, desvincular todas las marcas de esta empresa
      await client.query(`
        UPDATE brands 
        SET company_id = NULL, updated_at = now() 
        WHERE company_id = $1
      `, [companyId]);
    }

    await client.query('COMMIT');
    logAccess(req.user, null, 'company_brands_updated');
    res.json({ ok: true, companyId, brandIds: cleanBrandIds });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

export default router;
