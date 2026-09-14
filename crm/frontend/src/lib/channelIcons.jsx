// Simplified, recognizable brand marks for the 3 messaging channels — not pixel-perfect
// logo reproductions (those are trademarked assets), just clean enough silhouettes to
// tell WhatsApp/Instagram/Messenger apart at a glance in a small avatar-sized circle.
// Reused everywhere a conversation's channel needs a visual (Conversations.jsx's list,
// the "Red Social" filter, and eventually the Pipeline once that channel work lands).

function WhatsAppGlyph({ size }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none">
      <circle cx="16" cy="16" r="16" fill="#25D366" />
      <path
        fill="#fff"
        d="M16 7a9 9 0 0 0-7.75 13.55L7 25l4.58-1.2A9 9 0 1 0 16 7Zm0 16.3a7.27 7.27 0 0 1-3.71-1.02l-.27-.16-2.72.71.73-2.65-.18-.27A7.3 7.3 0 1 1 16 23.3Zm4-5.47c-.22-.11-1.3-.64-1.5-.71-.2-.07-.35-.11-.5.11-.15.22-.57.71-.7.86-.13.15-.26.16-.48.05-.22-.11-.94-.35-1.8-1.11-.66-.59-1.11-1.32-1.24-1.54-.13-.22-.01-.34.1-.45.1-.1.22-.26.33-.39.11-.13.15-.22.22-.37.07-.15.04-.28-.02-.39-.05-.11-.5-1.2-.68-1.65-.18-.43-.36-.37-.5-.38h-.43c-.15 0-.39.05-.6.28-.2.22-.79.77-.79 1.87s.81 2.17.92 2.32c.11.15 1.6 2.45 3.89 3.43.54.24.97.38 1.3.48.55.17 1.05.15 1.45.09.44-.07 1.3-.53 1.49-1.04.18-.51.18-.95.13-1.04-.05-.09-.2-.15-.42-.26Z"
      />
    </svg>
  );
}

function InstagramGlyph({ size }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size}>
      <defs>
        <linearGradient id="ig-grad" x1="0" y1="32" x2="32" y2="0">
          <stop offset="0" stopColor="#FFDD55" />
          <stop offset="0.35" stopColor="#FF543E" />
          <stop offset="0.65" stopColor="#C837AB" />
          <stop offset="1" stopColor="#5B51D8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#ig-grad)" />
      <rect x="9" y="9" width="14" height="14" rx="4.5" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="16" cy="16" r="3.6" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="20.6" cy="11.4" r="1.15" fill="#fff" />
    </svg>
  );
}

function MessengerGlyph({ size }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size}>
      <defs>
        <linearGradient id="msgr-grad" x1="4.5" y1="2.5" x2="27.5" y2="29.5">
          <stop offset="0" stopColor="#00B2FF" />
          <stop offset="0.5" stopColor="#006AFF" />
          <stop offset="1" stopColor="#A100FF" />
        </linearGradient>
      </defs>
      <path fill="url(#msgr-grad)" d="M16 2C8.3 2 2 7.8 2 15.2c0 4.2 2 7.9 5.2 10.3V30l4.7-2.6c1.3.4 2.7.6 4.1.6 7.7 0 14-5.8 14-13.2S23.7 2 16 2Z" />
      <path fill="#fff" d="m9 19.4 5.1-5.4 4.1 3.9 5.6-6.1-5.1 5.4-4.1-3.9L9 19.4Z" />
    </svg>
  );
}

export const CHANNEL_ICONS = { whatsapp: WhatsAppGlyph, instagram: InstagramGlyph, messenger: MessengerGlyph };
export const CHANNEL_LABELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger' };

export function ChannelIcon({ channel, size = 20 }) {
  const Glyph = CHANNEL_ICONS[channel];
  if (!Glyph) return null;
  return <Glyph size={size} />;
}
