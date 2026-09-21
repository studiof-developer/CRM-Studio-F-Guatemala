import { Router } from 'express';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows: brands } = await pool.query(`
      SELECT b.*, c.name AS company_name 
      FROM brands b 
      LEFT JOIN companies c ON b.company_id = c.id 
      ORDER BY b.name ASC
    `);
    const { rows: branches } = await pool.query('SELECT * FROM branches ORDER BY name ASC');
    
    const brandsWithBranches = brands.map(brand => ({
        ...brand,
        branches: branches.filter(b => b.brand_id === brand.id)
    }));

    res.json(brandsWithBranches);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, companyId, company_id } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const rawCid = companyId !== undefined ? companyId : company_id;
    const targetCompanyId = (rawCid && !isNaN(Number(rawCid))) ? Number(rawCid) : null;
    const { rows } = await pool.query(
      'INSERT INTO brands (name, company_id) VALUES ($1, $2) RETURNING *',
      [name.trim(), targetCompanyId]
    );
    let companyName = null;
    if (targetCompanyId) {
      const comp = await pool.query('SELECT name FROM companies WHERE id = $1', [targetCompanyId]);
      companyName = comp.rows[0]?.name ?? null;
    }
    logAccess(req.user, null, 'brand_created');
    res.status(201).json({ ...rows[0], company_name: companyName, branches: [] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Esa marca ya existe' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { name, companyId, company_id } = req.body ?? {};
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
      params.push(name.trim());
      updates.push(`name = $${params.length}`);
    }

    if (companyId !== undefined || company_id !== undefined) {
      const rawCid = companyId !== undefined ? companyId : company_id;
      const cleanCid = (rawCid && !isNaN(Number(rawCid))) ? Number(rawCid) : null;
      params.push(cleanCid);
      updates.push(`company_id = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'No se enviaron campos para actualizar' });

    updates.push('updated_at = now()');
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE brands SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Marca no encontrada' });

    let companyName = null;
    if (rows[0].company_id) {
      const comp = await pool.query('SELECT name FROM companies WHERE id = $1', [rows[0].company_id]);
      companyName = comp.rows[0]?.name ?? null;
    }

    logAccess(req.user, null, 'brand_updated');
    res.json({ ...rows[0], company_name: companyName });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Esa marca ya existe' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM brands WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Marca no encontrada' });
    logAccess(req.user, null, 'brand_deleted');
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'No se puede eliminar la marca porque tiene sucursales o números asociados' });
    next(err);
  }
});

router.post('/:brandId/branches', async (req, res, next) => {
  try {
    const { name } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre de la sucursal es obligatorio' });
    const brandId = Number(req.params.brandId);
    if (!brandId || isNaN(brandId)) return res.status(400).json({ error: 'ID de marca inválido' });
    const { rows } = await pool.query(
      'INSERT INTO branches (brand_id, name) VALUES ($1, $2) RETURNING *',
      [brandId, name.trim()]
    );
    logAccess(req.user, null, 'branch_created');
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una sucursal con ese nombre en esta marca' });
    next(err);
  }
});

router.patch('/:brandId/branches/:id', async (req, res, next) => {
  try {
    const { name } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre de la sucursal no puede estar vacío' });
    const { rows } = await pool.query(
      'UPDATE branches SET name = $1 WHERE id = $2 AND brand_id = $3 RETURNING *',
      [name.trim(), req.params.id, req.params.brandId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    logAccess(req.user, null, 'branch_updated');
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una sucursal con ese nombre en esta marca' });
    next(err);
  }
});

router.delete('/:brandId/branches/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM branches WHERE id = $1 AND brand_id = $2 RETURNING id', [req.params.id, req.params.brandId]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    logAccess(req.user, null, 'branch_deleted');
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'No se puede eliminar la sucursal porque tiene numeros asociados' });
    next(err);
  }
});

export default router;
