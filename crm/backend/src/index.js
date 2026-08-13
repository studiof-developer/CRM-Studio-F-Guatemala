import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import ticketsRouter from './routes/tickets.js';
import conversationsRouter from './routes/conversations.js';
import customersRouter from './routes/customers.js';
import usersRouter from './routes/users.js';
import productsRouter from './routes/products.js';
import dashboardRouter from './routes/dashboard.js';
import auditRouter from './routes/audit.js';
import authRouter from './routes/auth.js';
import attachmentsRouter, { inboundRouter } from './routes/attachments.js';
import { requireAuth, requireRole } from './auth.js';
import { addClient, removeClient } from './events.js';
import { startListener } from './listener.js';

const app = express();
// Behind Dokploy's Traefik in production — without this, req.ip is the proxy's
// address for every request, which would make the login rate limiter apply
// globally instead of per-client.
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/tickets', requireAuth, ticketsRouter);
app.use('/api/conversations', requireAuth, conversationsRouter);
app.use('/api/customers', requireAuth, customersRouter);
app.use('/api/users', requireAuth, requireRole('admin'), usersRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/audit', requireAuth, requireRole('admin', 'supervisor'), auditRouter);
app.use('/api/attachments', requireAuth, attachmentsRouter);
// No requireAuth: n8n calls this directly (no advisor session), protected by its own
// shared-secret header check inside the router instead.
app.use('/api/whatsapp-inbound', inboundRouter);

app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  addClient(res);
  req.on('close', () => removeClient(res));
});

startListener();

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`CRM backend listening on ${port}`));
