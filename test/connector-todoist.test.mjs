/**
 * test/connector-todoist.test.mjs — the Todoist connector.
 *
 * This file exists because the connector shipped with none, and the two worst
 * defects it shipped with were both of a kind that only a behavioural test can
 * see. The shape check in test/connectors.test.mjs proves the manifest DECLARES
 * an origin and a budget; it cannot notice that the URL under that origin
 * addresses a parameter the vendor deleted, and it cannot notice that a pure
 * function's answer depends on which timezone the laptop is set to. So the two
 * sections that carry the most weight here are:
 *
 *  1. THE WIRE SHAPE IS PINNED, NOT DESCRIBED. Todoist's API v1 moved filtering
 *     off `GET /tasks` onto `GET /tasks/filter` and renamed the parameter from
 *     `filter` to `query`. The connector sent `GET /api/v1/tasks?filter=…`,
 *     which is a request Todoist ANSWERS — with every active task in the
 *     account, the user's whole selection criterion dropped in silence. Nothing
 *     threw. The only thing that can catch that class of bug is a test that
 *     reads the path and the parameter names off a real socket, which is what
 *     the mock below records.
 *
 *  2. THE DAY KEY MUST NOT DEPEND ON THE MACHINE. `dueDayKey` is the one
 *     distinction this connector exists to make — "overdue" against "due today"
 *     — and a due datetime with no offset used to be resolved through
 *     `new Date()`, i.e. against the HOST's zone rather than the user's. Two
 *     tests attack it from opposite directions: one varies the USER's zone and
 *     demands the answer not move (which is red on any machine), and one varies
 *     the MACHINE's zone and demands the same, which is the reviewer's original
 *     measurement reproduced.
 *
 * EVERY SOCKET GOES TO 127.0.0.1, on the pattern test/connector-fireflies.test
 * .mjs established. The connector addresses the real https://api.todoist.com
 * and the transport's origin allow-list is enforced against that real origin;
 * only `createHttp`'s `fetchImpl` seam — the same one core/doctor.mjs uses —
 * decides which socket the accepted request lands on. `globalThis.fetch` is
 * wrapped for the length of the run so that if an edit ever forgets, this suite
 * says so instead of contacting Todoist from whatever machine is running it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/* Set before the modules that read it are evaluated, which is why every import
   below is dynamic. `core/log.mjs` fixes its level at import time, and an
   unforced secrets backend would detect the operator's own login keychain no
   matter where ZELOS_HOME points. */
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-todoist-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';

/* ------------------------------------------------------- outbound guard */

const realFetch = globalThis.fetch;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  const url = new URL(raw);
  if (!LOOPBACK.test(url.hostname)) {
    throw new Error(`this suite must not contact ${url.host} — every endpoint has to be a local mock`);
  }
  return realFetch(input, init);
};

const connector = (await import('../core/connectors/todoist.mjs')).default;
const {
  ENDPOINT, QUERY_PARAM,
  dueDayKey, dueValueOf, dueness, duePhrase, priorityLabel, readPage, todoistError,
} = await import('../core/connectors/todoist.mjs');
const { AuthError, RateLimitError, createHttp } = await import('../core/connectors/http.mjs');
const { assertShape } = await import('../core/connectors/index.mjs');
const { open, close, migrate, upsertMessages, listMessages } = await import('../core/db.mjs');
const { localTimezone, todayKey } = await import('../core/time.mjs');
const { diagnose } = await import('../core/doctor.mjs');

let seq = 0;
const openDbs = [];

function freshDb() {
  const db = open(path.join(HOME_ROOT, `td${seq++}.db`));
  migrate(db);
  openDbs.push(db);
  return db;
}

const HOST_TZ = process.env.TZ;

test.after(() => {
  globalThis.fetch = realFetch;
  if (HOST_TZ === undefined) delete process.env.TZ; else process.env.TZ = HOST_TZ;
  for (const db of openDbs) close(db);
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const TOKEN = 'td_0a91c4f7e2b6';

/* The user is in New York and the sweep has already zoned `now`
   (core/sweep.mjs:533 calls `nowISO(tz)`), so the day under test is the 11th. */
const TZ = 'America/New_York';
const NOW = '2026-08-11T09:00:00-04:00';
const TODAY = '2026-08-11';

const TASK_LATE = {
  id: '6X1a',
  content: 'File the retainage release',
  description: 'The GC will not release without it.',
  priority: 4,
  url: 'https://app.todoist.com/app/task/6X1a',
  labels: ['paperwork'],
  due: { date: '2026-08-09', string: '9 Aug' },
};

const TASK_TODAY = {
  id: '6X2b',
  content: 'Water the plants',
  priority: 1,
  url: 'https://app.todoist.com/app/task/6X2b',
  due: { date: TODAY, string: 'every day', is_recurring: true },
};

/**
 * The shape that shipped broken: a time with NO offset.
 *
 * Todoist sends this for a task given a time in a workspace with no fixed zone,
 * and it is a wall clock — the digits the user typed. `due.date` is the bare day
 * beside it, and `dueValueOf` deliberately prefers `datetime`, so this fixture
 * is the one that actually exercises the third branch of `dueDayKey`.
 */
const TASK_FLOATING = {
  id: '6X3c',
  content: 'Call the inspector',
  priority: 3,
  due: { date: '2026-08-12', datetime: '2026-08-12T01:00:00', string: '12 Aug 1:00am' },
};

/** A real instant, which needs exactly the conversion the two above must not get. */
const TASK_TONIGHT = {
  id: '6X4d',
  content: 'Submit the change order',
  priority: 2,
  // 01:00Z on the 12th is nine in the evening on the 11th in New York.
  due: { date: '2026-08-12', datetime: '2026-08-12T01:00:00Z', string: '12 Aug' },
};

const page = (results, next = null) => JSON.stringify({ results, next_cursor: next });

/* ------------------------------------------------------------------ *
 * The mock, the transport and the ctx
 * ------------------------------------------------------------------ */

/**
 * A Todoist-shaped endpoint on 127.0.0.1 that records what it was asked.
 *
 * `answer` is either a string or `(nth, url) => string | {status, body}`, so a
 * test can make page two differ from page one — which is what gives the paging
 * assertions teeth.
 */
async function todoistServer(t, answer, { status = 200, headers = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({
        method: req.method,
        url: req.url,
        path: url.pathname,
        params: url.searchParams,
        query: Object.fromEntries(url.searchParams),
        headers: { ...req.headers },
      });
      const out = typeof answer === 'function' ? answer(requests.length, url) : answer;
      const shaped = typeof out === 'string' ? { status, body: out } : { status, ...out };
      res.writeHead(shaped.status, { 'content-type': 'application/json', ...headers, ...(shaped.headers || {}) });
      res.end(shaped.body ?? '');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, requests };
}

/**
 * The real transport, built from the real manifest, pointed at the mock.
 *
 * `origins`, `limits` and `credential` all come off the connector, so flipping
 * any of them turns these tests red. The `fetchImpl` swap happens AFTER the
 * allow-list has already accepted `https://api.todoist.com`, so it cannot widen
 * what is reachable; it only decides which socket the accepted request lands on.
 */
function transportFor(mock, { secret = TOKEN } = {}) {
  return createHttp({
    origins: connector.origins,
    limits: connector.limits,
    credential: connector.credential,
    secret,
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      return realFetch(`${mock.origin}${url.pathname}${url.search}`, init);
    },
  });
}

function ctxFor(httpClient, over = {}) {
  const emitted = [];
  const ctx = {
    source: {
      id: 's_td',
      enabled: true,
      label: 'My tasks',
      type: 'todoist',
      keyRef: 'todoist.s_td',
      settings: {},
    },
    label: 'My tasks',
    secret: TOKEN,
    cursor: null,
    timezone: TZ,
    identityEmail: 'nemo@example.com',
    now: NOW,
    emit: (message, done = 0, total = 0) => emitted.push({ message, done, total }),
    signal: undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: httpClient,
    ...over,
  };
  return { ctx, emitted };
}

/** One collect against a one-page answer, for the tests that only want the rows. */
async function collectOnce(t, tasks, over = {}) {
  const mock = await todoistServer(t, page(tasks));
  const { ctx, emitted } = ctxFor(transportFor(mock), over);
  const result = await connector.collect(ctx);
  return { mock, result, emitted, part: result.parts[0], rows: result.parts[0].rows };
}

/**
 * Run `fn` with the MACHINE in `zone`, then put the machine back.
 *
 * Node applies a `process.env.TZ` change to both `new Date(…)` parsing and
 * `Intl`, which is the only way to reproduce the defect this guards: the bug was
 * that an offset-less due time was resolved against the host's zone. The
 * assertion below is not ceremony — if a platform ever stops honouring the
 * change, this test would otherwise pass while measuring nothing at all.
 */
async function withMachineZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    assert.equal(localTimezone(), zone,
      `this test measures what the MACHINE's zone does to a due date, and setting it to ${zone} did not take`);
    return await fn();
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
}

/* ================================================================== *
 * 1. The manifest
 * ================================================================== */

test('the manifest satisfies the connector interface and declares the host it reads', () => {
  assert.doesNotThrow(() => assertShape(connector));

  assert.equal(connector.type, 'todoist');
  assert.equal(connector.configKey, 'sources');
  assert.equal(connector.sink, 'messages', 'an obligation is a message-shaped row, not a calendar entry');
  assert.notEqual(connector.graphql, true, 'this is a GET API; declaring graphql would open postJson for nothing');

  assert.deepEqual(connector.origins, ['https://api.todoist.com']);
  assert.ok(connector.origins.includes(new URL(ENDPOINT).origin),
    `the connector reads ${ENDPOINT}, which its own allow-list would refuse`);

  // Non-negotiable #3: the user mints the credential and it travels in a header
  // where core/log.mjs can redact it. There is no `as: 'query'` to reach for.
  assert.equal(connector.credential.required, true);
  assert.equal(connector.credential.send.as, 'header');
  assert.equal(connector.credential.send.prefix, undefined,
    'Todoist only accepts the prefixed form; linear.mjs needs `prefix: \'\'` and copying one manifest onto the other breaks both');
});

test('the row cap and the keep field cannot disagree, and the budget covers a full page walk', () => {
  const maxItems = connector.fields.find((f) => f.name === 'maxItems');
  assert.equal(maxItems.max, connector.limits.maxRows,
    'a user allowed to keep more rows than core/sweep.mjs will store is a silent trim');

  /* The budget's only real job is to stop a paging loop that has gone wrong, so
     it has to be comfortably above what one honest sweep costs — three pages
     plus a `zelos doctor` probe, several times over. */
  assert.ok(connector.limits.budget.calls >= 12,
    `a budget of ${connector.limits.budget.calls} cannot fund repeated three-page sweeps inside one window`);
  assert.equal(connector.limits.budget.perMs, 15 * 60 * 1000);
});

/* ================================================================== *
 * 2. The endpoint — the user's filter has to be ASKED for
 * ================================================================== */

test('collect asks /api/v1/tasks/filter and sends the filter as `query`', async (t) => {
  /* THE DEFECT THIS PINS. API v1 removed the `filter` parameter from
     `GET /tasks` and moved filtering to `GET /tasks/filter` with `query=`
     (Todoist's v1 migration guide; Doist's own SDK has TASKS_FILTER_PATH =
     "tasks/filter" and sends query/lang/limit). The connector sent
     `GET /api/v1/tasks?filter=overdue+%7C+today` — a request Todoist ANSWERS,
     with every active task in the account, because it ignores a parameter it
     does not know. So the failure was silent by construction: no throw, no
     empty read, just the wrong tasks under a source that promises "due today or
     overdue". Only the path and the parameter NAMES can catch it. */
  const { mock } = await collectOnce(t, [TASK_LATE]);

  assert.equal(mock.requests.length, 1);
  const req = mock.requests[0];

  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/api/v1/tasks/filter',
    'the plain /api/v1/tasks endpoint takes project_id/section_id/label/ids and no filter of any kind');
  assert.equal(req.query.query, 'overdue | today',
    `the filter expression must ride on \`${QUERY_PARAM}\`; \`filter\` is the REST v2 name and v1 deleted it`);
  assert.equal(req.params.has('filter'), false,
    'sending the removed parameter is worse than sending nothing: Todoist answers it with the whole account');
  assert.equal(req.query.limit, '200', 'the SDK types this endpoint\'s limit as 1…200');
  assert.equal(req.params.has('cursor'), false, 'the first page has no cursor to resume from');
});

test('the filter the user typed is the filter that is sent', async (t) => {
  const mine = '(overdue | today) & assigned to: me';
  const { mock, rows } = await collectOnce(t, [TASK_LATE], {
    source: { id: 's_td', label: 'My tasks', type: 'todoist', settings: { filter: mine } },
  });

  assert.equal(mock.requests[0].query.query, mine,
    'the whole premise of the editable field is that a shared workspace can narrow the read without a release');
  assert.equal(rows.length, 1);
});

test('the token travels in the Authorization header and never in the URL', async (t) => {
  const { mock } = await collectOnce(t, []);
  const req = mock.requests[0];

  assert.equal(req.headers.authorization, `Bearer ${TOKEN}`,
    'the manifest declares credential.send and the transport is what attaches it');
  assert.doesNotMatch(req.url, new RegExp(TOKEN),
    'a token in a query string lands in the vendor\'s access log, in every proxy\'s, and in ours');
});

test('the transport built from this manifest refuses any other host', async (t) => {
  const mock = await todoistServer(t, page([]));
  const client = transportFor(mock);

  await assert.rejects(
    client.get(`${mock.origin}/api/v1/tasks/filter`),
    /not one of this source's addresses/,
  );
  assert.equal(mock.requests.length, 0,
    'the allow-list is checked before a socket exists, so nothing should have arrived');
});

/* ================================================================== *
 * 3. The day key — "overdue" against "due today"
 * ================================================================== */

test('a due datetime with no offset is a WALL CLOCK, so no zone may move it', () => {
  /* THE HOST-INDEPENDENT PROOF, and the one that is red on every machine.
     `2026-08-12T01:00:00` carries no offset, so it names no instant — it is the
     digits the user typed. Read it through `new Date()` and it acquires an
     instant from whatever zone is nearby, and re-expressing THAT in two zones
     25 hours apart necessarily lands on two different days. Kiritimati is
     UTC+14 and Niue is UTC−11; the old code answered them one day apart no
     matter what the machine was set to. A wall clock has one answer. */
  const floating = '2026-08-12T01:00:00';
  assert.equal(dueDayKey(floating, 'Pacific/Kiritimati'), '2026-08-12');
  assert.equal(dueDayKey(floating, 'Pacific/Niue'), '2026-08-12');
  assert.equal(dueDayKey(floating, 'Pacific/Kiritimati'), dueDayKey(floating, 'Pacific/Niue'),
    'a due time with no offset has no instant to convert, so naming a different zone cannot move its day');

  // Late-evening is the mirror case: it must not slide FORWARD either.
  assert.equal(dueDayKey('2026-08-11T23:00:00', 'Pacific/Kiritimati'), TODAY);
  assert.equal(dueDayKey('2026-08-11T23:00:00', 'Pacific/Niue'), TODAY);
});

test('the machine\'s own zone cannot move a due day', async () => {
  /* The reviewer's measurement, reproduced: one pure function, identical
     arguments, only the machine varied. core/sweep.mjs:135-138 supports
     identity.timezone and the laptop's zone differing on purpose — a machine
     set to UTC belonging to somebody in New York is an ordinary thing — so any
     answer that moves with the machine is wrong for that user by a whole day.
     One day early is `Overdue by 1 day`, a `\Flagged` row and +10 in
     scoreInbound: the model told an obligation is late when it is not. */
  const cases = [
    ['2026-08-12T01:00:00', '2026-08-12'],  // floating, the shape that shipped broken
    ['2026-08-11T23:00:00', TODAY],         // floating, the mirror direction
    ['2026-08-12', '2026-08-12'],           // a bare date is a day and always was
    ['2026-08-12T01:00:00Z', TODAY],        // an instant, which DOES depend on the reader's zone
  ];
  for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    await withMachineZone(zone, () => {
      for (const [raw, expected] of cases) {
        assert.equal(dueDayKey(raw, TZ), expected,
          `dueDayKey(${JSON.stringify(raw)}, '${TZ}') answered differently with the machine in ${zone}`);
      }
    });
  }
});

test('a due datetime that DOES carry an offset is still converted to the reader\'s zone', () => {
  /* The half that must not be lost while fixing the other one. 01:00Z on the
     12th is nine in the evening on the 11th in New York; reading the day off
     the string calls a task due tonight "due tomorrow" and drops it out of
     today. */
  assert.equal(dueDayKey('2026-08-12T01:00:00Z', TZ), TODAY);
  assert.equal(dueDayKey('2026-08-11T21:00:00-04:00', TZ), TODAY);
  assert.equal(dueDayKey('2026-08-12T01:00:00Z', 'Asia/Tokyo'), '2026-08-12');
  assert.equal(dueDayKey('', TZ), null);
  assert.equal(dueDayKey('sometime tuesday', TZ), null);
});

test('dueValueOf prefers the value that carries a time', () => {
  assert.equal(dueValueOf(TASK_FLOATING), '2026-08-12T01:00:00',
    'a task with a time on it has BOTH, and the bare day throws away the deadline that makes it urgent');
  assert.equal(dueValueOf(TASK_LATE), '2026-08-09');
  assert.equal(dueValueOf({}), '');
  assert.equal(dueValueOf(null), '');
});

test('the three due shapes each reach the board as the right sentence', async (t) => {
  /* End to end, with the machine deliberately somewhere the user is not — which
     is the whole configuration the defect needed. Under the old code the
     floating task read "Due today" from here and took the due-today count with
     it. */
  await withMachineZone('UTC', async () => {
    const { rows } = await collectOnce(t, [TASK_LATE, TASK_TODAY, TASK_FLOATING, TASK_TONIGHT]);
    const say = Object.fromEntries(rows.map((r) => [r.subject, r.snippet]));

    assert.match(say['File the retainage release'], /^Overdue by 2 days — was due 2026-08-09/);
    assert.match(say['Water the plants'], /^Due today, 2026-08-11/);
    assert.match(say['Submit the change order'], /^Due today, 2026-08-11/,
      'an instant at 01:00Z is nine in the evening the day before in New York');
    assert.match(say['Call the inspector'], /^Due in 1 day, 2026-08-12/,
      'a floating 1am on the 12th is the 12th for the person who typed it, wherever the laptop is');
  });
});

test('overdue rows are flagged and due-today rows are not', async (t) => {
  const { rows } = await collectOnce(t, [TASK_LATE, TASK_TODAY]);
  const flags = Object.fromEntries(rows.map((r) => [r.subject, r.flags]));

  assert.deepEqual(flags['File the retainage release'], ['\\Flagged'],
    '`\\Flagged` is +10 in scoreInbound, which is what keeps an overdue row alive when the context budget bites');
  assert.deepEqual(flags['Water the plants'], []);
  assert.equal(rows.every((r) => !r.flags.includes('\\Seen')), true,
    'an open task is unhandled, which is what the mark means');
});

test('duePhrase never lets overdue and due-today look alike', () => {
  assert.equal(duePhrase({ key: TODAY, overdueDays: 0 }), 'Due today, 2026-08-11');
  assert.equal(duePhrase({ key: '2026-08-10', overdueDays: 1 }), 'Overdue by 1 day — was due 2026-08-10');
  assert.equal(duePhrase({ key: '2026-08-04', overdueDays: 7 }), 'Overdue by 7 days — was due 2026-08-04');
  assert.equal(duePhrase({ key: '2026-08-12', overdueDays: -1 }), 'Due in 1 day, 2026-08-12');
  assert.equal(duePhrase({ key: null, overdueDays: null }), 'No due date');
});

test('the API priority number is reported as the label the user sees, not the number', () => {
  /* Note 2 in the connector: in the API 4 is the most urgent and 1 is the
     default; in the app those are "P1" and "P4". Linear runs the other way, so
     a helper shared between the two files would rank one of them upside down. */
  assert.equal(priorityLabel(4), 'P1');
  assert.equal(priorityLabel(3), 'P2');
  assert.equal(priorityLabel(2), 'P3');
  assert.equal(priorityLabel(1), '', 'every task carries 1, so a board full of "P4" says less than one that stays quiet');
  assert.equal(priorityLabel(undefined), '');
  assert.equal(priorityLabel('nonsense'), '');
});

test('the most overdue is emitted first, because a cap keeps whatever came first', async (t) => {
  /* core/sweep.mjs:717 truncates with `kept.slice(0, maxRows)` and the connector
     does the same, so emission order decides which obligations survive. Todoist
     returns tasks in ITS order — the fixture is handed over in exactly the wrong
     one. */
  const { rows } = await collectOnce(t, [TASK_FLOATING, TASK_TODAY, TASK_LATE]);
  assert.deepEqual(rows.map((r) => r.subject), [
    'File the retainage release',   // 2 days late
    'Water the plants',             // due today
    'Call the inspector',           // due tomorrow
  ]);
});

/* ================================================================== *
 * 4. Paging
 * ================================================================== */

test('a second page is read, resumed from the cursor the first one gave', async (t) => {
  /* This is also the regression guard for the transport fix at ffda7ee: a
     missing `x-ratelimit-remaining` used to read as "zero calls remaining" and
     mark the whole budget spent on the first response, so page two was refused
     and this connector could never reach it. The mock deliberately sends no
     rate-limit headers, which is what Todoist does. */
  const mock = await todoistServer(t, (nth) => (nth === 1
    ? page([TASK_LATE], 'cur_2')
    : page([TASK_TODAY])));
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(mock.requests.length, 2, 'the first page offered a cursor and it was not followed');
  assert.equal(mock.requests[0].params.has('cursor'), false);
  assert.equal(mock.requests[1].query.cursor, 'cur_2');
  assert.equal(mock.requests[1].query.query, 'overdue | today', 'the filter has to survive the second page too');
  assert.deepEqual(result.parts[0].rows.map((r) => r.subject).sort(),
    ['File the retainage release', 'Water the plants']);
  assert.equal(result.parts[0].note, null, 'a complete two-page read has nothing to report');
});

test('a cursor that stops advancing cannot multiply the rows', async (t) => {
  /* MAX_PAGES bounds the REQUEST count; it never bounded the ROW set. Measured
     before the fix against a server holding distinct tasks behind a
     non-advancing cursor: the connector emitted a full keep-budget of rows
     carrying a fraction as many distinct ids, `upsertMessages` collapsed them,
     and the difference was real obligations that never reached the board —
     under a note that blamed urgency. */
  const held = [TASK_LATE, TASK_TODAY, TASK_FLOATING];
  const mock = await todoistServer(t, () => page(held, 'stuck'));
  const { ctx } = ctxFor(transportFor(mock));

  const { rows, note } = (await connector.collect(ctx)).parts[0];

  assert.equal(mock.requests.length, 3, 'MAX_PAGES is what stops a cursor that never advances');
  assert.equal(rows.length, 3, `the same page three times produced ${rows.length} rows`);
  assert.equal(new Set(rows.map((r) => r.messageId)).size, 3);
  assert.doesNotMatch(note ?? '', /least urgent were dropped/,
    'nothing was dropped for being least urgent — there were only three tasks');
});

test('running out of pages is reported as never fetched, not as least urgent', async (t) => {
  /* The note used to say, as fact, that what it lost was the least urgent. That
     is true of the keep-cap, which slices a SORTED list. It is false of a
     stopped page walk: Todoist returns tasks in its own order, so the most
     overdue task in the account may be among the ones never asked for. Here the
     keep-cap never fires at all — before the fix this loss produced no note
     whatsoever, which is the silent version of the same lie. */
  let n = 0;
  const mock = await todoistServer(t, () => {
    n += 1;
    return page([{ ...TASK_TODAY, id: `p${n}` }], `cur_${n + 1}`);
  });
  const { ctx } = ctxFor(transportFor(mock));

  const { rows, note } = (await connector.collect(ctx)).parts[0];

  assert.equal(mock.requests.length, 3);
  assert.equal(rows.length, 3);
  assert.ok(note, 'the page walk stopped with tasks still unread and said nothing at all about it');
  assert.match(note, /never fetched/);
  assert.match(note, /not necessarily the least urgent/);
  assert.doesNotMatch(note, /least urgent were dropped/);
});

test('a page that fails after one that succeeded keeps the rows already in hand', async (t) => {
  /* The connector-side half of the budget defect. A throw from page two used to
     discard page one as well, so a two-page sweep stored ZERO rows including the
     page that arrived intact, and the user was told an allowance was spent
     rather than that some of their tasks were missing. */
  const mock = await todoistServer(t, (nth) => (nth === 1
    ? page([TASK_LATE, TASK_TODAY], 'cur_2')
    : { status: 500, body: '{"error":"Internal Server Error"}' }));
  const { ctx } = ctxFor(transportFor(mock));

  const { rows, note } = (await connector.collect(ctx)).parts[0];

  assert.equal(rows.length, 2, 'the page that arrived intact was thrown away with the one that failed');
  assert.match(note, /stopped answering part-way/);
  assert.match(note, /not necessarily the least urgent/);
});

test('a failure with nothing in hand is still a failure', async (t) => {
  /* The other side of the rescue above: salvaging is only honest when there is
     something to salvage. An empty read reported as success is the
     "nothing happened today" lie this product exists to avoid. */
  const mock = await todoistServer(t, { status: 500, body: '{"error":"Internal Server Error"}' });
  const { ctx, emitted } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), /returned 500/);
  assert.deepEqual(emitted, [], 'a failed read must not report a count of zero tasks');
});

test('a revoked token on page two propagates instead of becoming a footnote', async (t) => {
  /* The one error whose CLASS is load-bearing: core/sweep.mjs keys a six-hour
     rest on AuthError. A dead credential downgraded to "some tasks are missing"
     would be retried every sweep forever while the board quietly stopped
     updating, which is worse than losing one page. */
  const mock = await todoistServer(t, (nth) => (nth === 1
    ? page([TASK_LATE], 'cur_2')
    : { status: 401, body: '{"error":"Invalid token"}' }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof AuthError, `came back as ${err.constructor.name}`);
    return true;
  });
});

/* ================================================================== *
 * 5. The row and the database contract
 * ================================================================== */

test('a task with no id is dropped and counted, never given a colliding row id', async (t) => {
  /* `todoist:task:` is the messageId EVERY id-less task would get, so they all
     hash to one messageRowId and overwrite each other: rows handed to
     upsertMessages, fewer rows in the database, an obligation gone with no
     error and the full count still reported to the board. Driven against the
     REAL upsert, because the row id is the thing under test. */
  const { rows, part } = await collectOnce(t, [
    TASK_LATE,
    { ...TASK_TODAY, id: '' },
    { ...TASK_FLOATING, id: undefined },
  ]);

  assert.equal(rows.length, 1,
    `two id-less tasks were given rows: ${rows.map((r) => r.messageId).join(', ')}`);
  assert.equal(rows[0].messageId, 'todoist:task:6X1a');
  assert.equal(rows.some((r) => r.messageId === 'todoist:task:'), false);
  assert.ok(part.note, 'tasks were discarded and the note said nothing');
  assert.match(part.note, /2 tasks arrived with no id/);

  const db = freshDb();
  const stored = upsertMessages(db, rows.map((r) => ({ ...r, sourceId: 's_td' })));
  assert.equal(stored.inserted, rows.length,
    'every row emitted has to survive the upsert; a shortfall is one row overwriting another');
});

test('a row never mentions `uid`, and two sweeps of the same tasks insert them once', async (t) => {
  /* THE RULE THAT HAS ALREADY COST THIS PROJECT TWICE. core/db.mjs:384 reads
     `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes
     0 while an OMITTED uid stays null — two different `messageRowId`s for the
     same task. A connector flipping between them re-inserts every task it has
     ever seen, on every sweep, forever.

     Asserting the key is absent is half of it. The other half is driving the
     real `upsertMessage` twice and watching the second sweep insert nothing,
     which is the only assertion that can see a row id at all. */
  const mock = await todoistServer(t, page([TASK_LATE, TASK_TODAY, TASK_FLOATING]));
  // A transport per sweep, because that is what core/sweep.mjs does: createHttp
  // is built fresh inside the per-source task on every sweep.
  const sweep = async () => (await connector.collect(ctxFor(transportFor(mock)).ctx)).parts[0].rows;

  const first = await sweep();
  for (const row of first) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'uid'), false,
      '`uid: null` and an omitted uid hash to different row ids — a task has no integer identity, so the key must be absent');
  }

  const db = freshDb();
  const stamp = (rows) => rows.map((r) => ({ ...r, sourceId: 's_td' }));
  assert.equal(upsertMessages(db, stamp(first)).inserted, 3);

  const second = await sweep();
  assert.equal(upsertMessages(db, stamp(second)).inserted, 0,
    'the same task was inserted a second time — the row id is not stable across sweeps');
  assert.equal(listMessages(db, { sourceId: 's_td' }).length, 3);
});

test('a recurring task keeps one row as its due date moves', async (t) => {
  /* Note 3 in the connector: finish "water the plants" and tomorrow's
     occurrence comes back as the SAME task id with a new due date. One standing
     obligation, re-armed, updating one row in place — not a new row every day
     forever. */
  const db = freshDb();
  const stamp = (rows) => rows.map((r) => ({ ...r, sourceId: 's_td' }));

  const monday = await collectOnce(t, [TASK_TODAY]);
  assert.equal(upsertMessages(db, stamp(monday.rows)).inserted, 1);

  const tuesday = await collectOnce(t, [{ ...TASK_TODAY, due: { ...TASK_TODAY.due, date: '2026-08-12' } }]);
  assert.equal(upsertMessages(db, stamp(tuesday.rows)).inserted, 0);
  assert.equal(listMessages(db, { sourceId: 's_td' }).length, 1);
});

test('the row says who it is for, where it came from and what it repeats', async (t) => {
  const { rows, emitted } = await collectOnce(t, [TASK_LATE, TASK_TODAY]);
  const late = rows.find((r) => r.subject === 'File the retainage release');
  const plants = rows.find((r) => r.subject === 'Water the plants');

  assert.equal(late.folder, 'Todoist');
  assert.equal(late.direction, 'in');
  assert.deepEqual(late.from, { name: 'Todoist', email: '' });
  assert.deepEqual(late.to, [{ name: '', email: 'nemo@example.com' }],
    'saying the list is the user\'s own earns scoreInbound\'s "addressed to you" credit');
  assert.equal(late.date, NOW,
    'the DUE date here would fall off core/db.mjs:441\'s `sent_at >= sinceISO` filter — the most overdue row is the one the model would never see');
  assert.match(late.text, /app\.todoist\.com\/app\/task\/6X1a/);
  assert.match(late.text, /paperwork/);
  assert.match(late.snippet, /P1$/, 'priority 4 in the API is P1 to the person reading it');
  assert.match(plants.snippet, /repeats every day/,
    'Todoist\'s own phrasing is the only place a recurrence rule is legible');
  assert.deepEqual(emitted, [{ message: 'My tasks: 1 overdue, 1 due today', done: 2, total: 2 }]);
});

test('a completed task never reaches the board', async (t) => {
  const { rows } = await collectOnce(t, [
    { ...TASK_LATE, is_completed: true },
    { ...TASK_TODAY, checked: true },
    TASK_FLOATING,
  ]);
  assert.deepEqual(rows.map((r) => r.subject), ['Call the inspector'],
    'a checked task on the board is a promise the product broke');
});

test('the keep cap trims the least urgent, and says how many and why', async (t) => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    ...TASK_TODAY, id: `k${i}`, content: `Task ${i}`, due: { date: `2026-08-0${i + 1}` },
  }));
  const { rows, part } = await collectOnce(t, many, {
    source: { id: 's_td', label: 'My tasks', type: 'todoist', settings: { maxItems: 3 } },
  });

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.subject), ['Task 0', 'Task 1', 'Task 2'],
    'ranked is SORTED before it is sliced, which is what makes "least urgent" a true statement here');
  assert.match(part.note, /keeps 3 — the 5 least urgent were dropped/);
  assert.match(part.note, /Raise "Tasks to keep"/);
});

test('an empty list is an answer, not a failure', async (t) => {
  /* "You have nothing due" and "the read failed" must never look alike: one is
     a fact about the day and the other is a fact about Zelos. */
  const { rows, part, emitted } = await collectOnce(t, []);
  assert.deepEqual(rows, []);
  assert.equal(part.note, null);
  assert.equal(part.error, null);
  assert.deepEqual(emitted, [{ message: 'My tasks: 0 overdue, 0 due today', done: 0, total: 0 }]);
});

test('no cursor is carried between sweeps', async (t) => {
  /* The Todoist cursor paginates ONE answer and is spent when the answer ends.
     Holding it would ask for page two of a list that no longer exists. */
  const mock = await todoistServer(t, page([TASK_LATE], 'cur_2'));
  const { ctx } = ctxFor(transportFor(mock), { cursor: { next: 'a_stale_one' } });

  const result = await connector.collect(ctx);

  assert.equal(Object.prototype.hasOwnProperty.call(result, 'cursor'), false);
  assert.equal(mock.requests[0].params.has('cursor'), false,
    'a cursor left in ctx from a previous sweep must not be resumed');
});

/* ================================================================== *
 * 6. Failures
 * ================================================================== */

test('a refused token is an AuthError, so the source rests instead of retrying all day', async (t) => {
  const mock = await todoistServer(t, { status: 401, body: '{"error":"Invalid token"}' });
  const { ctx, emitted } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof AuthError, `came back as ${err.constructor.name}`);
    return true;
  });
  assert.deepEqual(emitted, []);
});

test('a 429 rests for as long as the server said, or for the declared window', async (t) => {
  const stated = await todoistServer(t, { status: 429, body: '{}' }, { headers: { 'retry-after': '120' } });
  await assert.rejects(connector.collect(ctxFor(transportFor(stated)).ctx), (err) => {
    assert.ok(err instanceof RateLimitError, `came back as ${err.constructor.name}`);
    assert.equal(err.retryAfterMs, 120_000, 'a stated limit is a fact and a declared budget is a guess');
    return true;
  });

  const silent = await todoistServer(t, { status: 429, body: '{}' });
  await assert.rejects(connector.collect(ctxFor(transportFor(silent)).ctx), (err) => {
    assert.equal(err.retryAfterMs, connector.limits.budget.perMs);
    return true;
  });
});

test('a body that is not JSON is refused without quoting the stranger back', async (t) => {
  /* This message reaches `sources[].error`, /api/state and the settings export,
     and a non-JSON answer here is a captive portal's sign-in page or a proxy's
     error page — not the vendor. */
  const mock = await todoistServer(t, '<html><body>Sign in to the hotel wifi</body></html>');
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.match(err.message, /not JSON/);
    assert.match(err.message, /proxy or a sign-in page/);
    assert.doesNotMatch(err.message, /hotel wifi/, 'a stranger\'s HTML must not be echoed into the settings export');
    return true;
  });
});

test('readPage accepts both shapes this endpoint has answered with', () => {
  assert.deepEqual(readPage(page([TASK_LATE], 'c1'), 'api.todoist.com'),
    { tasks: [TASK_LATE], nextCursor: 'c1' });
  assert.deepEqual(readPage(page([]), 'api.todoist.com'), { tasks: [], nextCursor: '' });
  // The bare array the older REST endpoint answered with. A reader that only
  // knew one shape would turn a working credential into "Todoist returned
  // nothing" with no way to tell it from an empty list.
  assert.deepEqual(readPage(JSON.stringify([TASK_LATE]), 'api.todoist.com'),
    { tasks: [TASK_LATE], nextCursor: '' });
  assert.throws(() => readPage('null', 'api.todoist.com'), /holds no task list/);
  assert.throws(() => readPage('{"results":"soon"}', 'api.todoist.com'), /holds no task list/);
});

test('a refusal the vendor put in the BODY is classified, not blamed on the API version', async (t) => {
  /* Every non-task body used to produce one sentence — "the endpoint or its
     version has changed" — as a plain Error. So a dead credential sent the user
     hunting for an API change AND never reached core/sweep.mjs's AuthError arm,
     which means it was retried every sweep forever instead of resting. */
  const refused = await todoistServer(t, '{"error":"Invalid API token","error_tag":"AUTH_INVALID_TOKEN","error_code":401}');
  await assert.rejects(connector.collect(ctxFor(transportFor(refused)).ctx), (err) => {
    assert.ok(err instanceof AuthError, `a dead token came back as ${err.constructor.name}`);
    assert.match(err.message, /Invalid API token/, 'the vendor\'s own words are the diagnosis');
    return true;
  });

  const bad = await todoistServer(t, '{"error":"Invalid filter query","error_code":15}');
  await assert.rejects(connector.collect(ctxFor(transportFor(bad)).ctx), (err) => {
    assert.equal(err.constructor.name, 'Error');
    assert.match(err.message, /Invalid filter query/);
    assert.doesNotMatch(err.message, /version has changed/,
      'sending somebody with a mistyped filter off to look for an API change is the wrong diagnosis');
    return true;
  });
});

test('todoistError says nothing about a healthy body, and bounds a shouting one', () => {
  assert.equal(todoistError({ results: [] }, 'api.todoist.com'), null);
  assert.equal(todoistError([], 'api.todoist.com'), null);
  assert.equal(todoistError({ errors: [] }, 'api.todoist.com'), null);
  assert.equal(todoistError(null, 'api.todoist.com'), null);

  /* core/doctor.mjs:80 puts no ceiling on `errorText` and prints the detail
     whole, so the cap has to be here. */
  const loud = todoistError({ error: 'ka-'.repeat(4000) }, 'api.todoist.com');
  assert.ok(loud.message.length < 700, `an unbounded ${loud.message.length}-char error reaches the terminal`);

  const limited = todoistError({ errors: [{ message: 'Rate limit exceeded' }] }, 'api.todoist.com');
  assert.ok(limited instanceof RateLimitError);
  assert.ok(limited.retryAfterMs > 0, 'a rate limit with no rest attached rests nothing');
});

/* ================================================================== *
 * 7. zelos doctor
 * ================================================================== */

/** Anything network-shaped throws, so a test that reaches one says so loudly. */
const SILENT_DEPS = {
  backend: async () => ({ name: 'macos-keychain', writable: true, note: 'Stored in your login keychain.' }),
  getSecret: async () => TOKEN,
  listModels: async () => [{ id: 'test-model', label: 'Test model' }],
  testImap: async () => { throw new Error('testImap should not have been called'); },
  testCalDav: async () => { throw new Error('testCalDav should not have been called'); },
};

function doctorConfig(settings = {}) {
  return {
    version: 1,
    identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: TZ },
    model: {
      protocol: 'openai',
      label: 'Test model',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test-model',
      keyRef: 'model.default',
      maxTokens: 4096,
      temperature: 0,
    },
    mail: [],
    calendars: [],
    sources: [{
      id: 's_td',
      enabled: true,
      label: 'My tasks',
      type: 'todoist',
      keyRef: 'todoist.s_td',
      settings,
    }],
    sweep: { intervalMinutes: 60, activeHours: [0, 23], auto: true },
    ui: { accent: '#5b8cff' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
  };
}

async function diagnoseAgainst(mock, settings) {
  const report = await diagnose({
    config: doctorConfig(settings),
    deps: {
      ...SILENT_DEPS,
      fetchImpl: (input, init) => {
        const url = new URL(String(input));
        return realFetch(`${mock.origin}${url.pathname}${url.search}`, init);
      },
    },
  });
  return report.checks.find((c) => c.id === 'source.s_td');
}

test('doctor runs the user\'s own filter, against the endpoint that accepts one', async (t) => {
  const mock = await todoistServer(t, page([TASK_LATE, TASK_TODAY]));

  const line = await diagnoseAgainst(mock, { filter: 'today & @paperwork' });

  assert.equal(line.status, 'pass', line.detail);
  assert.equal(line.label, 'Todoist · My tasks');
  assert.match(line.detail, /"today & @paperwork" matches 2 tasks/);
  assert.equal(mock.requests[0].path, '/api/v1/tasks/filter',
    'a probe that asks a different endpoint than the sweep does is not a diagnostic');
  assert.equal(mock.requests[0].query.query, 'today & @paperwork');
  assert.equal(mock.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('a refused filter is reported with the filter in it, and the remedy leads with the filter', async (t) => {
  /* The docstring on `check` says the whole reason it runs the user's own query
     is that a mistyped filter is the likeliest thing to be wrong here. The
     verdict used to read `Todoist: api.todoist.com returned 400` under an action
     that led with the API token — withholding the one fact the probe exists to
     surface, and pointing a stuck person at the one thing that was fine. */
  const mock = await todoistServer(t, { status: 400, body: '{"error":"Unable to parse filter"}' });

  const line = await diagnoseAgainst(mock, { filter: 'overdue && todya' });

  assert.equal(line.status, 'fail');
  assert.match(line.detail, /overdue && todya/, 'the filter that was refused is the one fact worth printing');
  assert.match(line.action, /^Check the Todoist filter/,
    'leading with the API token sends the reader to the one thing the 400 did not implicate');
  assert.ok(line.action.indexOf('overdue && todya') < line.action.indexOf('API token'),
    'the filter has to come before the token in the remedy, not merely appear somewhere in it');
});

test('a refused TOKEN still leads with the token', async (t) => {
  /* The exception that keeps the rule honest: on a 401 the credential really is
     the first thing to check, and the transport has already classified it. */
  const mock = await todoistServer(t, { status: 401, body: '{"error":"Invalid token"}' });

  const line = await diagnoseAgainst(mock, {});

  assert.equal(line.status, 'fail');
  assert.match(line.action, /^Check the API token/);
  assert.match(line.action, /Integrations → Developer/, 'a failure with nowhere to go is not a diagnosis');
});

test('check measures overdue in the zone it is given, not in the machine\'s', async (t) => {
  /* `check` used to compute `today` with a bare `todayKey()` and pass `''` as
     the timezone, so the overdue count in the one line a stuck person reads was
     measured wherever the laptop happens to be rather than where the user
     lives — the same one-day error `dueDayKey` exists to prevent, printed in
     `zelos doctor`.

     Niue is UTC−11 and Kiritimati is UTC+14: 25 hours apart, so their local
     dates are NEVER the same one. A task due on today's date in Niue is not
     late there and is already late in Kiritimati. That makes this deterministic
     on any day and on any machine — and it is exactly what a check that ignores
     the zone it was handed cannot reproduce, because it answers both the same.

     `checkContext` (core/doctor.mjs:846) does not thread `identity.timezone`
     through yet, which is why this drives `check` directly rather than through
     `diagnose`. The connector half is what is testable today; see the handoff. */
  const NIUE = 'Pacific/Niue';
  const KIRITIMATI = 'Pacific/Kiritimati';
  const dueToday = todayKey(NIUE);
  const mock = await todoistServer(t, page([{ ...TASK_TODAY, due: { date: dueToday } }]));

  const probe = (timezone) => connector.check(
    { id: 's_td', settings: {} },
    { http: transportFor(mock), timezone },
  );

  const here = await probe(NIUE);
  const ahead = await probe(KIRITIMATI);

  assert.equal(here.status, 'pass', here.detail);
  // `of them overdue`, not `overdue` — the echoed filter is "overdue | today".
  assert.doesNotMatch(here.detail, /of them overdue/,
    `a task due ${dueToday} is not late for somebody in ${NIUE}: ${here.detail}`);
  assert.match(ahead.detail, /1 of them overdue/,
    `${KIRITIMATI} is a day ahead of ${NIUE}, so the same task is already late there`);
  assert.notEqual(here.detail, ahead.detail,
    'a check that ignores the timezone it was handed answers both zones identically');
});
