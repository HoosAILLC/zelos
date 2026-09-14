import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import imessage, { attributedText, messageDate, resolveDatabasePath } from '../core/connectors/imessage.mjs';

const NOW = '2026-09-10T20:00:00.000Z';
const EPOCH = Date.UTC(2001, 0, 1);
const appleDate = (iso, nanos = true) => BigInt(Date.parse(iso) - EPOCH) * (nanos ? 1_000_000n : 1n) / (nanos ? 1n : 1000n);
const signature = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t, { minimal = false, wal = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-imessage-fixture-'));
  const file = path.join(dir, 'chat.db');
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER,
      handle_id INTEGER, text TEXT ${minimal ? '' : ', attributedBody BLOB, service TEXT, is_read INTEGER, associated_message_type INTEGER, item_type INTEGER, group_action_type INTEGER, is_system_message INTEGER, is_deleted INTEGER, date_retracted INTEGER, destination_caller_id TEXT, cache_has_attachments INTEGER'});
    CREATE INDEX message_date ON message(date);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE INDEX chat_message_lookup ON chat_message_join(message_id);
    CREATE INDEX chat_handle_lookup ON chat_handle_join(chat_id);
    INSERT INTO handle VALUES (1, '+15550101001'), (2, 'kit@example.test'), (3, '+15550101003');
    INSERT INTO chat VALUES (1, 'iMessage;+;fictional-group', 'Site planning'), (2, 'SMS;-;+15550101003', '');
    INSERT INTO chat_handle_join VALUES (1,1), (1,2), (2,3);
  `);
  let id = 0;
  const insert = (patch = {}, chatId = 1) => {
    const row = { guid: `fictional-${++id}`, date: appleDate('2026-09-10T19:00:00.000Z'), is_from_me: 0, handle_id: 1, text: 'Can you send the revised plan?', ...(minimal ? {} : { service: 'iMessage', is_read: 0, associated_message_type: 0, item_type: 0 }), ...patch };
    const keys = Object.keys(row);
    const result = db.prepare(`INSERT INTO message (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    if (chatId !== null) db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(chatId, result.lastInsertRowid);
    return result.lastInsertRowid;
  };
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  t.mock.method(os, 'platform', () => 'darwin');
  const ctx = (settings = {}, extra = {}) => ({
    source: { id: 'fictional-phone', settings: { databasePath: file, ...settings } },
    label: 'Fictional phone', now: NOW, identityEmail: '',
    http: () => { throw new Error('Messages must never use a network transport'); },
    log: new Proxy({}, { get() { return () => { throw new Error('No private content logging'); }; } }),
    ...extra,
  });
  return { dir, file, db, insert, ctx };
}

test('Messages manifest is local, read-only, credential-free, and bounded', () => {
  assert.equal(imessage.type, 'imessage');
  assert.equal(imessage.option, 'iPhone texts (Messages on this Mac)');
  assert.equal(imessage.configKey, 'sources');
  assert.equal(imessage.sink, 'messages');
  assert.equal(imessage.credential, null);
  assert.deepEqual(imessage.origins, []);
  assert.equal(imessage.limits.maxRows, 2000);
  assert.deepEqual(imessage.fields.map((field) => [field.name, field.default]), [
    ['databasePath', '~/Library/Messages/chat.db'], ['lookbackDays', 14], ['maxMessages', 400],
  ]);
  for (const method of ['send', 'delete', 'markRead', 'archive']) assert.equal(imessage[method], undefined);
});

test('the default database path expands without reading a real home', (t) => {
  t.mock.method(os, 'homedir', () => path.resolve('/fictional-home'));
  assert.equal(resolveDatabasePath(), path.join(os.homedir(), 'Library', 'Messages', 'chat.db'));
  assert.equal(resolveDatabasePath({ databasePath: '~/example/chat.db' }), path.join(os.homedir(), 'example', 'chat.db'));
});

test('Messages dates accept seconds and nanoseconds without integer overflow or local-time drift', () => {
  for (const nano of [true, false]) assert.equal(messageDate(appleDate(NOW, nano).toString()), NOW);
  assert.equal(messageDate(appleDate('2026-09-10T20:00:00.123Z').toString()), '2026-09-10T20:00:00.123Z');
  for (const value of [null, undefined, '', 'not a date', -1, 0, '999999999999999999999999999999']) assert.equal(messageDate(value), null);
});

test('incoming, outgoing and group rows preserve identity, direction and actual read state', async (t) => {
  const f = fixture(t);
  f.insert({ guid: 'incoming', is_read: 1 });
  f.insert({ guid: 'outgoing', is_from_me: 1, handle_id: 0, text: 'I will send it tomorrow.', destination_caller_id: 'me@example.test' });
  f.insert({ guid: 'sms', service: 'SMS', handle_id: 3, text: 'Meet at the gate.' }, 2);
  const { parts, cursor } = await imessage.collect(f.ctx());
  const rows = parts[0].rows;
  assert.equal(rows.length, 3);
  assert.equal(cursor, undefined);
  const received = rows.find((r) => r.messageId === 'imessage:incoming');
  const sent = rows.find((r) => r.messageId === 'imessage:outgoing');
  assert.equal(received.direction, 'in');
  assert.deepEqual(received.from, { name: '+15550101001', email: '' });
  assert.deepEqual(received.flags, ['\\Seen']);
  assert.deepEqual(sent.flags, []);
  assert.equal(sent.direction, 'out');
  assert.deepEqual(sent.from, { name: 'Me', email: 'me@example.test' });
  assert.deepEqual(sent.to, [{ name: '+15550101001', email: '' }, { name: 'kit@example.test', email: 'kit@example.test' }]);
  assert.equal(sent.threadKey, received.threadKey);
  assert.notEqual(rows.find((r) => r.messageId === 'imessage:sms').threadKey, received.threadKey);
  assert.match(received.folder, /iPhone texts.*Site planning/);
  assert.equal(received.subject, 'Can you send the revised plan?');
  for (const row of rows) { assert.equal(Object.hasOwn(row, 'id'), false); assert.equal(Object.hasOwn(row, 'uid'), false); }
  assert.deepEqual((await imessage.collect(f.ctx())).parts[0].rows, rows);
  const other = await imessage.collect({ ...f.ctx(), source: { ...f.ctx().source, id: 'other-phone' } });
  assert.notEqual(other.parts[0].rows[0].threadKey, rows[0].threadKey);
});

test('WAL-only messages are visible and the source database, WAL and message state stay unchanged', async (t) => {
  const f = fixture(t, { wal: true });
  f.insert({ guid: 'wal-only', is_read: 0 });
  const stateQuery = f.db.prepare('SELECT * FROM message');
  stateQuery.setReadBigInts(true);
  const before = { db: signature(f.file), wal: signature(`${f.file}-wal`), state: stateQuery.get() };
  const result = await imessage.collect(f.ctx());
  assert.equal(result.parts[0].rows[0].messageId, 'imessage:wal-only');
  assert.equal(signature(f.file), before.db);
  assert.equal(signature(`${f.file}-wal`), before.wal);
  assert.deepEqual(stateQuery.get(), before.state);
  // -shm is SQLite's live coordination area and may change during a SELECT.
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['chat.db', 'chat.db-shm', 'chat.db-wal']);
});

test('a read-only ordinary database gains no files and no changed bytes', async (t) => {
  const f = fixture(t, { minimal: true });
  f.insert();
  const before = signature(f.file);
  assert.equal((await imessage.collect(f.ctx())).parts[0].rows.length, 1);
  assert.equal(signature(f.file), before);
  assert.deepEqual(fs.readdirSync(f.dir), ['chat.db']);
});

test('only the bounded recent window is imported, newest first, across mixed timestamp units', async (t) => {
  const f = fixture(t);
  f.insert({ guid: 'too-old', date: appleDate('2026-08-27T19:59:59.999Z') });
  f.insert({ guid: 'edge', date: appleDate('2026-08-27T20:00:00.000Z') });
  f.insert({ guid: 'now-seconds', date: appleDate(NOW, false) });
  f.insert({ guid: 'future', date: appleDate('2026-09-10T20:00:00.001Z') });
  const all = (await imessage.collect(f.ctx())).parts[0].rows;
  assert.deepEqual(all.map((r) => r.messageId), ['imessage:now-seconds', 'imessage:edge']);
  const limited = (await imessage.collect(f.ctx({ maxMessages: 1 }))).parts[0];
  assert.deepEqual(limited.rows.map((r) => r.messageId), ['imessage:now-seconds']);
  assert.match(limited.note, /newest 1/);
});

test('reactions, system/service entries, attachments-only and messages removed from chats are skipped', async (t) => {
  const f = fixture(t);
  f.insert({ guid: 'keep', cache_has_attachments: 1, text: '\uFFFCBring the sketch.' });
  for (const patch of [
    { associated_message_type: 2001 }, { associated_message_type: 3001 }, { associated_message_type: 1000 },
    { associated_message_type: 4000 }, { item_type: 1 }, { group_action_type: 1 }, { is_system_message: 1 },
    { is_deleted: 1 }, { date_retracted: 123 }, { service: 'FaceTime' },
    { text: '\uFFFC', cache_has_attachments: 1 }, { text: null, cache_has_attachments: 1 },
    { text: null, attributedBody: attributed('\uFFFC'), cache_has_attachments: 1 },
  ]) f.insert(patch);
  f.insert({ guid: 'recoverable-only' }, null);
  const result = await imessage.collect(f.ctx());
  assert.deepEqual(result.parts[0].rows.map((row) => row.messageId), ['imessage:keep']);
  assert.equal(result.parts[0].rows[0].text, 'Bring the sketch.');
  assert.equal(result.parts[0].rows[0].hasAttachments, true);
  assert.equal(result.parts[0].note, null, 'supported attachment-only messages are skipped without a false failure');
});

function attributed(text) {
  const content = Buffer.from(text);
  const size = content.length < 128 ? Buffer.from([content.length]) : Buffer.from([0x81, content.length & 255, content.length >> 8]);
  return Buffer.concat([Buffer.from([4, 11]), Buffer.from('streamtyped'), Buffer.from([0x81, 0xe8, 3]), Buffer.from('NSAttributedString'), Buffer.from([0x84]), Buffer.from('NSString'), Buffer.from([1, 43]), size, content, Buffer.from([0x86, 0x84]), Buffer.from('NSDictionary metadata not message text')]);
}

test('fictional archives generated by native Foundation decode without assuming our test encoder', () => {
  // Generated on macOS with NSArchiver.archivedData(withRootObject:
  // NSAttributedString(string: ...)). No real Messages database was involved.
  const samples = [
    ['Fictional meeting at 4 — bring the plan. 👋', 'BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBKy9GaWN0aW9uYWwgbWVldGluZyBhdCA0IOKAlCBicmluZyB0aGUgcGxhbi4g8J+Ri4aEAmlJASuShISEDE5TRGljdGlvbmFyeQCUhAFpAIaG'],
    ['x'.repeat(128), 'BAtzdHJlYW10eXBlZIHoA4QBQISEhBJOU0F0dHJpYnV0ZWRTdHJpbmcAhIQITlNPYmplY3QAhZKEhIQITlNTdHJpbmcBlIQBK4GAAHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4hoQCaUkBgYAAkoSEhAxOU0RpY3Rpb25hcnkAlIQBaQCGhg=='],
  ];
  for (const [text, base64] of samples) assert.equal(attributedText(Buffer.from(base64, 'base64')), text);
});

test('bounded attributedBody fallback extracts only its length-delimited UTF-8 text', async (t) => {
  const f = fixture(t);
  for (const text of ['Thanks — see you at 4! 👋', 'Long fictional text. '.repeat(20)]) {
    assert.equal(attributedText(attributed(text)), text.trim());
    f.insert({ text: null, attributedBody: attributed(text) });
  }
  const corrupt = attributed('Example');
  corrupt[corrupt.indexOf(Buffer.from([1, 43])) + 2] = 127;
  for (const body of [corrupt, Buffer.from('bplist00 fake object archive'), Buffer.alloc(128001, 42), Buffer.from('NSString\u0001+ordinary text')]) {
    assert.equal(attributedText(body), null);
    f.insert({ text: null, attributedBody: body });
  }
  const result = await imessage.collect(f.ctx());
  assert.equal(result.parts[0].rows.length, 2);
  assert.ok(result.parts[0].rows.every((row) => !row.text.includes('NSDictionary')));
  assert.match(result.parts[0].note, /4 message bodies/);
});

test('the row and body ceilings hold without advancing a cursor', async (t) => {
  const f = fixture(t);
  f.db.exec('BEGIN');
  for (let i = 0; i < 2200; i++) f.insert({ text: `Fictional message ${i}`, date: appleDate(NOW) - BigInt(i) * 1_000_000n });
  f.db.exec('COMMIT');
  const result = await imessage.collect(f.ctx({ maxMessages: 2000 }));
  assert.equal(result.parts[0].rows.length, 2000);
  assert.match(result.parts[0].note, /newest 2000/);
  assert.equal(result.cursor, undefined);
  f.insert({ text: 'x'.repeat(50000), date: appleDate(NOW) });
  assert.equal((await imessage.collect(f.ctx({ maxMessages: 1 }))).parts[0].rows[0].text.length, 20000);
});

test('permission, missing, wrong-layout and non-Mac errors are actionable and never leak database contents', async (t) => {
  const f = fixture(t);
  f.insert();
  await t.test('Full Disk Access', async (t) => {
    t.mock.method(fs, 'lstatSync', () => { const error = new Error('private path and content'); error.code = 'EPERM'; throw error; });
    await assert.rejects(imessage.collect(f.ctx()), /Full Disk Access.*enable Zelos/);
    const check = await imessage.check(f.ctx().source);
    assert.equal(check.status, 'fail');
    assert.match(check.action, /installed Zelos app/);
    assert.ok(!check.detail.includes('private path and content'));
  });
  await assert.rejects(imessage.collect(f.ctx({ databasePath: path.join(f.dir, 'absent.db') })), /No Messages database.*same Apple Account/);
  assert.ok(!fs.existsSync(path.join(f.dir, 'absent.db')));
  const wrong = path.join(f.dir, 'wrong.db');
  const other = new DatabaseSync(wrong); other.exec('CREATE TABLE message (secret TEXT)'); other.close();
  await assert.rejects(imessage.collect(f.ctx({ databasePath: wrong })), /layout/);
  await t.test('not a Mac', async (t) => {
    t.mock.method(os, 'platform', () => 'win32');
    await assert.rejects(imessage.collect(f.ctx()), /only.*Mac/);
  });
});

test('special files and symbolic links are refused before opening SQLite', async (t) => {
  const f = fixture(t);
  await assert.rejects(imessage.collect(f.ctx({ databasePath: f.dir })), /regular files/);
  // Windows CI may not permit symlinks, so the directory case still runs there.
  if (process.platform !== 'win32') {
    const link = path.join(f.dir, 'alias.db'); fs.symlinkSync(f.file, link);
    await assert.rejects(imessage.collect(f.ctx({ databasePath: link })), /not links/);
  }
});

test('cancellation before opening and during a bounded import closes the reader without partial results', async (t) => {
  const f = fixture(t);
  f.db.exec('BEGIN');
  for (let i = 0; i < 300; i++) f.insert();
  f.db.exec('COMMIT');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(imessage.collect(f.ctx({}, { signal: controller.signal })), /cancelled/);
  const running = new AbortController();
  setImmediate(() => running.abort());
  await assert.rejects(imessage.collect(f.ctx({}, { signal: running.signal })), /cancelled/);
  assert.equal((await imessage.collect(f.ctx())).parts[0].rows.length, 300);
});

test('invalid limits are rejected before reading, and check has no credential or network requirement', async (t) => {
  const f = fixture(t);
  f.insert();
  for (const settings of [{ maxMessages: 2001 }, { maxMessages: 0 }, { lookbackDays: 366 }, { lookbackDays: 1.5 }]) {
    await assert.rejects(imessage.collect(f.ctx(settings)), /whole number/);
  }
  const checked = await imessage.check(f.ctx().source, { now: NOW });
  assert.equal(checked.status, 'pass');
  assert.match(checked.detail, /No messages were changed/);
});
