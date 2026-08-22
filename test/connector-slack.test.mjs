/**
 * test/connector-slack.test.mjs — the Slack workspace reader, against a real
 * socket.
 *
 * THIS FILE EXISTS BECAUSE THERE WAS NOTHING. An adversarial review mirrored
 * the repo, sabotaged the copy five ways — `uid: null` on every row, `return
 * body` in place of the `ok:false` throw, `direction` pinned to `'in'`, the
 * channel namespace stripped off `threadKey`, MAX_HISTORY_PAGES raised from 8
 * to 100,000 — and the 1,207-test suite stayed green on all five. Every defect
 * this file now guards shipped through that gap, including the two the
 * connector's own comments spend sixteen and six lines respectively warning
 * about.
 *
 * WHAT IS HARD ABOUT TESTING THIS CONNECTOR, and what the mock below is shaped
 * around:
 *
 *  1. FAILURE ARRIVES AS HTTP 200. A revoked token, a missing scope, a channel
 *     the token cannot see — Slack answers all of them 200 with `{"ok": false}`.
 *     So `ctx.http` cannot help and every failure decision is the connector's.
 *     A version that trusted `res.status` reads `body.messages` off `{ok:false}`,
 *     gets undefined, emits zero rows and reports the source healthy: a dead
 *     token that looks like a quiet week.
 *
 *  2. THE COST OF A SWEEP IS COUNTABLE. The mock records every call by method,
 *     so "selection does not cost a `users.info` per person you have ever DMed"
 *     is an assertion about a number rather than a claim about a comment. The
 *     measurement that started this file: 200 IMs and `onlyChannels: 'site-ops',
 *     maxChannels: 1` cost 118 `users.info` calls, zero `conversations.history`,
 *     and then threw.
 *
 * EVERY SOCKET GOES TO 127.0.0.1. The connector reads the real
 * https://slack.com/api and the transport's origin allow-list is enforced
 * against that real origin; only `createHttp`'s `fetchImpl` seam — the same one
 * core/doctor.mjs uses — swaps the host for the mock, so the allow-list is
 * exercised for real and nothing dials Slack. `globalThis.fetch` is wrapped for
 * the length of the run so that if an edit ever forgets, this suite says so
 * instead of contacting a stranger's workspace from whatever machine is running
 * it.
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
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-slack-'));
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

const slack = (await import('../core/connectors/slack.mjs')).default;
const {
  CURSOR_VERSION, packCursor, prettyName, renderSlackText, tsToISO, validMark,
} = await import('../core/connectors/slack.mjs');
const { AuthError, RateLimitError, createHttp } = await import('../core/connectors/http.mjs');
const { assertShape } = await import('../core/connectors/index.mjs');
const {
  open, close, migrate, upsertMessages, listMessages, messagesInThread,
} = await import('../core/db.mjs');

let seq = 0;
const openDbs = [];

function freshDb() {
  const db = open(path.join(HOME_ROOT, `slack${seq += 1}.db`));
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

const TOKEN = 'xoxp-test-0e2a4c6b';
const NOW = '2026-08-11T13:00:00.000Z';
const NOW_MS = Date.parse(NOW);

/** Slack's own encoding: epoch seconds, six decimals, and a STRING. */
const ts = (isoOrMs, micro = 0) => {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}${String(micro).padStart(3, '0')}`;
};

const IM_DANA = { id: 'D_DANA', is_im: true, user: 'U_DANA' };
const CH_OPS = { id: 'C_OPS', name: 'site-ops', is_channel: true, is_member: true };
const CH_ZONING = { id: 'C_ZONING', name: 'zoning', is_channel: true, is_member: true };
const MPIM = { id: 'G_CREW', is_mpim: true, name: 'mpdm-dana--ali--nemo-1' };

/** The four-message DM the review measured: a question, a promise, an answer. */
const DM_THREAD = [
  { user: 'U_DANA', ts: ts('2026-08-11T09:00:03Z'), text: 'Thursday works.' },
  { user: 'U_ME', ts: ts('2026-08-11T09:00:02Z'), text: 'I will have the shop drawings to you Thursday.' },
  { user: 'U_DANA', ts: ts('2026-08-11T09:00:01Z'), text: 'When can I expect the shop drawings?' },
  { user: 'U_ME', ts: ts('2026-08-11T09:00:00Z'), text: 'Morning.' },
];

/* ------------------------------------------------------------------ *
 * A slack.com on 127.0.0.1
 * ------------------------------------------------------------------ */

/**
 * Routes are keyed by Web API method. A route is a body (object or string) or
 * `(params, nth, res) => body`; returning `undefined` from the function form
 * means the route wrote the response itself, which is how the HTTP-level cases
 * (a real 429, an HTML proxy page) are expressed.
 *
 * `calls` records every request in order, which is the only way to assert what
 * a sweep COST — see the users.info tests.
 */
async function slackServer(t, routes = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://slack.test');
    const method = url.pathname.replace(/^\/api\//, '');
    const params = Object.fromEntries(url.searchParams.entries());
    calls.push({ method, params, headers: { ...req.headers } });
    const nth = calls.filter((c) => c.method === method).length;

    const route = routes[method];
    if (route === undefined) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
      return;
    }
    const out = typeof route === 'function' ? route(params, nth, res) : route;
    if (out === undefined) return; // the route answered for itself
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof out === 'string' ? out : JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

/** The default workspace: the token's owner is U_ME in team Alder. */
const AUTH_OK = { ok: true, user_id: 'U_ME', user: 'nemo', bot_id: '', team: 'Alder', team_id: 'T_ALDER' };

const listOf = (...channels) => ({ ok: true, channels, response_metadata: { next_cursor: '' } });
const historyOf = (...messages) => ({ ok: true, messages, response_metadata: { next_cursor: '' } });

/** `users.info` for a fixed map of ids, and `user_not_found` for anyone else. */
const usersFrom = (map) => (params) => {
  const name = map[params.user];
  return name
    ? { ok: true, user: { id: params.user, name, profile: { display_name: name, real_name: name } } }
    : { ok: false, error: 'user_not_found' };
};

const NAMES = usersFrom({ U_DANA: 'dana', U_ME: 'nemo', U_ALI: 'ali' });

/**
 * The real transport, built from the real manifest, pointed at the mock.
 *
 * `origins`, `limits` and `credential` all come off the connector, so flipping
 * any of them turns these tests red. `minGapMs` is the ONE thing overridden:
 * it is 1,200 ms of wall-clock pacing per request, which is a property of
 * Slack's Tier 3 and not a behaviour of this connector — paying it would make a
 * twenty-channel test take half a minute. The budget is left real, because
 * spending it IS behaviour.
 */
function transportFor(mock, over = {}) {
  return createHttp({
    origins: slack.origins,
    limits: { ...slack.limits, minGapMs: 0 },
    credential: slack.credential,
    secret: TOKEN,
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      return realFetch(`${mock.origin}${url.pathname}${url.search}`, init);
    },
    ...over,
  });
}

function ctxFor(mock, { settings = {}, cursor = null, signal = null, http: client = null } = {}) {
  const emitted = [];
  return {
    source: { id: 's_slack', enabled: true, label: 'Slack', type: 'slack', keyRef: 'slack.s_slack', settings },
    label: 'Slack',
    secret: TOKEN,
    cursor,
    window: { from: '2026-08-04T13:00:00.000Z', to: '2026-08-11T13:00:00.000Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: NOW,
    emit: (message, done = 0, total = 0) => emitted.push({ message, done, total }),
    signal,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: client || transportFor(mock),
    emitted,
  };
}

const countOf = (mock, method) => mock.calls.filter((c) => c.method === method).length;
const rowsOf = (result) => result.parts.flatMap((p) => p.rows || []);
const stamp = (rows) => rows.map((r) => ({ ...r, sourceId: 's_slack' }));

/* ================================================================== *
 * 1. The manifest
 * ================================================================== */

test('the manifest satisfies the connector interface and pins the one host it reads', () => {
  assert.doesNotThrow(() => assertShape(slack));
  assert.equal(slack.type, 'slack');
  assert.equal(slack.sink, 'messages');
  assert.deepEqual(slack.origins, ['https://slack.com']);

  /* Non-negotiable: the token is a header, never a query parameter — a token in
     a query string is logged intact by every proxy between here and Slack, and
     core/log.mjs can only redact what it can recognise. */
  assert.equal(slack.credential.send.as, 'header');
  assert.equal(slack.credential.send.prefix, 'Bearer ');

  // There is no `type: 'url'` field, because `originsFor` widens the allow-list
  // with any URL the user typed — a "Slack API base" setting would be a way to
  // point a token at a host that is not Slack.
  assert.equal(slack.fields.some((f) => f.type === 'url'), false);
});

test('the transport built from this manifest refuses any other host', async (t) => {
  const mock = await slackServer(t, { 'auth.test': AUTH_OK });
  await assert.rejects(
    transportFor(mock).get(`${mock.origin}/api/auth.test`),
    /not one of this source's addresses/,
  );
  assert.equal(mock.calls.length, 0, 'the allow-list is checked before a socket exists');
});

/* ================================================================== *
 * 2. A 200 that means no
 * ================================================================== */

test('`{ok:false, error:"invalid_auth"}` on an HTTP 200 is an AuthError, never a quiet week', async (t) => {
  /* The worst lie this product can tell: a revoked token reported as "nothing
     needs you". `ctx.http` sees a 200 and can do nothing here, so the whole
     decision is the connector's. */
  const mock = await slackServer(t, { 'auth.test': { ok: false, error: 'invalid_auth' } });

  await assert.rejects(slack.collect(ctxFor(mock)), (err) => {
    assert.ok(err instanceof AuthError, `a dead token came back as ${err.constructor.name}, so the sweep retries it every half hour`);
    assert.match(err.message, /invalid_auth/);
    assert.match(err.message, /reinstall/i, 'a failure with nowhere to go is not a diagnosis');
    return true;
  });
});

test('a dead token found on the SECOND call is still an AuthError', async (t) => {
  // `token_revoked` mid-sweep is the ordinary way a token dies: auth.test was
  // fine thirty minutes ago and the listing is where it shows up.
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'conversations.list': { ok: false, error: 'token_revoked' },
  });
  await assert.rejects(slack.collect(ctxFor(mock)), (err) => err instanceof AuthError);
});

test('`missing_scope` is a plain error, not a six-hour park', async (t) => {
  /* Deliberate, and the comment at DEAD_TOKEN says why: the fix is to add the
     scope and reinstall, a bot token frequently survives that reinstall
     unchanged, so `authResting` would keep Slack dark for six hours after the
     user had already fixed it. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'conversations.list': { ok: false, error: 'missing_scope', needed: 'channels:read' },
  });
  await assert.rejects(slack.collect(ctxFor(mock)), (err) => {
    assert.ok(!(err instanceof AuthError), 'a missing scope parked the source for six hours');
    assert.match(err.message, /channels:read/, 'the scope Slack asked for is the whole fix');
    return true;
  });
});

test('a 200 that is not JSON says which host answered and what it was', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': (params, nth, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>upstream connect error</body></html>');
      return undefined;
    },
  });
  await assert.rejects(slack.collect(ctxFor(mock)), /slack\.com answered auth\.test with a body that is not JSON/);
});

test('one channel refusing does not cost the workspace', async (t) => {
  /* `not_in_channel` on a private channel the token can LIST but not read. One
     part per conversation exists for exactly this: the failure has to cost the
     user that channel, not the sweep. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS, CH_ZONING),
    'conversations.history': (params) => (params.channel === 'C_ZONING'
      ? { ok: false, error: 'not_in_channel' }
      : historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Crane window moved to Tuesday.' })),
  });

  const result = await slack.collect(ctxFor(mock));
  const failed = result.parts.find((p) => p.error);
  const read = result.parts.find((p) => p.rows.length);

  assert.ok(failed, 'the refused channel produced no part, so nothing on any surface says why it is missing');
  assert.equal(failed.label, '#zoning');
  assert.match(String(failed.error.message), /not_in_channel/);
  assert.equal(read.label, '#site-ops');
  assert.equal(read.rows.length, 1, 'one channel refusing took the other channel down with it');
});

/* ================================================================== *
 * 3. The row
 * ================================================================== */

test('a row carries no `uid`, and a second sweep of the same message inserts nothing', async (t) => {
  /* THE RULE THAT HAS ALREADY COST THIS PROJECT TWICE. core/db.mjs:384 reads
     `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` stores 0
     while an OMITTED uid stays null — two different `messageRowId`s for one
     message. A release that flipped between them would re-insert every Slack
     message it has ever seen on every sweep: `stats.newMessages` never settles,
     `shouldRunFull` forces a full run each time, and the user is billed for a
     model call every thirty minutes.

     Asserted against the REAL database and not by reading the object, because
     the coercion is the part that bites. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(IM_DANA),
    'conversations.history': historyOf(...DM_THREAD),
  });

  const first = rowsOf(await slack.collect(ctxFor(mock)));
  assert.equal(first.length, 4);
  for (const row of first) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'uid'), false,
      'the row carries a uid key — omit it entirely or always give it a number, never null');
  }

  const db = freshDb();
  assert.equal(upsertMessages(db, stamp(first)).inserted, 4);

  const second = rowsOf(await slack.collect(ctxFor(mock)));
  assert.equal(upsertMessages(db, stamp(second)).inserted, 0,
    'the same message inserted twice — the row id is not stable, so the board duplicates every sweep');
  assert.equal(listMessages(db, { sourceId: 's_slack' }).length, 4);
});

test('what the token owner wrote is `out`, and it is what `promised` is mined from', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(IM_DANA),
    'conversations.history': historyOf(...DM_THREAD),
  });

  const rows = rowsOf(await slack.collect(ctxFor(mock)));
  const mine = rows.filter((r) => r.direction === 'out');
  assert.equal(mine.length, 2, 'without `direction` half the board — the whole `promised` bucket — cannot exist');
  assert.ok(mine.every((r) => r.flags.includes('\\Seen')),
    'the user\'s own messages flagged unread take the +8 "unread" bump and fill `now` with their own remarks');
  assert.ok(rows.filter((r) => r.direction === 'in').every((r) => r.flags.length === 0));
  assert.equal(rows[0].folder, '@dana', 'the DM folder is the person, which needs users.info to have been spent');
});

test('a bot message with everything in attachments and blocks is still a row with words in it', async (t) => {
  /* The messages a board exists to catch — a failed deploy, a paged alert —
     carry an empty `text` and everything real in `attachments[]` or `blocks[]`.
     A reader that took only `text` shows them as blank rows with a timestamp. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf(
      {
        bot_id: 'B_DEPLOY',
        username: 'Deploybot',
        ts: ts('2026-08-11T10:00:00Z'),
        text: '',
        attachments: [{ title: 'Build 4821 failed', text: 'retainage-service · main' }],
      },
      {
        bot_id: 'B_PAGE',
        ts: ts('2026-08-11T10:01:00Z'),
        text: '',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Disk 91% on db-1' } }],
      },
    ),
  });

  const rows = rowsOf(await slack.collect(ctxFor(mock)));
  assert.match(rows[0].text, /Build 4821 failed/);
  assert.match(rows[0].text, /retainage-service/);
  assert.equal(rows[0].from.name, 'Deploybot');
  assert.match(rows[1].text, /Disk 91% on db-1/);
  assert.equal(rows[1].from.name, 'a Slack app', 'an unnamed integration is still not the channel');
});

test('Slack talking about itself is not correspondence', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf(
      { subtype: 'channel_join', user: 'U_ALI', ts: ts('2026-08-11T11:00:00Z'), text: 'has joined the channel' },
      { user: 'U_DANA', ts: ts('2026-08-11T10:00:00Z'), text: 'Pour is Thursday.' },
    ),
  });
  const rows = rowsOf(await slack.collect(ctxFor(mock)));
  assert.equal(rows.length, 1, 'a board that surfaces join notices teaches people to ignore the board');
  assert.match(rows[0].subject, /Pour is Thursday/);
});

test('the entities are decoded LAST, so a literal <@U123> stays literal', () => {
  /* The trap this file's own comment calls the one most likely to be tidied
     into a bug: somebody who TYPES `<@U_DANA>` has it delivered as
     `&lt;@U_DANA&gt;`, and decoding first turns their literal text into a
     mention of a person who was never mentioned — then resolves that person's
     name into the body of a message about something else. */
  const resolve = (id) => (id === 'U_DANA' ? 'dana' : null);
  assert.equal(renderSlackText('&lt;@U_DANA&gt; is how you mention someone', resolve),
    '<@U_DANA> is how you mention someone');
  assert.equal(renderSlackText('ping <@U_DANA> please', resolve), 'ping @dana please');
  assert.equal(renderSlackText('<https://a.example/pr/9|the PR>', resolve), 'the PR (https://a.example/pr/9)');
  assert.equal(renderSlackText('<!here> heads up', resolve), '@here heads up');
  assert.equal(renderSlackText('a &amp; b', resolve), 'a & b');
});

test('prettyName turns an mpdm id into the people in it', () => {
  assert.equal(prettyName(MPIM), 'dana, ali, nemo');
  assert.equal(prettyName(CH_OPS), 'site-ops');
});

/* ================================================================== *
 * 4. threadKey — the whole reason `waiting` and `promised` can work
 * ================================================================== */

test('a DM is ONE thread, not one thread per message', async (t) => {
  /* Slack sets `thread_ts` only inside an explicit thread, so ordinary DM
     messages have none and the key used to fall back to the message's own `ts`.
     Measured on this exact four-message DM: four thread keys for one
     conversation, so core/triage.mjs's `threadIndex` gave every message
     `count: 1`, `thread.latest === msg` was unconditionally true, and every
     promise the user ever made in Slack scored `+14 "nobody answered"` forever
     — including this one, which dana answered one second later. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(IM_DANA),
    'conversations.history': historyOf(...DM_THREAD),
  });

  const rows = rowsOf(await slack.collect(ctxFor(mock)));
  const keys = new Set(rows.map((r) => r.threadKey));
  assert.equal(keys.size, 1, `a four-message DM produced ${keys.size} threads: ${[...keys].join(', ')}`);
  assert.equal([...keys][0], 'slack:D_DANA', 'the key must still be namespaced — a bare ts collides across sources');

  // And the promise the user made can actually find its answer.
  const db = freshDb();
  upsertMessages(db, stamp(rows));
  const promise = rows.find((r) => /shop drawings to you Thursday/.test(r.text));
  const inThread = messagesInThread(db, promise.threadKey);
  assert.equal(inThread.length, 4);
  assert.equal(inThread.at(-1).body, 'Thursday works.',
    'the reply is invisible to `messagesInThread`, so the promise reads as unanswered forever');
});

test('a group DM threads on the conversation too', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(MPIM),
    'conversations.history': historyOf(
      { user: 'U_ALI', ts: ts('2026-08-11T09:01:00Z'), text: 'Confirmed.' },
      { user: 'U_ME', ts: ts('2026-08-11T09:00:00Z'), text: 'Crane at seven?' },
    ),
  });
  const rows = rowsOf(await slack.collect(ctxFor(mock)));
  assert.equal(new Set(rows.map((r) => r.threadKey)).size, 1);
  assert.equal(rows[0].threadKey, 'slack:G_CREW');
});

test('a public channel is not one conversation, but an explicit thread is', async (t) => {
  /* #site-ops is a room, not a thread: collapsing it would make its newest
     message the "latest" of everything anyone ever said in it. Two unrelated
     messages are two threads; a broadcast reply lands with its parent. */
  const parent = ts('2026-08-11T09:00:00Z');
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf(
      { subtype: 'thread_broadcast', user: 'U_ALI', ts: ts('2026-08-11T09:05:00Z'), thread_ts: parent, text: 'Pushed to Tuesday.' },
      { user: 'U_DANA', ts: parent, text: 'Crane window?', reply_count: 3 },
      { user: 'U_DANA', ts: ts('2026-08-11T08:00:00Z'), text: 'Unrelated.' },
    ),
  });

  const rows = rowsOf(await slack.collect(ctxFor(mock)));
  const byText = Object.fromEntries(rows.map((r) => [r.text.split('\n')[0], r.threadKey]));
  assert.equal(byText['Pushed to Tuesday.'], `slack:C_OPS:${parent}`,
    'a broadcast reply landed outside its own thread');
  assert.equal(byText['Crane window?'], `slack:C_OPS:${parent}`);
  assert.notEqual(byText['Unrelated.'], byText['Crane window?'],
    'two unrelated channel messages became one thread, so the newest is "latest" for both');

  const withReplies = rows.find((r) => /Crane window/.test(r.text));
  assert.match(withReplies.text, /\(3 replies in thread/,
    'this connector does not fetch replies, so a nineteen-message argument shown as a one-line question lies by omission');
});

/* ================================================================== *
 * 5. What a sweep COSTS — selection before names
 * ================================================================== */

test('a DM-heavy workspace does not spend the budget naming people it will never read', async (t) => {
  /* THE MEASUREMENT THAT STARTED THIS FILE. `users.info` used to be spent once
     per IM in the whole `conversations.list` result — before `onlyChannels` and
     before `maxChannels`. With 200 IMs and a user who asked for exactly one
     channel: 120 calls made, 118 of them `users.info`, ZERO
     `conversations.history`, then a RateLimitError out of `collect` — which
     meant the 118 names it had just paid for were not even cached, so the next
     sweep did the identical thing. At `minGapMs: 1200` that is 144 seconds of
     sleeping per sweep to read nothing, forever. */
  const ims = Array.from({ length: 200 }, (_, i) => ({ id: `D_${i}`, is_im: true, user: `U_${i}` }));
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': usersFrom({}),
    'conversations.list': listOf(...ims, CH_OPS),
    'conversations.history': historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Pour is Thursday.' }),
  });

  const result = await slack.collect(ctxFor(mock, { settings: { onlyChannels: 'site-ops', maxChannels: 1 } }));

  /* Everything before the first `conversations.history` is what CHOOSING cost;
     the lookups after it are message authors, which are rows on the board. */
  const firstRead = mock.calls.findIndex((c) => c.method === 'conversations.history');
  const chose = mock.calls.slice(0, firstRead).filter((c) => c.method === 'users.info').length;
  assert.ok(chose <= 1,
    `selecting one channel cost ${chose} users.info calls out of a budget of ${slack.limits.budget.calls}`);
  assert.equal(countOf(mock, 'conversations.history'), 1, 'the sweep never reached a message');
  assert.equal(rowsOf(result).length, 1);
  assert.equal(result.parts.find((p) => p.rows.length).label, '#site-ops');
});

test('selection never costs more calls than reading does', async (t) => {
  /* The bound, stated as a number: `onlyChannels` matching a DM by the person's
     NAME does need a lookup, and this is what stops that need from being
     unbounded. 200 unknown DM partners, `maxChannels: 5`. */
  const ims = Array.from({ length: 200 }, (_, i) => ({ id: `D_${i}`, is_im: true, user: `U_${i}` }));
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': usersFrom({}),
    'conversations.list': listOf(...ims),
    'conversations.history': historyOf(),
  });

  await slack.collect(ctxFor(mock, { settings: { onlyChannels: 'dana', maxChannels: 5 } }));
  assert.ok(countOf(mock, 'users.info') <= 5,
    `${countOf(mock, 'users.info')} lookups to choose at most 5 conversations`);
});

test('onlyChannels still finds a DM by the person\'s name, and by their id', async (t) => {
  /* The feature the bound above must not have broken: the field's own hint says
     "a channel name without the #, or the name of the person for a DM". */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(IM_DANA, { id: 'D_ALI', is_im: true, user: 'U_ALI' }, CH_OPS),
    'conversations.history': historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Hi.' }),
  });

  const byName = await slack.collect(ctxFor(mock, { settings: { onlyChannels: 'dana' } }));
  assert.deepEqual(byName.parts.filter((p) => p.label).map((p) => p.label), ['@dana']);

  const byId = await slack.collect(ctxFor(mock, { settings: { onlyChannels: 'U_ALI' } }));
  assert.deepEqual(byId.parts.filter((p) => p.label).map((p) => p.label), ['@ali'],
    'the partner id is the exact key, and it costs nothing to match on');
});

test('a cached name makes the next sweep\'s selection free', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(IM_DANA, { id: 'D_ALI', is_im: true, user: 'U_ALI' }),
    'conversations.history': historyOf(),
  });

  const first = await slack.collect(ctxFor(mock, { settings: { onlyChannels: 'dana' } }));
  const spentFirst = countOf(mock, 'users.info');
  await slack.collect(ctxFor(mock, { settings: { onlyChannels: 'dana' }, cursor: first.cursor }));

  assert.ok(spentFirst > 0, 'the first sweep must have paid for the name it cached');
  assert.equal(countOf(mock, 'users.info'), spentFirst,
    'the cursor carries the names, and the second sweep bought them again');
});

/* ================================================================== *
 * 6. The cursor
 * ================================================================== */

test('a rate limit part-way through keeps the marks of the channels it never reached', async (t) => {
  /* The sweep AFTER a throttle used to be strictly more expensive than the one
     that was throttled: `seen` started empty, so every conversation the loop did
     not reach lost the high-water mark it already had and was asked for the full
     `lookbackDays` window again. Measured with four primed marks and Slack
     refusing the second channel: the stored cursor came back holding one. On a
     genuinely throttled workspace that never converges. */
  const primed = packCursor({
    seen: {
      C_OPS: ts('2026-08-10T09:00:00Z'),
      C_ZONING: ts('2026-08-10T09:00:00Z'),
      C_A: ts('2026-08-10T09:00:00Z'),
      C_B: ts('2026-08-10T09:00:00Z'),
    },
    users: { U_DANA: 'dana' },
    usersAt: NOW_MS - 60_000,
  });

  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(
      CH_OPS, CH_ZONING,
      { id: 'C_A', name: 'a-room', is_channel: true, is_member: true },
      { id: 'C_B', name: 'b-room', is_channel: true, is_member: true },
    ),
    // `#a-room` is read first (rank, then folder), and the throttle lands on the
    // second conversation — the case the swallow at the RateLimitError branch
    // exists for.
    'conversations.history': (params) => (params.channel === 'C_A'
      ? historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Pour is Thursday.' })
      : { ok: false, error: 'ratelimited' }),
  });

  const result = await slack.collect(ctxFor(mock, { cursor: primed }));

  assert.deepEqual(Object.keys(result.cursor.seen).sort(), ['C_A', 'C_B', 'C_OPS', 'C_ZONING'],
    'the channels the loop never reached lost their marks, so the next sweep re-reads a week of each');
  assert.equal(result.cursor.seen.C_A, ts('2026-08-11T09:00:00Z'), 'the channel that WAS read must still advance');
  assert.equal(result.cursor.seen.C_B, ts('2026-08-10T09:00:00Z'), 'an untouched mark must come back unchanged');
  assert.equal(result.cursor.seen.C_OPS, ts('2026-08-10T09:00:00Z'));
  assert.equal(rowsOf(result).length, 1, 'the twelve channels that arrived were thrown away to report the thirteenth');
});

test('an abort keeps the marks too', async (t) => {
  const controller = new AbortController();
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS, CH_ZONING),
    'conversations.history': () => {
      controller.abort();
      return historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Pour is Thursday.' });
    },
  });
  const primed = packCursor({ seen: { C_ZONING: ts('2026-08-10T09:00:00Z') }, users: {}, usersAt: NOW_MS });

  const result = await slack.collect(ctxFor(mock, { cursor: primed, signal: controller.signal }));

  assert.equal(countOf(mock, 'conversations.history'), 1, 'the abort was ignored');
  assert.equal(result.cursor.seen.C_ZONING, ts('2026-08-10T09:00:00Z'),
    'a cancelled sweep threw away a mark it never looked at');
});

test('a throttle that read NOTHING is raised, so the sweep can rest the source', async (t) => {
  /* The other half of the trade. Keeping a partial read is worth swallowing the
     error for; keeping nothing is not — and `{ok:false,error:"ratelimited"}` is
     synthesised by this connector, so it never touches the transport's meter.
     Swallowed, core/sweep.mjs records `notBefore: 0` with the whole budget still
     open and tries again in half an hour. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': { ok: false, error: 'ratelimited' },
  });

  await assert.rejects(slack.collect(ctxFor(mock)), (err) => {
    assert.ok(err instanceof RateLimitError, `came back as ${err.constructor.name}`);
    assert.ok(err.retryAfterMs > 0, 'a rate limit with no rest attached rests nothing');
    return true;
  });
});

test('a real HTTP 429 with Retry-After is the transport\'s number, not ours', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'conversations.list': (params, nth, res) => {
      res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' });
      res.end('{}');
      return undefined;
    },
  });
  await assert.rejects(slack.collect(ctxFor(mock)), (err) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfterMs, 30_000, 'a stated limit is a fact and a declared budget is a guess');
    return true;
  });
});

test('the high-water mark is the newest ts SEEN, and `oldest` is the later of it and the floor', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf(
      // Nothing but noise, which must STILL advance the mark — a channel whose
      // last fortnight is join notices would otherwise be re-read forever.
      { subtype: 'channel_join', user: 'U_ALI', ts: ts('2026-08-11T11:00:00Z'), text: 'joined' },
    ),
  });

  const first = await slack.collect(ctxFor(mock, { settings: { lookbackDays: 7 } }));
  assert.equal(mock.calls.find((c) => c.method === 'conversations.history').params.oldest,
    `${Math.floor((NOW_MS - 7 * 86_400_000) / 1000)}.000000`, 'the first sweep asks from the lookback floor');
  assert.equal(first.cursor.seen.C_OPS, ts('2026-08-11T11:00:00Z'));

  await slack.collect(ctxFor(mock, { cursor: first.cursor, settings: { lookbackDays: 7 } }));
  assert.equal(mock.calls.filter((c) => c.method === 'conversations.history').at(-1).params.oldest,
    ts('2026-08-11T11:00:00Z'), 'the second sweep re-read the whole lookback');
});

test('a mark from another version is dropped rather than sent to Slack', async (t) => {
  /* A mark that is too large is PERMANENT: it is sent as `oldest`, Slack has
     nothing after the year 57000, and the reduce only ever moves a mark upward —
     so the channel is silent forever while the part reports `ok: true, count: 0`,
     the exact shape of a quiet week. Measured with milliseconds (the obvious v0
     mistake), an ISO string, and a plain bad number. */
  for (const bad of ['1754899320001', '2026-08-11T12:00:00Z', '99999999999.000000', '']) {
    const mock = await slackServer(t, {
      'auth.test': AUTH_OK,
      'users.info': NAMES,
      'conversations.list': listOf(CH_OPS),
      'conversations.history': historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Pour is Thursday.' }),
    });
    const cursor = { v: CURSOR_VERSION, seen: { C_OPS: bad }, users: {}, usersAt: 0 };

    const result = await slack.collect(ctxFor(mock, { cursor }));
    const asked = mock.calls.find((c) => c.method === 'conversations.history').params.oldest;

    assert.equal(asked, `${Math.floor((NOW_MS - 7 * 86_400_000) / 1000)}.000000`,
      `the mark ${JSON.stringify(bad)} was sent to Slack as \`oldest\`, blacking the channel out`);
    assert.equal(rowsOf(result).length, 1);
    assert.equal(result.cursor.seen.C_OPS, ts('2026-08-11T09:00:00Z'), 'the bad mark survived the sweep');
  }
});

test('validMark keeps a real ts and refuses the rest', () => {
  assert.equal(validMark(ts('2026-08-11T09:00:00Z'), NOW_MS), true);
  assert.equal(validMark('1786430000', NOW_MS), true, 'the six decimals are optional');
  assert.equal(validMark('1754899320001', NOW_MS), false, 'milliseconds');
  assert.equal(validMark('2026-08-11T12:00:00Z', NOW_MS), false, 'an ISO string');
  assert.equal(validMark(String(Math.floor(NOW_MS / 1000) + 86_400), NOW_MS), false, 'tomorrow');
  assert.equal(validMark(1786430000, NOW_MS), false, 'a number is not what Slack sends');
});

test('a cursor from a version this one does not know is not half-trusted', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Hi.' }),
  });
  const future = { v: CURSOR_VERSION + 1, seen: { C_OPS: ts('2026-08-11T08:00:00Z') }, users: { U_DANA: 'dana' }, usersAt: NOW_MS };

  await slack.collect(ctxFor(mock, { cursor: future }));

  assert.equal(mock.calls.find((c) => c.method === 'conversations.history').params.oldest,
    `${Math.floor((NOW_MS - 7 * 86_400_000) / 1000)}.000000`, 'a mark in an unknown encoding was believed');
  assert.equal(countOf(mock, 'users.info'), 1, 'a name cache in an unknown encoding was believed');
});

test('a conversation that is gone loses its mark; one merely not read keeps it', async (t) => {
  const primed = packCursor({
    seen: { C_OPS: ts('2026-08-10T09:00:00Z'), C_ARCHIVED: ts('2026-08-10T09:00:00Z') },
    users: {},
    usersAt: NOW_MS,
  });
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS, CH_ZONING),
    'conversations.history': historyOf(),
  });

  // Only #site-ops is read, and #zoning is still in the workspace.
  const result = await slack.collect(ctxFor(mock, { cursor: primed, settings: { onlyChannels: 'site-ops' } }));

  assert.ok(!('C_ARCHIVED' in result.cursor.seen),
    'a conversation absent from a complete listing kept its mark, so the cursor grows towards the ceiling that drops it');
  assert.equal(result.cursor.seen.C_OPS, ts('2026-08-10T09:00:00Z'));
});

test('a mark is NOT forgotten because the breadth stopped asking for its type', async (t) => {
  /* A mark carries no type. `breadth: 'channels'` asks Slack for no `im` at
     all, so every DM is absent from a listing that is otherwise complete —
     reading that as "these conversations are gone" means flipping the setting
     back costs a week of every DM. */
  const primed = packCursor({ seen: { D_DANA: ts('2026-08-10T09:00:00Z') }, users: {}, usersAt: NOW_MS });
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf(),
  });

  const result = await slack.collect(ctxFor(mock, { cursor: primed, settings: { breadth: 'channels' } }));
  assert.equal(result.cursor.seen.D_DANA, ts('2026-08-10T09:00:00Z'),
    'a narrower breadth was read as "your direct messages no longer exist"');
});

test('a mark is NOT forgotten because a missing scope hid its half of Slack', async (t) => {
  /* "Absent from the list" has to mean "gone", not "not shown to us this time".
     A token missing `im:read` lists no DMs, and forgetting their marks there
     would re-read a week of every DM the moment the scope came back. */
  const primed = packCursor({ seen: { D_DANA: ts('2026-08-10T09:00:00Z') }, users: {}, usersAt: NOW_MS });
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': (params) => {
      if (String(params.types).includes(',')) return { ok: false, error: 'missing_scope', needed: 'im:read' };
      return /im|mpim/.test(params.types) ? { ok: false, error: 'missing_scope', needed: 'im:read' } : listOf(CH_OPS);
    },
    'conversations.history': historyOf(),
  });

  const result = await slack.collect(ctxFor(mock, { cursor: primed }));

  assert.equal(result.cursor.seen.D_DANA, ts('2026-08-10T09:00:00Z'),
    'a scope failure was read as "these conversations no longer exist"');
  const note = result.parts.map((p) => p.note).filter(Boolean).join(' ');
  assert.match(note, /im:read/, 'the user is not told which half of their Slack is dark');
});

test('packCursor trims until it will actually store, names first', () => {
  /* core/sweep.mjs DROPS a cursor over 4,096 characters and logs a warning
     nobody reads, which would mean every sweep re-reads the full lookback of
     every channel forever — the expensive failure this connector can have. */
  const seen = {};
  const users = {};
  for (let i = 0; i < 300; i += 1) seen[`C${i}`] = ts(NOW_MS - i * 86_400_000);
  for (let i = 0; i < 300; i += 1) users[`U${i}`] = `person-number-${i}`;

  const packed = packCursor({ seen, users, usersAt: NOW_MS });
  assert.ok(JSON.stringify(packed).length <= 4096, `packed to ${JSON.stringify(packed).length} characters`);
  assert.equal(Object.keys(packed.users).length, 0, 'names are the cheapest thing to rebuild and go first');
  assert.ok(Object.keys(packed.seen).length > 0, 'the marks are the expensive thing and must survive');
  assert.ok('C0' in packed.seen, 'the NEWEST mark — the channel being read right now — was trimmed first');
});

/* ================================================================== *
 * 7. What the run record says
 * ================================================================== */

test('a healthy token that matches no conversation reports a read of zero, not nothing', async (t) => {
  /* core/sweep.mjs:703 iterates `result?.parts || []`, so an empty array pushes
     NOTHING into `sources[]`: measured end to end, `stats.sources` came back
     `[]`, `sourcesOk` 0, `sourcesFailed` 0 — the source absent from the run
     record, from /api/state, from the Now banner and from the settings export.
     That is the most common first-run state there is: a bot token not yet
     invited to any channel. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'conversations.list': listOf(),
  });

  const result = await slack.collect(ctxFor(mock));

  assert.equal(result.parts.length, 1, 'a source that read zero vanished from the run record entirely');
  assert.deepEqual(result.parts[0], { label: '', rows: [], error: null, note: null });
});

test('the cap doing its job is not a failed source', async (t) => {
  /* core/sweep.mjs:724 sets `ok: !note` and `count: kept.length`, so a note on a
     rows-LESS part is indistinguishable from a failure. Measured with 25
     conversations and the default `maxChannels: 20`: `sourcesOk: 20,
     sourcesFailed: 1`, the failing entry reading "25 conversations matched and
     Zelos read the first 20" with a count of zero — a red Slack on the Now
     banner forever, on an ordinary configuration. Carried by a part that has
     rows it is the shape core/sweep.mjs:713 documents instead: a non-zero count
     with `ok: false`, neither a success nor a failure. */
  const channels = Array.from({ length: 25 }, (_, i) => ({
    id: `C_${String(i).padStart(2, '0')}`, name: `room-${String(i).padStart(2, '0')}`, is_channel: true, is_member: true,
  }));
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(...channels),
    'conversations.history': historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Pour is Thursday.' }),
  });

  const result = await slack.collect(ctxFor(mock));
  const noted = result.parts.filter((p) => p.note);

  assert.equal(noted.length, 1);
  assert.match(noted[0].note, /25 conversations matched/);
  assert.ok(noted[0].rows.length > 0,
    'the note rides on an empty part, which core/sweep.mjs reports as a failed source with a count of zero');
  assert.equal(result.parts.filter((p) => !p.rows.length && !p.error).length, 0,
    'no phantom zero-row part');
});

test('a missing users:read is a note on the board, not silence', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': { ok: false, error: 'missing_scope', needed: 'users:read' },
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Pour is Thursday.' }),
  });

  const result = await slack.collect(ctxFor(mock));

  assert.equal(countOf(mock, 'users.info'), 1, 'the failure must be latched — one refused call for the whole run');
  assert.match(result.parts.map((p) => p.note).filter(Boolean).join(' '), /users:read/);
  assert.equal(rowsOf(result)[0].from.name, 'U_DANA', 'the id is at least honest about being one');
});

test('an id cached as its own name does not outlive the scope that caused it', async (t) => {
  /* Measured: sweep 1 without `users:read` stored `{"U_DANA":"U_DANA"}` in the
     cursor. The user added the scope and reinstalled — exactly what this
     connector's own error text tells them to do — and sweep 2 made ZERO
     `users.info` calls and still showed `@U_DANA`, because `names.has(key)`
     short-circuits. It cleared a week later when the whole cache aged out. */
  let scoped = false;
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': (params) => (scoped ? NAMES(params) : { ok: false, error: 'missing_scope', needed: 'users:read' }),
    'conversations.list': listOf(IM_DANA),
    'conversations.history': historyOf({ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Pour is Thursday.' }),
  });

  const first = await slack.collect(ctxFor(mock));
  assert.deepEqual(first.cursor.users, {}, 'an id is not a name and must not be cached as one');

  scoped = true;
  const second = await slack.collect(ctxFor(mock, { cursor: first.cursor }));
  assert.equal(second.cursor.users.U_DANA, 'dana', 'adding the scope changed nothing for seven days');
  assert.equal(rowsOf(second)[0].folder, '@dana');
});

test('a cursor that already carries an id-as-name recovers on the next sweep', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(IM_DANA),
    'conversations.history': historyOf(),
  });
  const poisoned = { v: CURSOR_VERSION, seen: {}, users: { U_DANA: 'U_DANA' }, usersAt: NOW_MS };

  const result = await slack.collect(ctxFor(mock, { cursor: poisoned }));

  assert.equal(countOf(mock, 'users.info'), 1, 'the stored id-as-name was trusted, so the name is never looked up again');
  assert.equal(result.parts[0].label, '@dana');
});

test('ctx.emit names the conversation being read, for the progress line', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS, IM_DANA),
    'conversations.history': historyOf(),
  });
  const ctx = ctxFor(mock);
  await slack.collect(ctx);
  assert.deepEqual(ctx.emitted, [
    { message: 'Slack: @dana', done: 1, total: 2 },
    { message: 'Slack: #site-ops', done: 2, total: 2 },
  ], 'direct messages are read first — someone typed your name');
});

/* ================================================================== *
 * 8. The page ceilings
 * ================================================================== */

test('a server that hands back a cursor forever is stopped, and says so', async (t) => {
  /* Cursor pagination has no other stopping condition: `has_more` comes from the
     same place the cursor does, so a server bug or a proxy replaying a cached
     page is an infinite loop against a rate-limited API. Raising
     MAX_HISTORY_PAGES from 8 to 100,000 was one of the five sabotages the old
     suite did not notice. */
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': (params, nth) => ({
      ok: true,
      channels: [{ id: `C_${nth}`, name: `room-${nth}`, is_channel: true, is_member: true }],
      response_metadata: { next_cursor: `page-${nth}` },
    }),
    'conversations.history': (params, nth) => ({
      ok: true,
      messages: [{ user: 'U_DANA', ts: ts(NOW_MS - nth * 60_000), text: `page ${nth}` }],
      response_metadata: { next_cursor: `page-${nth}` },
    }),
  });

  const result = await slack.collect(ctxFor(mock, { settings: { maxChannels: 1, maxPerChannel: 1000 } }));

  assert.equal(countOf(mock, 'conversations.list'), 10, 'the list page ceiling is the only stop on this loop');
  assert.equal(countOf(mock, 'conversations.history'), 8, 'the history page ceiling is the only stop on this loop');
  assert.match(result.parts.map((p) => p.note).filter(Boolean).join(' '), /more conversations than Zelos will page through/,
    'the truncation is silent, so "why is #zoning missing" is answerable only by reading a constant');
});

test('the same cursor twice is an ending, not a loop', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': () => ({
      ok: true,
      messages: [{ user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'Hi.' }],
      response_metadata: { next_cursor: 'stuck' },
    }),
  });

  await slack.collect(ctxFor(mock, { settings: { maxPerChannel: 1000 } }));
  assert.equal(countOf(mock, 'conversations.history'), 2,
    'a proxy replaying one page spent every page the ceiling allows');
});

test('maxPerChannel stops the paging as well as the rows', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': (params, nth) => ({
      ok: true,
      messages: Array.from({ length: 5 }, (_, i) => ({
        user: 'U_DANA', ts: ts(NOW_MS - (nth * 10 + i) * 60_000), text: `m${nth}-${i}`,
      })),
      response_metadata: { next_cursor: `p${nth}` },
    }),
  });

  const result = await slack.collect(ctxFor(mock, { settings: { maxPerChannel: 7 } }));
  assert.equal(countOf(mock, 'conversations.history'), 2, 'the connector kept paging past what it was asked for');
  assert.equal(rowsOf(result).length, 7);
});

test('a channel with more messages than the cap says what it skipped, on the part that carries the rows', async (t) => {
  /* `conversations.history` is newest-first, the cap keeps the newest, and the
     high-water mark is the newest ts SEEN — so what the cap drops is the
     oldest tail of the window, and the next sweep asks from above it.
     Measured: three messages, `maxPerChannel: 2`, sweep one kept the two
     newest and said nothing; sweep two asked with `oldest` = the newest ts
     and got `[]`. The oldest was never read, under `ok: true`. The cut is the
     right cut for a triage board and backfilling it would spend the budget on
     old traffic; what was wrong was the silence. */
  const three = [
    { user: 'U_DANA', ts: ts('2026-08-11T09:00:02Z'), text: 'third (newest)' },
    { user: 'U_DANA', ts: ts('2026-08-11T09:00:01Z'), text: 'second' },
    { user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'first (oldest)' },
  ];
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    // Honours `oldest` the way Slack does, so the second sweep sees the skip.
    'conversations.history': (params) => historyOf(...three.filter((m) => Number(m.ts) > Number(params.oldest))),
  });

  const first = await slack.collect(ctxFor(mock, { settings: { maxPerChannel: 2 } }));
  const part = first.parts.find((p) => p.rows.length);
  assert.deepEqual(part.rows.map((r) => r.text), ['third (newest)', 'second']);
  assert.match(part.note ?? '', /#site-ops had more than 2 messages since the last read/,
    'the cut was silent, so "why is Monday missing from #site-ops" had no answer');
  assert.match(part.note, /kept the newest 2 and skipped the rest/);
  assert.match(part.note, /Messages per conversation/, 'the note has to name the setting that moves the line');
  assert.equal(first.parts.filter((p) => p.note && !p.rows.length).length, 0,
    'a note on a rows-less part reads as a failed source with a count of zero');

  const second = await slack.collect(ctxFor(mock, { cursor: first.cursor, settings: { maxPerChannel: 2 } }));
  assert.equal(rowsOf(second).length, 0, 'the skipped tail is not re-read — which is why the first sweep had to say so');
  assert.ok(second.parts.every((p) => !p.note), 'nothing was cut this time, so nothing is said');
});

test('exactly the cap with a page still on offer is a cut too; a channel under the cap is not', async (t) => {
  /* The paging stops at the cap BEFORE it reads the next cursor, so a channel
     holding exactly `maxPerChannel` plus another page used to look complete:
     the only evidence of more was the cursor nobody looked at. #zoning, with
     the same two messages and no further page, is the control — a note there
     would be a false alarm on every ordinary channel. */
  const two = [
    { user: 'U_DANA', ts: ts('2026-08-11T09:00:01Z'), text: 'second' },
    { user: 'U_DANA', ts: ts('2026-08-11T09:00:00Z'), text: 'first' },
  ];
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS, CH_ZONING),
    'conversations.history': (params) => (params.channel === 'C_OPS'
      ? { ok: true, messages: two, response_metadata: { next_cursor: 'one-more-page' } }
      : historyOf(...two)),
  });

  const result = await slack.collect(ctxFor(mock, { settings: { maxPerChannel: 2 } }));
  const ops = result.parts.find((p) => p.label === '#site-ops');
  const zoning = result.parts.find((p) => p.label === '#zoning');
  assert.equal(ops.rows.length, 2);
  assert.match(ops.note ?? '', /#site-ops had more than 2 messages/, 'a cursor still on offer is a cut, and was not read');
  assert.equal(countOf(mock, 'conversations.history'), 2, 'saying so must not cost a page the cap was there to save');
  assert.equal(zoning.rows.length, 2);
  assert.equal(zoning.note, null, 'exactly the cap, with nothing behind it, is a complete read');
});

/* ================================================================== *
 * 9. What the request carries
 * ================================================================== */

test('the token travels as a Bearer header and never in the query string', async (t) => {
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': listOf(CH_OPS),
    'conversations.history': historyOf(),
  });

  await slack.collect(ctxFor(mock));

  for (const call of mock.calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`, `${call.method} sent no credential`);
    assert.equal(JSON.stringify(call.params).includes(TOKEN), false,
      `${call.method} put the token in a query string, which every proxy between here and Slack logs intact`);
  }
});

test('breadth decides which types are asked for, and membership is applied here', async (t) => {
  /* The `types` half is Slack's filter and the `is_member` half is this file's:
     `conversations.list` returns every public channel in the workspace whether
     or not the token's owner has ever opened it. The mock honours `types` so
     both halves are exercised rather than only the one. */
  const LURK = { id: 'C_LURK', name: 'lurking', is_channel: true, is_member: false };
  const mock = await slackServer(t, {
    'auth.test': AUTH_OK,
    'users.info': NAMES,
    'conversations.list': (params) => {
      const types = String(params.types).split(',');
      return listOf(...[IM_DANA, CH_OPS, LURK].filter((c) => types.includes(c.is_im ? 'im' : 'public_channel')));
    },
    'conversations.history': historyOf(),
  });

  const participating = await slack.collect(ctxFor(mock));
  assert.equal(mock.calls[1].params.types, 'im,mpim,private_channel,public_channel');
  assert.deepEqual(participating.parts.filter((p) => p.label).map((p) => p.label), ['@dana', '#site-ops'],
    'a public channel the token has never opened is not "the channels I am in"');

  const channelsOnly = await slack.collect(ctxFor(mock, { settings: { breadth: 'channels' } }));
  assert.equal(channelsOnly.parts.filter((p) => p.label).map((p) => p.label).includes('@dana'), false,
    '"no direct messages" still read a direct message');

  const all = await slack.collect(ctxFor(mock, { settings: { breadth: 'all' } }));
  assert.ok(all.parts.filter((p) => p.label).map((p) => p.label).includes('#lurking'),
    '`all` is the labelled choice that widens this, and it did not');
});

/* ================================================================== *
 * 10. zelos doctor
 * ================================================================== */

test('check names the workspace and the person the token belongs to', async (t) => {
  const mock = await slackServer(t, { 'auth.test': { ...AUTH_OK, bot_id: 'B_ZELOS' } });
  const verdict = await slack.check({ id: 's_slack' }, ctxFor(mock));
  assert.equal(verdict.status, 'pass');
  assert.match(verdict.detail, /Alder/);
  assert.match(verdict.detail, /U_ME/);
  assert.match(verdict.detail, /bot token/, 'which KIND of token it is separates two different fixes');
});

test('check returns a failure rather than throwing one', async (t) => {
  /* core/doctor.mjs turns a throw into "That is a failure inside Zelos rather
     than in your settings", which is the wrong thing to tell someone whose
     token expired. */
  const mock = await slackServer(t, { 'auth.test': { ok: false, error: 'missing_scope', needed: 'users:read' } });
  const verdict = await slack.check({ id: 's_slack' }, ctxFor(mock));
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.detail, /users:read/);
  assert.match(verdict.action, /api\.slack\.com/);
});

test('tsToISO parses the date and never the identity', () => {
  assert.equal(tsToISO('1754899320.001700'), '2025-08-11T08:02:00.002Z');
  assert.equal(tsToISO(''), null);
  assert.equal(tsToISO('not a ts'), null);
  assert.equal(tsToISO('0'), null);
});
