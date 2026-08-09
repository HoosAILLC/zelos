/**
 * core/time.mjs — the one place Zelos is allowed to think about time.
 *
 * The rule that governs this whole file: an ISO string that carries an offset
 * ("2026-08-11T14:00:00-04:00") already tells you the wall-clock time somebody
 * will read off their wall. Feeding it to `new Date()` and formatting it back
 * re-expresses that instant in whatever zone the *viewer* happens to be in,
 * which silently slides every calendar chip. So: to display, read the digits
 * off the STRING with a regex. Use Date only for real instant arithmetic.
 */

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** IANA zone of this machine, e.g. "America/Indianapolis". */
export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * UTC offset of `tz` at the given instant, as "+HH:MM" / "-HH:MM".
 * Uses Intl rather than a bundled tz database, so DST is correct for free.
 */
export function offsetFor(tz, at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    // "GMT-04:00" | "GMT+5:30" | "GMT"
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(raw);
    if (!m) return '+00:00';
    const sign = m[1];
    const hh = String(Number(m[2])).padStart(2, '0');
    const mm = (m[3] || '00').padStart(2, '0');
    return `${sign}${hh}:${mm}`;
  } catch {
    return '+00:00';
  }
}

/** Parse "+HH:MM" / "-HHMM" / "Z" into signed minutes. */
export function offsetMinutes(offset) {
  if (!offset || offset === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** Render an instant as an ISO string carrying `tz`'s offset. */
export function toZonedISO(at, tz = localTimezone()) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const offset = offsetFor(tz, date);
  const shifted = new Date(date.getTime() + offsetMinutes(offset) * 60_000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}` +
    offset
  );
}

/** Now, as an ISO string in `tz`. */
export function nowISO(tz = localTimezone()) {
  return toZonedISO(new Date(), tz);
}

/**
 * Wall-clock fields read straight off the string — never via Date.
 * Returns null for anything unparseable, so callers can degrade instead of
 * rendering "NaN:NaN".
 */
export function wallClock(iso) {
  if (typeof iso !== 'string') return null;
  const m = ISO_RE.exec(iso.trim());
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] === undefined ? 0 : Number(m[4]),
    minute: m[5] === undefined ? 0 : Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6]),
    offset: m[7] || null,
    dateOnly: m[4] === undefined,
  };
}

/** "YYYY-MM-DD" for the day this string names, in its own zone. */
export function dayKey(iso) {
  const w = wallClock(iso);
  if (!w) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)}`;
}

/** Minutes since midnight, local to the string. */
export function minutesIntoDay(iso) {
  const w = wallClock(iso);
  if (!w) return null;
  return w.hour * 60 + w.minute;
}

/** True instant, for ordering and arithmetic. */
export function instant(iso) {
  const w = wallClock(iso);
  if (!w) return null;
  if (w.dateOnly) return Date.parse(`${iso}T00:00:00Z`);
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Day-key arithmetic that never crosses a Date object. */
export function addDaysToKey(key, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function todayKey(tz = localTimezone()) {
  return dayKey(nowISO(tz));
}

/** 0 = Sunday. Computed from the key, not from a parsed local Date. */
export function weekdayOfKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

export function startOfWeekKey(key, weekStartsOn = 0) {
  const wd = weekdayOfKey(key);
  if (wd === null) return null;
  return addDaysToKey(key, -((wd - weekStartsOn + 7) % 7));
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function monthName(i) { return MONTHS[i - 1] || ''; }
export function dayName(i) { return DAYS[i] || ''; }

/** "2:00 PM" — from the string. */
export function formatTime(iso, { pad = false } = {}) {
  const w = wallClock(iso);
  if (!w || w.dateOnly) return '';
  const ampm = w.hour < 12 ? 'AM' : 'PM';
  const h12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  const h = pad ? String(h12).padStart(2, '0') : String(h12);
  return w.minute === 0 ? `${h} ${ampm}` : `${h}:${String(w.minute).padStart(2, '0')} ${ampm}`;
}

/** "Tue, Aug 11" */
export function formatDay(iso) {
  const key = dayKey(iso);
  const w = wallClock(iso);
  if (!key || !w) return '';
  return `${dayName(weekdayOfKey(key)).slice(0, 3)}, ${monthName(w.month).slice(0, 3)} ${w.day}`;
}

/**
 * "in 20m" / "3h ago" / "yesterday" — deliberately coarse. Precision here reads
 * as noise; a person only needs to know roughly how stale a thing is.
 */
export function humanDelta(iso, now = Date.now()) {
  const t = instant(iso);
  if (t === null) return '';
  const diff = t - (now instanceof Date ? now.getTime() : now);
  const abs = Math.abs(diff);
  const future = diff > 0;
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return future ? 'tomorrow' : 'yesterday';
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`;
  const months = Math.round(days / 30);
  return future ? `in ${months}mo` : `${months}mo ago`;
}

/** Whole days between two day-keys. Used for staleness, so it must not drift. */
export function daysBetweenKeys(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!pa || !pb) return null;
  const ta = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const tb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((tb - ta) / 86_400_000);
}

/** IMAP SEARCH wants "01-Aug-2026". */
export function imapDate(at) {
  const d = at instanceof Date ? at : new Date(at);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')}-${mon}-${d.getUTCFullYear()}`;
}
