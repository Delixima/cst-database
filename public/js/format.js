// Formatting and small utilities.

const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
const longFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
const relFmt = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });

export const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');
export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const fmtLong = (iso) => (iso ? longFmt.format(new Date(iso)) : '—');

export function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return relFmt.format(Math.round(diff), 'second');
  if (abs < 3600) return relFmt.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relFmt.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return relFmt.format(Math.round(diff / 86400), 'day');
  return fmtDate(iso);
}

/** "120 s (2 min)" */
export function fmtJail(seconds) {
  if (seconds == null) return '—';
  const s = Number(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${s} s (${m} min${rest ? ' ' + rest + ' s' : ''})`;
}

export const fmtNumber = (n) => new Intl.NumberFormat('fr-FR').format(Number(n ?? 0));

/** Date -> value for <input type="datetime-local"> in local time. */
export function toLocalInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO string (or null). */
export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** <input type="date"> value -> ISO at local start (or end) of day. */
export function dayBoundary(value, end = false) {
  if (!value) return null;
  const d = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const qs = (name) => new URLSearchParams(location.search).get(name);

/** Escapes LIKE wildcards in user input. */
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Strictly validated https URL (same rule as the SQL constraint). */
export function isValidEvidenceUrl(u) {
  if (typeof u !== 'string' || u.length < 12 || u.length > 2048) return false;
  if (!/^https:\/\/[^\s<>"'`]+$/.test(u)) return false;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

export function looksLikeImage(u) {
  try {
    const url = new URL(u);
    return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(url.pathname) ||
      /(^|\.)(media\.discordapp\.net|i\.imgur\.com|i\.gyazo\.com|prnt\.sc|i\.ibb\.co)$/i.test(url.hostname);
  } catch {
    return false;
  }
}
