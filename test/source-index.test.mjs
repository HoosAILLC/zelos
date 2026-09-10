import test from 'node:test';
import assert from 'node:assert/strict';
import * as dbm from '../core/db.mjs';

function fresh(t) {
  const db = dbm.open(':memory:'); dbm.migrate(db);
  t.after(() => dbm.close(db));
  return db;
}
function indexed(db, ref) { return db.prepare('SELECT title, body FROM search WHERE ref = ?').all(ref); }
const NOW = '2026-09-11T10:00:00Z';

test('bulk message indexing keeps one final document per identity and retains richer cached bodies', (t) => {
  const db = fresh(t);
  const row = { sourceId: 'mail', messageId: 'one', subject: 'First title', text: 'Original body', date: NOW };
  const first = dbm.upsertMessages(db, [row, { ...row, subject: 'Final title', text: 'Current body' }]);
  assert.equal(first.inserted, 1);
  assert.equal(first.updated, 1);
  const ref = `msg:${first.ids[0]}`;
  assert.equal(indexed(db, ref).length, 1);
  assert.match(indexed(db, ref)[0].title, /Final title/);
  assert.match(indexed(db, ref)[0].body, /Current body/);
  dbm.upsertMessages(db, [{ ...row, subject: 'Header refresh', text: '', snippet: '' }]);
  assert.equal(indexed(db, ref).length, 1);
  assert.match(indexed(db, ref)[0].body, /Current body/);
  assert.equal(dbm.search(db, 'Current').length, 1);
  assert.equal(dbm.search(db, 'Original').length, 0);
});

test('bulk message inserts replace orphaned duplicate search references instead of appending', (t) => {
  const db = fresh(t);
  const row = { sourceId: 'mail', messageId: 'orphan', subject: 'Current subject', text: 'Current body', date: NOW };
  const id = dbm.messageRowId('mail', null, 'orphan');
  const ref = `msg:${id}`;
  // An interrupted older importer or an externally edited cache can have an
  // index document without a source row. The optimized path must repair it.
  for (let n = 0; n < 2; n++) db.prepare('INSERT INTO search (title, body, ref, kind) VALUES (?,?,?,?)').run('Stale orphan', 'Outdated', ref, 'message');
  const saved = dbm.upsertMessages(db, [row]);
  assert.equal(saved.ids[0], id);
  assert.equal(indexed(db, ref).length, 1);
  assert.match(indexed(db, ref)[0].body, /Current body/);
  assert.equal(dbm.search(db, 'Outdated').length, 0);
});

test('bulk calendar indexing replaces repeats and orphaned refs, and safely reindexes reappearing events', (t) => {
  const db = fresh(t);
  const row = { calendarId: 'calendar', uid: 'one', title: 'Old event', description: 'Old details', startsAt: '2026-09-11T14:00:00Z', endsAt: '2026-09-11T15:00:00Z' };
  const id = dbm.eventRowId('calendar', 'one', '');
  const ref = `evt:${id}`;
  dbm.indexDoc(db, { ref, kind: 'event', title: 'Orphaned event' });
  dbm.upsertEvents(db, [row, { ...row, title: 'Current event', description: 'Current details' }]);
  assert.deepEqual(indexed(db, ref).map((entry) => entry.title), ['Current event']);
  assert.equal(dbm.search(db, 'Orphaned').length, 0);
  dbm.reconcileEvents(db, { calendarId: 'calendar', events: [], from: '2026-09-11T00:00:00Z', to: '2026-09-12T00:00:00Z', timezone: 'UTC' });
  assert.equal(indexed(db, ref).length, 0);
  dbm.upsertEvents(db, [{ ...row, title: 'Restored event' }]);
  assert.deepEqual(indexed(db, ref).map((entry) => entry.title), ['Restored event']);
});

test('a failed bulk source write rolls back both source rows and newly appended index documents', (t) => {
  const db = fresh(t);
  db.exec("CREATE TRIGGER reject_bad_message BEFORE INSERT ON messages WHEN NEW.subject = 'Reject me' BEGIN SELECT RAISE(ABORT, 'controlled failure'); END");
  assert.throws(() => dbm.upsertMessages(db, [
    { sourceId: 'mail', messageId: 'one', subject: 'Allowed' },
    { sourceId: 'mail', messageId: 'two', subject: 'Reject me' },
  ]), /controlled failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search').get().n, 0);
});
