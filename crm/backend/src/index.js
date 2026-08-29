import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import ticketsRouter from './routes/tickets.js';
import conversationsRouter, { recoverOrphanedSends } from './routes/conversations.js';
import customersRouter from './routes/customers.js';
import usersRouter from './routes/users.js';
import productsRouter from './routes/products.js';
import dashboardRouter from './routes/dashboard.js';
import auditRouter from './routes/audit.js';
import { runErpSync } from './erpSync.js';
import authRouter from './routes/auth.js';
import attachmentsRouter, { inboundRouter } from './routes/attachments.js';
import quickRepliesRouter from './routes/quickReplies.js';
import whatsappNumbersRouter from './routes/whatsappNumbers.js';
import campaignsRouter from './routes/campaigns.js';
import agentTestRouter from './routes/agentTest.js';
import agentToolsRouter from './routes/agentTools.js';
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
app.use('/api/quick-replies', requireAuth, quickRepliesRouter);
app.use('/api/whatsapp-numbers', requireAuth, requireRole('admin'), whatsappNumbersRouter);
// A broadcast reaches hundreds of customers at once and costs real money per message —
// restricted the same way WhatsApp number configuration is, not opened to every asesor.
app.use('/api/campaigns', requireAuth, requireRole('admin', 'supervisor'), campaignsRouter);
// Admin only — a sandbox to talk to the AI agent before it ever reaches a real customer.
app.use('/api/agent-test', requireAuth, requireRole('admin'), agentTestRouter);
// No requireAuth: n8n calls this directly (no advisor session), protected by its own
// shared-secret header check inside the router instead.
app.use('/api/whatsapp-inbound', inboundRouter);
// Called by the n8n AI Agent as tools (inventory/customer lookup) — server-to-server,
// not a logged-in CRM session, same as whatsapp-inbound above.
app.use('/api/agent-tools', agentToolsRouter);

app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Nginx-style reverse proxies (Traefik/Dokploy included, depending on config) can
    // buffer responses by default, which would hold every event until the buffer fills
    // instead of streaming it — this asks them not to. Harmless if the proxy ignores it.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  addClient(res);

  // A silent connection looks identical to a dead one to both sides — proxies and load
  // balancers commonly time out and drop idle connections after 30-60s with no bytes
  // sent, without either end finding out until the next real event tries to use it.
  // A comment line every 20s keeps bytes flowing (a browser EventSource ignores lines
  // starting with ":") so the connection either stays alive or fails fast and reconnects.
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(res);
  });
});

startListener();

// A deploy landing mid-send used to strand that message forever. The startup pass
// catches whatever the restart just orphaned; the interval catches sends that hung
// rather than crashed. Delayed so the pool and the listener settle first.
// ponytail: fine on one instance — two would both sweep and could double-send the
// same row. Needs a SELECT ... FOR UPDATE SKIP LOCKED claim before scaling out.
setTimeout(() => {
  recoverOrphanedSends().catch((err) => console.error('recoverOrphanedSends failed', err));
  setInterval(() => {
    recoverOrphanedSends().catch((err) => console.error('recoverOrphanedSends failed', err));
  }, 5 * 60 * 1000);
}, 15000);

// Read-only: pulls the ERP's customer summary and inventory into our own tables so the
// CRM (and eventually the bot) never has to hit their server live per request — see
// erpSync.js. Off entirely if the credentials aren't configured (local dev, or before
// they're set in production), same graceful-degradation pattern as WhatsApp's env-var
// fallback. 20 minutes, inside the 15-30 min window agreed on.
if (process.env.ERP_API_KEY) {
  const ERP_SYNC_INTERVAL_MS = 20 * 60 * 1000;
  setTimeout(() => {
    runErpSync();
    setInterval(runErpSync, ERP_SYNC_INTERVAL_MS);
  }, 15000);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`CRM backend listening on ${port}`));
