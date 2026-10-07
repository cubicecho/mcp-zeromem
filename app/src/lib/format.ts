/** Compact "how long ago" text for an epoch-millisecond timestamp, e.g. "just now", "5m ago", "2h ago". */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** "1h 02m" / "3d 04h" style uptime from a second count. */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, '0')}h`;
  }
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Thousands-separated integer. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** A local date and time from an epoch-millisecond timestamp. */
export function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

/** A score in [0, 1] as a percentage with no decimals. */
export function formatPercent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A UTC calendar date, `2025-03-14`: what the engine means by a day. */
export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A `[start, end)` period as its first and last UTC day, or the one day it is. */
export function formatWindow(window: { start: number; end: number }): string {
  const first = formatDay(window.start);
  const last = formatDay(window.end - 1);
  return first === last ? first : `${first} – ${last}`;
}
