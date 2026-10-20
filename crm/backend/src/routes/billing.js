import { Router } from 'express';
import { requireRole } from '../auth.js';
import { getBillingStatus, saveBilling } from '../metaBilling.js';

const router = Router();

// Estado de la facturación de la API de WhatsApp. Administradores y supervisores ven todo; el resto de los roles solo
// necesita saber si los envíos están bloqueados por pago.
router.get('/meta', async (req, res, next) => {
  try {
    const s = await getBillingStatus({ fresh: req.query.fresh === '1' });
    if (['admin', 'supervisor'].includes(req.user.role)) return res.json(s);
    res.json({ level: s.blocked ? 'blocked' : 'ok', blocked: s.blocked });
  } catch (err) { next(err); }
});

// body: { owed?, threshold?, warnAt?, criticalAt? } — owed = el "Saldo actual" que muestra Meta (0 al pagar).
router.put('/meta', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try { res.json(await saveBilling(req.body ?? {}, req.user.id)); } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
});

export default router;
