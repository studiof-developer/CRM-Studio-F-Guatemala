const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

// Named SSE event (the Postgres NOTIFY channel) so each page can subscribe to only
// the kind of change it cares about, instead of every client re-fetching on anything.
export function broadcast(channel, payload) {
  const data = `event: ${channel}\ndata: ${payload}\n\n`;
  for (const res of clients) res.write(data);
}
