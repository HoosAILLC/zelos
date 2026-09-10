import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { installDom, walk, text, findButton, settle } from './helpers/ui-dom.mjs';

async function fixture(t) {
  const document = installDom(t);
  const { state } = await import('../ui/lib/store.js');
  const source = await import('../ui/lib/source-status.js');
  const settings = await import('../ui/views/settings.js');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, opts = {}) => {
    calls.push({ path, opts });
    const body = path === '/api/help' ? {} : path === '/api/sweep' ? { ok: true } : {};
    return { ok: true, text: async () => JSON.stringify(body) };
  });
  state.config = { identity: { timezone: 'UTC' }, mail: [], calendars: [], sources: [] };
  state.health = { model: { configured: false } };
  state.sweep = { running: false };
  state.board = { ...state.board, sourceStatus: [], runs: {} };
  return { document, state, source, settings, calls };
}

test('connection routes preserve opaque IDs and the real app parser passes the exact target', async t => {
  const { source } = await fixture(t);
  const id = 'work/mail % # [a]';
  const route = source.connectionRoute({ configKey: 'mail', id });
  const code = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8').match(/function parseHash\(\) \{[\s\S]*?\n\}/)[0];
  const context = vm.createContext({ window: { location: { hash: route } }, VIEWS: [{ id: 'settings' }], parseConnectionTarget: source.parseConnectionTarget });
  assert.equal(vm.runInContext(`${code}\nparseHash().connectionId`, context), id);
  assert.equal(source.parseConnectionTarget('%bad'), null);
});

test('mail, calendar and task recovery selects only the requested account and preserves existing Edit', async t => {
  const { state, settings } = await fixture(t);
  for (const [family, render, extra] of [['mail', settings.mailPanel, { user: 'person@example.invalid' }], ['calendars', settings.calendarPanel, { kind: 'ics' }], ['sources', settings.sourcesPanel, { type: 'todoist' }]]) {
    state.config[family] = [{ id: 'first', label: 'First', ...extra }, { id: 'target', label: 'Target', ...extra }];
    const node = render({ connectionId: 'target' });
    const targets = walk(node).filter(item => item.getAttribute('data-connection-target') !== null);
    assert.equal(targets.length, 1); assert.match(targets[0].getAttribute('aria-label'), /Target/);
    assert.ok(findButton(targets[0], 'Edit')); assert.ok(findButton(targets[0], 'Check all connections'));
    const missing = render({ connectionId: 'removed' });
    assert.match(text(missing), /no longer configured/);
    assert.equal(findButton(missing, 'Check all connections'), undefined);
  }
});

test('the targeted mail Edit opens that account rather than the first account in the family', async t => {
  const { state, settings } = await fixture(t);
  state.config.mail = [
    { id: 'first', label: 'First', user: 'first@example.invalid' },
    { id: 'target', label: 'Work mail', user: 'target@example.invalid' },
  ];
  const node = settings.mailPanel({ connectionId: 'target' });
  const card = node.querySelector('[data-connection-target]');
  findButton(card, 'Edit').click(); await settle();
  assert.ok(walk(node).some(input => input.tag === 'input' && input.value === 'target@example.invalid'));
  assert.equal(walk(node).some(input => input.tag === 'input' && input.value === 'first@example.invalid'), false);
});

test('the real route focus function focuses and reveals an exact connection without building a selector from its ID', async t => {
  const { document } = await fixture(t);
  const main = document.body.appendChild(document.createElement('main'));
  const card = main.appendChild(document.createElement('div')); card.setAttribute('data-connection-target', '');
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const focus = source.match(/function focusConnectionTarget\(\) \{[\s\S]*?\n\}/)[0];
  const context = vm.createContext({ main, route: { view: 'settings', connectionId: 'odd"[id]' }, focusQuietly: node => node.focus() });
  assert.equal(vm.runInContext(`${focus}\nfocusConnectionTarget()`, context), true);
  assert.equal(document.activeElement, card); assert.equal(card.scrolled, true);
});

test('reading-status and setup links target the failing account without claiming credentials are verified', async t => {
  const { state, source } = await fixture(t);
  state.config.mail = [{ id: 'unread', label: 'New mail' }, { id: 'failed', label: 'Work' }];
  state.health.model.configured = true;
  state.board.sourceStatus = [{ id: 'failed', configKey: 'mail', ok: false, error: 'Sign in again' }];
  const paths = [];
  findButton(source.readingStatus(path => paths.push(path)), 'Review connection').click();
  assert.deepEqual(paths, ['#/settings/mail/failed']);
  const setup = text(source.setupStatus(() => {}));
  assert.match(setup, /AI chosen.*test it/);
  assert.match(setup, /New mail: configured; no successful read recorded/);
  assert.match(setup, /Work: needs attention/);
  assert.doesNotMatch(setup, /verified|has a successful read/);
});

test('recovery respects cooldowns, paused connections and live check state; it never starts by rendering', async t => {
  const { document, state, source, calls } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-09-10T12:00:00Z') });
  state.config.mail = [{ id: 'mail', label: 'Mail' }];
  const report = { id: 'mail', configKey: 'mail', enabled: true, ok: false, retryAt: '2026-09-10T12:00:01Z' };
  state.board.sourceStatus = [report];
  const recovery = document.body.appendChild(source.connectionRecovery('mail', 'mail'));
  const check = findButton(recovery, 'Check all connections');
  assert.equal(check.disabled, true); check.fire('click'); await settle();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1002); assert.equal(check.disabled, false);
  state.sweep.running = true; check.fire('click'); await settle(); assert.equal(calls.length, 0);
  state.sweep.running = false; state.config.mail[0].enabled = false;
  check.fire('click'); await settle(); assert.equal(calls.length, 0);
  state.config.mail[0].enabled = true;
  check.fire('click'); await settle();
  assert.deepEqual(calls.map(call => call.path), ['/api/sweep']);
  assert.equal(JSON.parse(calls[0].opts.body).mode, 'auto');
});
