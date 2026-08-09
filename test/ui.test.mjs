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
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

const core = await import(path.join(ROOT, 'core/time.mjs'));
const ui = await import(path.join(UI, 'lib/time.js'));
const fmt = await import(path.join(UI, 'lib/format.js'));

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
      addEventListener() {},
      createElement() { throw new Error('these tests must not build DOM'); },
    };
  }
}

test('itemsInBucket keeps snoozed rows off the panes; snoozedItems carries them', async () => {
  stubBrowserGlobals();
  const store = await import(path.join(UI, 'lib/store.js'));
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

test('setItemState carries the snooze deadline, and only when one was chosen', async (t) => {
  stubBrowserGlobals();
  const { api } = await import(path.join(UI, 'lib/api.js'));
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
  const items = await import(path.join(UI, 'lib/items.js'));
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
  const store = await import(path.join(UI, 'lib/store.js'));
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
  const store = await import(path.join(UI, 'lib/store.js'));
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
  // The navigation handler is the only place allowed to move the scroll: a
  // deferred board refresh yanking the page to the top is its own bug.
  assert.equal(app.split('scrollTo').length - 1, 1);
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

test('no rule still branches on a theme attribute that is never set', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  // There is one theme. A dead `[data-theme=…]` override is a rule that looks
  // like it is handling a case and is not.
  assert.ok(!/\[data-theme[~^|*$]?=/.test(css), 'app.css still branches on data-theme');
  assert.ok(!/data-theme=/.test(html), 'index.html still carries a data-theme attribute');
});
