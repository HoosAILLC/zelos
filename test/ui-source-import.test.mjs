import test from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '../core/connectors/index.mjs';
import { installDom, walk, text, findButton, settle } from './helpers/ui-dom.mjs';

const manifests = describe();

async function fixture(t, { startError = null, sources = [{ id: 'texts', type: 'imessage', enabled: true, label: 'iPhone texts' }] } = {}) {
  const document = installDom(t);
  const store = await import('../ui/lib/store.js');
  const settings = await import('../ui/views/settings.js');
  const calls = [];
  store.state.config = { identity: {}, mail: [], calendars: [], sources, sweep: { auto: false } };
  store.state.secretRefs = [];
  store.state.board = { ...store.state.board, sourceStatus: [], runs: {} };
  store.state.sweep = { running: false, phase: '', error: null, lastResult: null };
  t.mock.method(globalThis, 'fetch', async (path, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method, body });
    let value;
    if (path === '/api/sweep') {
      if (startError) return { ok: false, status: startError.status || 500, text: async () => JSON.stringify({ error: startError.message }) };
      value = { started: true, mode: body.mode };
    } else if (path === '/api/config' && method === 'PUT') {
      value = { config: { ...store.state.config, ...body }, secretRefs: [], errors: [] };
    } else if (path === '/api/health') value = {};
    else throw new Error(`Unexpected request ${method} ${path}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  });
  t.after(() => { document.body.replaceChildren(); store.emit(); });
  return { document, store, settings, calls };
}

test('Messages setup help follows source selection and saving only stores the manifest fields', async t => {
  const { document, store, settings, calls } = await fixture(t);
  let saved = 0;
  const form = document.body.appendChild(settings.sourceForm({ id: 'texts', type: 'imessage', label: 'iPhone texts', enabled: true }, { manifests, onSaved() { saved++; }, onCancel() {} }));
  assert.match(text(form), /same Apple Account/);
  assert.match(text(form), /Full Disk Access/);
  assert.match(text(form), /Text Message Forwarding/);
  assert.equal(walk(form).some(node => node.getAttribute('type') === 'password'), false);
  const picker = walk(form).find(node => node.tag === 'select');
  picker.value = 'rss'; picker.fire('change');
  assert.doesNotMatch(text(form), /Full Disk Access/);
  picker.value = 'imessage'; picker.fire('change');
  assert.match(text(form), /Full Disk Access/);
  assert.deepEqual(calls, [], 'opening setup help must not read Messages or request an AI review');
  findButton(form, 'Save source').click(); await settle();
  assert.equal(saved, 1);
  const writes = calls.filter(call => call.method !== 'GET');
  assert.deepEqual(writes.map(call => call.path), ['/api/config']);
  assert.deepEqual(writes[0].body.sources[0].settings, { databasePath: '~/Library/Messages/chat.db', lookbackDays: 14, maxMessages: 400 });
  assert.equal(store.state.config.sweep.auto, false);
});

test('Read sources now explicitly requests light mode and follows real busy and completion state', async t => {
  const { document, store, settings, calls } = await fixture(t);
  const panel = document.body.appendChild(settings.sourcesPanel());
  const read = findButton(panel, 'Read sources now');
  assert.ok(read);
  assert.match(text(panel), /all enabled/);
  assert.equal(read.disabled, false);
  assert.deepEqual(calls, []);
  read.click();
  assert.equal(read.disabled, true, 'disable before the request can complete');
  read.fire('click'); await settle();
  assert.deepEqual(calls, [{ path: '/api/sweep', method: 'POST', body: { mode: 'light' } }]);
  assert.equal(read.disabled, true, 'an accepted request has not finished reading');
  assert.doesNotMatch(text(panel), /Finished reading/);
  store.state.sweep = { running: false, error: null, lastResult: { mode: 'light', ok: true, stats: { sourcesFailed: 0 } } };
  store.emit();
  assert.equal(read.disabled, false);
  assert.match(text(panel), /Finished reading sources without asking AI/);
  assert.equal(store.state.config.sweep.auto, false, 'manual import must not enable automatic AI checks');
  const replacement = settings.sourcesPanel(); panel.replaceWith(replacement); store.emit();
  assert.match(text(replacement), /Finished reading sources without asking AI/, 'completion remains visible after board refresh replaces the panel');
});

test('Read sources now is disabled by other checks and reports partial and failed imports honestly', async t => {
  const { document, store, settings, calls } = await fixture(t);
  const panel = document.body.appendChild(settings.sourcesPanel());
  const read = findButton(panel, 'Read sources now');
  assert.ok(read);
  store.state.sweep = { running: true, error: null }; store.emit();
  assert.equal(read.disabled, true);
  read.fire('click'); await settle(); assert.deepEqual(calls, []);
  store.state.sweep = { running: false, error: null, lastResult: { mode: 'light', ok: true, stats: { sourcesFailed: 1 } } }; store.emit();
  assert.match(text(panel), /Some sources could not be read/);
  assert.doesNotMatch(text(panel), /Finished reading sources/);
  store.state.sweep = { running: false, error: 'Messages access was denied.', lastResult: { mode: 'light', ok: false } }; store.emit();
  assert.match(text(panel), /Messages access was denied/);
  assert.equal(read.disabled, false);
});

test('Read sources now shows request failure and allows retry without switching modes', async t => {
  const { document, settings, calls } = await fixture(t, { startError: { message: 'The local service is unavailable.' } });
  const panel = document.body.appendChild(settings.sourcesPanel());
  const read = findButton(panel, 'Read sources now');
  assert.ok(read);
  read.click(); await settle();
  assert.equal(read.disabled, false);
  assert.match(text(panel), /The local service is unavailable/);
  read.click(); await settle();
  assert.deepEqual(calls.map(call => call.body), [{ mode: 'light' }, { mode: 'light' }]);
});

test('Read sources now needs an enabled connection and also works for mail/calendar-only setups', async t => {
  const { document, store, settings, calls } = await fixture(t, { sources: [] });
  const panel = document.body.appendChild(settings.sourcesPanel());
  const read = findButton(panel, 'Read sources now');
  assert.ok(read); assert.equal(read.disabled, true);
  read.fire('click'); await settle(); assert.deepEqual(calls, []);
  store.state.config.calendars = [{ id: 'calendar', enabled: false }]; store.emit(); assert.equal(read.disabled, true);
  store.state.config.calendars[0].enabled = true; store.emit(); assert.equal(read.disabled, false);
  read.click(); await settle();
  assert.deepEqual(calls.map(call => call.body), [{ mode: 'light' }]);
});
