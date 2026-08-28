/**
 * core/sources/ics.mjs — RFC 5545 (iCalendar) parsing and recurrence expansion.
 *
 * The invariant the rest of Zelos is built on: every emitted `startsAt` /
 * `endsAt` either carries an explicit UTC offset ("2026-08-11T14:00:00-04:00")
 * or is a bare "YYYY-MM-DD" paired with `allDay:true`. Downstream code reads
 * wall-clock digits straight off that string, so an offset dropped here slides
 * every chip on the calendar.
 *
 * Two deliberate choices, both load-bearing:
 *
 * 1. Recurrence is computed on *wall clock*, not on instants. A weekly 14:00
 *    meeting in America/New_York stays at 14:00 across a DST change; only its
 *    offset moves. So the expander works in "nominal" milliseconds — the
 *    wall-clock fields fed through Date.UTC, a frame with no DST of its own —
 *    and resolves the real offset once per instance, at emit time.
 *
 * 2. Instances are re-expressed in the *target* zone (`opts.tzid`, defaulting to
 *    this machine's zone). A week grid can only place two events side by side if
 *    their strings are in one frame; an event stamped +01:00 next to one stamped
 *    -05:00 would render an hour apart from the truth. The instant is preserved
 *    exactly — only the offset the string carries is normalised. For the common
 *    case (event zone == viewer zone) this is a no-op.
 *
 * Offsets come from Intl (see offsetFor in core/time.mjs), so DST is right
 * without shipping a tz database. The embedded VTIMEZONE is consulted only when
 * Intl rejects the TZID — Windows-style ids like "Eastern Standard Time".
 *
 * Everything in a calendar file is attacker-controlled. Nothing here is
 * evaluated, executed or fetched; URLs are restricted to http/https/mailto
 * before they leave this module.
 */

import { offsetFor, offsetMinutes, toZonedISO, localTimezone, instant as isoInstant } from '../time.mjs';
import { log } from '../log.mjs';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Loop fuses. A malformed rule must cost milliseconds, not a hung process. */
const MAX_PERIODS = 20_000;
const MAX_EMPTY_PERIODS = 4_000; // ~8 leap years of daily periods, so Feb 29 rules still resolve
const MAX_CANDIDATE_SCANS = 500_000; // total BY* work per rule — the lists are unbounded input, walked once per period

const ics = log.child('[ics]');

/* ------------------------------------------------------------------ *
 * Line handling
 * ------------------------------------------------------------------ */

/** RFC 5545 §3.1 line unfolding: a line break followed by one space or tab. */
export function unfold(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n[ \t]/g, '')
    .replace(/[\r\n][ \t]/g, '');
}

/** TEXT value unescaping: \n \N -> newline, \, \; \\ -> the literal character. */
function unescapeText(value) {
  if (typeof value !== 'string') return '';
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = value[++i];
    if (next === undefined) {
      out += '\\';
      break;
    }
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === '\\' || next === ',' || next === ';') out += next;
    else out += `\\${next}`; // undefined escape: keep the bytes rather than mangle them
  }
  return out;
}

/**
 * Split one content line into name, params and raw value.
 * Params may be quoted ("(GMT-05:00) Eastern") and quoted values may contain
 * ':' and ';' — a naive split on ':' loses TZIDs and CNs.
 */
function parseContentLine(line) {
  let i = 0;
  while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).trim().toUpperCase();
  const params = Object.create(null);

  while (line[i] === ';') {
    i++;
    let j = i;
    while (j < line.length && line[j] !== '=' && line[j] !== ';' && line[j] !== ':') j++;
    const pname = line.slice(i, j).trim().toUpperCase();
    const values = [];
    if (line[j] === '=') {
      j++;
      for (;;) {
        if (line[j] === '"') {
          j++;
          const start = j;
          while (j < line.length && line[j] !== '"') j++;
          values.push(line.slice(start, j));
          if (line[j] === '"') j++;
        } else {
          const start = j;
          while (j < line.length && line[j] !== ',' && line[j] !== ';' && line[j] !== ':') j++;
          values.push(line.slice(start, j));
        }
        if (line[j] === ',') {
          j++;
          continue;
        }
        break;
      }
    }
    if (pname) params[pname] = values.join(',');
    i = j;
  }

  const value = line[i] === ':' ? line.slice(i + 1) : '';
  return { name, params, value };
}

/* ------------------------------------------------------------------ *
 * Nominal (wall-clock) arithmetic
 * ------------------------------------------------------------------ */

function mk(y, mo, d, h = 0, mi = 0, s = 0) {
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  if (y >= 0 && y <= 99) {
    // Date.UTC maps 0–99 into the 1900s; calendar years are literal.
    const fixed = new Date(t);
    fixed.setUTCFullYear(y);
    return fixed.getTime();
  }
  return t;
}

function fields(nominal) {
  const d = new Date(nominal);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    wd: d.getUTCDay(),
  };
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function weekdayOf(y, mo, d) {
  return new Date(mk(y, mo, d)).getUTCDay();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKeyOfNominal(nominal) {
  const f = fields(nominal);
  return `${f.y}-${pad2(f.mo)}-${pad2(f.d)}`;
}

/** Day-of-month for the nth (1-based, or negative from the end) weekday of a month. */
function nthWeekdayOfMonth(y, mo, weekday, n) {
  if (!Number.isInteger(n) || n === 0) return null;
  const len = daysInMonth(y, mo);
  if (n > 0) {
    const first = weekdayOf(y, mo, 1);
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= len ? day : null;
  }
  const lastWd = weekdayOf(y, mo, len);
  const day = len - ((lastWd - weekday + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? day : null;
}

/** {mo, d} for the nth weekday of a whole year — YEARLY;BYDAY=20MO with no BYMONTH. */
function nthWeekdayOfYear(y, weekday, n) {
  const yearLen = (mk(y + 1, 1, 1) - mk(y, 1, 1)) / DAY_MS;
  let doy;
  if (n > 0) {
    const jan1 = weekdayOf(y, 1, 1);
    doy = 1 + ((weekday - jan1 + 7) % 7) + (n - 1) * 7;
    if (doy > yearLen) return null;
  } else {
    const dec31 = weekdayOf(y, 12, 31);
    doy = yearLen - ((dec31 - weekday + 7) % 7) + (n + 1) * 7;
    if (doy < 1) return null;
  }
  const f = fields(mk(y, 1, doy));
  return { mo: f.mo, d: f.d };
}

/* ------------------------------------------------------------------ *
 * Zones
 * ------------------------------------------------------------------ */

const zoneValidity = new Map();

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  if (zoneValidity.has(tz)) return zoneValidity.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  zoneValidity.set(tz, ok);
  return ok;
}

/**
 * Signed minutes of offset for a wall-clock reading in `tz`.
 *
 * The offset depends on the instant and the instant depends on the offset, so
 * this converges: guess with the nominal value read as UTC, then re-read the
 * offset at the candidate instant. Two refinements settle every wall clock that
 * exists, including both readings of a fall-back fold.
 *
 * A spring-forward gap is the one that cannot converge — the wall clock is not
 * a time, so the loop oscillates between the offsets either side of the jump.
 * It used to just return whichever it held after the second pass, and which one
 * that was depended on where the very first guess happened to fall: New York's
 * 02:30 on 2027-03-14 pushed forward to 03:30-04:00 while London's 01:30 on
 * 2027-03-28 pulled *backward* to 00:30Z, so a 00:30–01:30 London meeting came
 * out zero minutes long. A gap is always a jump forward, so the smaller of the
 * two readings is the offset in force just before it; taking it shifts every
 * such wall clock into the hour that does exist, in every zone alike, which is
 * what a calendar server does with the same input.
 */
function zoneOffsetMinutesForWall(tz, nominal, vtimezones) {
  if (isValidTimeZone(tz)) {
    let off = offsetMinutes(offsetFor(tz, new Date(nominal)));
    let prev = off;
    for (let pass = 0; pass < 2; pass++) {
      const next = offsetMinutes(offsetFor(tz, new Date(nominal - off * 60_000)));
      if (next === off) return off;
      prev = off;
      off = next;
    }
    return Math.min(prev, off);
  }
  const vtz = vtimezones?.get?.(tz);
  if (vtz) return vtimezoneOffsetMinutes(vtz, nominal);
  if (tz) ics.debug(`unknown TZID, treating as UTC: ${tz}`);
  return 0;
}

/** Offset in minutes for a wall-clock reading, resolved from an embedded VTIMEZONE. */
function vtimezoneOffsetMinutes(vtz, nominal) {
  let best = null;
  let earliest = null;
  for (const obs of vtz.observances) {
    if (obs.start === null) continue;
    if (earliest === null || obs.start < earliest.start) earliest = obs;
    for (const onset of observanceOnsets(obs, nominal)) {
      if (onset <= nominal && (best === null || onset > best.onset)) {
        best = { onset, offset: obs.offsetTo };
      }
    }
  }
  if (best) return best.offset;
  if (earliest) return earliest.offsetFrom ?? earliest.offsetTo ?? 0;
  return 0;
}

/**
 * Onsets of one STANDARD/DAYLIGHT observance near `nominal`.
 * Onsets are written in the wall clock of the *previous* offset, which is
 * exactly the frame we are comparing against, so no conversion is needed.
 */
function observanceOnsets(obs, nominal) {
  const out = [obs.start];
  if (!obs.rrule) {
    for (const extra of obs.rdates) out.push(extra);
    return out;
  }
  const floor = nominal - 3 * 366 * DAY_MS;
  const ceiling = nominal + 366 * DAY_MS;
  // Generous count: Windows exporters anchor observances in 1601, and truncating
  // the series would leave STANDARD and DAYLIGHT compared at the wrong onsets.
  for (const t of recurrenceNominals(obs.start, obs.rrule, { maxNominal: ceiling, maxCount: 2000 })) {
    if (t >= floor) out.push(t);
  }
  for (const extra of obs.rdates) out.push(extra);
  return out;
}

/* ------------------------------------------------------------------ *
 * Value parsing
 * ------------------------------------------------------------------ */

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/**
 * A DATE / DATE-TIME value, kept as wall-clock fields plus how to anchor them.
 * kind: 'date' (all-day) | 'utc' (trailing Z) | 'tzid' | 'floating'.
 */
function parseDateValue(raw, params = {}) {
  const value = String(raw || '').trim();
  const m = DT_RE.exec(value);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const isDate = !hasTime || String(params.VALUE || '').toUpperCase() === 'DATE';
  const tzid = params.TZID ? String(params.TZID).trim() : null;
  let kind;
  if (isDate) kind = 'date';
  else if (m[7] === 'Z') kind = 'utc';
  else if (tzid) kind = 'tzid';
  else kind = 'floating';
  return {
    kind,
    tzid: kind === 'tzid' ? tzid : null,
    nominal: mk(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      hasTime && !isDate ? Number(m[4]) : 0,
      hasTime && !isDate ? Number(m[5]) : 0,
      hasTime && !isDate ? Number(m[6]) : 0,
    ),
  };
}

/** Multi-valued DATE/DATE-TIME property (EXDATE, RDATE). */
function parseDateList(raw, params) {
  const out = [];
  for (const piece of String(raw || '').split(',')) {
    const dt = parseDateValue(piece, params);
    if (dt) out.push(dt);
  }
  return out;
}

const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** RFC 5545 DURATION -> milliseconds of nominal (wall-clock) length. */
function parseDuration(raw) {
  const m = DURATION_RE.exec(String(raw || '').trim().toUpperCase());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const weeks = Number(m[2] || 0);
  const days = Number(m[3] || 0);
  const hours = Number(m[4] || 0);
  const mins = Number(m[5] || 0);
  const secs = Number(m[6] || 0);
  return sign * (((weeks * 7 + days) * 24 + hours) * 3_600_000 + mins * 60_000 + secs * 1000);
}

const BYDAY_RE = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;

/** RRULE value -> a normalised rule object. Unknown parts are ignored, not fatal. */
function parseRRule(raw) {
  const rule = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: [],
    bymonthday: [],
    bymonth: [],
    bysetpos: [],
    wkst: 1, // Monday, the RFC default
  };
  for (const part of String(raw || '').split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim();
    switch (key) {
      case 'FREQ':
        rule.freq = val.toUpperCase();
        break;
      case 'INTERVAL': {
        const n = Number(val);
        rule.interval = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
        break;
      }
      case 'COUNT': {
        const n = Number(val);
        rule.count = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
        break;
      }
      case 'UNTIL':
        rule.until = parseDateValue(val, {});
        break;
      case 'BYDAY':
        for (const entry of val.toUpperCase().split(',')) {
          const m = BYDAY_RE.exec(entry.trim());
          if (m) rule.byday.push({ ordinal: m[1] ? Number(m[1]) : 0, weekday: WEEKDAYS.indexOf(m[2]) });
        }
        break;
      case 'BYMONTHDAY':
        for (const entry of val.split(',')) {
          const n = Number(entry.trim());
          if (Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31) rule.bymonthday.push(n);
        }
        break;
      case 'BYMONTH':
        for (const entry of val.split(',')) {
          const n = Number(entry.trim());
          if (Number.isInteger(n) && n >= 1 && n <= 12) rule.bymonth.push(n);
        }
        break;
      case 'BYSETPOS':
        for (const entry of val.split(',')) {
          const n = Number(entry.trim());
          if (Number.isInteger(n) && n !== 0) rule.bysetpos.push(n);
        }
        break;
      case 'WKST': {
        const idx = WEEKDAYS.indexOf(val.toUpperCase());
        if (idx >= 0) rule.wkst = idx;
        break;
      }
      default:
        break;
    }
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return null;
  return rule;
}

/** "mailto:jane@example.com" with a CN param -> {name, email, rsvp}. */
function parseCalAddress(prop) {
  if (!prop) return null;
  const raw = String(prop.value || '').trim();
  const email = /^mailto:/i.test(raw) ? raw.slice(7).trim() : raw;
  const name = prop.params.CN ? unescapeText(prop.params.CN).trim() : '';
  const rsvp = prop.params.PARTSTAT ? String(prop.params.PARTSTAT).toUpperCase() : null;
  return { name, email, rsvp };
}

/** Calendars are untrusted input; only these schemes may reach the UI. */
function safeishUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  return /^(https?|mailto):/i.test(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * parseICS
 * ------------------------------------------------------------------ */

/**
 * Parse an iCalendar document.
 * -> {vevents:[VEvent], vtimezones:Map<tzid, VTimezone>, calname:string|null}
 *
 * Each VEvent carries a reference to `vtimezones` so it can be handed to
 * `expand` on its own without losing its zone definitions.
 */
export function parseICS(text) {
  const lines = unfold(String(text ?? '')).split(/\r\n|\n|\r/);
  const vtimezones = new Map();
  const vevents = [];
  let calname = null;

  /** Stack of open components; each holds the props seen so far. */
  const stack = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    const { name, params, value } = parseContentLine(line);
    if (!name) continue;

    if (name === 'BEGIN') {
      const comp = { type: value.trim().toUpperCase(), props: [], children: [] };
      if (current) current.children.push(comp);
      stack.push(comp);
      current = comp;
      continue;
    }
    if (name === 'END') {
      const closed = stack.pop();
      current = stack[stack.length - 1] || null;
      if (!closed) continue;
      if (closed.type === 'VEVENT' && (!current || current.type === 'VCALENDAR')) {
        const ev = buildVEvent(closed, vtimezones);
        if (ev) vevents.push(ev);
      } else if (closed.type === 'VTIMEZONE') {
        const tz = buildVTimezone(closed);
        if (tz) vtimezones.set(tz.tzid, tz);
      }
      continue;
    }
    if (!current) continue;
    current.props.push({ name, params, value });
    if (current.type === 'VCALENDAR' && name === 'X-WR-CALNAME' && !calname) {
      calname = unescapeText(value).trim() || null;
    }
  }

  for (const ev of vevents) ev.calendarName = calname;
  return { vevents, vtimezones, calname };
}

function firstProp(comp, name) {
  return comp.props.find((p) => p.name === name) || null;
}

function allProps(comp, name) {
  return comp.props.filter((p) => p.name === name);
}

function textProp(comp, name) {
  const p = firstProp(comp, name);
  return p ? unescapeText(p.value) : '';
}

function buildVEvent(comp, vtimezones) {
  const dtstartProp = firstProp(comp, 'DTSTART');
  const dtstart = dtstartProp ? parseDateValue(dtstartProp.value, dtstartProp.params) : null;
  if (!dtstart) {
    ics.debug('VEVENT without a usable DTSTART, skipped');
    return null;
  }

  const dtendProp = firstProp(comp, 'DTEND');
  const durationProp = firstProp(comp, 'DURATION');
  const recurProp = firstProp(comp, 'RECURRENCE-ID');
  const rruleProp = firstProp(comp, 'RRULE');

  const exdates = [];
  for (const p of allProps(comp, 'EXDATE')) exdates.push(...parseDateList(p.value, p.params));

  const rdates = [];
  for (const p of allProps(comp, 'RDATE')) {
    const isPeriod = String(p.params.VALUE || '').toUpperCase() === 'PERIOD';
    for (const piece of String(p.value || '').split(',')) {
      if (isPeriod || piece.includes('/')) {
        const [startRaw, endRaw] = piece.split('/');
        const start = parseDateValue(startRaw, p.params);
        if (!start) continue;
        let durationMs = null;
        if (endRaw && /^[+-]?P/i.test(endRaw)) durationMs = parseDuration(endRaw);
        else if (endRaw) {
          const end = parseDateValue(endRaw, p.params);
          if (end) durationMs = end.nominal - start.nominal;
        }
        rdates.push({ start, durationMs });
      } else {
        const start = parseDateValue(piece, p.params);
        if (start) rdates.push({ start, durationMs: null });
      }
    }
  }

  const attendees = allProps(comp, 'ATTENDEE').map(parseCalAddress).filter((a) => a && a.email);
  const statusRaw = textProp(comp, 'STATUS').trim().toUpperCase();

  return {
    uid: textProp(comp, 'UID').trim() || null,
    sequence: Number(textProp(comp, 'SEQUENCE')) || 0,
    summary: textProp(comp, 'SUMMARY'),
    description: textProp(comp, 'DESCRIPTION'),
    location: textProp(comp, 'LOCATION'),
    url: safeishUrl(firstProp(comp, 'URL')?.value),
    status: statusRaw || null,
    organizer: parseCalAddress(firstProp(comp, 'ORGANIZER')),
    attendees,
    dtstart,
    dtend: dtendProp ? parseDateValue(dtendProp.value, dtendProp.params) : null,
    durationMs: durationProp ? parseDuration(durationProp.value) : null,
    rrule: rruleProp ? parseRRule(rruleProp.value) : null,
    exdates,
    rdates,
    recurrenceId: recurProp ? parseDateValue(recurProp.value, recurProp.params) : null,
    // RANGE is the only parameter that changes what a RECURRENCE-ID *means*:
    // THISANDFUTURE claims the named instance and every one after it, so an
    // override carrying it has to be applied to a range rather than to a single
    // slot. It lives on the VEvent rather than inside the parsed value because
    // no other property can carry it.
    recurrenceRange:
      recurProp && String(recurProp.params.RANGE || '').trim().toUpperCase() === 'THISANDFUTURE'
        ? 'THISANDFUTURE'
        : null,
    calendarName: null,
    vtimezones,
  };
}

function buildVTimezone(comp) {
  const tzid = (firstProp(comp, 'TZID')?.value || '').trim();
  if (!tzid) return null;
  const observances = [];
  for (const child of comp.children) {
    if (child.type !== 'STANDARD' && child.type !== 'DAYLIGHT') continue;
    const startProp = firstProp(child, 'DTSTART');
    const start = startProp ? parseDateValue(startProp.value, {})?.nominal ?? null : null;
    const rdates = [];
    for (const p of allProps(child, 'RDATE')) {
      for (const dt of parseDateList(p.value, p.params)) rdates.push(dt.nominal);
    }
    observances.push({
      type: child.type,
      offsetFrom: parseUtcOffset(firstProp(child, 'TZOFFSETFROM')?.value),
      offsetTo: parseUtcOffset(firstProp(child, 'TZOFFSETTO')?.value),
      start,
      rrule: firstProp(child, 'RRULE') ? parseRRule(firstProp(child, 'RRULE').value) : null,
      rdates,
    });
  }
  return { tzid, observances };
}

/** "-0500" / "+0530" / "+053000" -> signed minutes. */
function parseUtcOffset(raw) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(raw || '').trim());
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/* ------------------------------------------------------------------ *
 * Recurrence
 * ------------------------------------------------------------------ */

/**
 * Yield wall-clock (nominal) milliseconds for a rule anchored at `start`.
 *
 * DTSTART is always yielded first, even when it does not itself satisfy the
 * BY* parts — real-world files break that rule constantly and dropping the
 * first instance is the more visible bug.
 *
 * `minNominal` is a fast-forward hint, not a filter: when the caller only
 * cares about instances at or after it, periods that end before it may be
 * skipped without being enumerated. Instances before `minNominal` may still
 * be yielded (DTSTART always is); the caller keeps its own window check.
 */
function* recurrenceNominals(start, rule, { maxNominal = Infinity, minNominal = -Infinity, maxCount = 1500 } = {}) {
  yield start;
  let emitted = 1;
  if (emitted >= maxCount) return;
  if (rule.count !== null && emitted >= rule.count) return;

  const base = fields(start);
  const timeOfDay = base.h * HOUR_MS + base.mi * 60_000 + base.s * 1000;
  const bymonth = new Set(rule.bymonth);
  const bydayWeekdays = new Set(rule.byday.map((b) => b.weekday));

  let periodY = base.y;
  let periodMo = base.mo;
  let periodD = base.d;

  if (rule.freq === 'WEEKLY') {
    const shift = (base.wd - rule.wkst + 7) % 7;
    const weekStart = fields(mk(base.y, base.mo, base.d) - shift * DAY_MS);
    periodY = weekStart.y;
    periodMo = weekStart.mo;
    periodD = weekStart.d;
  } else if (rule.freq === 'MONTHLY') {
    periodD = 1;
  } else if (rule.freq === 'YEARLY') {
    periodMo = 1;
    periodD = 1;
  }

  // A rule with no COUNT can be entered anywhere in its series: every period
  // boundary is DTSTART's boundary plus a whole number of interval steps, and
  // no period's expansion depends on the ones before it. So when the caller
  // only wants a distant window, jump the anchor to just before it instead of
  // walking — and counting against maxCount — years of instances nobody asked
  // for; without this jump a daily rule anchored a few years back exhausts the
  // instance budget before it ever reaches the window and the standing meeting
  // silently vanishes. The jump lands one full period early on purpose, cheap
  // insurance that the period straddling `minNominal` is generated whole.
  // COUNT rules cannot take the shortcut: which instances exist depends on how
  // many came before, so those still enumerate from DTSTART.
  if (rule.count === null && Number.isFinite(minNominal)) {
    const anchorMs = mk(periodY, periodMo, periodD);
    if (minNominal > anchorMs) {
      if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
        const stepMs = rule.interval * (rule.freq === 'WEEKLY' ? 7 : 1) * DAY_MS;
        const whole = Math.floor((minNominal - anchorMs) / stepMs) - 1;
        if (whole > 0) {
          const landed = fields(anchorMs + whole * stepMs);
          periodY = landed.y;
          periodMo = landed.mo;
          periodD = landed.d;
        }
      } else if (rule.freq === 'MONTHLY') {
        const target = fields(minNominal);
        const months = target.y * 12 + (target.mo - 1) - (periodY * 12 + (periodMo - 1));
        const whole = Math.floor(months / rule.interval) - 1;
        if (whole > 0) {
          const total = periodY * 12 + (periodMo - 1) + whole * rule.interval;
          periodY = Math.floor(total / 12);
          periodMo = (total % 12) + 1;
          periodD = 1;
        }
      } else {
        const whole = Math.floor((fields(minNominal).y - periodY) / rule.interval) - 1;
        if (whole > 0) periodY += whole * rule.interval;
      }
    }
  }

  // The period fuses bound how many periods run, not what one period costs.
  // BY* lists arrive uncapped and are walked once per period, so a document
  // full of entries that never match bought seconds of frozen sweep — this
  // budget bounds the total scanning one rule may do, however the list is
  // shaped. A real rule's whole horizon costs a few thousand.
  let emptyRun = 0;
  const scans = { left: MAX_CANDIDATE_SCANS };
  for (let period = 0; period < MAX_PERIODS; period++) {
    const periodStart = mk(periodY, periodMo, periodD);
    if (periodStart > maxNominal) return;

    const days = candidateDays(rule, periodY, periodMo, periodD, base, bymonth, bydayWeekdays, scans);
    if (scans.left < 0) {
      ics.warn(`recurrence scanned ${MAX_CANDIDATE_SCANS} candidate days; giving up (FREQ=${rule.freq})`);
      return;
    }
    let selected = [...new Set(days.map((day) => mk(day.y, day.mo, day.d) + timeOfDay))].sort((a, b) => a - b);

    if (rule.bysetpos.length) {
      scans.left -= rule.bysetpos.length;
      const picked = [];
      for (const pos of rule.bysetpos) {
        const idx = pos > 0 ? pos - 1 : selected.length + pos;
        if (idx >= 0 && idx < selected.length) picked.push(selected[idx]);
      }
      selected = [...new Set(picked)].sort((a, b) => a - b);
    }

    let produced = 0;
    for (const t of selected) {
      if (t <= start) continue;
      if (t > maxNominal) return;
      yield t;
      produced++;
      emitted++;
      if (emitted >= maxCount) return;
      if (rule.count !== null && emitted >= rule.count) return;
    }

    if (produced === 0) {
      if (++emptyRun > MAX_EMPTY_PERIODS) {
        ics.warn(`recurrence produced nothing for ${MAX_EMPTY_PERIODS} periods; giving up (FREQ=${rule.freq})`);
        return;
      }
    } else {
      emptyRun = 0;
    }

    // Advance one period.
    if (rule.freq === 'DAILY') {
      const next = fields(mk(periodY, periodMo, periodD) + rule.interval * DAY_MS);
      periodY = next.y;
      periodMo = next.mo;
      periodD = next.d;
    } else if (rule.freq === 'WEEKLY') {
      const next = fields(mk(periodY, periodMo, periodD) + rule.interval * 7 * DAY_MS);
      periodY = next.y;
      periodMo = next.mo;
      periodD = next.d;
    } else if (rule.freq === 'MONTHLY') {
      const total = periodY * 12 + (periodMo - 1) + rule.interval;
      periodY = Math.floor(total / 12);
      periodMo = (total % 12) + 1;
      periodD = 1;
    } else {
      periodY += rule.interval;
      periodMo = 1;
      periodD = 1;
    }
  }
  ics.warn(`recurrence hit the ${MAX_PERIODS}-period cap (FREQ=${rule.freq})`);
}

/** Days a rule selects inside one period, as {y, mo, d}. Spends `scans` as it looks. */
function candidateDays(rule, periodY, periodMo, periodD, base, bymonth, bydayWeekdays, scans) {
  if (rule.freq === 'DAILY') {
    scans.left -= rule.bymonthday.length;
    if (bymonth.size && !bymonth.has(periodMo)) return [];
    if (bydayWeekdays.size && !bydayWeekdays.has(weekdayOf(periodY, periodMo, periodD))) return [];
    if (rule.bymonthday.length && !matchesMonthDay(rule.bymonthday, periodY, periodMo, periodD)) return [];
    return [{ y: periodY, mo: periodMo, d: periodD }];
  }

  if (rule.freq === 'WEEKLY') {
    scans.left -= 7 * rule.bymonthday.length;
    const out = [];
    const weekStart = mk(periodY, periodMo, periodD);
    for (let i = 0; i < 7; i++) {
      const f = fields(weekStart + i * DAY_MS);
      if (bydayWeekdays.size ? !bydayWeekdays.has(f.wd) : f.wd !== base.wd) continue;
      if (bymonth.size && !bymonth.has(f.mo)) continue;
      if (rule.bymonthday.length && !matchesMonthDay(rule.bymonthday, f.y, f.mo, f.d)) continue;
      out.push({ y: f.y, mo: f.mo, d: f.d });
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    if (bymonth.size && !bymonth.has(periodMo)) return [];
    return daysInOneMonth(rule, periodY, periodMo, base.d, bydayWeekdays, scans);
  }

  // YEARLY. With BYDAY but no BYMONTH/BYMONTHDAY the ordinal spans the whole
  // year ("the 20th Monday of 2026"), which is a different question from the
  // monthly one.
  if (rule.byday.length && !bymonth.size && !rule.bymonthday.length) {
    const out = [];
    for (const b of rule.byday) {
      if ((scans.left -= b.ordinal !== 0 ? 1 : 366) < 0) break;
      if (b.ordinal !== 0) {
        const hit = nthWeekdayOfYear(periodY, b.weekday, b.ordinal);
        if (hit) out.push({ y: periodY, mo: hit.mo, d: hit.d });
        continue;
      }
      for (let mo = 1; mo <= 12; mo++) {
        const len = daysInMonth(periodY, mo);
        for (let d = 1; d <= len; d++) {
          if (weekdayOf(periodY, mo, d) === b.weekday) out.push({ y: periodY, mo, d });
        }
      }
    }
    return out;
  }

  const months = bymonth.size ? [...bymonth].sort((a, b) => a - b) : [base.mo];
  const out = [];
  for (const mo of months) out.push(...daysInOneMonth(rule, periodY, mo, base.d, bydayWeekdays, scans));
  return out;
}

function daysInOneMonth(rule, y, mo, defaultDay, bydayWeekdays, scans) {
  const len = daysInMonth(y, mo);
  let days = [];

  if (rule.bymonthday.length) {
    scans.left -= rule.bymonthday.length;
    for (const n of rule.bymonthday) {
      const day = n > 0 ? n : len + n + 1;
      if (day >= 1 && day <= len) days.push(day);
    }
    // BYDAY alongside BYMONTHDAY is a filter, not a generator — ordinals are
    // meaningless in that combination, only the weekday counts.
    if (bydayWeekdays.size) days = days.filter((d) => bydayWeekdays.has(weekdayOf(y, mo, d)));
  } else if (rule.byday.length) {
    for (const b of rule.byday) {
      if ((scans.left -= b.ordinal === 0 ? len : 1) < 0) break;
      if (b.ordinal === 0) {
        for (let d = 1; d <= len; d++) if (weekdayOf(y, mo, d) === b.weekday) days.push(d);
      } else {
        const day = nthWeekdayOfMonth(y, mo, b.weekday, b.ordinal);
        if (day) days.push(day);
      }
    }
  } else if (defaultDay <= len) {
    days.push(defaultDay);
  }

  return [...new Set(days)].sort((a, b) => a - b).map((d) => ({ y, mo, d }));
}

function matchesMonthDay(bymonthday, y, mo, d) {
  const len = daysInMonth(y, mo);
  return bymonthday.some((n) => (n > 0 ? n === d : len + n + 1 === d));
}

/* ------------------------------------------------------------------ *
 * Expansion to Events
 * ------------------------------------------------------------------ */

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const fromIso = isoInstant(String(value));
  if (fromIso !== null) return fromIso;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Everything one VEvent needs to turn a nominal wall clock into a real instant.
 *
 * A *floating* value — no TZID, no trailing Z — is the trap. Reading it as the
 * viewer's zone anchors it to a frame the calendar never named, and every value
 * that has to line up with a generated instance then lands somewhere else.
 * Measured on a New York daily series carrying a floating EXDATE: 2 instances
 * for a New York viewer (right), 3 for London, UTC and Tokyo — the cancelled
 * meeting is back on the board. A floating RECURRENCE-ID stops replacing the
 * instance it moves, so the old time and the new one both render, with
 * different ids, and nothing downstream dedupes them; a UTC master with a
 * floating RECURRENCE-ID ghosts in *every* zone, its own included. A floating
 * UNTIL trims a weekly series a Monday early or a Monday late.
 *
 * So a floating value borrows `ctx.floatingAnchor` — the frame the group's own
 * DTSTART is written in — and only falls back to the viewer's zone when there
 * is nothing to borrow, which is exactly the case the RFC's "read it as local
 * time" rule is about.
 */
function anchorFor(dt, ctx) {
  if (dt.kind === 'utc') return { kind: 'utc' };
  if (dt.kind === 'date') return { kind: 'date' };
  if (dt.kind === 'tzid') return { kind: 'zoned', tz: dt.tzid };
  return ctx.floatingAnchor || { kind: 'zoned', tz: ctx.targetTz };
}

/**
 * The frame a group's floating values belong to: whatever DTSTART the master —
 * or, for an orphan override, the override itself — is written in. Null when
 * that DTSTART is floating or all-day, because then there is no named frame to
 * borrow and every floating value in the group reduces to the viewer's zone,
 * which is what it already did.
 */
function seriesAnchor(dt) {
  if (!dt) return null;
  if (dt.kind === 'utc') return { kind: 'utc' };
  if (dt.kind === 'tzid') return { kind: 'zoned', tz: dt.tzid };
  return null;
}

function nominalToInstant(nominal, anchor, ctx) {
  if (anchor.kind === 'utc') return nominal;
  const tz = anchor.kind === 'date' ? ctx.targetTz : anchor.tz;
  return nominal - zoneOffsetMinutesForWall(tz, nominal, ctx.vtimezones) * 60_000;
}

/** The inverse: what wall clock does `anchor` read at this instant. */
function instantToNominal(at, anchor, ctx) {
  if (anchor.kind === 'utc') return at;
  const tz = anchor.kind === 'date' ? ctx.targetTz : anchor.tz;
  if (isValidTimeZone(tz)) return at + offsetMinutes(offsetFor(tz, new Date(at))) * 60_000;
  const vtz = ctx.vtimezones?.get?.(tz);
  if (!vtz) return at;
  // VTIMEZONE onsets are stated in wall clock, so approximate once and refine.
  let nominal = at;
  for (let pass = 0; pass < 2; pass++) {
    const off = vtimezoneOffsetMinutes(vtz, nominal);
    const next = at + off * 60_000;
    if (next === nominal) break;
    nominal = next;
  }
  return nominal;
}

/**
 * Expand VEvents into concrete Events inside [from, to).
 *
 * opts:
 *   from, to  ISO string | Date | epoch ms — window; an instance is kept when it
 *             overlaps it. Omit either side for an open bound.
 *   max       hard cap on returned instances (default 1500).
 *   tzid      target zone for the emitted offsets (default: this machine's).
 *   email     optional — if given, the event's top-level `rsvp` is that
 *             attendee's PARTSTAT. Purely additive; callers may omit it.
 *   vtimezones optional Map, for VEvents not produced by parseICS.
 */
export function expand(vevents, { from, to, max = 1500, tzid, email = null, vtimezones = null } = {}) {
  const list = Array.isArray(vevents) ? vevents : vevents ? [vevents] : [];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1500;
  const requested = tzid && isValidTimeZone(tzid) ? tzid : localTimezone();
  const fromMs = toMs(from) ?? -Infinity;
  const toMsBound = toMs(to) ?? Infinity;
  const wanted = email ? String(email).trim().toLowerCase() : null;

  // Group by UID so RECURRENCE-ID overrides can replace generated instances.
  const groups = new Map();
  for (const ev of list) {
    if (!ev || !ev.dtstart) continue;
    const key = ev.uid || `anon:${groups.size}`;
    if (!groups.has(key)) groups.set(key, { masters: [], overrides: [] });
    (ev.recurrenceId ? groups.get(key).overrides : groups.get(key).masters).push(ev);
  }

  // `max` used to be spent in document order: `expandOne` returned the moment
  // the shared array reached the cap, groups were walked in file order, and the
  // sort ran afterwards. Measured on 40 weekday-recurring meetings in one
  // document at the default 1500: 31 UIDs came back and meetings 31–40 were
  // gone outright, the same UIDs every sweep — and because the survivors ran to
  // the last day of the window, the result looked complete. The sink keeps the
  // globally earliest `cap` instead, so what gets cut is the tail of the
  // *window*, not whichever meetings a shared calendar happens to list last.
  const sink = { cap, items: [], horizon: toMsBound, dropped: 0 };

  for (const [, group] of groups) {
    const ctx = {
      targetTz: requested,
      floatingAnchor: seriesAnchor(group.masters[0]?.dtstart || group.overrides[0]?.dtstart || null),
      vtimezones: vtimezones || group.masters[0]?.vtimezones || group.overrides[0]?.vtimezones || null,
      wanted,
      fromMs,
      toMsBound,
    };

    // Overrides, keyed by the instance they replace. A RANGE=THISANDFUTURE one
    // is additionally kept in instant order: it owns its own slot *and* every
    // later instance, and where two of them overlap the later one wins.
    const byInstant = new Map();
    const byDay = new Map();
    const future = [];
    for (const ov of group.overrides) {
      const anchor = anchorFor(ov.recurrenceId, ctx);
      const t = nominalToInstant(ov.recurrenceId.nominal, anchor, ctx);
      byInstant.set(t, ov);
      byDay.set(dateKeyOfNominal(ov.recurrenceId.nominal), ov);
      if (ov.recurrenceRange === 'THISANDFUTURE') future.push({ at: t, ov, shift: null });
    }
    future.sort((a, b) => a.at - b.at);
    const overrides = { byInstant, byDay, future, used: new Set() };

    for (const master of group.masters) expandOne(master, ctx, sink, overrides);

    // Overrides that matched no generated instance are still real events.
    for (const ov of group.overrides) {
      if (overrides.used.has(ov)) continue;
      const anchor = anchorFor(ov.dtstart, ctx);
      const startInstant = nominalToInstant(ov.dtstart.nominal, anchor, ctx);
      const durationMs = durationOf(ov, ctx);
      if (startInstant + durationMs <= fromMs || startInstant >= sink.horizon) continue;
      keep(sink, startInstant, buildEvent(ov, ov.dtstart.nominal, ctx, ov.recurrenceId, durationMs));
    }
  }

  sink.items.sort((a, b) => a.sortKey - b.sortKey);
  if (sink.items.length > cap) {
    sink.dropped += sink.items.length - cap;
    sink.items.length = cap;
  }
  if (sink.dropped > 0) {
    ics.warn(`more than max=${cap} instances in the window; dropped ${sink.dropped} from the far end of it`);
  }
  return sink.items.map((c) => c.event);
}

/**
 * Keep one instance, or let the cap drop it.
 *
 * Pruning at twice the cap bounds memory without biasing the answer: the
 * `cap`-th earliest instant only ever moves *earlier* as more groups arrive, so
 * anything at or past it is already unreachable and the horizon can be tightened
 * for every group still to come. That tightening is also what keeps the fix
 * cheap — once the budget is full, a later group generates almost nothing
 * instead of enumerating its whole window to have it thrown away.
 */
function keep(sink, sortKey, event) {
  sink.items.push({ sortKey, event });
  if (sink.items.length < sink.cap * 2) return;
  sink.items.sort((a, b) => a.sortKey - b.sortKey);
  sink.dropped += sink.items.length - sink.cap;
  sink.items.length = sink.cap;
  sink.horizon = Math.min(sink.horizon, sink.items[sink.cap - 1].sortKey + 1);
}

/** The latest RANGE=THISANDFUTURE override that has taken effect by `at`, if any. */
function latestFutureOverride(future, at) {
  let hit = null;
  for (const entry of future) {
    if (entry.at > at) break;
    hit = entry;
  }
  return hit;
}

/**
 * Where a generated instance lands once a RANGE=THISANDFUTURE override owns it.
 *
 * "This and all following events" states the new shape once, on the first
 * affected instance: its DTSTART minus its RECURRENCE-ID is the displacement,
 * and every later instance moves by the same amount and takes the override's
 * properties. Both readings are taken in the *override's* own frame, so a move
 * written in a different zone than the master still shifts by the wall-clock
 * amount its author typed, and the shift survives a DST change intact.
 *
 * The one part left unimplemented: an override that carries its own RRULE is
 * restating the tail's *rule*, not just displacing it. `expandOne` only runs on
 * masters, so that rule is not expanded — the master's rule still shapes the
 * tail. Warn rather than emit a half-corrected series silently.
 */
function applyThisAndFuture(entry, startInstant, ctx) {
  if (entry.shift === null) {
    entry.anchor = anchorFor(entry.ov.dtstart, ctx);
    entry.shift = entry.ov.dtstart.nominal - instantToNominal(entry.at, entry.anchor, ctx);
    entry.durationMs = durationOf(entry.ov, ctx);
    if (entry.ov.rrule) {
      ics.warn(
        `RANGE=THISANDFUTURE override carries its own RRULE, which is not expanded; ` +
          `the master's rule still shapes the tail (UID ${entry.ov.uid || 'unknown'})`,
      );
    }
  }
  const nominal = instantToNominal(startInstant, entry.anchor, ctx) + entry.shift;
  return { nominal, startInstant: nominalToInstant(nominal, entry.anchor, ctx), durationMs: entry.durationMs };
}

function expandOne(master, ctx, sink, overrides) {
  const anchor = anchorFor(master.dtstart, ctx);
  const durationMs = durationOf(master, ctx);
  const isAllDay = master.dtstart.kind === 'date';

  // EXDATE, matched on the true instant so a differently-zoned EXDATE still lands.
  const excludedInstants = new Set();
  const excludedDays = new Set();
  for (const ex of master.exdates) {
    const exAnchor = anchorFor(ex, ctx);
    excludedInstants.add(nominalToInstant(ex.nominal, exAnchor, ctx));
    if (ex.kind === 'date') excludedDays.add(dateKeyOfNominal(ex.nominal));
  }

  // Generation bound: the window's upper edge plus a day of slack, since a
  // nominal reading can sit up to ~14h either side of the instant it names.
  // `sink.horizon` is that edge or tighter — tighter once the cap is full and
  // instances past a known instant can no longer reach the answer.
  const maxNominal = sink.horizon === Infinity ? Infinity : sink.horizon + 26 * HOUR_MS;
  let untilInstant = Infinity;
  let generationBound = maxNominal;
  if (master.rrule?.until) {
    const untilAnchor = anchorFor(master.rrule.until, ctx);
    if (master.rrule.until.kind === 'date') {
      untilInstant = nominalToInstant(master.rrule.until.nominal + DAY_MS - 1000, untilAnchor, ctx);
    } else {
      untilInstant = nominalToInstant(master.rrule.until.nominal, untilAnchor, ctx);
    }
    generationBound = Math.min(generationBound, untilInstant + 26 * HOUR_MS);
  }

  const nominals = [];
  if (master.rrule) {
    // The generator may skip whole periods before this point, so it must sit
    // far enough below the window that nothing overlapping it is lost: an
    // instance still counts when it *ends* after `fromMs`, and its nominal can
    // read up to ~14h away from the instant it names, so back off by the
    // event's own length plus the same day of slack the upper bound uses.
    // For a COUNT rule the budget must reach the full count — the series is
    // enumerated from DTSTART, and a cap below COUNT would drop the tail of a
    // series whose window sits exactly there. A hostile COUNT still cannot
    // buy unbounded work: the budget tops out at a figure no human rule
    // reaches (100k instances is centuries of anything), and MAX_PERIODS
    // holds underneath it regardless.
    const minNominal = ctx.fromMs === -Infinity ? -Infinity : ctx.fromMs - Math.max(0, durationMs) - 26 * HOUR_MS;
    const budget =
      master.rrule.count !== null ? Math.max(sink.cap, Math.min(master.rrule.count, 100_000)) : sink.cap;
    for (const t of recurrenceNominals(master.dtstart.nominal, master.rrule, {
      maxNominal: generationBound,
      minNominal,
      maxCount: budget,
    })) {
      nominals.push(t);
    }
  } else {
    nominals.push(master.dtstart.nominal);
  }

  // RDATE values may be written in a different frame than DTSTART (a Z value on
  // a zoned event is common), so each one is converted into the master's frame
  // before it joins the nominal series.
  const extras = new Map(); // nominal -> per-instance duration from an RDATE PERIOD
  for (const rd of master.rdates) {
    const at = nominalToInstant(rd.start.nominal, anchorFor(rd.start, ctx), ctx);
    const nominal = instantToNominal(at, anchor, ctx);
    nominals.push(nominal);
    if (rd.durationMs !== null) extras.set(nominal, rd.durationMs);
  }

  const seen = new Set();
  for (const nominal of nominals.sort((a, b) => a - b)) {
    if (seen.has(nominal)) continue;
    seen.add(nominal);
    // The horizon can tighten while this very series is being walked, and the
    // nominals are sorted, so once a reading sits a full day past it nothing
    // later in the list can still land inside.
    if (sink.horizon !== Infinity && nominal > sink.horizon + 26 * HOUR_MS) break;

    const startInstant = nominalToInstant(nominal, anchor, ctx);
    if (startInstant > untilInstant) continue;
    if (excludedInstants.has(startInstant)) continue;
    if (excludedDays.size && excludedDays.has(dateKeyOfNominal(nominal))) continue;

    const override =
      overrides.byInstant.get(startInstant) || (isAllDay ? overrides.byDay.get(dateKeyOfNominal(nominal)) : undefined);
    if (override) {
      overrides.used.add(override);
      const ovAnchor = anchorFor(override.dtstart, ctx);
      const ovStart = nominalToInstant(override.dtstart.nominal, ovAnchor, ctx);
      const ovDuration = durationOf(override, ctx);
      if (ovStart + ovDuration <= ctx.fromMs || ovStart >= sink.horizon) continue;
      keep(sink, ovStart, buildEvent(override, override.dtstart.nominal, ctx, override.recurrenceId, ovDuration));
      continue;
    }

    // A "this and all following events" edit owns every instance after its own.
    // Identity stays with the generated slot, not with the override, so the row
    // this instance already occupies is updated rather than duplicated.
    const tail = latestFutureOverride(overrides.future, startInstant);
    if (tail) {
      overrides.used.add(tail.ov);
      const moved = applyThisAndFuture(tail, startInstant, ctx);
      if (moved.startInstant + moved.durationMs <= ctx.fromMs || moved.startInstant >= sink.horizon) continue;
      keep(
        sink,
        moved.startInstant,
        buildEvent(tail.ov, moved.nominal, ctx, { ...master.dtstart, nominal }, moved.durationMs),
      );
      continue;
    }

    const thisDuration = extras.has(nominal) ? extras.get(nominal) : durationMs;
    if (startInstant + thisDuration <= ctx.fromMs || startInstant >= sink.horizon) continue;

    const isSeries = Boolean(master.rrule) || master.rdates.length > 0;
    const recurrenceId = isSeries ? { ...master.dtstart, nominal } : null;
    keep(sink, startInstant, buildEvent(master, nominal, ctx, recurrenceId, thisDuration));
  }
}

/** Nominal (wall-clock) length of an event, so a DST crossing cannot stretch it. */
function durationOf(ev, ctx) {
  if (ev.durationMs !== null && ev.durationMs !== undefined) return Math.max(0, ev.durationMs);
  if (ev.dtend) {
    const sameFrame = ev.dtend.kind === ev.dtstart.kind && ev.dtend.tzid === ev.dtstart.tzid;
    if (sameFrame) return Math.max(0, ev.dtend.nominal - ev.dtstart.nominal);
    const startInstant = nominalToInstant(ev.dtstart.nominal, anchorFor(ev.dtstart, ctx), ctx);
    const endInstant = nominalToInstant(ev.dtend.nominal, anchorFor(ev.dtend, ctx), ctx);
    return Math.max(0, endInstant - startInstant);
  }
  return ev.dtstart.kind === 'date' ? DAY_MS : 0;
}

function buildEvent(src, startNominal, ctx, recurrenceIdValue, durationMs) {
  const allDay = src.dtstart.kind === 'date';
  let startsAt;
  let endsAt;

  if (allDay) {
    // DTEND is exclusive in RFC 5545 and stays exclusive here: `endsAt` is the
    // day after the last one covered, matching how a timed event's end is the
    // moment after it.
    startsAt = dateKeyOfNominal(startNominal);
    endsAt = dateKeyOfNominal(startNominal + Math.max(DAY_MS, durationMs || DAY_MS));
  } else {
    const anchor = anchorFor(src.dtstart, ctx);
    const startInstant = nominalToInstant(startNominal, anchor, ctx);
    // A wall clock inside a DST spring-forward gap does not exist, so resolving
    // it pushes it forward into the hour that does: 02:30 in New York on
    // 2027-03-14 reads back as 03:30-04:00. The end has to travel the same
    // distance. Resolved on its own it does not — the stated 03:30 end lands on
    // that *same* instant and the meeting is emitted as "3:30 AM – 3:30 AM",
    // zero minutes long (measured; the control a day later is a correct 60).
    // `shift` is 0 for every wall clock that exists, which is every instance of
    // every event outside this one hour a year, so the fall-back fold — where
    // the reading is ambiguous rather than absent, and 01:00 -> 02:00 genuinely
    // is two hours — keeps the behaviour it always had.
    const shift = instantToNominal(startInstant, anchor, ctx) - startNominal;
    const endInstant = nominalToInstant(startNominal + shift + durationMs, anchor, ctx);
    startsAt = toZonedISO(new Date(startInstant), ctx.targetTz);
    endsAt = toZonedISO(new Date(endInstant), ctx.targetTz);
  }

  let rsvp = null;
  if (ctx.wanted) {
    const mine = src.attendees.find((a) => a.email.toLowerCase() === ctx.wanted);
    rsvp = mine?.rsvp || null;
  } else if (src.attendees.length === 1) {
    rsvp = src.attendees[0].rsvp || null;
  }

  const organizer = src.organizer
    ? src.organizer.name
      ? `${src.organizer.name} <${src.organizer.email}>`
      : src.organizer.email
    : null;

  return {
    uid: src.uid,
    recurrenceId: recurrenceIdValue ? recurrenceIdToString(recurrenceIdValue, ctx) : null,
    title: src.summary,
    description: src.description,
    location: src.location,
    startsAt,
    endsAt,
    allDay,
    organizer,
    attendees: src.attendees.map((a) => ({ name: a.name, email: a.email, rsvp: a.rsvp })),
    rsvp,
    status: src.status,
    url: src.url,
    calendarName: src.calendarName || null,
  };
}

/** Stable identity for one instance of a series: the recurrence point, normalised. */
function recurrenceIdToString(dt, ctx) {
  if (dt.kind === 'date') return dateKeyOfNominal(dt.nominal);
  const t = nominalToInstant(dt.nominal, anchorFor(dt, ctx), ctx);
  return toZonedISO(new Date(t), ctx.targetTz);
}

/** parseICS + expand, for the common "give me the events in this window" case. */
export function parseICS_toEvents(text, { from, to, max = 1500, tzid, email = null } = {}) {
  const { vevents, vtimezones } = parseICS(text);
  return expand(vevents, { from, to, max, tzid, email, vtimezones });
}
