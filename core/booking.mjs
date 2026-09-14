/** Local booking ledger. No listener, provider write, message delivery, or external I/O.
 * Public integration must authenticate owner settings, rate-limit guests and gate
 * availability on fresh calendar snapshots. Local locking cannot reserve an ICS provider.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { addDaysToKey, offsetFor, offsetMinutes, toZonedISO, weekdayOfKey } from './time.mjs';

export class BookingError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'BookingError'; this.status = status; }
}
const fail = (message, status = 400) => { throw new BookingError(message, status); };
const text = (value, label, max, optional = false) => {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || !value.trim() && !optional || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} is missing or invalid.`);
  return value.trim();
};
const integer = (value, label, low, high) => Number.isInteger(value) && value >= low && value <= high ? value : fail(`${label} must be between ${low} and ${high}.`);
const dayKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value ? value : fail('Choose a real date in YYYY-MM-DD format.');
const timeMinutes = (value, end = false) => {
  if (end && value === '24:00') return 1440;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('Choose a time in HH:MM format.');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
};
const hash = token => createHash('sha256').update(token).digest('hex');
const current = now => { const value = now === undefined ? Date.now() : new Date(now).getTime(); if (!Number.isFinite(value)) fail('Invalid current time.'); return value; };
const defaults = () => ({ enabled: false, title: 'Meet with me', timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', durationMinutes: 30, bufferMinutes: 10, minNoticeMinutes: 120, horizonDays: 30 });

export function migrateBooking(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS booking_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
    timezone TEXT NOT NULL, duration_minutes INTEGER NOT NULL, buffer_minutes INTEGER NOT NULL,
    guest_name TEXT NOT NULL, guest_email TEXT NOT NULL, guest_note TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('confirmed','cancelled')), cancel_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, cancelled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS bookings_time ON bookings(state,starts_at,ends_at);
  CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_start ON bookings(starts_at) WHERE state='confirmed';`);
}
export function getBookingSettings(db) {
  const row = db.prepare('SELECT * FROM booking_settings WHERE id=1').get();
  return { ...defaults(), ...(row ? JSON.parse(row.data_json) : {}), updatedAt: row?.updated_at || null };
}
export function saveBookingSettings(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide availability settings.');
  const old = getBookingSettings(db), value = { ...old, ...input };
  if (Object.hasOwn(input, 'expectedUpdatedAt') && input.expectedUpdatedAt !== old.updatedAt) fail('Availability changed. Reload before saving again.', 409);
  if (typeof value.enabled !== 'boolean') fail('Choose whether booking is enabled.');
  const timezone = text(value.timezone, 'Time zone', 100);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { fail('Choose a valid IANA time zone.'); }
  if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7 || value.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(value.weekdays).size !== value.weekdays.length) fail('Choose unique available weekdays, from 0 (Sunday) to 6 (Saturday).');
  const start = timeMinutes(value.startTime), end = timeMinutes(value.endTime, true);
  const durationMinutes = integer(value.durationMinutes, 'Meeting duration', 5, 240);
  if (end <= start || end - start < durationMinutes) fail('Choose a same-day window long enough for one meeting.');
  const settings = { enabled: value.enabled, title: text(value.title, 'Booking title', 120), timezone, weekdays: [...value.weekdays].sort(),
    startTime: value.startTime, endTime: value.endTime, durationMinutes,
    bufferMinutes: integer(value.bufferMinutes, 'Buffer', 0, 120), minNoticeMinutes: integer(value.minNoticeMinutes, 'Advance notice', 0, 43200),
    horizonDays: integer(value.horizonDays, 'Booking horizon', 1, 90) };
  const updatedAt = new Date(Math.max(Date.now(), (Date.parse(old.updatedAt) || 0) + 1)).toISOString();
  db.prepare('INSERT INTO booking_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(JSON.stringify(settings), updatedAt);
  return { ...settings, updatedAt };
}

// Resolve a wall time through Intl offsets and round-trip validation. Gaps have
// no candidates; repeated clock times have two. Public slots omit both cases.
function wallInstants(day, minutes, tz) {
  if (minutes === 1440) { day = addDaysToKey(day, 1); minutes = 0; }
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
  const wall = `${day}T${clock}`, naive = Date.parse(`${wall}Z`), offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) offsets.add(offsetMinutes(offsetFor(tz, new Date(naive + hours * 3600000))));
  return [...offsets].map(offset => naive - offset * 60000).filter(instant => toZonedISO(instant, tz)?.slice(0, 19) === wall).sort((a, b) => a - b);
}
function calendarInstant(raw, tz, last = false) {
  if (typeof raw !== 'string') return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const value = Date.parse(raw); return Number.isFinite(value) ? value : null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!match || Number(match[4] || 0) > 59) return null;
  try { dayKey(match[1]); } catch { return null; }
  const minutes = Number(match[2] || 0) * 60 + Number(match[3] || 0);
  if (Number(match[2] || 0) > 23 || Number(match[3] || 0) > 59) return null;
  const values = wallInstants(match[1], minutes, tz);
  return values.length ? values[last ? values.length - 1 : 0] + Number(match[4] || 0) * 1000 : null;
}
function busyCalendar(db, tz) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) return [];
  const rows = db.prepare("SELECT starts_at,ends_at,all_day,status,rsvp FROM events WHERE UPPER(COALESCE(status,''))<>'CANCELLED' AND UPPER(COALESCE(rsvp,''))<>'DECLINED' LIMIT 50001").all();
  if (rows.length > 50000) fail('The calendar snapshot is too large to check safely.', 503);
  return rows.map(row => {
    const start = calendarInstant(row.starts_at, tz);
    // Missing ends conservatively occupy the rest of that local day.
    const end = calendarInstant(row.ends_at || `${addDaysToKey(row.starts_at?.slice(0, 10), 1)}T00:00:00`, tz, true);
    if (start === null || end === null || end <= start) fail('A calendar time needs review before availability can be shared.', 503);
    return { start, end };
  });
}
function activeBookings(db) {
  const rows = db.prepare("SELECT starts_at,ends_at,buffer_minutes FROM bookings WHERE state='confirmed' LIMIT 50001").all();
  if (rows.length > 50000) fail('There are too many bookings to check safely.', 503);
  return rows.map(row => ({ start: Date.parse(row.starts_at), end: Date.parse(row.ends_at), buffer: row.buffer_minutes }));
}
function available(settings, day, now, calendar, bookings) {
  const today = toZonedISO(now, settings.timezone).slice(0, 10);
  if (!settings.enabled || day < today || day >= addDaysToKey(today, settings.horizonDays) || !settings.weekdays.includes(weekdayOfKey(day))) return [];
  const slots = [], duration = settings.durationMinutes * 60000, buffer = settings.bufferMinutes * 60000;
  const windowEnd = timeMinutes(settings.endTime, true);
  for (let minute = timeMinutes(settings.startTime); minute + settings.durationMinutes <= windowEnd; minute += settings.durationMinutes) {
    const starts = wallInstants(day, minute, settings.timezone), ends = wallInstants(day, minute + settings.durationMinutes, settings.timezone);
    if (starts.length !== 1 || ends.length !== 1 || ends[0] - starts[0] !== duration) continue;
    const start = starts[0], end = ends[0];
    if (start < now + settings.minNoticeMinutes * 60000) continue;
    if (calendar.some(busy => start < busy.end + buffer && end > busy.start - buffer)) continue;
    if (bookings.some(busy => { const gap = Math.max(settings.bufferMinutes, busy.buffer) * 60000; return start < busy.end + gap && end > busy.start - gap; })) continue;
    slots.push({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
  }
  return slots;
}
function limit(options, operation) {
  if (options.rateLimit === undefined) return;
  if (typeof options.rateLimit !== 'function') fail('A valid rate-limit hook is required.', 500);
  const result = options.rateLimit({ operation, clientKey: options.clientKey || '' });
  if (result?.then) fail('The booking rate-limit hook must be synchronous.', 500);
  if (result === false || result?.allowed === false) fail('Too many requests. Try again later.', 429);
}
const publicSettings = settings => ({ enabled: settings.enabled, title: settings.title, timezone: settings.timezone, durationMinutes: settings.durationMinutes });
export function listBookingSlots(db, input = {}, options = {}) {
  limit(options, 'availability');
  const settings = getBookingSettings(db), now = current(input.now ?? options.now);
  const from = dayKey(input.from || toZonedISO(now, settings.timezone).slice(0, 10));
  const to = dayKey(input.to || addDaysToKey(from, 6));
  if (to < from || Date.parse(to) - Date.parse(from) > 30 * 86400000) fail('Choose up to 31 days of availability.');
  if (!settings.enabled) return { settings: publicSettings(settings), from, to, slots: [] };
  const calendar = busyCalendar(db, settings.timezone), bookings = activeBookings(db), slots = [];
  for (let day = from; day <= to; day = addDaysToKey(day, 1)) slots.push(...available(settings, day, now, calendar, bookings));
  return { settings: publicSettings(settings), from, to, slots };
}
const guestView = row => ({ id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, timezone: row.timezone, durationMinutes: row.duration_minutes, state: row.state, createdAt: row.created_at, cancelledAt: row.cancelled_at });
/** A write reservation is acquired before checking both saved calendars and bookings. */
export function createBooking(db, input, options = {}) {
  limit(options, 'create');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide a meeting request.');
  const name = text(input.name, 'Name', 120), email = text(input.email, 'Email', 254).toLowerCase(), note = text(input.note, 'Note', 2000, true);
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(email) || email.split('@')[0].startsWith('.') || email.split('@')[0].endsWith('.') || email.split('@')[0].includes('..')) fail('Enter a valid email address.');
  if (typeof input.startsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.startsAt)) fail('Choose an available meeting time.');
  dayKey(input.startsAt.slice(0, 10));
  const requested = Date.parse(input.startsAt), now = current(options.now);
  if (!Number.isFinite(requested)) fail('Choose an available meeting time.');
  let transaction = false;
  try {
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    const settings = getBookingSettings(db);
    if (!settings.enabled) fail('Booking is currently unavailable.', 409);
    const day = toZonedISO(requested, settings.timezone).slice(0, 10);
    const slot = available(settings, day, now, busyCalendar(db, settings.timezone), activeBookings(db)).find(value => Date.parse(value.startsAt) === requested);
    if (!slot) fail('That time is no longer available. Choose another time.', 409);
    const id = randomUUID(), cancellationToken = randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO bookings(id,starts_at,ends_at,timezone,duration_minutes,buffer_minutes,guest_name,guest_email,guest_note,state,cancel_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'confirmed',?,?)`).run(id, slot.startsAt, slot.endsAt, settings.timezone, settings.durationMinutes, settings.bufferMinutes, name, email, note, hash(cancellationToken), new Date(now).toISOString());
    const booking = guestView(db.prepare('SELECT * FROM bookings WHERE id=?').get(id));
    if(options.onCreated){
      const result=options.onCreated({...booking,name,email,note},{cancellationToken});
      if(result?.then)fail('Booking persistence must finish synchronously.',500);
    }
    db.exec('COMMIT'); transaction = false;
    return { booking, cancellationToken };
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    if (/database is (?:locked|busy)/i.test(error.message)) fail('Availability is being updated. Refresh before trying again.', 409);
    throw error;
  }
}
export function cancelBooking(db, input, options = {}) {
  limit(options, 'cancel');
  const row = getBookingForGuest(db,input);
  db.prepare("UPDATE bookings SET state='cancelled',cancelled_at=? WHERE id=? AND state='confirmed'").run(new Date(current(options.now)).toISOString(), row.id);
  return { booking: guestView(db.prepare('SELECT * FROM bookings WHERE id=?').get(row.id)) };
}
/** Private credential check for a guest's own confirmation/calendar file. */
export function getBookingForGuest(db,input) {
  const id = text(input?.id, 'Booking', 100), token = text(input?.token, 'Cancellation token', 100);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail('This cancellation link is invalid.', 404);
  const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  // Compare a fixed-length dummy hash even when no booking exists.
  const valid = timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(row?.cancel_hash || '0'.repeat(64), 'hex'));
  if (!row || !valid) fail('This cancellation link is invalid.', 404);
  return row;
}
export function cancelOwnerBooking(db,id) {
  id=text(id,'Booking',100);
  const row=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  if(!row)fail('Booking not found.',404);
  db.prepare("UPDATE bookings SET state='cancelled',cancelled_at=? WHERE id=? AND state='confirmed'").run(new Date().toISOString(),id);
  return {booking:guestView(db.prepare('SELECT * FROM bookings WHERE id=?').get(id))};
}
/** Owner-only. Never expose this response on a guest availability endpoint. */
export function listBookings(db, { state = '' } = {}) {
  if (!['', 'confirmed', 'cancelled'].includes(state)) fail('Choose a valid booking state.');
  return db.prepare('SELECT * FROM bookings WHERE (?=\'\' OR state=?) ORDER BY starts_at DESC LIMIT 1000').all(state, state)
    .map(row => ({ ...guestView(row), name: row.guest_name, email: row.guest_email, note: row.guest_note }));
}
