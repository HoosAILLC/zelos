import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-sweep-refresh-'));
process.env.ZELOS_HOME = root;
process.env.ZELOS_LOG_LEVEL = 'silent';
const { open, close, migrate, listMessages } = await import('../core/db.mjs');
const { runSweep, shouldRunFull } = await import('../core/sweep.mjs');
const { DEFAULTS } = await import('../core/config.mjs');
const databases = [];
test.after(() => { for (const db of databases) close(db); fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const db = open(':memory:'); migrate(db); databases.push(db);
  const config = { ...structuredClone(DEFAULTS), mail: [{
    id: 'mail', enabled: true, host: 'example.invalid', user: 'me@example.com',
    mailboxes: ['INBOX'], sentMailbox: '', keyRef: 'mail.password',
  }], calendars: [{ id: 'calendar', kind: 'file', url: '/unused.ics', enabled: true }] };
  const data = {
    messages: [{ uid: 1, messageId: 'deadline', subject: 'Deadline', date: new Date(Date.now() - 3600000).toISOString(), text: 'The deadline is Friday.', snippet: 'The deadline is Friday.' }],
    events: [], calls: 0,
  };
  const sweep = (mode = 'auto') => runSweep({ db, config, mode, deps: {
    getSecret: async () => 'test-secret',
    fetchMail: async () => data.messages,
    fetchEvents: async () => data.events,
    complete: async () => { data.calls++; return { text: JSON.stringify({ first: null, items: [], notes: [] }), usage: { input: 1, output: 1 } }; },
  } });
  return { db, config, data, sweep };
}

test('changed existing message content triggers immediate automatic classification', async () => {
  const { data, sweep } = setup();
  await sweep();
  data.messages[0] = { ...data.messages[0], text: 'The deadline moved to this afternoon.' };
  const result = await sweep();
  assert.equal(result.stats.newMessages, 0);
  assert.equal(result.stats.changedMessages, 1);
  assert.equal(result.stats.kind, 'full');
  assert.equal(data.calls, 2);
});

test('unchanged rereads, read-time dates and preserved bodies do not buy model calls', async () => {
  const { db, data, sweep } = setup();
  await sweep();
  data.messages[0] = { ...data.messages[0], date: new Date().toISOString(), text: '', snippet: '' };
  const result = await sweep();
  assert.equal(result.stats.changedMessages, 0);
  assert.equal(result.stats.kind, 'light');
  assert.equal(data.calls, 1);
  assert.equal(listMessages(db)[0].body, 'The deadline is Friday.');
});

test('moved and removed appointments are new information even without new row identities', async () => {
  const { data, sweep } = setup();
  const start = Date.now() + 86400000;
  data.events = [{ uid: 'meeting', title: 'Meeting', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600000).toISOString() }];
  await sweep();
  data.events[0] = { ...data.events[0], startsAt: new Date(start + 3600000).toISOString(), endsAt: new Date(start + 7200000).toISOString() };
  const moved = await sweep();
  assert.equal(moved.stats.newEvents, 0);
  assert.equal(moved.stats.changedEvents, 1);
  assert.equal(moved.stats.kind, 'full');
  data.events = [];
  const removed = await sweep();
  assert.equal(removed.stats.removedEvents, 1);
  assert.equal(removed.stats.kind, 'full');
  assert.equal(data.calls, 3);
});

test('an explicitly light run retains changed-source work for the next automatic run', async () => {
  const { db, config, data, sweep } = setup();
  await sweep();
  data.messages[0] = { ...data.messages[0], subject: 'Urgent revised deadline' };
  const light = await sweep('light');
  assert.equal(light.stats.kind, 'light');
  assert.equal(data.calls, 1);
  assert.equal(shouldRunFull(db, config), true);
  await sweep();
  assert.equal(data.calls, 2);
});

test('the same message read through two folders is counted once by its final content', async () => {
  const { config, data, sweep } = setup();
  config.mail[0].sentMailbox = 'Sent';
  const first = await sweep();
  assert.equal(first.stats.newMessages, 1);
  assert.equal(first.stats.changedMessages, 0, 'an inserted message is not also an update');
  const second = await sweep();
  assert.equal(second.stats.changedMessages, 0, 'intermediate folder/direction changes cancel out');
  assert.equal(second.stats.kind, 'light');
  data.messages[0] = { ...data.messages[0], subject: 'Revised deadline' };
  const changed = await sweep();
  assert.equal(changed.stats.changedMessages, 1);
  assert.equal(changed.stats.kind, 'full');
  assert.equal(data.calls, 2);
});

test('a later source write failure does not lose a message revision awaiting classification', async () => {
  const { db, config, data, sweep } = setup();
  const start = Date.now() + 86400000;
  data.events = [{ uid: 'meeting', title: 'Meeting', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600000).toISOString() }];
  await sweep();
  data.messages[0] = { ...data.messages[0], text: 'The deadline is this afternoon.' };
  db.exec("CREATE TRIGGER fail_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'controlled event write failure'); END");
  const failed = await sweep();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /controlled event write failure/);
  assert.equal(listMessages(db)[0].body, 'The deadline is this afternoon.', 'the message write succeeded before the event write failed');
  assert.equal(shouldRunFull(db, config), true, 'the persisted revision still needs classification');
  db.exec('DROP TRIGGER fail_event_update');
  const retried = await sweep();
  assert.equal(retried.stats.changedMessages, 0, 'the retry rereads the already stored revision');
  assert.equal(retried.stats.kind, 'full');
  assert.equal(data.calls, 2);
});
