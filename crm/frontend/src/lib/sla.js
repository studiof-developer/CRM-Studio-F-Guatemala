// How long a ticket can sit in "esperando_asesor" before it's flagged overdue.
export const SLA_MINUTES = 15;

export function minutesSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
}

export function isOverdue(createdAt) {
  return minutesSince(createdAt) > SLA_MINUTES;
}

export function formatWait(createdAt) {
  const m = minutesSince(createdAt);
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}min`;
  // Past a day, "385h 58min" stops meaning anything at a glance — a date reads
  // instantly instead. Drops the year unless it's not the current one.
  const date = new Date(createdAt);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('es-GT', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
