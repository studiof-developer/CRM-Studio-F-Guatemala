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
  return `${Math.floor(m / 60)}h ${m % 60}min`;
}
