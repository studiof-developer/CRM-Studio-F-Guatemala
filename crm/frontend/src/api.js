export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

// A 401 from any endpoint (except the login attempt itself — a wrong password is
// also a 401, not an expired session) means the session cookie is gone or expired.
// Without this, each page just failed its own request with its own generic error
// message — scattered and confusing, with nothing telling the advisor to log back
// in. App.jsx listens for this and drops straight to the Login screen instead.
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...options });
  if (res.status === 401 && path !== '/api/auth/login') {
    window.dispatchEvent(new Event('studio-f-session-expired'));
  }
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

export async function fetchPipelineColumn(bucket, { offset = 0, limit = 50, sort = 'desc' } = {}) {
  const params = new URLSearchParams({ bucket, offset, limit, sort });
  const res = await apiFetch(`/api/tickets/pipeline?${params}`);
  if (!res.ok) throw new Error('Error al cargar el pipeline');
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

export async function fetchConversations(q, temperature, ticketStatus, limit, unreadOnly) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (temperature) params.set('temperature', temperature);
  if (ticketStatus) params.set('ticketStatus', ticketStatus);
  if (limit) params.set('limit', limit);
  // Unread is always a small slice regardless of how many threads exist — never
  // capped by the recency limit above, or a real unread thread outside that window
  // would silently disappear from both this filter and the sidebar badge count.
  if (unreadOnly) params.set('unread', 'true');
  const qs = params.toString();
  const res = await apiFetch(`/api/conversations${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Error al cargar conversaciones');
  return res.json();
}

export async function fetchUnreadCount() {
  const res = await apiFetch('/api/conversations/unread-count');
  if (!res.ok) throw new Error('Error al cargar el conteo de no leídos');
  const { count } = await res.json();
  return count;
}

export async function fetchConversation(sessionId, limit) {
  const qs = limit ? `?limit=${limit}` : '';
  const res = await apiFetch(`/api/conversations/${sessionId}${qs}`);
  if (!res.ok) throw new Error('Error al cargar la conversación');
  return res.json();
}

export async function fetchMessageByWamid(sessionId, wamid) {
  const res = await apiFetch(`/api/conversations/${sessionId}/message-by-wamid/${encodeURIComponent(wamid)}`);
  if (!res.ok) throw new Error('not found');
  return res.json();
}

export async function sendAgentTestMessage(testSessionId, message) {
  const res = await apiFetch('/api/agent-test/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testSessionId, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Error al hablar con el agente de prueba');
  return data.reply;
}

export async function fetchMessageDistance(sessionId, id) {
  const res = await apiFetch(`/api/conversations/${sessionId}/message-distance/${id}`);
  if (!res.ok) throw new Error('not found');
  return res.json();
}

export async function searchConversation(sessionId, q) {
  const res = await apiFetch(`/api/conversations/${sessionId}/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('Error al buscar en la conversación');
  return res.json();
}

export async function searchAllConversations(q) {
  const res = await apiFetch(`/api/conversations/search-all?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('Error al buscar en las conversaciones');
  return res.json();
}

export async function markConversationUnread(sessionId) {
  const res = await apiFetch(`/api/conversations/${sessionId}/mark-unread`, { method: 'POST' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al marcar como no leído');
  return res.json();
}

export async function takeConversation(sessionId) {
  const res = await apiFetch(`/api/conversations/${sessionId}/take`, { method: 'POST' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al tomar la conversación');
  return res.json();
}

// "Who's viewing what" — a heartbeat while a chat is open, so the conversation list can
// highlight it for the rest of the team. Best-effort: a failure here shouldn't interrupt
// reading/answering a chat, so callers swallow errors rather than surface them.
export async function fetchPresenceSnapshot() {
  const res = await apiFetch('/api/conversations/presence');
  if (!res.ok) throw new Error('Error al cargar presencia');
  return res.json();
}
export async function sendPresenceHeartbeat(sessionId) {
  return apiFetch(`/api/conversations/${sessionId}/presence`, { method: 'POST' });
}
export async function leavePresence(sessionId) {
  return apiFetch(`/api/conversations/${sessionId}/presence/leave`, { method: 'POST' });
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

export async function retryFailedMessage(sessionId, messageId) {
  const res = await apiFetch(`/api/conversations/${sessionId}/messages/${messageId}/retry`, { method: 'POST' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'No se pudo reenviar el mensaje');
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

// products.image_url already comes back as an API-relative path (e.g.
// /api/products/images/12345.jpg) — this just adds the host, same as attachmentUrl above.
export function productImageUrl(imageUrl) {
  return imageUrl ? `${API_BASE}${imageUrl}` : null;
}

export async function fetchCampaignTemplates() {
  const res = await apiFetch('/api/campaigns/templates');
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al cargar las plantillas');
  return res.json();
}

export async function uploadCampaignHeaderMedia(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await apiFetch('/api/campaigns/header-media', { method: 'POST', body: formData });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al subir la imagen');
  return res.json();
}

export async function searchCampaignAudience(temperature, q) {
  const params = new URLSearchParams();
  if (temperature) params.set('temperature', temperature);
  if (q) params.set('q', q);
  const res = await apiFetch(`/api/campaigns/audience?${params.toString()}`);
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al buscar clientes');
  return res.json();
}

export async function fetchCampaigns() {
  const res = await apiFetch('/api/campaigns');
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al cargar las campañas');
  return res.json();
}

export async function fetchCampaign(id) {
  const res = await apiFetch(`/api/campaigns/${id}`);
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al cargar la campaña');
  return res.json();
}

export async function createCampaign(payload) {
  const res = await apiFetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al crear la campaña');
  return res.json();
}

export async function retryCampaignFailed(id) {
  const res = await apiFetch(`/api/campaigns/${id}/retry-failed`, { method: 'POST' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al reintentar los envíos fallidos');
  return res.json();
}

export async function fetchCustomerCounts() {
  const res = await apiFetch('/api/customers/counts');
  if (!res.ok) throw new Error('Error al cargar los conteos de clientes');
  return res.json();
}

export async function fetchCustomers(q, status) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const qs = params.toString();
  const res = await apiFetch(`/api/customers${qs ? `?${qs}` : ''}`);
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

export async function fetchQuickReplies() {
  const res = await apiFetch('/api/quick-replies');
  if (!res.ok) throw new Error('Error al cargar las plantillas');
  return res.json();
}

export async function createQuickReply(data) {
  const res = await apiFetch('/api/quick-replies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al crear la plantilla');
  return res.json();
}

export async function updateQuickReply(id, data) {
  const res = await apiFetch(`/api/quick-replies/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al actualizar la plantilla');
  return res.json();
}

export async function deleteQuickReply(id) {
  const res = await apiFetch(`/api/quick-replies/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al eliminar la plantilla');
}

export async function fetchWhatsappNumbers() {
  const res = await apiFetch('/api/whatsapp-numbers');
  if (!res.ok) throw new Error('Error al cargar los números de WhatsApp');
  return res.json();
}

export async function testWhatsappNumber(data) {
  const res = await apiFetch('/api/whatsapp-numbers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'No se pudo validar el número');
  return res.json();
}

export async function createWhatsappNumber(data) {
  const res = await apiFetch('/api/whatsapp-numbers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al guardar el número');
  return res.json();
}

export async function updateWhatsappNumber(id, data) {
  const res = await apiFetch(`/api/whatsapp-numbers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al actualizar el número');
  return res.json();
}

export async function deleteWhatsappNumber(id) {
  const res = await apiFetch(`/api/whatsapp-numbers/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al eliminar el número');
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

export async function fetchUnanswered(from, to) {
  const res = await apiFetch(`/api/audit/unanswered?${new URLSearchParams({ from, to })}`);
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al cargar los mensajes sin responder');
  return res.json();
}

export async function importProducts(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await apiFetch('/api/products/import', { method: 'POST', body: formData });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Error al importar el catálogo');
  return res.json();
}
