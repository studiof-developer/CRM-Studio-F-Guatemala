import { useEffect } from 'react';
import { API_BASE } from '../api.js';

// One shared connection for the whole app — every page subscribing with its own
// EventSource would open a separate HTTP connection each and risk the browser's
// per-origin connection cap once several pages/badges are all listening at once.
let source = null;
function ensureSource() {
  if (!source) source = new EventSource(`${API_BASE}/api/events`, { withCredentials: true });
  return source;
}

// channel matches a Postgres NOTIFY channel name (see db/init/*-notify.sh).
// Returns an unsubscribe function.
export function onLiveEvent(channel, callback) {
  const es = ensureSource();
  const handler = (e) => callback(e.data);
  es.addEventListener(channel, handler);
  return () => es.removeEventListener(channel, handler);
}

// React convenience wrapper — pass a useCallback'd handler (this codebase already
// wraps its load functions in useCallback everywhere, so this matches that pattern).
//
// Debounced by default: every callback here is some flavor of "reload the list/counts",
// and a burst of same-channel events (several messages landing within the same second —
// a few customers texting close together, a template blast, etc.) used to fire one full
// reload PER event. Every open tab/badge doing that at once is exactly what piled up as
// dozens of duplicate requests and overlapping heavy queries fighting each other in
// Postgres (seen 2026-08-31). Collapsing a burst into one reload after it settles fixes
// that at the source instead of in each individual caller.
export function useLiveEvent(channel, callback, delayMs = 400) {
  useEffect(() => {
    let timer = null;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(callback, delayMs);
    };
    const unsubscribe = onLiveEvent(channel, debounced);
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [channel, callback, delayMs]);
}
