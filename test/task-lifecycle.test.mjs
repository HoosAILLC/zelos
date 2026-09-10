import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-task-lifecycle-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_LOG_LEVEL = 'silent';
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
const dbm = await import('../core/db.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const { DEFAULTS } = await import('../core/config.mjs');
const { sourceStateKey } = await import('../core/connectors/index.mjs');
const originalFetch = globalThis.fetch;
const databases = [];
test.after(() => { globalThis.fetch = originalFetch; for (const db of databases) dbm.close(db); fs.rmSync(home, { recursive: true, force: true }); });

function setup(type) {
  const db = dbm.open(':memory:'); dbm.migrate(db); databases.push(db);
  const config = { ...structuredClone(DEFAULTS), mail: [], calendars: [], sources: [{ id: type, type, enabled: true, keyRef: `${type}.key`, settings: {} }] };
  let response;
  let prompt = '';
  let calls = 0;
  const task = (id = 'one') => ({ id, content: `Obligation ${id}`, title: `Obligation ${id}`, identifier: `ENG-${id}`, due: { date: new Date().toISOString().slice(0, 10) }, dueDate: new Date().toISOString().slice(0, 10), state: { name: 'Todo', type: 'unstarted' } });
  const page = (rows, next = null) => type === 'todoist'
    ? { results: rows, next_cursor: next }
    : { data: { viewer: { name: 'Test', email: 'test@example.com', assignedIssues: { nodes: rows, pageInfo: { hasNextPage: !!next, endCursor: next } } } } };
  const setResponse = (value) => { response = value; };
  const sweep = async (mode = 'auto') => {
    dbm.setKV(db, sourceStateKey(type), null);
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).host, type === 'todoist' ? 'api.todoist.com' : 'api.linear.app');
      const data = typeof response === 'function' ? response(++requests, url, init) : response;
      if (data instanceof Error) throw data;
      return new Response(JSON.stringify(data), { status: 200 });
    };
    return runSweep({ db, config, mode, deps: { getSecret: async () => 'synthetic-secret', complete: async (request) => {
      calls++; prompt = request.messages.map(m => m.content).join('\n');
      return { text: '{"first":null,"items":[],"notes":[]}', usage: { input: 1, output: 1 } };
    } } });
  };
  return { db, config, task, page, setResponse, sweep, prompt: () => prompt, calls: () => calls };
}

for (const type of ['todoist', 'linear']) {
  test(`${type}: complete absence retires active evidence, preserves history, and reopening restores it`, async () => {
    const h = setup(type);
    h.setResponse(h.page([h.task()])); await h.sweep();
    const message = dbm.listMessages(h.db)[0];
    const item = dbm.upsertItem(h.db, { key: `${type}-one`, bucket: 'now', headline: 'Obligation one', sourceRefs: [`msg:${message.id}`] });
    dbm.indexDoc(h.db, { ref: `item:${item.id}`, kind: 'item', title: 'Obligation one' });
    const draft = dbm.upsertDraft(h.db, { itemId: item.id, body: 'Follow up on obligation one' });
    assert.ok(h.prompt().includes('Obligation one'));
    h.setResponse(h.page([]));
    const gone = await h.sweep();
    assert.equal(gone.stats.kind, 'full', 'retiring source evidence needs reassessment');
    assert.equal(dbm.listMessages(h.db).length, 0);
    const history = dbm.getMessage(h.db, message.id);
    assert.equal(history.task_activity, 'inactive');
    assert.equal(history.task_inactive_reason, 'not_in_current_selection');
    assert.match(history.subject, /Obligation one$/);
    assert.ok(!h.prompt().includes('Obligation one'), 'neither message nor prior board item supplies stale open wording');
    assert.equal(dbm.listBoard(h.db).length, 0);
    assert.equal(dbm.bucketCounts(h.db).now, 0);
    assert.equal(dbm.listDrafts(h.db).length, 0);
    assert.equal(dbm.getDraft(h.db, draft.id).body, 'Follow up on obligation one');
    assert.equal(dbm.getItem(h.db, item.id).state, 'open', 'source selection does not rewrite the user decision');
    assert.equal(dbm.getItem(h.db, item.id).sourceInactive, true);
    assert.equal(dbm.search(h.db, 'Obligation').length, 0);
    const hits = dbm.search(h.db, 'Obligation', { includeInactive: true });
    assert.ok(hits.some(hit => hit.ref === `msg:${message.id}` && hit.sourceInactive));
    assert.ok(hits.some(hit => hit.ref === `item:${item.id}` && hit.sourceInactive));
    dbm.reindex(h.db);
    assert.equal(dbm.search(h.db, 'Obligation').length, 0, 'rebuilding search cannot restore stale active evidence');
    h.setResponse(h.page([h.task()]));
    const reopened = await h.sweep();
    assert.equal(reopened.stats.kind, 'full');
    assert.equal(dbm.listMessages(h.db)[0].id, message.id);
    assert.equal(dbm.getMessage(h.db, message.id).task_activity, 'active');
    assert.equal(dbm.listBoard(h.db)[0].id, item.id);
    assert.equal(dbm.listDrafts(h.db)[0].id, draft.id);
    assert.ok(h.prompt().includes('Obligation one'));
  });

  test(`${type}: partial, capped, malformed and failed reads never retire unseen tasks`, async () => {
    const h = setup(type);
    h.setResponse(h.page([h.task('one'), h.task('two')])); await h.sweep();
    const original = dbm.listMessages(h.db).map(m => m.id).sort();
    const scenarios = [
      () => new Error('offline'),
      n => n === 1 ? h.page([h.task()], 'next') : new Error('later page failed'),
      () => h.page([h.task()], 'repeating-cursor'),
      () => h.page([h.task(), {}]),
      () => h.page([h.task(), { id: {} }]),
      () => ({ ...h.page([h.task()]), errors: [{ message: 'Some tasks could not be read' }] }),
      () => type === 'todoist' ? { results: [h.task()] } : { data: { viewer: { assignedIssues: { nodes: [h.task()], pageInfo: {} } } } },
    ];
    for (const response of scenarios) {
      h.setResponse(response); await h.sweep('full');
      assert.deepEqual(dbm.listMessages(h.db).map(m => m.id).sort(), original);
    }
    h.config.sources[0].settings.maxItems = 1;
    h.setResponse(h.page([h.task('one'), h.task('two')])); await h.sweep('full');
    assert.deepEqual(dbm.listMessages(h.db).map(m => m.id).sort(), original);
  });

  test(`${type}: a new filter replaces the old selection only after a complete read`, async () => {
    const h = setup(type);
    h.setResponse(h.page([h.task()])); await h.sweep();
    const original = dbm.listMessages(h.db)[0];
    h.config.sources[0].settings = type === 'todoist' ? { filter: '#Other project' } : { horizonDays: 0 };
    h.setResponse(n => n === 1 ? h.page([h.task('two')], 'next') : new Error('partial replacement'));
    await h.sweep();
    assert.equal(dbm.getMessage(h.db, original.id).task_activity, 'active');
    h.setResponse(h.page([h.task('two')])); await h.sweep();
    assert.equal(dbm.getMessage(h.db, original.id).task_activity, 'inactive');
    assert.equal(dbm.getMessage(h.db, original.id).task_inactive_reason, 'not_in_current_selection');
    assert.equal(dbm.listMessages(h.db).length, 1);
    assert.match(dbm.listMessages(h.db)[0].subject, /Obligation two$/);
  });

  test(`${type}: mixed-source obligations and user decisions survive inactivity and reopening`, async () => {
    const h = setup(type);
    h.setResponse(h.page([h.task()])); await h.sweep();
    const message = dbm.listMessages(h.db)[0];
    const mail = dbm.upsertMessage(h.db, { sourceId: 'mail', messageId: 'real-mail', subject: 'Another reason to do this', text: 'Please follow up', date: new Date().toISOString() });
    const mixed = dbm.upsertItem(h.db, { key: 'mixed', bucket: 'today', headline: 'Still owed from mail', sourceRefs: [`msg:${message.id}`, `msg:${mail.id}`] });
    const done = dbm.upsertItem(h.db, { key: 'done', bucket: 'today', headline: 'User already finished', sourceRefs: [`msg:${message.id}`] });
    dbm.setItemState(h.db, done.id, 'done');
    h.setResponse(h.page([])); await h.sweep();
    assert.equal(dbm.getItem(h.db, mixed.id).sourceInactive, false);
    assert.ok(dbm.listBoard(h.db).some(row => row.id === mixed.id));
    h.setResponse(h.page([h.task()])); await h.sweep();
    assert.equal(dbm.getItem(h.db, done.id).state, 'done');
  });

  test(`${type}: the first complete read after upgrading retires legacy task evidence without deleting it`, async () => {
    const h = setup(type);
    const legacy = dbm.upsertMessage(h.db, { sourceId: type, messageId: `${type === 'todoist' ? 'todoist:task:' : 'linear:issue:'}legacy`, subject: 'Legacy obligation', date: new Date().toISOString(), text: 'Previously due today' });
    h.db.exec('DROP TABLE task_activity; PRAGMA user_version = 2');
    assert.deepEqual(dbm.migrate(h.db), { version: 3, applied: 1 });
    assert.equal(dbm.getMessage(h.db, legacy.id).task_activity, null);
    assert.equal(dbm.listMessages(h.db).length, 1, 'migration alone does not infer activity');
    h.setResponse(new Error('first read failed')); await h.sweep();
    assert.equal(dbm.listMessages(h.db).length, 1);
    h.setResponse(h.page([])); await h.sweep();
    assert.equal(dbm.listMessages(h.db).length, 0);
    assert.equal(dbm.getMessage(h.db, legacy.id).body, 'Previously due today');
    assert.equal(dbm.getMessage(h.db, legacy.id).task_activity, 'inactive');
    h.db.prepare('DELETE FROM messages WHERE id = ?').run(legacy.id);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM task_activity').get().n, 0, 'forgetting source data also forgets its activity metadata');
  });

  test(`${type}: an explicitly light refresh preserves membership changes for automatic reassessment`, async () => {
    const h = setup(type);
    h.setResponse(h.page([h.task()])); await h.sweep();
    h.setResponse(h.page([]));
    const light = await h.sweep('light');
    assert.equal(light.stats.kind, 'light');
    assert.equal(light.stats.taskActivityChanges, 1);
    const next = await h.sweep();
    assert.equal(next.stats.kind, 'full');
    assert.equal(next.stats.taskActivityChanges, 0);
    assert.equal(h.calls(), 2);
  });
}
