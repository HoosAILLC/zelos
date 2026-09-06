import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-calendar-sync-'));
process.env.ZELOS_HOME = path.join(root, 'home');
process.env.ZELOS_LOG_LEVEL = 'silent';
const { open, close, migrate, upsertEvent, reconcileEvents, listEvents, search } = await import('../core/db.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const { DEFAULTS } = await import('../core/config.mjs');
const { eventsFrom } = await import('../core/connectors/calendar.mjs');
const { eventSpanOnDay, conflictsFirst } = await import('../ui/lib/format.js');
let seq = 0;
const databases = [];
test.after(() => {
  for (const db of databases) close(db);
  fs.rmSync(root, { recursive: true, force: true });
});
function fresh() {
  const db = open(path.join(root, `${seq++}.db`));
  migrate(db); databases.push(db); return db;
}
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const start = Date.now() + 86_400_000;
const calendarText = (extra = []) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:weekly',
  `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 3_600_000)}`,
  'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Moonstone appointment', ...extra,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
const emptyCalendar = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
function setup(db) {
  const file = path.join(root, `calendar-${seq++}.ics`);
  fs.writeFileSync(file, calendarText());
  const config = { ...structuredClone(DEFAULTS), mail: [], calendars: [{
    id: 'sync', kind: 'file', enabled: true, url: file, label: 'Test calendar',
  }] };
  const sweep = (deps = {}) => runSweep({ db, config, mode: 'light', deps: { getSecret: async () => null, ...deps } });
  return { file, config, sweep };
}

test('successful calendar snapshots remove deleted recurring occurrences and their search docs', async () => {
  const db = fresh(); const { file, sweep } = setup(db);
  assert.equal((await sweep()).ok, true);
  assert.equal(listEvents(db).length, 2);
  fs.writeFileSync(file, calendarText([`EXDATE:${stamp(start + 7 * 86_400_000)}`]));
  const result = await sweep();
  assert.equal(result.ok, true);
  assert.equal(result.stats.sources[0].count, 1);
  assert.equal(listEvents(db).length, 1);
  assert.equal(search(db, 'moonstone').length, 1);
});

test('empty snapshots remove only this source inside the fetched window', async () => {
  const db = fresh(); const { file, sweep } = setup(db);
  await sweep();
  const event = { uid: 'unrelated', title: 'Preserved', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600000).toISOString() };
  upsertEvent(db, { ...event, calendarId: 'other' });
  upsertEvent(db, { ...event, calendarId: 'sync', uid: 'old', startsAt: new Date(start - 100 * 86400000).toISOString(), endsAt: new Date(start - 100 * 86400000 + 3600000).toISOString() });
  upsertEvent(db, { ...event, calendarId: 'sync', uid: 'future', startsAt: new Date(start + 100 * 86400000).toISOString(), endsAt: new Date(start + 100 * 86400000 + 3600000).toISOString() });
  fs.writeFileSync(file, emptyCalendar);
  await sweep();
  assert.deepEqual(listEvents(db).map(e => e.uid).sort(), ['future', 'old', 'unrelated']);
});

test('failed, truncated, incomplete and malformed calendar reads keep cached events', async () => {
  const db = fresh(); const { file, sweep } = setup(db); await sweep();
  const fail = await sweep({ fetchEvents: async () => { throw new Error('offline'); } });
  assert.equal(fail.stats.sourcesFailed, 1);
  for (const flag of ['truncated', 'incomplete']) {
    const partial = Object.assign([], { [flag]: true });
    await sweep({ fetchEvents: async () => partial });
    assert.equal(listEvents(db).length, 2, `${flag} must preserve the prior snapshot`);
  }
  fs.writeFileSync(file, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:weekly\r\n');
  await sweep();
  assert.equal(listEvents(db).length, 2, 'an interrupted ICS write is not a deletion');
});

test('a recurrence stopped by its work budget is explicitly incomplete', () => {
  const text = calendarText(['RRULE:FREQ=DAILY;BYMONTHDAY=' + Array(18000).fill('1').join(',')])
    .replace('RRULE:FREQ=WEEKLY;COUNT=2\r\n', '');
  const result = eventsFrom(text, { from: new Date(start).toISOString(), to: new Date(start + 60 * 86400000).toISOString() });
  assert.equal(result.incomplete, true);
});

test('cancelled calendar events have no occupied span or false conflict', () => {
  const event = { starts_at: '2026-09-14T14:00:00Z', ends_at: '2026-09-14T15:00:00Z', status: 'CANCELLED' };
  assert.equal(eventSpanOnDay(event, '2026-09-14'), null);
  assert.equal(eventSpanOnDay({ ...event, all_day: true, status: 'cancelled' }, '2026-09-14'), null);
  const rows = [event, { ...event, status: 'CONFIRMED' }].flatMap(event => {
    const span = eventSpanOnDay(event, '2026-09-14'); return span ? [{ event, ...span }] : [];
  });
  assert.deepEqual(conflictsFirst(rows).map(row => row.conflict), [false]);
});

test('reconciliation preserves boundary days, overlapping events and invalid windows', () => {
  const db = fresh();
  const add = (uid, startsAt, endsAt, allDay = false) => upsertEvent(db, {
    calendarId: 'edge', uid, startsAt, endsAt, allDay, title: uid,
  });
  add('contained', '2026-09-08T09:00:00-04:00', '2026-09-08T10:00:00-04:00');
  add('crosses-start', '2026-09-07T09:00:00-04:00', '2026-09-07T11:00:00-04:00');
  add('crosses-end', '2026-09-10T09:00:00-04:00', '2026-09-10T11:00:00-04:00');
  add('day-contained', '2026-09-08', '2026-09-09', true);
  add('day-at-start', '2026-09-07', '2026-09-08', true);
  add('day-at-end', '2026-09-10', '2026-09-11', true);
  add('undated-end', '2026-09-08T10:00:00-04:00', null);
  const window = { calendarId: 'edge', events: [], from: '2026-09-07T14:00:00Z', to: '2026-09-10T14:00:00Z', timezone: 'America/New_York' };
  assert.equal(reconcileEvents(db, { ...window, to: window.from }), 0);
  assert.equal(reconcileEvents(db, { ...window, calendarId: '' }), 0);
  assert.equal(reconcileEvents(db, window), 2);
  assert.deepEqual(listEvents(db).map(e => e.uid).sort(), ['crosses-end', 'crosses-start', 'day-at-end', 'day-at-start', 'undated-end']);
});

test('unsupported recurrence does not turn a partial parse into a deletion snapshot', () => {
  const result = eventsFrom(calendarText().replace('FREQ=WEEKLY;COUNT=2', 'FREQ=HOURLY;COUNT=2'), {});
  assert.equal(result.incomplete, true);
});

test('malformed and partially refused CalDAV snapshots cannot erase cached appointments', async (t) => {
  const { invalidate } = await import('../core/sources/caldav.mjs');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; invalidate(); });
  const listing = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendar/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
  const partialListing = listing.replace('</d:multistatus>', '<d:response><d:href>/unavailable/</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>');
  for (const scenario of ['truncated-report', 'truncated-report-with-events', 'truncated-listing', 'partial-listing', 'failed-home-empty-root', 'failed-home-partial-root', 'optional-property-refused']) {
    invalidate();
    const db = fresh();
    upsertEvent(db, { calendarId: 'dav', uid: 'saved', title: 'Keep me', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600000).toISOString() });
    globalThis.fetch = async (url, opts) => {
      if (scenario.startsWith('failed-home-')) {
        if (opts.method === 'REPORT') return new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 });
        const at = new URL(url).pathname;
        if (at === '/home/') return new Response('Unavailable', { status: 500 });
        const prop = at === '/principal/' ? '<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>'
          : opts.body.includes('current-user-principal') ? '<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>'
          : scenario === 'failed-home-partial-root' ? '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>' : '<d:resourcetype><d:collection/></d:resourcetype>';
        return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
      }
      let body = scenario === 'truncated-listing' || (scenario === 'truncated-report' && opts.method === 'REPORT')
        ? '<d:multistatus xmlns:d="DAV:">'
        : opts.method === 'REPORT' ? '<d:multistatus xmlns:d="DAV:"/>' : scenario === 'partial-listing' ? partialListing : listing;
      if (scenario === 'truncated-report-with-events' && opts.method === 'REPORT') body = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><c:calendar-data><![CDATA[${calendarText()}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response>`;
      if (scenario === 'optional-property-refused' && opts.method === 'PROPFIND') body = listing.replace('</d:response>', '<d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>');
      return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } });
    };
    const config = { ...structuredClone(DEFAULTS), mail: [], calendars: [{ id: 'dav', kind: 'caldav', enabled: true, url: 'http://127.0.0.1:9966/', label: 'DAV' }] };
    const result = await runSweep({ db, config, mode: 'light', deps: { getSecret: async () => null } });
    const incomplete = scenario !== 'optional-property-refused';
    assert.equal(listEvents(db).some(event => event.uid === 'saved'), incomplete, scenario);
    assert.equal(result.stats.sourcesFailed, incomplete ? 1 : 0, scenario);
  }
});

test('ignored or invalid recurrence modifiers preserve the previous calendar snapshot', () => {
  for (const modifier of ['BYHOUR=9,15', 'BYMINUTE=30', 'BYSECOND=0', 'BYYEARDAY=1', 'BYWEEKNO=2', 'BYDAY=ZZ', 'COUNT=abc', 'UNTIL=broken', 'INTERVAL=0', 'BYMONTH=13']) {
    const result = eventsFrom(calendarText().replace('FREQ=WEEKLY;COUNT=2', `FREQ=DAILY;${modifier}`), {
      from: new Date(start).toISOString(), to: new Date(start + 2 * 86400000).toISOString(),
    });
    assert.equal(result.incomplete, true, modifier);
  }
});

test('malformed recurrence date properties prevent calendar reconciliation', () => {
  for (const property of ['RDATE:garbage', 'EXDATE:garbage', 'RECURRENCE-ID:garbage', 'RDATE;VALUE=PERIOD:20260907T140000Z/broken']) {
    assert.equal(eventsFrom(calendarText([property]), {
      from: new Date(start).toISOString(), to: new Date(start + 2 * 86400000).toISOString(),
    }).incomplete, true, property);
  }
});
