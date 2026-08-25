import pg from 'pg';
import { broadcast } from './events.js';
import { flushQueuedMessages } from './routes/conversations.js';

const RECONNECT_DELAY_MS = 5000;

export function startListener() {
  const client = new pg.Client();
  client.on('error', (err) => console.error('listener error', err));
  // Postgres closing the connection for any reason (idle_session_timeout, a restart, a
  // network blip) emits 'end' — without reconnecting here, the whole live-update system
  // (dashboard/list refresh, and releasing anything queued behind the 24h window on a
  // customer reply) goes quiet forever until the next deploy restarts the process.
  client.on('end', () => {
    console.error('listener connection ended, reconnecting in 5s');
    setTimeout(startListener, RECONNECT_DELAY_MS);
  });
  client.on('notification', (msg) => {
    broadcast(msg.channel, msg.payload);
    // n8n writes inbound customer messages straight into the table, so this trigger is
    // the only place the backend finds out one arrived — and a customer reply is exactly
    // what reopens WhatsApp's 24h window and releases anything the advisor had queued.
    if (msg.channel !== 'message_changes') return;
    let sessionId = null;
    try {
      sessionId = JSON.parse(msg.payload)?.session_id ?? null;
    } catch {
      return;
    }
    flushQueuedMessages(sessionId).catch((err) => console.error('flushQueuedMessages failed', err));
  });

  // A single client processes one query at a time — firing these concurrently via
  // Promise.all made pg warn about overlapping queries on the same connection.
  client.connect()
    // This connection is meant to sit idle for hours between notifications, unlike
    // every other (pooled, short-lived) session — exempt it from the database's
    // idle_session_timeout instead of getting killed for doing its job correctly.
    .then(() => client.query('SET idle_session_timeout = 0'))
    .then(() => client.query('LISTEN ticket_changes'))
    .then(() => client.query('LISTEN message_changes'))
    .then(() => client.query('LISTEN read_changes'))
    .catch((err) => {
      console.error('listener connect failed', err);
      setTimeout(startListener, RECONNECT_DELAY_MS);
    });

  return client;
}
