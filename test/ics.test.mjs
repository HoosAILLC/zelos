/**
 * test/ics.test.mjs — RFC 5545 parsing and recurrence expansion.
 *
 * Fixtures are inline strings. Nothing here touches the network, the real
 * ~/.zelos, or any file on disk.
 *
 * Every test pins an explicit `tzid` so results do not depend on the machine
 * running them, and every emitted time is checked for a carried offset — that
 * property is the whole reason this module exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { unfold, parseICS, expand, parseICS_toEvents } from '../core/sources/ics.mjs';

const NY = 'America/New_York';

/** Join fixture lines with CRLF, the wire form of an .ics file. */
function ics(...lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//zelos//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function vevent(...lines) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

const OFFSET_RE = /[+-]\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The invariant: an offset, or a bare date paired with allDay. */
function assertCarriesOffset(events) {
  for (const ev of events) {
    for (const key of ['startsAt', 'endsAt']) {
      const value = ev[key];
      assert.equal(typeof value, 'string', `${key} must be a string`);
      if (ev.allDay) {
        assert.match(value, DATE_RE, `all-day ${key} must be a bare date, got ${value}`);
      } else {
        assert.match(value, OFFSET_RE, `${key} must carry an explicit offset, got ${value}`);
      }
    }
  }
}

function starts(events) {
  return events.map((e) => e.startsAt);
}

/** Expand a single-VEVENT fixture over a wide window in New York. */
function expandFixture(lines, opts = {}) {
  const events = parseICS_toEvents(ics(...lines), {
    from: '2020-01-01T00:00:00Z',
    to: '2035-01-01T00:00:00Z',
    tzid: NY,
    ...opts,
  });
  assertCarriesOffset(events);
  return events;
}

/* ------------------------------------------------------------------ *
 * Line handling and escaping
 * ------------------------------------------------------------------ */

test('unfold removes CRLF+space and LF+tab continuations, whitespace included', () => {
  // RFC 5545 \u00A73.1: folding inserts a line break AND one whitespace character;
  // unfolding removes both, so no space appears in the rejoined value.
  assert.equal(unfold('DESCRIPTION:one\r\n two'), 'DESCRIPTION:onetwo');
  assert.equal(unfold('DESCRIPTION:one\n\tthree'), 'DESCRIPTION:onethree');
  assert.equal(unfold('DESCRIPTION:one\r\n  two'), 'DESCRIPTION:one two', 'only the first WSP is the fold');
  assert.equal(unfold('A:1\r\nB:2'), 'A:1\r\nB:2', 'a plain line break is not a fold');
  assert.equal(unfold('\uFEFFBEGIN:VCALENDAR'), 'BEGIN:VCALENDAR', 'BOM is stripped');
  assert.equal(unfold(null), '');
});

test('folded lines and TEXT escapes survive parsing', () => {
  const [ev] = expandFixture(
    vevent(
      'UID:escapes-1',
      'DTSTART;TZID=America/New_York:20260811T140000',
      'DTEND;TZID=America/New_York:20260811T150000',
      'SUMMARY:Budget\\, Q4\\; final',
      'DESCRIPTION:line one\\nline two — a very long descrip',
      ' tion folded across lines\\, with a path C:\\\\Users\\\\nemo',
      'LOCATION:Room 4\\, floor 2',
    ),
  );
  assert.equal(ev.title, 'Budget, Q4; final');
  assert.equal(ev.location, 'Room 4, floor 2');
  assert.equal(
    ev.description,
    'line one\nline two — a very long description folded across lines, with a path C:\\Users\\nemo',
  );
});

test('quoted params may contain colons and semicolons', () => {
  const { vevents } = parseICS(
    ics(
      ...vevent(
        'UID:quoted-1',
        'DTSTART;TZID="(GMT-05:00) Eastern; custom":20260811T140000',
        'ATTENDEE;CN="Doe, Jane";PARTSTAT=ACCEPTED:mailto:jane@example.test',
        'SUMMARY:Quoted',
      ),
    ),
  );
  assert.equal(vevents.length, 1);
  assert.equal(vevents[0].dtstart.tzid, '(GMT-05:00) Eastern; custom');
  assert.deepEqual(vevents[0].attendees, [
    { name: 'Doe, Jane', email: 'jane@example.test', rsvp: 'ACCEPTED' },
  ]);
});

/* ------------------------------------------------------------------ *
 * The four DTSTART forms
 * ------------------------------------------------------------------ */

test('DTSTART;VALUE=DATE yields a bare date and allDay', () => {
  const [ev] = expandFixture(
    vevent('UID:date-1', 'DTSTART;VALUE=DATE:20260811', 'DTEND;VALUE=DATE:20260812', 'SUMMARY:All day'),
  );
  assert.equal(ev.allDay, true);
  assert.equal(ev.startsAt, '2026-08-11');
  assert.equal(ev.endsAt, '2026-08-12');
});

test('a multi-day all-day event keeps RFC-exclusive DTEND', () => {
  const [ev] = expandFixture(
    vevent('UID:date-2', 'DTSTART;VALUE=DATE:20260811', 'DTEND;VALUE=DATE:20260814', 'SUMMARY:Conference'),
  );
  assert.equal(ev.startsAt, '2026-08-11');
  assert.equal(ev.endsAt, '2026-08-14');
});

test('an all-day event with no DTEND covers exactly one day', () => {
  const [ev] = expandFixture(vevent('UID:date-3', 'DTSTART;VALUE=DATE:20260811', 'SUMMARY:Holiday'));
  assert.equal(ev.startsAt, '2026-08-11');
  assert.equal(ev.endsAt, '2026-08-12');
});

test('DTSTART;TZID keeps its wall clock and gains the right offset', () => {
  const [ev] = expandFixture(
    vevent(
      'UID:tzid-1',
      'DTSTART;TZID=America/New_York:20260811T140000',
      'DTEND;TZID=America/New_York:20260811T153000',
      'SUMMARY:Tzid',
    ),
  );
  assert.equal(ev.startsAt, '2026-08-11T14:00:00-04:00');
  assert.equal(ev.endsAt, '2026-08-11T15:30:00-04:00');
});

test('DTSTART with a trailing Z is re-expressed in the target zone, same instant', () => {
  const [ev] = expandFixture(
    vevent('UID:utc-1', 'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z', 'SUMMARY:Utc'),
  );
  assert.equal(ev.startsAt, '2026-08-11T14:00:00-04:00');
  assert.equal(Date.parse(ev.startsAt), Date.parse('2026-08-11T18:00:00Z'));
});

test('floating DTSTART is read as local time in the target zone', () => {
  const [ev] = expandFixture(
    vevent('UID:float-1', 'DTSTART:20260811T140000', 'DTEND:20260811T150000', 'SUMMARY:Floating'),
  );
  assert.equal(ev.startsAt, '2026-08-11T14:00:00-04:00');

  const [inLondon] = expandFixture(
    vevent('UID:float-1', 'DTSTART:20260811T140000', 'DTEND:20260811T150000', 'SUMMARY:Floating'),
    { tzid: 'Europe/London' },
  );
  assert.equal(inLondon.startsAt, '2026-08-11T14:00:00+01:00', 'floating time follows the viewer');
});

test('a foreign TZID keeps its instant when re-expressed', () => {
  const [ev] = expandFixture(
    vevent(
      'UID:tzid-2',
      'DTSTART;TZID=Europe/London:20260811T140000',
      'DTEND;TZID=Europe/London:20260811T150000',
      'SUMMARY:London standup',
    ),
  );
  assert.equal(ev.startsAt, '2026-08-11T09:00:00-04:00');
  assert.equal(Date.parse(ev.startsAt), Date.parse('2026-08-11T13:00:00Z'));
});

/* ------------------------------------------------------------------ *
 * DST, in both directions
 * ------------------------------------------------------------------ */

test('a zoned weekly series keeps its wall clock across spring-forward', () => {
  // US DST 2026 begins Sunday 8 March.
  const events = expandFixture(
    vevent(
      'UID:dst-spring',
      'DTSTART;TZID=America/New_York:20260305T090000',
      'DTEND;TZID=America/New_York:20260305T100000',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'SUMMARY:Thursday sync',
    ),
  );
  assert.deepEqual(starts(events), ['2026-03-05T09:00:00-05:00', '2026-03-12T09:00:00-04:00']);
  assert.deepEqual(
    events.map((e) => e.endsAt),
    ['2026-03-05T10:00:00-05:00', '2026-03-12T10:00:00-04:00'],
    'the hour-long meeting stays an hour long',
  );
});

test('a zoned weekly series keeps its wall clock across fall-back', () => {
  // US DST 2026 ends Sunday 1 November.
  const events = expandFixture(
    vevent(
      'UID:dst-fall',
      'DTSTART;TZID=America/New_York:20261029T090000',
      'DTEND;TZID=America/New_York:20261029T100000',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'SUMMARY:Thursday sync',
    ),
  );
  assert.deepEqual(starts(events), ['2026-10-29T09:00:00-04:00', '2026-11-05T09:00:00-05:00']);
});

test('a start inside the spring-forward gap keeps its length instead of collapsing', () => {
  // 02:30 does not exist in New York on 2027-03-14, so the reading is pushed
  // into the hour that does. The regression: the end was resolved on its own
  // and 03:30 landed on that same instant, so the meeting was emitted as
  // "3:30 AM – 3:30 AM" — zero minutes, once a year, for any 02:00–02:59 start.
  const gap = (uid, day, endLine) =>
    vevent(uid, `DTSTART;TZID=America/New_York:${day}T023000`, endLine, 'SUMMARY:Early call');

  const [shifted] = expandFixture(gap('UID:dst-gap', '20270314', 'DTEND;TZID=America/New_York:20270314T033000'));
  assert.equal(shifted.startsAt, '2027-03-14T03:30:00-04:00', '02:30 does not exist; it becomes 03:30');
  assert.equal(shifted.endsAt, '2027-03-14T04:30:00-04:00', 'and the end travels the same distance');

  const [control] = expandFixture(gap('UID:dst-ctl', '20270315', 'DTEND;TZID=America/New_York:20270315T033000'));
  assert.equal(control.startsAt, '2027-03-15T02:30:00-04:00', 'the control a day later is untouched');
  assert.equal(control.endsAt, '2027-03-15T03:30:00-04:00');

  const [withDuration] = expandFixture(gap('UID:dst-gap-dur', '20270314', 'DURATION:PT1H'));
  assert.equal(withDuration.startsAt, '2027-03-14T03:30:00-04:00', 'DURATION takes the same path');
  assert.equal(withDuration.endsAt, '2027-03-14T04:30:00-04:00');
});

test('the spring-forward gap resolves the same way in every zone', () => {
  // London's gap is 01:00–01:59 on 2027-03-28. Its 01:30 used to be pulled
  // *backward* to 00:30Z while New York's 02:30 was pushed forward, purely
  // because the first offset guess fell on a different side — so a 00:30–01:30
  // London meeting, whose start exists and whose end does not, also came out
  // zero minutes long.
  const events = parseICS_toEvents(
    ics(
      ...vevent(
        'UID:ldn-end-in-gap',
        'DTSTART;TZID=Europe/London:20270328T003000',
        'DTEND;TZID=Europe/London:20270328T013000',
        'SUMMARY:Ends in the gap',
      ),
      ...vevent(
        'UID:ldn-start-in-gap',
        'DTSTART;TZID=Europe/London:20270328T013000',
        'DTEND;TZID=Europe/London:20270328T023000',
        'SUMMARY:Starts in the gap',
      ),
    ),
    { from: '2027-03-01', to: '2027-04-01', tzid: 'Europe/London' },
  );
  assertCarriesOffset(events);
  assert.deepEqual(
    events.map((e) => [e.startsAt, e.endsAt]),
    [
      ['2027-03-28T00:30:00+00:00', '2027-03-28T02:30:00+01:00'],
      ['2027-03-28T02:30:00+01:00', '2027-03-28T03:30:00+01:00'],
    ],
  );
  for (const ev of events) {
    assert.equal(Date.parse(ev.endsAt) - Date.parse(ev.startsAt), 3_600_000, `${ev.uid} must stay an hour long`);
  }
});

test('the fall-back fold keeps its stated wall clock, and its real two hours', () => {
  // The counterweight to the gap fix: 01:00 is ambiguous rather than absent on
  // 2026-11-01, both readings exist, and an event stated 01:00 -> 02:00 really
  // does run for two hours. Deriving the end from start + length instead would
  // emit "1:00 AM – 1:00 AM" and simply move the zero-length label to November.
  const [ev] = expandFixture(
    vevent(
      'UID:dst-fold-span',
      'DTSTART;TZID=America/New_York:20261101T010000',
      'DTEND;TZID=America/New_York:20261101T020000',
      'SUMMARY:Across the fold',
    ),
  );
  assert.equal(ev.startsAt, '2026-11-01T01:00:00-04:00');
  assert.equal(ev.endsAt, '2026-11-01T02:00:00-05:00');
  assert.equal(Date.parse(ev.endsAt) - Date.parse(ev.startsAt), 2 * 3_600_000);
});

test('UTC instants land on the right side of a DST change', () => {
  const before = expandFixture(vevent('UID:z-before', 'DTSTART:20260305T140000Z', 'SUMMARY:Before'));
  const after = expandFixture(vevent('UID:z-after', 'DTSTART:20260312T140000Z', 'SUMMARY:After'));
  assert.equal(before[0].startsAt, '2026-03-05T09:00:00-05:00');
  assert.equal(after[0].startsAt, '2026-03-12T10:00:00-04:00');
});

test('an all-day series is unaffected by the DST change it spans', () => {
  const events = expandFixture(
    vevent('UID:dst-allday', 'DTSTART;VALUE=DATE:20261029', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Bins'),
  );
  assert.deepEqual(starts(events), ['2026-10-29', '2026-11-05']);
  assert.equal(events[0].allDay, true);
});

/* ------------------------------------------------------------------ *
 * RRULE — one test per feature
 * ------------------------------------------------------------------ */

test('FREQ=DAILY with INTERVAL and COUNT', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-daily',
      'DTSTART;TZID=America/New_York:20260811T080000',
      'RRULE:FREQ=DAILY;INTERVAL=3;COUNT=4',
      'SUMMARY:Every third day',
    ),
  );
  assert.deepEqual(
    starts(events),
    [
      '2026-08-11T08:00:00-04:00',
      '2026-08-14T08:00:00-04:00',
      '2026-08-17T08:00:00-04:00',
      '2026-08-20T08:00:00-04:00',
    ],
  );
});

test('FREQ=DAILY with UNTIL stops on the boundary', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-until',
      'DTSTART;TZID=America/New_York:20260811T080000',
      'RRULE:FREQ=DAILY;UNTIL=20260814T120000Z',
      'SUMMARY:Until',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'],
  );
});

test('FREQ=WEEKLY with BYDAY picks the named weekdays', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-weekly-byday',
      'DTSTART;TZID=America/New_York:20260907T093000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6',
      'SUMMARY:Standup',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-09-07', '2026-09-09', '2026-09-11', '2026-09-14', '2026-09-16', '2026-09-18'],
  );
});

test('WKST changes which instances an every-other-week rule produces', () => {
  // The worked example from RFC 5545 §3.8.5.3.
  const base = (wkst) =>
    starts(
      expandFixture(
        vevent(
          'UID:rr-wkst',
          'DTSTART;TZID=America/New_York:19970805T090000',
          `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${wkst}`,
          'SUMMARY:Wkst',
        ),
        { from: '1997-01-01T00:00:00Z', to: '1998-01-01T00:00:00Z' },
      ),
    ).map((s) => s.slice(0, 10));

  assert.deepEqual(base('MO'), ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']);
  assert.deepEqual(base('SU'), ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']);
});

test('FREQ=MONTHLY with an ordinal BYDAY (2TU)', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-2tu',
      'DTSTART;TZID=America/New_York:20260908T190000',
      'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3',
      'SUMMARY:Board meeting',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-09-08', '2026-10-13', '2026-11-10'],
  );
});

test('FREQ=MONTHLY with a negative ordinal BYDAY (-1FR)', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-last-fri',
      'DTSTART;TZID=America/New_York:20260925T160000',
      'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3',
      'SUMMARY:Retro',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-09-25', '2026-10-30', '2026-11-27'],
  );
});

test('FREQ=MONTHLY with BYMONTHDAY, including a negative day', () => {
  const positive = expandFixture(
    vevent(
      'UID:rr-bymd',
      'DTSTART;TZID=America/New_York:20260901T090000',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=4',
      'SUMMARY:Payroll',
    ),
  );
  assert.deepEqual(
    starts(positive).map((s) => s.slice(0, 10)),
    ['2026-09-01', '2026-09-15', '2026-10-01', '2026-10-15'],
  );

  const negative = expandFixture(
    vevent(
      'UID:rr-bymd-neg',
      'DTSTART;TZID=America/New_York:20260930T170000',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3',
      'SUMMARY:Month end',
    ),
  );
  assert.deepEqual(
    starts(negative).map((s) => s.slice(0, 10)),
    ['2026-09-30', '2026-10-31', '2026-11-30'],
  );
});

test('BYMONTH restricts a monthly rule to named months', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-bymonth',
      'DTSTART;TZID=America/New_York:20260115T100000',
      'RRULE:FREQ=MONTHLY;BYMONTH=1,7;COUNT=4',
      'SUMMARY:Semiannual review',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-01-15', '2026-07-15', '2027-01-15', '2027-07-15'],
  );
});

test('FREQ=YEARLY repeats the anniversary', () => {
  const events = expandFixture(
    vevent('UID:rr-yearly', 'DTSTART;VALUE=DATE:20260811', 'RRULE:FREQ=YEARLY;COUNT=3', 'SUMMARY:Anniversary'),
  );
  assert.deepEqual(starts(events), ['2026-08-11', '2027-08-11', '2028-08-11']);
});

test('FREQ=YEARLY with an ordinal BYDAY counts across the whole year', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-yearly-byday',
      'DTSTART;TZID=America/New_York:20260119T090000',
      'RRULE:FREQ=YEARLY;BYDAY=3MO;COUNT=2',
      'SUMMARY:Third Monday of the year',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-01-19', '2027-01-18'],
  );
});

test('BYSETPOS selects within the generated set', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-setpos',
      'DTSTART;TZID=America/New_York:20260930T170000',
      'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3',
      'SUMMARY:Last working day',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-09-30', '2026-10-30', '2026-11-30'],
  );
});

test('a sparse rule still finds its next hit years later', () => {
  const events = expandFixture(
    vevent(
      'UID:rr-leap',
      'DTSTART;VALUE=DATE:20280229',
      'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;COUNT=2',
      'SUMMARY:Leap day',
    ),
  );
  assert.deepEqual(starts(events), ['2028-02-29', '2032-02-29']);
});

test('DTSTART is emitted even when it does not satisfy its own rule', () => {
  // Real feeds break this constantly; dropping the stated start of an event
  // that plainly exists is the worse failure.
  const events = expandFixture(
    vevent(
      'UID:rr-nonconforming',
      'DTSTART;TZID=America/New_York:20260908T090000', // a Tuesday
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3',
      'SUMMARY:Mislabelled',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-09-08', '2026-09-14', '2026-09-21'],
  );
});

/* ------------------------------------------------------------------ *
 * Old series reaching a distant window
 *
 * The regression these guard: nominal generation used to spend its whole
 * instance budget counting forward from DTSTART, so a rule anchored a few
 * years back ran out before it ever reached the requested window and a real
 * standing meeting silently vanished from the calendar.
 * ------------------------------------------------------------------ */

test('a daily rule anchored years back still fills a distant window', () => {
  const window = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' };
  const rule = (uid, dtstart) =>
    vevent(uid, `DTSTART;TZID=America/New_York:${dtstart}`, 'RRULE:FREQ=DAILY', 'SUMMARY:Standing');

  const old = expandFixture(rule('UID:ff-daily-old', '20210105T090000'), window);
  const recent = expandFixture(rule('UID:ff-daily-new', '20260701T090000'), window);

  // The sweep: one instance per day across the whole window, at the anchored
  // wall clock, regardless of how long ago the series began.
  assert.equal(recent.length, 30, 'the recently anchored control covers the window');
  assert.deepEqual(
    starts(old),
    Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}T09:00:00-04:00`),
    'the 2021 anchor produces the same 30 August days, not zero',
  );
});

test('a weekly BYDAY rule anchored in 2019 lands on the right weekdays in 2026', () => {
  // `max` deliberately smaller than the instances between the anchor and the
  // window: enumerating from DTSTART would exhaust it long before 2026.
  const events = expandFixture(
    vevent(
      'UID:ff-weekly-byday',
      'DTSTART;TZID=America/New_York:20190107T093000', // a Monday
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'SUMMARY:Standup',
    ),
    { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z', max: 100 },
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    [
      '2026-08-03', '2026-08-05', '2026-08-07',
      '2026-08-10', '2026-08-12', '2026-08-14',
      '2026-08-17', '2026-08-19', '2026-08-21',
      '2026-08-24', '2026-08-26', '2026-08-28',
      '2026-08-31',
    ],
    'every Monday, Wednesday and Friday of August 2026, nothing else',
  );
  for (const ev of events) {
    const wd = new Date(`${ev.startsAt.slice(0, 10)}T12:00:00Z`).getUTCDay();
    assert.ok([1, 3, 5].includes(wd), `${ev.startsAt} must be Mo/We/Fr`);
  }
});

test('INTERVAL=2 weekly keeps its week parity after the jump to the window', () => {
  // Bi-weekly Mondays from 2019-01-07. 2026-08-03 is 2765 days = 197 weeks and
  // 4 days on, an odd week — so August 2026 holds exactly the 10th and 24th,
  // and landing on the wrong parity would surface the 3rd, 17th and 31st.
  const events = expandFixture(
    vevent(
      'UID:ff-parity',
      'DTSTART;TZID=America/New_York:20190107T090000',
      'RRULE:FREQ=WEEKLY;INTERVAL=2',
      'SUMMARY:Biweekly',
    ),
    { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z', max: 50 },
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-08-10', '2026-08-24'],
  );
});

test('an EXDATE inside the window of an old series still excludes its instance', () => {
  const events = expandFixture(
    vevent(
      'UID:ff-exdate',
      'DTSTART;TZID=America/New_York:20210105T090000',
      'RRULE:FREQ=DAILY',
      'EXDATE;TZID=America/New_York:20260812T090000',
      'SUMMARY:Standing minus one',
    ),
    { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' },
  );
  assert.equal(events.length, 29, 'thirty August days minus the excluded one');
  assert.ok(!starts(events).some((s) => s.startsWith('2026-08-12')), 'the 12th is excluded');
  assert.ok(starts(events).some((s) => s.startsWith('2026-08-11')), 'its neighbours are not');
  assert.ok(starts(events).some((s) => s.startsWith('2026-08-13')));
});

test('COUNT rules enumerate from DTSTART: exactly the count, never more', () => {
  // COUNT semantics forbid the jump — which instances exist depends on how
  // many came before — so the finite series is walked from its anchor.
  const events = expandFixture(
    vevent(
      'UID:ff-count',
      'DTSTART;TZID=America/New_York:20210105T090000',
      'RRULE:FREQ=DAILY;COUNT=10',
      'SUMMARY:Short series',
    ),
    { from: '2020-01-01T00:00:00Z', to: '2035-01-01T00:00:00Z' },
  );
  assert.equal(events.length, 10);
  assert.equal(starts(events)[0], '2021-01-05T09:00:00-05:00');
  assert.equal(starts(events)[9], '2021-01-14T09:00:00-05:00');

  const afterTheEnd = expandFixture(
    vevent(
      'UID:ff-count-after',
      'DTSTART;TZID=America/New_York:20210105T090000',
      'RRULE:FREQ=DAILY;COUNT=10',
      'SUMMARY:Short series',
    ),
    { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' },
  );
  assert.deepEqual(afterTheEnd, [], 'a series that ended in 2021 has nothing in 2026');
});

test('the instance budget cannot truncate a COUNT series below its count', () => {
  // 2000 daily instances from 2021-01-05 run to 2026-06-27. A budget pinned at
  // the default cap of 1500 would end the series in early 2025 and leave this
  // June 2026 window empty.
  const events = expandFixture(
    vevent(
      'UID:ff-count-tail',
      'DTSTART;TZID=America/New_York:20210105T090000',
      'RRULE:FREQ=DAILY;COUNT=2000',
      'SUMMARY:Long finite series',
    ),
    { from: '2026-06-01T00:00:00Z', to: '2026-07-01T00:00:00Z' },
  );
  assert.equal(events.length, 27, 'June 1st through the 27th, where instance #2000 falls');
  assert.equal(starts(events)[0], '2026-06-01T09:00:00-04:00');
  assert.equal(starts(events)[26], '2026-06-27T09:00:00-04:00');
});

/* ------------------------------------------------------------------ *
 * EXDATE, RDATE, RECURRENCE-ID
 * ------------------------------------------------------------------ */

test('EXDATE removes an instance without extending the series', () => {
  const events = expandFixture(
    vevent(
      'UID:exdate-1',
      'DTSTART;TZID=America/New_York:20260907T090000',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE;TZID=America/New_York:20260914T090000',
      'SUMMARY:Weekly',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-09-07', '2026-09-21', '2026-09-28'],
    'COUNT counts the excluded occurrence',
  );
});

test('EXDATE written in another zone still matches by instant', () => {
  const events = expandFixture(
    vevent(
      'UID:exdate-2',
      'DTSTART;TZID=America/New_York:20260907T090000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'EXDATE:20260914T130000Z',
      'SUMMARY:Weekly',
    ),
  );
  assert.deepEqual(
    starts(events).map((s) => s.slice(0, 10)),
    ['2026-09-07', '2026-09-21'],
  );
});

test('a comma-separated EXDATE removes every listed instance', () => {
  const events = expandFixture(
    vevent(
      'UID:exdate-3',
      'DTSTART;VALUE=DATE:20260907',
      'RRULE:FREQ=DAILY;COUNT=5',
      'EXDATE;VALUE=DATE:20260908,20260910',
      'SUMMARY:Daily',
    ),
  );
  assert.deepEqual(starts(events), ['2026-09-07', '2026-09-09', '2026-09-11']);
});

test('RDATE adds instances outside the rule', () => {
  const events = expandFixture(
    vevent(
      'UID:rdate-1',
      'DTSTART;TZID=America/New_York:20260907T090000',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'RDATE;TZID=America/New_York:20260910T150000',
      'SUMMARY:Weekly plus one',
    ),
  );
  assert.deepEqual(starts(events), [
    '2026-09-07T09:00:00-04:00',
    '2026-09-10T15:00:00-04:00',
    '2026-09-14T09:00:00-04:00',
  ]);
});

test('RDATE with a PERIOD value carries its own length', () => {
  const events = expandFixture(
    vevent(
      'UID:rdate-2',
      'DTSTART;TZID=America/New_York:20260907T090000',
      'DTEND;TZID=America/New_York:20260907T093000',
      'RDATE;VALUE=PERIOD:20260910T190000Z/PT2H',
      'SUMMARY:Usually short',
    ),
  );
  assert.equal(events.length, 2);
  assert.equal(events[1].startsAt, '2026-09-10T15:00:00-04:00');
  assert.equal(events[1].endsAt, '2026-09-10T17:00:00-04:00');
});

test('RECURRENCE-ID replaces the generated instance and keeps its identity', () => {
  const events = expandFixture([
    ...vevent(
      'UID:override-1',
      'DTSTART;TZID=America/New_York:20260811T140000',
      'DTEND;TZID=America/New_York:20260811T150000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:Weekly 1:1',
    ),
    ...vevent(
      'UID:override-1',
      'RECURRENCE-ID;TZID=America/New_York:20260818T140000',
      'DTSTART;TZID=America/New_York:20260818T163000',
      'DTEND;TZID=America/New_York:20260818T173000',
      'SUMMARY:Weekly 1:1 (moved)',
    ),
  ]);

  assert.equal(events.length, 3, 'the override replaces, it does not add');
  assert.deepEqual(starts(events), [
    '2026-08-11T14:00:00-04:00',
    '2026-08-18T16:30:00-04:00',
    '2026-08-25T14:00:00-04:00',
  ]);
  assert.equal(events[1].title, 'Weekly 1:1 (moved)');
  assert.equal(
    events[1].recurrenceId,
    '2026-08-18T14:00:00-04:00',
    'identity stays with the original slot so the row is updated, not duplicated',
  );
  assert.equal(events[0].recurrenceId, '2026-08-11T14:00:00-04:00');
  assert.equal(new Set(events.map((e) => e.recurrenceId)).size, 3, 'each instance is addressable');
});

test('a cancelled override is surfaced as CANCELLED rather than silently dropped', () => {
  const events = expandFixture([
    ...vevent(
      'UID:override-2',
      'DTSTART;TZID=America/New_York:20260811T140000',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'SUMMARY:Weekly',
    ),
    ...vevent(
      'UID:override-2',
      'RECURRENCE-ID;TZID=America/New_York:20260818T140000',
      'DTSTART;TZID=America/New_York:20260818T140000',
      'STATUS:CANCELLED',
      'SUMMARY:Weekly',
    ),
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[1].status, 'CANCELLED');
});

test('an override with no matching instance is still emitted', () => {
  const events = expandFixture([
    ...vevent(
      'UID:override-3',
      'RECURRENCE-ID;TZID=America/New_York:20260818T140000',
      'DTSTART;TZID=America/New_York:20260818T160000',
      'SUMMARY:Orphan override',
    ),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].startsAt, '2026-08-18T16:00:00-04:00');
  assert.equal(events[0].recurrenceId, '2026-08-18T14:00:00-04:00');
});

/* ------------------------------------------------------------------ *
 * Floating values inside a zoned series
 *
 * The regression these guard: a value with no TZID and no trailing Z used to be
 * read as the *viewer's* zone, not the series'. The exclusion set and the
 * override map were then keyed on instants in a frame the calendar never named,
 * while the instances they had to match were keyed on the master's — so a
 * cancelled meeting came back and a moved one rendered twice, at a different
 * count for every viewer.
 * ------------------------------------------------------------------ */

/** Expand the same fixture in four zones and return one number per zone. */
function acrossZones(lines, project) {
  const zones = [NY, 'Europe/London', 'UTC', 'Asia/Tokyo'];
  return zones.map((tz) => [tz, project(expandFixture(lines, { tzid: tz }))]);
}

test('a floating EXDATE is read in the series zone, so it cancels for every viewer', () => {
  const lines = vevent(
    'UID:float-exdate',
    'DTSTART;TZID=America/New_York:20260810T140000',
    'DTEND;TZID=America/New_York:20260810T150000',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE:20260811T140000', // no TZID: floating, but plainly the series' own 14:00
    'SUMMARY:Daily',
  );
  for (const [tz, count] of acrossZones(lines, (evs) => evs.length)) {
    assert.equal(count, 2, `${tz} must lose the 11th, same as the calendar's own zone`);
  }
  const inTokyo = expandFixture(lines, { tzid: 'Asia/Tokyo' });
  assert.deepEqual(
    starts(inTokyo).map((s) => s.slice(0, 10)),
    ['2026-08-11', '2026-08-13'],
    'the two survivors are the 10th and the 12th in New York, shown in Tokyo',
  );
});

test('a floating RECURRENCE-ID replaces its instance rather than ghosting beside it', () => {
  const lines = [
    ...vevent(
      'UID:float-rid',
      'DTSTART;TZID=America/New_York:20260811T140000',
      'DTEND;TZID=America/New_York:20260811T150000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:Weekly 1:1',
    ),
    ...vevent(
      'UID:float-rid',
      'RECURRENCE-ID:20260818T140000', // floating
      'DTSTART;TZID=America/New_York:20260818T163000',
      'DTEND;TZID=America/New_York:20260818T173000',
      'SUMMARY:Weekly 1:1 (moved)',
    ),
  ];
  for (const [tz, count] of acrossZones(lines, (evs) => evs.length)) {
    assert.equal(count, 3, `${tz} must show three instances, not the moved one plus its ghost`);
  }
  const inLondon = expandFixture(lines, { tzid: 'Europe/London' });
  assert.deepEqual(starts(inLondon), [
    '2026-08-11T19:00:00+01:00',
    '2026-08-18T21:30:00+01:00',
    '2026-08-25T19:00:00+01:00',
  ]);
  assert.equal(inLondon[1].title, 'Weekly 1:1 (moved)');
  assert.equal(inLondon[1].recurrenceId, '2026-08-18T19:00:00+01:00', 'identity stays with the original slot');
});

test('a UTC master with a floating RECURRENCE-ID matches, in its own zone included', () => {
  // This variant needs no timezone mismatch at all: the floating value was
  // anchored to the viewer while the instances were anchored to UTC, so it
  // ghosted everywhere.
  const lines = [
    ...vevent(
      'UID:float-rid-utc',
      'DTSTART:20260811T180000Z',
      'DTEND:20260811T190000Z',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:Sync',
    ),
    ...vevent(
      'UID:float-rid-utc',
      'RECURRENCE-ID:20260818T180000',
      'DTSTART:20260818T203000Z',
      'DTEND:20260818T213000Z',
      'SUMMARY:Sync (moved)',
    ),
  ];
  for (const [tz, count] of acrossZones(lines, (evs) => evs.length)) {
    assert.equal(count, 3, `${tz} must show three instances`);
  }
  const inUtc = expandFixture(lines, { tzid: 'UTC' });
  assert.equal(inUtc[1].startsAt, '2026-08-18T20:30:00+00:00');
  assert.equal(inUtc[1].title, 'Sync (moved)');
});

test('a floating UNTIL ends the series on the same day for every viewer', () => {
  // UNTIL is an RRULE part and can never carry a TZID, so a value with no
  // trailing Z is floating by construction — a spelling real exporters emit.
  const lines = vevent(
    'UID:float-until',
    'DTSTART;TZID=America/New_York:20260803T090000',
    'RRULE:FREQ=WEEKLY;UNTIL=20260831T090000',
    'SUMMARY:Mondays',
  );
  for (const [tz, days] of acrossZones(lines, (evs) => starts(evs).map((s) => s.slice(0, 10)))) {
    assert.equal(days.length, 5, `${tz} must keep all five Mondays, the last one included`);
  }
  assert.deepEqual(
    starts(expandFixture(lines, { tzid: 'Europe/Berlin' })).map((s) => s.slice(0, 10)),
    ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'],
  );
});

/* ------------------------------------------------------------------ *
 * RANGE=THISANDFUTURE
 * ------------------------------------------------------------------ */

test('RANGE=THISANDFUTURE moves the instance it names and every one after it', () => {
  // "This and all following events": the override states the new shape once and
  // the tail of the series takes both its displacement and its properties. It
  // used to be parsed as an ordinary single-instance override, so exactly one
  // occurrence moved and every later one kept a time that no longer existed —
  // indistinguishable, on the board, from a correct row.
  const events = expandFixture([
    ...vevent(
      'UID:taf-1',
      'DTSTART;TZID=America/New_York:20260819T150000',
      'DTEND;TZID=America/New_York:20260819T160000',
      'RRULE:FREQ=WEEKLY;COUNT=5',
      'LOCATION:Room A',
      'SUMMARY:Weekly',
    ),
    ...vevent(
      'UID:taf-1',
      'RECURRENCE-ID;TZID=America/New_York;RANGE=THISANDFUTURE:20260902T150000',
      'DTSTART;TZID=America/New_York:20260902T170000',
      'DTEND;TZID=America/New_York:20260902T180000',
      'LOCATION:Room B',
      'SUMMARY:Weekly (moved)',
    ),
  ]);

  assert.equal(events.length, 5, 'the range replaces instances, it does not add any');
  assert.deepEqual(starts(events), [
    '2026-08-19T15:00:00-04:00',
    '2026-08-26T15:00:00-04:00',
    '2026-09-02T17:00:00-04:00',
    '2026-09-09T17:00:00-04:00',
    '2026-09-16T17:00:00-04:00',
  ]);
  assert.deepEqual(
    events.map((e) => e.location),
    ['Room A', 'Room A', 'Room B', 'Room B', 'Room B'],
    'a permanent room change lands on the whole tail, not on one instance',
  );
  assert.deepEqual(
    events.map((e) => e.endsAt.slice(11, 16)),
    ['16:00', '16:00', '18:00', '18:00', '18:00'],
  );
  assert.deepEqual(
    events.map((e) => e.recurrenceId),
    [
      '2026-08-19T15:00:00-04:00',
      '2026-08-26T15:00:00-04:00',
      '2026-09-02T15:00:00-04:00',
      '2026-09-09T15:00:00-04:00',
      '2026-09-16T15:00:00-04:00',
    ],
    'identity stays with the original slots so rows are updated, not duplicated',
  );
});

test('an override without RANGE still moves exactly one instance', () => {
  // The counterweight: RANGE defaults to the single instance, and the three
  // shipped calendar services never emit it at all.
  const events = expandFixture([
    ...vevent(
      'UID:taf-2',
      'DTSTART;TZID=America/New_York:20260819T150000',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'SUMMARY:Weekly',
    ),
    ...vevent(
      'UID:taf-2',
      'RECURRENCE-ID;TZID=America/New_York:20260902T150000',
      'DTSTART;TZID=America/New_York:20260902T170000',
      'SUMMARY:Weekly (this one only)',
    ),
  ]);
  assert.deepEqual(
    starts(events).map((s) => s.slice(11, 16)),
    ['15:00', '15:00', '17:00', '15:00'],
  );
});

test('a THISANDFUTURE displacement is a wall-clock move, so it survives a DST change', () => {
  // The series is New York's, the viewer is London's, and US and UK DST end on
  // different weekends — an instant-shaped shift would drift by an hour.
  const events = expandFixture(
    [
      ...vevent(
        'UID:taf-3',
        'DTSTART;TZID=America/New_York:20261020T090000',
        'RRULE:FREQ=WEEKLY;COUNT=4',
        'SUMMARY:Standup',
      ),
      ...vevent(
        'UID:taf-3',
        'RECURRENCE-ID;TZID=America/New_York;RANGE=THISANDFUTURE:20261027T090000',
        'DTSTART;TZID=America/New_York:20261027T100000',
        'SUMMARY:Standup (an hour later)',
      ),
    ],
    { tzid: 'Europe/London' },
  );
  const inNewYork = events.map((e) => new Date(e.startsAt).toLocaleTimeString('en-GB', { timeZone: NY, hour12: false }));
  assert.deepEqual(inNewYork, ['09:00:00', '10:00:00', '10:00:00', '10:00:00'], 'the New York wall clock is what moved');
});

test('a non-recurring event has a null recurrenceId', () => {
  const [ev] = expandFixture(
    vevent('UID:single-1', 'DTSTART;TZID=America/New_York:20260811T140000', 'SUMMARY:One-off'),
  );
  assert.equal(ev.recurrenceId, null);
});

/* ------------------------------------------------------------------ *
 * Runaway and malformed input
 * ------------------------------------------------------------------ */

test('an unbounded rule is capped at max and returns promptly', () => {
  const started = Date.now();
  const events = parseICS_toEvents(
    ics(
      ...vevent(
        'UID:runaway-1',
        'DTSTART;TZID=America/New_York:20260101T090000',
        'RRULE:FREQ=DAILY;INTERVAL=0',
        'SUMMARY:Forever',
      ),
    ),
    { tzid: NY, max: 25 }, // no window at all: only the cap can stop this
  );
  assert.equal(events.length, 25);
  assert.ok(Date.now() - started < 3000, 'capping must be cheap');
  assertCarriesOffset(events);
});

test('a rule that can never match terminates instead of spinning', () => {
  const started = Date.now();
  const events = parseICS_toEvents(
    ics(
      ...vevent(
        'UID:runaway-2',
        'DTSTART;TZID=America/New_York:20260101T090000',
        'RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31',
        'SUMMARY:31 February',
      ),
    ),
    { tzid: NY, max: 500 },
  );
  assert.equal(events.length, 1, 'only DTSTART itself survives');
  assert.ok(Date.now() - started < 5000, 'the empty-period fuse must trip fast');
});

test('a huge BYDAY list cannot buy seconds of expansion per sweep', () => {
  // The period fuses bound how many periods run, not what one period costs.
  // This rule buys the most periods a document can: entries that never match
  // (there is no 99th Monday of a year), a DTSTART two thousand years back so
  // every year up to the window is walked, and a COUNT — which disables the
  // fast-forward jump — so each of those years re-scans the whole list. At
  // 100,000 entries that was ~19 seconds of frozen event loop, well inside the
  // subscribed-calendar byte cap, on every sweep.
  const started = Date.now();
  const events = parseICS_toEvents(
    ics(
      ...vevent(
        'UID:runaway-3',
        'DTSTART;TZID=America/New_York:00010101T090000',
        `RRULE:FREQ=YEARLY;COUNT=5;BYDAY=${Array(100_000).fill('99MO').join(',')}`,
        'SUMMARY:Nothing, expensively',
      ),
    ),
    { from: '2026-08-20', to: '2026-10-26', tzid: NY },
  );
  assert.equal(events.length, 0, 'nothing matches, and DTSTART itself is outside the window');
  assert.ok(Date.now() - started < 3000, 'the scan budget must trip fast');
});

test('an unsupported FREQ degrades to a single occurrence', () => {
  const events = expandFixture(
    vevent(
      'UID:bad-freq',
      'DTSTART;TZID=America/New_York:20260811T140000',
      'RRULE:FREQ=FORTNIGHTLY;COUNT=99',
      'SUMMARY:Nonsense',
    ),
  );
  assert.equal(events.length, 1);
});

test('garbage in does not throw', () => {
  for (const junk of ['', 'not a calendar at all', 'BEGIN:VCALENDAR', 'END:VEVENT\r\nBEGIN:VEVENT']) {
    assert.deepEqual(parseICS_toEvents(junk, { tzid: NY }), []);
  }
  const { vevents } = parseICS(ics(...vevent('UID:no-start', 'SUMMARY:Missing DTSTART')));
  assert.deepEqual(vevents, [], 'an event with no usable DTSTART is dropped, not half-built');
});

test('max caps the total across several events, cutting the window and not a calendar', () => {
  const events = parseICS_toEvents(
    ics(
      ...vevent('UID:cap-a', 'DTSTART;VALUE=DATE:20260101', 'RRULE:FREQ=DAILY;COUNT=100', 'SUMMARY:A'),
      ...vevent('UID:cap-b', 'DTSTART;VALUE=DATE:20260101', 'RRULE:FREQ=DAILY;COUNT=100', 'SUMMARY:B'),
    ),
    { from: '2026-01-01', to: '2027-01-01', tzid: NY, max: 30 },
  );
  assert.equal(events.length, 30);
  // This used to assert only the total, which is also what the starvation bug
  // produced: A took all thirty and B was absent from the calendar entirely.
  assert.deepEqual(
    ['cap-a', 'cap-b'].map((uid) => events.filter((e) => e.uid === uid).length),
    [15, 15],
    'both series survive; the budget buys fewer days, not fewer meetings',
  );
  assert.deepEqual(starts(events).at(-1), '2026-01-15', 'what is missing is the far end of the window');
});

test('max keeps the earliest instances, not whichever meetings the file lists first', () => {
  // Reproduces the shared-calendar case: `expandOne` returned the moment the
  // shared array reached `max`, groups were walked in document order, and the
  // sort ran afterwards — so on a file of 40 weekday-recurring meetings the
  // first 31 UIDs took the whole 1500 and meetings 31–40 vanished outright,
  // deterministically, the same UIDs every sweep. Twelve daily meetings at
  // distinct hours and a cap of 24 is the same shape: the honest answer is
  // every meeting on the first two days.
  const lines = [];
  for (let i = 0; i < 12; i++) {
    lines.push(
      ...vevent(
        `UID:starve-${i}`,
        `DTSTART;TZID=America/New_York:20260105T${String(8 + i).padStart(2, '0')}0000`,
        'RRULE:FREQ=DAILY;COUNT=40',
        `SUMMARY:Meeting ${i}`,
      ),
    );
  }
  const events = parseICS_toEvents(ics(...lines), {
    from: '2026-01-05T00:00:00-05:00',
    to: '2026-03-01T00:00:00-05:00',
    tzid: NY,
    max: 24,
  });
  assertCarriesOffset(events);
  assert.equal(events.length, 24);
  assert.equal(new Set(events.map((e) => e.uid)).size, 12, 'every meeting is represented, none starved');
  assert.deepEqual(
    [...new Set(starts(events).map((s) => s.slice(0, 10)))],
    ['2026-01-05', '2026-01-06'],
    'the cut falls at the end of the window, so what is shown is the next two days in full',
  );
});

/* ------------------------------------------------------------------ *
 * VTIMEZONE fallback
 * ------------------------------------------------------------------ */

const WINDOWS_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Eastern Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16011101T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010308T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

test('an embedded VTIMEZONE resolves a TZID that Intl rejects', () => {
  const summer = parseICS_toEvents(
    ics(
      ...WINDOWS_VTIMEZONE,
      ...vevent('UID:vtz-summer', 'DTSTART;TZID=Eastern Standard Time:20260811T140000', 'SUMMARY:Summer'),
    ),
    { from: '2026-01-01', to: '2027-01-01', tzid: 'UTC' },
  );
  const winter = parseICS_toEvents(
    ics(
      ...WINDOWS_VTIMEZONE,
      ...vevent('UID:vtz-winter', 'DTSTART;TZID=Eastern Standard Time:20260115T140000', 'SUMMARY:Winter'),
    ),
    { from: '2026-01-01', to: '2027-01-01', tzid: 'UTC' },
  );

  assertCarriesOffset(summer);
  assertCarriesOffset(winter);
  assert.equal(summer[0].startsAt, '2026-08-11T18:00:00+00:00', 'August is -04:00 under the embedded rules');
  assert.equal(winter[0].startsAt, '2026-01-15T19:00:00+00:00', 'January is -05:00');
});

test('parseICS exposes the VTIMEZONE map and the calendar name', () => {
  const { vtimezones, calname, vevents } = parseICS(
    ics(
      'X-WR-CALNAME:Nemo — Work',
      ...WINDOWS_VTIMEZONE,
      ...vevent('UID:vtz-map', 'DTSTART;TZID=Eastern Standard Time:20260811T140000', 'SUMMARY:X'),
    ),
  );
  assert.equal(calname, 'Nemo — Work');
  assert.equal(vevents[0].calendarName, 'Nemo — Work');
  assert.ok(vtimezones.has('Eastern Standard Time'));
  assert.equal(vtimezones.get('Eastern Standard Time').observances.length, 2);
});

test('an unresolvable TZID degrades to UTC rather than throwing', () => {
  const events = expandFixture(
    vevent('UID:vtz-missing', 'DTSTART;TZID=Mars/Olympus:20260811T140000', 'SUMMARY:Unknown zone'),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].startsAt, '2026-08-11T10:00:00-04:00', '14:00 read as UTC, shown in New York');
});

/* ------------------------------------------------------------------ *
 * Window, ordering and event fields
 * ------------------------------------------------------------------ */

test('the window keeps events that overlap it and drops the rest', () => {
  const fixture = ics(
    ...vevent(
      'UID:window-1',
      'DTSTART;TZID=America/New_York:20260811T230000',
      'DTEND;TZID=America/New_York:20260812T010000',
      'SUMMARY:Straddles midnight',
    ),
    ...vevent('UID:window-2', 'DTSTART;TZID=America/New_York:20260901T090000', 'SUMMARY:Far future'),
  );
  const events = parseICS_toEvents(fixture, {
    from: '2026-08-12T00:00:00-04:00',
    to: '2026-08-13T00:00:00-04:00',
    tzid: NY,
  });
  assert.deepEqual(
    events.map((e) => e.uid),
    ['window-1'],
    'an event already running when the window opens still counts',
  );
});

test('results are ordered by true instant across calendars and zones', () => {
  const events = parseICS_toEvents(
    ics(
      ...vevent('UID:order-a', 'DTSTART;TZID=Europe/London:20260811T160000', 'SUMMARY:London 4pm'),
      ...vevent('UID:order-b', 'DTSTART;TZID=America/New_York:20260811T090000', 'SUMMARY:NY 9am'),
      ...vevent('UID:order-c', 'DTSTART:20260811T200000Z', 'SUMMARY:8pm UTC'),
    ),
    { from: '2026-08-01', to: '2026-09-01', tzid: NY },
  );
  // 09:00 EDT = 13:00Z beats 16:00 BST = 15:00Z, which beats 20:00Z.
  assert.deepEqual(
    events.map((e) => e.uid),
    ['order-b', 'order-a', 'order-c'],
  );
  assert.deepEqual(starts(events), [
    '2026-08-11T09:00:00-04:00',
    '2026-08-11T11:00:00-04:00',
    '2026-08-11T16:00:00-04:00',
  ]);
});

test('organizer, attendees and rsvp are carried through', () => {
  const lines = vevent(
    'UID:people-1',
    'DTSTART;TZID=America/New_York:20260811T140000',
    'ORGANIZER;CN=Marcus Reyes:mailto:marcus@riverstone.test',
    'ATTENDEE;CN=Nemo Hale;PARTSTAT=NEEDS-ACTION:mailto:nemo@northgate.test',
    'ATTENDEE;CN=Jane Doe;PARTSTAT=ACCEPTED:mailto:jane@riverstone.test',
    'STATUS:CONFIRMED',
    'SUMMARY:Kickoff',
  );
  const [ev] = expandFixture(lines, { email: 'NEMO@northgate.test' });
  assert.equal(ev.organizer, 'Marcus Reyes <marcus@riverstone.test>');
  assert.equal(ev.status, 'CONFIRMED');
  assert.equal(ev.rsvp, 'NEEDS-ACTION', 'rsvp is mine, matched case-insensitively');
  assert.deepEqual(ev.attendees, [
    { name: 'Nemo Hale', email: 'nemo@northgate.test', rsvp: 'NEEDS-ACTION' },
    { name: 'Jane Doe', email: 'jane@riverstone.test', rsvp: 'ACCEPTED' },
  ]);
});

test('only http, https and mailto URLs escape the parser', () => {
  const [good] = expandFixture(
    vevent('UID:url-1', 'DTSTART;VALUE=DATE:20260811', 'URL:https://meet.example.test/abc', 'SUMMARY:Good'),
  );
  assert.equal(good.url, 'https://meet.example.test/abc');

  for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
    const [ev] = expandFixture(
      vevent('UID:url-2', 'DTSTART;VALUE=DATE:20260811', `URL:${hostile}`, 'SUMMARY:Hostile'),
    );
    assert.equal(ev.url, null, `${hostile} must not survive`);
  }
});

test('expand accepts hand-built VEvents and honours max', () => {
  const { vevents, vtimezones } = parseICS(
    ics(
      ...vevent(
        'UID:direct-1',
        'DTSTART;TZID=America/New_York:20260811T140000',
        'RRULE:FREQ=DAILY;COUNT=50',
        'SUMMARY:Direct',
      ),
    ),
  );
  const events = expand(vevents, { from: '2026-08-01', to: '2026-12-01', max: 7, tzid: NY, vtimezones });
  assert.equal(events.length, 7);
  assertCarriesOffset(events);
});
