function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function yesterday(now) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return d;
}

// WhatsApp-style: time for today, "Ayer" for yesterday, short date otherwise.
export function formatListTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return d.toLocaleTimeString('es-GT', { hour: 'numeric', minute: '2-digit' });
  if (isSameDay(d, yesterday(now))) return 'Ayer';
  return d.toLocaleDateString('es-GT', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function formatDateSeparator(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return 'Hoy';
  if (isSameDay(d, yesterday(now))) return 'Ayer';
  return d.toLocaleDateString('es-GT', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatBubbleTime(iso) {
  return new Date(iso).toLocaleTimeString('es-GT', { hour: 'numeric', minute: '2-digit' });
}

// Groups messages into [{ dateLabel, items }] runs by calendar day.
export function groupByDay(messages) {
  const groups = [];
  for (const m of messages) {
    const label = formatDateSeparator(m.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(m);
    } else {
      groups.push({ label, items: [m] });
    }
  }
  return groups;
}
