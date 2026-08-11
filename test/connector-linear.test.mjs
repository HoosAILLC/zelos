/**
 * test/connector-linear.test.mjs — the Linear issues reader, against a real socket.
 *
 * This file exists because core/connectors/linear.mjs stated THREE TIMES that it
 * was tested and no test in the repo named `linear` at all. An adversarial
 * review proved it the only way that counts: it copied the tree to scratch,
 * applied twelve breaking mutations one at a time — deleting the load-bearing
 * `prefix: ''` (every read then 401s), adding `uid: null` (re-inserts every row
 * on every sweep forever), deleting the `errors[]` check (a refused key becomes
 * a silent empty success), `direction: 'out'`, inverting the workflow-state
 * filter so the board showed only FINISHED work, deleting the urgency sort,
 * building `messageId` from the renumberable `identifier` — and ran the full
 * 1,207-test suite after every one. All twelve stayed green.
 *
 * So the ordering principle here is: one test per claim the connector's own
 * header makes, and every one of them has to be red when the claim is broken.
 * Assertions about the REQUEST are as load-bearing as assertions about the rows
 * — the filter that decides which issues exist at all is on the wire, not in the
 * row shape, and no mock can apply a GraphQL filter for us.
 *
 * EVERY SOCKET GOES TO 127.0.0.1. `collect` posts to the real
 * https://api.linear.app and the transport's origin allow-list is enforced
 * against that real origin; only the last hop — `createHttp`'s `fetchImpl` seam,
 * the same one core/doctor.mjs uses — swaps the host for the mock. So the
 * allow-list runs for real (a test below proves it still refuses a foreign
 * origin), the credential attachment runs for real, the byte cap and the meter
 * run for real, and nothing dials the vendor. `globalThis.fetch` is wrapped for
 * the length of the run so that if an edit ever forgets, this suite says so
 * instead of contacting Linear from whatever machine is running it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/* Set before the modules that read it are evaluated, which is why every import
   below is dynamic. core/log.mjs fixes its level at import time, and an
   unforced secrets backend would detect the operator's own login keychain no
   matter where ZELOS_HOME points. */
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-linear-'));
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

const connector = (await import('../core/connectors/linear.mjs')).default;
const { ISSUES_QUERY, graphqlError, dueness, duePhrase } = await import('../core/connectors/linear.mjs');
const { AuthError, RateLimitError, createHttp } = await import('../core/connectors/http.mjs');
const { assertShape } = await import('../core/connectors/index.mjs');
const { open, close, migrate, upsertMessages, listMessages } = await import('../core/db.mjs');

let seq = 0;
const openDbs = [];

function freshDb() {
  const db = open(path.join(HOME_ROOT, `ln${seq++}.db`));
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

const KEY = 'lin_api_0e2a4c6b';

/* A New York user at 09:00, so the day key is 2026-08-11 and the horizon lands
   on 2026-08-18. The offset is not decoration: `dueDate` is Linear's bare
   `TimelessDate`, and every one of these dates read through `new Date()` would
   land a day earlier for this user. */
const NOW = '2026-08-11T09:00:00-04:00';
const TODAY = '2026-08-11';
const TZ = 'America/New_York';
const IDENTITY = 'nemo@northgate.example';

/** The address Linear knows this account by, deliberately NOT the identity's. */
const VIEWER = { name: 'Nemo Hale', email: 'nemo@work.example' };

function issue(over = {}) {
  return {
    id: '8f2c1b40-0d3a-4a5e-9f11-2b7c6d5e4a30',
    identifier: 'ENG-412',
    title: 'Retainage schedule',
    description: 'The schedule of values needs the retainage column filled in before Thursday.',
    url: 'https://linear.app/acme/issue/ENG-412',
    dueDate: '2026-08-02',
    priorityLabel: 'Urgent',
    state: { name: 'In Progress', type: 'started' },
    team: { name: 'Engineering' },
    creator: { name: 'Priya Raman', email: 'priya@acme.example' },
    ...over,
  };
}

/** One page of `viewer.assignedIssues`, in the shape the query asks for. */
function page(nodes, { hasNextPage = false, endCursor = null, viewer = VIEWER } = {}) {
  return JSON.stringify({
    data: {
      viewer: {
        ...viewer,
        assignedIssues: { pageInfo: { hasNextPage, endCursor }, nodes },
      },
    },
  });
}

/* ------------------------------------------------------------------ *
 * The mock, the transport and the ctx
 * ------------------------------------------------------------------ */

/**
 * A GraphQL endpoint on 127.0.0.1 that records what it was asked.
 *
 * `answer` is either a fixed string or `(nth, body) => string | {status, text}`,
 * so a test can make the second page differ from the first — which is the only
 * way to assert on paging at all. NOTHING here sends `x-ratelimit-remaining`,
 * because Linear does not: this is also the standing regression test for
 * core/connectors/http.mjs treating a missing header as "zero calls left".
 */
async function linearServer(t, answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      const out = typeof answer === 'function' ? answer(requests.length, body) : answer;
      const { status = 200, text = out } = typeof out === 'object' && out !== null ? out : {};
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof text === 'string' ? text : JSON.stringify(text));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

/**
 * The real transport, built from the real manifest, pointed at the mock.
 *
 * `origins`, `limits`, `credential` and `graphql` all come off the connector, so
 * flipping any of them turns these tests red — which is the point. The
 * `fetchImpl` swap happens AFTER the allow-list has already accepted
 * https://api.linear.app, so it cannot widen what is reachable; it only decides
 * which socket the accepted request lands on.
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

function ctxFor(mock, over = {}) {
  const emitted = [];
  const httpClient = over.http ?? transportFor(mock);
  const ctx = {
    source: { id: 's_ln', enabled: true, label: 'Linear', type: 'linear', keyRef: 'linear.s_ln', settings: {} },
    label: 'Linear',
    secret: KEY,
    cursor: null,
    window: { from: '2026-08-04T09:00:00-04:00', to: '2026-10-10T09:00:00-04:00' },
    timezone: TZ,
    identityEmail: IDENTITY,
    now: NOW,
    emit: (message, done = 0, total = 0) => emitted.push({ message, done, total }),
    signal: undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
    http: httpClient,
  };
  return { ctx, emitted, http: httpClient };
}

const collectRows = async (mock, over = {}) => {
  const { ctx } = ctxFor(mock, over);
  const result = await connector.collect(ctx);
  return { result, rows: result.parts.flatMap((p) => p.rows), part: result.parts[0] };
};

const stamp = (rows) => rows.map((r) => ({ ...r, sourceId: 's_ln' }));

/* ================================================================== *
 * 1. The manifest, and the request it produces
 * ================================================================== */

test('the manifest satisfies the connector interface and reads only its own origin', async (t) => {
  assert.doesNotThrow(() => assertShape(connector));
  assert.equal(connector.type, 'linear');
  assert.equal(connector.sink, 'messages', 'an issue you owe is a message-shaped row, never a calendar event');
  assert.equal(connector.graphql, true, 'without this core/connectors/http.mjs refuses postJson entirely');
  assert.deepEqual(connector.origins, ['https://api.linear.app']);

  const mock = await linearServer(t, page([]));
  await assert.rejects(
    transportFor(mock).postJson(`${mock.origin}/graphql`, { query: ISSUES_QUERY }),
    /not one of this source's addresses/,
  );
  assert.equal(mock.requests.length, 0,
    'the allow-list is checked before a socket exists, so nothing should have arrived');
});

test('the API key travels with NO `Bearer ` prefix, which is the whole of note 1', async (t) => {
  /* Linear rejects a personal API key sent in the OAuth shape. `credential.send`
     carries `prefix: ''` and core/connectors/http.mjs:231 reads
     `send.prefix ?? 'Bearer '`, so deleting the empty string is not a tidy-up —
     it silently re-adds the prefix and every read starts failing with a 401 that
     looks like a bad key. Asserted on the wire, because the manifest saying
     `prefix: ''` and the transport sending it are two different facts. */
  const mock = await linearServer(t, page([issue()]));
  await collectRows(mock);

  assert.equal(mock.requests[0].headers.authorization, KEY,
    'the key was sent as something other than the bare header value — a `Bearer ` prefix here is a 401 on every read');
  assert.equal(mock.requests[0].method, 'POST');
  assert.equal(mock.requests[0].url, '/graphql');
  assert.match(mock.requests[0].headers['content-type'], /application\/json/);
});

test('`graphql: true` is what makes the POST legal at all', async (t) => {
  const mock = await linearServer(t, page([]));
  const { ctx } = ctxFor(mock, { http: transportFor(mock, { graphql: false }) });
  await assert.rejects(connector.collect(ctx), /did not declare `graphql: true`/);
  assert.equal(mock.requests.length, 0, 'a refused POST must not reach a socket');
});

test('the request asks for UNFINISHED issues due inside the horizon', async (t) => {
  /* The filter is the connector. Invert `nin` to `in` and the board shows only
     completed and cancelled work — a mutation the review applied and the whole
     suite ignored. No mock can apply a GraphQL filter for us, so the assertion
     is against the document that actually went out on the wire, not against a
     copy of it and not against the module's export. */
  const mock = await linearServer(t, page([]));
  await collectRows(mock);

  const sent = mock.requests[0].body;
  assert.equal(sent.query, ISSUES_QUERY, 'the exported query and the posted document have drifted apart');
  assert.match(sent.query, /state:\s*\{\s*type:\s*\{\s*nin:\s*\["completed",\s*"canceled"\]\s*\}\s*\}/,
    'the state filter no longer excludes finished work — `in` here shows a board of everything already done');
  assert.match(sent.query, /dueDate:\s*\{\s*lte:\s*\$dueBy\s*\}/,
    'without the dueDate bound this reads the entire assigned backlog, and Linear cannot sort it by urgency');

  assert.deepEqual(sent.variables, { after: null, dueBy: '2026-08-18' },
    'the horizon is 7 days from the user\'s own day key; a Date round-trip would land on the 17th for this user');
});

test('the horizon setting is what moves the window, and it is clamped', async (t) => {
  const mock = await linearServer(t, page([]));
  const ask = async (horizonDays) => {
    await collectRows(mock, { source: { id: 's_ln', label: 'Linear', settings: { horizonDays } } });
    return mock.requests[mock.requests.length - 1].body.variables.dueBy;
  };

  assert.equal(await ask(0), TODAY, 'zero days ahead means today, and overdue issues still qualify');
  assert.equal(await ask(30), '2026-09-10');
  assert.equal(await ask(9_000), '2027-08-11', 'a 365-day clamp is the field maximum');
  assert.equal(await ask('nonsense'), '2026-08-18', 'an unparseable setting falls back to the field default');
});

/* ================================================================== *
 * 2. The budget, and the second page
 * ================================================================== */

test('the declared budget is Zelos\'s own restraint and it fits a full sweep', () => {
  /* It used to be 5,000, quoted as the vendor's ceiling — the wrong row of
     Linear's table. 5,000/hr is the OAuth App figure; a PERSONAL API KEY, which
     is the only credential this connector accepts, gets 2,500. A budget declared
     at twice the real allowance bounds nothing and misleads the next reader. */
  const { budget } = connector.limits;
  assert.ok(budget && budget.perMs === 3_600_000, 'the allowance is stated per hour');
  assert.ok(budget.calls <= 2_500,
    `a personal API key gets 2,500 requests an hour; declaring ${budget.calls} is a claim about somebody else's limit`);
  assert.ok(budget.calls < 100,
    'the budget is meant to bound a runaway paging loop; anything near the vendor ceiling bounds nothing');

  const perSweep = 4; // MAX_PAGES
  const sweepsPerHour = Math.floor(3_600_000 / connector.limits.minIntervalMs);
  assert.ok(budget.calls >= perSweep * 2,
    `a sweep costs up to ${perSweep} calls and doctor spends more on a transport built without the persisted meter`);
  assert.ok(sweepsPerHour >= 1);
});

test('a four-page sweep reaches every page through ONE transport, with no rate-limit header in sight', async (t) => {
  /* THE REGRESSION THAT MADE MAX_PAGES DEAD CODE. Linear does not send
     `x-ratelimit-remaining` — its headers are `X-RateLimit-Requests-Remaining`
     and friends — and core/connectors/http.mjs read the missing header as
     `Number(null)`, which is 0, which marked the entire declared budget spent on
     the first response. Every account with more than 100 due issues then failed
     the read entirely and rested for an hour. Fixed in http.mjs; this is the
     connector-side proof that page two is reachable at all. */
  const mock = await linearServer(t, (nth) => page(
    [issue({ id: `id-${nth}`, identifier: `ENG-${nth}`, dueDate: '2026-08-0'.concat(nth) })],
    { hasNextPage: nth < 4, endCursor: `cursor-${nth}` },
  ));
  const { ctx, http: client } = ctxFor(mock, { source: { id: 's_ln', label: 'Linear', settings: { maxItems: 200 } } });

  const rows = (await connector.collect(ctx)).parts.flatMap((p) => p.rows);

  assert.equal(mock.requests.length, 4, 'the sweep stopped early — page two onwards was never asked for');
  assert.equal(rows.length, 4, 'rows from the later pages were lost');
  assert.deepEqual(mock.requests.map((r) => r.body.variables.after), [null, 'cursor-1', 'cursor-2', 'cursor-3'],
    'the endCursor was not carried into the next request, so paging would loop on page one forever');
  assert.ok(client.meter.spent <= connector.limits.budget.calls,
    `a four-page sweep reported ${client.meter.spent} calls spent against a budget of ${connector.limits.budget.calls}`);
});

/* ================================================================== *
 * 3. A 200 with an errors body — and the six-hour lie
 * ================================================================== */

test('a refused key arrives as a 200 and is promoted to an AuthError', async (t) => {
  /* core/connectors/http.mjs raises AuthError on a 401 and can do nothing with
     this body: GraphQL answers "OK" and then explains, inside it, that it did
     nothing. An AuthError is what core/sweep.mjs:740 keys the six-hour rest on;
     a plain Error here is a dead credential retried twice an hour forever. */
  const mock = await linearServer(t, JSON.stringify({
    errors: [{ message: 'Authentication failed - please provide a valid API key', extensions: { code: 'AUTHENTICATION_ERROR' } }],
  }));
  const { ctx, emitted } = ctxFor(mock);

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof AuthError, `a 200 meaning "your key is dead" came back as ${err.constructor.name}`);
    assert.match(err.message, /valid API key/, "the vendor's own words are the diagnosis");
    return true;
  });
  assert.deepEqual(emitted, [], 'a failed read must not report a count of zero issues');
});

test('a FORBIDDEN on one field of a healthy response is NOT a dead credential', async (t) => {
  /* THE FINDING WITH TEETH. The old matcher joined every entry's code into one
     string and ran /AUTHENTICATION|UNAUTHENTICATED|FORBIDDEN|AUTHORIZATION/ over
     it, so a SAML-restricted workspace, a team the key cannot see, or a missing
     scope on `viewer.email` escalated the whole read to "your key is dead".
     The cost of that is not one extra sweep: core/sweep.mjs:735 rests the
     credential for six hours and core/sweep.mjs:653-656 pushes NOTHING into
     `sources[]` for a rested source — no error, no count, no banner. So the
     board shows a calm, complete-looking day with no Linear in it, every sweep,
     until the user edits a credential they were never told to doubt. */
  const mock = await linearServer(t, JSON.stringify({
    data: { viewer: { name: VIEWER.name, email: null, assignedIssues: { pageInfo: {}, nodes: [issue()] } } },
    errors: [{ message: 'You do not have access to this team', path: ['viewer', 'email'], extensions: { code: 'FORBIDDEN' } }],
  }));
  const { ctx } = ctxFor(mock);

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(!(err instanceof AuthError),
      'one refused field bought a six-hour credential block, and a rested source reports nothing at all — '
      + 'the board goes quiet and the silence reads as calm');
    assert.match(err.message, /do not have access/, 'the failure still has to say what happened');
    return true;
  });
});

test('a permission complaint that merely says "not authenticated" is not a dead credential either', async (t) => {
  /* The prose fallback used to be the substring `authenticat`, which promoted
     `{code: 'BAD_USER_INPUT', message: 'user not authenticated for team'}` — a
     per-field complaint carrying an explicit non-auth code — to an AuthError.
     A code is a contract; a message is a sentence somebody may reword. */
  const mock = await linearServer(t, JSON.stringify({
    data: { viewer: null },
    errors: [{ message: 'user not authenticated for team ENG', extensions: { code: 'BAD_USER_INPUT' } }],
  }));
  await assert.rejects(connector.collect(ctxFor(mock).ctx), (err) => {
    assert.ok(!(err instanceof AuthError), 'a BAD_USER_INPUT was read as a refused key');
    return true;
  });
});

test('a code-less body that says the key is required IS a dead credential', async (t) => {
  // The narrow fallback still has to work, or a vendor that stops sending codes
  // turns a dead key into a retry loop.
  const mock = await linearServer(t, JSON.stringify({
    errors: [{ message: 'Authentication required, not authenticated' }],
  }));
  await assert.rejects(connector.collect(ctxFor(mock).ctx), (err) => {
    assert.ok(err instanceof AuthError, `came back as ${err.constructor.name}`);
    return true;
  });
});

test('graphqlError decides per entry, and only a wholly-auth failure is an AuthError', () => {
  const auth = [{ extensions: { code: 'AUTHENTICATION_ERROR' }, message: 'nope' }];
  const forbidden = [{ extensions: { code: 'FORBIDDEN' }, message: 'not your team' }];

  assert.ok(graphqlError(auth) instanceof AuthError);
  assert.ok(graphqlError([{ extensions: { code: 'UNAUTHENTICATED' } }]) instanceof AuthError);
  assert.ok(!(graphqlError(forbidden, { hasData: true }) instanceof AuthError));
  assert.ok(!(graphqlError([...auth, ...forbidden], { hasData: true }) instanceof AuthError),
    'one auth entry beside a healthy partial response is not a statement about the key');
  assert.ok(graphqlError([...auth, ...forbidden], { hasData: false }) instanceof AuthError,
    'an auth failure with no data at all is exactly what a refused query looks like');

  assert.equal(graphqlError([]).constructor.name, 'Error');
  assert.match(graphqlError([]).message, /said nothing about why/);
  assert.ok(graphqlError([{ message: `${'ka-'.repeat(4_000)}` }]).message.length < 700,
    'an unbounded error message reaches `runs.error`, /api/state and the terminal');
});

test('a stated rate limit arrives as 200 and rests the source for the declared window', async (t) => {
  const mock = await linearServer(t, JSON.stringify({
    errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }],
  }));
  await assert.rejects(connector.collect(ctxFor(mock).ctx), (err) => {
    assert.ok(err instanceof RateLimitError, `came back as ${err.constructor.name}`);
    assert.ok(err.retryAfterMs > 0, 'a rate limit with no rest attached rests nothing');
    return true;
  });
});

test('a 200 that is not JSON fails without quoting what a captive portal sent', async (t) => {
  const mock = await linearServer(t, '<html><body>Sign in to the guest network</body></html>');
  await assert.rejects(connector.collect(ctxFor(mock).ctx), (err) => {
    assert.match(err.message, /not JSON/);
    assert.doesNotMatch(err.message, /guest network/,
      'the body of a sign-in page reaches /api/state and the settings export; it is not the user\'s to read here');
    return true;
  });
});

test('a 200 with no viewer is a failure, never an empty day', async (t) => {
  const mock = await linearServer(t, JSON.stringify({ data: { viewer: null } }));
  await assert.rejects(connector.collect(ctxFor(mock).ctx), /does not know whose issues these are/);
});

/* ================================================================== *
 * 4. The row
 * ================================================================== */

test('an assigned issue becomes a message-shaped row that says how late it is', async (t) => {
  const mock = await linearServer(t, page([issue()]));
  const { rows, part } = await collectRows(mock);
  const [row] = rows;

  assert.equal(rows.length, 1);
  assert.equal(row.subject, 'ENG-412 Retainage schedule');
  assert.equal(row.folder, 'Engineering');
  assert.equal(row.direction, 'in', 'an assigned issue is something that arrived at you');
  assert.deepEqual(row.from, { name: 'Priya Raman', email: 'priya@acme.example' });
  assert.equal(row.threadKey, 'linear:eng-412');
  assert.equal(row.messageId, `linear:issue:${issue().id}`);
  assert.match(row.snippet, /^Overdue by 9 days — was due 2026-08-02/,
    'the snippet is what `renderMessage` prints under every message; overdue and due-today must not read alike');
  assert.match(row.text, /linear\.app\/acme\/issue\/ENG-412/, 'the row has to be openable');
  assert.deepEqual(row.flags, ['\\Flagged'], 'an overdue issue is +10 in scoreInbound and prints as [flagged]');
  assert.equal(part.note, null, 'a clean read is `ok: true`, and a note makes it false');
});

test('a row is addressed to the IDENTITY, which is the address triage actually compares', async (t) => {
  /* core/triage.mjs:590 is `msg.to.some((a) => sameEmail(a?.email, ctx.userEmail))`
     where `ctx.userEmail` is `identity.email` and `sameEmail` is exact
     case-insensitive equality — no alias handling, no domain handling. With
     Linear's own account address here instead, a user whose work tool says
     nemo@work.example and whose Settings identity says nemo@northgate.example scores 0
     instead of 6, so every Linear obligation ranks lower than the connector
     believes and is cut from the prompt earlier. */
  const mock = await linearServer(t, page([issue()]));
  const { rows } = await collectRows(mock);

  assert.ok(rows[0].to.some((a) => String(a?.email).toLowerCase() === IDENTITY),
    `the row is addressed to ${JSON.stringify(rows[0].to)}, which is not the identity triage scores against`);
});

test('with no identity configured the row still names the Linear account', async (t) => {
  const mock = await linearServer(t, page([issue()]));
  const { rows } = await collectRows(mock, { identityEmail: '' });
  assert.deepEqual(rows[0].to, [{ name: VIEWER.name, email: VIEWER.email }],
    'a user who never filled Settings in should not lose the To line entirely');
});

test('a row carries no `uid`, and two sweeps of the same issue insert it once', async (t) => {
  /* THE RULE THAT HAS ALREADY COST THIS PROJECT TWICE. core/db.mjs:384 reads
     `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes 0
     while an OMITTED uid stays null — two different `messageRowId`s for the same
     issue, and a release that flips between them re-inserts every issue this
     connector has ever seen on every sweep, forever. Asserting the key is absent
     is half of it; the other half is driving the REAL upsert twice. */
  const mock = await linearServer(t, page([issue()]));
  const first = (await collectRows(mock)).rows;
  assert.equal(Object.prototype.hasOwnProperty.call(first[0], 'uid'), false,
    'the row carries a uid key — an issue has no integer identity, so omit it entirely or always give it a number');

  const db = freshDb();
  assert.equal(upsertMessages(db, stamp(first)).inserted, 1, 'the first sweep stored nothing');
  const second = (await collectRows(mock)).rows;
  assert.equal(upsertMessages(db, stamp(second)).inserted, 0,
    'the same issue inserted twice — the row id is not stable, so the board duplicates on every sweep');
  assert.equal(listMessages(db, { sourceId: 's_ln' }).length, 1);
});

test('identity is the UUID, so a team move re-groups the row instead of re-inserting it', async (t) => {
  /* `ENG-412` is what a person says out loud and it is not stable: drag the
     issue to another team and Linear renumbers it to `OPS-88`. `messageRowId` is
     the primary key, so identity built on `identifier` re-inserts the issue as
     brand new the day somebody moves it. */
  const mock = await linearServer(t, (nth) => page([
    nth === 1 ? issue() : issue({ identifier: 'OPS-88', team: { name: 'Operations' } }),
  ]));
  const db = freshDb();

  const before = (await collectRows(mock)).rows;
  assert.equal(upsertMessages(db, stamp(before)).inserted, 1);

  const after = (await collectRows(mock)).rows;
  assert.equal(after[0].threadKey, 'linear:ops-88', 'the readable identifier is what regroups, and it costs nothing');
  assert.equal(upsertMessages(db, stamp(after)).inserted, 0,
    'a renumbered issue was inserted as a brand new row — identity is built on the renumberable identifier');
});

test('`date` is the moment of the read, so a six-week-overdue issue survives the prompt window', async (t) => {
  /* NOTE 3, PROVED AGAINST THE REAL DATABASE. `gatherPromptInput` hands the model
     `listMessages(db, {sinceISO})` with sinceISO 21 days back and core/db.mjs:441
     filters on `sent_at >= ?`. Put the due date in `date` and the single most
     urgent row this connector can produce is the one row the model never sees. */
  const overdue = issue({ dueDate: '2026-06-30' });
  const mock = await linearServer(t, page([overdue]));
  const { rows } = await collectRows(mock);
  const db = freshDb();
  upsertMessages(db, stamp(rows));

  assert.equal(rows[0].date, NOW, '`date` is `ctx.now`; the due date appears in words, in the snippet');
  const sinceISO = '2026-07-21T09:00:00-04:00'; // 21 days back, the prompt window
  const visible = listMessages(db, { sourceId: 's_ln', sinceISO });
  assert.equal(visible.length, 1,
    'the most overdue issue in the account fell out of the 21-day prompt window — with the due date in `date` it always will');
  assert.match(visible[0].snippet, /Overdue by 42 days/, 'the dueness has to survive into the snippet');
});

test('the emitted rows are most-overdue-first, because the cap cuts from the end', async (t) => {
  /* core/sweep.mjs:717 truncates with `kept.slice(0, maxRows)` and this connector
     trims to the user's own `maxItems` the same way, so whatever order the rows
     are emitted in is the order in which they survive. Emitting Linear's order —
     creation order, since `orderBy` accepts nothing else — means a cap of 2 drops
     the two most urgent as readily as the two least. */
  const mock = await linearServer(t, page([
    issue({ id: 'a', identifier: 'ENG-1', dueDate: '2026-08-18' }),   // 7 days ahead
    issue({ id: 'b', identifier: 'ENG-2', dueDate: TODAY }),          // today
    issue({ id: 'c', identifier: 'ENG-3', dueDate: '2026-07-01' }),   // 41 days overdue
    issue({ id: 'd', identifier: 'ENG-4', dueDate: '2026-08-05' }),   // 6 days overdue
  ]));
  const { rows, part } = await collectRows(mock, {
    source: { id: 's_ln', label: 'Linear', settings: { maxItems: 2 } },
  });

  assert.deepEqual(rows.map((r) => r.threadKey), ['linear:eng-3', 'linear:eng-4'],
    'the cap kept the wrong two — the ranking is what decides which obligations reach the board at all');
  assert.deepEqual(rows.map((r) => r.flags), [['\\Flagged'], ['\\Flagged']]);
  assert.match(part.note, /keeps 2 — the 2 least urgent were dropped/,
    'a silent drop of obligations is the failure this product exists to prevent');
});

test('every field a hostile issue can inflate is bounded before it reaches the database', async (t) => {
  /* `BODY_CHARS` used to cap the description and nothing else. Measured with one
     issue whose fields were each 200,000 characters — a 1.4 MB response, well
     inside the transport's 8 MiB cap, so nothing upstream refuses it: `subject`
     came out at 400,001 chars, `text` at 1,004,101, `threadKey` at 200,007 and
     the addresses at 200,000 each. All of it lands in `messages`, is concatenated
     into the FTS body (core/db.mjs:409-415), and `subject`/`text` are what
     `renderMessage` hands the model. */
  const big = 'x'.repeat(200_000);
  const mock = await linearServer(t, page([issue({
    identifier: big, title: big, description: big, url: `https://linear.app/${big}`,
    priorityLabel: big, state: { name: big, type: 'started' }, team: { name: big },
    creator: { name: big, email: `${big}@acme.example` },
  })], { viewer: { name: big, email: `${big}@work.example` } }));

  const { rows } = await collectRows(mock, { identityEmail: '' });
  const [row] = rows;

  /* The bound each field is held to, and every number is the connector's own
     constant rather than a round figure: subject SUBJECT_CHARS, text TEXT_CHARS,
     threadKey `linear:` + ID_CHARS, the rest NAME_CHARS. Measured before the
     fix, from this same 1.4 MB response: subject 400,001, text 1,004,101,
     threadKey 200,007, folder 200,000, each address 200,000. */
  const sizes = {
    subject: row.subject.length,
    text: row.text.length,
    threadKey: row.threadKey.length,
    folder: row.folder.length,
    fromName: row.from.name.length,
    fromEmail: row.from.email.length,
    to: JSON.stringify(row.to).length,
    snippet: row.snippet.length,
    messageId: row.messageId.length,
  };
  const bounds = {
    subject: 200, text: 6_000, threadKey: 60, folder: 120,
    fromName: 120, fromEmail: 120, to: 300, snippet: 240, messageId: 200,
  };
  for (const [field, cap] of Object.entries(bounds)) {
    assert.ok(sizes[field] <= cap,
      `${field} is ${sizes[field]} characters against a cap of ${cap} — one issue can write a megabyte `
      + 'into the messages table, the FTS index and the model prompt');
  }

  const db = freshDb();
  assert.equal(upsertMessages(db, stamp(rows)).inserted, 1, 'a bounded row still has to store');
});

/* ================================================================== *
 * 5. Paging: what a cut-short read is allowed to claim
 * ================================================================== */

test('hitting the page cap is REPORTED, and the note stops claiming a total it cannot know', async (t) => {
  /* The loop reads `hasNextPage: true` on its fourth page and used to throw it
     away, then print "Linear had 400 issues assigned to you and due" — a
     falsehood the connector generated about an account it had not finished
     reading, with `ok: true` beside it. And the unread ones are an arbitrary
     set: Linear's `orderBy` accepts only createdAt/updatedAt, so pages arrive in
     creation order and the single most overdue issue can sit on page 6 forever. */
  const mock = await linearServer(t, (nth) => page(
    Array.from({ length: 100 }, (_, i) => issue({ id: `p${nth}-${i}`, identifier: `ENG-${nth}${i}` })),
    { hasNextPage: true, endCursor: `cursor-${nth}` },
  ));
  const { part } = await collectRows(mock, { source: { id: 's_ln', label: 'Linear', settings: { maxItems: 200 } } });

  assert.equal(mock.requests.length, 4, 'MAX_PAGES is what stops a runaway paging loop');
  assert.ok(part.note, 'a partial read reported itself as a clean success');
  assert.match(part.note, /MORE than 400/,
    'the note stated an exact total for a read that stopped with pages still waiting');
  assert.doesNotMatch(part.note, /Linear had 400 issues/, 'that sentence is the falsehood');
  assert.match(part.note, /Days ahead to look/, 'a partial read with no way out of it is not a diagnosis');
});

test('a page bigger than it was asked for is bounded rather than spread into a RangeError', async (t) => {
  /* `first: 100` is a request, not a guarantee. `issues.push(...nodes)` is one
     call argument per node, and a measured 200,000-node page — 6.6 MB, inside
     the transport's 8 MiB cap, so `readCapped` passes it straight through —
     throws `RangeError: Maximum call stack size exceeded` instead of being read
     or refused. 500 nodes here rather than 200,000 because the bound is what
     makes the spread impossible, and a 6.6 MB fixture costs a minute of CI. */
  const mock = await linearServer(t, page(
    Array.from({ length: 500 }, (_, i) => issue({ id: `n${i}`, identifier: `ENG-${i}` })),
  ));
  const { rows, part } = await collectRows(mock, { source: { id: 's_ln', label: 'Linear', settings: { maxItems: 200 } } });

  assert.equal(rows.length, 200, 'the row cap still applies');
  assert.match(part.note, /MORE than 400/,
    'a page that ignored `first: 100` was swallowed whole — nothing bounds what one response can put in memory');
});

test('a page that fails after an earlier one succeeded keeps the rows already read', async (t) => {
  /* A throw out of `collect` discards every row already in hand, so one 500 on
     the last page costs the user 300 obligations and shows them nothing at all.
     The failure is reported as a note, which core/sweep.mjs:712-726 renders as
     `ok: false` with the sentence in `error` — "some of it", which is what
     happened. */
  const mock = await linearServer(t, (nth) => (nth === 1
    ? page([issue()], { hasNextPage: true, endCursor: 'cursor-1' })
    : { status: 500, text: '{"errors":[{"message":"upstream"}]}' }));

  const { rows, part } = await collectRows(mock);

  assert.equal(rows.length, 1, 'page one\'s rows were thrown away because page two failed');
  assert.ok(part.note, 'a partial read was reported as a clean success');
  assert.match(part.note, /stopped answering part-way through/);
  assert.match(part.note, /MORE than 1/, 'a read the server cut short cannot state a total either');
  assert.doesNotMatch(part.note, /Days ahead to look/,
    'the horizon is the user\'s to move and the 500 was not — this sends them to fix the one thing that was working');
});

test('an AuthError on a later page still propagates, dead rows in hand or not', async (t) => {
  /* The exception to the rule above, and it is not negotiable: an AuthError has
     to reach core/sweep.mjs:740 or a refused key is retried every half hour
     forever, and a RateLimitError has to set `notBefore` or the next sweep spends
     an allowance the server has already refused. */
  const mock = await linearServer(t, (nth) => (nth === 1
    ? page([issue()], { hasNextPage: true, endCursor: 'cursor-1' })
    : JSON.stringify({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] })));

  await assert.rejects(connector.collect(ctxFor(mock).ctx), (err) => {
    assert.ok(err instanceof AuthError, `a refused key on page two came back as ${err.constructor.name}`);
    return true;
  });
});

test('an issue with no id is dropped rather than collapsed onto one shared row', async (t) => {
  /* `messageId` is `linear:issue:${id}`, so without an id every such issue in a
     sweep produces the same row id and they overwrite each other inside one
     `upsertMessages` transaction. Measured with two distinct issues: one row
     survived. A GraphQL partial response nulling one field is exactly the shape
     that makes this reachable. */
  const mock = await linearServer(t, page([
    issue({ id: '', identifier: 'ENG-1' }),
    issue({ id: undefined, identifier: 'ENG-2' }),
    issue({ id: 'real', identifier: 'ENG-3' }),
  ]));
  const { rows, part } = await collectRows(mock);

  assert.deepEqual(rows.map((r) => r.messageId), ['linear:issue:real'],
    'an id-less issue reached the database, where it silently overwrites the next one');
  assert.match(part.note, /2 issues arrived with no id/,
    'a row that cannot be tracked between sweeps disappeared without a word');
});

/* ================================================================== *
 * 6. Dueness, and `zelos doctor`
 * ================================================================== */

test('dueness compares day keys and never converts a TimelessDate through a Date', () => {
  /* Feeding a bare `YYYY-MM-DD` to `new Date()` reads it as UTC midnight, and
     re-expressing that anywhere west of Greenwich lands it on the day BEFORE —
     every issue due today reported as one day overdue, for every user in the
     Americas. */
  assert.deepEqual(dueness('2026-08-02', TODAY), { key: '2026-08-02', overdueDays: 9 });
  assert.deepEqual(dueness(TODAY, TODAY), { key: TODAY, overdueDays: 0 });
  assert.deepEqual(dueness('2026-08-18', TODAY), { key: '2026-08-18', overdueDays: -7 });
  assert.deepEqual(dueness(null, TODAY), { key: null, overdueDays: null });
  assert.deepEqual(dueness('2026-08-02', null), { key: '2026-08-02', overdueDays: null });
});

test('duePhrase keeps a due date it is holding, even when the dueness is unknown', () => {
  /* The guard tested `overdueDays` and printed "No due date" for an issue that
     had one, throwing the date away and sorting the entry to the very bottom. */
  assert.equal(duePhrase({ key: '2026-08-02', overdueDays: null }), 'Due 2026-08-02');
  assert.equal(duePhrase({ key: null, overdueDays: null }), 'No due date');
  assert.equal(duePhrase({ key: '2026-08-02', overdueDays: 1 }), 'Overdue by 1 day — was due 2026-08-02');
  assert.equal(duePhrase({ key: TODAY, overdueDays: 0 }), `Due today, ${TODAY}`);
  assert.equal(duePhrase({ key: '2026-08-12', overdueDays: -1 }), 'Due in 1 day, 2026-08-12');
});

test('doctor runs the sweep\'s own query and names the account the key belongs to', async (t) => {
  /* A `viewer { name }` probe proves the key works and proves nothing about the
     query, so a filter Linear has stopped accepting would pass doctor and fail at
     07:00 — and this is the command a stuck user runs. */
  const mock = await linearServer(t, page([issue(), issue({ id: 'b', dueDate: '2026-08-18' })]));
  const verdict = await connector.check({ id: 's_ln', settings: {} }, { http: transportFor(mock) });

  assert.equal(verdict.status, 'pass', verdict.detail);
  assert.equal(mock.requests[0].body.query, ISSUES_QUERY, 'doctor asked a cheaper question than the sweep asks');
  assert.match(verdict.detail, /Signed in as Nemo Hale/);
  assert.match(verdict.detail, /1 of them overdue/);
});

test('doctor returns a refusal rather than throwing one', async (t) => {
  /* core/doctor.mjs:945 would catch a throw and describe it as a fault inside
     Zelos, which sends the reader to the wrong place when the real answer is
     "your key was refused". */
  const mock = await linearServer(t, JSON.stringify({
    errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }],
  }));
  const verdict = await connector.check({ id: 's_ln', settings: {} }, { http: transportFor(mock) });

  assert.equal(verdict.status, 'fail');
  assert.match(verdict.detail, /Authentication required/);
  assert.match(verdict.action, /linear\.app\/settings\/api/, 'a failure with nowhere to go is not a diagnosis');
});
