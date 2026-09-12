/**
 * ui/lib/time.js — the browser-side mirror of core/time.mjs.
 *
 * The server serves only `ui/` and `assets/` (core/server.mjs `roots`), so the
 * page physically cannot `import` from `core/`. Rather than invent a second set
 * of time rules, this file carries the display half of core/time.mjs verbatim,
 * and `test/ui-time.test.mjs` imports BOTH and asserts they agree across a
 * corpus of ISO strings. If someone edits one and not the other, that test goes
 * red — the duplication is checked, not trusted.
 *
 * The rule this file exists to enforce: a calendar chip's position comes from
 * the DIGITS IN THE STRING. `new Date('2026-08-11T14:00:00-04:00')` re-expresses
 * that instant in the viewer's zone, which slides every chip by the difference.
 * Date is used here only for real instant arithmetic (ordering, "3h ago").
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

/**
 * The instant a DEADLINE written as a bare date actually falls due.
 *
 * `instant()` reads "2026-08-12" as UTC midnight because it is the ordering
 * function: it needs one rule that never consults a zone, and for sorting, an
 * arbitrary but consistent point inside the day is fine. As a *deadline* that
 * rule is wrong twice over for anyone west of Greenwich — the item turns
 * overdue-red at 8pm the evening before in New York, and then reads "due 16h
 * ago" for the whole of the day it is actually due.
 *
 * A bare date means "some time that day", so the moment it becomes late is the
 * END of that day, not the start: at 9am on the 12th an item due the 12th is
 * due, not overdue, which is the only reading that makes "due today" behave.
 * Start-of-day would paint it red for every one of the hours the person still
 * has to do it in.
 *
 * The offset is resolved from the day's own local noon rather than from UTC
 * noon, so a zone far from Greenwich still lands on the right side of its own
 * DST switch. A zone that changes offset late in the evening can still be an
 * hour out at the very last minute of that one day a year, which is a smaller
 * error than the whole-day one this replaces.
 *
 * The answer is remembered per zone and per day-key, because the two Intl
 * lookups behind it cost something like a hundred times the string parse they
 * replaced, and a board row asks for the same deadline twice — once for its
 * words and once for whether it is late. Both instants the lookups are taken at
 * are derived from the zone and the key alone, so the memo is exact rather than
 * an approximation: the same pair can never produce a different answer, DST
 * boundary or not. The cap is only there so a window left open for a month
 * cannot accumulate keys without limit.
 */
const DUE_CACHE_MAX = 512;
const dueCache = new Map();

export function dueInstant(iso, tz = localTimezone()) {
  const w = wallClock(iso);
  if (!w) return null;
  if (!w.dateOnly) return instant(iso);
  const key = dayKey(iso);
  const memoKey = `${tz}|${key}`;
  if (dueCache.has(memoKey)) return dueCache.get(memoKey);
  const utcNoon = Date.parse(`${key}T12:00:00Z`);
  if (Number.isNaN(utcNoon)) return null;
  const localNoon = utcNoon - offsetMinutes(offsetFor(tz, new Date(utcNoon))) * 60_000;
  const parsed = Date.parse(`${key}T23:59:59.999${offsetFor(tz, new Date(localNoon))}`);
  const t = Number.isNaN(parsed) ? null : parsed;
  if (dueCache.size >= DUE_CACHE_MAX) dueCache.clear();
  dueCache.set(memoKey, t);
  return t;
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
