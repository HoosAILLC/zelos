/**
 * test/ui.test.mjs — the parts of the UI that can be wrong without anyone
 * noticing until a chip is in the wrong place.
 *
 * Three groups:
 *
 *  1. **Time parity.** The browser cannot import core/time.mjs (the server
 *     serves only ui/ and assets/), so ui/lib/time.js carries a copy of its
 *     display half. This suite imports BOTH and asserts they agree across a
 *     corpus of ISO strings, offsets and DST boundaries. Edit one and not the
 *     other and this goes red — which is the whole reason the copy is allowed
 *     to exist.
 *  2. **Layout maths.** Chip spans, overlap packing and month-cell ordering are
 *     pure functions in ui/lib/format.js, so they are testable without a DOM,
 *     and they are exactly where a calendar silently lies.
 *  3. **Source guards.** No innerHTML anywhere in ui/, no remote URL in the
 *     shipped page, no inline script (the server's CSP has no 'unsafe-inline'
 *     for scripts). These are product guarantees, not style preferences.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

/**
 * A module specifier for a file on disk.
 *
 * import() takes a URL, not a path, and on POSIX an absolute path happens to
 * be an acceptable one. On Windows it is not: 'C:\\…' parses as a URL whose
 * scheme is 'c', and every dynamic import in this file threw at load — which
 * is why the whole file failed on that platform rather than any one test.
 */
const fileUrl = (...parts) => pathToFileURL(path.join(...parts)).href;

/**
 * How many rows a month cell paints, read out of the view that owns it.
 *
 * It is not exported — it is a private layout constant of ui/views/calendar.js
 * and has no business being one — so the boundary test below used to keep its
 * own copy. A constant restated in a second file is a constant that can drift,
 * and this one is load-bearing prose: conflictsFirst's docstring in
 * ui/lib/format.js says a day with "three or more" all-day entries buries a
 * clash, which is only true while this number is 3. A parser that cannot find
 * it fails loudly rather than falling back to a guess, for the same reason
 * test/router-table.mjs does: a silent default is how the copy got stale.
 */
function monthVisible() {
  const src = fs.readFileSync(path.join(UI, 'views/calendar.js'), 'utf8');
  const m = /\nconst MONTH_VISIBLE = (\d+);/.exec(src);
  if (!m) {
    throw new Error('ui/views/calendar.js no longer declares MONTH_VISIBLE where this reader looks — '
      + 'fix the reader, do not restate the number');
  }
  return Number(m[1]);
}

const core = await import(fileUrl(ROOT, 'core/time.mjs'));
const ui = await import(fileUrl(UI, 'lib/time.js'));
const fmt = await import(fileUrl(UI, 'lib/format.js'));

/* ------------------------------------------------------------ 1. parity */

const CORPUS = [
  '2026-08-11T14:00:00-04:00',
  '2026-08-11T14:00:00+05:30',
  '2026-08-11T00:00:00Z',
  '2026-08-11T23:59:00-08:00',
  '2026-01-01T00:30:00+13:00',
  '2026-03-08T02:30:00-05:00',   // US DST spring-forward morning
  '2026-11-01T01:30:00-04:00',   // fall-back hour
  '2026-12-31T23:00:00+01:00',
  '2026-08-11',                  // all-day, no time part
  '2026-02-29',                  // not a real date; must not throw
  '2026-08-11T14:00',            // no seconds
  '2026-08-11 14:00:00-04:00',   // space separator
  'nonsense',
  '',
];

test('ui/lib/time.js mirrors core/time.mjs — wallClock', () => {
  for (const iso of CORPUS) {
    assert.deepEqual(ui.wallClock(iso), core.wallClock(iso), iso);
  }
  assert.equal(ui.wallClock(null), core.wallClock(null));
  assert.equal(ui.wallClock(undefined), core.wallClock(undefined));
});

test('ui/lib/time.js mirrors core/time.mjs — derived readings', () => {
  for (const iso of CORPUS) {
    assert.equal(ui.dayKey(iso), core.dayKey(iso), `dayKey ${iso}`);
    assert.equal(ui.minutesIntoDay(iso), core.minutesIntoDay(iso), `minutesIntoDay ${iso}`);
    assert.equal(ui.instant(iso), core.instant(iso), `instant ${iso}`);
    assert.equal(ui.formatTime(iso), core.formatTime(iso), `formatTime ${iso}`);
    assert.equal(ui.formatDay(iso), core.formatDay(iso), `formatDay ${iso}`);
  }
});

test('ui/lib/time.js mirrors core/time.mjs — key arithmetic', () => {
  const keys = ['2026-01-01', '2026-02-28', '2026-03-01', '2026-08-11', '2026-12-31', 'bad'];
  for (const key of keys) {
    assert.equal(ui.weekdayOfKey(key), core.weekdayOfKey(key), `weekdayOfKey ${key}`);
    assert.equal(ui.startOfWeekKey(key), core.startOfWeekKey(key), `startOfWeekKey ${key}`);
    for (const n of [-31, -7, -1, 0, 1, 7, 45]) {
      assert.equal(ui.addDaysToKey(key, n), core.addDaysToKey(key, n), `addDaysToKey ${key} ${n}`);
    }
    for (const other of keys) {
      assert.equal(ui.daysBetweenKeys(key, other), core.daysBetweenKeys(key, other), `daysBetweenKeys ${key} ${other}`);
    }
  }
});

test('ui/lib/time.js mirrors core/time.mjs — offsets, zoning and deltas', () => {
  const at = new Date('2026-08-11T18:00:00Z');
  const winter = new Date('2026-01-11T18:00:00Z');
  for (const tz of ['America/New_York', 'Europe/London', 'Asia/Kolkata', 'UTC', 'Not/AZone']) {
    assert.equal(ui.offsetFor(tz, at), core.offsetFor(tz, at), `offsetFor ${tz}`);
    assert.equal(ui.offsetFor(tz, winter), core.offsetFor(tz, winter), `offsetFor winter ${tz}`);
    assert.equal(ui.toZonedISO(at, tz), core.toZonedISO(at, tz), `toZonedISO ${tz}`);
  }
  for (const raw of ['+05:30', '-0800', 'Z', '', null, 'junk']) {
    assert.equal(ui.offsetMinutes(raw), core.offsetMinutes(raw), `offsetMinutes ${raw}`);
  }
  const now = Date.parse('2026-08-11T12:00:00Z');
  for (const iso of CORPUS) {
    assert.equal(ui.humanDelta(iso, now), core.humanDelta(iso, now), `humanDelta ${iso}`);
  }
  assert.equal(ui.monthName(8), core.monthName(8));
  assert.equal(ui.dayName(0), core.dayName(0));
  assert.equal(ui.localTimezone(), core.localTimezone());
});

test('an offset in the string is read, never re-expressed in the local zone', () => {
  // 2pm in New York is 2pm on that calendar, wherever this test runs.
  const iso = '2026-08-11T14:00:00-04:00';
  assert.equal(ui.minutesIntoDay(iso), 14 * 60);
  assert.equal(ui.dayKey(iso), '2026-08-11');
  // ...and 1am in Auckland is still the 12th there, not the 11th here.
  assert.equal(ui.dayKey('2026-08-12T01:00:00+12:00'), '2026-08-12');
});

/* -------------------------------------------------------- 2. layout maths */

const day = (h, m = 0) => `2026-08-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`;

test('eventSpanOnDay clamps to the day it is asked about', () => {
  const ev = { starts_at: day(9, 30), ends_at: day(11, 0), all_day: false };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 570, end: 660, allDay: false });
  assert.equal(fmt.eventSpanOnDay(ev, '2026-08-12'), null);
});

test('eventSpanOnDay splits an event that runs through midnight', () => {
  const ev = {
    starts_at: '2026-08-11T22:30:00-04:00',
    ends_at: '2026-08-12T01:30:00-04:00',
    all_day: false,
  };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 1350, end: 1440, allDay: false });
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-12'), { start: 0, end: 90, allDay: false });
});

test('an event ending exactly at midnight does not appear on the next day', () => {
  const ev = {
    starts_at: '2026-08-11T22:00:00-04:00',
    ends_at: '2026-08-12T00:00:00-04:00',
    all_day: false,
  };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 1320, end: 1440, allDay: false });
  assert.equal(fmt.eventSpanOnDay(ev, '2026-08-12'), null);
});

test('a zero-length event still gets a visible span', () => {
  const ev = { starts_at: day(9), ends_at: day(9), all_day: false };
  const span = fmt.eventSpanOnDay(ev, '2026-08-11');
  assert.ok(span.end > span.start);
});

test('all-day events own the whole column', () => {
  const ev = { starts_at: '2026-08-11', ends_at: '2026-08-12', all_day: true };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 0, end: 1440, allDay: true });
});

/**
 * The end of an all-day event is RFC 5545's exclusive DTEND — the day after the
 * last one covered — so a one-day holiday must not paint across two columns.
 */
test('an all-day event stops before its exclusive end date', () => {
  const oneDay = { starts_at: '2026-08-11', ends_at: '2026-08-12', all_day: true };
  assert.equal(fmt.eventSpanOnDay(oneDay, '2026-08-12'), null);

  const fiveDays = { starts_at: '2026-08-07', ends_at: '2026-08-12', all_day: true };
  const covered = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']
    .filter((key) => fmt.eventSpanOnDay(fiveDays, key));
  assert.deepEqual(covered, ['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11']);

  // A calendar that writes DTEND == DTSTART is malformed, but it still means
  // "this one day" — it must not vanish.
  const degenerate = { starts_at: '2026-08-11', ends_at: '2026-08-11', all_day: true };
  assert.deepEqual(fmt.eventSpanOnDay(degenerate, '2026-08-11'), { start: 0, end: 1440, allDay: true });
});

test('packColumns: non-overlapping events all take the full width', () => {
  const packed = fmt.packColumns([
    { start: 540, end: 600 },
    { start: 600, end: 660 },
    { start: 700, end: 730 },
  ]);
  assert.deepEqual(packed.map((p) => [p.col, p.cols]), [[0, 1], [0, 1], [0, 1]]);
});

test('packColumns: a cluster is divided only among its own members', () => {
  // Two overlapping in the morning, two overlapping in the afternoon. Four
  // quarter-width columns would be the bug this exists to prevent.
  const packed = fmt.packColumns([
    { start: 540, end: 660, id: 'a' },
    { start: 600, end: 700, id: 'b' },
    { start: 840, end: 900, id: 'c' },
    { start: 850, end: 950, id: 'd' },
  ]);
  const by = Object.fromEntries(packed.map((p) => [p.id, p]));
  assert.deepEqual([by.a.col, by.a.cols], [0, 2]);
  assert.deepEqual([by.b.col, by.b.cols], [1, 2]);
  assert.deepEqual([by.c.col, by.c.cols], [0, 2]);
  assert.deepEqual([by.d.col, by.d.cols], [1, 2]);
});

test('packColumns: a freed column is reused before a new one is opened', () => {
  const packed = fmt.packColumns([
    { start: 0, end: 60, id: 'a' },
    { start: 30, end: 90, id: 'b' },
    { start: 60, end: 120, id: 'c' },   // a has ended: c belongs in column 0
  ]);
  const by = Object.fromEntries(packed.map((p) => [p.id, p]));
  assert.equal(by.c.col, 0);
  assert.equal(by.c.cols, 2);
});

test('packColumns: a triple booking gets three columns', () => {
  const packed = fmt.packColumns([
    { start: 660, end: 720 },
    { start: 670, end: 730 },
    { start: 680, end: 700 },
  ]);
  assert.deepEqual(packed.map((p) => p.col).sort(), [0, 1, 2]);
  assert.ok(packed.every((p) => p.cols === 3));
});

test('conflictsFirst puts a clash above a quiet earlier event', () => {
  const ordered = fmt.conflictsFirst([
    { start: 480, end: 540, id: 'early-and-quiet' },
    { start: 660, end: 720, id: 'clash-a' },
    { start: 670, end: 700, id: 'clash-b' },
    { start: 900, end: 960, id: 'late-and-quiet' },
  ]);
  assert.deepEqual(ordered.slice(0, 2).map((e) => e.id), ['clash-a', 'clash-b']);
  assert.equal(ordered[0].conflict, true);
  assert.equal(ordered[2].conflict, false);
  // Truncating to three rows must still show both halves of the clash.
  assert.ok(ordered.slice(0, 3).filter((e) => e.conflict).length === 2);
});

test('conflictsFirst leaves a quiet day in time order', () => {
  const ordered = fmt.conflictsFirst([
    { start: 900, end: 960, id: 'c' },
    { start: 480, end: 540, id: 'a' },
    { start: 660, end: 700, id: 'b' },
  ]);
  assert.deepEqual(ordered.map((e) => e.id), ['a', 'b', 'c']);
});

test('an all-day event is not a clash with the day it fills', () => {
  // eventSpanOnDay hands an all-day event minutes 0–1440, so in the overlap
  // pass it overlapped everything: one birthday flagged every event on the day
  // and the month cell painted "clash" over a day where nothing clashes.
  const ordered = fmt.conflictsFirst([
    { start: 0, end: 1440, allDay: true, id: 'holiday' },
    { start: 540, end: 555, id: 'standup' },
  ]);
  assert.deepEqual(ordered.map((e) => e.conflict), [false, false]);
  assert.equal(ordered.some((e) => e.conflict), false, 'nothing overlaps; the cell must not flag one');
});

test('a holiday does not bury the double booking underneath it', () => {
  // The harm is the inverse of the obvious one. When the 0–1440 span made
  // every entry conflict:true the tiebreak went to zero, the sort collapsed to
  // plain start order, and the genuine clash fell behind "+N more". Measured
  // on the shipped code: the three visible rows were HOLIDAY, 8am, 9am.
  const day = [
    { start: 0, end: 1440, allDay: true, id: 'holiday' },
    { start: 480, end: 540, id: '8am' },
    { start: 540, end: 600, id: '9am' },
    { start: 660, end: 720, id: 'clash-a' },
    { start: 670, end: 700, id: 'clash-b' },
  ];
  const ordered = fmt.conflictsFirst(day);
  assert.deepEqual(ordered.slice(0, 3).map((e) => e.id), ['holiday', 'clash-a', 'clash-b']);
  // ...and the all-day entry keeps the top of the cell, where a day-long thing
  // belongs, without claiming to collide with anything.
  assert.equal(ordered[0].allDay, true);
  assert.equal(ordered[0].conflict, false);
});

test('three all-day banners do bury the clash, and the cell badge is what stops it going quiet', () => {
  // The boundary of what conflictsFirst promises, pinned so the docstring above
  // it cannot drift back into promising more. All-day entries sort above
  // everything and MONTH_VISIBLE is 3, so a birthday, a holiday and a PTO day
  // fill the cell and the double booking really is behind "+N more". The
  // sentence that used to sit here — "a conflict cannot hide behind +4" — was
  // false for exactly this day.
  //
  // What keeps that honest is monthCell deriving `has-conflict` from
  // `spans.some(s => s.conflict)` over the WHOLE day rather than the visible
  // slice (ui/views/calendar.js:572), which is the reader this flag is for. If
  // that ever narrows to the visible three, this day goes silent, and the
  // second half of this test is what says so.
  const day = [
    { start: 0, end: 1440, allDay: true, id: 'birthday' },
    { start: 0, end: 1440, allDay: true, id: 'holiday' },
    { start: 0, end: 1440, allDay: true, id: 'pto' },
    { start: 480, end: 510, id: '8am' },
    { start: 540, end: 600, id: 'clash-a' },
    { start: 570, end: 630, id: 'clash-b' },
  ];
  const ordered = fmt.conflictsFirst(day);
  // Read, not restated. This line was `const MONTH_VISIBLE = 3;` with
  // `// ui/views/calendar.js:564` beside it — a number owned by another file,
  // copied here next to a line reference that had already drifted two lines.
  // Widening the cell to four rows would have left this test green while the
  // sentence it exists to protect — "three or more", in ui/lib/format.js's
  // docstring for conflictsFirst — became false.
  const MONTH_VISIBLE = monthVisible();
  assert.deepEqual(ordered.slice(0, MONTH_VISIBLE).map((e) => e.id), ['birthday', 'holiday', 'pto'],
    `the month cell shows ${MONTH_VISIBLE} rows, so three banners no longer fill it — `
    + 'conflictsFirst\'s docstring says "three or more" in as many words and now needs rewriting with it');
  assert.equal(ordered.slice(0, MONTH_VISIBLE).some((e) => e.conflict), false,
    'neither half of the clash is visible — which is the thing the docstring must not deny');
  assert.deepEqual(ordered.filter((e) => e.conflict).map((e) => e.id), ['clash-a', 'clash-b'],
    'the flags are still right; it is only the truncation that hides them');
  assert.equal(ordered.some((e) => e.conflict), true,
    'the expression monthCell uses for its badge still fires, so the day is marked even when the pair is not shown');
});

/* ----------------------------------------------------- items and wording */

test('carriedFor says nothing until a thing is genuinely stale', () => {
  const today = '2026-08-11';
  assert.equal(fmt.carriedFor({ first_seen: '2026-08-11T09:00:00-04:00' }, today), null);
  assert.equal(fmt.carriedFor({ first_seen: '2026-08-08T09:00:00-04:00' }, today), null); // 3 days
  assert.equal(fmt.carriedFor({ first_seen: '2026-08-07T09:00:00-04:00' }, today), 'carried 4 days');
  assert.equal(fmt.carriedFor({ first_seen: '2026-07-21T09:00:00-04:00' }, today), 'carried 3 weeks');
  assert.equal(fmt.carriedFor({ first_seen: '2026-05-01T09:00:00-04:00' }, today), 'carried 3 months');
  assert.equal(fmt.carriedFor({}, today), null);
});

test('byUrgency: severity, then soonest due, then longest carried', () => {
  const rows = [
    { id: 'low', severity: 0, due_at: null, first_seen: '2026-08-01T00:00:00Z' },
    { id: 'sev3-later', severity: 3, due_at: '2026-08-12T00:00:00Z', first_seen: '2026-08-10T00:00:00Z' },
    { id: 'sev3-sooner', severity: 3, due_at: '2026-08-11T00:00:00Z', first_seen: '2026-08-10T00:00:00Z' },
    { id: 'sev1-old', severity: 1, due_at: null, first_seen: '2026-07-01T00:00:00Z' },
    { id: 'sev1-new', severity: 1, due_at: null, first_seen: '2026-08-09T00:00:00Z' },
  ];
  assert.deepEqual(
    [...rows].sort(fmt.byUrgency).map((r) => r.id),
    ['sev3-sooner', 'sev3-later', 'sev1-old', 'sev1-new', 'low'],
  );
});

test('a dated item beats an undated one at the same severity', () => {
  const dated = { severity: 2, due_at: '2026-08-11T00:00:00Z', first_seen: '2026-08-10T00:00:00Z' };
  const undated = { severity: 2, due_at: null, first_seen: '2026-01-01T00:00:00Z' };
  assert.ok(fmt.byUrgency(dated, undated) < 0);
  assert.ok(fmt.byUrgency(undated, dated) > 0);
});

test('severityOf clamps whatever the model produced', () => {
  assert.equal(fmt.severityOf({ severity: 9 }), 3);
  assert.equal(fmt.severityOf({ severity: -4 }), 0);
  assert.equal(fmt.severityOf({ severity: '2' }), 2);
  assert.equal(fmt.severityOf({ severity: 'urgent!' }), 0);
  assert.equal(fmt.severityOf(null), 0);
});

test('dueLabel is relative near the deadline and absolute far from it', () => {
  const now = Date.parse('2026-08-11T12:00:00Z');
  assert.equal(fmt.dueLabel({ due_at: '2026-08-11T14:00:00Z' }, now), 'due in 2h');
  assert.equal(fmt.dueLabel({ due_at: '2026-08-11T09:00:00Z' }, now), 'due 3h ago');
  assert.match(fmt.dueLabel({ due_at: '2026-08-20T09:00:00-04:00' }, now), /^due Thu, Aug 20/);
  assert.equal(fmt.dueLabel({ due_at: null }, now), '');
  assert.equal(fmt.dueLabel({ due_at: 'not a date' }, now), '');
  assert.equal(fmt.isOverdue({ due_at: '2026-08-11T09:00:00Z' }, now), true);
  assert.equal(fmt.isOverdue({ due_at: '2026-08-11T14:00:00Z' }, now), false);
});

test('every bucket has a label a person can read without decoding', () => {
  for (const bucket of fmt.BUCKETS) {
    assert.equal(typeof fmt.BUCKET_LABEL[bucket], 'string');
    assert.ok(fmt.BUCKET_LABEL[bucket].length > 0, bucket);
    assert.ok(fmt.BUCKET_TAG[bucket].length > 0, bucket);
  }
  // The two the model names badly are the two that matter most.
  assert.equal(fmt.BUCKET_LABEL.waiting, 'They owe you');
  assert.equal(fmt.BUCKET_LABEL.promised, 'You owe them');
});

test('sweepSummary reads as a sentence, and survives a run with no stats', () => {
  assert.equal(
    fmt.sweepSummary({ stats: { messages: 1, events: 2, items: 3, ms: 8_430 } }),
    '1 message · 2 events · 3 items · 8.4s',
  );
  assert.equal(fmt.sweepSummary({ stats: {} }), '');
  assert.equal(fmt.sweepSummary(null), '');
});

/* -------------------------------------------------------- 3. source guards */

function uiFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(UI);
  return out;
}

test('no file in ui/ can put a string into the DOM as markup', () => {
  // Mail is attacker-controlled and so is the model's output. A single
  // innerHTML in this directory is a cross-site scripting hole with a subject
  // line as its payload.
  const banned = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment)\b/;
  for (const file of uiFiles().filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      // The one permitted mention is prose explaining why there is none.
      if (line.includes('innerHTML') && /^\s*(\*|\/\/)/.test(line)) continue;
      assert.ok(!banned.test(line), `${path.relative(ROOT, file)}:${i + 1} ${line.trim()}`);
    }
  }
});

test('the page loads nothing from the network', () => {
  // Zero CDN, works offline, and the server's CSP would refuse it anyway.
  const remote = /(https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9]/i;
  for (const file of uiFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (/^\s*(\*|\/\/|<!--)/.test(line)) continue;      // prose
      if (line.includes('http://www.w3.org/2000/svg')) continue; // an XML namespace, not a fetch
      if (line.includes('hale.example') || line.includes('example.com')) continue; // placeholder copy
      assert.ok(!remote.test(line), `${path.relative(ROOT, file)}:${i + 1} ${line.trim()}`);
    }
  }
});

test('index.html carries no inline script and no inline event handler', () => {
  // The server sends `default-src 'self'` with no script 'unsafe-inline', so an
  // inline script is not merely poor practice here — it silently does nothing.
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'inline <script> block in index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler attribute in index.html');
  assert.match(html, /<script src="\/boot\.js">/);
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test('the meander is drawn, not downloaded', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /--meander:\s*url\("data:image\/svg\+xml/);
  assert.match(css, /mask-image: var\(--meander\)/);
});

test('every disclosure in ui/ hides with [hidden], and the CSS makes that stick', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  // Without this rule any class that sets `display` outranks the UA's
  // [hidden]{display:none} and every collapsed panel is on screen.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('no reveal animation can strand content in a hidden state', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.ok(!/animation-fill-mode:\s*(both|forwards)/.test(css));
  assert.ok(!/opacity:\s*0;[^}]*animation/.test(css));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

/**
 * Both of these were found by driving the running app, and both are silent
 * failures: nothing throws, the page just renders slightly wrong. The guards are
 * on the source because the behaviour they protect needs a layout engine to
 * observe, and a unit test that cannot see one can still keep the mechanism from
 * being reverted to the version that did not work.
 */
test('a clipped calendar chip title is marked as clipped, not cut mid-word', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const chip = /^\.chip-title \{([^}]*)\}/m.exec(css);
  assert.ok(chip, '.chip-title rule is missing');
  // `text-overflow: ellipsis` alone does nothing here: the title wraps, and
  // text-overflow only ever fires on a single line. A wrapped title needs a box
  // clamp or it is cut mid-word with no mark at all.
  assert.match(chip[1], /-webkit-line-clamp:\s*var\(--chip-lines/);
  assert.match(chip[1], /-webkit-box-orient:\s*vertical/);

  const calendar = fs.readFileSync(path.join(UI, 'views/calendar.js'), 'utf8');
  assert.match(calendar, /setProperty\('--chip-lines'/,
    'the line budget must be measured per chip, not copied out of the stylesheet');
});

test('the phone week calendar has exactly one horizontal scroller', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const narrow = /@media \(max-width: 47\.99rem\) \{\s*\n\s*\.cal-grid\.mode-week \{[\s\S]*?\n\}/m.exec(css);
  assert.ok(narrow, 'the narrow week-grid media block is missing');

  // `.cal-scroll` carries `overflow-y: auto` for the 1440-minute body, and CSS
  // Overflow 3 coerces a `visible` on the other axis to `auto` beside it. So
  // `overflow-x: visible` here did not opt the box out of the outer scroller,
  // it made a SECOND one — on a box still at min-width 0 inside a 584px body.
  // Measured in a live Blink at 375px: clientWidth 344 against scrollWidth
  // 584, and dragging the inner scroller to 220 left `.cal-grid` at 0, i.e.
  // 220px of drift between the date header and the time body beneath it.
  assert.ok(!/\.cal-scroll[^{}]*\{[^{}]*overflow-x/.test(narrow[0]),
    '.cal-scroll must not set overflow-x here — next to overflow-y it can only ever be a scroller');

  const sized = /\.cal-grid\.mode-week \.cal-head,[\s\S]*?\{[^{}]*min-width[^{}]*\}/m.exec(narrow[0]);
  assert.ok(sized, 'the min-width group is missing');
  for (const part of ['.cal-head', '.cal-allday', '.cal-scroll', '.cal-body']) {
    assert.ok(sized[0].includes(`.cal-grid.mode-week ${part},`) || sized[0].includes(`.cal-grid.mode-week ${part} {`),
      `${part} must be sized with its siblings, or it drifts out of register with them`);
  }
});

test('the sticky rail re-measures the header instead of trusting the last paint', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  // The rail sticks at `top: var(--topbar-h)`. Nothing repaints on a window
  // resize, so measuring only after a paint leaves that offset stale and the
  // rail slides under the header.
  assert.match(css, /top:\s*var\(--topbar-h\)/);
  assert.match(app, /new ResizeObserver/);
  assert.match(app, /--topbar-h/);
});

/**
 * The surface tokens (--paper, --ground-2, --ground-3) are translucent fills,
 * not colours. Used as a label colour they render at a few percent white and
 * the text disappears — which is exactly what happened to the pressed calendar
 * segment and the today marker: both were legible while those tokens were
 * opaque, and both went invisible the moment the palette turned to glass.
 * Type that sits on a filled accent has its own token.
 */
test('no translucent surface token is used as a text colour', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const surfaces = ['--paper', '--ground-2', '--ground-3', '--accent-wash', '--accent-edge', '--accent-glow'];
  for (const token of surfaces) {
    const misuse = new RegExp(`(?<!-)color:\\s*var\\(${token}\\b`).exec(css);
    assert.equal(misuse, null, `${token} is a surface fill; it cannot be a text colour`);
  }
});

test('anything filled with the raw accent states its own label colour', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /--on-accent:\s*color-mix/, 'the on-accent token must exist');

  const offenders = [];
  for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
    // The raw hue as a fill, not one of the washes. A rule with no `color` at
    // all is a decoration — a progress bar, the now-dot — and needs nothing.
    if (!/background(-color)?:\s*var\(--accent\)\s*;/.test(body)) continue;
    if (!/(?<!-)color:\s*/.test(body)) continue;
    if (!/(?<!-)color:\s*var\(--(on-accent|ground)\)/.test(body)) {
      offenders.push(body.replace(/\s+/g, ' ').trim().slice(0, 80));
    }
  }
  assert.deepEqual(offenders, [], 'text on a filled accent must take --on-accent (or --ground)');
});

/* ------------------------------------------------- 4. store and item state */

/**
 * The store and the API client are plain modules with one browser assumption
 * each: api.js reads the session token off `window.location` when it loads.
 * These stubs satisfy exactly that — no DOM is faked, and anything that tries
 * to build one in here fails loudly, because a unit test quietly exercising a
 * pretend layout engine proves nothing about the real one.
 */
function stubBrowserGlobals() {
  if (!globalThis.window) {
    globalThis.window = {
      location: { href: 'http://127.0.0.1:7777/' },
      history: { replaceState() {} },
      addEventListener() {},
    };
  }
  if (!globalThis.sessionStorage) {
    globalThis.sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };
  }
  if (!globalThis.localStorage) {
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  }
  if (!globalThis.document) {
    globalThis.document = {
      documentElement: { style: { setProperty() {} } },
      // The board's heartbeat reads this and stops while nobody is looking, so
      // the stub has to have an opinion about it.
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      createElement() { throw new Error('these tests must not build DOM'); },
    };
  }
}

/** Let a chain of already-resolved promises settle, without a real timer. */
async function settle() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('itemsInBucket keeps snoozed rows off the panes; snoozedItems carries them', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.board = {
    ...store.state.board,
    items: [
      { id: 'a', bucket: 'now', state: 'open' },
      { id: 'b', bucket: 'now', state: 'snoozed', snoozed_until: '2026-08-12T09:00:00-04:00' },
      { id: 'c', bucket: 'now', state: 'done' },
      { id: 'd', bucket: 'now', state: 'snoozed', snoozed_until: null },
      { id: 'e', bucket: 'today', state: 'dismissed' },
    ],
  };
  // The regression this pins: a snoozed row used to stay in its bucket, so the
  // pane showed a sleeping item while the count claimed the board was clear.
  assert.deepEqual(store.itemsInBucket('now').map((i) => i.id), ['a']);
  assert.deepEqual(store.itemsInBucket('today').map((i) => i.id), []);
  assert.deepEqual(store.snoozedItems().map((i) => i.id), ['b', 'd']);
});

test('"Worth knowing" is one number, in the rail and in the section it opens', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.board = {
    ...store.state.board,
    counts: { now: 0, today: 0, soon: 0, waiting: 0, promised: 0, note: 1, money: 0 },
    // The model is instructed to report a quiet day in `notes`, which no
    // bucket count has ever included — so the rail read "Worth knowing 0"
    // beside a section headed "Worth knowing 3", on the ordinary day.
    notes: ['The invoice went out.', 'Nothing else needs you today.', '   ', 7, null],
    items: [{ id: 'n1', bucket: 'note', state: 'open' }],
    drafts: [],
    events: [],
    now: null,
  };
  assert.equal(store.boardNotes().length, 2, 'blank and non-string notes are not notes');
  // The invariant, in the same terms ui/views/now.js builds its heading from.
  assert.equal(
    store.railCounts().note,
    store.boardNotes().length + store.itemsInBucket('note').length,
  );
  assert.equal(store.railCounts().note, 3);

  const now = fs.readFileSync(path.join(UI, 'views/now.js'), 'utf8');
  assert.match(now, /boardNotes\(\)/,
    'the section must count through the same store export the rail does');
  assert.ok(!/state\.board\.notes/.test(now),
    'a second copy of the filter in the view is how the two numbers drifted apart');
});

test('setItemState carries the snooze deadline, and only when one was chosen', async (t) => {
  stubBrowserGlobals();
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let captured = null;
  globalThis.fetch = async (reqPath, init = {}) => {
    captured = { path: reqPath, body: init.body ? JSON.parse(init.body) : null };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  t.after(() => { delete globalThis.fetch; });

  await api.setItemState('abc', 'snoozed', { until: '2026-08-12T09:00:00-04:00' });
  assert.equal(captured.path, '/api/items/abc/state');
  assert.deepEqual(captured.body, { state: 'snoozed', until: '2026-08-12T09:00:00-04:00' });

  // No deadline chosen: the field is ABSENT, so the server applies its own
  // default rather than being handed a null to interpret.
  await api.setItemState('abc', 'open');
  assert.deepEqual(captured.body, { state: 'open' });

  // An EXPLICIT null is different from absence and must survive the wire: it
  // is how Undo restores a legacy manual snooze — no deadline, wake by hand —
  // without the server upgrading it to tomorrow morning.
  await api.setItemState('abc', 'snoozed', { until: null });
  assert.deepEqual(captured.body, { state: 'snoozed', until: null });
});

test('the snooze chooser offers three future deadlines in the configured zone', async () => {
  stubBrowserGlobals();
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const tz = 'America/New_York';
  const noon = Date.parse('2026-08-11T16:00:00Z'); // Tuesday, noon in New York

  const [later, tomorrow, nextWeek] = items.snoozeChoices(tz, noon);
  assert.equal(later.label, 'Later today');
  assert.equal(later.until, ui.toZonedISO(new Date(noon + 4 * 3_600_000), tz));
  assert.equal(tomorrow.until, '2026-08-12T09:00:00-04:00');
  assert.equal(nextWeek.until, '2026-08-17T09:00:00-04:00');
  assert.equal(ui.weekdayOfKey(ui.dayKey(nextWeek.until)), 1, 'next week means a Monday');

  // From a Monday, "next week" is the FOLLOWING Monday, not later today.
  const monday = Date.parse('2026-08-10T16:00:00Z');
  const [, , fromMonday] = items.snoozeChoices(tz, monday);
  assert.equal(fromMonday.until, '2026-08-17T09:00:00-04:00');
});

test('a toast dismisses itself, and an action toast is given longer', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setTimeout'] });

  store.notify('saved');
  t.mock.timers.tick(5_900);
  assert.ok(store.state.toast, 'a plain toast must live its whole window');
  t.mock.timers.tick(200);
  assert.equal(store.state.toast, null, 'a plain toast must dismiss itself');

  // A toast with an action must not vanish mid-reach for the button.
  store.notify('Marked done: the invoice', { action: { label: 'Undo', run: () => {} } });
  t.mock.timers.tick(6_500);
  assert.ok(store.state.toast, 'an action toast outlives the plain window');
  t.mock.timers.tick(2_000);
  assert.equal(store.state.toast, null);

  // A replacement restarts the clock along with the message.
  store.notify('one');
  t.mock.timers.tick(4_000);
  store.notify('two');
  t.mock.timers.tick(4_000);
  assert.equal(store.state.toast?.message, 'two', 'the replacement restarted the clock');
  t.mock.timers.tick(2_100);
  assert.equal(store.state.toast, null);
});

test('done raises an Undo that restores the exact prior state, deadline included', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const board = {
    items: [{ id: 'x', bucket: 'now', state: 'snoozed', snoozed_until: '2026-08-12T09:00:00-04:00', headline: 'chase the survey invoice' }],
    counts: {}, events: [], drafts: [], runs: { last: null }, notes: [], first: null, now: null,
  };
  const posts = [];
  globalThis.fetch = async (reqPath, init = {}) => {
    if (init.method === 'POST') posts.push({ path: reqPath, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => (reqPath === '/api/state' ? JSON.stringify(board) : '{}') };
  };
  t.after(() => { delete globalThis.fetch; });
  store.state.board = { ...store.state.board, ...board };

  await store.setItemState('x', 'done');
  assert.deepEqual(posts[0].body, { state: 'done' });
  assert.equal(store.state.toast?.action?.label, 'Undo');

  await store.state.toast.action.run();
  // The undo does not merely reopen the item — it re-snoozes it to the same
  // deadline it had, because that deadline was a decision the user made.
  assert.deepEqual(posts[1].body, { state: 'snoozed', until: '2026-08-12T09:00:00-04:00' });
  store.notify(null);
});

/* ------------------------------------------ 5. shell behaviour, from source */

/**
 * The behaviours below need a layout engine to observe directly, so — like the
 * chip-clamp and sticky-rail guards above — they are pinned at the source: the
 * mechanism that made the bug impossible must still be present.
 */
test('the capture panel is built once, and no repaint path rebuilds it', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  // Exactly one call site (the one-time chrome build) plus the definition. A
  // second call site means some repaint mints a fresh panel — which is the
  // note-wipe bug: every sweep tick destroyed a half-typed note.
  assert.equal(app.split('capturePanel(').length - 1, 2,
    'capturePanel must have exactly one call site besides its definition');
  const paint = /function paintChrome\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(paint, 'paintChrome is missing');
  assert.ok(!paint[0].includes('capturePanel('), 'paintChrome rebuilds the capture panel');
  assert.match(paint[0], /if \(!chrome\) chrome = buildChrome\(\)/,
    'the chrome must be built once and reused');
});

test('a board-driven re-render defers while a text field in main has focus', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const render = /function render\(\{ force = false \}[\s\S]*?\n\}/m.exec(app);
  assert.ok(render, 'render is missing');
  assert.match(render[0], /editingInMain\(\)/, 'render must check for a focused field');
  assert.match(render[0], /renderQueued = true/, 'a mid-edit render must queue, not run');
  assert.match(app, /document\.addEventListener\('focusout'/, 'the queued render must flush on blur');
});

test('view navigation resets the scroll; same-view re-renders leave it alone', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const onRoute = /function onRoute\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(onRoute, 'onRoute is missing');
  assert.match(onRoute[0], /window\.scrollTo\(0, 0\)/);
  assert.match(onRoute[0], /before !== route\.view/,
    'the reset must be gated on the view actually changing');

  // Two call sites, and exactly two: onRoute above, and the skeleton handover
  // in render() — leaving onboarding for the board is a navigation in
  // everything but the hash, and onRoute cannot see it because the view name is
  // 'now' on both sides. Anything beyond those two is a repaint moving the
  // page under a reader, which is its own bug: a deferred board refresh that
  // yanks the scroll to the top is exactly the thing this guard is here for.
  assert.equal(app.split('scrollTo').length - 1, 2);
  const handover = /if \(layout !== 'chrome'\) \{[\s\S]*?\n  \}/m.exec(app);
  assert.ok(handover, 'the skeleton handover branch is missing');
  assert.match(handover[0], /window\.scrollTo\(0, 0\)/,
    'the second call site must be the skeleton handover, not a repaint');
  for (const fn of ['paintChrome', 'flushQueuedRender', 'paintSweepLine']) {
    const body = new RegExp(`function ${fn}\\([^)]*\\)[\\s\\S]*?\\n\\}`, 'm').exec(app);
    assert.ok(body, `${fn} is missing`);
    assert.ok(!body[0].includes('scrollTo'), `${fn} must not move the scroll`);
  }
});

test('exactly one document-level keydown listener, and it closes the note panel', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.equal(app.split("document.addEventListener('keydown'").length - 1, 1);
  assert.match(app, /e\.key !== 'Escape'/);
});

test('the calendar empty state is a claim about the config AND an empty board', () => {
  const cal = fs.readFileSync(path.join(UI, 'views/calendar.js'), 'utf8');
  // "No calendar connected" while a calendar is connected was the lie; a
  // connected calendar with a quiet fortnight must still get its grid. But the
  // config cannot be the whole story: the demo seeds a week of events without
  // writing any config entry, and a demo board deserves its grid too. So the
  // setup card appears only when BOTH are empty.
  assert.match(cal, /\(state\.config\?\.calendars\?\.length \|\| 0\) === 0 && !state\.board\.events\.length/);
});

test('the clash flag cannot escape its month cell', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const flag = /^\.month-flag \{([^}]*)\}/m.exec(css);
  assert.ok(flag, '.month-flag rule is missing');
  assert.match(flag[1], /max-width:\s*100%/);
  assert.match(flag[1], /overflow:\s*hidden/);
  assert.match(flag[1], /text-overflow:\s*ellipsis/);
  // The flex row above it must be allowed to shrink, or max-width: 100% is
  // measured against a row that already blew the cell open.
  const row = /^\.month-num-row \{([^}]*)\}/m.exec(css);
  assert.ok(row, '.month-num-row rule is missing');
  assert.match(row[1], /min-width:\s*0/);
});

test('a sweep that lost one source says so, and does not call the run failed', () => {
  const src = fs.readFileSync(path.join(UI, 'views/now.js'), 'utf8');
  // A run that lost ONE source comes back ok:true. The banner returned null
  // unless the WHOLE run had failed, so a revoked app password, a 404'd .ics
  // or a Sent folder that is not called Sent rendered as "Nothing needs you."
  // and nothing else — the board simply got quieter while the app reassured.
  assert.ok(!/if \(!live && !\(last && last\.ok === false\)\) return null;/.test(src),
    'the banner must not be gated on the whole run having failed');
  const trouble = /function sweepTrouble\(\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(trouble, 'sweepTrouble is missing');
  assert.match(trouble[0], /sourcesFailed/, 'the count every sweep writes must have a reader');
  assert.match(trouble[0], /'partial'/);

  const banner = /function failureBanner\(trouble\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(banner, 'failureBanner is missing');
  // Its own tone and its own sentence. "The last sweep failed" over a run that
  // read four sources out of five is a lie in the alarming direction, and it
  // sends the reader looking for a broken app instead of a dead password.
  assert.match(banner[0], /The last sweep could not read everything/);
  assert.match(banner[0], /banner-warn/);
  assert.match(banner[0], /The last sweep failed/);

  const render = /export function renderNow\(ctx\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(render, 'renderNow is missing');
  assert.match(render[0], /sweepTrouble\(\)/, 'the view has to actually ask');

  // The empty state under the banner has to branch its TITLE, not only its
  // detail. Branching the detail alone left "Nothing on the board yet." as the
  // largest text on the screen after a partial failure, and "yet" is exactly
  // the reassurance the banner exists to withdraw: it tells the reader the
  // board is merely between sweeps. The detail line underneath does not undo a
  // headline.
  const emptyUnderBanner = /body\.appendChild\(banner[\s\S]*?: emptyForContext\(navigate\)\);/m.exec(render[0]);
  assert.ok(emptyUnderBanner, 'the banner/empty-state branch in renderNow is missing');
  const titles = [...emptyUnderBanner[0].matchAll(/title: '([^']*)'/g)].map((m) => m[1]);
  assert.equal(titles.length, 2, 'the two failures must get two titles');
  assert.notEqual(titles[0], titles[1], 'both failures are still using the same headline');
  assert.ok(titles.some((t) => /yet/.test(t)), 'the whole-failure case keeps "yet" — a sweep really is still to come');
  assert.ok(
    titles.filter((t) => /yet/.test(t)).length === 1,
    'the partial-failure title must not say "yet": that sweep finished, and what is missing is what could not be read',
  );
  /* The two assertions above are order-blind, and swapping the two objects
     leaves them both green while putting the reassurance back on exactly the
     case this test exists for. `titles[0]` is the `trouble === 'partial'` arm —
     the first branch of the ternary matched below — so tie the title to its
     arm, not to the pair. */
  assert.ok(
    !/yet/.test(titles[0]),
    `the partial arm is the first ternary branch and it must not be the one that says "yet" (got ${JSON.stringify(titles[0])})`,
  );
  assert.match(emptyUnderBanner[0], /trouble === 'partial'/, 'the branch has to be on the trouble kind');
});

test('the first screen paints its action row whether or not it is in the document', () => {
  const src = fs.readFileSync(path.join(UI, 'views/onboarding.js'), 'utf8');
  const paint = /const paintActions = \(\) => \{[\s\S]*?\n  \};/m.exec(src);
  assert.ok(paint, 'paintActions is missing');
  // It is called synchronously twelve lines before shell() puts `actions` in a
  // tree, so a live-node guard is always false on the pass that matters — and
  // the two probe .finally callbacks that covered for it are gated on
  // module-level caches, so the SECOND build of this screen got neither. The
  // row kept its placeholder: no "Use Ollama and open the board", no "Try it
  // with sample data" (the only way into the sample data anywhere in ui/), no
  // "Choose a model", no demo-week note. watchBoard rebuilds this screen every
  // three minutes, so it emptied itself with nobody touching it.
  assert.ok(!/isConnected/.test(paint[0]),
    'paintActions must not gate on the row being in the document');
  assert.match(src, /Try it with sample data/);
  const start = /function startScreen\(rerender, navigate\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(start, 'startScreen is missing');
  assert.match(start[0], /\n {2}paintActions\(\);\n/,
    'the row must be painted on the way out, not only when a probe lands');
});

test('a settings sub-tab change moves focus instead of dropping it on <body>', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const onRoute = /function onRoute\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(onRoute, 'onRoute is missing');
  // A sub-route change still forces replace(main, currentView()), so the
  // .subtab button that was pressed is detached and focus falls to <body> —
  // with aria-selected written onto freshly built nodes nobody is focused on,
  // announced to no one, on all eight panels. Comparing only route.view left
  // it there.
  assert.match(onRoute[0], /beforeSub !== route\.sub/,
    'onRoute must notice a sub-route change, not only a view change');
  assert.match(onRoute[0], /refocusSelectedTab\(\)/);
  assert.ok(onRoute[0].indexOf('render({ force: true })') < onRoute[0].indexOf('refocusSelectedTab()'),
    'focus has to be restored after the rebuild, not before it');

  const refocus = /function refocusSelectedTab\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(refocus, 'refocusSelectedTab is missing');
  assert.match(refocus[0], /\[role="tab"\]\[aria-selected="true"\]/);
  assert.match(refocus[0], /focusQuietly/);
  // A sub-route with no tablist behind it — #/calendar/2026-08-11 — must be
  // left alone. Yanking focus to the top of the page on a date change is this
  // same bug pointed the other way.
  assert.match(refocus[0], /if \(selected\)/);

  // The same-hash branch of navigate() rebuilds the view without a hashchange,
  // so activating the tab you are already on loses focus by the same route
  // while onRoute never runs at all.
  const nav = /function navigate\(hash\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(nav, 'navigate is missing');
  assert.match(nav[0], /refocusSelectedTab\(\)/);
  /* And it has to come second. This assertion used to be presence alone, which
     is order-blind about a defect that is entirely an ordering: refocus reads
     the tab out of the tree render() has just built, so hoisting it above the
     render — a plausible tidy-up, since both lines are about the same view —
     focuses the button that is one line away from being detached and puts the
     orphaning back exactly as it was, with the guard still green. */
  assert.ok(nav[0].indexOf('render({ force: true })') < nav[0].indexOf('refocusSelectedTab()'),
    'focus has to be restored after the rebuild, not before it');
});

/* ------------------------------------------- 6. the overnight window, and
                                                   the things nobody could hear */

/**
 * A bare "due 2026-08-12" is a DAY, not an instant, and `instant()` reads it as
 * UTC midnight because it is the ordering rule. Used as a deadline that made an
 * item turn overdue-red at 8pm the evening before in New York, and read "due
 * 16h ago" for the whole of the day it was actually due. dueInstant() is the
 * deadline reading; instant() is left exactly as the parity suite pins it.
 */
test('dueInstant puts a bare deadline at the end of its own day, in the right zone', () => {
  const tz = 'America/New_York';
  assert.equal(ui.dueInstant('2026-08-12', tz), Date.parse('2026-08-12T23:59:59.999-04:00'));
  // ...and the same date in January lands on the winter offset, not the summer one.
  assert.equal(ui.dueInstant('2026-01-12', tz), Date.parse('2026-01-12T23:59:59.999-05:00'));
  // A due date that names a time is that time, untouched.
  assert.equal(ui.dueInstant('2026-08-12T09:00:00-04:00', tz), Date.parse('2026-08-12T09:00:00-04:00'));
  assert.equal(ui.dueInstant('nonsense', tz), null);
  // The ordering rule is deliberately unchanged.
  assert.equal(ui.instant('2026-08-12'), Date.parse('2026-08-12T00:00:00Z'));
});

test('a bare due date is not overdue during its own day, west of Greenwich', () => {
  const tz = 'America/New_York';
  const item = { due_at: '2026-08-12' };
  // 8:30pm on the 11th — half an hour past the UTC midnight the old reading
  // used, which is where an item due tomorrow started rendering overdue-red.
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-12T00:30:00Z'), tz), false);
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-12T13:00:00Z'), tz), false); // 9am, its own day
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-13T03:00:00Z'), tz), false); // 11pm, still its day
  // Half past midnight: the day it was promised for is over, and now it is late.
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-13T04:30:00Z'), tz), true);
});

test('a bare due date reads as a day, not as hours since UTC midnight', () => {
  const tz = 'America/New_York';
  const due = { due_at: '2026-08-12' };
  assert.equal(fmt.dueLabel(due, Date.parse('2026-08-12T13:00:00Z'), tz), 'due today');
  assert.equal(fmt.dueLabel(due, Date.parse('2026-08-11T22:00:00Z'), tz), 'due tomorrow');
  assert.equal(fmt.dueLabel(due, Date.parse('2026-08-13T13:00:00Z'), tz), 'due yesterday');
  assert.equal(fmt.dueLabel({ due_at: '2026-08-20' }, Date.parse('2026-08-12T13:00:00Z'), tz), 'due Thu, Aug 20');
  // A deadline that names a time still counts down to it.
  assert.equal(
    fmt.dueLabel({ due_at: '2026-08-11T14:00:00Z' }, Date.parse('2026-08-11T12:00:00Z'), tz),
    'due in 2h',
  );
});

test('the day cost is stated in tokens, or not at all', () => {
  assert.equal(fmt.tokenLine({ in: 12_400, out: 1_120 }), '12k tokens in · 1.1k out');
  // The sweep engine's own field names read the same.
  assert.equal(fmt.tokenLine({ tokensIn: 900, tokensOut: 40 }), '900 tokens in · 40 out');
  // Absence is not zero: an older database, or a machine that has never swept,
  // has nothing to report and must render nothing rather than "0 tokens in".
  assert.equal(fmt.tokenLine(null), '');
  assert.equal(fmt.tokenLine(undefined), '');
  assert.equal(fmt.tokenLine({}), '');
  assert.equal(fmt.tokenLine({ in: 0, out: 0 }), '');
  // A rolling total is only today's while today is still today.
  assert.equal(fmt.tokenLine({ day: '2026-08-11', in: 500, out: 20 }, '2026-08-12'), '');
  assert.equal(fmt.tokenLine({ day: '2026-08-12', in: 500, out: 20 }, '2026-08-12'), '500 tokens in · 20 out');
  // Zelos does not know what anyone pays per token and must never imply it does.
  assert.ok(!/[$€£]/.test(fmt.tokenLine({ in: 12_400, out: 1_120 })));
  assert.equal(fmt.compactCount(999), '999');
  assert.equal(fmt.compactCount(1_050), '1.1k');
  assert.equal(fmt.compactCount(2_400_000), '2.4M');
});

test('a window left open past midnight keeps its date, its now-line and its day', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.board = {
    ...store.state.board,
    now: '2026-08-11T23:30:00-04:00',
    events: [
      { id: 'tonight', starts_at: '2026-08-11T21:00:00-04:00' },
      { id: 'tomorrow', starts_at: '2026-08-12T09:00:00-04:00' },
    ],
  };
  store.state.boardAt = Date.now() - 3 * 3_600_000;

  // The old nowMark answered {key: null} the moment the clock passed midnight:
  // blank header date, no now-line, no events, and the calendar's "Today"
  // button anchored to yesterday until someone reloaded the page.
  const nm = store.nowMark();
  assert.equal(nm.key, '2026-08-12');
  assert.ok(Math.abs(nm.minutes - 150) < 2, `2:30am, not ${nm.minutes}`);
  assert.deepEqual(store.eventsToday().map((e) => e.id), ['tomorrow']);
});

test('an untouched window refetches the board on a timer, and stops while hidden', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setInterval'] });

  let fetched = 0;
  const board = {
    items: [], counts: {}, events: [], drafts: [], runs: { last: null },
    notes: [], first: null, now: '2026-08-12T02:30:00-04:00',
  };
  globalThis.fetch = async (reqPath) => {
    if (reqPath === '/api/state') fetched += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(board) };
  };
  t.after(() => {
    delete globalThis.fetch;
    globalThis.document.visibilityState = 'visible';
  });

  store.state.phase = 'ready';
  const stop = store.watchBoard({ intervalMs: 60_000 });
  t.after(stop);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetched, 1, 'nothing was refetching the board at all');

  globalThis.document.visibilityState = 'hidden';
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetched, 1, 'a tab nobody is looking at must not poll');

  globalThis.document.visibilityState = 'visible';
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetched, 2, 'the heartbeat resumes when the tab comes back');
  assert.equal(store.state.board.now, '2026-08-12T02:30:00-04:00');
});

test('the heartbeat refetches through the store, so it defers like any board change', () => {
  const store = fs.readFileSync(path.join(UI, 'lib/store.js'), 'utf8');
  const watch = /export function watchBoard\([\s\S]*?\n\}/m.exec(store);
  assert.ok(watch, 'watchBoard is missing');
  assert.match(watch[0], /setInterval/);
  assert.match(watch[0], /visibilityState === 'hidden'/, 'a hidden tab must not poll');
  assert.match(watch[0], /visibilitychange/, 'and it must catch up when the tab returns');
  // loadBoard + emit is the same path a finished sweep takes, which is what
  // puts this refresh under the shell's deferred-render rule: a refetch landing
  // while a draft is being typed queues until that field blurs.
  assert.match(watch[0], /await loadBoard\(\)/);
  assert.match(watch[0], /\n\s*emit\(\);/);
  assert.ok(!/notify\(/.test(watch[0]), 'a background refetch must not toast its failures');

  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.match(app, /watchBoard\(\)/, 'the shell never starts the heartbeat');
});

/**
 * A live region announces MUTATIONS made while it is in the document. Both of
 * the app's regions were built with their text already set and then swapped in
 * whole — so sweep progress, sweep failure and every single toast were silent.
 * ui/views/ai-access.js documents the same trap and works around it the same way.
 */
test('the sweep line and the toast can actually be heard', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');

  const build = /function buildSweepLine\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(build, 'buildSweepLine is missing');
  assert.match(build[0], /'aria-live': 'polite'/);
  assert.ok(!/text:/.test(build[0]), 'a live region born with its text set announces nothing');

  const paint = /function paintSweepLine\(parts\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(paint, 'paintSweepLine is missing');
  assert.match(paint[0], /announce\(parts\.textNode/);

  const announce = /function announce\(node, text\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(announce, 'announce is missing');
  assert.match(announce[0], /requestAnimationFrame/, 'the text must land after insertion');

  // Replacing the region is the same silence in another coat, so the repaint
  // path must update the one that is already there.
  const paintChrome = /function paintChrome\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(paintChrome, 'paintChrome is missing');
  assert.ok(!paintChrome[0].includes('buildSweepLine('), 'paintChrome mints a fresh live region');
  assert.match(paintChrome[0], /paintSweepLine\(chrome\.sweep\)/);

  const toast = /function toastBar\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(toast, 'toastBar is missing');
  assert.ok(!/text: state\.toast\.message/.test(toast[0]), 'the toast bakes its message in');
  assert.match(paintChrome[0], /announce\(built\.text, state\.toast\.message\)/);
});

test('the page declares the one theme it actually has', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  // "light dark" on an app with a single black theme makes a light-mode OS draw
  // its scrollbars, form controls and caret pale against pure black.
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.ok(!/content="light dark"/.test(html));
});

test('the search route is registered, and its view module answers to it', async () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.match(app, /import \{ renderSearch \} from '\.\/views\/search\.js';/);
  assert.match(app, /\{ id: 'search', label: 'Search', render: renderSearch, countKey: null \}/);
  // No count badge: every other number in the rail is work that is waiting, and
  // "how many things could you find" is not that.
  assert.ok(!/id: 'search'[^}]*countKey: '/.test(app));

  assert.ok(fs.existsSync(path.join(UI, 'views/search.js')), 'ui/views/search.js is missing');
  stubBrowserGlobals();
  const mod = await import(fileUrl(UI, 'views/search.js'));
  assert.equal(typeof mod.renderSearch, 'function', 'search.js must export renderSearch');
});

/* ------------------------------------- 7. the view helpers worth pinning */

/**
 * The search and calendar views keep their arithmetic in exported pure
 * functions precisely so it can be checked here, without a layout engine. Both
 * modules are imported rather than read as text: these are behaviours, not
 * mechanisms, and a source guard would only pin the spelling.
 */
test('a search hit knows where — and whether — it can be opened', async () => {
  stubBrowserGlobals();
  const search = await import(fileUrl(UI, 'views/search.js'));

  assert.deepEqual(search.refParts('msg:abc'), { prefix: 'msg', id: 'abc' });
  // Message ids are not guaranteed to be colon-free; only the first one splits.
  assert.deepEqual(search.refParts('msg:a:b'), { prefix: 'msg', id: 'a:b' });
  assert.equal(search.refParts('msg:'), null);
  assert.equal(search.refParts('other:1'), null);
  assert.equal(search.refParts(null), null);

  assert.equal(search.hashForBucket('waiting'), '#/owed');
  assert.equal(search.hashForBucket('money'), '#/today');
  assert.equal(search.hashForBucket('nonsense'), '#/now');

  const items = [
    { id: 'i1', bucket: 'waiting', sourceRefs: ['msg:m1'] },
    { id: 'i2', bucket: 'now', sourceRefs: [] },
  ];
  const events = [{ id: 'e1', starts_at: '2026-08-11T14:00:00-04:00' }];

  // The hash carries the day, so opening a March event lands on March rather
  // than on whatever range the calendar was last left showing.
  assert.deepEqual(search.destinationFor('evt:e1', { items, events }), {
    where: 'calendar', hash: '#/calendar/2026-08-11', event: events[0], day: '2026-08-11',
  });
  assert.equal(search.destinationFor('item:i1', { items, events }).hash, '#/owed');
  // A message is not a page in this app, but the item a sweep raised from it is.
  const raised = search.destinationFor('msg:m1', { items, events });
  assert.equal(raised.item.id, 'i1');
  assert.equal(raised.raised, true);
  // A hit nothing on the board cites offers no way in, which is honest: an
  // item that has been done is not on a page any more.
  assert.equal(search.destinationFor('msg:gone', { items, events }), null);
  assert.equal(search.destinationFor('evt:gone', { items, events }), null);
  assert.equal(search.destinationFor('item:gone', { items, events }), null);
});

test('the results summary counts in the words the app uses, board first', async () => {
  stubBrowserGlobals();
  const search = await import(fileUrl(UI, 'views/search.js'));
  assert.equal(
    search.summariseKinds([
      { kind: 'message' }, { kind: 'item' }, { kind: 'message' }, { kind: 'event' },
    ]),
    'board 1 · mail 2 · calendar 1',
  );
  assert.equal(search.summariseKinds([]), '');
  assert.equal(search.summariseKinds(null), '');
  // The database's own vocabulary must not reach the screen.
  assert.equal(search.kindLabel('capture'), 'note');
  assert.equal(search.kindLabel('message'), 'mail');
  assert.equal(search.kindLabel(''), 'result');
});

test('the calendar opens where the day is, not at midnight', async () => {
  stubBrowserGlobals();
  const cal = await import(fileUrl(UI, 'views/calendar.js'));

  // Now wins, with two hours of context above it.
  assert.equal(cal.openingScrollMinutes({ nowMinutes: 14 * 60, firstEventMinutes: 9 * 60 }), 12 * 60);
  // Early enough and it clamps rather than going negative.
  assert.equal(cal.openingScrollMinutes({ nowMinutes: 30 }), 0);
  // A range with no today aims at its first timed event instead.
  assert.equal(cal.openingScrollMinutes({ firstEventMinutes: 10 * 60 }), 10 * 60 - 45);
  // And with neither, the working day.
  assert.equal(cal.openingScrollMinutes({}), 7 * 60);

  // All-day spans start at minute zero and live in their own strip; counting
  // them would aim every range at midnight.
  assert.equal(cal.earliestStartMinutes([
    { start: 0, allDay: true }, { start: 600 }, { start: 540 },
  ]), 540);
  assert.equal(cal.earliestStartMinutes([{ start: 0, allDay: true }]), null);
  assert.equal(cal.earliestStartMinutes([]), null);

  // A re-render in the same place keeps the scroll the reader chose; arriving,
  // or moving to another range, does not.
  const sig = cal.rangeSignature('week', ['2026-08-09', '2026-08-15']);
  assert.equal(sig, cal.rangeSignature('week', ['2026-08-09', '2026-08-10', '2026-08-15']));
  assert.equal(cal.shouldOpenAtTarget({ signature: sig, lastSignature: sig, wasOnScreen: true }), false);
  assert.equal(cal.shouldOpenAtTarget({ signature: sig, lastSignature: sig, wasOnScreen: false }), true);
  assert.equal(cal.shouldOpenAtTarget({ signature: sig, lastSignature: 'week|x|y', wasOnScreen: true }), true);
});

test('the tab bar does not keep a second copy of how many views there are', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const bar = /^\.tabbar \{([^}]*)\}/m.exec(css);
  assert.ok(bar, '.tabbar rule is missing');
  // A literal column count here is VIEWS.length written down twice; adding the
  // seventh view wrapped the extra tab onto a row below the bar.
  assert.ok(!/grid-template-columns:\s*repeat\(\d/.test(bar[1]), 'the tab count is hardcoded in CSS');
  assert.match(bar[1], /grid-auto-flow: column/);
  assert.match(bar[1], /grid-auto-columns: minmax\(0, 1fr\)/);
});

test('no rule still branches on a theme attribute that is never set', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  // There is one theme. A dead `[data-theme=…]` override is a rule that looks
  // like it is handling a case and is not.
  assert.ok(!/\[data-theme[~^|*$]?=/.test(css), 'app.css still branches on data-theme');
  assert.ok(!/data-theme=/.test(html), 'index.html still carries a data-theme attribute');
});

/* ------------------------------------------- 8. the fixes that were not wired,
                                                  and the failures nobody saw */

/**
 * A zone parameter nothing passes is not a fix.
 *
 * `dueLabel` and `isOverdue` both take a zone and both default it to the
 * BROWSER's, and every row on the board called them without one — so a bare
 * "due 2026-08-12" was judged against the laptop's zone while the carried-for
 * badge on the same line was judged in the configured one. The two readings are
 * a whole day apart for anyone away from home. `dueBit` is the single place the
 * zone is threaded, and the two assertions below are the two halves that matter:
 * that it actually consults the zone, and that no call site has been left behind.
 */
test('a deadline is read in the configured zone, wherever the browser thinks it is', async () => {
  stubBrowserGlobals();
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const item = { due_at: '2026-08-12' };
  // 1pm UTC on the 12th. In New York that is 9am of the day it is due; in
  // Kiritimati it is 3am of the day AFTER. Two zones, two honest answers, and
  // neither of them depends on where this test is being run.
  const now = Date.parse('2026-08-12T13:00:00Z');

  const inNewYork = items.dueBit(item, { tz: 'America/New_York', now });
  assert.deepEqual(inNewYork, { text: 'due today', hot: false });

  const inKiritimati = items.dueBit(item, { tz: 'Pacific/Kiritimati', now });
  assert.deepEqual(inKiritimati, { text: 'due yesterday', hot: true });

  assert.equal(items.dueBit({ due_at: null }, { tz: 'America/New_York', now }), null);
});

test('every production call of dueLabel/isOverdue is handed a zone', () => {
  // The fix lived in format.js and was reachable only from the tests. This walks
  // the shipped modules and fails on a call site that left the zone to chance —
  // which is what metaLine() and itemHero() were both doing.
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(UI);

  let callSites = 0;
  for (const file of files) {
    // format.js declares them; a declaration is not a call.
    if (file.endsWith(path.join('lib', 'format.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(dueLabel|isOverdue)\s*\(([^)]*)\)/g)) {
      callSites += 1;
      assert.match(m[2], /\bzone\b|\btz\b/,
        `${path.relative(UI, file)} calls ${m[1]}(${m[2]}) without a zone`);
    }
  }
  assert.ok(callSites > 0, 'the call sites moved; this guard is now pinning nothing');
});

/**
 * The memo is exact, not approximate: both Intl lookups inside dueInstant are
 * taken at instants derived from the zone and the day-key alone, so the same
 * pair can never produce a different answer. What it buys is the cost — the
 * lookups are something like a hundred times the string parse they replaced, and
 * a board row asks for the same deadline twice, once for its words and once for
 * whether it is late.
 */
test('a deadline costs its zone lookup once per zone and day, not once per row', (t) => {
  const real = Intl.DateTimeFormat;
  let built = 0;
  // A subclass rather than a wrapper: `new Intl.DateTimeFormat(...)` must keep
  // returning something with formatToParts on it.
  class Counting extends real {
    constructor(...args) {
      built += 1;
      super(...args);
    }
  }
  Intl.DateTimeFormat = Counting;
  t.after(() => { Intl.DateTimeFormat = real; });

  const tz = 'America/New_York';
  // A key this process has certainly not seen, so the memo starts cold.
  const first = ui.dueInstant('2031-08-12', tz);
  assert.ok(built > 0, 'the first reading must actually consult the zone');
  const beforeRepeat = built;

  for (let i = 0; i < 20; i += 1) {
    assert.equal(ui.dueInstant('2031-08-12', tz), first);
  }
  assert.equal(built, beforeRepeat, 'the same zone and day were looked up again');

  // A different day, and a different zone on the same day, are both still real
  // work — the memo must not be answering from the wrong entry.
  assert.equal(ui.dueInstant('2031-01-12', tz), Date.parse('2031-01-12T23:59:59.999-05:00'));
  assert.equal(ui.dueInstant('2031-08-12', 'Europe/London'), Date.parse('2031-08-12T23:59:59.999+01:00'));
  assert.equal(first, Date.parse('2031-08-12T23:59:59.999-04:00'));
});

/**
 * The heartbeat swallowed every error, which left the app permanently and
 * invisibly stale in the exact scenario it was added for: the window open
 * overnight, whose hours-old board looks precisely like a current one.
 */
test('a run of failed heartbeats says so, and one blip does not', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setInterval'] });

  const board = {
    items: [], counts: {}, events: [], drafts: [], runs: { last: null },
    notes: [], first: null, now: '2026-08-12T02:30:00-04:00',
  };
  let answering = false;
  globalThis.fetch = async () => (answering
    ? { ok: true, status: 200, text: async () => JSON.stringify(board) }
    : { ok: false, status: 503, text: async () => '{"error":"the server is not there"}' });
  t.after(() => {
    delete globalThis.fetch;
    store.state.fatal = null;
    store.state.phase = 'ready';
  });

  store.state.phase = 'ready';
  store.state.fatal = null;
  const stop = store.watchBoard({ intervalMs: 60_000 });
  t.after(stop);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal, null, 'one missed refetch is a wifi hiccup, not news');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal, null, 'two is still not a story');

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal?.title, 'Zelos is not answering',
    'a heartbeat that keeps failing must stop pretending the board is current');
  assert.equal(store.state.phase, 'down');

  // ...and it comes back down by itself when the server does.
  answering = true;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal, null, 'a server that came back must clear its own screen');
  assert.equal(store.state.phase, 'ready');
});

test('the heartbeat states its failure in the same words the boot path uses', () => {
  const store = fs.readFileSync(path.join(UI, 'lib/store.js'), 'utf8');
  const watch = /export function watchBoard\([\s\S]*?\n\}/m.exec(store);
  assert.ok(watch, 'watchBoard is missing');
  // One screen, one wording. Two copies of "Zelos is not answering" is two
  // sentences that will drift.
  assert.match(watch[0], /fatalFor\(err\)/);
  assert.equal(store.split("title: 'Zelos is not answering'").length - 1, 1);
  const refresh = /export async function refresh\([\s\S]*?\n\}/m.exec(store);
  assert.ok(refresh, 'refresh is missing');
  assert.match(refresh[0], /fatalFor\(err\)/);
});

/**
 * `nowMark()` rolls its key past midnight rather than giving up, and the
 * now-line is a child of whichever column was today when the grid was built. So
 * at 00:03 the line was being repositioned three minutes down YESTERDAY's
 * column — a confident claim about the wrong day.
 */
test('past midnight the now-line changes column, or leaves', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const cal = await import(fileUrl(UI, 'views/calendar.js'));

  // A grid small enough to reason about: the handful of node behaviours
  // tickNowLine actually uses, and nothing else.
  const node = (day) => {
    const self = {
      dataset: day ? { day } : {},
      children: [],
      parentNode: null,
      classes: new Set(day ? [] : []),
      style: {},
      classList: {
        add(c) { self.classes.add(c); },
        remove(c) { self.classes.delete(c); },
      },
      appendChild(child) {
        child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = self;
        self.children.push(child);
        return child;
      },
      remove() {
        const kids = self.parentNode?.children;
        if (kids) kids.splice(kids.indexOf(self), 1);
        self.parentNode = null;
      },
    };
    return self;
  };

  const grid = (dayKeys) => {
    const cols = dayKeys.map((d) => node(d));
    const line = node(null);
    cols[0].appendChild(line);
    cols[0].classList.add('is-today');
    const realDoc = globalThis.document;
    globalThis.document = {
      ...realDoc,
      querySelector: (sel) => (sel === '.cal-days .now-line' && line.parentNode ? line : null),
      querySelectorAll: (sel) => (sel === '.cal-days .cal-col' ? cols : []),
    };
    t.after(() => { globalThis.document = realDoc; });
    return { cols, line };
  };

  // The board was fetched at 23:30 and nobody has touched the window since; it
  // is now three hours later, which is 02:30 of the NEXT day.
  store.state.board = { ...store.state.board, now: '2026-08-11T23:30:00-04:00' };
  store.state.boardAt = Date.now() - 3 * 3_600_000;
  assert.equal(store.nowMark().key, '2026-08-12', 'the premise of this test has moved');

  const week = grid(['2026-08-11', '2026-08-12']);
  cal.tickNowLine();
  assert.equal(week.line.parentNode, week.cols[1],
    'the now-line stayed in yesterday and moved itself down inside it');
  assert.ok(week.cols[1].classes.has('is-today'));
  assert.ok(!week.cols[0].classes.has('is-today'), 'the grid is claiming two todays');
  assert.match(week.line.style.top, /^calc\(15\d(\.\d+)? \* var\(--min-h\)\)$/);

  // A grid the new day is not on has no honest place to draw "now".
  const stale = grid(['2026-08-11']);
  cal.tickNowLine();
  assert.equal(stale.line.parentNode, null, 'a line for a day not on screen must go');
});

/**
 * `paint()` runs on every board render, and the board now has a heartbeat — so
 * rewriting the status region unconditionally announces stale search results to
 * a screen reader on a timer, forever.
 */
test('the search status announces a change, not a repaint', () => {
  const search = fs.readFileSync(path.join(UI, 'views/search.js'), 'utf8');
  const paint = /function paint\(\)[\s\S]*?\n\}/m.exec(search);
  assert.ok(paint, 'paint is missing');
  assert.ok(!/statusNode\.textContent\s*=/.test(paint[0]),
    'paint writes the live region on every render');
  assert.match(paint[0], /announce\(statusNode/);

  const announce = /function announce\(node, text\)[\s\S]*?\n\}/m.exec(search);
  assert.ok(announce, 'announce is missing');
  assert.match(announce[0], /if \(announced === value\) return/, 'the guard must be on the text');
  assert.match(announce[0], /requestAnimationFrame/, 'the text must land after insertion');
});

/**
 * 'Check a token' reverted to the just-minted token on every repaint, so the
 * second press of Test checked something other than what was on screen.
 */
test('what was typed into the token test survives a repaint', () => {
  const src = fs.readFileSync(path.join(UI, 'views/ai-access.js'), 'utf8');
  const block = /function testBlock\(v\)[\s\S]*?\n  \}/m.exec(src);
  assert.ok(block, 'testBlock is missing');
  assert.ok(!/^\s*if \(revealed\) tokenInput\.value = revealed\.value;$/m.test(block[0]),
    'the field is still overwritten with the minted token on every repaint');
  assert.match(block[0], /if \(tokenDraft !== null\) tokenInput\.value = tokenDraft;/);
  assert.match(block[0], /addEventListener\('input'[\s\S]*?tokenDraft = tokenInput\.value/);
  // Module scope, not closure scope: the panel is rebuilt wholesale, so a draft
  // kept inside the builder would not survive the thing it exists to survive.
  assert.match(src, /^let tokenDraft = null;$/m);
  // Minting is the one write that is allowed to replace it.
  const mint = /async function mint\(label\)[\s\S]*?\n  \}/m.exec(src);
  assert.ok(mint, 'mint is missing');
  assert.match(mint[0], /tokenDraft = null;/);
});

/* ------------------------------------- 9. the setting that existed everywhere
                                            except where anyone could reach it */

/**
 * `requireTls` was stored by core/config.mjs, enforced by core/sources/imap.mjs
 * and forwarded by the sweep, the doctor and the mail-test route — and `grep -rn
 * requireTls ui/` matched nothing. A security setting nobody can see is not a
 * setting, and the account editor had no way to say "this bridge on my own
 * machine is deliberate" short of hand-editing config.json.
 *
 * The mapping is checked as behaviour because it is the whole of the risk: get
 * it backwards, or coerce a stray string, and Zelos quietly stops requiring
 * encryption for a real mail server on the public internet.
 */
test('the TLS choice maps to the three values config stores, and junk lands on the safe one', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const config = await import(fileUrl(ROOT, 'core/config.mjs'));

  assert.deepEqual(settings.TLS_CHOICES.map((c) => c.value), ['auto', 'require', 'allow']);
  for (const choice of settings.TLS_CHOICES) {
    assert.ok(choice.label.length > 0, choice.value);
    // The copy is about the password, not about the protocol. A user deciding
    // this should not have to know what STARTTLS is.
    assert.ok(!/STARTTLS|TLS handshake|cleartext/i.test(choice.label), choice.label);
  }

  assert.equal(settings.requireTlsFor('auto'), null);
  assert.equal(settings.requireTlsFor('require'), true);
  assert.equal(settings.requireTlsFor('allow'), false);
  // A select can only hand back its own values, but the direction of the
  // failure matters: anything unrecognised must resolve to "decide from the
  // host", never to permission.
  for (const junk of ['', 'false', 'true', null, undefined, 0, 'Allow']) {
    assert.equal(settings.requireTlsFor(junk), null, JSON.stringify(junk));
  }

  assert.equal(settings.tlsChoiceFor(true), 'require');
  assert.equal(settings.tlsChoiceFor(false), 'allow');
  // What every account saved before this setting existed says, and what a new
  // one gets: the default the config module itself ships.
  assert.equal(config.MAIL_ACCOUNT_DEFAULTS.requireTls, null);
  assert.equal(settings.tlsChoiceFor(null), 'auto');
  assert.equal(settings.tlsChoiceFor(undefined), 'auto');
  // A truthy string is not a boolean, and must not read as permission either.
  for (const junk of ['false', 'true', 0, 1, 'no']) {
    assert.equal(settings.tlsChoiceFor(junk), 'auto', JSON.stringify(junk));
  }
});

/**
 * The editor and the test button are pinned at the source because building the
 * form needs a layout engine, and the failure is in the wiring rather than in
 * any function: "Test the connection" composed its body by hand and left
 * `requireTls` out of it, so the one moment a user is told "this works" was the
 * moment least like the sweep that runs at 07:00.
 */
test('the mail editor can set requireTls, and the test connects under the same rule', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');

  // A control, actually placed in the returned form — not merely built.
  assert.match(form[0], /select\(TLS_CHOICES, \{ value: tlsChoiceFor\(draft\.requireTls\) \}\)/,
    'the editor must offer the three stored values');
  assert.match(form[0], /field\('Sending your password', tlsSelect/,
    'the control must be in the form, with a label about the password');

  // Both paths out of this form carry it, and both read the same control.
  const probe = /api\.testMail\(\{[\s\S]*?\}\)/m.exec(form[0]);
  assert.ok(probe, 'the testMail call is missing');
  assert.match(probe[0], /requireTls: requireTls\(\)/,
    'the connection test omits requireTls and so tests different rules than the sweep');
  // The account literal the save sends. It moved into a `patch` object when the
  // form learned to adopt identity.email, so this reads the literal rather than
  // the shape of the saveConfig call — the assertion is about what is in the
  // account, not about how many keys travel beside it.
  const save = /mail: \[\.\.\.others, \{[\s\S]*?\}\]/m.exec(form[0]);
  assert.ok(save, 'the saved account literal is missing');
  assert.match(save[0], /requireTls: requireTls\(\)/, 'the save drops what the editor chose');
  assert.match(form[0], /await saveConfig\(patch\)/, 'the assembled patch must actually be saved');

  // The blank a new account opens on is the config module's blank. A literal
  // `false` here would excuse cleartext for a host nobody has named yet.
  const blank = /editor\.replaceChildren\(mailForm\(\{[\s\S]*?\}, \{/m.exec(src);
  assert.ok(blank, 'the new-account literal is missing');
  assert.match(blank[0], /requireTls: null/, 'a new account must start on "decide from the address"');
});

/**
 * `identity.name` and `identity.email` had a schema, a validator, and readers in
 * the scorer and the prompt — and nothing a user could reach ever set them.
 * `grep identity ui/` returned one hit and it read `timezone`. No panel, no
 * onboarding step, no CLI flag; only a hand-crafted PUT or an edit to
 * config.json.
 *
 * Verified on a fresh home: `identity.email` stayed `''`, `sameEmail(a, '')` is
 * false for every message, and the +6 To: and −2 Cc: branches at
 * core/triage.mjs:434-435 never fired once. At the item cap that is not
 * cosmetic — a message written straight to the user was cut from the sweep
 * prompt entirely while newer Cc-only rollups survived. `identity.name` stayed
 * `''` too, so every prompt read "name: (not set — do not invent one)" and
 * every draft came back unsigned with nothing on screen to say why.
 *
 * Both ends are named here on purpose. WRITER: the You panel's
 * `saveConfig({ identity: … })`, and the mail form adopting the first account's
 * address. READER: `core/triage.mjs` `buildSweepPrompt`, whose behaviour is
 * asserted in test/triage.test.mjs, and `core/sweep.mjs` `directionOf`.
 */
test('Settings can set who you are, and the value has a reader on the other end', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');

  // The panel is reachable, not merely defined.
  const panels = /const PANELS = \[[\s\S]*?\];/m.exec(src);
  assert.ok(panels, 'PANELS is missing');
  assert.match(panels[0], /id: 'you'/, 'the You panel is not in the tab strip');
  assert.match(src, /if \(panel === 'you'\) body = youPanel\(\)/,
    'the tab exists but renderSettings never builds the panel');

  // It writes the two keys the readers read, and nothing else.
  const panel = /function youPanel\(\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(panel, 'youPanel is missing');
  assert.match(panel[0], /saveConfig\(\{ identity: \{ name: nameInput\.value\.trim\(\), email \} \}\)/,
    'the You panel does not persist name and email');
  // The timezone is resolved from the machine on every load, so writing it back
  // would freeze the zone the user was in the day they typed it.
  assert.ok(!/timezone:/.test(panel[0].replace(/'[^']*'|`[^`]*`/g, '')),
    'the panel persists a timezone, which core/config.mjs resolves at read time');

  // The default for an install that predates the panel.
  assert.equal(settings.defaultIdentityEmail({ mail: [{ enabled: true, user: 'me@example.com' }] }), 'me@example.com');
  assert.equal(
    settings.defaultIdentityEmail({ mail: [{ enabled: false, user: 'old@example.com' }, { enabled: true, user: 'me@example.com' }] }),
    'me@example.com',
    'a disabled account is not who you are',
  );
  assert.equal(settings.defaultIdentityEmail({ mail: [{ enabled: true, user: 'not-an-address' }] }), '',
    'a username that is not an address must not be offered as one — core/config.mjs would reject it');
  for (const empty of [null, undefined, {}, { mail: [] }, { mail: 'nope' }, { mail: [null] }]) {
    assert.equal(settings.defaultIdentityEmail(empty), '', JSON.stringify(empty));
  }

  // The second writer: saving a mailbox adopts its address when nothing is set,
  // so an install that has been running for months stops being wrong without
  // anyone having to find a new tab.
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');
  assert.match(form[0], /state\.config\?\.identity\?\.email/, 'the mail form never looks at what is already set');
  assert.match(form[0], /patch\.identity = \{ email: adopted \}/, 'the mail form does not adopt the address');
  assert.match(form[0], /!known &&/, 'an address the user already chose must not be overwritten');
  assert.match(form[0], /Zelos will also treat \$\{adopted\}/, 'adopting it silently is how this became invisible in the first place');

  // The readers, named rather than assumed.
  const triage = fs.readFileSync(path.join(ROOT, 'core/triage.mjs'), 'utf8');
  assert.match(triage, /const userEmail = str\(identity\.email\)/, 'core/triage.mjs no longer reads identity.email');
  assert.match(triage, /sameEmail\(a\?\.email, ctx\.userEmail\)\)\) score \+= 6/, 'the To: branch this feeds is gone');
  const sweep = fs.readFileSync(path.join(ROOT, 'core/sweep.mjs'), 'utf8');
  assert.match(sweep, /config\?\.identity\?\.email/, 'core/sweep.mjs no longer reads identity.email');
});

/**
 * `sentMailbox` is appended to every fetch by core/sweep.mjs's `mailboxesFor()`
 * and had no writer anywhere in `ui/` — the string appeared exactly once, in a
 * blank-account literal. The stored default is the bare word "Sent", which is
 * wrong for Gmail, Microsoft 365 and iCloud: three of the eight providers this
 * app hardcodes and the three largest. Reproduced against a Microsoft 365
 * folder set: `{label:"Work / Sent", ok:false, error:"Mailbox doesn't exist:
 * Sent"}` on every sweep forever, run still `ok:true`, doctor still "pass".
 *
 * WRITER: the field below, into `saveConfig({ mail: [...] })`. READER:
 * `mailboxesFor()` and `directionOf()` in core/sweep.mjs, plus the mail check in
 * core/doctor.mjs — pinned in test/doctor.test.mjs. The prefill's own source is
 * the SPECIAL-USE flag `listMailboxes()` has computed since the client was
 * written and which nothing outside a test had ever read.
 */
test('the mail editor can set the sent folder, and takes it from the server when asked', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');

  // A control, actually in the returned form, and actually saved.
  assert.match(form[0], /field\('Sent folder', sentInput/, 'the control is built but never placed');
  assert.match(form[0], /sentMailbox: sentInput\.value\.trim\(\)/, 'the save drops what the editor chose');
  // The three provider spellings, so nobody has to already know theirs.
  for (const spelling of ['\\[Gmail\\]/Sent Mail', 'Sent Items', 'Sent Messages']) {
    assert.match(form[0], new RegExp(spelling), `the hint does not name ${spelling}`);
  }

  // The prefill reads the flag off the test response.
  assert.match(form[0], /sentMailboxFromTest\(result\.mailboxes, sentInput\.value\)/,
    'the SPECIAL-USE flag is on the wire and in the response object with nowhere to land');

  const M365 = [
    { name: 'INBOX', specialUse: 'inbox' },
    { name: 'Sent Items', specialUse: 'sent' },
    { name: 'Drafts', specialUse: 'drafts' },
  ];
  assert.equal(settings.sentMailboxFromTest(M365, 'Sent'), 'Sent Items',
    'the default "Sent" is not on this server, so the flag has to win');
  assert.equal(settings.sentMailboxFromTest(M365, ''), 'Sent Items');
  // What the user typed wins — but only when the server actually has it. A name
  // the server does not have is a typo, and keeping it is how the whole defect
  // looked like nothing at all.
  assert.equal(settings.sentMailboxFromTest([...M365, { name: 'Archive/Sent', specialUse: null }], 'Archive/Sent'), 'Archive/Sent');
  assert.equal(settings.sentMailboxFromTest([{ name: 'INBOX' }, { name: 'Sent' }], 'Sent'), 'Sent',
    'a server with no SPECIAL-USE flags at all must not have the choice taken away');
  // Nothing to say is said with nothing: no flag and no typed name leaves it be.
  assert.equal(settings.sentMailboxFromTest([{ name: 'INBOX' }], ''), '');
  assert.equal(settings.sentMailboxFromTest([{ name: 'INBOX' }], 'Sent'), 'Sent');
  for (const junk of [null, undefined, 'not-an-array', 42]) {
    assert.equal(settings.sentMailboxFromTest(junk, 'Sent'), 'Sent', JSON.stringify(junk));
  }

  // The reader, named.
  const sweep = fs.readFileSync(path.join(ROOT, 'core/sweep.mjs'), 'utf8');
  assert.match(sweep, /account\.sentMailbox === 'string' \? account\.sentMailbox\.trim\(\)/,
    'core/sweep.mjs no longer reads sentMailbox, so this field writes to nothing');
});

/**
 * The tab strip set `role="tablist"`, `role="tab"` and `aria-selected` while the
 * panel had no `role="tabpanel"`, no `aria-labelledby`, and the tabs had no
 * `id` and no `aria-controls`. A control that announces "tab, selected" while
 * pointing at nothing is worse than a plain button: the user is told there are
 * eight tabs and given no way to find out what any of them controls.
 *
 * Finished rather than dropped, because `refocusSelectedTab()` in ui/app.js now
 * finds the pressed tab again through `[role="tab"][aria-selected="true"]` —
 * the roles carry the focus fix as well.
 */
test('the Settings tab strip is a whole tablist, not half of one', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const render = /export function renderSettings\(ctx\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(render, 'renderSettings is missing');

  // Ids that survive a rebuild. `nextId()` ticks on every render, which would
  // leave aria-labelledby pointing at the id the tab had one paint ago.
  assert.match(src, /const tabId = \(id\) => `settings-tab-\$\{id\}`/);
  assert.match(src, /const panelId = \(id\) => `settings-panel-\$\{id\}`/);

  assert.match(render[0], /id: tabId\(p\.id\)/, 'a tab with no id cannot be pointed at');
  assert.match(render[0], /'aria-selected': selected \? 'true' : 'false'/);
  // Only the live panel is in the document, so only the selected tab may claim
  // to control one: seven dangling references read as empty relationships.
  assert.match(render[0], /'aria-controls': selected \? panelId\(p\.id\) : null/);
  // Roving tabindex, so the strip is one tab stop with arrows inside it.
  assert.match(render[0], /tabindex: selected \? '0' : '-1'/);
  assert.match(render[0], /onkeydown: onTabKey/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(render[0], new RegExp(`'${key}'`), `${key} does nothing in the tablist`);
  }

  // The other half of the relationship.
  assert.match(render[0], /body\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(render[0], /body\.setAttribute\('id', panelId\(panel\)\)/);
  assert.match(render[0], /body\.setAttribute\('aria-labelledby', tabId\(panel\)\)/);

  // The ids the two halves use have to be the same ids, which is only true if
  // both go through the helpers rather than spelling the string out.
  assert.equal((src.match(/settings-tab-/g) ?? []).length, 1, 'the tab id is spelled out in more than one place');
  assert.equal((src.match(/settings-panel-/g) ?? []).length, 1, 'the panel id is spelled out in more than one place');
});

/**
 * The removal half of the midnight fix. `tickNowLine` dropped the line when the
 * new day was off screen and left `is-today` on the column that was today when
 * the grid was built — so a day grid showing the 12th, ticked at 00:03 on the
 * 13th, went on tinting the 12th and labelling it today.
 */
test('a now-line that leaves takes the today marker with it', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const cal = await import(fileUrl(UI, 'views/calendar.js'));

  const node = (day) => {
    const self = {
      dataset: day ? { day } : {},
      children: [],
      parentNode: null,
      classes: new Set(),
      style: {},
      classList: {
        add(c) { self.classes.add(c); },
        remove(c) { self.classes.delete(c); },
      },
      appendChild(child) {
        child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = self;
        self.children.push(child);
        return child;
      },
      remove() {
        const kids = self.parentNode?.children;
        if (kids) kids.splice(kids.indexOf(self), 1);
        self.parentNode = null;
      },
    };
    return self;
  };

  const grid = (dayKeys) => {
    const cols = dayKeys.map((d) => node(d));
    const line = node(null);
    cols[0].appendChild(line);
    cols[0].classList.add('is-today');
    const realDoc = globalThis.document;
    globalThis.document = {
      ...realDoc,
      querySelector: (sel) => (sel === '.cal-days .now-line' && line.parentNode ? line : null),
      querySelectorAll: (sel) => (sel === '.cal-days .cal-col' ? cols : []),
    };
    t.after(() => { globalThis.document = realDoc; });
    return { cols, line };
  };

  // A day grid built on the 12th, still open at three minutes past midnight.
  store.state.board = { ...store.state.board, now: '2026-08-12T23:30:00-04:00' };
  store.state.boardAt = Date.now() - 33 * 60_000;
  const mark = store.nowMark();
  assert.equal(mark.key, '2026-08-13', 'the premise of this test has moved');
  assert.ok(Math.abs(mark.minutes - 3) < 2, `00:03, not ${mark.minutes}`);

  const day = grid(['2026-08-12']);
  cal.tickNowLine();
  assert.equal(day.line.parentNode, null, 'the line has no honest place on this grid');
  assert.ok(!day.cols[0].classes.has('is-today'),
    'the 12th is still being drawn as today, on the 13th');

  // The other way out: no reading of "now" at all. The marker goes with it,
  // because it was only ever a claim about a clock this grid can no longer read.
  const orphan = grid(['2026-08-12', '2026-08-13']);
  store.state.board = { ...store.state.board, now: null };
  assert.equal(store.nowMark().key, null, 'the premise of this test has moved');
  cal.tickNowLine();
  assert.equal(orphan.line.parentNode, null);
  assert.ok(!orphan.cols.some((c) => c.classes.has('is-today')), 'a today marker outlived its clock');
});
