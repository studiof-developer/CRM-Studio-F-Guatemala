// Same palette/hash used by Avatar.jsx — pulled out so anything else that needs to
// identify a person by a consistent color (e.g. the "who's viewing this chat" presence
// highlight) matches their avatar color instead of picking its own.
const COLORS = ['#4338ca', '#0891b2', '#c2410c', '#15803d', '#a21caf', '#b91c1c', '#7c3aed', '#0369a1'];

export function colorFor(seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

// For a translucent background tint (e.g. "this row is highlighted in Fulana's color")
// where a solid avatar color would be too strong to sit behind text.
export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
