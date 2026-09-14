import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { BookingError, migrateBooking, getBookingSettings, saveBookingSettings, listBookingSlots, createBooking, cancelBooking, listBookings } from '../core/booking.mjs';

const now = '2026-09-11T08:00:00Z';
const settings = { enabled: true, timezone: 'UTC', weekdays: [1,2,3,4,5], startTime: '09:00', endTime: '12:00', durationMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 0, horizonDays: 30 };
const request = { startsAt: '2026-09-11T09:00:00Z', name: 'Synthetic Guest', email: 'guest@example.test', note: 'Fictional meeting.' };
const range = { from: '2026-09-11', to: '2026-09-11', now };
function fixture(t, patch = {}) {
  const db = new DatabaseSync(':memory:'); migrateBooking(db);
  db.exec('CREATE TABLE events(starts_at TEXT,ends_at TEXT,all_day INTEGER,status TEXT,rsvp TEXT,title TEXT)');
  saveBookingSettings(db, { ...settings, ...patch }); t.after(() => db.close());
  const event = (start, end, extra = {}) => db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(start, end, extra.allDay || 0, extra.status || 'CONFIRMED', extra.rsvp || '', extra.title || 'Private medical appointment');
  const slots = (input = {}, options = {}) => listBookingSlots(db, { ...range, ...input }, options);
  const book = (input = {}, options = {}) => createBooking(db, { ...request, ...input }, { now, ...options });
  return { db, event, slots, book };
}
const starts = response => response.slots.map(slot => slot.startsAt);
const status = value => error => error instanceof BookingError && error.status === value;

test('migration is repeatable within the owner schema transaction and defaults to disabled', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('BEGIN'); migrateBooking(db); migrateBooking(db); db.exec('COMMIT');
    assert.equal(getBookingSettings(db).enabled, false);
    assert.equal(listBookingSlots(db, range).slots.length, 0);
    assert.throws(() => createBooking(db, request, { now }), status(409));
  } finally { db.close(); }
});

test('settings validate actual dates, zones, weekdays, meeting lengths and optimistic edits', t => {
  const { db } = fixture(t);
  for (const patch of [{ timezone: 'Mars/Studio' }, { weekdays: [1,1] }, { weekdays: [] }, { weekdays: [8] }, { enabled: 'true' }, { durationMinutes: 0 }, { durationMinutes: 31.5 }, { bufferMinutes: -1 }, { minNoticeMinutes: -1 }, { horizonDays: 91 }, { startTime: '17:00', endTime: '09:00' }, { startTime: '24:00' }, { endTime: '11:99' }, { title: 'Hi\r\nHeader' }]) assert.throws(() => saveBookingSettings(db, patch));
  const previous = getBookingSettings(db), changed = saveBookingSettings(db, { title: 'Studio introduction', expectedUpdatedAt: previous.updatedAt });
  assert.notEqual(changed.updatedAt, previous.updatedAt);
  assert.throws(() => saveBookingSettings(db, { title: 'Stale edit', expectedUpdatedAt: previous.updatedAt }), status(409));
  for (const input of [{ from: '2026-02-30' }, { from: '2026-09-12', to: '2026-09-11' }, { to: '2026-10-12' }]) assert.throws(() => listBookingSlots(db, { ...range, ...input }));
});

test('public availability exposes only meeting metadata and precise UTC slots', t => {
  const f = fixture(t); f.event('2026-09-11T10:00:00Z', '2026-09-11T10:30:00Z');
  const result = f.slots();
  assert.equal(result.slots.length, 5);
  assert.deepEqual(Object.keys(result.settings).sort(), ['durationMinutes','enabled','timezone','title']);
  assert.deepEqual(Object.keys(result.slots[0]).sort(), ['endsAt','startsAt']);
  assert.ok(!JSON.stringify(result).includes('Private medical'));
  assert.ok(!JSON.stringify(result).includes('guest'));
  assert.ok(!starts(result).includes('2026-09-11T10:00:00.000Z'));
});

test('weekday, notice, horizon and date boundaries filter candidate slots', t => {
  const f = fixture(t, { minNoticeMinutes: 90, horizonDays: 2 });
  assert.equal(f.slots().slots[0].startsAt, '2026-09-11T09:30:00.000Z');
  assert.equal(f.slots({ from: '2026-09-12', to: '2026-09-13' }).slots.length, 0);
  assert.equal(f.slots({ from: '2026-09-10', to: '2026-09-10' }).slots.length, 0);
  assert.equal(f.slots({ from: '2026-09-14', to: '2026-09-14' }).slots.length, 0);
  assert.throws(() => f.book(), status(409));
  assert.throws(() => f.book({ startsAt: '2026-09-11T09:15:00Z' }), status(409));
});

test('meeting buffers block overlap while exact adjacent boundaries stay available', t => {
  const f = fixture(t, { bufferMinutes: 15 });
  f.event('2026-09-11T10:00:00Z', '2026-09-11T10:30:00Z');
  assert.deepEqual(starts(f.slots()), ['2026-09-11T09:00:00.000Z','2026-09-11T11:00:00.000Z','2026-09-11T11:30:00.000Z']);
  saveBookingSettings(f.db, { bufferMinutes: 0 });
  assert.ok(starts(f.slots()).includes('2026-09-11T09:30:00.000Z'));
  assert.ok(starts(f.slots()).includes('2026-09-11T10:30:00.000Z'));
});

test('offset calendar events and overnight overlaps block by instant', t => {
  const f = fixture(t);
  f.event('2026-09-11T06:00:00-04:00', '2026-09-11T06:30:00-04:00');
  f.event('2026-09-10T23:00:00Z', '2026-09-11T09:45:00Z');
  assert.deepEqual(starts(f.slots()), ['2026-09-11T10:30:00.000Z','2026-09-11T11:00:00.000Z','2026-09-11T11:30:00.000Z']);
});

test('floating and all-day events use the owner zone, with exclusive all-day ends', t => {
  const f = fixture(t, { timezone: 'America/Indiana/Indianapolis' });
  f.event('2026-09-11T09:00:00', '2026-09-11T10:00:00');
  assert.equal(f.slots().slots[0].startsAt, '2026-09-11T14:00:00.000Z');
  f.event('2026-09-11', '2026-09-12', { allDay: 1 });
  assert.equal(f.slots().slots.length, 0);
  assert.equal(f.slots({ from: '2026-09-14', to: '2026-09-14' }).slots.length, 6);
});

test('cancelled and declined calendar entries are free, tentative entries remain busy', t => {
  const f = fixture(t);
  f.event('2026-09-11T09:00:00Z', '2026-09-11T10:00:00Z', { status: 'CANCELLED' });
  f.event('2026-09-11T10:00:00Z', '2026-09-11T11:00:00Z', { rsvp: 'DECLINED' });
  f.event('2026-09-11T11:00:00Z', '2026-09-11T11:30:00Z', { status: 'TENTATIVE' });
  assert.equal(f.slots().slots.length, 5);
  assert.ok(!starts(f.slots()).includes('2026-09-11T11:00:00.000Z'));
});

test('floating event seconds remain busy and impossible guest dates cannot roll forward', t => {
  const f = fixture(t);
  f.event('2026-09-11T09:29:59', '2026-09-11T09:30:01');
  assert.ok(!starts(f.slots()).includes('2026-09-11T09:00:00.000Z'));
  assert.ok(!starts(f.slots()).includes('2026-09-11T09:30:00.000Z'));
  assert.throws(() => f.book({ startsAt: '2026-02-30T09:00:00Z' }, { now: '2026-02-28T08:00:00Z' }));
});

test('missing ends conservatively block the rest of the day and malformed times fail closed', t => {
  const f = fixture(t);
  f.event('2026-09-11T10:00:00Z', null);
  assert.equal(f.slots().slots.length, 2);
  f.event('unreadable', '2026-09-11T11:00:00Z');
  assert.throws(() => f.slots(), status(503));
  assert.throws(() => f.book(), status(503));
  assert.equal(listBookings(f.db).length, 0);
});

test('DST gaps and repeated local hours are omitted instead of guessed', t => {
  const f = fixture(t, { timezone: 'America/New_York', weekdays: [0], startTime: '01:00', endTime: '04:00', horizonDays: 90 });
  const spring = f.slots({ from: '2026-03-08', to: '2026-03-08', now: '2026-03-07T12:00:00Z' });
  assert.deepEqual(starts(spring), ['2026-03-08T06:00:00.000Z','2026-03-08T07:00:00.000Z','2026-03-08T07:30:00.000Z']);
  const fall = f.slots({ from: '2026-11-01', to: '2026-11-01', now: '2026-10-31T12:00:00Z' });
  assert.deepEqual(starts(fall), ['2026-11-01T07:00:00.000Z','2026-11-01T07:30:00.000Z','2026-11-01T08:00:00.000Z','2026-11-01T08:30:00.000Z']);
});

test('half-hour zones and windows ending at midnight retain exact duration', t => {
  const f = fixture(t, { timezone: 'Asia/Kolkata', startTime: '23:00', endTime: '24:00' });
  assert.deepEqual(starts(f.slots()), ['2026-09-11T17:30:00.000Z','2026-09-11T18:00:00.000Z']);
  assert.ok(f.slots().slots.every(slot => Date.parse(slot.endsAt) - Date.parse(slot.startsAt) === 30 * 60000));
});

test('booking saves owner details and only a token hash, while public result excludes personal data', t => {
  const f = fixture(t), result = f.book();
  assert.equal(result.booking.state, 'confirmed');
  assert.match(result.cancellationToken, /^[A-Za-z0-9_-]{43}$/);
  const row = f.db.prepare('SELECT * FROM bookings').get();
  assert.match(row.cancel_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(row).includes(result.cancellationToken));
  assert.ok(!JSON.stringify(result.booking).includes('guest@example.test'));
  assert.equal(listBookings(f.db)[0].email, 'guest@example.test');
  assert.equal(listBookings(f.db)[0].note, 'Fictional meeting.');
  assert.ok(!JSON.stringify(listBookings(f.db)).includes(row.cancel_hash));
  assert.equal(f.slots().slots.length, 5);
});

test('stale availability is rechecked against new calendar records and bookings', t => {
  const f = fixture(t);
  assert.equal(f.slots().slots.length, 6);
  f.event('2026-09-11T09:00:00Z', '2026-09-11T09:30:00Z');
  assert.throws(() => f.book(), status(409));
  f.book({ startsAt: '2026-09-11T09:30:00Z' });
  assert.throws(() => f.book({ startsAt: '2026-09-11T09:30:00Z', email: 'different@example.test' }), status(409));
  assert.equal(listBookings(f.db).length, 1);
});

test('existing bookings retain their buffer when owner settings later reduce it', t => {
  const f = fixture(t, { bufferMinutes: 30 }); f.book();
  saveBookingSettings(f.db, { bufferMinutes: 0, durationMinutes: 15 });
  assert.throws(() => f.book({ startsAt: '2026-09-11T09:30:00Z' }), status(409));
  assert.throws(() => f.book({ startsAt: '2026-09-11T09:45:00Z' }), status(409));
  assert.equal(f.book({ startsAt: '2026-09-11T10:00:00Z' }).booking.state, 'confirmed');
});

test('cancellation requires the exact secret and is repeatable without changing its timestamp', t => {
  const f = fixture(t), first = f.book(), second = f.book({ startsAt: '2026-09-11T10:00:00Z' });
  assert.throws(() => cancelBooking(f.db, { id: first.booking.id, token: second.cancellationToken }, { now }), status(404));
  assert.throws(() => cancelBooking(f.db, { id: 'missing', token: first.cancellationToken }, { now }), status(404));
  const cancelled = cancelBooking(f.db, { id: first.booking.id, token: first.cancellationToken }, { now });
  assert.equal(cancelled.booking.state, 'cancelled');
  assert.equal(cancelBooking(f.db, { id: first.booking.id, token: first.cancellationToken }, { now: '2026-09-11T08:10:00Z' }).booking.cancelledAt, cancelled.booking.cancelledAt);
  assert.equal(f.book().booking.state, 'confirmed');
  assert.equal(listBookings(f.db, { state: 'cancelled' }).length, 1);
});

test('guest inputs reject header controls, invalid addresses, non-grid times and excess text', t => {
  const f = fixture(t);
  for (const patch of [{ name: 'x\nBcc:y' }, { email: 'a@example.test\n' }, { email: 'two@example.test,three@example.test' }, { email: '.x@example.test' }, { email: 'x..y@example.test' }, { email: 'x@bad-.test' }, { startsAt: '2026-09-11T09:00' }, { startsAt: '2026-09-11T09:00:01Z' }, { name: 'x'.repeat(121) }, { note: 'x'.repeat(2001) }]) assert.throws(() => f.book(patch));
  assert.equal(listBookings(f.db).length, 0);
});

test('rate-limit hooks precede reads and writes and never receive private guest fields', t => {
  const f = fixture(t), calls = [];
  const allowed = { clientKey: 'opaque-client', rateLimit: info => { calls.push(info); return true; } };
  f.slots({}, allowed); const booked = f.book({}, allowed);
  cancelBooking(f.db, { id: booked.booking.id, token: booked.cancellationToken }, { ...allowed, now });
  assert.deepEqual(calls, ['availability','create','cancel'].map(operation => ({ operation, clientKey: 'opaque-client' })));
  const denied = { rateLimit: () => ({ allowed: false }) };
  assert.throws(() => f.slots({}, denied), status(429));
  assert.throws(() => f.book({}, denied), status(429));
  assert.throws(() => cancelBooking(f.db, { id: 'missing', token: 'x' }, denied), status(429));
  assert.throws(() => f.slots({}, { rateLimit: async () => true }), status(500));
});

test('competing database connections serialize reservation and reject overlapping requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zelos-booking-test-')), file = join(dir, 'bookings.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(file); migrateBooking(db); saveBookingSettings(db, settings); db.close();
  const gate = new SharedArrayBuffer(4), moduleUrl = new URL('../core/booking.mjs', import.meta.url).href;
  const code = `import {parentPort,workerData} from 'node:worker_threads'; import {DatabaseSync} from 'node:sqlite';
    const {createBooking}=await import(workerData.moduleUrl); const db=new DatabaseSync(workerData.file); db.exec('PRAGMA busy_timeout=2000');
    parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(workerData.gate),0,0);
    try {const result=createBooking(db,workerData.request,{now:workerData.now});parentPort.postMessage({status:result.booking.state});}
    catch(error){parentPort.postMessage({status:error.status,error:error.message});} finally {db.close();}`;
  const workers = [0,1].map(index => new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), { workerData: { file, gate, moduleUrl, now, request: { ...request, name: `Guest ${index}` } } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  const results = workers.map(worker => new Promise((resolve, reject) => { worker.on('message', result => { if (!result.ready) resolve(result); }); worker.on('error', reject); }));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.on('message', result => { if (result.ready) resolve(); }); worker.on('error', reject); })));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
  const outcomes = await Promise.all(results);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [409, 'confirmed']);
  const check = new DatabaseSync(file); assert.equal(listBookings(check).length, 1); check.close();
});

test('busy reservation failure does not roll back another connection or leave a partial booking', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zelos-booking-lock-')), file = join(dir, 'bookings.db');
  const first = new DatabaseSync(file), second = new DatabaseSync(file);
  t.after(() => { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); });
  migrateBooking(first); saveBookingSettings(first, settings); first.exec('BEGIN IMMEDIATE');
  assert.throws(() => createBooking(second, request, { now }), status(409));
  first.exec('COMMIT');
  assert.equal(createBooking(second, request, { now }).booking.state, 'confirmed');
});
