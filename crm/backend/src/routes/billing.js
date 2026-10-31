import { Router } from 'express';
import { requireRole } from '../auth.js';
import { getBillingStatus, saveBilling } from '../metaBilling.js';

const router = Router();

// Estado de la facturación de la API de WhatsApp, por línea. Solo la ve el administrador; el resto de los roles recibe "ok".
router.get('/meta', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.json({ level: 'ok', lines: [] });
    res.json(await getBillingStatus({ fresh: req.query.fresh === '1' }));
  } catch (err) { next(err); }
});

// body: { lineId?, owed?, threshold?, warnAt?, criticalAt? } — owed = el "Saldo actual" que muestra Meta para esa línea (0 al pagar).
router.put('/meta', requireRole('admin'), async (req, res, next) => {
  try { res.json(await saveBilling(req.body ?? {}, req.user.id)); } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
});

export default router;
