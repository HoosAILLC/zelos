/**
 * test/integration.test.mjs — the seams between modules.
 *
 * Every other test file exercises one module with the rest faked out. That is
 * the right way to test a parser, and it is exactly why it cannot catch the
 * class of bug this file exists for: two modules built against the same spec
 * that disagree about a field name, an argument order, or a unit.
 *
 * So nothing here is stubbed at a module boundary. A real IMAP conversation
 * happens over a real socket, a real ICS document is served over real HTTP, a
 * real model endpoint answers on the loopback, `runSweep` runs with its real
 * dependencies, and the board is then read back through the real HTTP server
 * the browser talks to. The only injected dependency is `getSecret`, because
 * the alternative is writing into the developer's actual login keychain.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-integration-'));
process.env.ZELOS_HOME = home;
// Every secret lookup here is injected, but the server routes reach the real
// module — so the backend is pinned to the temp home's encrypted file. A test
// must never be able to write into the developer's login keychain.
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { open: openDb, migrate, close: closeDb, listMessages, getItemByKey } =
  await import('../core/db.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const { createServer, listen } = await import('../core/server.mjs');
const { DEFAULTS } = await import('../core/config.mjs');

/**
 * ui/lib/api.js is browser code: it reads the token out of `location` at import
 * time and keeps it in sessionStorage. Shimming those three globals is enough to
 * run the page's real network client here, which is the point — the SSE frames
 * the server writes and the parser the browser reads them with were built by
 * different hands against the same paragraph of the spec, and a test that
 * reimplements either one proves nothing about whether they agree.
 */
const FIXED_TOKEN = 'a'.repeat(64);
globalThis.window = {
  location: { href: `http://127.0.0.1/?t=${FIXED_TOKEN}`, host: '127.0.0.1' },
  history: { replaceState() {} },
};
globalThis.sessionStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null; },
  setItem(k, v) { this.store.set(k, String(v)); },
};
const { openStream } = await import('../ui/lib/api.js');

/* ================================================================== *
 * Mock IMAP — a real server on a real socket.
 * ================================================================== */

const HEADER_SECTION =
  'HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID)';
const PLAIN_STRUCTURE = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 120 4 NIL NIL NIL NIL)';

function fetchLine({ seq, uid, items = '', section, payload }) {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([
    Buffer.from(`* ${seq} FETCH (UID ${uid}${items ? ` ${items}` : ''} BODY[${section}] {${body.length}}\r\n`, 'utf8'),
    body,
    Buffer.from(')\r\n', 'utf8'),
  ]);
}

/**
 * Serves a different message list per mailbox, so the sweep's INBOX/Sent split
 * — and therefore its in/out direction rule — is exercised for real.
 */
function startMockImap(mailboxes) {
  const commandLog = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK [CAPABILITY IMAP4rev1] Zelos integration mock\r\n');

    let selected = 'INBOX';
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        commandLog.push(line);

        const parts = line.split(' ');
        const tag = parts[0] || '';
        let verb = (parts[1] || '').toUpperCase();
        let argStart = 2;
        if (verb === 'UID') {
          verb = `UID ${(parts[2] || '').toUpperCase()}`;
          argStart = 3;
        }
        const args = parts.slice(argStart).join(' ');
        const send = (text) => socket.write(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));
        const list = mailboxes[selected] || [];

        switch (verb) {
          case 'CAPABILITY':
            send(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
            break;
          case 'LOGIN':
            send(`${tag} OK LOGIN completed\r\n`);
            break;
          case 'SELECT':
          case 'EXAMINE': {
            selected = args.replace(/^"|"$/g, '').trim();
            const n = (mailboxes[selected] || []).length;
            send(
              `* ${n} EXISTS\r\n`
              + '* OK [UIDVALIDITY 42] UIDs valid\r\n'
              + '* OK [UIDNEXT 9001] Predicted next UID\r\n'
              + '* FLAGS (\\Answered \\Seen)\r\n'
              + `${tag} OK [READ-ONLY] completed\r\n`,
            );
            break;
          }
          case 'UID SEARCH':
            send(`* SEARCH ${list.map((m) => m.uid).join(' ')}\r\n${tag} OK UID SEARCH completed\r\n`);
            break;
          case 'UID FETCH': {
            const spec = args.slice(args.indexOf('('));
            const set = args.slice(0, args.indexOf('(')).trim().split(',').filter(Boolean);
            const wanted = set
              .map((uid) => list.find((m) => String(m.uid) === uid))
              .filter(Boolean);
            if (spec.includes('BODYSTRUCTURE')) {
              wanted.forEach((m, i) => send(fetchLine({
                seq: i + 1,
                uid: m.uid,
                items: `FLAGS (${m.flags ?? '\\Seen'}) INTERNALDATE "${m.internalDate}" BODYSTRUCTURE ${PLAIN_STRUCTURE}`,
                section: HEADER_SECTION,
                payload: m.headers,
              })));
            } else {
              const part = /BODY\.PEEK\[([^\]]*)\]/.exec(spec)?.[1] ?? '1';
              wanted.forEach((m, i) => send(fetchLine({ seq: i + 1, uid: m.uid, section: part, payload: m.body })));
            }
            send(`${tag} OK UID FETCH completed\r\n`);
            break;
          }
          case 'LOGOUT':
            send(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
            break;
          default:
            send(`${tag} BAD unexpected ${verb}\r\n`);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      commandLog,
      async close() {
        for (const s of sockets) s.destroy();
        await new Promise((done) => server.close(done));
      },
    }));
  });
}

function headerBlock(lines) {
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/* ================================================================== *
 * Mock HTTP — the calendar, and the model.
 * ================================================================== */

function startHttp(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/**
 * An OpenAI-protocol endpoint on the loopback — which `isLocalAddress` treats as
 * local, so it must be reachable with no API key at all. It records the request
 * body so the test can assert on the prompt the model was actually handed.
 */
function startMockModel(replyFor) {
  const seen = [];
  return startHttp((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ url: req.url, headers: req.headers, body });

      // `stream:true` is a different wire format, not a different answer: the
      // Ask view depends on it, so the mock has to speak it for real.
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of ['You owe Riverstone ', '$18,400', ', due Friday.']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 9 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: replyFor(seen.length, body) } }],
        usage: { prompt_tokens: 1234, completion_tokens: 567 },
      }));
    });
  }).then((s) => ({ ...s, seen }));
}

/* ================================================================== *
 * Fixtures
 * ================================================================== */

/** Two days out, so it lands inside every window the sweep and the board use. */
function soonISO(dayOffset, hour) {
  const d = new Date(Date.now() + dayOffset * 86_400_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(hour)}0000`;
}

const INBOX = [
  {
    uid: 101,
    internalDate: '07-Aug-2026 09:15:00 -0400',
    // RFC 2047 base64: "Café invoice — final numbers"
    headers: headerBlock([
      'From: "Reyes, Marcus" <marcus@riverstone.example>',
      'To: Nemo Hale <nemo@northgate.example>',
      'Subject: =?utf-8?B?Q2Fmw6kgaW52b2ljZSDigJQgZmluYWwgbnVtYmVycw==?=',
      'Date: Fri, 07 Aug 2026 09:15:00 -0400',
      'Message-ID: <inv-1@riverstone.example>',
    ]),
    body: 'The final number is $18,400. Wire by Friday.\r\n',
  },
  {
    uid: 102,
    internalDate: '07-Aug-2026 11:00:00 -0400',
    headers: headerBlock([
      'From: Jane Roe <jane@aldervance.example>',
      'To: Nemo Hale <nemo@northgate.example>',
      'Subject: Re: site walk (rescheduled) ) stray paren',
      'Date: Fri, 07 Aug 2026 11:00:00 -0400',
      'Message-ID: <walk-2@aldervance.example>',
    ]),
    body: 'Can we move the site walk to Thursday?\r\n',
  },
];

const SENT = [
  {
    uid: 201,
    internalDate: '07-Aug-2026 12:00:00 -0400',
    headers: headerBlock([
      'From: Nemo Hale <nemo@northgate.example>',
      'To: Jane Roe <jane@aldervance.example>',
      'Subject: Re: site walk (rescheduled) ) stray paren',
      'Date: Fri, 07 Aug 2026 12:00:00 -0400',
      'Message-ID: <walk-3@northgate.example>',
      'In-Reply-To: <walk-2@aldervance.example>',
    ]),
    body: "I'll send the revised schedule Monday.\r\n",
  },
];

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Zelos//integration//EN',
  'X-WR-CALNAME:Work',
  'BEGIN:VEVENT',
  'UID:walk-0001',
  'SUMMARY:Site walk with Alder Vance',
  'LOCATION:1400 Riverstone Dr',
  `DTSTART;TZID=America/New_York:${soonISO(2, 14)}`,
  `DTEND;TZID=America/New_York:${soonISO(2, 15)}`,
  'ORGANIZER;CN=Jane Roe:mailto:jane@aldervance.example',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:holiday-0002',
  'SUMMARY:Office closed',
  `DTSTART;VALUE=DATE:${soonISO(3, 0).slice(0, 8)}`,
  `DTEND;VALUE=DATE:${soonISO(4, 0).slice(0, 8)}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/**
 * A deliberately badly-behaved model answer: fenced in prose, six `now` items
 * where the spec allows four, an out-of-range severity, an illegal bucket, a
 * `sourceRefs` entry pointing at a message that does not exist, a draft with a
 * bracketed placeholder, and a `javascript:` link.
 */
function boardReply(msgRef) {
  return `Sure! Here is the board you asked for.

\`\`\`json
${JSON.stringify({
    first: 'wire-riverstone',
    items: [
      { key: 'wire-riverstone', bucket: 'now', headline: 'Wire $18,400 to Riverstone before Friday', why: 'Marcus sent final numbers and the wire window closes Friday.', person: 'Marcus Reyes', personEmail: 'marcus@riverstone.example', dueAt: null, severity: 3, sourceRefs: [msgRef, 'msg:ffffffffffffffff'], link: 'https://riverstone.example/invoice/9', draft: null },
      { key: 'confirm-site-walk', bucket: 'now', headline: 'Confirm Thursday for the Alder Vance site walk', why: 'Jane asked to move it and has not heard back.', person: 'Jane Roe', personEmail: 'jane@aldervance.example', dueAt: null, severity: 2, sourceRefs: [], link: null, draft: { to: 'jane@aldervance.example', subject: 'Re: site walk', body: 'Thursday works. I will be on site at 2pm.' } },
      { key: 'send-revised-schedule', bucket: 'promised', headline: 'Send Jane the revised schedule you promised Monday', why: 'You told her Monday; it is not sent.', person: 'Jane Roe', personEmail: 'jane@aldervance.example', dueAt: null, severity: 2, sourceRefs: [], link: null, draft: { to: 'jane@aldervance.example', subject: 'Revised schedule', body: 'Hi [NAME], attached is the revised schedule.' } },
      { key: 'now-four', bucket: 'now', headline: 'Fourth thing the model thought was urgent', why: 'Filler with a real severity.', person: '', personEmail: '', dueAt: null, severity: 2, sourceRefs: [], link: null, draft: null },
      { key: 'now-five', bucket: 'now', headline: 'Fifth thing the model thought was urgent', why: 'Should be demoted out of now.', person: '', personEmail: '', dueAt: null, severity: 1, sourceRefs: [], link: null, draft: null },
      { key: 'now-six', bucket: 'now', headline: 'Sixth thing the model thought was urgent', why: 'Should be demoted out of now.', person: '', personEmail: '', dueAt: null, severity: 0, sourceRefs: [], link: null, draft: null },
      { key: 'bad-bucket', bucket: 'URGENT!!', headline: 'Bucket the model invented', why: 'Must be clamped to something legal.', person: '', personEmail: '', dueAt: null, severity: 99, sourceRefs: [], link: 'javascript:alert(1)', draft: null },
    ],
    notes: ['Two threads with Alder Vance are really one conversation.'],
  }, null, 0)}
\`\`\`

Let me know if you want it re-ranked.`;
}

/* ================================================================== *
 * One live stack, shared by the whole file.
 * ================================================================== */

let imap;
let calendar;
let model;
let db;
let config;
let server;
let base;
let token;
let firstRun;
let secondRun;
let inboxMessageId;
let carriedAfterFirstRun;

before(async () => {
  imap = await startMockImap({ INBOX, Sent: SENT });
  calendar = await startHttp((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(ICS);
  });

  db = openDb(path.join(home, 'integration.db'));
  migrate(db);

  config = structuredClone(DEFAULTS);
  config.identity = { name: 'Nemo Hale', email: 'nemo@northgate.example', timezone: 'America/New_York' };
  config.mail = [{
    id: 'm_test01', enabled: true, label: 'Work',
    host: '127.0.0.1', port: imap.port, secure: false,
    user: 'nemo@northgate.example', keyRef: 'mail.m_test01',
    mailboxes: ['INBOX'], sentMailbox: 'Sent',
    lookbackDays: 400, maxMessages: 50,
  }];
  config.calendars = [{
    id: 'c_test01', enabled: true, label: 'Work', kind: 'ics',
    url: `http://127.0.0.1:${calendar.port}/work.ics`, user: '', keyRef: null,
  }];
  config.sweep.auto = false;

  // The mail fixture is dated Aug 2026; a short lookback would search it away on
  // a machine whose clock is far from that. 400 days keeps the fixture in range.
  model = await startMockModel(() => boardReply(`msg:${inboxMessageId}`));
  config.model = {
    ...config.model,
    protocol: 'openai',
    label: 'Local',
    baseUrl: `${model.origin}/v1`,
    model: 'test-model',
    keyRef: null,
  };

  // The one seam: a real getSecret would write to the developer's keychain.
  const deps = { getSecret: async (ref) => (ref === 'mail.m_test01' ? 'app-password' : null) };

  // Pass one primes the database so the model reply can name a real message id.
  await runSweep({ db, config, mode: 'light', deps });
  inboxMessageId = listMessages(db, { limit: 10 }).find((m) => m.uid === 101).id;

  firstRun = await runSweep({ db, config, mode: 'full', deps });
  // Snapshotted before the second run so the carry-forward assertion compares
  // against a value that was really written, not one derived after the fact.
  carriedAfterFirstRun = structuredClone(getItemByKey(db, 'wire-riverstone'));
  secondRun = await runSweep({ db, config, mode: 'full', deps });

  server = createServer({
    db,
    config,
    token: FIXED_TOKEN,
    heartbeatMs: 50,
    runSweep: async ({ onProgress } = {}) => {
      onProgress?.({ phase: 'fetch', message: 'Reading mail', done: 0, total: 2 });
      onProgress?.({ phase: 'think', message: 'Asking the model', done: 1, total: 2 });
      return { runId: 'run_streamtest', ok: true, stats: { messages: 3, items: 6 } };
    },
  });
  const bound = await listen(server, { port: 0 });
  base = bound.url.replace(/\/$/, '');
  token = server.sessionToken;
});

after(async () => {
  await new Promise((done) => server.close(done));
  closeDb(db);
  await Promise.all([imap.close(), calendar.close(), model.close()]);
});

const apiGet = async (p) => {
  const res = await fetch(base + p, { headers: { 'X-Zelos-Token': token } });
  return { status: res.status, body: await res.json() };
};

/* ================================================================== *
 * Tests
 * ================================================================== */

describe('mail: imap.mjs -> sweep.mjs -> db.mjs', () => {
  test('the sweep reads both mailboxes and stores what came off the wire', () => {
    assert.equal(firstRun.ok, true, firstRun.error);
    const stored = listMessages(db, { limit: 50 });
    assert.equal(stored.length, 3);
  });

  test('an RFC2047 subject survives the whole path into the database', () => {
    const row = listMessages(db, { limit: 50 }).find((m) => m.uid === 101);
    assert.equal(row.subject, 'Café invoice — final numbers');
    assert.equal(row.from_email, 'marcus@riverstone.example');
    assert.equal(row.sent_at, '2026-08-07T09:15:00-04:00');
  });

  test('the sent mailbox is stored as outbound and the inbox as inbound', () => {
    const byUid = new Map(listMessages(db, { limit: 50 }).map((m) => [m.uid, m]));
    assert.equal(byUid.get(101).direction, 'in');
    assert.equal(byUid.get(102).direction, 'in');
    assert.equal(byUid.get(201).direction, 'out', 'the Sent mailbox is what "promised" is mined from');
  });

  test('a reply and its parent share a thread key', () => {
    const byUid = new Map(listMessages(db, { limit: 50 }).map((m) => [m.uid, m]));
    assert.equal(byUid.get(102).thread_key, byUid.get(201).thread_key);
  });

  test('the sweep never marks the user\'s mail read', () => {
    const peeks = imap.commandLog.filter((l) => /BODY(\.PEEK)?\[/.test(l));
    assert.ok(peeks.length > 0, 'expected the client to fetch some body sections');
    for (const line of peeks) {
      assert.ok(!/BODY\[/.test(line), `BODY[ without PEEK sets \\Seen: ${line}`);
    }
  });
});

describe('calendar: ics.mjs -> sweep.mjs -> db.mjs -> /api/state', () => {
  test('a TZID event keeps its own offset all the way to the API', async () => {
    const { body } = await apiGet('/api/state');
    const walk = body.events.find((e) => e.uid === 'walk-0001');
    assert.ok(walk, 'the timed event should be on the board');
    assert.match(
      walk.starts_at,
      /^\d{4}-\d{2}-\d{2}T14:00:00-0[45]:00$/,
      `wall-clock 14:00 must survive with an explicit offset, got ${walk.starts_at}`,
    );
    assert.equal(walk.all_day, false);
    assert.equal(walk.title, 'Site walk with Alder Vance');
    assert.equal(walk.location, '1400 Riverstone Dr');
  });

  test('an all-day event stays a bare date and is flagged all-day', async () => {
    const { body } = await apiGet('/api/state');
    const holiday = body.events.find((e) => e.uid === 'holiday-0002');
    assert.ok(holiday, 'the all-day event should be on the board');
    assert.match(holiday.starts_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(holiday.all_day, true);
  });
});

describe('prompt: db.mjs -> triage.mjs -> llm.mjs', () => {
  test('the request that hit the socket is an OpenAI chat completion', () => {
    const call = model.seen.at(-1);
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.body.model, 'test-model');
    assert.ok(Array.isArray(call.body.messages) && call.body.messages.length > 0);
  });

  test('a keyless loopback endpoint needs no API key', () => {
    const call = model.seen.at(-1);
    assert.equal(call.headers.authorization, undefined);
    assert.ok(model.seen.length >= 2, 'both full sweeps reached the model');
  });

  test('the model was shown the mail this sweep actually fetched', () => {
    const text = JSON.stringify(model.seen.at(-1).body);
    assert.ok(text.includes('Café invoice'), 'the decoded subject should reach the prompt');
    assert.ok(text.includes('aldervance.example'), 'the correspondent should reach the prompt');
  });

  test('the board the model returned came back through the response, not a stub', () => {
    assert.equal(firstRun.stats.tokensIn, 1234);
    assert.equal(firstRun.stats.tokensOut, 567);
  });
});

describe('board: triage clamps hold all the way to /api/state', () => {
  test('six now items from the model become at most four on the board', async () => {
    const { body } = await apiGet('/api/state');
    const nowItems = body.items.filter((i) => i.bucket === 'now');
    assert.ok(nowItems.length <= 4, `now must be capped at 4, got ${nowItems.length}`);
    assert.equal(body.counts.now, nowItems.length, 'the rail count must match the rows');
  });

  test('the demoted items are carried, not dropped', async () => {
    const { body } = await apiGet('/api/state');
    const keys = new Set(body.items.map((i) => i.id));
    for (const key of ['now-five', 'now-six']) {
      assert.ok(getItemByKey(db, key), `${key} must still exist after demotion`);
    }
    assert.ok(keys.size >= 6, 'every legal item the model returned should be on the board');
  });

  test('an illegal bucket and an out-of-range severity are clamped, not stored raw', async () => {
    const { body } = await apiGet('/api/state');
    const legal = new Set(['now', 'today', 'soon', 'waiting', 'promised', 'note', 'money']);
    for (const item of body.items) {
      assert.ok(legal.has(item.bucket), `illegal bucket reached the board: ${item.bucket}`);
      assert.ok(item.severity >= 0 && item.severity <= 3, `severity out of range: ${item.severity}`);
    }
  });

  test('a javascript: link never reaches the board', async () => {
    const { body } = await apiGet('/api/state');
    for (const item of body.items) {
      if (item.link) assert.match(item.link, /^(https?:|mailto:)/, `unsafe link: ${item.link}`);
    }
    const invented = body.items.find((i) => i.id === 'bad-bucket');
    if (invented) assert.equal(invented.link, null);
  });

  test('a sourceRef pointing at nothing is dropped and the real one kept', async () => {
    const item = getItemByKey(db, 'wire-riverstone');
    assert.ok(item, 'the hero item should exist');
    assert.deepEqual(item.sourceRefs, [`msg:${inboxMessageId}`]);
  });
});

describe('drafts: triage -> db -> /api/state -> PUT', () => {
  test('a draft with a bracketed placeholder is rejected as not ready', async () => {
    const { body } = await apiGet('/api/state');
    for (const draft of body.drafts) {
      assert.ok(!/\[[^\]]+\]/.test(draft.body), `a placeholder draft was published: ${draft.body}`);
    }
  });

  test('a finished draft reaches the board addressed to a real person', async () => {
    const { body } = await apiGet('/api/state');
    const draft = body.drafts.find((d) => d.to_email === 'jane@aldervance.example');
    assert.ok(draft, 'the ready draft should be on the board');
    assert.match(draft.body, /Thursday works/);
  });

  test('an edit to a draft persists', async () => {
    const before = (await apiGet('/api/state')).body.drafts[0];
    const res = await fetch(`${base}/api/drafts/${encodeURIComponent(before.id)}`, {
      method: 'PUT',
      headers: { 'X-Zelos-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Thursday at 2pm works.', state: 'edited' }),
    });
    assert.equal(res.status, 200);
    const after2 = (await apiGet('/api/state')).body.drafts.find((d) => d.id === before.id);
    assert.equal(after2.body, 'Thursday at 2pm works.');
    assert.equal(after2.state, 'edited');
  });
});

describe('identity: a second sweep carries an item forward', () => {
  test('the second run re-fetched the same mail without duplicating it', () => {
    assert.equal(secondRun.ok, true, secondRun.error);
    assert.equal(listMessages(db, { limit: 50 }).length, 3);
  });

  test('an item returned twice keeps its first_seen and increments seen_runs', () => {
    const item = getItemByKey(db, 'wire-riverstone');
    assert.equal(carriedAfterFirstRun.seen_runs, 1);
    assert.equal(item.seen_runs, 2, 'seen_runs counts full runs, not model calls');
    assert.equal(
      item.first_seen,
      carriedAfterFirstRun.first_seen,
      'first_seen is what "carried for N days" is measured from and must never be rewritten',
    );
    assert.equal(item.last_seen_run, secondRun.runId);
    assert.notEqual(item.last_seen_run, firstRun.runId);
  });

  test('a decision the user made is not overwritten by the next sweep', async () => {
    const target = getItemByKey(db, 'confirm-site-walk');
    const res = await fetch(`${base}/api/items/${encodeURIComponent(target.id)}/state`, {
      method: 'POST',
      headers: { 'X-Zelos-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'done' }),
    });
    assert.equal(res.status, 200);

    const deps = { getSecret: async () => 'app-password' };
    await runSweep({ db, config, mode: 'full', deps });
    assert.equal(getItemByKey(db, 'confirm-site-walk').state, 'done');
  });
});

describe('the board the browser is served', () => {
  test('/api/state carries every key ui/lib/store.js reads', async () => {
    const { status, body } = await apiGet('/api/state');
    assert.equal(status, 200);
    for (const key of ['items', 'events', 'drafts', 'runs', 'counts', 'notes', 'first']) {
      assert.ok(key in body, `/api/state is missing ${key}`);
    }
    assert.ok(Array.isArray(body.items) && Array.isArray(body.events) && Array.isArray(body.drafts));
    assert.equal(typeof body.counts, 'object');
  });

  test('every item carries the exact fields the UI renders', async () => {
    const { body } = await apiGet('/api/state');
    assert.ok(body.items.length > 0);
    for (const item of body.items) {
      for (const key of ['id', 'bucket', 'headline', 'why', 'severity', 'state', 'due_at',
        'person', 'person_email', 'first_seen', 'seen_runs', 'sourceRefs']) {
        assert.ok(key in item, `item ${item.id} is missing ${key}`);
      }
    }
  });

  test('the last run is reported with the stats the header shows', async () => {
    const { body } = await apiGet('/api/state');
    assert.ok(body.runs.last, 'a completed sweep should be reported');
    assert.equal(body.runs.last.ok, true);
    assert.equal(typeof body.runs.last.stats.messages, 'number');
  });

  test('/api/search finds a message the sweep indexed', async () => {
    const { body } = await apiGet('/api/search?q=Riverstone');
    assert.ok(body.results.length > 0, 'FTS5 should have indexed the fetched mail');
  });
});

describe('SSE: core/server.mjs writes frames ui/lib/api.js can read', () => {
  test('sweep progress reaches the page through the real client parser', async () => {
    const events = [];
    const controller = new AbortController();
    const streaming = openStream(`${base}/api/sweep/stream`, {
      signal: controller.signal,
      onEvent: (name, data) => {
        events.push([name, data]);
        if (name === 'done' || name === 'failed') controller.abort();
      },
    }).catch((err) => { if (err.name !== 'AbortError') throw err; });

    // The stream has to be listening before the sweep starts, or the progress
    // it is meant to carry is emitted into an empty room.
    await new Promise((r) => setTimeout(r, 60));
    await fetch(`${base}/api/sweep`, {
      method: 'POST',
      headers: { 'X-Zelos-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full' }),
    });
    await streaming;

    const names = events.map(([n]) => n);
    assert.ok(names.includes('hello'), `the stream should greet with status, got ${names.join(',')}`);
    assert.ok(names.includes('progress'), `progress should reach the page, got ${names.join(',')}`);
    assert.ok(names.includes('done'), `completion should reach the page, got ${names.join(',')}`);

    const progress = events.find(([n]) => n === 'progress')[1];
    for (const key of ['phase', 'message', 'done', 'total']) {
      assert.ok(key in progress, `progress is missing ${key}, which the sweep bar reads`);
    }
    assert.equal(typeof progress.message, 'string');
  });

  test('a streamed answer arrives as deltas with its sources', async () => {
    const events = [];
    await openStream(`${base}/api/ask`, {
      method: 'POST',
      body: { question: 'What do I owe Riverstone?' },
      onEvent: (name, data) => events.push([name, data]),
    });

    const names = events.map(([n]) => n);
    assert.ok(names.includes('sources'), `the answer must name what it read, got ${names.join(',')}`);
    assert.ok(names.includes('delta'), `the answer must stream, got ${names.join(',')}`);
    assert.ok(names.includes('done'), `the answer must terminate, got ${names.join(',')}`);

    const text = events.filter(([n]) => n === 'delta').map(([, d]) => d.text).join('');
    assert.ok(text.length > 0, 'the assembled answer should not be empty');

    const sources = events.find(([n]) => n === 'sources')[1];
    assert.ok(Array.isArray(sources));
  });

  test('an unauthenticated stream is refused before any frame is written', async () => {
    const res = await fetch(`${base}/api/sweep/stream`, { headers: { Accept: 'text/event-stream' } });
    assert.equal(res.status, 401);
    assert.notEqual(res.headers.get('content-type'), 'text/event-stream');
    await res.arrayBuffer();
  });
});

describe('privacy.sendBodies is a real setting, not a label', () => {
  const SECRET = 'ZZ-ROUTING-021000021-ZZ';

  /** Runs one sweep against a throwaway db and returns what hit the model. */
  async function promptWith(sendBodies) {
    const scratchDb = openDb(path.join(home, `privacy-${sendBodies}.db`));
    migrate(scratchDb);
    const { upsertMessages } = await import('../core/db.mjs');
    upsertMessages(scratchDb, [{
      sourceId: 'm_p', uid: 1, messageId: 'p@x', threadKey: 'p@x', folder: 'INBOX', direction: 'in',
      from: { name: 'Marcus', email: 'marcus@riverstone.example' }, to: [], cc: [],
      subject: 'Wire details', date: new Date().toISOString(),
      snippet: 'Wire details enclosed', text: `Please wire today. ${SECRET}`,
      hasAttachments: false, flags: [],
    }]);

    const cfg = structuredClone(config);
    cfg.mail = [];
    cfg.calendars = [];
    cfg.privacy = { ...cfg.privacy, sendBodies };
    const at = model.seen.length;
    await runSweep({ db: scratchDb, config: cfg, mode: 'full', deps: { getSecret: async () => null } });
    closeDb(scratchDb);
    return JSON.stringify(model.seen.slice(at));
  }

  test('with sendBodies on, the body is in the request', async () => {
    assert.ok((await promptWith(true)).includes(SECRET));
  });

  test('with sendBodies off, the body never reaches the socket', async () => {
    const wire = await promptWith(false);
    assert.ok(!wire.includes(SECRET), 'the message body was sent despite privacy.sendBodies:false');
    assert.ok(wire.includes('Wire details'), 'headers and snippet should still be sent');
  });

  test('response_format is never sent to a local endpoint', () => {
    for (const call of model.seen) {
      assert.ok(!('response_format' in call.body),
        'many local runtimes reject response_format; the spec says to rely on the prompt instead');
    }
  });
});

/* ================================================================== *
 * The source kinds and the protocol the main path did not exercise.
 * ================================================================== */

describe('the calendar kinds sweep.mjs dispatches on', () => {
  /** A throwaway db so each calendar kind is judged on its own events. */
  function scratch(name) {
    const scratchDb = openDb(path.join(home, `${name}.db`));
    migrate(scratchDb);
    return scratchDb;
  }

  test('kind:"file" reads an .ics off disk', async () => {
    const file = path.join(home, 'on-disk.ics');
    fs.writeFileSync(file, ICS);
    const scratchDb = scratch('file-cal');
    const cfg = structuredClone(config);
    cfg.mail = [];
    cfg.calendars = [{ id: 'c_file', enabled: true, label: 'On disk', kind: 'file', url: file, keyRef: null }];

    const result = await runSweep({ db: scratchDb, config: cfg, mode: 'full', deps: { getSecret: async () => null } });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stats.events, 2, 'both events in the file should be stored');
    closeDb(scratchDb);
  });

  test('kind:"caldav" discovers a collection and stores what the REPORT returned', async () => {
    const principal = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat>
<d:prop><d:current-user-principal><d:href>/dav/principals/nemo/</d:href></d:current-user-principal></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const homeSet = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response>
<d:href>/dav/principals/nemo/</d:href><d:propstat>
<d:prop><cal:calendar-home-set><d:href>/dav/calendars/nemo/</d:href></cal:calendar-home-set></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const collections = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response>
<d:href>/dav/calendars/nemo/personal/</d:href><d:propstat><d:prop>
<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
<d:displayname>Personal</d:displayname>
<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const escaped = ICS.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const report = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response>
<d:href>/dav/calendars/nemo/personal/e0.ics</d:href><d:propstat>
<d:prop><cal:calendar-data>${escaped}</cal:calendar-data></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

    const seenAuth = [];
    const dav = await startHttp((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seenAuth.push(req.headers.authorization ?? null);
        const routes = {
          'PROPFIND /dav/': principal,
          'PROPFIND /dav/principals/nemo/': homeSet,
          'PROPFIND /dav/calendars/nemo/': collections,
          'REPORT /dav/calendars/nemo/personal/': report,
        };
        const body = routes[`${req.method} ${req.url}`];
        if (!body) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(body);
      });
    });

    try {
      const scratchDb = scratch('caldav-cal');
      const cfg = structuredClone(config);
      cfg.mail = [];
      cfg.calendars = [{
        id: 'c_dav', enabled: true, label: 'DAV', kind: 'caldav',
        url: `${dav.origin}/dav/`, user: 'nemo', keyRef: 'cal.c_dav',
      }];

      const result = await runSweep({
        db: scratchDb,
        config: cfg,
        mode: 'full',
        deps: { getSecret: async () => 'dav-password' },
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.stats.events, 2, 'the REPORT body should have been parsed as ICS');
      assert.ok(
        seenAuth.some((a) => a?.startsWith('Basic ')),
        'the stored password should be used, not silently skipped',
      );
      closeDb(scratchDb);
    } finally {
      await dav.close();
    }
  });

  test('a source that fails does not fail the sweep', async () => {
    const scratchDb = scratch('broken-cal');
    const cfg = structuredClone(config);
    cfg.mail = [];
    cfg.calendars = [
      { id: 'c_dead', enabled: true, label: 'Dead', kind: 'ics', url: 'http://127.0.0.1:1/none.ics', keyRef: null },
      { id: 'c_live', enabled: true, label: 'Live', kind: 'ics', url: `http://127.0.0.1:${calendar.port}/work.ics`, keyRef: null },
    ];

    const result = await runSweep({ db: scratchDb, config: cfg, mode: 'full', deps: { getSecret: async () => null } });
    assert.equal(result.ok, true, 'one unreachable calendar must not cost the user the others');
    assert.equal(result.stats.events, 2, 'the reachable calendar should still have been read');
    assert.equal(result.stats.sourcesFailed, 1);
    const dead = result.stats.sources.find((s) => s.id === 'c_dead');
    assert.equal(dead.ok, false);
    assert.ok(dead.error, 'a failed source must say why, so Settings can show it');
    closeDb(scratchDb);
  });
});

describe('the anthropic wire protocol, driven by the real sweep', () => {
  test('the system prompt goes top-level and max_tokens is sent', async () => {
    const seen = [];
    const anthropic = await startHttp((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'claude-test',
          content: [{ type: 'text', text: '{"first":null,"items":[],"notes":["nothing pressing"]}' }],
          usage: { input_tokens: 11, output_tokens: 22 },
        }));
      });
    });

    try {
      const scratchDb = openDb(path.join(home, 'anthropic.db'));
      migrate(scratchDb);
      const cfg = structuredClone(config);
      cfg.mail = [];
      cfg.calendars = [];
      cfg.model = {
        ...cfg.model,
        protocol: 'anthropic',
        baseUrl: anthropic.origin,
        model: 'claude-test',
        keyRef: 'model.default',
        maxTokens: 4096,
      };

      const result = await runSweep({
        db: scratchDb,
        config: cfg,
        mode: 'full',
        deps: { getSecret: async () => 'sk-ant-test' },
      });
      assert.equal(result.ok, true, result.error);

      const call = seen.at(-1);
      assert.equal(call.url, '/v1/messages');
      assert.equal(call.headers['x-api-key'], 'sk-ant-test');
      assert.equal(call.headers['anthropic-version'], '2023-06-01');
      assert.equal(call.headers.authorization, undefined, 'anthropic authenticates with x-api-key, not Bearer');
      assert.equal(typeof call.body.system, 'string');
      assert.ok(call.body.system.length > 0, 'the system prompt must be top-level, not a message');
      assert.equal(call.body.max_tokens, 4096, 'anthropic rejects a request without max_tokens');
      for (const m of call.body.messages) {
        assert.notEqual(m.role, 'system', 'no system role may appear in the anthropic message list');
      }
      assert.equal(result.stats.tokensIn, 11);
      assert.equal(result.stats.tokensOut, 22);
      closeDb(scratchDb);
    } finally {
      await anthropic.close();
    }
  });
});
