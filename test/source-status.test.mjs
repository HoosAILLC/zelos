import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-source-status-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_LOG_LEVEL = 'silent';
const { open, close, migrate, getKV, setKV } = await import('../core/db.mjs');
const { recordSourceResults, readSourceStatus } = await import('../core/source-status.mjs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const FIRST = '2026-09-09T10:00:00.000Z';
const SECOND = '2026-09-09T11:00:00.000Z';
const THIRD = '2026-09-09T12:00:00.000Z';
const CONFIG = { mail: [{ id: 'mail_1', label: 'Work mail', host: 'mail.example.test' }] };
function fresh(t, file = ':memory:') {
  const db = open(file);
  migrate(db);
  t.after(() => { try { close(db); } catch {} });
  return db;
}

test('source health survives reopen and a partial folder failure preserves the last full success', (t) => {
  const file = path.join(home, 'health.db');
  const db = fresh(t, file);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: true }], FIRST);
  recordSourceResults(db, [
    { id: 'mail_1', kind: 'mail', label: 'Inbox', ok: true },
    { id: 'mail_1', kind: 'mail', label: 'Sent', ok: false, error: 'Sent folder timed out' },
  ], SECOND);
  close(db);
  const reopened = fresh(t, file);
  const [status] = readSourceStatus(reopened, CONFIG);
  assert.equal(status.ok, false);
  assert.equal(status.lastAttemptAt, SECOND);
  assert.equal(status.lastSuccessAt, FIRST);
  assert.equal(status.error, 'Sent folder timed out');
  recordSourceResults(reopened, [{ id: 'mail_1', kind: 'mail', ok: true }], THIRD);
  const [recovered] = readSourceStatus(reopened, CONFIG);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.lastSuccessAt, THIRD);
  assert.equal(recovered.error, null);
});

test('a skipped source cannot advance timestamps or make a failure successful', (t) => {
  const db = fresh(t);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: false, error: 'Sign in again' }], FIRST);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', attempted: false, ok: true, retryAt: THIRD }], SECOND);
  const [status] = readSourceStatus(db, CONFIG, { now: SECOND });
  assert.equal(status.ok, false);
  assert.equal(status.lastAttemptAt, FIRST);
  assert.equal(status.lastSuccessAt, null);
  assert.equal(status.retryAt, THIRD);
  recordSourceResults(db, [], THIRD);
  assert.equal(readSourceStatus(db, CONFIG)[0].lastAttemptAt, FIRST);
});

test('unread and disabled sources are explicit, and old lastOkAt is not treated as success', (t) => {
  const db = fresh(t);
  setKV(db, 'source.mail_1.state', JSON.stringify({ lastOkAt: Date.parse(FIRST), notBefore: Date.parse(THIRD) }));
  const config = { ...CONFIG, calendars: [{ id: 'off', enabled: false, url: 'https://example.test/private-token' }], sources: [{ id: 'unknown', type: 'future-connector' }] };
  const before = db.prepare('SELECT k, v FROM kv ORDER BY k').all();
  const rows = readSourceStatus(db, config, { now: SECOND });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.ok === null && row.lastSuccessAt === null && row.lastAttemptAt === null));
  assert.equal(rows[0].retryAt, THIRD);
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[1].configKey, 'calendars');
  assert.equal(rows[2].kind, 'future-connector');
  assert.deepEqual(db.prepare('SELECT k, v FROM kv ORDER BY k').all(), before, 'the API reader must not write');
  assert.ok(!JSON.stringify(rows).includes('private-token'));
});

test('stored health and API rows whitelist fields and redact credential-shaped errors', (t) => {
  const db = fresh(t);
  const secret = 'sk-live-this-key-must-never-escape';
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: false, error: `Rejected ${secret}`, password: secret, rows: [{ body: 'PRIVATE BODY' }], cursor: 'PRIVATE CURSOR' }], FIRST);
  const saved = JSON.parse(getKV(db, 'source.health.mail_1'));
  assert.deepEqual(Object.keys(saved).sort(), ['error', 'id', 'kind', 'lastAttemptAt', 'lastSuccessAt', 'ok', 'retryAt'].sort());
  const wire = JSON.stringify(readSourceStatus(db, { mail: [{ ...CONFIG.mail[0], password: secret, keyRef: 'hidden.ref' }] }));
  for (const forbidden of [secret, 'PRIVATE BODY', 'PRIVATE CURSOR', 'hidden.ref']) assert.ok(!wire.includes(forbidden));
  assert.match(wire, /redacted/);
});

test('generic sources resolve their configured type for family, label, and retry pacing', (t) => {
  const db = fresh(t);
  const sources = [{ id: 'tasks', type: 'todoist' }, { id: 'issues', type: 'linear' }];
  for (const source of sources) setKV(db, `source.${source.id}.state`, JSON.stringify({ lastAt: Date.parse(FIRST) }));
  const rows = readSourceStatus(db, { sources }, { now: FIRST });
  assert.deepEqual(rows.map((row) => row.kind), ['todoist', 'linear']);
  assert.deepEqual(rows.map((row) => row.label), ['Todoist', 'Linear']);
  assert.ok(rows.every((row) => row.configKey === 'sources' && Date.parse(row.retryAt) > Date.parse(FIRST)));
});

test('older runs cannot replace newer failures but can supply an earlier successful fetch', (t) => {
  const db = fresh(t);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: false, error: 'Latest failure' }], SECOND);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: true }], FIRST);
  const [status] = readSourceStatus(db, CONFIG);
  assert.equal(status.lastAttemptAt, SECOND);
  assert.equal(status.lastSuccessAt, FIRST);
  assert.equal(status.ok, false);
  assert.equal(status.error, 'Latest failure');
});

test('partial notes cannot claim success and expired or disabled retry times are not offered', (t) => {
  const db = fresh(t);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: true, note: 'Only the first page was read', retryAt: THIRD }], FIRST);
  assert.equal(readSourceStatus(db, CONFIG, { now: SECOND })[0].ok, false);
  assert.equal(readSourceStatus(db, CONFIG, { now: SECOND })[0].lastSuccessAt, null);
  assert.equal(readSourceStatus(db, CONFIG, { now: THIRD })[0].retryAt, null);
  assert.equal(readSourceStatus(db, { mail: [{ ...CONFIG.mail[0], enabled: false }] }, { now: SECOND })[0].retryAt, null);
});

test('known auth pauses stay visible without claiming a new fetch', (t) => {
  const db = fresh(t);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: true }], FIRST);
  recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: false, attempted: false, error: 'Sign in again', retryAt: THIRD }], SECOND);
  const [status] = readSourceStatus(db, CONFIG, { now: SECOND });
  assert.equal(status.ok, false);
  assert.equal(status.error, 'Sign in again');
  assert.equal(status.lastAttemptAt, FIRST);
  assert.equal(status.lastSuccessAt, FIRST);
});

test('a skipped part prevents aggregate success and status write failures do not fail a sweep', (t) => {
  const db = fresh(t);
  recordSourceResults(db, [
    { id: 'mail_1', kind: 'mail', ok: true },
    { id: 'mail_1', kind: 'mail', ok: true, attempted: false },
  ], FIRST);
  assert.equal(readSourceStatus(db, CONFIG)[0].ok, false);
  assert.equal(readSourceStatus(db, CONFIG)[0].lastSuccessAt, null);
  close(db);
  assert.equal(recordSourceResults(db, [{ id: 'mail_1', kind: 'mail', ok: true }], SECOND), 0);
});
