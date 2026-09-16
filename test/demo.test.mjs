/** UI integration gaps for the current generated website preview.
 *
 * The former website/demo transport was retired. Completion, undo, reset,
 * meal/finance interactions, Ask streaming and read-only Family access are
 * exercised in website-preview.test.mjs. This file keeps the additional public
 * API/view contracts against the actual build output. Real connection edits,
 * secret storage, simulated arrivals, scheduler wakeups and cursor-paged history
 * belonged to the retired transport; they are not claimed by this browser demo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDom, text, findButton } from './helpers/ui-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'website'))) {
  test('public website preview is available', { skip: 'Website preview is excluded from this npm deployment.' }, () => {});
} else {
  const { buildWebsite, previewSource } = await import('../scripts/build-website.mjs');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-demo-build-test-'));
  buildWebsite({ root, out: output });
  test.after(() => fs.rmSync(output, { recursive: true, force: true }));

  async function adapter(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-demo-ui-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Each UI import graph has independent browser-memory data. Images are not
    // fetched by the small DOM fixture; copy the generated code, not media.
    const generated = path.join(output, 'try');
    fs.cpSync(generated, dir, { recursive: true, filter: source => source !== path.join(generated, 'assets') });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const realTimer = setTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, _ms, ...args) => realTimer(fn, 0, ...args));
    t.mock.method(globalThis, 'fetch', () => { throw new Error('The preview must never contact a server'); });
    const importUi = file => import(pathToFileURL(path.join(dir, file)).href);
    return { ...await importUi('lib/api.js'), importUi };
  }

  test('generated preview exposes the current app API and uses canonical history and settings views', async t => {
    installDom(t);
    const { api } = await adapter(t);
    const real = await import('../ui/lib/api.js');
    assert.deepEqual(Object.keys(api).sort(), Object.keys(real.api).sort(), 'new app methods need the generated fictional transport too');
    for (const file of ['views/settings.js', 'lib/item-history.js', 'lib/updates.js', 'lib/subscription.js']) {
      const expected = previewSource(fs.readFileSync(path.join(root, 'ui', file), 'utf8'));
      assert.equal(fs.readFileSync(path.join(output, 'try', file), 'utf8'), expected, `${file} must not become a second stale UI`);
      assert.equal(fs.readFileSync(path.join(output, 'demo', file), 'utf8'), expected, `the old /demo bookmark must use the current ${file}`);
    }
    const health = await api.health();
    assert.match(health.model.label, /Example answers.*no live AI/);
    assert.equal(health.backend.writable, false);
    assert.match(health.backend.note, /Fictional records.*No passwords/);
    assert.equal((await api.state()).sourceStatus.length, 0, 'the preview must not invent successful account connections');
  });

  test('current preview keeps finished search history opt-in, draft edits local, and snooze reversible', async t => {
    const { api, request } = await adapter(t);
    const item = (await api.state()).items.find(row => row.state === 'open');
    await request(`/api/items/${item.id}/correction`, { method: 'POST', body: { decision: 'corrected', headline: 'HistoricalTaskExample' } });
    await api.setItemState(item.id, 'done');
    assert.deepEqual((await api.search('HistoricalTaskExample')).results, []);
    const hit = (await api.search('HistoricalTaskExample', { includeHistory: true })).results.find(row => row.id === item.id);
    assert.equal(hit.excerpt, item.why);
    assert.equal(hit.ref, `item:${item.id}`);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await api.setItemState(item.id, 'snoozed', { until });
    const snoozed = (await api.state()).items.find(row => row.id === item.id);
    assert.equal(snoozed.state, 'snoozed');
    assert.equal(Date.parse(snoozed.snoozed_until), Date.parse(until));
    await api.setItemState(item.id, 'open');
    assert.equal((await api.state()).items.find(row => row.id === item.id).snoozed_until, null);
    const draft = (await api.state()).drafts[0];
    assert.ok(draft, 'the current sample board must include a reviewable draft');
    await api.updateDraft(draft.id, { body: 'Revised fictional reply', state: 'edited' });
    assert.equal((await api.state()).drafts.find(row => row.id === draft.id).body, 'Revised fictional reply');
    await assert.rejects(request('/api/mail/send', { method: 'POST', body: { draftId: draft.id } }), { status: 501 });
  });

  test('canonical history and update views handle the preview without native backup or false update claims', async t => {
    installDom(t);
    const { api, request, importUi } = await adapter(t);
    const { state } = await importUi('lib/store.js');
    state.board = await api.state(); state.config = (await api.config()).config; state.health = await api.health();
    const item = state.board.items.find(row => row.state === 'open');
    assert.deepEqual((await request(`/api/items/${item.id}/history`)).entries, [], 'fictional data must not acquire invented older history');
    await api.setItemState(item.id, 'done');
    const { itemHistory } = await importUi('lib/item-history.js');
    const history = itemHistory(item);
    await history.toggle.listeners.get('click')[0].call(history.toggle);
    assert.match(text(history.panel), /You.*Changed/);
    assert.match(text(history.panel), /Status: Open → Done/);
    const snapshot = await request(`/api/items/${item.id}/history`);
    snapshot.entries[0].changes[0].after = 'tampered';
    assert.equal((await request(`/api/items/${item.id}/history`)).entries[0].changes[0].after, 'done');
    const update = await request('/api/updates');
    assert.equal(update.canInstall, false);
    assert.equal(update.latest, null);
    const { updatesPanel } = await importUi('lib/updates.js');
    const updates = updatesPanel();
    await findButton(updates, 'Check for updates').listeners.get('click')[0]();
    assert.match(text(updates), /This action needs the installed app/);
    assert.doesNotMatch(text(updates), /You have the latest|undefined/);
    const { backupPanel, canUseBackups } = await importUi('lib/backup.js');
    assert.equal(canUseBackups(), false);
    assert.equal(backupPanel(), null);
  });

  test('preview check events identify a demonstration and do not fabricate source reads, decisions or history', async t => {
    const { api, request, openStream } = await adapter(t);
    const before = await api.state();
    const controller = new AbortController();
    const events = [];
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const stream = openStream('/api/sweep/stream', { signal: controller.signal, onEvent: (event, value) => {
      events.push({ event, value });
      if (event === 'done' || event === 'failed') finish({ event, value });
    } });
    try {
      await api.sweep('full');
      const result = await finished;
      assert.equal(result.event, 'done');
      assert.equal(result.value.mode, 'demo', 'a button animation is not a real source/model run');
      assert.equal(events.some(({ event, value }) => event === 'progress' && ['model', 'merge'].includes(value.phase)), false);
    } finally { controller.abort(); await stream; }
    const after = await api.state();
    for (const field of ['items', 'finished', 'drafts', 'sourceStatus', 'first', 'runs']) assert.deepEqual(after[field], before[field], field);
    assert.deepEqual((await request(`/api/items/${before.items[0].id}/history`)).entries, []);
    assert.equal(events[0].event, 'hello');
  });

  test('preview settings refuse real account and credential edits without changing sample configuration', async t => {
    const { api } = await adapter(t);
    const before = await api.config();
    await assert.rejects(api.saveConfig({ mail: [{ id: 'new-mail', user: 'owner@example.invalid', enabled: true }] }), { status: 501 });
    await assert.rejects(api.saveConfig({ model: { protocol: 'chatgpt', model: 'auto', keyRef: null } }), { status: 501 });
    await assert.rejects(api.setSecret('demo-no-value', { toString() { throw new Error('secret was read'); } }), { status: 501 });
    assert.deepEqual(await api.config(), before);
    await assert.rejects(api.testModel({ protocol: 'chatgpt' }), { status: 501 });
    assert.deepEqual(await api.config(), before, 'a refused connection check must not look like configuration success');
  });
}
