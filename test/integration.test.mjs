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
// The temp home is removed at the very bottom of the teardown, not here — see
// the hook below the one that closes the stack. It has to run after the
// database inside it is closed, and node:test runs root `after` hooks in the
// order they were registered.

const { open: openDb, migrate, close: closeDb, listMessages, getItemByKey, itemRowId, getKV } =
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

/**
 * And only now the home itself.
 *
 * This used to be registered beside the `mkdtemp` at the top of the file, and
 * node:test runs root `after` hooks in the order they were registered — so the
 * directory was being removed while the SQLite database inside it was still
 * open. POSIX unlinks a file a process still holds without complaint, which is
 * why that was invisible on macOS and Linux; Windows refuses, and `rmSync`
 * answered EPERM/EBUSY from a root hook, which fails the whole file rather than
 * one test. The retries are for the same platform: a handle can outlive
 * `close()` by a few milliseconds, and Node documents exactly these errors as
 * the ones `maxRetries` exists for.
 */
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const apiGet = async (p) => {
  const res = await fetch(base + p, { headers: { 'X-Zelos-Token': token } });
  return { status: res.status, body: await res.json() };
};

/* ================================================================== *
 * Enough browser to run a view
 *
 * The point of this file is that no seam is faked, and "the view reads what the
 * server wrote" is a seam. ui/lib/dom.js builds real elements, so running a view
 * here needs a `document` — but only the handful of behaviours `el()` uses, and
 * a stub of exactly those is honest in a way a whole DOM library would not be:
 * anything the view starts relying on that is not here fails loudly instead of
 * being quietly emulated.
 * ================================================================== */

/** ui/lib/dom.js's `append` asks `children instanceof Node`, so there has to be one. */
class FakeNode {}

function fakeNode(tag) {
  const self = Object.assign(new FakeNode(), {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    dataset: {},
    listeners: {},
    textContent: '',
    hidden: false,
    isConnected: false,
    style: { setProperty(name, value) { this[name] = String(value); } },
    setAttribute(k, v) { self.attributes[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(self.attributes, k) ? self.attributes[k] : null; },
    addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
    appendChild(child) { child.parentNode = self; self.children.push(child); return child; },
    replaceChildren(...kids) { self.children = kids; },
    after(node) {
      const kids = self.parentNode?.children;
      if (kids) kids.splice(kids.indexOf(self) + 1, 0, node);
    },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {} },
  });
  return self;
}

function installBrowserGlobals() {
  if (!globalThis.Node) globalThis.Node = FakeNode;
  if (!globalThis.localStorage) {
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  }
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = () => 0;
  if (!globalThis.getComputedStyle) {
    globalThis.getComputedStyle = () => ({ lineHeight: '16px', getPropertyValue: () => '0.8' });
  }
  if (!globalThis.document) {
    globalThis.document = {
      documentElement: { style: { setProperty() {} } },
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => [],
      createElement: (tag) => fakeNode(tag),
      createTextNode: (text) => {
        const node = fakeNode('#text');
        node.textContent = String(text);
        return node;
      },
    };
  }
}

/** Every node in a built tree that a predicate likes. */
function collect(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) collect(child, predicate, out);
  return out;
}

/** All the text under a node, in document order. */
function textOf(node) {
  if (!node || typeof node !== 'object') return '';
  return `${node.textContent || ''}${(node.children || []).map(textOf).join('')}`;
}

const addDays = (key, n) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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
    for (const key of ['items', 'events', 'drafts', 'runs', 'counts', 'notes', 'first', 'eventWindow']) {
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

  /**
   * REGRESSION (#27), and the whole seam in one test: the server declares which
   * days its `events` answers for, ui/lib/store.js keeps that declaration, and
   * ui/views/calendar.js stops its ‹ and › at it.
   *
   * Before this contract existed the calendar had no way to tell "no events on
   * that day" from "that day was never in the question", so it drew fully styled
   * empty grids for months it had simply not been sent — measured 2026-08-10:
   * November, 35 empty cells; October, 22; August's own grid, eight. Both ends
   * are asserted against the real modules, because the failure mode this wave
   * exists for is a payload nobody reads and a reader nobody sends to.
   */
  test('the served event window reaches the store and stops the calendar arrows', async () => {
    const { body } = await apiGet('/api/state');
    assert.ok(body.eventWindow, '/api/state must declare the window');

    installBrowserGlobals();
    const store = await import('../ui/lib/store.js');
    const cal = await import('../ui/views/calendar.js');

    // The store keeps what the server said, exactly as loadBoard would.
    store.state.board = { ...store.state.board, ...body };
    assert.deepEqual(store.eventWindow(), body.eventWindow,
      'the store must carry the window the server declared');
    assert.equal(store.dayIsLoaded(body.eventWindow.from), true);
    assert.equal(store.dayIsLoaded(body.eventWindow.to), true);
    // A day past the far edge is not "free", it is unanswered.
    const pastTheEdge = `${Number(body.eventWindow.to.slice(0, 4)) + 2}-01-15`;
    assert.equal(store.dayIsLoaded(pastTheEdge), false);

    // And the calendar refuses to walk there. Month mode from two years out:
    // every cell of that grid is past the edge, so the arrow is dead.
    const window = store.eventWindow();
    assert.equal(cal.rangeIsReachable(cal.keysForAnchor('month', pastTheEdge), window), false);
    // ...while the month the board opens on is reachable, INCLUDING the leading
    // cells its grid borrows from the previous month — the exact eight days that
    // used to fall outside the served window.
    const grid = cal.keysForAnchor('month', body.now.slice(0, 10));
    assert.equal(cal.rangeIsReachable(grid, window), true);
    for (const key of grid.filter((k) => k.slice(0, 7) === body.now.slice(0, 7))) {
      assert.equal(store.dayIsLoaded(key), true,
        `${key} is a cell of this month's own grid and must have been served`);
    }
    assert.equal(store.dayIsLoaded(grid[0]), true,
      `the grid's first cell (${grid[0]}) is drawn on screen today and must have been served`);

    // With no declaration at all — an older server — nothing is refused and
    // nothing is marked, which is what every build before this one did.
    store.state.board = { ...store.state.board, eventWindow: null };
    assert.equal(store.eventWindow(), null);
    assert.equal(store.dayIsLoaded(pastTheEdge), true);
    assert.equal(cal.rangeIsReachable(cal.keysForAnchor('month', pastTheEdge), store.eventWindow()), true);
  });

  /**
   * ...and the grid the reader actually sees.
   *
   * The test above proves the decision is right; this one proves the grid asks
   * it. That distinction is the whole reason this file exists — a helper that is
   * correct and a renderer that never calls it is the shape of every dead
   * feature in this repo, and it passes any test written against the helper.
   *
   * A one-day window, set on the store directly, so the assertion is arithmetic
   * and not a guess about which weekday the far edge lands on today.
   */
  test('a day the window does not cover is drawn as unserved, not as free', async () => {
    installBrowserGlobals();
    const store = await import('../ui/lib/store.js');
    const cal = await import('../ui/views/calendar.js');

    const today = new Date().toISOString().slice(0, 10);
    store.state.config = { calendars: [{ id: 'c_1', kind: 'ics', url: 'https://example.test/c.ics' }] };
    store.state.board = {
      ...store.state.board,
      events: [],
      now: `${today}T12:00:00+00:00`,
      eventWindow: { from: today, to: today },
    };
    store.state.boardAt = Date.now();

    // Week mode (the default when matchMedia says nothing), anchored at today
    // through the route — which is how the search view sends somebody to a day.
    const view = cal.renderCalendar({ sub: today, rerender() {}, navigate() {} });
    const heads = collect(view, (n) => (n.attributes.class || '').includes('cal-head-cell'));
    assert.equal(heads.length, 7, 'a week has seven columns');

    const marked = heads.filter((n) => textOf(n).includes('not loaded'));
    assert.equal(marked.length, 6,
      'six of the seven days are outside a one-day window and none of them may be drawn as merely empty');
    const unmarked = heads.filter((n) => !textOf(n).includes('not loaded'));
    assert.equal(unmarked.length, 1);

    // The columns carry the state too, so the grid below the header is not
    // making the opposite claim to the header above it.
    const cols = collect(view, (n) => (n.attributes.class || '').split(' ').includes('cal-col'));
    assert.equal(cols.filter((n) => (n.attributes.class || '').includes('is-unloaded')).length, 6);

    // The line under the toolbar counts them rather than waving at them.
    assert.ok(textOf(view).includes('6 days here are outside what Zelos has loaded'),
      `the view should say how much of it is unanswered, got: ${textOf(view).slice(0, 400)}`);

    // And both arrows are dead, because no neighbouring week holds a served day.
    const arrows = collect(view, (n) => n.tagName === 'BUTTON' && ['‹', '›'].includes(textOf(n)));
    assert.equal(arrows.length, 2);
    for (const arrow of arrows) {
      assert.equal(arrow.attributes.disabled, '',
        'an arrow that can only ever reach an empty grid must not be pressable');
    }

    // With the window widened to cover the whole week, every mark goes away and
    // the arrows come back — the marking is a claim about data, not decoration.
    store.state.board = {
      ...store.state.board,
      eventWindow: { from: addDays(today, -30), to: addDays(today, 30) },
    };
    const wide = cal.renderCalendar({ sub: today, rerender() {}, navigate() {} });
    assert.equal(textOf(wide).includes('not loaded'), false);
    assert.equal(textOf(wide).includes('outside what Zelos has loaded'), false);
    for (const arrow of collect(wide, (n) => n.tagName === 'BUTTON' && ['‹', '›'].includes(textOf(n)))) {
      assert.equal(arrow.attributes.disabled, undefined);
    }
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

  /**
   * REGRESSION (#51). Ask computed its usage, reported it over SSE, and both
   * ends dropped it: `recordTokens` had one caller, inside `runSweep`'s
   * `finish`. Reproduced with a mock upstream — twenty `POST /api/ask` calls,
   * twenty real completions, 100,000 tokens reported over SSE, and afterwards
   * `sweep.tokens` was null and `/api/state` carried no `tokens` at all.
   *
   * The three hops are all here, in the order they have to hold: the sweep
   * engine writes the counter, /api/state carries the field, and ui/app.js's
   * rail renders it through ui/lib/format.js's `tokenLine`. A test that only
   * checked the SSE frame would have passed on the broken code.
   */
  test('what Ask spends reaches the counter the rail reads', async () => {
    const before = (await apiGet('/api/state')).body.tokens ?? { tokensIn: 0, tokensOut: 0, runs: 0, modelRuns: 0 };

    const events = [];
    await openStream(`${base}/api/ask`, {
      method: 'POST',
      body: { question: 'What do I owe Riverstone?' },
      onEvent: (name, data) => events.push([name, data]),
    });
    const done = events.find(([n]) => n === 'done')[1];
    const spent = (Number(done.usage?.input) || 0) + (Number(done.usage?.output) || 0);
    assert.ok(spent > 0, 'the mock upstream reports usage, so there is something to count');

    const after = (await apiGet('/api/state')).body.tokens;
    assert.ok(after, '/api/state must carry the counter, or the rail has nothing to render');
    assert.equal(after.tokensIn, before.tokensIn + (Number(done.usage.input) || 0),
      'Ask is spend and the counter is a spend counter');
    assert.equal(after.tokensOut, before.tokensOut + (Number(done.usage.output) || 0));
    // ...and it is NOT a sweep. These two are what "asked the model N times
    // today" is counted from.
    assert.equal(after.runs, before.runs, 'an Ask is not a sweep that happened');
    assert.equal(after.modelRuns, before.modelRuns);

    // The third hop: the line the rail actually paints, built by the real
    // formatter from the real payload.
    const fmt = await import('../ui/lib/format.js');
    const line = fmt.tokenLine(after, after.day);
    assert.match(line, /tokens in · .* out$/, `the rail should render the counter, got ${JSON.stringify(line)}`);
    assert.notEqual(line, '');
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

/* ================================================================== *
 * The two promises no single sweep can keep.
 *
 * Everything above judges one run. These are the properties that only
 * break once the user has lived with the board for a while: a `now`
 * bucket that fills up four items at a time, and finished work that
 * comes back because the model was never told it was finished. Both are
 * driven through the real sweep against a real model socket and read
 * back through the real HTTP server the browser talks to.
 * ================================================================== */

describe('the board over several runs: sweep.mjs -> db.mjs -> /api/state', () => {
  const queued = [];
  const prompts = [];
  let boardDb;
  let boardModel;
  let boardServer;
  let boardBase;
  let boardToken;

  const nowItem = (key, severity) => ({
    key,
    bucket: 'now',
    headline: `Deal with ${key}`,
    why: 'Something concrete breaks today.',
    person: '',
    personEmail: '',
    dueAt: null,
    severity,
    sourceRefs: [],
    link: null,
    draft: null,
  });

  const sweepOnce = () => runSweep({
    db: boardDb,
    config: boardConfig,
    mode: 'full',
    deps: { getSecret: async () => null },
  });

  let boardConfig;

  before(async () => {
    boardModel = await startMockModel((_call, body) => {
      prompts.push(body.messages.map((m) => m.content).join('\n'));
      return JSON.stringify(queued.shift() ?? { first: null, items: [], notes: [] });
    });

    boardDb = openDb(path.join(home, 'board-over-runs.db'));
    migrate(boardDb);

    // No mail and no calendars: the subject here is what the board does with
    // model replies over time, and an empty inbox keeps that the only variable.
    boardConfig = structuredClone(config);
    boardConfig.mail = [];
    boardConfig.calendars = [];
    boardConfig.model = { ...config.model, baseUrl: `${boardModel.origin}/v1`, keyRef: null };

    queued.push({ first: null, notes: [], items: [0, 1, 2, 3].map((i) => nowItem(`older-${i}`, 1)) });
    await sweepOnce();
    queued.push({ first: null, notes: [], items: [0, 1, 2, 3].map((i) => nowItem(`newer-${i}`, 3)) });
    await sweepOnce();

    boardServer = createServer({ db: boardDb, config: boardConfig, token: FIXED_TOKEN, heartbeatMs: 50 });
    boardBase = (await listen(boardServer, { port: 0 })).url.replace(/\/$/, '');
    boardToken = boardServer.sessionToken;
  });

  after(async () => {
    await new Promise((done) => boardServer.close(done));
    closeDb(boardDb);
    await boardModel.close();
  });

  const boardGet = async (p) => {
    const res = await fetch(boardBase + p, { headers: { 'X-Zelos-Token': boardToken } });
    return { status: res.status, body: await res.json() };
  };

  test('two legal replies of four now items each leave four on the board, not eight', async () => {
    const { body } = await boardGet('/api/state');
    const inNow = body.items.filter((i) => i.bucket === 'now');
    assert.equal(inNow.length, 4, `the page must never show more than four, got ${inNow.length}`);
    assert.equal(body.counts.now, 4, 'and the rail must agree with the rows');
    assert.deepEqual(
      inNow.map((i) => i.payload.key).sort(),
      ['newer-0', 'newer-1', 'newer-2', 'newer-3'],
      'the survivors are the ones the board ranks first, by severity',
    );
  });

  test('the four that lost their place are carried as today, not dropped', async () => {
    const { body } = await boardGet('/api/state');
    assert.equal(body.items.length, 8, 'every item the model produced is still on the board');
    for (const key of ['older-0', 'older-1', 'older-2', 'older-3']) {
      const row = getItemByKey(boardDb, key);
      assert.equal(row.bucket, 'today', `${key} should have been demoted, not deleted`);
      assert.equal(row.state, 'open', 'demotion is a bucket change and nothing else');
    }
  });

  test('an item the user finishes is named to the next prompt as already handled', async () => {
    const done = await fetch(`${boardBase}/api/items/${itemRowId('newer-0')}/state`, {
      method: 'POST',
      headers: { 'X-Zelos-Token': boardToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'done' }),
    });
    assert.equal(done.status, 200);

    queued.push({ first: null, notes: [], items: [] });
    const third = await sweepOnce();
    assert.equal(third.ok, true, third.error);

    const prompt = prompts.at(-1);
    assert.match(prompt, /ALREADY HANDLED — DO NOT RAISE THESE AGAIN/);
    assert.match(prompt, /key=newer-0 · done/);
    assert.ok(!prompts[0].includes('ALREADY HANDLED'),
      'the first run had nothing handled and was told nothing');
  });

  test('what the runs cost is recorded where the UI can read it', () => {
    const totals = JSON.parse(getKV(boardDb, 'sweep.tokens'));
    assert.match(totals.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(totals.tokensIn, 3 * 1234, 'every successful run added what the endpoint reported');
    assert.equal(totals.tokensOut, 3 * 567);
    assert.equal(totals.runs, 3);
    assert.equal(totals.modelRuns, 3);
    assert.equal(totals.lifetime.tokensIn, 3 * 1234);
    assert.ok(totals.at, 'and it says when it was last touched');
  });
});
