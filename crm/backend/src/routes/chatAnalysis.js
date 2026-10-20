import { Router } from 'express';
import { analyzeWindow, chatDetail } from '../chatAnalysis.js';

const router = Router();
const MAX_RANGE_MS = 7 * 86400000;

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const gtDay = (offsetDays) => new Date(Date.now() - 6 * 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
function parseWindow(q) {
  const date = (v, fallback) => { const d = new Date(v || fallback); if (Number.isNaN(+d)) throw bad('Fecha inválida'); return d; };
  const from = date(q.from, `${gtDay(1)}T21:00:00-06:00`);
  const to = date(q.to, new Date());
  if (to <= from) throw bad('La fecha final debe ser posterior a la inicial');
  if (to - from > MAX_RANGE_MS) throw bad('El período máximo es de 7 días');
  return { from, to };
}

// Análisis de chats (admin y supervisor). GET /?from&to → lista liviana clasificada; GET /:phone?from&to → ficha y conversación.
router.get('/', async (req, res, next) => {
  try {
    const { from, to } = parseWindow(req.query);
    // para "atendidos ayer, retomaron hoy" hace falta el día anterior al final del período, completo
    const dayBefore = new Date(`${new Date(+to - 6 * 3600000 - 86400000).toISOString().slice(0, 10)}T00:00:00-06:00`);
    res.json(await analyzeWindow({ from, to, ctxFrom: dayBefore }));
  } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
});

router.get('/:phone', async (req, res, next) => {
  try {
    if (!/^[0-9a-z:_.+-]{3,64}$/i.test(req.params.phone)) throw bad('Número inválido');
    const { from, to } = parseWindow(req.query);
    const detail = await chatDetail({ phone: req.params.phone, from, to });
    detail ? res.json(detail) : res.status(404).json({ error: 'Chat no encontrado' });
  } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
});

export default router;
