export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...options });
  return res;
}

export async function login(username, password) {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('Usuario o contraseña incorrectos');
  return res.json();
}

export async function logout() {
  await apiFetch('/api/auth/logout', { method: 'POST' });
}

export async function fetchMe() {
  const res = await apiFetch('/api/auth/me');
  if (!res.ok) return null;
  return res.json();
}

export async function fetchTickets(status = 'esperando_asesor') {
  const res = await apiFetch(`/api/tickets?status=${status}`);
  if (!res.ok) throw new Error('Error al cargar tickets');
  return res.json();
}

export async function fetchTicket(id) {
  const res = await apiFetch(`/api/tickets/${id}`);
  if (!res.ok) throw new Error('Error al cargar el ticket');
  return res.json();
}

export async function updateTicket(id, patch) {
  const res = await apiFetch(`/api/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Error al actualizar el ticket');
  return res.json();
}

export async function fetchConversations(q, temperature) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (temperature) params.set('temperature', temperature);
  const qs = params.toString();
  const res = await apiFetch(`/api/conversations${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Error al cargar conversaciones');
  return res.json();
}

export async function fetchConversation(sessionId) {
  const res = await apiFetch(`/api/conversations/${sessionId}`);
  if (!res.ok) throw new Error('Error al cargar la conversación');
  return res.json();
}

export async function startConversation({ phone, fullName, address }) {
  const res = await apiFetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, fullName, address }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al iniciar la conversación');
  return res.json();
}

export async function sendConversationMessage(sessionId, content, replyTo) {
  const res = await apiFetch(`/api/conversations/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, replyTo }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al enviar el mensaje');
  return res.json();
}

export async function sendConversationAttachment(sessionId, file, caption) {
  const formData = new FormData();
  formData.append('file', file);
  if (caption) formData.append('caption', caption);
  const res = await apiFetch(`/api/conversations/${sessionId}/attachments`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al enviar el archivo');
  return res.json();
}

export function attachmentUrl(id) {
  return `${API_BASE}/api/attachments/${id}/file`;
}

export function attachmentDownloadUrl(id) {
  return `${attachmentUrl(id)}?download=1`;
}

export async function fetchCustomerCounts() {
  const res = await apiFetch('/api/customers/counts');
  if (!res.ok) throw new Error('Error al cargar los conteos de clientes');
  return res.json();
}

export async function fetchCustomers(status) {
  const qs = status ? `?status=${status}` : '';
  const res = await apiFetch(`/api/customers${qs}`);
  if (!res.ok) throw new Error('Error al cargar clientes');
  return res.json();
}

export async function fetchCustomer(id) {
  const res = await apiFetch(`/api/customers/${id}`);
  if (!res.ok) throw new Error('Error al cargar el cliente');
  return res.json();
}

export async function updateCustomerProfile(id, fields) {
  const res = await apiFetch(`/api/customers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al actualizar el cliente');
  return res.json();
}

export async function updateCustomerTags(id, patch) {
  const res = await apiFetch(`/api/customers/${id}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al actualizar la etiqueta');
  return res.json();
}

export async function fetchUsers() {
  const res = await apiFetch('/api/users');
  if (!res.ok) throw new Error('Error al cargar usuarios');
  return res.json();
}

export async function createUser(data) {
  const res = await apiFetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al crear el usuario');
  return res.json();
}

export async function updateUser(id, data) {
  const res = await apiFetch(`/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al actualizar el usuario');
  return res.json();
}

export async function deleteUser(id) {
  const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al eliminar el usuario');
}

export async function fetchProducts() {
  const res = await apiFetch('/api/products');
  if (!res.ok) throw new Error('Error al cargar el catálogo');
  return res.json();
}

export async function fetchDashboard() {
  const res = await apiFetch('/api/dashboard');
  if (!res.ok) throw new Error('Error al cargar el dashboard');
  return res.json();
}

export async function fetchAccessAudit(filters = {}) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const res = await apiFetch(`/api/audit/access${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Error al cargar la auditoría de accesos');
  return res.json();
}

export async function fetchAiDecisions(filters = {}) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const res = await apiFetch(`/api/audit/ai-decisions${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Error al cargar el log de decisiones de la IA');
  return res.json();
}

export async function importProducts(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await apiFetch('/api/products/import', { method: 'POST', body: formData });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al importar el catálogo');
  return res.json();
}
