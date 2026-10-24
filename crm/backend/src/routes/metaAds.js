import { Router } from 'express';
import { fetchReport, fetchAdCreative, validRange } from '../metaAdsReport.js';

// Informe de anuncios de Meta: lo ve todo usuario con sesión (asesoras incluidas). Solo lectura.
const router = Router();

// El detalle del error de Meta (token vencido, sin permiso…) es para quien administra; el resto solo recibe el aviso general.
function metaError(err, req, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (/Meta|token|permission|OAuth/i.test(err.message)) {
    return res.status(502).json({ error: req.user.role === 'asesor' ? 'No se pudo consultar a Meta en este momento. Avisa a un administrador.' : err.message });
  }
  next(err);
}

// GET /api/meta-ads/report?since=YYYY-MM-DD&until=YYYY-MM-DD&level=campaign|adset|ad
router.get('/report', async (req, res, next) => {
  try {
    const { since, until, level = 'campaign' } = req.query;
    if (!validRange(since, until)) return res.status(400).json({ error: 'Indica un rango de fechas válido' });
    res.json(await fetchReport({ since, until, level }));
  } catch (err) { metaError(err, req, res, next); }
});

// GET /api/meta-ads/creative/:adId — imagen y video del anuncio, en vivo desde Meta
router.get('/creative/:adId', async (req, res, next) => {
  try {
    res.json(await fetchAdCreative(req.params.adId));
  } catch (err) { metaError(err, req, res, next); }
});

export default router;
