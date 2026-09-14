import { colorFor } from '../lib/avatarColor.js';
import { ChannelIcon } from '../lib/channelIcons.jsx';

function initialsOf(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

// `channel` is optional and additive — every existing caller that doesn't pass one
// (Customers.jsx, and anywhere else) keeps today's colored-initials circle exactly as
// before. When passed ('whatsapp'/'instagram'/'messenger'), the circle shows that
// channel's mark instead — Conversations.jsx's list uses this so an advisor can tell
// which platform a thread came from at a glance (2026-09-14 request), same idea meant
// to extend to the Pipeline once that channel work lands.
export default function Avatar({ name, size = 40, channel }) {
  const label = name?.trim() || '?';
  if (channel) {
    return (
      <div className="flex shrink-0 items-center justify-center rounded-full overflow-hidden" style={{ width: size, height: size }}>
        <ChannelIcon channel={channel} size={size} />
      </div>
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: colorFor(label), fontSize: size * 0.4 }}
    >
      {name ? initialsOf(name) : '?'}
    </div>
  );
}
