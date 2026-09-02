import { colorFor } from '../lib/avatarColor.js';

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
