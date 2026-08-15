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
export function useLiveEvent(channel, callback) {
  useEffect(() => onLiveEvent(channel, callback), [channel, callback]);
}
