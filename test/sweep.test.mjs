import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-sweep-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const {
  open, close, migrate,
  getItemByKey, itemRowId, setItemState, listBoard, bucketCounts,
  listMessages, listEvents, insertCapture, listCaptures,
  getRun, getKV, startRun, finishRun,
} = await import('../core/db.mjs');
const { SWEEP_KV } = await import('../core/triage.mjs');
const {
  runSweep, shouldRunFull, nextRunAt, isActiveHour, Scheduler, FULL_RUN_MAX_AGE_MS,
} = await import('../core/sweep.mjs');

let seq = 0;
const openDbs = [];
const servers = [];

function fresh() {
  const db = open(path.join(HOME_ROOT, `s${seq++}.db`));
  migrate(db);
  openDbs.push(db);
  return db;
}

test.after(async () => {
  for (const db of openDbs) close(db);
  for (const server of servers) await new Promise((r) => server.close(r));
  fs.rmSync(HOME_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A port nothing is listening on: bind one, read it, give it back. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function icsDocument(startMs) {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zelos test//EN',
    'X-WR-CALNAME:Work',
    'BEGIN:VEVENT',
    'UID:precon-9001',
    `DTSTAMP:${stamp(startMs - 86_400_000)}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(startMs + 3_600_000)}`,
    'SUMMARY:Pre-con with Alder & Vance',
    'LOCATION:Site trailer',
    'DESCRIPTION:Bring the retainage figure',
    'ORGANIZER;CN=Marcus Reyes:mailto:marcus@riverstone.example',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** A local .ics host. No third party is contacted by any test in this file. */
async function icsServer(body) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/work.ics`, hits: () => hits };
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
      maxTokens: 2048,
      temperature: 0,
    },
    mail: [],
    calendars: [],
    sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true },
    ui: { theme: 'marble' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
    ...over,
  };
}

function mailAccount(over = {}) {
  return {
    id: 'm_work',
    enabled: true,
    label: 'Work',
    host: 'imap.example.invalid',
    port: 993,
    secure: true,
    user: 'nemo@example.com',
    keyRef: 'mail.m_work',
    mailboxes: ['INBOX'],
    sentMailbox: 'Sent',
    lookbackDays: 14,
    maxMessages: 50,
    ...over,
  };
}

/** A record shaped like one from imap.fetchRecent. */
function fetched(over = {}) {
  return {
    uid: 1,
    messageId: '<a@example.com>',
    inReplyTo: '',
    references: [],
    threadKey: 'thread-a',
    from: { name: 'Priya Raman', email: 'john@raman.example' },
    to: [{ name: 'Nemo', email: 'nemo@example.com' }],
    cc: [],
    subject: 'Dates for the walkthrough',
    date: '2026-08-06T11:04:00+00:00',
    snippet: 'Either the 28th or the 30th works',
    text: 'Either the 28th or the 30th works on our end.',
    hasAttachments: false,
    flags: [],
    folder: 'INBOX',
    ...over,
  };
}

/** A model that returns exactly what a test tells it to, and counts its calls. */
function fakeModel(reply) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const body = typeof reply === 'function' ? reply(calls.length, opts) : reply;
    if (body instanceof Error) throw body;
    return {
      text: typeof body === 'string' ? body : JSON.stringify(body),
      usage: { input: 1234, output: 567 },
      model: 'test-model',
      raw: {},
    };
  };
  fn.calls = calls;
  return fn;
}

const SECRETS = async () => 'a-password';

function board(items, over = {}) {
  return { first: null, items, notes: ['A quiet morning.'], ...over };
}

function item(over = {}) {
  return {
    key: 'thread-a',
    bucket: 'waiting',
    headline: 'Answer Priya Raman on the Jul 28 dates',
    why: 'He offered two dates and has had no reply.',
    person: 'Priya Raman',
    personEmail: 'john@raman.example',
    dueAt: null,
    severity: 2,
    sourceRefs: [],
    link: null,
    ...over,
  };
}

/* ================================================================== *
 * runSweep
 * ================================================================== */

test('a full run fetches, persists, thinks and merges', async () => {
  const db = fresh();
  const model = fakeModel(board([item(), item({ key: 'k2', bucket: 'today', headline: 'Draw the retainage figure' })]));
  const config = baseConfig({ mail: [mailAccount()] });

  const phases = [];
  const result = await runSweep({
    db,
    config,
    onProgress: (p) => phases.push(p.phase),
    deps: {
      getSecret: SECRETS,
      complete: model,
      fetchMail: async ({ mailbox }) =>
        mailbox === 'Sent'
          ? [fetched({ uid: 9, messageId: '<s@example.com>', threadKey: 'thread-a', folder: 'Sent', subject: 'Re: Dates', text: "I'll confirm tomorrow." })]
          : [fetched(), fetched({ uid: 2, messageId: '<b@example.com>', threadKey: 'thread-b', subject: 'Invoice 4471' })],
    },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(model.calls.length, 1);
  assert.equal(result.stats.kind, 'full');
  assert.equal(result.stats.messages, 3);
  assert.equal(result.stats.items, 2);
  assert.equal(result.stats.tokensIn, 1234);
  assert.equal(result.stats.tokensOut, 567);
  assert.ok(result.stats.ms >= 0);
  assert.equal(listMessages(db).length, 3);
  assert.ok(getItemByKey(db, 'thread-a'));
  assert.deepEqual(result.notes, ['A quiet morning.']);

  // The sent mailbox is read too — `promised` cannot exist without it.
  const out = listMessages(db, { direction: 'out' });
  assert.equal(out.length, 1);
  assert.equal(out[0].folder, 'Sent');

  assert.deepEqual(phases.slice(0, 3), ['start', 'fetch', 'persist']);
  assert.ok(phases.includes('think'));
  assert.ok(phases.includes('merge'));
  assert.equal(phases.at(-1), 'done');

  const run = getRun(db, result.runId);
  assert.equal(run.ok, true);
  assert.equal(run.kind, 'full');
  assert.equal(run.tokens_in, 1234);
});

test('the four-item now bar holds end to end, through a real model reply', async () => {
  const db = fresh();
  const six = [0, 1, 2, 3, 4, 5].map((i) => item({
    key: `urgent-${i}`,
    bucket: 'now',
    headline: `Deal with the urgent thing number ${i}`,
    severity: i,
  }));
  // Wrapped in prose and a fence, the way a small local model actually answers.
  const model = fakeModel(`Sure! Here is the board:\n\n\`\`\`json\n${JSON.stringify(board(six))}\n\`\`\`\nHope that helps.`);

  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.stats.now, 4, 'exactly four survive as now');
  const counts = bucketCounts(db);
  assert.equal(counts.now, 4);
  assert.equal(counts.today, 2, 'the other two were demoted, not deleted');
  assert.equal(listBoard(db).length, 6);
  assert.equal(getItemByKey(db, 'urgent-0').bucket, 'today');
  assert.equal(getItemByKey(db, 'urgent-5').bucket, 'now');
});

test('what the user decided survives the next run', async () => {
  const db = fresh();
  const model = fakeModel(board([item(), item({ key: 'k2', bucket: 'today', headline: 'Draw the retainage figure' })]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  const id = itemRowId('thread-a');
  const before = getItemByKey(db, 'thread-a');
  setItemState(db, id, 'done');

  await runSweep({ db, config, mode: 'full', deps });
  const after = getItemByKey(db, 'thread-a');

  assert.equal(after.state, 'done', 'the model does not get to reopen it');
  assert.equal(after.seen_runs, 2, 'but it is still recognised as the same obligation');
  assert.equal(after.first_seen, before.first_seen);
  assert.equal(model.calls.length, 2);
});

test('one dead source does not cost the run the others', async () => {
  const db = fresh();
  const deadPort = await closedPort();
  const startsAt = Date.now() + 26 * 3_600_000;
  const cal = await icsServer(icsDocument(startsAt));
  const model = fakeModel(board([item({ key: 'evt-precon', bucket: 'today', headline: 'Bring the retainage figure to the pre-con' })]));

  const config = baseConfig({
    // A real IMAP client against a port with nothing behind it.
    mail: [mailAccount({ id: 'm_dead', label: 'Dead host', host: '127.0.0.1', port: deadPort, secure: false })],
    calendars: [{ id: 'c_work', enabled: true, label: 'Work', kind: 'ics', url: cal.url, user: '', keyRef: null }],
  });

  const result = await runSweep({ db, config, deps: { getSecret: SECRETS, complete: model } });

  assert.equal(result.ok, true, 'the run still produced a board');
  const mailSources = result.stats.sources.filter((s) => s.kind === 'mail');
  assert.equal(mailSources.length, 2, 'INBOX and Sent were both attempted');
  assert.ok(mailSources.every((s) => s.ok === false));
  assert.match(mailSources[0].error, /127\.0\.0\.1|ECONNREFUSED|connect/i,
    `the failure must name what failed, got: ${mailSources[0].error}`);

  const calSource = result.stats.sources.find((s) => s.kind === 'calendar');
  assert.equal(calSource.ok, true);
  assert.equal(calSource.count, 1);
  assert.equal(result.stats.sourcesFailed, 2);
  assert.equal(result.stats.sourcesOk, 1);
  assert.equal(result.stats.events, 1);
  assert.equal(listEvents(db).length, 1);
  assert.equal(listEvents(db)[0].title, 'Pre-con with Alder & Vance');
  assert.equal(model.calls.length, 1, 'the model still got to think about what did arrive');
});

test('an account with no stored password is reported, not crashed on', async () => {
  const db = fresh();
  const model = fakeModel(board([]));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    deps: { getSecret: async () => null, complete: model, fetchMail: async () => [fetched()] },
  });
  const source = result.stats.sources.find((s) => s.kind === 'mail');
  assert.equal(source.ok, false);
  assert.match(source.error, /No password stored for Work/);
  assert.equal(result.stats.messages, 0);
});

test('a light run reads the sources and calls no model at all', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  const result = await runSweep({ db, config, mode: 'light', deps });

  assert.equal(result.ok, true);
  assert.equal(result.stats.kind, 'light');
  assert.equal(result.modelCalls, 0);
  assert.equal(model.calls.length, 0, 'a light run must never reach the model');
  assert.equal(listMessages(db).length, 1, 'but it still refreshes what it stores');
  assert.ok(result.counts, 'and it still recomputes the derived counts');
});

test('an auto run goes full for new mail and light when nothing changed', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  const first = await runSweep({ db, config, mode: 'auto', deps });
  assert.equal(first.stats.kind, 'full', 'a first run always thinks');
  assert.equal(model.calls.length, 1);

  const second = await runSweep({ db, config, mode: 'auto', deps });
  assert.equal(second.stats.kind, 'light', 'nothing new arrived, so nothing was re-thought');
  assert.equal(model.calls.length, 1);

  // Now something new arrives mid-interval: the run upgrades itself rather than
  // making the user wait for the next slot.
  deps.fetchMail = async () => [fetched(), fetched({ uid: 77, messageId: '<new@example.com>', threadKey: 'thread-new', subject: 'Invoice 4471 is past due' })];
  const third = await runSweep({ db, config, mode: 'auto', deps });
  assert.equal(third.stats.kind, 'full');
  assert.equal(third.stats.newMessages, 1);
  assert.equal(model.calls.length, 2);
  assert.equal(getRun(db, second.runId).kind, 'light');
  assert.equal(getRun(db, third.runId).kind, 'full', 'the run record says what the run actually did');
});

test('privacy.sendBodies:false reaches the model as a prompt with no body text', async () => {
  const db = fresh();
  const secret = 'CONFIDENTIAL-BODY-STRING-9911';
  const model = fakeModel(board([item()]));
  const config = baseConfig({
    mail: [mailAccount()],
    privacy: { maxItemsPerSweep: 150, sendBodies: false, bodyChars: 4000 },
  });

  await runSweep({
    db,
    config,
    mode: 'full',
    deps: {
      getSecret: SECRETS,
      complete: model,
      fetchMail: async () => [fetched({ snippet: 'harmless preview line', text: `payload: ${secret}` })],
    },
  });

  assert.equal(model.calls.length, 1);
  const sent = `${model.calls[0].system}\n${model.calls[0].messages.map((m) => m.content).join('\n')}`;
  assert.ok(!sent.includes(secret), 'the body must not leave the machine');
  assert.ok(sent.includes('harmless preview line'), 'the snippet still does');
  assert.ok(listMessages(db)[0].body.includes(secret), 'and the body is still stored locally');
});

test('captures are triaged, then marked processed — but only the ones that were sent', async () => {
  const db = fresh();
  const capture = insertCapture(db, 'Call the bank about the retainage line');
  const model = fakeModel(board([item({ key: 'cap-bank', bucket: 'today', headline: 'Call the bank about retainage' })]));

  await runSweep({ db, config: baseConfig(), mode: 'full', deps: { getSecret: SECRETS, complete: model } });

  const sent = model.calls[0].messages[0].content;
  assert.ok(sent.includes(`[cap:${capture.id}]`));
  assert.equal(listCaptures(db, { includeProcessed: false }).length, 0);
});

test('a capture the budget could not send stays untriaged instead of vanishing', async () => {
  const db = fresh();
  for (let i = 0; i < 30; i++) insertCapture(db, `note number ${i}`);
  const model = fakeModel(board([]));

  await runSweep({ db, config: baseConfig(), mode: 'full', deps: { getSecret: SECRETS, complete: model } });

  const sent = model.calls[0].messages[0].content;
  const cited = (sent.match(/\[cap:/g) || []).length;
  const stillWaiting = listCaptures(db, { includeProcessed: false }).length;
  assert.ok(cited > 0 && cited < 30, `expected some but not all captures, got ${cited}`);
  assert.equal(stillWaiting, 30 - cited, 'exactly the ones that were not sent come back next run');
});

test('a model that answers with something other than JSON fails the run honestly', async () => {
  const db = fresh();
  const model = fakeModel('I am terribly sorry, I cannot help with that.');
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /not with JSON/);
  assert.match(result.error, /I am terribly sorry/);
  assert.equal(listMessages(db).length, 1, 'what was fetched is still stored');
  assert.equal(getRun(db, result.runId).ok, false);
});

test('a model that cannot be reached fails the run without losing the fetch', async () => {
  const db = fresh();
  const model = fakeModel(new Error('Could not reach the model at http://127.0.0.1:1/v1 (ECONNREFUSED)'));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
  assert.equal(listMessages(db).length, 1);
});

test('the prior board is handed back to the model on the next run', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  await runSweep({ db, config, mode: 'full', deps });

  const secondPrompt = model.calls[1].messages[0].content;
  assert.match(secondPrompt, /THE BOARD YOU PRODUCED LAST RUN/);
  assert.match(secondPrompt, /key=thread-a/);
});

test('a cancelled sweep stops and says so', async () => {
  const db = fresh();
  const controller = new AbortController();
  const model = fakeModel(board([item()]));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    signal: controller.signal,
    deps: {
      getSecret: SECRETS,
      complete: model,
      fetchMail: async () => {
        controller.abort();
        return [fetched()];
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/i);
  assert.equal(model.calls.length, 0);
});

/* ================================================================== *
 * shouldRunFull
 * ================================================================== */

test('shouldRunFull: a database with no successful full run always thinks', () => {
  const db = fresh();
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T10:00:00+00:00'), true);
});

test('shouldRunFull: quiet since the last full run means light', () => {
  const db = fresh();
  const id = startRun(db, { kind: 'full', now: '2026-08-08T09:00:00+00:00' });
  finishRun(db, id, { ok: true, now: '2026-08-08T09:01:00+00:00' });
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T09:30:00+00:00'), false);
});

test('shouldRunFull: newly stored mail, an untriaged note, or four hours all force a think', () => {
  const config = baseConfig();
  const at = '2026-08-08T09:00:00+00:00';

  const withNew = fresh();
  let id = startRun(withNew, { kind: 'full', now: at });
  finishRun(withNew, id, { ok: true, now: at });
  assert.equal(shouldRunFull(withNew, config, '2026-08-08T09:30:00+00:00'), false);
  withNew.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(SWEEP_KV.pendingNew, '3');
  assert.equal(shouldRunFull(withNew, config, '2026-08-08T09:30:00+00:00'), true);

  const withCapture = fresh();
  id = startRun(withCapture, { kind: 'full', now: at });
  finishRun(withCapture, id, { ok: true, now: at });
  assert.equal(shouldRunFull(withCapture, config, '2026-08-08T09:30:00+00:00'), false);
  insertCapture(withCapture, 'remember the bank call');
  assert.equal(shouldRunFull(withCapture, config, '2026-08-08T09:30:00+00:00'), true);

  const stale = fresh();
  id = startRun(stale, { kind: 'full', now: at });
  finishRun(stale, id, { ok: true, now: at });
  const later = new Date(Date.parse(at) + FULL_RUN_MAX_AGE_MS + 60_000).toISOString();
  assert.equal(shouldRunFull(stale, config, later), true);
});

test('shouldRunFull: a full run that failed does not count as having thought', () => {
  const db = fresh();
  const id = startRun(db, { kind: 'full', now: '2026-08-08T09:00:00+00:00' });
  finishRun(db, id, { ok: false, error: 'model unreachable', now: '2026-08-08T09:00:10+00:00' });
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T09:05:00+00:00'), true);
});

test('a successful full run clears the pending-new counter', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });
  assert.equal(getKV(db, SWEEP_KV.pendingNew), '0');
});

/* ================================================================== *
 * nextRunAt / isActiveHour
 * ================================================================== */

test('nextRunAt adds the interval and keeps the offset', () => {
  const config = baseConfig();
  assert.equal(nextRunAt(config, '2026-08-08T10:00:00+00:00'), '2026-08-08T10:30:00+00:00');
  assert.equal(
    nextRunAt(baseConfig({ sweep: { intervalMinutes: 90, activeHours: [6, 23], auto: true } }), '2026-08-08T10:00:00+00:00'),
    '2026-08-08T11:30:00+00:00',
  );
});

test('nextRunAt waits for the active window rather than sweeping at 3am', () => {
  const config = baseConfig();
  // 22:50 + 30m = 23:20, past the 23:00 close -> tomorrow at 06:00.
  assert.equal(nextRunAt(config, '2026-08-08T22:50:00+00:00'), '2026-08-09T06:00:00+00:00');
  // 04:00 + 30m = 04:30, before the 06:00 open -> this morning at 06:00.
  assert.equal(nextRunAt(config, '2026-08-08T04:00:00+00:00'), '2026-08-08T06:00:00+00:00');
});

test('nextRunAt clamps a nonsense interval instead of trusting it', () => {
  const wild = baseConfig({ sweep: { intervalMinutes: 0, activeHours: [6, 23], auto: true } });
  assert.equal(nextRunAt(wild, '2026-08-08T10:00:00+00:00'), '2026-08-08T10:05:00+00:00');
});

test('isActiveHour reads the hour off the string', () => {
  const config = baseConfig();
  assert.equal(isActiveHour(config, '2026-08-08T10:00:00+00:00'), true);
  assert.equal(isActiveHour(config, '2026-08-08T05:59:00+00:00'), false);
  assert.equal(isActiveHour(config, '2026-08-08T23:00:00+00:00'), false);
});

/* ================================================================== *
 * Scheduler
 * ================================================================== */

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

test('the scheduler starts, reports itself, and stops', (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  const scheduler = new Scheduler({ db, config: baseConfig(), run: async () => ({ ok: true }) });
  const idle = scheduler.status();
  assert.equal(idle.running, false);
  assert.equal(idle.nextRunAt, null);

  const started = scheduler.start();
  assert.equal(started.running, true);
  assert.equal(started.intervalMinutes, 30);
  assert.deepEqual(started.activeHours, [6, 23]);
  assert.equal(started.nextRunAt, '2026-08-08T10:30:00+00:00');

  assert.equal(scheduler.start().nextRunAt, '2026-08-08T10:30:00+00:00', 'start is idempotent');

  const stopped = scheduler.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.nextRunAt, null);
});

test('the scheduler does not drift, and skips slots it slept through', async (t) => {
  const db = fresh();
  const T0 = Date.UTC(2026, 7, 8, 10, 0, 0);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });

  let runs = 0;
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: async () => { runs += 1; return { ok: true, runId: `r${runs}` }; },
  });
  scheduler.start();
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T10:30:00+00:00');

  // The machine was asleep for 95 minutes: three slots came due.
  t.mock.timers.tick(95 * 60_000);
  await flush();

  assert.equal(runs, 1, 'missed slots are skipped, never queued up');
  assert.equal(
    scheduler.status().nextRunAt,
    '2026-08-08T12:00:00+00:00',
    'and the cadence stays on its original 30-minute grid rather than restarting from now',
  );
  assert.equal(scheduler.status().runs, 1);
  assert.equal(scheduler.status().busy, false);

  t.mock.timers.tick(25 * 60_000);
  await flush();
  assert.equal(runs, 2);
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T12:30:00+00:00');

  scheduler.stop();
});

test('the scheduler honours sweep.auto and active hours without stopping the loop', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let runs = 0;
  const scheduler = new Scheduler({
    db,
    config: baseConfig({ sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: false } }),
    run: async () => { runs += 1; return { ok: true }; },
  });
  scheduler.start();
  assert.equal(scheduler.status().auto, false);

  t.mock.timers.tick(31 * 60_000);
  await flush();
  assert.equal(runs, 0, 'auto:false means the timer keeps time but does not sweep');
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T11:00:00+00:00');

  // Turning it back on must not require a restart.
  scheduler.reconfigure(baseConfig());
  assert.equal(scheduler.status().auto, true);
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T11:01:00+00:00');
  scheduler.stop();
});

test('the scheduler runs on demand and records the result', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  const seen = [];
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: async ({ mode }) => ({ ok: true, mode }),
    onRun: (r) => seen.push(r),
  });
  const result = await scheduler.runNow('full');
  assert.deepEqual(result, { ok: true, mode: 'full' });
  assert.equal(seen.length, 1);
  assert.equal(scheduler.status().runs, 1);
  assert.equal(scheduler.status().lastResult.mode, 'full');
  assert.ok(scheduler.status().lastRunAt);
});

test('the scheduler refuses to run two sweeps at once', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let release;
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
  });
  const first = scheduler.runNow();
  await flush();
  const second = await scheduler.runNow();
  assert.deepEqual(second, { ok: false, busy: true, error: 'A sweep is already running' });
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(scheduler.status().runs, 1);
});

test('the scheduler survives a sweep that throws', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: async () => { throw new Error('the disk caught fire'); },
  });
  const result = await scheduler.runNow();
  assert.equal(result.ok, false);
  assert.match(result.error, /disk caught fire/);
  assert.equal(scheduler.status().busy, false);
});

test('the scheduler cancels an in-flight sweep when it is stopped', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let sawAbort = false;
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve({ ok: false, error: 'cancelled' });
        });
      }),
  });
  const pending = scheduler.runNow();
  await flush();
  scheduler.stop();
  await pending;
  assert.equal(sawAbort, true);
});
