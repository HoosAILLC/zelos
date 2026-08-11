/**
 * test/connectors.test.mjs — the seam, and one connector written against it.
 *
 * Two things are being proved here and they are different things.
 *
 * THE SEAM. That `core/connectors/index.mjs` is what config validation and the
 * run loop actually read, rather than a second hardcoded list sitting beside the
 * ones that were there before. The strongest available proof is a source type
 * that did not exist when the run loop was written — `rss`, in `config.sources`,
 * a config key nothing read a week ago — arriving on the board with no branch
 * anywhere in core/sweep.mjs naming it. If the sweep still held a list, that
 * source would be invisible.
 *
 * THE CONNECTOR. RSS was chosen for the proof because it needs no credential and
 * no vendor account: every test below runs against a real HTTP server on
 * 127.0.0.1 with no secret store involved. A contract that were awkward for a
 * source this plain would be the wrong contract.
 *
 * The secret backend is forced anyway. Nothing here reaches core/secrets.mjs —
 * the feed has no credential — but `runSweep` resolves `getSecret` from
 * DEFAULT_DEPS unless a test replaces it, and a test that forgot to would
 * otherwise read the operator's own login keychain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ZELOS_LOG_LEVEL = 'silent';
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-connectors-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { open, close, migrate, listMessages, getKV, setKV } = await import('../core/db.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const registry = await import('../core/connectors/index.mjs');
const {
  assertShape, describe: describeAll, enabledSources, unknownSources,
  get: connectorFor, originsFor, sourceCursorKey, sourceStateKey, typesFor,
} = registry;
const {
  AuthError, RateLimitError, createHttp, createMeter, parseRetryAfter, originOf, secretHash,
} = await import('../core/connectors/http.mjs');
const { parseFeed } = await import('../core/connectors/rss.mjs');
const { validateConfig, SECRET_KEYS } = await import('../core/config.mjs');

let seq = 0;
const openDbs = [];
const servers = [];

function fresh() {
  const db = open(path.join(HOME_ROOT, `c${seq++}.db`));
  migrate(db);
  openDbs.push(db);
  return db;
}

test.after(async () => {
  for (const db of openDbs) close(db);
  for (const server of servers) await new Promise((r) => server.close(r));
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const RSS_TWO = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Alder &amp; Vance Notices</title>
  <link>https://alder.example/</link>
  <item>
    <title>Retainage schedule posted</title>
    <link>https://alder.example/notices/retainage</link>
    <guid isPermaLink="false">alder-2026-08-09-retainage</guid>
    <pubDate>Sun, 09 Aug 2026 14:02:00 +0000</pubDate>
    <description><![CDATA[<p>The <b>retainage</b> schedule for Q3 is posted.</p>]]></description>
  </item>
  <item>
    <title>Pre-con moved to Thursday</title>
    <link>https://alder.example/notices/precon</link>
    <guid isPermaLink="false">alder-2026-08-10-precon</guid>
    <pubDate>Mon, 10 Aug 2026 08:30:00 +0000</pubDate>
    <description>Bring the schedule of values.</description>
  </item>
</channel></rss>`;

const ATOM_ONE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Vance Engineering</title>
  <link rel="self" href="https://vance.example/feed.xml"/>
  <link rel="alternate" href="https://vance.example/"/>
  <entry>
    <title>Stamped drawings are out</title>
    <link rel="enclosure" href="https://vance.example/drawings.pdf"/>
    <link rel="alternate" href="https://vance.example/posts/stamped"/>
    <id>tag:vance.example,2026:post/41</id>
    <updated>2026-08-10T13:00:00Z</updated>
    <author><name>Dana Vance</name></author>
    <summary>Sheets A1 through A9 are stamped and uploaded.</summary>
  </entry>
</feed>`;

/**
 * A feed server whose behaviour each test dictates.
 *
 * `handler` gets `(req, res, hits)` and may answer however it likes; the default
 * serves `body` with an ETag, which is what makes the conditional-request tests
 * possible without a second server.
 *
 * Closed in the TEST's `after`, not the file's, and that is not tidiness. Every
 * one of these binds an ephemeral port, node:test runs the suite's files in
 * parallel, and test/server.test.mjs asserts that a server offered a busy port
 * lands on exactly `busy + 1`. Holding a dozen listeners open for the length of
 * this file made that assertion fail roughly one run in four — a real defect in
 * a test that had been stable, caused entirely by a neighbour. One or two live
 * listeners at a time is what every other file in the suite costs.
 */
async function feedServer(t, { body = RSS_TWO, etag = null, handler = null } = {}) {
  let hits = 0;
  const seenHeaders = [];
  const server = http.createServer((req, res) => {
    hits += 1;
    seenHeaders.push({ ...req.headers });
    if (handler) { handler(req, res, hits); return; }
    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml', ...(etag ? { etag } : {}) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  if (t && typeof t.after === 'function') {
    t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  } else {
    servers.push(server);
  }
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/feed.xml`,
    hits: () => hits,
    headers: () => seenHeaders,
  };
}

function baseConfig(over = {}) {
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
    sources: [],
    sweep: { intervalMinutes: 30, activeHours: [0, 23], auto: true },
    ui: { accent: '#5b8cff' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
    ...over,
  };
}

const feedSource = (over = {}) => ({
  id: 's_feed',
  enabled: true,
  label: 'Alder notices',
  type: 'rss',
  keyRef: null,
  settings: { url: '', maxItems: 50 },
  ...over,
});

/** Light mode and no secrets: these tests are about the fetch, not the model. */
const sweepDeps = { getSecret: async () => null };

/* ================================================================== *
 * The registry is what the sweep and config actually read
 * ================================================================== */

test('the calendar kinds config validates are the ones the registry offers', () => {
  /* Two lists that must agree, guarded the way this repo already guards the
     route table: the value is parsed out of the source rather than restated
     here, so a third copy cannot appear in the test and quietly become the
     thing being compared. core/config.mjs cannot import the registry — it is
     imported BY core/sources/caldav.mjs, so the edge back would be a cycle one
     eager paths() away from a TDZ crash at launch — so this cross-check is what
     is paid instead. */
  const src = fs.readFileSync(path.join(ROOT, 'core/config.mjs'), 'utf8');
  const m = /const CALENDAR_KINDS = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'CALENDAR_KINDS is no longer declared as a literal array in core/config.mjs');
  const kinds = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  assert.deepEqual(typesFor('calendars'), kinds,
    'config validates a set of calendar kinds the registry does not offer, or the other way round');
});

test('core/sweep.mjs no longer decides anything from a source kind', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core/sweep.mjs'), 'utf8');
  // The two comparisons the unified loop replaced. Either one coming back means
  // the registry has become decoration.
  assert.doesNotMatch(src, /calendar\.kind === '(?:file|caldav|ics)'/,
    'the run loop is branching on a calendar kind again');
  assert.doesNotMatch(src, /config\.mail\s*:\s*\[\]\)\.filter/,
    'the run loop is filtering config.mail itself again instead of asking the registry');
  assert.match(src, /enabledSources\(config\)/, 'the run loop no longer asks the registry what to read');
});

test('enabledSources reads all three places config keeps a source, and drops what names nothing', () => {
  const config = baseConfig({
    mail: [{ id: 'm_1', enabled: true, host: 'imap.example.com' }],
    calendars: [
      { id: 'c_1', enabled: true, kind: 'ics', url: 'https://x.example/a.ics' },
      { id: 'c_off', enabled: false, kind: 'ics', url: 'https://x.example/b.ics' },
      { id: 'c_junk', enabled: true, kind: 'runes', url: 'https://x.example/c.ics' },
    ],
    sources: [
      { id: 's_1', enabled: true, type: 'rss', settings: { url: 'https://x.example/feed' } },
      { id: 's_junk', enabled: true, type: 'nostromo', settings: {} },
    ],
  });

  /* An unrecognised CALENDAR kind falls back to the .ics reader; an
     unrecognised `sources[]` type is dropped. The asymmetry is deliberate and
     it is the behaviour this replaced: the old `defaultFetchEvents` tested
     `=== 'file'`, then `=== 'caldav'`, and let everything else reach
     `fetchIcsText`, so `kind: 'webcal'` produced a real row — events if the URL
     served a calendar, a named error in the Now banner if it did not.

     Dispatching strictly instead made the row VANISH: a calendar the user can
     see in Settings, contributing nothing, with nothing anywhere saying why.
     The registry does have the right answer for that — `unknownSources()` —
     which had no production reader when this was written.

     IT HAS ONE NOW: core/doctor.mjs reads it and names every entry no connector
     claims, asserted in test/connector-seam.test.mjs. So the condition this
     comment set has been met and the fallback below is the LAST thing standing
     between here and a strict dispatch. It is still asserted as a fallback
     because the change belongs in its own diff: the assertion, the comment
     above it and core/connectors/index.mjs's own note all move together, and
     folding that into the pass that built the reader would make both
     unreviewable.

     A generic `sources[]` entry is different: there is no sensible default
     reader for a type nobody claims, so it is dropped and reported. */
  assert.deepEqual(
    enabledSources(config).map(({ connector, source }) => [connector.type, source.id]),
    [['imap', 'm_1'], ['ics', 'c_1'], ['ics', 'c_junk'], ['rss', 's_1']],
  );

  // Dropped rather than thrown on: core/config.mjs:236-238 is explicit that a
  // hand-edited typo must not brick the app that exists to report the typo.
  assert.deepEqual(
    unknownSources(config).map((u) => [u.at, u.id, u.type]),
    [['calendars', 'c_junk', 'runes'], ['sources', 's_junk', 'nostromo']],
  );
});

test('a null entry in config.mail is skipped, not thrown on mid-sweep', () => {
  /* REGRESSION. `enabledSources`'s guard was `source?.enabled !== false`, which
     is TRUE for null — so a null entry produced `{connector, source: null}`, the
     host read `source.label` off it, and the rejection escaped both
     `Promise.all` and `runSweep`. `finish()` then never ran, leaving the `runs`
     row `startRun` opened unfinished: a board showing a sweep that is still
     going and never will be. The old `isEnabled` opened with `!!x`.

     `normalizeAccounts` filters non-objects, so production reaches this only
     through an injected config — which is exactly what the desktop shell's
     documented `deps` seam is. */
  const config = baseConfig({
    mail: [null, { id: 'm_1', enabled: true, host: 'imap.example.com' }],
    calendars: [null],
    sources: [null],
  });
  assert.deepEqual(
    enabledSources(config).map(({ connector, source }) => [connector.type, source.id]),
    [['imap', 'm_1']],
  );
});

test('a source type that did not exist when the run loop was written reaches the board', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const result = await runSweep({
    db,
    config: baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] }),
    mode: 'light',
    deps: sweepDeps,
  });

  assert.equal(result.ok, true);
  const entry = result.stats.sources.find((s) => s.kind === 'rss');
  assert.ok(entry, `no rss source was reported: ${JSON.stringify(result.stats.sources)}`);
  assert.equal(entry.ok, true);
  assert.equal(entry.count, 2);
  assert.equal(entry.label, 'Alder notices', 'a source with one part carries the plain label, with no separator');
  assert.equal(result.stats.messages, 2);

  const stored = listMessages(db);
  assert.deepEqual(stored.map((m) => m.subject).sort(), ['Pre-con moved to Thursday', 'Retainage schedule posted']);
  assert.equal(stored[0].source_id, 's_feed', 'the host stamps the source id, not the connector');
  assert.equal(stored[0].folder, 'Alder & Vance Notices', 'the feed title becomes the folder');
});

/* ================================================================== *
 * Isolation — a connector failing costs its own row and nothing else
 * ================================================================== */

test('one failing feed is isolated to its own sources[] entry', async (t) => {
  const db = fresh();
  const good = await feedServer(t);
  const dead = await feedServer(t, {
    handler: (req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); },
  });

  const result = await runSweep({
    db,
    config: baseConfig({
      sources: [
        feedSource({ id: 's_good', label: 'Good feed', settings: { url: good.url } }),
        feedSource({ id: 's_dead', label: 'Dead feed', settings: { url: dead.url } }),
      ],
    }),
    mode: 'light',
    deps: sweepDeps,
  });

  assert.equal(result.ok, true, 'the run still produced a board');
  const byId = Object.fromEntries(result.stats.sources.map((s) => [s.id, s]));
  assert.equal(byId.s_good.ok, true);
  assert.equal(byId.s_good.count, 2);
  assert.equal(byId.s_dead.ok, false);
  assert.equal(byId.s_dead.count, 0);
  assert.match(byId.s_dead.error, /500/, `the failure must name what failed, got: ${byId.s_dead.error}`);
  assert.equal(result.stats.sourcesOk, 1);
  assert.equal(result.stats.sourcesFailed, 1);
  assert.equal(listMessages(db).length, 2, 'what did arrive was stored');
});

test('a mail account and a feed fail independently of each other', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const result = await runSweep({
    db,
    config: baseConfig({
      mail: [{
        id: 'm_1', enabled: true, label: 'Work', host: 'imap.example.com', port: 993, secure: true,
        user: 'nemo@example.com', keyRef: 'mail.m_1', mailboxes: ['INBOX'], sentMailbox: 'Sent',
        lookbackDays: 14, maxMessages: 400,
      }],
      sources: [feedSource({ settings: { url: feed.url } })],
    }),
    mode: 'light',
    // No password for the mail account; the feed does not need one.
    deps: { getSecret: async () => null },
  });

  const mail = result.stats.sources.filter((s) => s.kind === 'mail');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].ok, false);
  assert.match(mail[0].error, /No password stored for Work/,
    'the sentence a user reads at 07:00 must survive the unified loop word for word');
  const rss = result.stats.sources.find((s) => s.kind === 'rss');
  assert.equal(rss.ok, true);
  assert.equal(rss.count, 2);
});

/* ================================================================== *
 * The cursor, and the property the ordering buys
 * ================================================================== */

test("a connector's cursor survives a run and is handed back to it", async (t) => {
  const db = fresh();
  const feed = await feedServer(t, { etag: '"v1"' });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(first.stats.sources[0].count, 2);
  assert.deepEqual(JSON.parse(getKV(db, sourceCursorKey('s_feed'))), { etag: '"v1"', lastModified: null });

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(feed.headers()[1]['if-none-match'], '"v1"',
    'the stored cursor was not sent back, so the feed was re-read in full');
  assert.equal(second.stats.sources[0].ok, true, 'a 304 is a successful read of nothing, not a failure');
  assert.equal(second.stats.sources[0].count, 0);
  assert.equal(listMessages(db).length, 2, 'and nothing was duplicated');
  assert.deepEqual(JSON.parse(getKV(db, sourceCursorKey('s_feed'))), { etag: '"v1"', lastModified: null },
    'a 304 must keep the cursor, or the next sweep re-reads everything');
});

test('a crash between the fetch and the store leaves the cursor where it was', async (t) => {
  const db = fresh();
  const feed = await feedServer(t, { etag: '"v1"' });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  /* The persist is made to fail for real rather than mocked: `upsertMessage`
     prepares a statement against `messages`, so a database without that table
     throws from exactly where a disk error would. This is the window §5 of the
     design exists to close — a cursor advanced before the upsert loses those
     rows forever, because the connector comes back next sweep asking for
     everything AFTER a page that was never stored. */
  db.exec('DROP TABLE messages');

  const result = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not store what was fetched/);
  assert.equal(getKV(db, sourceCursorKey('s_feed')), null,
    'the cursor advanced past rows that were never stored — those entries are lost forever');
});

test('a cursor larger than the ceiling is refused rather than stored', async (t) => {
  const db = fresh();
  // 8 KB of ETag. Nothing legitimate does this; a connector caching a page of
  // results in its cursor does, and that is a second message store with no
  // index, no search and no cleanup.
  const huge = `"${'x'.repeat(8192)}"`;
  const feed = await feedServer(t, { etag: huge });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const result = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(result.ok, true, 'an oversized cursor is not a reason to fail the run');
  assert.equal(result.stats.sources[0].count, 2, 'nor a reason to lose the rows');
  assert.equal(getKV(db, sourceCursorKey('s_feed')), null);
});

/* ================================================================== *
 * A refused credential, and a source that is deliberately resting
 * ================================================================== */

test('a refused credential rests the source, and resting pushes nothing into sources[]', async (t) => {
  const db = fresh();
  const feed = await feedServer(t, {
    handler: (req, res) => { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('nope'); },
  });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(first.stats.sources.length, 1);
  assert.equal(first.stats.sources[0].ok, false);
  assert.match(first.stats.sources[0].error, /rejected the credential/);
  const state = JSON.parse(getKV(db, sourceStateKey('s_feed')));
  assert.ok(state.authBlockedUntil > Date.now(), 'nothing recorded that the credential was refused');

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(feed.hits(), 1, 'the sweep asked again with the credential the host just refused');
  /* Silence, not a green row. `{ok: true, count: 0}` would inflate
     stats.sourcesOk — a number three files consume — with a source that was
     never read; `{ok: false}` would put a red banner on the screen forty-seven
     times a day for a source that is deliberately resting. */
  assert.deepEqual(second.stats.sources, []);
  assert.equal(second.stats.sourcesOk, 0);
  assert.equal(second.stats.sourcesFailed, 0);
});

test('changing the stored credential releases the block immediately', async (t) => {
  const db = fresh();
  const feed = await feedServer(t, {
    handler: (req, res, hits) => {
      if (hits === 1) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(RSS_TWO);
    },
  });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  // The user pastes a different token. The block is keyed on WHICH credential
  // was refused, not on a flag, because that is the real shape of the failure:
  // somebody rotates a token and the six-hour wait must not apply to the new one.
  const state = JSON.parse(getKV(db, sourceStateKey('s_feed')));
  setKV(db, sourceStateKey('s_feed'), JSON.stringify({ ...state, secretHash: 'a-different-one' }));

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(feed.hits(), 2);
  assert.equal(second.stats.sources[0].ok, true);
  assert.equal(second.stats.sources[0].count, 2);
});

test('a stated rate limit rests the source until the moment the host named', async (t) => {
  const db = fresh();
  const feed = await feedServer(t, {
    handler: (req, res) => { res.writeHead(429, { 'retry-after': '3600' }); res.end(); },
  });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(first.stats.sources[0].ok, false);
  assert.match(first.stats.sources[0].error, /rate limiting/);
  const state = JSON.parse(getKV(db, sourceStateKey('s_feed')));
  assert.ok(state.notBefore - Date.now() > 3_000_000, `Retry-After was not honoured: ${state.notBefore - Date.now()}ms`);

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(feed.hits(), 1);
  assert.deepEqual(second.stats.sources, []);
});

/* ================================================================== *
 * The row identity trap, measured
 * ================================================================== */

test('a feed row carries no uid at all, and a second sweep inserts nothing', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(first.stats.newMessages, 2);

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  /* The whole point. core/db.mjs:384 reads
     `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes
     0 and an OMITTED uid becomes null — two different messageRowIds for one
     entry. A connector that drifts between the two re-inserts every row it has
     ever seen on every sweep, forever: newMessages never settles, shouldRunFull
     forces a full run every time, and the user is billed for a model call every
     thirty minutes. */
  assert.equal(second.stats.newMessages, 0, 'the same entries were inserted a second time');
  assert.equal(listMessages(db).length, 2);
  assert.equal(listMessages(db)[0].uid, null, 'a uid appeared where the connector emitted none');
});

test('the RSS connector is a pure function of its ctx — no db, no server, no secret store', async (t) => {
  const rss = connectorFor('rss');
  const feed = await feedServer(t, { body: ATOM_ONE });
  const emitted = [];
  const ctx = {
    source: { id: 's_1', settings: { url: feed.url } },
    label: 'Vance',
    secret: null,
    cursor: null,
    window: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: '2026-08-11T09:00:00Z',
    emit: (message, done, total) => emitted.push([message, done, total]),
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: createHttp({ origins: [feed.origin], limits: rss.limits }),
    deps: {},
  };

  const r = await rss.collect(ctx);
  assert.equal(r.parts.length, 1);
  const row = r.parts[0].rows[0];
  assert.equal(r.parts[0].rows.length, 1);
  assert.equal(row.messageId, 'tag:vance.example,2026:post/41');
  assert.ok(!('uid' in row), 'a uid key must never appear on a row with no integer identity');
  assert.equal(row.subject, 'Stamped drawings are out');
  assert.equal(row.from.name, 'Dana Vance');
  assert.equal(row.direction, 'in');
  assert.match(row.date, /^2026-08-10T13:00/);
  assert.match(row.snippet, /Sheets A1 through A9/);
  assert.deepEqual(emitted, [['Vance: 1 entries', 1, 1]]);
});

test('parseFeed reads what a feed means, not what its markup says', () => {
  const rss = parseFeed(RSS_TWO);
  assert.equal(rss.title, 'Alder & Vance Notices', 'entities are decoded');
  assert.equal(rss.entries.length, 2);
  assert.equal(rss.entries[0].id, 'alder-2026-08-09-retainage');
  assert.equal(rss.entries[0].body, 'The retainage schedule for Q3 is posted.',
    'CDATA is a quoting device and the HTML inside it is markup, not text');

  const atom = parseFeed(ATOM_ONE);
  assert.equal(atom.title, 'Vance Engineering', 'the channel title, not the first entry title');

  /* A channel with no title of its own. Taking the first <title> in the
     document would name the feed after whatever article happens to be at the
     top of it today — so the folder every stored row is filed under would
     change on the publisher's schedule, and the board would show one source as
     several. Nothing is the right answer here; the caller falls back to the
     host the user typed. */
  const headless = parseFeed('<rss><channel><link>https://x.example/</link>'
    + '<item><title>Whatever is at the top today</title><guid>g1</guid></item></channel></rss>');
  assert.equal(headless.title, '');
  assert.equal(headless.entries[0].title, 'Whatever is at the top today');
  assert.equal(atom.entries[0].link, 'https://vance.example/posts/stamped',
    'rel="enclosure" is a media file and rel="self" is the feed; neither is the article');

  // A commented-out <item> is a real thing in a hand-edited feed and is not an entry.
  assert.equal(parseFeed('<rss><channel><title>T</title><!-- <item><title>X</title></item> --></channel></rss>').entries.length, 0);
  // Nothing here should ever throw on a stranger's XML.
  for (const junk of ['', '<not xml', null, undefined, '<rss><channel>']) {
    assert.deepEqual(parseFeed(junk).entries, [], JSON.stringify(junk));
  }
});

test('a feed longer than the number the user chose is capped at it', async (t) => {
  const db = fresh();
  const items = Array.from({ length: 12 }, (_, i) =>
    `<item><title>Notice ${i}</title><guid>n-${i}</guid><pubDate>Mon, 10 Aug 2026 08:0${i % 10}:00 +0000</pubDate></item>`);
  const feed = await feedServer(t, { body: `<rss><channel><title>Long</title>${items.join('')}</channel></rss>` });

  const result = await runSweep({
    db,
    config: baseConfig({ sources: [feedSource({ settings: { url: feed.url, maxItems: 5 } })] }),
    mode: 'light',
    deps: sweepDeps,
  });
  assert.equal(result.stats.sources[0].count, 5, 'the connector honours the number the user chose');
  assert.equal(listMessages(db).length, 5);
});

/* ================================================================== *
 * The transport, on its own
 * ================================================================== */

test('ctx.http refuses an address that is not the source\'s own', async (t) => {
  const feed = await feedServer(t);
  const other = await feedServer(t);
  const http1 = createHttp({ origins: [feed.origin], limits: {} });

  await assert.rejects(() => http1.get(other.url), /not one of this source's addresses/,
    'a URL that arrived from somewhere other than the user was fetchable');
  await assert.rejects(() => http1.get('file:///etc/passwd'), /only be read over http or https/);
  await assert.rejects(() => http1.get('http://169.254.169.254/latest/meta-data/'),
    /not one of this source's addresses/);
  // The one it was given works, so the refusals above are not a broken client.
  assert.equal((await http1.get(feed.url)).status, 200);
});

test('the transport, not the connector, decides what a 401 and a 429 mean', async (t) => {
  /* The two error classes are the entire replacement for a status enum, and
     this is what makes them free: a connector writes no code at all to get the
     behaviour, because the transport throws them. A connector that never calls
     ctx.http — imap, ics, caldav, file — therefore cannot raise either, which
     is what keeps their failure behaviour byte-identical to what it was. */
  const refuses = await feedServer(t, { handler: (req, res) => { res.writeHead(401); res.end(); } });
  const limits = await feedServer(t, { handler: (req, res) => { res.writeHead(429, { 'retry-after': '90' }); res.end(); } });

  await assert.rejects(() => createHttp({ origins: [refuses.origin], limits: {} }).get(refuses.url), AuthError);
  await assert.rejects(
    () => createHttp({ origins: [limits.origin], limits: {} }).get(limits.url),
    (err) => err instanceof RateLimitError && err.retryAfterMs === 90_000,
  );
});

test('a redirect off the origin is refused, and one on it costs the credential nothing', async (t) => {
  const away = await feedServer(t);
  const home = await feedServer(t, {
    handler: (req, res, hits) => {
      if (req.url === '/away') { res.writeHead(302, { location: away.url }); res.end(); return; }
      if (req.url === '/hop') { res.writeHead(302, { location: '/feed.xml' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(RSS_TWO);
    },
  });
  const client = createHttp({
    origins: [home.origin],
    limits: {},
    credential: { label: 'Token', send: { as: 'header', name: 'authorization', prefix: 'Bearer ' } },
    secret: 'a-token',
  });

  await assert.rejects(() => client.get(`${home.origin}/away`), /not one of this source's addresses/);
  assert.equal(away.hits(), 0, 'the off-origin destination was contacted before the refusal');

  const ok = await client.get(`${home.origin}/hop`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Alder/);
  // Three requests reached this host — /away, /hop, and the hop's destination —
  // and every one of them is the origin the user configured, so every one of
  // them carries the credential. The property being pinned is that the
  // credential never leaves that origin, which `away.hits() === 0` above and
  // this equality together state.
  assert.equal(home.hits(), 3);
  assert.equal(home.headers().filter((h) => h.authorization === 'Bearer a-token').length, 3);
});

test('only one redirect is followed, however many the host offers', async (t) => {
  const home = await feedServer(t, {
    handler: (req, res, hits) => { res.writeHead(302, { location: `/hop${hits}` }); res.end(); },
  });
  const client = createHttp({ origins: [home.origin], limits: {} });
  await assert.rejects(() => client.get(`${home.origin}/start`), /returned 302/,
    'a redirect chain was followed past the single hop this transport allows');
  assert.equal(home.hits(), 2);
});

test('a body larger than the cap is refused off the stream, not after buying it', async (t) => {
  const home = await feedServer(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      // No content-length: a host that wants to hand Zelos 48 MiB does not announce it.
      for (let i = 0; i < 40; i += 1) res.write('x'.repeat(64 * 1024));
      res.end();
    },
  });
  const client = createHttp({ origins: [home.origin], limits: {}, maxBytes: 128 * 1024 });
  await assert.rejects(() => client.get(home.url), /more than 131072 bytes/);
});

test('postJson is closed unless the manifest declared graphql', async (t) => {
  const home = await feedServer(t);
  const closed = createHttp({ origins: [home.origin], limits: {} });
  await assert.rejects(() => closed.postJson(home.url, { query: '{ me }' }), /may only read with GET/);
  const open = createHttp({ origins: [home.origin], limits: {}, graphql: true });
  assert.equal((await open.postJson(home.url, { query: '{ me }' })).status, 200);
});

test('a persisted budget does not refill because the process restarted', async (t) => {
  const home = await feedServer(t);
  const limits = { minGapMs: 0, budget: { calls: 3, perMs: 3_600_000 } };
  const startedAt = Date.now();

  // What a previous run left in `source.<id>.state`.
  const meter = createMeter(limits, { spent: 3, windowStartedAt: startedAt }, startedAt);
  assert.equal(meter.spent, 3, 'the window is still open, so the spend carries');
  const client = createHttp({ origins: [home.origin], limits, meter });
  await assert.rejects(() => client.get(home.url), RateLimitError);
  assert.equal(home.hits(), 0, 'the request went out anyway');

  // A window that has rolled over starts clean.
  const rolled = createMeter(limits, { spent: 3, windowStartedAt: startedAt - 3_600_001 }, startedAt);
  assert.equal(rolled.spent, 0);
});

test('Retry-After is read in both forms the RFC allows', () => {
  const now = Date.parse('2026-08-11T09:00:00Z');
  assert.equal(parseRetryAfter('120', now), 120_000);
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 09:02:00 GMT', now), 120_000);
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 08:00:00 GMT', now), 0, 'a moment in the past is now');
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter('soon', now), null);
});

test('originOf and secretHash keep their promises', () => {
  assert.equal(originOf('https://api.github.com/repos/x/y?a=1'), 'https://api.github.com');
  assert.equal(originOf('webcal://cal.example.com/x.ics'), 'https://cal.example.com');
  assert.equal(originOf('file:///etc/passwd'), null);
  assert.equal(originOf('not a url'), null);
  assert.equal(secretHash(null), null);
  assert.equal(secretHash('hunter2').length, 16);
  assert.notEqual(secretHash('hunter2'), 'hunter2');
});

/* ================================================================== *
 * assertShape — the interface, enforced at import
 * ================================================================== */

const validManifest = (over = {}) => ({
  type: 'sample',
  family: 'sample',
  label: 'Sample',
  option: 'A sample source',
  configKey: 'sources',
  sink: 'messages',
  credential: null,
  origins: ['https://api.example.com'],
  fields: [],
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: null },
  collect: async () => ({ parts: [] }),
  ...over,
});

test('assertShape accepts a well-formed manifest and every connector that ships', () => {
  assert.doesNotThrow(() => assertShape(validManifest()));
  for (const c of registry.all()) assert.doesNotThrow(() => assertShape(c, new Set()), c.type);
});

test('assertShape refuses a settings field named anything config would strip', () => {
  /* The clause nobody would think of. `stripSecrets` deletes these key names
     anywhere at any depth on every save and logs "config: refused to store
     credential fields" — so a connector field called `key`, holding an innocuous
     project key, vanishes on save with a warning that reads like a false
     positive. Every name in the set is checked, not a sample, because the set is
     the thing that has to stay in sync. */
  for (const name of SECRET_KEYS) {
    if (!/^[a-z][A-Za-z0-9_]*$/.test(name)) continue; // api_key etc. fail the identifier rule first
    assert.throws(
      () => assertShape(validManifest({ fields: [{ name, type: 'text', label: 'X' }] })),
      /strips from every save/,
      `a field named "${name}" was accepted and would silently vanish on save`,
    );
  }
  assert.doesNotThrow(() => assertShape(validManifest({ fields: [{ name: 'projectKey', type: 'text', label: 'Project' }] })));
});

test('assertShape refuses a manifest that could change something at a source', () => {
  /* Non-negotiable #2 as a property of the SHAPE rather than a convention. A
     reviewer asking "can Zelos send?" reads this list, not eleven connectors. */
  for (const verb of ['send', 'reply', 'archive', 'complete', 'write', 'delete']) {
    assert.throws(
      () => assertShape(validManifest({ [verb]: async () => {} })),
      /not part of the connector interface/,
      `a connector declaring \`${verb}\` was accepted`,
    );
  }
});

test('assertShape refuses the rest of the ways a manifest can be wrong', () => {
  const cases = [
    [{ type: 'Sample' }, /lowercase `type`/],
    [{ family: '' }, /needs a `family`/],
    [{ configKey: 'somewhere' }, /configKey must be one of/],
    [{ sink: 'captures' }, /sink must be one of/],
    [{ collect: undefined }, /needs a collect/],
    [{ origins: undefined }, /needs an `origins` array/],
    [{ origins: ['https://api.example.com/v3'] }, /must be a bare origin/],
    [{ origins: ['ftp://api.example.com'] }, /must be http or https/],
    [{ limits: undefined }, /needs a `limits` object/],
    [{ limits: { minIntervalMs: NaN, minGapMs: 0 } }, /minIntervalMs must be a number/],
    [{ limits: { minIntervalMs: 0, minGapMs: 0, budget: { calls: 0, perMs: 1 } } }, /budget.calls must be positive|budget\.calls must be a positive/],
    [{ limits: { minIntervalMs: 0, minGapMs: 0, maxRows: 0 } }, /maxRows must be a positive integer/],
    [{ fields: [{ name: 'ok', type: 'colour', label: 'X' }] }, /must be one of/],
    [{ fields: [{ name: 'ok', type: 'choice', label: 'X' }] }, /choice with no choices/],
    [{ credential: { label: 'T', send: { as: 'query', name: 'token' } } }, /There is no "query"/],
  ];
  for (const [over, re] of cases) {
    assert.throws(() => assertShape(validManifest(over)), re, JSON.stringify(over));
  }
  const seen = new Set();
  assertShape(validManifest(), seen);
  assert.throws(() => assertShape(validManifest(), seen), /registered twice/);
});

test('describe() survives JSON and carries no functions', () => {
  const manifests = describeAll();
  assert.deepEqual(JSON.parse(JSON.stringify(manifests)), manifests,
    'the UI reaches core/ only over HTTP, so a manifest that does not round-trip is unreachable');
  for (const m of manifests) {
    for (const v of Object.values(m)) assert.notEqual(typeof v, 'function');
  }
  assert.deepEqual(manifests.map((m) => m.type), ['imap', 'ics', 'caldav', 'file', 'rss']);
  assert.equal(manifests.find((m) => m.type === 'imap').credential.required, true);
  assert.equal(manifests.find((m) => m.type === 'file').credential, null,
    'a source with nothing to paste must not be described as needing something');
});

test('originsFor is the user\'s addresses plus the connector\'s, and nothing a document said', () => {
  const rss = connectorFor('rss');
  assert.deepEqual(originsFor(rss, { settings: { url: 'https://alder.example/feed.xml' } }),
    ['https://alder.example/feed.xml']);
  assert.deepEqual(originsFor(connectorFor('ics'), { url: 'https://cal.example/x.ics' }),
    ['https://cal.example/x.ics']);
  assert.deepEqual(originsFor(rss, { settings: {} }), [], 'nothing configured means nothing reachable');
});

/* ================================================================== *
 * config.sources[] — the envelope, and only the envelope
 * ================================================================== */

test('validateConfig checks a source envelope and leaves the payload to the registry', () => {
  const good = baseConfig({
    sources: [feedSource({ keyRef: 'rss.s_feed', settings: { url: 'https://alder.example/feed.xml' } })],
  });
  assert.deepEqual(validateConfig(good), { ok: true, errors: [] });

  // A config written before `sources` existed is not broken.
  const older = baseConfig();
  delete older.sources;
  assert.equal(validateConfig(older).ok, true);

  const bad = validateConfig(baseConfig({
    sources: [
      { id: '', enabled: 'yes', label: 4, type: '', keyRef: 'bad ref!', settings: [] },
      feedSource({ id: 's_dup' }),
      feedSource({ id: 's_dup' }),
    ],
  }));
  const at = bad.errors.map((e) => e.path);
  for (const p of ['sources[0].id', 'sources[0].enabled', 'sources[0].label', 'sources[0].type',
    'sources[0].keyRef', 'sources[0].settings', 'sources[2].id']) {
    assert.ok(at.includes(p), `expected an error at ${p}, got ${at.join(', ')}`);
  }

  /* The deliberate non-check. A hand-edited type that names no connector LOADS:
     the sweep reports that source unread and `zelos doctor` names it, which is
     strictly better than refusing to load the file that has the typo in it. */
  assert.equal(validateConfig(baseConfig({ sources: [feedSource({ type: 'runes' })] })).ok, true);
});

test('a source with no credential is never told a password is missing', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const result = await runSweep({
    db,
    config: baseConfig({ sources: [feedSource({ keyRef: 'rss.s_feed', settings: { url: feed.url } })] }),
    mode: 'light',
    deps: { getSecret: async () => null },
  });
  assert.equal(result.stats.sources[0].ok, true,
    '`credential: null` must not be read as `credential: {required: false}` with a missing value');
});

/* ================================================================== *
 * The zero-dependency claim, extended to the new directory
 * ================================================================== */

test('no connector reaches the network except through the transport', () => {
  const dir = path.join(ROOT, 'core/connectors');
  const offenders = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    /* Two files are allowed a socket and both are named here rather than
       detected: http.mjs IS the transport, and ics.mjs carries core/sweep.mjs's
       original .ics reader verbatim because routing it through the transport
       would turn a 401 on a subscription URL into a six-hour rest — a behaviour
       change, deferred on purpose. Every other connector, and every connector
       added later, must go through ctx.http, because docs/SECURITY.md's
       invitation to check with tcpdump survives ten connectors only as a test. */
    if (name === 'http.mjs' || name === 'ics.mjs') continue;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/(^|[^.\w])fetch\s*\(/.test(code) || /globalThis\.fetch/.test(code)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `these connectors open their own sockets:\n  ${offenders.join('\n  ')}`);
});
