import pg from 'pg';
import { broadcast } from './events.js';
import { flushQueuedMessages } from './routes/conversations.js';

export function startListener() {
  const client = new pg.Client();
  client.on('error', (err) => console.error('listener error', err));
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
    .then(() => client.query('LISTEN ticket_changes'))
    .then(() => client.query('LISTEN message_changes'))
    .then(() => client.query('LISTEN read_changes'))
    .catch((err) => console.error('listener connect failed', err));

  return client;
}
