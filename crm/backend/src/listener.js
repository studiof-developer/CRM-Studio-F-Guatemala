import pg from 'pg';
import { broadcast } from './events.js';

export function startListener() {
  const client = new pg.Client();
  client.on('error', (err) => console.error('listener error', err));
  client.on('notification', (msg) => broadcast(msg.channel, msg.payload));

  client.connect()
    .then(() => Promise.all([
      client.query('LISTEN ticket_changes'),
      client.query('LISTEN message_changes'),
    ]))
    .catch((err) => console.error('listener connect failed', err));

  return client;
}
