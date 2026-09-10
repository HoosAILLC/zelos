import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Every database below is fictional. Set the home and secret backend before
// importing the registry/sweep, so no default can reach the operator's data.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-imessage-integration-'));
process.env.ZELOS_HOME = path.join(root, 'home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';

const { open, close, migrate, listMessages, messagesInThread, search } = await import('../core/db.mjs');
const { DEFAULTS } = await import('../core/config.mjs');
const { get: connectorFor } = await import('../core/connectors/index.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const { buildSweepPrompt } = await import('../core/triage.mjs');

test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
let sequence = 0;
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const appleTime = ms => BigInt(Math.floor((ms - APPLE_EPOCH_MS) / 1000)) * 1_000_000_000n;

function fixture(t) {
  const directory = path.join(root, `case-${sequence++}`);
  fs.mkdirSync(directory);
  const databasePath = path.join(directory, 'fictional-chat.db');
  const sourceDb = new DatabaseSync(databasePath);
  sourceDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER,
      handle_id INTEGER, text TEXT, service TEXT, is_read INTEGER,
      cache_has_attachments INTEGER DEFAULT 0
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550101001'), (2, 'kit@example.com');
    INSERT INTO chat VALUES (1, 'iMessage;+;fictional-group', 'Fictional planning group'),
      (2, 'SMS;-;+15550101001', '');
    INSERT INTO chat_handle_join VALUES (1, 1), (1, 2), (2, 1);
  `);
  const now = Date.now();
  const insert = sourceDb.prepare(`INSERT INTO message
    (ROWID, guid, date, is_from_me, handle_id, text, service, is_read)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(1, 'group-incoming-guid', appleTime(now - 3_600_000), 0, 1,
    'Could you bring the project drawings?', 'iMessage', 0);
  insert.run(2, 'group-outgoing-guid', appleTime(now - 3_000_000), 1, 0,
    'I will bring the project drawings tomorrow.', 'iMessage', 1);
  insert.run(3, 'direct-incoming-guid', appleTime(now - 2_400_000), 0, 1,
    'Oldwordquartz is the current delivery password.', 'SMS', 0);
  sourceDb.exec('INSERT INTO chat_message_join VALUES (1, 1), (1, 2), (2, 3)');

  const db = open(path.join(directory, 'archive.db'));
  migrate(db);
  t.after(() => { close(db); sourceDb.close(); });
  // The production connector is Mac-only; only the OS answer is replaced.
  // The registered collect function and its read-only SQLite path remain real.
  t.mock.method(os, 'platform', () => 'darwin');
  let externalCalls = 0;
  const forbidden = async () => { externalCalls++; throw new Error('External access is forbidden in this test'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  t.after(() => assert.equal(externalCalls, 0, 'the local light import reached a network, secret or model dependency'));

  const source = id => ({
    id, type: 'imessage', label: `Fictional Messages ${id}`, enabled: true, keyRef: null,
    settings: { databasePath, lookbackDays: 14, maxMessages: 400 },
  });
  const config = {
    ...structuredClone(DEFAULTS),
    identity: { name: '', email: '', timezone: 'UTC' },
    mail: [], calendars: [], sources: [source('messages-one')],
    sweep: { ...DEFAULTS.sweep, auto: false },
  };
  const sweep = () => runSweep({ db, config, mode: 'light', deps: {
    getSecret: forbidden, fetchMail: forbidden, fetchEvents: forbidden, complete: forbidden,
  } });
  const prompt = (privacy = config.privacy) => buildSweepPrompt({
    identity: config.identity, now: new Date().toISOString(), privacy,
    // Match the ordinary prompt's DB path, including its recent-date filter.
    messages: listMessages(db, { sinceISO: new Date(Date.now() - 21 * 86_400_000).toISOString(), limit: 1200 }),
  });
  return { sourceDb, db, databasePath, source, config, sweep, prompt };
}

function assertLight(result, count) {
  assert.equal(result.ok, true, JSON.stringify(result.stats.sources));
  assert.equal(result.stats.sourcesFailed, 0, JSON.stringify(result.stats.sources));
  assert.equal(result.stats.kind, 'light');
  assert.equal(result.modelCalls, 0);
  assert.equal(result.stats.tokensIn, 0);
  assert.equal(result.stats.tokensOut, 0);
  assert.equal(result.stats.messages, count);
}

test('real Messages import preserves direction and isolates group threads across sources with no identity email', async t => {
  const f = fixture(t);
  assert.equal(connectorFor('imessage')?.sink, 'messages', 'the source must be registered in the production sweep');
  f.config.sources.push(f.source('messages-two'));
  // Keeping the writer open leaves committed fixture messages in WAL. A
  // reader must see them without rewriting/checkpointing the source database.
  const beforeDb = fs.readFileSync(f.databasePath);
  const beforeWal = fs.readFileSync(`${f.databasePath}-wal`);
  const result = await f.sweep();
  assertLight(result, 6);
  assert.equal(result.stats.newMessages, 6);
  assert.deepEqual(fs.readFileSync(f.databasePath), beforeDb);
  assert.deepEqual(fs.readFileSync(`${f.databasePath}-wal`), beforeWal);

  const rows = listMessages(f.db);
  assert.equal(new Set(rows.map(row => row.id)).size, 6, 'the same GUID in different sources must not overwrite another source');
  const groupThreads = [];
  for (const id of ['messages-one', 'messages-two']) {
    const ownRows = rows.filter(row => row.source_id === id);
    assert.equal(ownRows.length, 3);
    const inbound = ownRows.find(row => row.message_id === 'imessage:group-incoming-guid');
    const outbound = ownRows.find(row => row.message_id === 'imessage:group-outgoing-guid');
    const direct = ownRows.find(row => row.message_id === 'imessage:direct-incoming-guid');
    assert.equal(inbound.direction, 'in');
    assert.equal(outbound.direction, 'out', 'Apple is_from_me must work without an email or outgoing handle');
    assert.equal(direct.direction, 'in');
    assert.equal(inbound.thread_key, outbound.thread_key);
    assert.notEqual(inbound.thread_key, direct.thread_key, 'the same phone contact in a direct chat and group is not one thread');
    assert.equal(messagesInThread(f.db, inbound.thread_key).length, 2, 'normal thread lookup must stay inside this source and chat');
    assert.ok(outbound.to.some(person => person.email === 'kit@example.com'), 'group recipients must survive the ordinary address storage');
    groupThreads.push(inbound.thread_key);
  }
  assert.notEqual(groupThreads[0], groupThreads[1], 'triage indexes bare thread keys across all sources');
  const built = f.prompt();
  assert.equal(built.budget.available.inbound, 4);
  assert.equal(built.budget.available.sent, 2);
  assert.equal(built.budget.available.captures, 0, 'imported texts are not instructions typed into Zelos');
  assert.match(built.messages[0].content, /SENT BY USER/);
  assert.match(built.messages[0].content, /I will bring the project drawings tomorrow/);
  assert.match(built.messages[0].content, /<<<ZELOS-UNTRUSTED [0-9a-f]{24} label="inbound mail">>>/);
  assert.match(built.messages[0].content, /<<<ZELOS-UNTRUSTED [0-9a-f]{24} label="mail sent by the user">>>/);
});

test('reimport is idempotent and an edited text replaces its cached search document without changing identity', async t => {
  const f = fixture(t);
  assertLight(await f.sweep(), 3);
  const before = listMessages(f.db).find(row => row.message_id === 'imessage:direct-incoming-guid');
  const repeated = await f.sweep();
  assertLight(repeated, 3);
  assert.equal(repeated.stats.newMessages, 0);
  assert.equal(repeated.stats.changedMessages, 0);
  assert.equal(listMessages(f.db).length, 3);

  f.sourceDb.prepare('UPDATE message SET text = ?, is_read = 1 WHERE guid = ?')
    .run('Newwordtopaz is the revised delivery password.', 'direct-incoming-guid');
  const revised = await f.sweep();
  assertLight(revised, 3);
  assert.equal(revised.stats.newMessages, 0);
  assert.equal(revised.stats.changedMessages, 1);
  const after = listMessages(f.db).find(row => row.message_id === before.message_id);
  assert.equal(after.id, before.id);
  assert.match(after.body, /Newwordtopaz/);
  assert.equal(search(f.db, 'Oldwordquartz').length, 0);
  assert.equal(search(f.db, 'Newwordtopaz').length, 1);
  assert.match(f.prompt().messages[0].content, /Newwordtopaz/);
  assert.doesNotMatch(f.prompt().messages[0].content, /Oldwordquartz/);
});

test('imported text obeys ordinary body privacy while retaining the complete local archive', async t => {
  const f = fixture(t);
  const bodyOnly = 'FICTIONAL_BODY_ONLY_DETAIL';
  const body = `Ordinary visible snippet. ${'More neutral context. '.repeat(25)} ${bodyOnly}`;
  f.sourceDb.prepare('UPDATE message SET text = ? WHERE guid = ?').run(body, 'direct-incoming-guid');
  assertLight(await f.sweep(), 3);
  const row = listMessages(f.db).find(message => message.message_id === 'imessage:direct-incoming-guid');
  assert.ok(row.body.includes(bodyOnly), 'privacy limits model context, not the archive');
  assert.ok(!row.snippet.includes(bodyOnly), 'the test marker must be outside the ordinary snippet');
  assert.match(f.prompt({ ...f.config.privacy, sendBodies: true }).messages[0].content, /FICTIONAL_BODY_ONLY_DETAIL/);
  const privatePrompt = f.prompt({ ...f.config.privacy, sendBodies: false });
  assert.doesNotMatch(privatePrompt.messages[0].content, /FICTIONAL_BODY_ONLY_DETAIL/);
  assert.match(privatePrompt.messages[0].content, /Ordinary visible snippet/);
  assert.equal(privatePrompt.budget.sendBodies, false);
  assert.equal(privatePrompt.budget.bodyChars, 0);
});

test('one extra readable message beyond the configured cap is reported as a partial source', async t => {
  const f = fixture(t);
  f.config.sources[0].settings.maxMessages = 2;
  const result = await f.sweep();
  assert.equal(result.ok, true, 'a partial local import can still store its readable messages');
  assert.equal(result.stats.messages, 2);
  assert.equal(result.stats.newMessages, 2);
  assert.equal(result.stats.sourcesFailed, 1, 'the final candidate was omitted, so the source must not claim a complete read');
  assert.match(result.stats.sources[0].error, /newest 2|limit|Messages to read/i);
  assert.equal(result.modelCalls, 0);
  assert.equal(listMessages(f.db).length, 2);
});
