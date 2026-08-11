/**
 * test/connector-github.test.mjs — the notifications reader, against a real
 * socket.
 *
 * This file exists because an adversarial review proved the connector had NO
 * behavioural coverage: nine mutations applied at once — `direction: 'out'`,
 * `uid: null`, the no-id guard deleted, the pulls-to-issues rewrite deleted,
 * the To line blanked, `participating` forced false, `all=false` flipped to
 * `all=true`, the `If-Modified-Since` header deleted, and the short-page break
 * deleted — left the whole suite green. Every one of those is a defect a
 * refactor could reintroduce with no signal, and two of them (`uid: null` and
 * the To line) are the exact failures other connectors already have dedicated
 * tests for.
 *
 * Nothing here contacts github.com. A loopback server answers, which is also
 * the only way to assert on the REQUEST — the conditional header, the
 * participating flag, the pagination stop — and the request is half of what
 * this connector is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const github = (await import('../core/connectors/github.mjs')).default;
const { createHttp } = await import('../core/connectors/http.mjs');
const { upsertMessages, open, close, migrate } = await import('../core/db.mjs');

/* ------------------------------------------------------------------ *
 * A GitHub that does what each test says
 * ------------------------------------------------------------------ */

function notification(over = {}) {
  return {
    id: '1',
    reason: 'review_requested',
    updated_at: '2026-08-11T12:30:00Z',
    repository: { full_name: 'octocat/Hello-World' },
    subject: {
      title: 'Retainage schedule',
      type: 'PullRequest',
      url: 'https://api.github.com/repos/octocat/Hello-World/pulls/456',
    },
    ...over,
  };
}

async function githubServer(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers } });
    handler(req, res, seen.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A ctx shaped like the one the sweep builds, pointed at the loopback server. */
function ctxFor(origin, { settings = {}, cursor = null } = {}) {
  const emitted = [];
  return {
    source: { id: 's_gh', label: 'GitHub', settings: { apiBase: origin, ...settings } },
    secret: 'ghp_a_token',
    cursor,
    label: 'GitHub',
    window: { from: '2026-08-01T00:00:00Z', to: '2026-08-12T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: '2026-08-11T13:00:00+00:00',
    emit: (m) => emitted.push(m),
    signal: null,
    log: { warn() {}, info() {}, debug() {} },
    emitted,
    http: createHttp({
      origins: [origin],
      limits: github.limits,
      credential: github.credential,
      secret: 'ghp_a_token',
    }),
  };
}

const okJson = (res, body, headers = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/* ================================================================== *
 * The request
 * ================================================================== */

test('the first read asks only for unread threads the user participates in', async (t) => {
  /* `all=false` and `participating=true` are the whole reason this connector is
     a "what needs you" feed rather than a firehose. Flipping either turns a
     board into every notification from every watched repo, which is the thing
     the connector exists not to do — and neither flip changes a single row's
     SHAPE, so nothing else here would notice. */
  const { origin, seen } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const ctx = ctxFor(origin);

  await github.collect(ctx);

  assert.match(seen[0].url, /all=false/, 'the reader asked for read notifications too');
  assert.match(seen[0].url, /participating=true/, 'the reader asked for watched repos it was not told to watch');
  assert.equal(seen[0].headers['x-github-api-version'], '2022-11-28',
    'the pinned API version is missing, so the payload shape can change on a date nobody here chose');
});

test('includeWatched widens the request, and that is the only thing that does', async (t) => {
  const { origin, seen } = await githubServer(t, (req, res) => okJson(res, []));
  await github.collect(ctxFor(origin, { settings: { includeWatched: true } }));
  assert.match(seen[0].url, /participating=false/, 'the setting did not reach the request');
});

/* ================================================================== *
 * The rows
 * ================================================================== */

test('a row carries no uid, so a second sweep of the same notification inserts nothing', async (t) => {
  /* The rule that has already cost this project once: `uid: null` coerces to 0
     in upsertMessage while an omitted uid stays null, and the two hash to
     different row ids — so a connector that flips between them re-inserts every
     row it has ever seen, on every sweep, forever. Asserted against the REAL
     database rather than by reading the object, because the coercion is the
     part that bites. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const result = await github.collect(ctxFor(origin));
  const rows = result.parts.flatMap((p) => p.rows);
  assert.equal(rows.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'uid'), false,
    'the row carries a uid key — omit it entirely or always give it a number, never null');

  const db = open(':memory:');
  t.after(() => close(db));
  migrate(db);
  const first = upsertMessages(db, rows);
  const second = upsertMessages(db, rows);
  assert.equal(first.inserted, 1, 'the first sweep stored nothing');
  assert.equal(second.inserted, 0,
    'the same notification inserted twice — the row id is not stable, so the board duplicates every sweep');
});

test('a review request puts the user on the To line, which is how triage sees it at all', async (t) => {
  /* core/triage.mjs scores from `to`/`cc`/`flags`/`direction` and never reads
     prose, so a connector that only wrote "Review requested" into the subject
     would have told a human and hidden it from the ranker. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    notification({ id: '1', reason: 'review_requested' }),
    notification({ id: '2', reason: 'subscribed', subject: { title: 'FYI', type: 'Issue', url: `${origin}/repos/o/r/issues/9` } }),
  ]));
  const rows = (await github.collect(ctxFor(origin))).parts.flatMap((p) => p.rows);

  const addressed = rows.find((r) => /Retainage/.test(r.subject));
  const watched = rows.find((r) => /FYI/.test(r.subject));
  assert.ok(addressed.to?.some((a) => /nemo@example\.com/i.test(a?.email ?? '')),
    'a review request did not put the user on the To line, so triage cannot weigh it');
  assert.ok(!watched.to?.some((a) => /nemo@example\.com/i.test(a?.email ?? '')),
    'a merely-watched thread was addressed to the user, which inflates everything');
  assert.equal(addressed.direction, 'in', 'a notification is something that arrived');
});

test('every notification on one pull request is one board item', async (t) => {
  /* GitHub reports the same PR under `pulls/456` and `issues/456` depending on
     the event. Keyed naively that is two conversations, and six comments on one
     review is six board items. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    notification({ id: '1', subject: { title: 'Retainage', type: 'PullRequest', url: `${origin}/repos/o/r/pulls/456` } }),
    notification({ id: '2', subject: { title: 'Retainage', type: 'Issue', url: `${origin}/repos/o/r/issues/456` } }),
  ]));
  const rows = (await github.collect(ctxFor(origin))).parts.flatMap((p) => p.rows);
  assert.equal(new Set(rows.map((r) => r.threadKey)).size, 1,
    'the same pull request produced two threads, so it will be two items on the board');
});

/* ================================================================== *
 * The cursor
 * ================================================================== */

test('the conditional header is sent, and a 304 is a free read of nothing', async (t) => {
  const { origin, seen } = await githubServer(t, (req, res, n) => {
    if (n === 1) { okJson(res, [notification()], { 'last-modified': 'Tue, 11 Aug 2026 12:30:00 GMT' }); return; }
    res.writeHead(304, { 'last-modified': 'Tue, 11 Aug 2026 12:30:00 GMT' });
    res.end();
  });

  const first = await github.collect(ctxFor(origin));
  assert.equal(first.cursor.lastModified, 'Tue, 11 Aug 2026 12:30:00 GMT', 'the validator was not stored');

  const second = await github.collect(ctxFor(origin, { cursor: { ...first.cursor, polledAtMs: 0 } }));
  assert.equal(seen[1].headers['if-modified-since'], 'Tue, 11 Aug 2026 12:30:00 GMT',
    'the validator was stored and then not sent, which spends the hourly budget for nothing');
  assert.equal(second.parts.flatMap((p) => p.rows).length, 0);
});

test('REGRESSION: changing what is asked for throws the validator away', async (t) => {
  /* `Last-Modified` describes the answer to ONE question. Add a repo, switch CI
     activity on, widen to watched threads — and the stored validator still
     describes the old question, so GitHub answers 304 and the connector says
     "nothing new" about notifications that were on the server all along.
     Measured before the fix: a sweep scoped to one repo, the user adds a
     second, and the next sweep reports zero rows while the new repo's
     notifications were in the response body both times. On a quiet account the
     validator holds for a day, so the user edits Settings, sees a confident
     green zero, and has nothing to read. */
  const { origin, seen } = await githubServer(t, (req, res, n) => {
    if (n === 1) { okJson(res, [notification()], { 'last-modified': 'Tue, 11 Aug 2026 12:30:00 GMT' }); return; }
    // A server that would answer 304 to the OLD question, and has rows for the new one.
    if (req.headers['if-modified-since']) { res.writeHead(304); res.end(); return; }
    okJson(res, [notification({ id: '2', repository: { full_name: 'acme/widgets' } })],
      { 'last-modified': 'Tue, 11 Aug 2026 13:00:00 GMT' });
  });

  const first = await github.collect(ctxFor(origin, { settings: { repos: 'octocat/Hello-World' } }));
  assert.ok(first.cursor.shape, 'the cursor does not record the shape of the question it answered');

  // The user widens the scope in Settings; the cursor is the one from before.
  const widened = await github.collect(ctxFor(origin, {
    settings: { repos: 'octocat/Hello-World, acme/widgets' },
    cursor: { ...first.cursor, polledAtMs: 0 },
  }));

  assert.ok(!seen[1].headers['if-modified-since'],
    'the stale validator was sent for a question it does not describe, so GitHub answered 304 about the old scope');
  assert.equal(widened.parts.flatMap((p) => p.rows).length, 1,
    'widening the scope returned nothing — the notification was in the response body and was thrown away');
});

/* ================================================================== *
 * Failure
 * ================================================================== */

test('an auth failure is an error, never an empty day', async (t) => {
  /* The worst possible lie this product can tell: a revoked token reported as
     "nothing needs you". The board goes quiet and the silence looks like calm. */
  const { origin } = await githubServer(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
  });
  await assert.rejects(() => github.collect(ctxFor(origin)),
    (err) => {
      assert.match(String(err?.message ?? ''), /credential|token|auth/i,
        `the error does not say the token is the problem: ${err?.message}`);
      return true;
    });
});

test('a 200 that is not a list of notifications is a failure, not zero rows', async (t) => {
  const { origin } = await githubServer(t, (req, res) => okJson(res, { message: 'Bad credentials' }));
  await assert.rejects(() => github.collect(ctxFor(origin)));
});
