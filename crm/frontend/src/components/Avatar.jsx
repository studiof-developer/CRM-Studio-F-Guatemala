const COLORS = ['#4338ca', '#0891b2', '#c2410c', '#15803d', '#a21caf', '#b91c1c', '#7c3aed', '#0369a1'];

function colorFor(seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function initialsOf(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export default function Avatar({ name, size = 40 }) {
  const label = name?.trim() || '?';
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: colorFor(label), fontSize: size * 0.4 }}
    >
      {name ? initialsOf(name) : '?'}
    </div>
  );
}
