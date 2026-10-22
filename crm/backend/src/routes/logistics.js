import { Router } from 'express';
import multer from 'multer';
import { requireRole } from '../auth.js';
import {
  getConfig, saveConfig, userRoles, listRoleAssignments, setUserRoles, viewerScope, createSheet, updateSheet, addPayment, removePayment, submitSheet, auditPayment, advance, addNote,
  listSheets, boardCounts, getSheet, chatProofs,
} from '../logistics.js';
import { ROLES, STATUS, TRANSITIONS } from '../logisticsFlow.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 6 } });

// Cada handler devuelve el error con su código y, si la ficha está incompleta, la lista de lo que falta.
const guard = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.missing ? { missing: err.missing } : {}) });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'El archivo pesa más de 60 MB' });
    next(err);
  }
};
const json = (v, fallback = {}) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } };
const id = (req, name = 'id') => { const n = Number(req.params[name]); if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('Identificador no válido'), { status: 400 }); return n; };

router.get('/me', guard(async (req, res) => {
  const scope = await viewerScope(req.user);
  res.json({ roles: scope.roles, seesAll: scope.seesAll, isAdmin: req.user.role === 'admin', roleLabels: ROLES, statusLabels: STATUS, steps: Object.fromEntries(Object.entries(TRANSITIONS).map(([k, s]) => [k, { code: s.code, label: s.label }])) });
}));

router.get('/config', guard(async (req, res) => {
  if (!(await viewerScope(req.user)).seesAll) return res.status(403).json({ error: 'forbidden' });
  res.json(await getConfig());
}));
router.put('/config', requireRole('admin'), guard(async (req, res) => { res.json(await saveConfig(req.body, req.user)); }));

router.get('/roles', requireRole('admin'), guard(async (req, res) => { res.json({ users: await listRoleAssignments(), roleLabels: ROLES }); }));
router.put('/roles/:userId', requireRole('admin'), guard(async (req, res) => { res.json({ roles: await setUserRoles(id(req, 'userId'), req.body?.roles, req.user.id) }); }));

router.get('/board', guard(async (req, res) => { res.json(await boardCounts(req.user)); }));

router.get('/sheets', guard(async (req, res) => {
  const { scope, status, q, mode, overdue, limit } = req.query;
  res.json({ sheets: await listSheets({ user: req.user, scope, status, q, mode, overdue: overdue === '1', limit }) });
}));
router.post('/sheets', guard(async (req, res) => {
  const { customerId, quoteId, data, items } = req.body ?? {};
  const cid = Number(customerId);
  if (!Number.isInteger(cid) || cid < 1) return res.status(400).json({ error: 'Indica el cliente' });
  res.status(201).json(await createSheet({ customerId: cid, quoteId: quoteId ? Number(quoteId) : null, data: data ?? {}, items: items ?? null, user: req.user }));
}));
router.get('/sheets/:id', guard(async (req, res) => { res.json(await getSheet(id(req), req.user)); }));
router.patch('/sheets/:id', guard(async (req, res) => { res.json(await updateSheet(id(req), { data: req.body?.data ?? {}, items: req.body?.items }, req.user)); }));
router.post('/sheets/:id/submit', guard(async (req, res) => { res.json(await submitSheet(id(req), req.user)); }));

router.post('/sheets/:id/payments', upload.single('proof'), guard(async (req, res) => {
  res.status(201).json(await addPayment(id(req), json(req.body.payment ?? req.body), req.file, req.user));
}));
router.delete('/sheets/:id/payments/:pid', guard(async (req, res) => { await removePayment(id(req), id(req, 'pid'), req.user); res.json({ ok: true }); }));
router.post('/sheets/:id/payments/:pid/audit', upload.single('evidence'), guard(async (req, res) => {
  res.json(await auditPayment(id(req), id(req, 'pid'), json(req.body.audit ?? req.body), req.file, req.user));
}));

router.post('/sheets/:id/steps/:key', upload.array('evidence', 6), guard(async (req, res) => {
  res.json(await advance(id(req), req.params.key, { data: json(req.body.data), note: req.body.note }, req.files, req.user));
}));
router.post('/sheets/:id/notes', guard(async (req, res) => { await addNote(id(req), req.body?.note, req.user); res.status(201).json({ ok: true }); }));

router.get('/customers/:customerId/chat-proofs', guard(async (req, res) => { res.json({ proofs: await chatProofs(id(req, 'customerId')) }); }));

export default router;
