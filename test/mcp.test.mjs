/**
 * test/mcp.test.mjs — the promises the MCP surface makes.
 *
 * Three of these are the product rather than a feature, and they are written to
 * fail loudly rather than to pass easily:
 *
 *  - A scope that is off must hide its tools from `tools/list` AND refuse them
 *    from `tools/call`. Both are checked, separately, because a client that
 *    hardcodes a tool name it saw once must still be stopped.
 *  - With `mail.bodies` off, no response from any tool may contain body text.
 *    That is asserted by putting a known phrase in a body and looking for it in
 *    the SERIALISED response of every tool — not by trusting that the field
 *    mapping omitted it. The same phrase is then found with the scope on, so
 *    the test cannot pass by looking at nothing.
 *  - Nothing here writes. Checked against the module's own source, not by
 *    hoping.
 *
 * No network, no real ~/.zelos: ZELOS_HOME is a temp dir and every database is
 * a file inside it.
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mcp-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SOURCE = fs.readFileSync(path.join(ROOT, 'core', 'mcp.mjs'), 'utf8');

const dbm = await import('../core/db.mjs');
const mcp = await import('../core/mcp.mjs');
const {
  SCOPES, SCOPE_INFO, TOOLS, AI_DEFAULTS, ERROR_CODES,
  PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS,
  aiConfig, toolsFor, handle, createStdioServer, serveStdio,
  recordAccess, listAccessLog,
} = mcp;

after(() => {
  for (const db of OPEN_DBS) { try { dbm.close(db); } catch { /* already closed */ } }
  fs.rmSync(HOME_ROOT, { recursive: true, force: true });
});

/* ================================================================== *
 * Fixtures
 * ================================================================== */

/**
 * The phrase that must never escape with `mail.bodies` off. It lives deep in a
 * message body, well past the snippet, and its words are indexed — so a search
 * for it MATCHES the message even when the text may not be returned.
 */
const BODY_CANARY = 'CANARY-BODY-7f3a4c-must-never-escape';
const BODY_CANARY_2 = 'Wire the balance to account 0042-9981';
const SNIPPET = 'The retainage invoice has not cleared';
/* A word from the SUBJECT line ('Invoice 4471 is past due'), which stays
   searchable with only mail.metadata. 'retainage' would NOT do — it lives in
   the snippet and the body, which is precisely what is no longer searchable. */
const SUBJECT_WORD = 'Invoice';

let seq = 0;
const OPEN_DBS = [];

function freshDb() {
  const file = path.join(HOME_ROOT, `t${seq++}.db`);
  const db = dbm.open(file);
  dbm.migrate(db);
  OPEN_DBS.push(db);
  return db;
}

function message(over = {}) {
  return {
    sourceId: 'm_work',
    uid: 1041,
    messageId: '<invoice-4471@riverstone.example>',
    threadKey: 'thread-invoice',
    folder: 'INBOX',
    direction: 'in',
    from: { name: 'Marcus Reyes', email: 'marcus@riverstone.example' },
    to: [{ name: 'Nemo Hale', email: 'nemo@example.com' }],
    cc: [],
    subject: 'Invoice 4471 is past due',
    date: '2026-08-05T09:12:00-04:00',
    snippet: SNIPPET,
    text: `${SNIPPET}.\n\n${BODY_CANARY_2}. ${BODY_CANARY}.`,
    hasAttachments: true,
    flags: ['\\Seen'],
    ...over,
  };
}

/** A populated database plus the ids the tests need to address it. */
function seeded() {
  const db = freshDb();

  const msgId = dbm.upsertMessage(db, message()).id;
  dbm.upsertMessage(db, message({
    uid: 1042,
    messageId: '<invoice-4471-reply@example.com>',
    direction: 'out',
    from: { name: 'Nemo Hale', email: 'nemo@example.com' },
    to: [{ name: 'Marcus Reyes', email: 'marcus@riverstone.example' }],
    subject: 'Re: Invoice 4471 is past due',
    date: '2026-08-06T08:00:00-04:00',
    snippet: 'Chasing accounting today',
    text: `Chasing accounting today. ${BODY_CANARY}.`,
  }));

  dbm.upsertEvent(db, {
    calendarId: 'c_work',
    uid: 'evt-9001',
    title: 'Pre-con with Alder & Vance',
    description: `Walk the slab schedule. ${BODY_CANARY}.`,
    location: 'Site trailer',
    startsAt: '2026-08-11T14:00:00-04:00',
    endsAt: '2026-08-11T15:00:00-04:00',
    allDay: false,
    organizer: { name: 'Alder', email: 'pm@aldervance.example' },
    attendees: [{ name: 'Nemo Hale', email: 'nemo@example.com', rsvp: 'ACCEPTED' }],
    rsvp: 'ACCEPTED',
    status: 'CONFIRMED',
  });

  const itemId = dbm.upsertItem(db, {
    key: 'invoice-4471-past-due',
    kind: 'money',
    bucket: 'now',
    headline: 'Chase invoice 4471 — 21 days past due',
    why: 'Marcus asked twice and the bank is asking about the retainage.',
    person: 'Marcus Reyes',
    personEmail: 'marcus@riverstone.example',
    dueAt: '2026-08-12T17:00:00-04:00',
    severity: 3,
    sourceRefs: [`msg:${msgId}`, 'evt:missing-on-purpose'],
    // Raw model output. It never goes out, so a body quoted into it cannot leak.
    payload: { rawModelNote: `verbatim quote: ${BODY_CANARY}` },
  }, { runId: 'run_1' }).id;

  dbm.upsertDraft(db, {
    itemId,
    to: 'marcus@riverstone.example',
    subject: 'Re: Invoice 4471',
    body: 'Marcus — accounting is releasing 4471 today and I will send the remittance.',
  });

  dbm.insertCapture(db, 'Ask the bank about the retainage release date');

  return { db, msgId, itemId };
}

const ALL_ON = Object.freeze({
  board: true, calendar: true, 'mail.metadata': true, 'mail.bodies': true, drafts: true, people: true,
});
const ALL_ON_NO_BODIES = Object.freeze({ ...ALL_ON, 'mail.bodies': false });

function cfg(scopes = ALL_ON, over = {}) {
  return {
    identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: 'America/New_York' },
    ai: { enabled: true, scopes: { ...scopes }, tokens: [], maxRows: 50, ...over },
  };
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

async function call(ctx, name, args = {}, id = 1) {
  return handle(rpc('tools/call', { name, arguments: args }, id), ctx);
}

/** Every tool, with arguments that actually return something for the fixture. */
function everyCall({ itemId, msgId }) {
  return [
    ['zelos_board', {}],
    ['zelos_board', { bucket: 'now', limit: 50 }],
    ['zelos_item', { id: itemId }],
    ['zelos_calendar', { from: '2026-08-01', to: '2026-09-01' }],
    ['zelos_search', { query: 'invoice' }],
    ['zelos_search', { query: 'retainage' }],
    // The canary's own words: FTS matches them inside the body, which is
    // exactly the case where a careless implementation hands the body back.
    // (The query itself is deliberately a fragment — echoing a caller's own
    // words back is not a leak, and the assertion could not tell the two apart.)
    ['zelos_search', { query: 'canary' }],
    ['zelos_search', { query: 'balance account' }],
    ['zelos_thread', { thread: 'thread-invoice' }],
    ['zelos_thread', { messageId: msgId }],
    ['zelos_drafts', {}],
    ['zelos_people', {}],
  ];
}

/* ================================================================== *
 * The closed set of scopes
 * ================================================================== */

describe('scopes', () => {
  test('SCOPES is the closed set from the spec, and SCOPE_INFO describes each one', () => {
    assert.deepEqual([...SCOPES].sort(), ['board', 'calendar', 'drafts', 'mail.bodies', 'mail.metadata', 'people']);
    assert.ok(Object.isFrozen(SCOPES));
    for (const id of SCOPES) {
      const info = SCOPE_INFO[id];
      assert.ok(info, `SCOPE_INFO is missing ${id}`);
      assert.equal(info.id, id);
      assert.ok(info.label && info.label.length > 1, `${id} needs a label`);
      assert.ok(info.summary && info.summary.length > 20, `${id} needs an honest one-liner, got ${info.summary}`);
      assert.ok(Array.isArray(info.tools));
    }
    assert.equal(SCOPE_INFO['mail.bodies'].sensitive, true, 'mail.bodies must be marked as the exposing one');
    assert.deepEqual([...SCOPE_INFO['mail.bodies'].implies], ['mail.metadata']);
  });

  test('every tool belongs to a scope in the set', () => {
    for (const tool of TOOLS) {
      assert.ok(SCOPES.includes(tool.scope), `${tool.name} claims unknown scope ${tool.scope}`);
    }
  });

  test('the shipped defaults are off, with mail closed', () => {
    assert.equal(AI_DEFAULTS.enabled, false, 'AI access must start off');
    assert.equal(AI_DEFAULTS.scopes['mail.metadata'], false);
    assert.equal(AI_DEFAULTS.scopes['mail.bodies'], false, 'mail.bodies must never default on');
    assert.equal(AI_DEFAULTS.scopes.drafts, false);
    assert.equal(AI_DEFAULTS.scopes.people, false);
  });

  test('aiConfig fills in a config that has no ai block at all', () => {
    const ai = aiConfig({ identity: {} });
    assert.equal(ai.enabled, false);
    assert.deepEqual(ai.scopes, { ...AI_DEFAULTS.scopes });
    assert.equal(ai.maxRows, 50);
    assert.deepEqual(ai.tokens, []);
    assert.deepEqual(aiConfig(null).scopes, { ...AI_DEFAULTS.scopes });
  });

  test('aiConfig only counts a literal true, and clamps maxRows', () => {
    const ai = aiConfig({ ai: { enabled: 'yes', scopes: { 'mail.bodies': 'true', board: 1, calendar: true }, maxRows: 99999 } });
    assert.equal(ai.enabled, false, 'anything but true is off');
    assert.equal(ai.scopes['mail.bodies'], false, '"true" the string must not open the most exposing scope');
    assert.equal(ai.scopes.board, false);
    assert.equal(ai.scopes.calendar, true);
    assert.equal(ai.maxRows, 500);
    assert.equal(aiConfig({ ai: { maxRows: -4 } }).maxRows, 1);
  });

  test('a config cannot invent a scope', () => {
    const ai = aiConfig({ ai: { enabled: true, scopes: { 'mail.everything': true, admin: true } } });
    assert.equal(Object.hasOwn(ai.scopes, 'mail.everything'), false);
    assert.deepEqual(toolsFor({ 'mail.everything': true, admin: true }), []);
  });
});

/* ================================================================== *
 * Enforcement point one: tools/list
 * ================================================================== */

describe('toolsFor — a disabled scope has no tools to show', () => {
  const names = (scopes) => toolsFor(scopes).map((t) => t.name).sort();

  test('the master switch alone empties the list', () => {
    assert.deepEqual(toolsFor({ enabled: false, scopes: ALL_ON }), []);
    assert.deepEqual(toolsFor(cfg(ALL_ON, { enabled: false })), []);
    assert.ok(toolsFor(cfg(ALL_ON)).length >= 7);
  });

  test('each scope contributes exactly its own tools', () => {
    assert.deepEqual(names({ board: true }), ['zelos_board', 'zelos_item']);
    assert.deepEqual(names({ calendar: true }), ['zelos_calendar']);
    assert.deepEqual(names({ 'mail.metadata': true }), ['zelos_search', 'zelos_thread']);
    assert.deepEqual(names({ drafts: true }), ['zelos_drafts']);
    assert.deepEqual(names({ people: true }), ['zelos_people']);
    assert.deepEqual(names({}), []);
  });

  test('turning on the calendar turns on nothing else', () => {
    assert.deepEqual(names({ calendar: true }), ['zelos_calendar']);
    assert.equal(names({ calendar: true }).includes('zelos_search'), false);
  });

  test('mail.bodies implies mail.metadata but adds no tool of its own', () => {
    assert.deepEqual(names({ 'mail.bodies': true }), ['zelos_search', 'zelos_thread']);
    assert.deepEqual(names({ 'mail.metadata': true }), names({ 'mail.bodies': true }));
  });

  test('it accepts a list, a map, an ai block or a whole config', () => {
    assert.deepEqual(names(['board']), ['zelos_board', 'zelos_item']);
    assert.deepEqual(names({ board: true }), ['zelos_board', 'zelos_item']);
    assert.deepEqual(names({ enabled: true, scopes: { board: true } }), ['zelos_board', 'zelos_item']);
    assert.deepEqual(names(cfg({ board: true })), ['zelos_board', 'zelos_item']);
    assert.deepEqual(toolsFor(undefined), []);
    assert.deepEqual(toolsFor('board'), []);
  });

  test('the descriptors are MCP-shaped and cannot be mutated back into the registry', () => {
    const first = toolsFor({ board: true })[0];
    assert.equal(typeof first.description, 'string');
    assert.equal(first.inputSchema.type, 'object');
    first.name = 'zelos_send_mail';
    first.inputSchema.properties = {};
    assert.equal(toolsFor({ board: true })[0].name, 'zelos_board', 'the registry handed out a live reference');
    assert.ok(Object.keys(toolsFor({ board: true })[0].inputSchema.properties).length > 0);
  });

  test('tools/list shows only what the scopes allow', async () => {
    const { db } = seeded();
    const listed = async (scopes) => {
      const res = await handle(rpc('tools/list'), { db, config: cfg(scopes) });
      return res.result.tools.map((t) => t.name).sort();
    };
    assert.deepEqual(await listed({ board: true, calendar: true }), ['zelos_board', 'zelos_calendar', 'zelos_item']);
    assert.deepEqual(await listed(ALL_ON_NO_BODIES), [
      'zelos_board', 'zelos_calendar', 'zelos_drafts', 'zelos_item', 'zelos_people', 'zelos_search', 'zelos_thread',
    ]);

    const off = await handle(rpc('tools/list'), { db, config: cfg(ALL_ON, { enabled: false }) });
    assert.deepEqual(off.result.tools, [], 'the master switch off must expose nothing');
  });
});

/* ================================================================== *
 * Enforcement point two: tools/call
 * ================================================================== */

describe('tools/call — a disabled scope is refused even when the name is known', () => {
  test('every tool is refused when its own scope is off', async () => {
    const { db, itemId, msgId } = seeded();
    for (const [name, args] of everyCall({ itemId, msgId })) {
      const scope = TOOLS.find((t) => t.name === name).scope;
      const scopes = { ...ALL_ON, [scope]: false };
      // mail.bodies implies mail.metadata, so closing metadata means closing both.
      if (scope === 'mail.metadata') scopes['mail.bodies'] = false;
      const ctx = { db, config: cfg(scopes) };

      const listed = (await handle(rpc('tools/list'), ctx)).result.tools.map((t) => t.name);
      assert.equal(listed.includes(name), false, `${name} is still advertised with ${scope} off`);

      const res = await call(ctx, name, args);
      assert.equal(res.result, undefined, `${name} answered with ${scope} off`);
      assert.equal(res.error.code, ERROR_CODES.SCOPE_DENIED);
      assert.match(res.error.message, new RegExp(scope.replace('.', '\\.')));
    }
  });

  test('the master switch off refuses every tool by name', async () => {
    const { db, itemId, msgId } = seeded();
    const ctx = { db, config: cfg(ALL_ON, { enabled: false }) };
    for (const [name, args] of everyCall({ itemId, msgId })) {
      const res = await call(ctx, name, args);
      assert.equal(res.error.code, ERROR_CODES.AI_DISABLED, `${name} ran with AI access switched off`);
      assert.match(res.error.message, /switched off/i);
    }
  });

  test('a tool name that does not exist is a clean error, not a crash', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg() }, 'zelos_send_mail', { to: 'x@y.example' });
    assert.equal(res.error.code, ERROR_CODES.INVALID_PARAMS);
    assert.match(res.error.message, /unknown tool/);
  });

  test('refusal does not depend on tools/list having been called first', async () => {
    const { db } = seeded();
    // A fresh context that has never listed anything, calling a remembered name.
    const res = await call({ db, config: cfg({ board: true }) }, 'zelos_thread', { thread: 'thread-invoice' });
    assert.equal(res.error.code, ERROR_CODES.SCOPE_DENIED);
  });

  test('an item hands back nothing from a scope that is off', async () => {
    const { db, itemId } = seeded();
    const boardOnly = await call({ db, config: cfg({ board: true }) }, 'zelos_item', { id: itemId });
    const payload = boardOnly.result.structuredContent;
    assert.equal(payload.found, true);
    assert.deepEqual(payload.sources, [], 'the mail behind an item is mail — it needs the mail scope');
    assert.deepEqual(payload.drafts, [], 'a draft is a draft — it needs the drafts scope');

    const withMail = (await call({ db, config: cfg({ board: true, 'mail.metadata': true, drafts: true }) }, 'zelos_item', { id: itemId }))
      .result.structuredContent;
    assert.equal(withMail.sources.length, 1, 'the one resolvable source should come back');
    assert.equal(withMail.sources[0].kind, 'message');
    assert.equal(withMail.drafts.length, 1);
  });
});

/* ================================================================== *
 * mail.bodies — the one that matters
 * ================================================================== */

describe('mail.bodies', () => {
  test('with it OFF, no serialised response from any tool contains body text', async () => {
    const { db, itemId, msgId } = seeded();
    const ctx = { db, config: cfg(ALL_ON_NO_BODIES) };

    for (const [name, args] of everyCall({ itemId, msgId })) {
      const res = await call(ctx, name, args);
      assert.ok(res.result, `${name} failed: ${JSON.stringify(res.error)}`);
      const wire = JSON.stringify(res);
      assert.equal(wire.includes(BODY_CANARY), false, `${name} leaked the body canary:\n${wire}`);
      assert.equal(wire.includes(BODY_CANARY_2), false, `${name} leaked body text:\n${wire}`);
      assert.equal(wire.includes('verbatim quote'), false, `${name} leaked the raw model payload:\n${wire}`);
    }
  });

  test('the index really does hold the body — so the test above is not looking at nothing', async () => {
    /*
     * This test used to prove non-vacuity by showing that a body-only word STILL
     * matched with mail.bodies off — the body is indexed, the search finds it,
     * and only the text is withheld. That was true, and it was the bug: a hit on
     * a word that exists nowhere but a body answers "is this word in your mail?"
     * for anything the caller can guess. The scope now confines the MATCH to the
     * title column, so bodies are unsearchable, not merely unreadable.
     *
     * Non-vacuity is therefore proved the other way round, which is stronger:
     * the SAME query finds the SAME message once the scope is on. If the index
     * did not hold the body, neither half would work.
     */
    const { db, msgId } = seeded();

    const off = await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_search', { query: 'canary' });
    const offHit = off.result.structuredContent.results
      .find((h) => h.kind === 'message' && h.message.id === msgId);
    assert.equal(offHit, undefined,
      'a word living only in the body must not match while mail.bodies is off');

    const on = await call({ db, config: cfg(ALL_ON) }, 'zelos_search', { query: 'canary' });
    const onHit = on.result.structuredContent.results
      .find((h) => h.kind === 'message' && h.message.id === msgId);
    assert.ok(onHit, 'the body IS indexed: the same query finds it once the scope is on');

    // A message reachable by its SUBJECT still comes back with the scope off,
    // and still hands over no body text and no FTS excerpt.
    const bySubject = await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_search', { query: SUBJECT_WORD });
    const subjHit = bySubject.result.structuredContent.results
      .find((h) => h.kind === 'message' && h.message.id === msgId);
    assert.ok(subjHit, 'metadata search must keep working — the subject is still indexed');
    assert.equal(subjHit.message.snippet, SNIPPET);
    assert.equal(Object.hasOwn(subjHit.message, 'body'), false, 'there must not even be a body key');
    assert.equal(Object.hasOwn(subjHit, 'excerpt'), false, 'the FTS excerpt is cut from the body — it must not go out');
    assert.equal(JSON.stringify(subjHit).includes(BODY_CANARY), false);
  });

  test('with it ON, the same phrase comes back', async () => {
    const { db, msgId } = seeded();
    const ctx = { db, config: cfg(ALL_ON) };
    for (const [name, args] of [
      ['zelos_search', { query: 'canary' }],
      ['zelos_thread', { thread: 'thread-invoice' }],
      ['zelos_thread', { messageId: msgId }],
    ]) {
      const wire = JSON.stringify(await call(ctx, name, args));
      assert.ok(wire.includes(BODY_CANARY), `${name} should return the body when mail.bodies is on`);
    }
  });

  test('mail.bodies on its own opens the mail tools, and carries the body', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg({ 'mail.bodies': true }) };
    const listed = (await handle(rpc('tools/list'), ctx)).result.tools.map((t) => t.name).sort();
    assert.deepEqual(listed, ['zelos_search', 'zelos_thread']);
    const wire = JSON.stringify(await call(ctx, 'zelos_thread', { thread: 'thread-invoice' }));
    assert.ok(wire.includes(BODY_CANARY));
  });

  test('a body longer than the cap is truncated and says so', async () => {
    const db = freshDb();
    dbm.upsertMessage(db, message({ text: `${'x'.repeat(60_000)} ${BODY_CANARY}` }));
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { thread: 'thread-invoice' });
    const msg = res.result.structuredContent.messages[0];
    assert.equal(msg.bodyTruncated, true);
    assert.ok(msg.body.length <= 40_000);
  });

  test('board items never carry the raw model payload', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', {});
    const item = res.result.structuredContent.items[0];
    assert.equal(Object.hasOwn(item, 'payload'), false);
    assert.ok(item.headline && item.why, 'the triage text itself is the point of the board scope');
  });

  test('calendar hands over time and place, not the event description', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_calendar', { from: '2026-08-01', to: '2026-09-01' });
    const ev = res.result.structuredContent.events[0];
    assert.equal(ev.title, 'Pre-con with Alder & Vance');
    assert.equal(ev.location, 'Site trailer');
    assert.equal(ev.attendees[0].email, 'nemo@example.com');
    assert.equal(Object.hasOwn(ev, 'description'), false, 'the scope promises title, time, location and attendees');
  });
});

/* ================================================================== *
 * The row cap
 * ================================================================== */

describe('config.ai.maxRows caps every result set', () => {
  function busy() {
    const db = freshDb();
    for (let i = 0; i < 12; i += 1) {
      dbm.upsertMessage(db, message({
        uid: 2000 + i,
        messageId: `<bulk-${i}@example.com>`,
        from: { name: `Person ${i}`, email: `person${i}@example.com` },
        subject: `Invoice ${i} is past due`,
        date: `2026-08-0${(i % 8) + 1}T09:0${i % 6}:00-04:00`,
      }));
      dbm.upsertItem(db, {
        key: `bulk-${i}`, kind: 'money', bucket: 'today', headline: `Invoice ${i}`, why: 'past due',
      }, { runId: 'run_1' });
      dbm.upsertEvent(db, {
        calendarId: 'c_work', uid: `bulk-${i}`, title: `Standup ${i}`,
        startsAt: `2026-08-1${i % 8}T09:00:00-04:00`, endsAt: `2026-08-1${i % 8}T09:30:00-04:00`,
      });
      dbm.upsertDraft(db, { itemId: `bulk-${i}`, to: `person${i}@example.com`, subject: 'Re', body: 'Sending today.' });
    }
    return db;
  }

  test('no tool returns more rows than the cap, however large the caller asks for', async () => {
    const db = busy();
    const ctx = { db, config: cfg(ALL_ON, { maxRows: 3 }) };
    const counts = {
      zelos_board: (p) => p.items.length,
      zelos_calendar: (p) => p.events.length,
      zelos_search: (p) => p.results.length,
      zelos_thread: (p) => p.messages.length,
      zelos_drafts: (p) => p.drafts.length,
      zelos_people: (p) => p.people.length,
    };
    const args = {
      zelos_board: { limit: 500 },
      zelos_calendar: { from: '2026-08-01', to: '2026-09-01', limit: 500 },
      zelos_search: { query: 'invoice', limit: 500 },
      zelos_thread: { thread: 'thread-invoice', limit: 500 },
      zelos_drafts: { limit: 500 },
      zelos_people: { limit: 500 },
    };
    for (const [name, count] of Object.entries(counts)) {
      const res = await call(ctx, name, args[name]);
      assert.ok(res.result, `${name}: ${JSON.stringify(res.error)}`);
      assert.equal(count(res.result.structuredContent), 3, `${name} returned more than maxRows`);
    }
  });

  test('a smaller limit than the cap is still honoured', async () => {
    const db = busy();
    const res = await call({ db, config: cfg(ALL_ON, { maxRows: 10 }) }, 'zelos_board', { limit: 2 });
    assert.equal(res.result.structuredContent.items.length, 2);
  });

  test('a nonsense limit is a clean invalid-params error', async () => {
    const db = busy();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', { limit: 'lots' });
    assert.equal(res.error.code, ERROR_CODES.INVALID_PARAMS);
  });
});

/* ================================================================== *
 * The audit log
 * ================================================================== */

describe('the access log', () => {
  test('every call leaves a row with the tool, the scope, the count and the time', async () => {
    const { db, itemId } = seeded();
    const ctx = { db, config: cfg(ALL_ON_NO_BODIES), transport: 'stdio', client: 'Claude Desktop' };
    assert.deepEqual(listAccessLog(db), []);

    await call(ctx, 'zelos_board', {});
    await call(ctx, 'zelos_item', { id: itemId });
    await call(ctx, 'zelos_search', { query: 'invoice' });

    const rows = listAccessLog(db);
    assert.equal(rows.length, 3, 'one row per call');
    assert.deepEqual(rows.map((r) => r.tool), ['zelos_search', 'zelos_item', 'zelos_board'], 'newest first');
    const board = rows.find((r) => r.tool === 'zelos_board');
    assert.equal(board.scope, 'board');
    assert.equal(board.rows, 1);
    assert.equal(board.ok, true);
    assert.equal(board.transport, 'stdio');
    assert.equal(board.client, 'Claude Desktop');
    assert.match(board.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('it records what the AI was refused, not only what it read', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg({ board: true }) };
    await call(ctx, 'zelos_thread', { thread: 'thread-invoice' });
    await call(ctx, 'zelos_not_a_tool', {});
    await call({ db, config: cfg(ALL_ON, { enabled: false }) }, 'zelos_board', {});

    const rows = listAccessLog(db);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.ok), [false, false, false]);
    assert.equal(rows.find((r) => r.tool === 'zelos_thread').detail, 'scope is off');
    assert.equal(rows.find((r) => r.tool === 'zelos_not_a_tool').detail, 'no such tool');
    assert.equal(rows.find((r) => r.tool === 'zelos_board').detail, 'AI access is off');
  });

  test('it says when a read included message bodies', async () => {
    const { db } = seeded();
    await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { thread: 'thread-invoice' });
    await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_thread', { thread: 'thread-invoice' });
    const [withoutBodies, withBodies] = listAccessLog(db);
    assert.equal(withBodies.detail, 'message bodies included');
    assert.equal(withoutBodies.detail, null);
  });

  test('the log survives a reopen and holds no message text', async () => {
    const { db, msgId } = seeded();
    await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { messageId: msgId });
    const wire = JSON.stringify(listAccessLog(db));
    assert.equal(wire.includes(BODY_CANARY), false, 'the audit log records that a read happened, not what was read');
    assert.equal(wire.includes(SNIPPET), false);

    recordAccess(db, { tool: 'zelos_board', scope: 'board', rows: 4, transport: 'http', tokenId: 't_x' });
    const top = listAccessLog(db, { limit: 1 })[0];
    assert.equal(top.tokenId, 't_x');
    assert.equal(top.transport, 'http');
    assert.equal(top.rows, 4);
    assert.deepEqual(listAccessLog(db, { tool: 'zelos_board' }).map((r) => r.tool), ['zelos_board']);
  });

  test('a log that cannot be written does not fail the read', async () => {
    const { db, itemId } = seeded();
    const broken = {
      exec() { throw new Error('disk is gone'); },
      prepare() { throw new Error('disk is gone'); },
    };
    assert.equal(recordAccess(broken, { tool: 'zelos_board' }), null);
    assert.deepEqual(listAccessLog(broken), []);
    // And through the real path: a call still answers.
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_item', { id: itemId });
    assert.ok(res.result);
  });
});

/* ================================================================== *
 * JSON-RPC
 * ================================================================== */

describe('JSON-RPC 2.0', () => {
  const ctx = () => ({ db: seeded().db, config: cfg(ALL_ON) });

  test('initialize answers with a protocol version, capabilities and honest instructions', async () => {
    const res = await handle(rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Claude Desktop', version: '1.0' },
    }), ctx());
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, '2024-11-05', 'a supported version the client asked for is echoed');
    assert.equal(res.result.capabilities.tools.listChanged, false);
    assert.equal(res.result.serverInfo.name, 'zelos');
    assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    assert.match(res.result.instructions, /read-only/i);
  });

  test('an unsupported protocol version gets ours back rather than a crash', async () => {
    const res = await handle(rpc('initialize', { protocolVersion: '1999-01-01' }), ctx());
    assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
    assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(PROTOCOL_VERSION));
    const bare = await handle(rpc('initialize'), ctx());
    assert.equal(bare.result.protocolVersion, PROTOCOL_VERSION);
  });

  test('the instructions say plainly what is shared', async () => {
    const off = await handle(rpc('initialize'), { db: null, config: cfg(ALL_ON, { enabled: false }) });
    assert.match(off.result.instructions, /switched OFF/i);
    const noBodies = await handle(rpc('initialize'), { db: null, config: cfg(ALL_ON_NO_BODIES) });
    assert.match(noBodies.result.instructions, /bodies are NOT shared/i);
    const bodies = await handle(rpc('initialize'), { db: null, config: cfg(ALL_ON) });
    assert.match(bodies.result.instructions, /Full message bodies are shared/i);
  });

  test('ping is an empty result', async () => {
    const res = await handle(rpc('ping', undefined, 'abc'), ctx());
    assert.deepEqual(res, { jsonrpc: '2.0', id: 'abc', result: {} });
  });

  test('an unknown method is a -32601 error object, never a throw', async () => {
    for (const method of ['frobnicate', 'resources/list', 'prompts/list', 'tools/write']) {
      const res = await handle(rpc(method), ctx());
      assert.equal(res.error.code, ERROR_CODES.METHOD_NOT_FOUND, method);
      assert.equal(res.result, undefined);
      assert.equal(res.id, 1);
    }
  });

  test('malformed requests get the right JSON-RPC errors', async () => {
    const c = ctx();
    assert.equal((await handle(null, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle('tools/list', c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle(42, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ jsonrpc: '1.0', id: 1, method: 'ping' }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ id: 1, method: 'ping' }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ jsonrpc: '2.0', id: 1 }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ jsonrpc: '2.0', id: {}, method: 'ping' }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
  });

  test('bad tools/call params are invalid-params, not internal errors', async () => {
    const c = ctx();
    assert.equal((await handle(rpc('tools/call', { arguments: {} }), c)).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await handle(rpc('tools/call', 'zelos_board'), c)).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await handle(rpc('tools/call', { name: 'zelos_board', arguments: [] }), c)).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_item', {})).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_search', { query: 123 })).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_board', { bucket: 'urgent!' })).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_calendar', { from: 'next tuesday' })).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_thread', {})).error.code, ERROR_CODES.INVALID_PARAMS);
  });

  test('a notification gets no response at all', async () => {
    const c = ctx();
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, c), null);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, c), null);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'nonsense' }, c), null);
  });

  test('a batch is answered as a batch, and an empty one is an error', async () => {
    const c = ctx();
    const res = await handle([rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', undefined, 2)], c);
    assert.equal(res.length, 2, 'the notification gets no reply');
    assert.deepEqual(res.map((r) => r.id), [1, 2]);
    assert.equal((await handle([], c)).error.code, ERROR_CODES.INVALID_REQUEST);
  });

  test('a missing database is an error object rather than a stack trace', async () => {
    const res = await call({ db: null, config: cfg(ALL_ON) }, 'zelos_board', {});
    assert.equal(res.error.code, ERROR_CODES.NO_DATABASE);
    // tools/list still works: a client can be told what exists before anything is open.
    const listed = await handle(rpc('tools/list'), { db: null, config: cfg(ALL_ON) });
    assert.ok(listed.result.tools.length >= 7);
  });

  test('an internal fault is reported without leaking its message', async () => {
    const exploding = {
      prepare() { throw new Error(`the secret was ${BODY_CANARY}`); },
      exec() { throw new Error(`the secret was ${BODY_CANARY}`); },
    };
    const res = await call({ db: exploding, config: cfg(ALL_ON) }, 'zelos_board', {});
    assert.equal(res.error.code, ERROR_CODES.INTERNAL_ERROR);
    assert.equal(JSON.stringify(res).includes(BODY_CANARY), false);
  });

  test('config may be a function, so a scope turned off takes effect on the next call', async () => {
    const { db } = seeded();
    const scopes = { ...ALL_ON };
    const ctxLive = { db, config: () => cfg(scopes) };
    assert.ok((await call(ctxLive, 'zelos_thread', { thread: 'thread-invoice' })).result);
    scopes['mail.metadata'] = false;
    scopes['mail.bodies'] = false;
    const after_ = await call(ctxLive, 'zelos_thread', { thread: 'thread-invoice' });
    assert.equal(after_.error.code, ERROR_CODES.SCOPE_DENIED, 'revoking a scope must bite immediately');
  });

  test('handle never throws, whatever it is handed', async () => {
    const c = ctx();
    const junk = [
      undefined, true, [], [[]], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: {}, arguments: 5 } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zelos_search', arguments: { query: 'x'.repeat(5_000) } } },
      { jsonrpc: '2.0', id: null, method: 'ping' },
    ];
    for (const request of junk) {
      const res = await handle(request, c);
      assert.ok(res === null || (typeof res === 'object'), `handle threw or returned junk for ${JSON.stringify(request)}`);
    }
  });
});

/* ================================================================== *
 * Read-only, structurally
 * ================================================================== */

describe('nothing here writes', () => {
  const WRITE_HELPERS = [
    'upsertMessage', 'upsertMessages', 'upsertEvent', 'upsertEvents', 'upsertItem', 'setItemState',
    'upsertDraft', 'updateDraft', 'insertCapture', 'markCaptureProcessed', 'startRun', 'finishRun',
    'setKV', 'deleteKV', 'indexDoc', 'removeDoc', 'reindex', 'withTransaction',
  ];

  test('core/mcp.mjs never names a db helper that can change a row', () => {
    const found = WRITE_HELPERS.filter((name) => new RegExp(`\\b${name}\\b`).test(MCP_SOURCE));
    assert.deepEqual(found, [], `core/mcp.mjs reaches for a write helper: ${found.join(', ')}`);
  });

  test('the only table it writes to is its own audit log', () => {
    const targets = [...MCP_SOURCE.matchAll(/\b(insert\s+into|update|delete\s+from)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((m) => m[2].toLowerCase());
    assert.ok(targets.length > 0, 'the scan found nothing — it must be broken');
    assert.deepEqual([...new Set(targets)], ['ai_access_log']);
  });

  test('no tool is write-shaped, and every one is annotated read-only', () => {
    const forbidden = /^(send|delete|remove|write|create|update|set|move|archive|reply|forward|mark|sync|fetch|run)$/i;
    for (const tool of TOOLS) {
      for (const word of tool.name.split('_')) {
        assert.equal(forbidden.test(word), false, `${tool.name} reads like it changes something`);
      }
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} is not annotated read-only`);
      assert.equal(tool.annotations.destructiveHint, false);
    }
    assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
      'zelos_board', 'zelos_calendar', 'zelos_drafts', 'zelos_item', 'zelos_people', 'zelos_search', 'zelos_thread',
    ], 'the tool set changed — was a write added?');
  });

  test('it opens no socket of its own', () => {
    for (const re of [/\bfetch\s*\(/, /node:http\b/, /node:net\b/, /node:tls\b/, /\.connect\s*\(/]) {
      assert.equal(re.test(MCP_SOURCE), false, `core/mcp.mjs looks like it talks to the network: ${re}`);
    }
  });

  test('running every tool leaves the data exactly as it was', async () => {
    const { db, itemId, msgId } = seeded();
    const snapshot = () => ({
      messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
      events: db.prepare('SELECT * FROM events ORDER BY id').all(),
      items: db.prepare('SELECT * FROM items ORDER BY id').all(),
      drafts: db.prepare('SELECT * FROM drafts ORDER BY id').all(),
      captures: db.prepare('SELECT * FROM captures ORDER BY id').all(),
      kv: db.prepare('SELECT * FROM kv ORDER BY k').all(),
      search: db.prepare('SELECT ref, kind FROM search ORDER BY ref').all(),
    });
    const before = JSON.stringify(snapshot());
    const ctx = { db, config: cfg(ALL_ON) };
    for (const [name, args] of everyCall({ itemId, msgId })) await call(ctx, name, args);
    assert.equal(JSON.stringify(snapshot()), before, 'a read changed something');
  });
});

/* ================================================================== *
 * stdio transport
 * ================================================================== */

describe('the stdio transport', () => {
  function rig({ config = cfg(ALL_ON), db = seeded().db } = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => { text += chunk.toString('utf8'); });
    const server = createStdioServer({ db, config, input, output });
    return {
      db,
      input,
      server,
      async run(lines) {
        server.start();
        for (const line of lines) input.write(line);
        input.end();
        const summary = await server.done;
        return { summary, lines: text.trim() ? text.trim().split('\n') : [] };
      },
    };
  }

  test('newline-delimited JSON-RPC in, newline-delimited JSON-RPC out, in order', async () => {
    const r = rig();
    const { lines, summary } = await r.run([
      `${JSON.stringify(rpc('initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'Claude Desktop' } }, 1))}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      `${JSON.stringify(rpc('tools/list', undefined, 2))}\n`,
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_board', arguments: {} }, 3))}\n`,
    ]);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((p) => p.id), [1, 2, 3], 'the notification got no reply, and order is preserved');
    for (const p of parsed) assert.equal(p.jsonrpc, '2.0');
    assert.equal(parsed[2].result.structuredContent.items.length, 1);
    assert.equal(summary.client, 'Claude Desktop');
    assert.equal(summary.handled, 4);
  });

  test('the client name from initialize lands in the access log', async () => {
    const r = rig();
    await r.run([
      `${JSON.stringify(rpc('initialize', { clientInfo: { name: 'Some Other AI' } }, 1))}\n`,
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_board', arguments: {} }, 2))}\n`,
    ]);
    assert.equal(listAccessLog(r.db)[0].client, 'Some Other AI');
  });

  test('a line that is not JSON is a parse error, and the stream keeps going', async () => {
    const r = rig();
    const { lines } = await r.run([
      'this is not json\n',
      '\n',
      `${JSON.stringify(rpc('ping', undefined, 7))}\n`,
    ]);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].error.code, ERROR_CODES.PARSE_ERROR);
    assert.equal(parsed[0].id, null);
    assert.deepEqual(parsed[1], { jsonrpc: '2.0', id: 7, result: {} });
  });

  test('a message split across chunks — including mid-character — survives', async () => {
    const r = rig();
    const request = JSON.stringify(rpc('tools/call', { name: 'zelos_search', arguments: { query: 'café ☕' } }, 5));
    const bytes = Buffer.from(`${request}\n`, 'utf8');
    // Cut inside the multibyte é: a string-concatenating reader corrupts here.
    const eAcute = bytes.indexOf(Buffer.from('é', 'utf8'));
    assert.ok(eAcute > 0);
    const { lines } = await r.run([
      bytes.subarray(0, eAcute + 1),
      bytes.subarray(eAcute + 1, bytes.length - 10),
      bytes.subarray(bytes.length - 10),
    ]);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.id, 5);
    assert.equal(parsed.result.structuredContent.query, 'café ☕', 'the query came back mangled');
  });

  test('a final message with no trailing newline is still answered', async () => {
    const r = rig();
    const { lines } = await r.run([JSON.stringify(rpc('ping', undefined, 9))]);
    assert.equal(JSON.parse(lines[0]).id, 9);
  });

  test('every byte written to stdout is a JSON-RPC message', async () => {
    const r = rig({ db: null });
    const { lines } = await r.run([
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_board', arguments: {} }, 1))}\n`,
      `${JSON.stringify(rpc('ping', undefined, 2))}\n`,
    ]);
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws if anything else reached stdout
      assert.equal(parsed.jsonrpc, '2.0');
    }
  });

  test('with the master switch off it runs, and refuses everything', async () => {
    const r = rig({ config: cfg(ALL_ON, { enabled: false }) });
    const { lines } = await r.run([
      `${JSON.stringify(rpc('initialize', {}, 1))}\n`,
      `${JSON.stringify(rpc('tools/list', undefined, 2))}\n`,
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_search', arguments: { query: 'invoice' } }, 3))}\n`,
    ]);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(parsed[0].result.instructions.includes('OFF'));
    assert.deepEqual(parsed[1].result.tools, []);
    assert.equal(parsed[2].error.code, ERROR_CODES.AI_DISABLED);
  });

  test('serveStdio runs until stdin closes', async () => {
    const { db } = seeded();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => { text += c.toString('utf8'); });

    const running = serveStdio({ db, config: cfg(ALL_ON), input, output });
    input.write(`${JSON.stringify(rpc('ping', undefined, 1))}\n`);
    input.write(`${JSON.stringify(rpc('tools/call', { name: 'zelos_people', arguments: {} }, 2))}\n`);
    input.end();

    const summary = await running;
    assert.equal(summary.handled, 2);
    const parsed = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((p) => p.id), [1, 2]);
    assert.equal(parsed[1].result.structuredContent.people[0].email, 'marcus@riverstone.example');
  });

  test('none of this ran against the real Zelos home', () => {
    assert.ok(fs.realpathSync(HOME_ROOT).startsWith(fs.realpathSync(os.tmpdir())), 'the suite must live in a temp dir');
    assert.ok(process.env.ZELOS_HOME.startsWith(HOME_ROOT), 'ZELOS_HOME escaped the temp dir');
    assert.notEqual(path.resolve(process.env.ZELOS_HOME), path.join(os.homedir(), '.zelos'));
  });
});

/* ================================================================== *
 * The data itself
 * ================================================================== */

describe('what the tools return', () => {
  test('the board carries what the scope promises', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', {});
    const item = res.result.structuredContent.items[0];
    assert.equal(item.bucket, 'now');
    assert.equal(item.headline, 'Chase invoice 4471 — 21 days past due');
    assert.equal(item.person, 'Marcus Reyes');
    assert.equal(item.personEmail, 'marcus@riverstone.example');
    assert.equal(item.dueAt, '2026-08-12T17:00:00-04:00');
    assert.equal(item.severity, 3);
    assert.equal(item.state, 'open');
    assert.ok(item.sourceRefs.includes(`msg:${db.prepare('SELECT id FROM messages ORDER BY uid LIMIT 1').get().id}`));
  });

  test('a bucket filter and a state filter both work', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg(ALL_ON) };
    assert.equal((await call(ctx, 'zelos_board', { bucket: 'now' })).result.structuredContent.items.length, 1);
    assert.equal((await call(ctx, 'zelos_board', { bucket: 'today' })).result.structuredContent.items.length, 0);
    assert.equal((await call(ctx, 'zelos_board', { state: 'done' })).result.structuredContent.items.length, 0);
  });

  test('an item that does not exist says so instead of erroring', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_item', { id: 'nope' });
    assert.equal(res.result.structuredContent.found, false);
    assert.equal(res.result.structuredContent.item, null);
    assert.equal(listAccessLog(db)[0].rows, 0);
  });

  test('a thread comes back oldest first, with both directions', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_thread', { thread: 'thread-invoice' });
    const messages = res.result.structuredContent.messages;
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((m) => m.direction), ['in', 'out']);
    assert.equal(messages[0].from.email, 'marcus@riverstone.example');
    assert.equal(messages[0].subject, 'Invoice 4471 is past due');
    assert.equal(messages[0].date, '2026-08-05T09:12:00-04:00');
    assert.equal(messages[0].hasAttachments, true);
  });

  test('an unknown thread is empty rather than an error', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { thread: 'no-such-thread' });
    assert.equal(res.result.structuredContent.found, false);
    assert.deepEqual(res.result.structuredContent.messages, []);
  });

  test('search restricts kinds to the scopes that are on', async () => {
    const { db } = seeded();
    const mailOnly = await call({ db, config: cfg({ 'mail.metadata': true }) }, 'zelos_search', { query: 'retainage' });
    assert.deepEqual(mailOnly.result.structuredContent.kinds, ['message']);
    for (const hit of mailOnly.result.structuredContent.results) assert.equal(hit.kind, 'message');

    const asked = await call({ db, config: cfg(ALL_ON) }, 'zelos_search', { query: 'retainage', kinds: ['capture'] });
    assert.deepEqual(asked.result.structuredContent.kinds, ['capture']);
    assert.equal(asked.result.structuredContent.results[0].capture.text, 'Ask the bank about the retainage release date');

    // Asking for a kind whose scope is off yields nothing, not an error.
    const denied = await call({ db, config: cfg({ 'mail.metadata': true }) }, 'zelos_search', { query: 'retainage', kinds: ['item'] });
    assert.deepEqual(denied.result.structuredContent.results, []);
  });

  test('people counts both directions and leaves the owner out', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_people', {});
    const people = res.result.structuredContent.people;
    assert.deepEqual(people.map((p) => p.email), ['marcus@riverstone.example']);
    assert.equal(people[0].name, 'Marcus Reyes');
    assert.equal(people[0].messages, 2);
    assert.equal(people[0].received, 1);
    assert.equal(people[0].sent, 1);
    assert.equal(people[0].lastAt, '2026-08-06T08:00:00-04:00');
  });

  test('drafts come back with their text and their state, and nothing that sends them', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_drafts', {});
    const draft = res.result.structuredContent.drafts[0];
    assert.equal(draft.to, 'marcus@riverstone.example');
    assert.equal(draft.state, 'pending');
    assert.match(draft.body, /accounting is releasing 4471/);
    assert.equal((await call({ db, config: cfg(ALL_ON) }, 'zelos_drafts', { state: 'used' })).result.structuredContent.drafts.length, 0);
  });

  test('the calendar window defaults to the next two weeks and filters by instant', async () => {
    const db = freshDb();
    dbm.upsertEvent(db, { calendarId: 'c', uid: 'past', title: 'Long gone', startsAt: '2020-01-01T09:00:00-05:00', endsAt: '2020-01-01T10:00:00-05:00' });
    dbm.upsertEvent(db, { calendarId: 'c', uid: 'soon', title: 'In the window', startsAt: '2026-08-11T14:00:00-04:00', endsAt: '2026-08-11T15:00:00-04:00' });
    const ctx = { db, config: cfg(ALL_ON) };

    const window = (await call(ctx, 'zelos_calendar', { from: '2026-08-10T00:00:00-04:00', to: '2026-08-12T00:00:00-04:00' })).result.structuredContent;
    assert.deepEqual(window.events.map((e) => e.title), ['In the window']);

    const wide = (await call(ctx, 'zelos_calendar', { from: '2019-01-01', to: '2027-01-01' })).result.structuredContent;
    assert.equal(wide.events.length, 2);

    const defaulted = (await call(ctx, 'zelos_calendar', {})).result.structuredContent;
    assert.match(defaulted.from, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Date.parse(defaulted.to) - Date.parse(defaulted.from) > 13 * 86_400_000);
    assert.equal(defaulted.events.some((e) => e.title === 'Long gone'), false);
  });

  test('the text result and the structured result are the same thing', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', {});
    assert.equal(res.result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(res.result.content[0].text), res.result.structuredContent);
  });
});
