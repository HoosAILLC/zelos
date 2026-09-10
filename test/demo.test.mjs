import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe } from '../core/connectors/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function adapter(t, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-demo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = JSON.parse(fs.readFileSync(path.join(root, 'website/demo-data.json'), 'utf8'));
  prepare(data);
  fs.copyFileSync(path.join(root, 'website/demo/lib/api.js'), path.join(dir, 'api.mjs'));
  fs.copyFileSync(path.join(root, 'ui/lib/time.js'), path.join(dir, 'time.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'demo-data.js'), `export default ${JSON.stringify(data)};`);
  fs.writeFileSync(path.join(dir, 'connectors.js'), `export default ${JSON.stringify(describe())};`);
  const realTimer = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, _ms, ...args) => realTimer(fn, 0, ...args));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('The demo must never contact a server'); });
  return { ...await import(pathToFileURL(path.join(dir, 'api.mjs')).href), data };
}

test('demo board matches the hydrated release UI and exposes known sample connection health', async t => {
  const { api, data } = await adapter(t);
  const oldWindow = globalThis.window;
  globalThis.window = { location: { href: 'http://127.0.0.1/' } };
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  const real = await import('../ui/lib/api.js');
  assert.deepEqual(Object.keys(api).sort(), Object.keys(real.api).sort(), 'every release UI API method needs a demo equivalent');
  const { PRESETS } = await import('../core/llm.mjs');
  assert.deepEqual(await api.presets(), PRESETS.filter(preset => !preset.local), 'guided setup needs the same provider key-page links and defaults');
  const board = await api.state();
  assert.ok(board.items.every(item => Array.isArray(item.sourceRefs) && typeof item.sourceInactive === 'boolean'));
  assert.ok(board.events.every(event => Array.isArray(event.attendees)));
  assert.deepEqual(board.finished, []);
  assert.equal(board.sourceStatus.length, data.config.mail.length + data.config.calendars.length + data.config.sources.length);
  assert.ok(board.sourceStatus.every(row => row.ok === true && row.lastSuccessAt && row.configKey));
  await api.saveConfig({ sources: [...data.config.sources, { id: 'new-source', type: 'todoist', label: 'New sample connection', enabled: true }] });
  const fresh = (await api.state()).sourceStatus.find(row => row.id === 'new-source');
  assert.equal(fresh.ok, null);
  assert.equal(fresh.lastSuccessAt, null);
});

test('demo done, restore and timed snooze preserve the actual item action contract', async t => {
  const { api } = await adapter(t);
  const id = (await api.state()).items[0].id;
  await api.setItemState(id, 'done');
  assert.ok((await api.state()).finished.some(item => item.id === id));
  await api.setItemState(id, 'open');
  assert.ok((await api.state()).items.some(item => item.id === id));
  const until = new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000).toISOString();
  await api.setItemState(id, 'snoozed', { until });
  const snoozed = (await api.state()).items.find(item => item.id === id);
  assert.equal(Date.parse(snoozed.snoozed_until), Date.parse(until));
  const later = Date.parse(until) + 1;
  t.mock.method(Date, 'now', () => later);
  const awake = (await api.state()).items.find(item => item.id === id);
  assert.equal(awake.state, 'open');
  assert.equal(awake.snoozed_until, null);
  await assert.rejects(api.setItemState(id, 'snoozed', { until: 'bad date' }), { status: 400 });
});

test('demo search supplies excerpts and keeps inactive task history opt-in', async t => {
  const { api, data } = await adapter(t, data => {
    data.items[0].sourceInactive = true;
    data.items[0].headline = 'HistoricalTaskExample';
    data.items[0].why = 'Retained history, absent from the current selection.';
  });
  assert.equal((await api.state()).items.some(item => item.id === data.items[0].id), false);
  assert.deepEqual((await api.search('HistoricalTaskExample')).results, []);
  const hit = (await api.search('HistoricalTaskExample', { includeHistory: true })).results[0];
  assert.equal(hit.sourceInactive, true);
  assert.equal(hit.excerpt, data.items[0].why);
  assert.equal(hit.ref, `item:${data.items[0].id}`);
  const draft = (await api.state()).drafts[0];
  await api.updateDraft(draft.id, { body: 'Revised demo reply', state: 'edited' });
  assert.equal((await api.state()).drafts.find(row => row.id === draft.id).body, 'Revised demo reply');
  // Even an object that refuses to be read is accepted: only the ref is kept.
  await api.setSecret('demo-no-value', { toString() { throw new Error('secret was read'); } });
  assert.ok((await api.config()).secretRefs.includes('demo-no-value'));
});
