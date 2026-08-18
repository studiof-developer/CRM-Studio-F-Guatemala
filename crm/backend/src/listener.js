import pg from 'pg';
import { broadcast } from './events.js';

export function startListener() {
  const client = new pg.Client();
  client.on('error', (err) => console.error('listener error', err));
  client.on('notification', (msg) => broadcast(msg.channel, msg.payload));

  // A single client processes one query at a time — firing these concurrently via
  // Promise.all made pg warn about overlapping queries on the same connection.
  client.connect()
    .then(() => client.query('LISTEN ticket_changes'))
    .then(() => client.query('LISTEN message_changes'))
    .then(() => client.query('LISTEN read_changes'))
    .catch((err) => console.error('listener connect failed', err));

  return client;
}
