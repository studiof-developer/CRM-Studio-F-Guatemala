const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

export function broadcast(payload) {
  const data = `data: ${payload}\n\n`;
  for (const res of clients) res.write(data);
}
