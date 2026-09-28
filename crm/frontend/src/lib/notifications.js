/**
 * Browser notification utilities — no external dependencies.
 * Uses the Web Audio API for the chime (no file needed) and the
 * Notification API for desktop push (requires user permission).
 *
 * Permission is requested lazily on first use so we stay compliant
 * with browsers that block auto-prompts on page load.
 */

// A shared AudioContext is reused across plays — creating a new one for every
// chime quickly exhausts the browser limit and causes silent failures.
let _ctx = null;
function getAudioContext() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

/**
 * Plays a soft two-note chime (C5 → G4) using the Web Audio API.
 * Silent if the browser has no audio context or the tab is muted.
 */
export function playChime() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const notes = [
      { freq: 523.25, start: now,       duration: 0.18 }, // C5
      { freq: 392.00, start: now + 0.2, duration: 0.30 }, // G4
    ];

    for (const { freq, start, duration } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      // Fade in quickly, fade out slowly for a "ding" feel
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    }
  } catch (err) {
    // Non-fatal — audio is best-effort
    console.warn('playChime: audio context error', err);
  }
}

/**
 * Requests notification permission from the browser.
 * Call once on login — subsequent calls are no-ops if permission is already granted/denied.
 * Returns the final permission state: 'granted' | 'denied' | 'default'.
 */
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch (err) {
    console.warn('requestNotificationPermission: failed', err);
    return 'denied';
  }
}

/**
 * Shows a desktop push notification if permission is granted.
 * @param {string} title
 * @param {string} body
 * @param {object} [options] — additional Notification options
 */
export function showDesktopNotification(title, body, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'crm-new-chat',   // collapses duplicate notifications instead of stacking
      renotify: true,        // still triggers sound/vibration even if same tag
      ...options,
    });
    // Auto-close after 8 seconds — the advisor can still click it to focus the tab
    setTimeout(() => n.close(), 8000);
  } catch (err) {
    console.warn('showDesktopNotification: failed', err);
  }
}
