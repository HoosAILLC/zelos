/**
 * test/connector-fireflies.test.mjs — the Fireflies.ai connector.
 *
 * Fireflies is a GraphQL API on a fifty-request-a-day free tier, which makes
 * two of its properties testable in a way most connectors' are not, and this
 * file is written around exactly those two:
 *
 *  1. THE COST OF A POLL IS COUNTABLE. The mock below records every request it
 *     receives, so "asks for everything in one round trip" is an assertion
 *     about a number and not a claim about a comment. A connector that fetched
 *     the summary per transcript would answer these tests with 1 + N.
 *
 *  2. FAILURE ARRIVES AS 200. GraphQL states a bad key, a spent allowance and a
 *     mistyped field in the body, so the whole "is this a success" decision is
 *     the connector's rather than the transport's. Six tests below feed it a 200
 *     and demand a rejection; the one that matters most is the partial — `data`
 *     populated AND `errors` present — because that is the shape a `?? []`
 *     reader turns into "you had no meetings".
 *
 * EVERY SOCKET GOES TO 127.0.0.1. The connector posts to the real
 * https://api.fireflies.ai/graphql and the transport's origin allow-list is
 * enforced against that real origin; only the last hop — `createHttp`'s
 * `fetchImpl` seam, the same one core/doctor.mjs already uses — swaps the host
 * for the mock. So the allow-list is exercised for real (a test below proves it
 * still refuses a foreign origin) and nothing dials the vendor. `globalThis.
 * fetch` is wrapped for the length of the run so that if an edit ever forgets,
 * this suite says so instead of contacting Fireflies from whatever machine is
 * running it.
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
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-fireflies-'));
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

const connector = (await import('../core/connectors/fireflies.mjs')).default;
const {
  API_URL, MEETINGS_QUERY, WHOAMI_QUERY,
  actionItems, attendeesOf, graphqlError, meetingDate, parseGraphql, rowFrom,
} = await import('../core/connectors/fireflies.mjs');
const { AuthError, RateLimitError, createHttp } = await import('../core/connectors/http.mjs');
const registry = await import('../core/connectors/index.mjs');
const { assertShape } = registry;
const { open, close, migrate, upsertMessages, listMessages } = await import('../core/db.mjs');
const { diagnose } = await import('../core/doctor.mjs');

let seq = 0;
const openDbs = [];

function freshDb() {
  const db = open(path.join(HOME_ROOT, `ff${seq++}.db`));
  migrate(db);
  openDbs.push(db);
  return db;
}

test.after(() => {
  globalThis.fetch = realFetch;
  for (const db of openDbs) close(db);
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const KEY = 'ff_test_0e2a4c6b';

const NOW = '2026-08-11T09:00:00.000Z';
const WINDOW_FROM = '2026-08-04T09:00:00.000Z';   // the sweep's now − 7 days
const WINDOW_TO = '2026-10-10T09:00:00.000Z';     // the sweep's now + 60 days

/**
 * A meeting with a full recap. `date` is derived from `dateString` rather than
 * typed out, so the two encodings cannot silently disagree in the fixture and
 * make a test pass for the wrong reason.
 */
const MEETING_FULL = {
  id: 'tr_0f1e',
  title: 'Alder & Vance pre-con',
  dateString: '2026-08-10T16:00:00.000Z',
  date: Date.parse('2026-08-10T16:00:00.000Z'),
  duration: 42.5,
  transcript_url: 'https://app.fireflies.ai/view/tr_0f1e',
  host_email: 'dana@vance.example',
  organizer_email: 'dana@vance.example',
  participants: ['dana@vance.example', 'nemo@example.com', 'kit@alder.example'],
  meeting_attendees: [
    { displayName: 'Dana Vance', name: 'Dana Vance', email: 'dana@vance.example' },
    { displayName: 'Nemo Hale', name: 'Nemo Hale', email: 'nemo@example.com' },
  ],
  summary: {
    overview: 'The team walked the schedule of values line by line and agreed the crane window moves to the following Tuesday.',
    short_summary: 'Schedule of values walked; crane window moved.',
    gist: 'Pre-con',
    action_items: '- Send the retainage schedule by Thursday\n- Confirm the crane window with the GC',
  },
};

/**
 * The same instant told a different way, and it is the whole point of this
 * fixture: 13:00−04:00 is 17:00Z, which is LATER than MEETING_FULL's 16:00Z,
 * but the string `2026-08-10T13:00:00-04:00` sorts BELOW `2026-08-10T16:00…`.
 * A cursor that compared ISO strings would move backwards here.
 */
const MEETING_LATER_BUT_LOWER = {
  id: 'tr_77aa',
  title: 'Retainage walkthrough',
  dateString: '2026-08-10T13:00:00-04:00',
  date: Date.parse('2026-08-10T17:00:00.000Z'),
  duration: 18,
  transcript_url: 'https://app.fireflies.ai/view/tr_77aa',
  host_email: 'kit@alder.example',
  participants: ['kit@alder.example', 'nemo@example.com'],
  meeting_attendees: [],
  // No summary yet — Fireflies generates it after the call ends, and this is
  // what a poll that caught the meeting in that gap actually receives.
  summary: null,
};

const ok = (transcripts) => JSON.stringify({ data: { transcripts } });

/* ------------------------------------------------------------------ *
 * The mock, the transport and the ctx
 * ------------------------------------------------------------------ */

/**
 * A GraphQL endpoint on 127.0.0.1 that records what it was asked.
 *
 * `answer` is either a fixed string or `(nth, body) => string`, so a test can
 * make the second request differ from the first — which is how the "one round
 * trip" assertion below has teeth: if the connector went back for summaries,
 * the mock would hand it something and the count would say so.
 */
async function graphqlServer(t, answer, { status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body, raw });
      const text = typeof answer === 'function' ? answer(requests.length, body) : answer;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
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
 * `origins`, `limits`, `credential` and `graphql` all come off the connector,
 * so flipping any of them in core/connectors/fireflies.mjs turns these tests
 * red — which is the point. The `fetchImpl` swap happens AFTER the allow-list
 * has already accepted `https://api.fireflies.ai`, so it cannot widen what is
 * reachable; it only decides which socket the accepted request lands on.
 */
function transportFor(mock, { secret = KEY, graphql = connector.graphql === true } = {}) {
  return createHttp({
    origins: connector.origins,
    limits: connector.limits,
    credential: connector.credential,
    graphql,
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
      id: 's_ff',
      enabled: true,
      label: 'Team meetings',
      type: 'fireflies',
      keyRef: 'fireflies.s_ff',
      settings: { meetings: 25 },
    },
    label: 'Team meetings',
    secret: KEY,
    cursor: null,
    window: { from: WINDOW_FROM, to: WINDOW_TO },
    timezone: 'UTC',
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

/** The variables of the nth recorded request. */
const varsOf = (mock, n = 0) => mock.requests[n].body.variables;

/* ================================================================== *
 * 1. The manifest
 * ================================================================== */

test('the manifest satisfies the connector interface and declares the endpoint it posts to', () => {
  assert.doesNotThrow(() => assertShape(connector));

  assert.equal(connector.type, 'fireflies');
  assert.equal(connector.configKey, 'sources');
  assert.equal(connector.sink, 'messages', 'a recap is a message-shaped row, not a calendar event');
  assert.equal(connector.graphql, true, 'without this core/connectors/http.mjs refuses postJson entirely');

  /* The declared origin and the URL `collect` posts to must be the same host,
     and they are written in two places — the manifest wants a bare origin and
     the request wants a path. A derivation would hide a mismatch; this catches
     one. */
  assert.deepEqual(connector.origins, ['https://api.fireflies.ai']);
  assert.ok(connector.origins.includes(new URL(API_URL).origin),
    `the connector posts to ${API_URL}, which its own allow-list would refuse`);

  // Non-negotiable #3: the user mints the credential, and it travels in a
  // header where core/log.mjs can redact it.
  assert.equal(connector.credential.required, true);
  assert.equal(connector.credential.send.as, 'header');
  assert.match(connector.credential.url, /^https:\/\/app\.fireflies\.ai\//);
});

test('the declared budget is one an hourly poll actually fits inside the free tier', () => {
  /* THE FREE TIER IS 50 REQUESTS A DAY. This is arithmetic on the manifest,
     not a restatement of it: `collect` makes one request, so the day's cost is
     the number of polls a day the interval permits. The sweep's own default
     cadence is 30 minutes, which would be 48 — over the budget below and
     within a rounding error of the vendor's ceiling, with nothing left for
     `zelos doctor`. */
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FREE_TIER_PER_DAY = 50;

  const budget = connector.limits.budget;
  assert.ok(budget, 'a source on a fifty-a-day allowance must declare a real budget');
  assert.equal(budget.perMs, DAY_MS, 'the allowance is stated per day, so the window has to be a day');

  const pollsPerDay = Math.floor(DAY_MS / connector.limits.minIntervalMs);
  assert.ok(pollsPerDay <= budget.calls,
    `an hourly poll is ${pollsPerDay} requests a day against a budget of ${budget.calls}`);
  assert.ok(budget.calls < FREE_TIER_PER_DAY,
    `the budget must leave headroom under ${FREE_TIER_PER_DAY}: core/doctor.mjs builds its check transport `
    + 'without the persisted meter, so every `zelos doctor` run spends a request this budget never sees');

  // And the row cap is above what the connector can ever ask for, so it only
  // fires when the server ignored the `limit` it was given.
  const meetings = connector.fields.find((f) => f.name === 'meetings');
  assert.ok(connector.limits.maxRows > meetings.max);
});

/* ================================================================== *
 * 2. One round trip
 * ================================================================== */

test('collect asks for the meetings and their summaries in ONE request', async (t) => {
  const mock = await graphqlServer(t, (nth) => {
    // Anything after the first would be an N+1 fetch. It is answered rather
    // than refused so the failure is a count, not a crash.
    if (nth > 1) return ok([]);
    return ok([MEETING_FULL]);
  });
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(mock.requests.length, 1,
    `a poll cost ${mock.requests.length} requests; the free tier allows 50 a day and an hourly poll must cost 24`);

  const row = result.parts[0].rows[0];
  // The proof that it was ONE trip and not a lucky first one: the summary the
  // row carries can only have come out of that single response.
  assert.match(row.text, /Send the retainage schedule by Thursday/);
  assert.match(row.text, /crane window moves to the following Tuesday/);
});

test('the request carries the key as a Bearer header and a JSON GraphQL document', async (t) => {
  const mock = await graphqlServer(t, ok([MEETING_FULL]));
  const { ctx } = ctxFor(transportFor(mock));

  await connector.collect(ctx);

  const req = mock.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/graphql');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`,
    'the manifest declares credential.send, and the transport is what attaches it');
  assert.match(req.headers['content-type'], /application\/json/);
  assert.equal(req.body.query, MEETINGS_QUERY);
  assert.deepEqual(Object.keys(req.body.variables).sort(), ['from', 'limit', 'to']);
});

test('`graphql: true` is what makes the POST legal at all', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  // The same transport the sweep would build for a manifest that did not
  // declare it. Every other test in this file passes `connector.graphql`, so
  // flipping the manifest turns them all red; this one names the reason.
  const { ctx } = ctxFor(transportFor(mock, { graphql: false }));

  await assert.rejects(connector.collect(ctx), /did not declare `graphql: true`/);
  assert.equal(mock.requests.length, 0, 'a refused POST must not reach a socket');
});

test('the transport built from this manifest refuses any other host', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  const client = transportFor(mock);

  await assert.rejects(
    client.postJson(`${mock.origin}/graphql`, { query: WHOAMI_QUERY }),
    /not one of this source's addresses/,
  );
  assert.equal(mock.requests.length, 0,
    'the allow-list is checked before a socket exists, so nothing should have arrived');
});

/* ================================================================== *
 * 3. A 200 with an errors body is a failure
 * ================================================================== */

test('a 200 carrying only an errors array is a failure, never an empty read', async (t) => {
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Cannot query field "summry" on type "Transcript".' }],
  }));
  const { ctx, emitted } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.match(err.message, /Cannot query field "summry"/, 'the vendor\'s own words are the diagnosis');
    return true;
  });
  assert.deepEqual(emitted, [], 'a failed poll must not report a count of zero meetings');
});

test('a 200 carrying BOTH data and errors is still a failure', async (t) => {
  /* The shape that turns a `?? []` reader into a liar in the other direction:
     there IS a `transcripts` array, so a connector that only looked at `data`
     would return one row and call the poll a success while the rest of the
     response was refused. */
  const mock = await graphqlServer(t, JSON.stringify({
    data: { transcripts: [MEETING_FULL] },
    errors: [{ message: 'Field "meeting_attendees" is restricted on this plan', extensions: { code: 'paid_required' } }],
  }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), /restricted on this plan/);
});

test('a 200 with neither meetings nor errors is a failure', async (t) => {
  const mock = await graphqlServer(t, JSON.stringify({ data: {} }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), /neither transcripts nor an error/);
});

test('a 200 that is not JSON at all is a failure that quotes what arrived', async (t) => {
  const mock = await graphqlServer(t, '<html><body>upstream connect error</body></html>');
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.match(err.message, /not JSON/);
    assert.match(err.message, /upstream connect error/);
    return true;
  });
});

test('a rejected key arrives as 200 and is still promoted to an AuthError', async (t) => {
  /* core/connectors/http.mjs raises AuthError on a 401 or a 403 and can do
     nothing with this body — Fireflies answers a dead key with 200. The class
     is what core/sweep.mjs keys its six-hour rest on, and the comment there is
     about this exact allowance: "Retrying a 401 against a host that allows
     fifty calls a day burns forty-eight of them before lunch." */
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Please provide a valid API key', extensions: { code: 'unauthenticated' } }],
  }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof AuthError,
      `a 200 that means "your key is dead" came back as ${err.constructor.name}, so the sweep would retry it 24 times a day`);
    assert.match(err.message, /Please provide a valid API key/);
    return true;
  });
});

test('a stated rate limit arrives as 200 and is still promoted to a RateLimitError', async (t) => {
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Too many requests, please try again later', extensions: { code: 'too_many_requests' } }],
  }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof RateLimitError, `came back as ${err.constructor.name}`);
    assert.ok(err.retryAfterMs > 0, 'a rate limit with no rest attached rests nothing');
    return true;
  });
});

test('a stranger error message is capped and flattened before it reaches a doctor row', () => {
  /* core/sweep.mjs caps what it STORES (ERROR_CHARS = 500). core/doctor.mjs:80
     does not: `errorText` is `err?.message` with no ceiling and the verdict's
     detail is printed whole, so the cap has to be here. */
  const err = graphqlError({ errors: [{ message: `${'ka-'.repeat(4000)}\nsecond line\nthird line` }] });
  assert.ok(err.message.length < 700, `an unbounded ${err.message.length}-char error reaches the terminal`);
  assert.doesNotMatch(err.message, /\n/, 'a multi-line error rendered into a one-line doctor row is unreadable');
});

test('graphqlError says nothing about a healthy body', () => {
  assert.equal(graphqlError({ data: { transcripts: [] } }), null);
  // Several servers send an explicit null on success; it must not read as one.
  assert.equal(graphqlError({ data: { transcripts: [] }, errors: null }), null);
  assert.equal(graphqlError({ data: { transcripts: [] }, errors: [] }), null);
});

test('parseGraphql hands back the field it was asked for', () => {
  assert.deepEqual(parseGraphql(JSON.stringify({ data: { users: [{ name: 'Dana' }] } }), 'users'), [{ name: 'Dana' }]);
  // An account with no meetings is an empty ARRAY, and that is a real answer.
  assert.deepEqual(parseGraphql(ok([]), 'transcripts'), []);
});

/* ================================================================== *
 * 4. The row
 * ================================================================== */

test('a recap becomes a message-shaped row: title, summary, attendees, meeting time', async (t) => {
  const mock = await graphqlServer(t, ok([MEETING_FULL]));
  const { ctx, emitted } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);
  const [row] = result.parts[0].rows;

  assert.equal(row.subject, 'Alder & Vance pre-con');
  assert.equal(row.folder, 'Team meetings');
  assert.equal(row.direction, 'in');
  assert.deepEqual(row.from, { name: 'Dana Vance', email: 'dana@vance.example' });
  assert.deepEqual(row.to.map((a) => a.email), ['nemo@example.com', 'kit@alder.example'],
    'the host goes in `from`; everyone else is a recipient, and the bare participant list fills the gaps');
  assert.equal(Date.parse(row.date), Date.parse('2026-08-10T16:00:00.000Z'), 'the meeting time is the date');
  assert.match(row.text, /app\.fireflies\.ai\/view\/tr_0f1e/, 'the recap has to be openable');
  assert.match(row.text, /43 min/);
  assert.deepEqual(emitted, [{ message: 'Team meetings: 1 meeting', done: 1, total: 1 }]);
});

test('the action items lead the body and the snippet — they are what you owe', async (t) => {
  const mock = await graphqlServer(t, ok([MEETING_FULL]));
  const { ctx } = ctxFor(transportFor(mock));

  const [row] = (await connector.collect(ctx)).parts[0].rows;

  /* Not a preference. core/triage.mjs:816 shrinks the per-message body budget
     to `floor(room / entries)` when the prompt does not fit and `clean()` at
     :482 caps from the TAIL, so whatever is at the bottom of a body is the
     first thing the model stops seeing. An overview runs to thousands of
     characters; the action items run to a few hundred. */
  const items = row.text.indexOf('Send the retainage schedule');
  const overview = row.text.indexOf('walked the schedule of values');
  assert.ok(items >= 0 && overview >= 0, row.text);
  assert.ok(items < overview,
    'the overview is above the action items, so a squeezed prompt drops the only part that is a commitment');

  assert.match(row.snippet, /^Action items: Send the retainage schedule by Thursday; Confirm the crane window/);
  assert.ok(row.snippet.length <= 400);
});

test('a meeting whose summary has not been generated yet still produces a usable row', async (t) => {
  const mock = await graphqlServer(t, ok([MEETING_LATER_BUT_LOWER]));
  const { ctx } = ctxFor(transportFor(mock));

  const [row] = (await connector.collect(ctx)).parts[0].rows;

  assert.equal(row.subject, 'Retainage walkthrough');
  assert.equal(row.snippet, '', 'there is nothing to summarise yet, and inventing something would be worse');
  assert.match(row.text, /app\.fireflies\.ai\/view\/tr_77aa/);
  assert.equal(Date.parse(row.date), Date.parse('2026-08-10T17:00:00.000Z'));
});

test('a transcript with no id is dropped rather than given a colliding row id', async (t) => {
  const mock = await graphqlServer(t, ok([{ ...MEETING_FULL, id: '' }, MEETING_FULL]));
  const { ctx } = ctxFor(transportFor(mock));

  const rows = (await connector.collect(ctx)).parts[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, 'fireflies:tr_0f1e');
});

test('a row never mentions `uid`, and two polls of the same meeting insert it once', async (t) => {
  /* THE RULE THAT HAS ALREADY BITTEN. core/db.mjs:384 reads
     `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes
     0 while an OMITTED uid stays null — two different `messageRowId`s for the
     same meeting. A connector that flipped between them would re-insert every
     recap it has ever seen on every sweep.

     Asserting the key is absent is half of it; the other half is driving the
     real `upsertMessage` twice and watching the second poll insert nothing. */
  const mock = await graphqlServer(t, ok([MEETING_FULL]));
  /* A transport per poll, because that is what the sweep does: `createHttp` is
     built fresh inside the per-source task on every sweep. It matters here for
     a second reason — core/connectors/http.mjs:337 reads
     `Number(res.headers.get('x-ratelimit-remaining'))`, and `Number(null)` is
     0, so a vendor that does not send that header (Fireflies does not) drives
     `state.spent` to the whole budget on the first response. Two polls through
     one transport hit it. See this task's handoff note: it is a defect in a
     file this connector does not own, and it makes EVERY budgeted connector a
     once-per-window connector until it is fixed. */
  const poll = async () => (await connector.collect(ctxFor(transportFor(mock)).ctx)).parts[0].rows;

  const first = await poll();
  assert.equal(Object.prototype.hasOwnProperty.call(first[0], 'uid'), false,
    '`uid: null` and an omitted uid hash to different row ids — a meeting has no integer identity, so the key must be absent');

  const db = freshDb();
  const stamp = (rows) => rows.map((r) => ({ ...r, sourceId: 's_ff' }));
  const one = upsertMessages(db, stamp(first));
  assert.equal(one.inserted, 1);

  const second = await poll();
  const two = upsertMessages(db, stamp(second));
  assert.equal(two.inserted, 0, 'the same meeting was inserted a second time — the row id is not stable');
  assert.equal(listMessages(db, { sourceId: 's_ff' }).length, 1);
});

test('action items survive whether the vendor sends a string or a list', () => {
  const asString = actionItems({ action_items: '- Send the SOV\n* Book the crane\n\n• Sign the change order' });
  const asList = actionItems({ action_items: ['Send the SOV', 'Book the crane', 'Sign the change order'] });
  assert.deepEqual(asString, ['Send the SOV', 'Book the crane', 'Sign the change order']);
  assert.deepEqual(asList, asString, 'guessing wrong here drops the row\'s most valuable field, silently');
  assert.deepEqual(actionItems({}), []);
  assert.deepEqual(actionItems(null), []);
});

test('attendees fold across both lists the vendor sends, on the address', () => {
  assert.deepEqual(attendeesOf(MEETING_FULL), [
    { name: 'Dana Vance', email: 'dana@vance.example' },
    { name: 'Nemo Hale', email: 'nemo@example.com' },
    { name: '', email: 'kit@alder.example' },
  ]);
  assert.deepEqual(attendeesOf({ participants: ['A@Example.com', 'a@example.com'] }),
    [{ name: '', email: 'A@Example.com' }], 'the same person twice is one attendee');
});

test('meetingDate reads either encoding, and neither is a crash', () => {
  assert.equal(Date.parse(meetingDate({ dateString: '2026-08-10T16:00:00.000Z' })), Date.parse('2026-08-10T16:00:00.000Z'));
  assert.equal(Date.parse(meetingDate({ date: Date.parse('2026-08-10T16:00:00.000Z') })), Date.parse('2026-08-10T16:00:00.000Z'));
  assert.equal(meetingDate({}), null);
  assert.equal(meetingDate({ dateString: 'sometime tuesday', date: 'nope' }), null);
});

test('rowFrom leaves the folder to the caller and never invents a from address', () => {
  const row = rowFrom({ id: 'x', title: '', summary: {} }, { folder: 'Sales calls' });
  assert.equal(row.folder, 'Sales calls');
  assert.equal(row.subject, '(untitled meeting)');
  assert.deepEqual(row.from, { name: 'Fireflies', email: '' });
});

/* ================================================================== *
 * 5. The cursor and the window
 * ================================================================== */

test('the first poll asks from the sweep window and no later than now', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(varsOf(mock).from, WINDOW_FROM);
  assert.equal(varsOf(mock).to, NOW,
    'the sweep window reaches 60 days into the future; a meeting that has not happened has no recap');
  assert.equal(result.cursor, null, 'nothing has ever been seen, so there is nothing to remember');
});

test('a poll resumes from the cursor, minus the window a summary can arrive late in', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  const { ctx } = ctxFor(transportFor(mock), { cursor: { newestAt: '2026-08-10T17:00:00.000Z' } });

  const result = await connector.collect(ctx);

  assert.equal(varsOf(mock).from, '2026-08-10T11:00:00.000Z',
    'six hours of overlap is how a recap that was still being generated last poll gets picked up');
  assert.deepEqual(result.cursor, { newestAt: '2026-08-10T17:00:00.000Z' },
    'a poll that found nothing must hand the high-water mark back, not reset it');
});

test('a stale cursor cannot widen the ask beyond the sweep window', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  const { ctx } = ctxFor(transportFor(mock), { cursor: { newestAt: '2019-03-01T00:00:00.000Z' } });

  await connector.collect(ctx);
  assert.equal(varsOf(mock).from, WINDOW_FROM,
    'a laptop shut for a year must not ask Fireflies for a year of meetings');
});

test('the cursor tracks the latest INSTANT, not the highest-sorting string', async (t) => {
  /* Both meetings are on 10 August. `2026-08-10T13:00:00-04:00` is 17:00Z —
     later than 16:00Z — but sorts BELOW `2026-08-10T16:00:00…` as text, and
     `meetingDate` deliberately preserves whatever offset the vendor sent. A
     lexical high-water mark would settle on 16:00Z and re-read the 17:00
     meeting on every poll for as long as it stayed in the window. */
  const mock = await graphqlServer(t, ok([MEETING_FULL, MEETING_LATER_BUT_LOWER]));
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(result.cursor.newestAt, '2026-08-10T17:00:00.000Z',
    'the cursor moved to the string that sorts highest rather than the meeting that happened last');
});

test('the meeting count the user configured is what is asked for, clamped to the vendor ceiling', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  const build = (meetings) => ctxFor(transportFor(mock), {
    source: { id: 's_ff', label: 'Team meetings', type: 'fireflies', settings: { meetings } },
  }).ctx;

  await connector.collect(build(10));
  await connector.collect(build(500));
  await connector.collect(build(0));

  assert.equal(varsOf(mock, 0).limit, 10);
  assert.equal(varsOf(mock, 1).limit, 50, 'Fireflies caps `limit` at 50 and asking for more is a rejected document');
  assert.equal(varsOf(mock, 2).limit, 25, 'a blank or zero setting falls back to the field default');
});

/* ================================================================== *
 * 6. zelos doctor
 * ================================================================== */

/** Anything network-shaped throws, so a test that reaches one says so loudly. */
const SILENT_DEPS = {
  backend: async () => ({ name: 'macos-keychain', writable: true, note: 'Stored in your login keychain.' }),
  getSecret: async () => KEY,
  listModels: async () => [{ id: 'test-model', label: 'Test model' }],
  testImap: async () => { throw new Error('testImap should not have been called'); },
  testCalDav: async () => { throw new Error('testCalDav should not have been called'); },
};

function doctorConfig() {
  return {
    version: 1,
    identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: 'UTC' },
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
      id: 's_ff',
      enabled: true,
      label: 'Team meetings',
      type: 'fireflies',
      keyRef: 'fireflies.s_ff',
      settings: { meetings: 25 },
    }],
    sweep: { intervalMinutes: 60, activeHours: [0, 23], auto: true },
    ui: { accent: '#5b8cff' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
  };
}

/**
 * Put the connector in the registry for the length of one test.
 *
 * The import line into core/connectors/index.mjs belongs to whoever registers
 * this connector, not to this file — so until it lands, this is how doctor can
 * see it at all. Once it lands, `get('fireflies')` answers and registering
 * again would throw "is registered twice", so the already-there case is a
 * no-op. Either way the assertions below are about the same object.
 */
function withRegistered(t) {
  if (registry.get('fireflies')) return;
  const off = registry.register(connector);
  t.after(off);
}

async function diagnoseAgainst(t, mock) {
  return diagnose({
    config: doctorConfig(),
    deps: {
      ...SILENT_DEPS,
      fetchImpl: (input, init) => {
        const url = new URL(String(input));
        return realFetch(`${mock.origin}${url.pathname}${url.search}`, init);
      },
    },
  });
}

const lineFor = (report, id) => report.checks.find((c) => c.id === id);

test('doctor runs the check and names the account the key belongs to', async (t) => {
  withRegistered(t);
  const mock = await graphqlServer(t, JSON.stringify({
    data: { users: [{ user_id: 'u_1', name: 'Nemo Hale', email: 'nemo@example.com' }] },
  }));

  const report = await diagnoseAgainst(t, mock);
  const line = lineFor(report, 'source.s_ff');

  assert.ok(line, `no line for the source: ${report.checks.map((c) => c.id).join(', ')}`);
  assert.equal(line.status, 'pass', line.detail);
  assert.equal(line.label, 'Fireflies · Team meetings');
  assert.match(line.detail, /Nemo Hale <nemo@example\.com>/,
    'a probe that cannot say WHOSE key this is answers the wrong question');

  assert.equal(mock.requests.length, 1, 'a diagnostic costs one of fifty requests a day');
  assert.equal(mock.requests[0].body.query, WHOAMI_QUERY);
  assert.equal(mock.requests[0].headers.authorization, `Bearer ${KEY}`);
});

test("doctor reports the vendor's own words when the key is refused with a 200", async (t) => {
  withRegistered(t);
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Please provide a valid API key', extensions: { code: 'unauthenticated' } }],
  }));

  const report = await diagnoseAgainst(t, mock);
  const line = lineFor(report, 'source.s_ff');

  assert.equal(line.status, 'fail',
    'a 200 that means "your key is dead" was reported as a healthy source');
  assert.match(line.detail, /Please provide a valid API key/);
  assert.match(line.action, /app\.fireflies\.ai/, 'a failure with nowhere to go is not a diagnosis');
});

test('doctor says so when the key is valid but names nobody', async (t) => {
  withRegistered(t);
  const mock = await graphqlServer(t, JSON.stringify({ data: { users: [] } }));

  const report = await diagnoseAgainst(t, mock);
  const line = lineFor(report, 'source.s_ff');

  assert.equal(line.status, 'warn');
  assert.match(line.detail, /named no account/);
});
