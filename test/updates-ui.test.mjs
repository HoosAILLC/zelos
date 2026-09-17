import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';
let updatesPanel;

async function fixture(t, initial = {}) {
  const document = installDom(t);
  ({ updatesPanel } = await import('../ui/lib/updates.js'));
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => { throw new Error('Native updates must not use the browser update endpoint'); };
  let state = { supported: true, status: 'idle', currentVersion: '1.8.4', automatic: true, ...initial };
  const calls = [];
  const listeners = new Set();
  let unsubscribed = 0;
  const bridge = {
    async getState(...args) { calls.push(['getState', args]); return state; },
    async check(...args) { calls.push(['check', args]); return state; },
    async download(...args) { calls.push(['download', args]); return state; },
    async install(...args) { calls.push(['install', args]); return state; },
    async setAutomatic(...args) { calls.push(['setAutomatic', args]); state = { ...state, automatic: args[0] }; return state; },
    onState(callback) { listeners.add(callback); return () => { listeners.delete(callback); unsubscribed += 1; }; },
  };
  window.zelos = { desktop: true, updates: bridge };
  const emit = next => { state = { ...state, ...next }; for (const listener of listeners) listener(state); return state; };
  const mount = () => document.body.appendChild(updatesPanel());
  return { document, bridge, calls, listeners, emit, mount, get unsubscribed() { return unsubscribed; } };
}

test('native settings read preferences without checking, downloading, or installing', async t => {
  const f = await fixture(t);
  const panel = f.mount(); await settle();
  assert.deepEqual(f.calls, [['getState', []]]);
  assert.equal(panel.querySelector('input').checked, true);
  assert.match(text(panel), /Check for updates automatically/);
  assert.match(text(panel), /Downloads and restarts need your approval/);
  assert.equal(findButton(panel, 'Check for updates').disabled, false);
  assert.equal(findButton(panel, 'Download update').hidden, true);
  assert.equal(findButton(panel, 'Update and restart').hidden, true);
  assert.equal(panel.querySelector('[role="status"]').getAttribute('aria-live'), 'polite');
});

test('native download reports progress and restart needs a separate click with no renderer paths or URLs', async t => {
  const f = await fixture(t, { status: 'available', latestVersion: '1.8.5', releaseUrl: 'https://github.com/HoosAILLC/zelos/releases/tag/v1.8.5' });
  let finish;
  f.bridge.download = (...args) => { f.calls.push(['download', args]); return new Promise(resolve => { finish = resolve; }); };
  const panel = f.mount(); await settle();
  const download = findButton(panel, 'Download update');
  const install = findButton(panel, 'Update and restart');
  download.focus(); download.click(); download.click();
  assert.deepEqual(f.calls.filter(([name]) => name === 'download'), [['download', []]]);
  assert.equal(findButton(panel, 'Check for updates').disabled, true);
  f.emit({ status: 'downloading', progress: 37.4 });
  assert.equal(panel.querySelector('progress').getAttribute('value'), '37');
  assert.equal(panel.querySelector('progress').getAttribute('aria-valuenow'), '37');
  assert.match(text(panel), /37% downloaded/);
  f.emit({ status: 'downloading', progress: 120 });
  assert.equal(panel.querySelector('progress').getAttribute('value'), '100');
  f.emit({ status: 'downloading', progress: NaN });
  assert.equal(panel.querySelector('progress').getAttribute('value'), null);
  f.document.body.focus();
  finish(f.emit({ status: 'downloaded', progress: 100 })); await settle();
  assert.equal(install.hidden, false); assert.equal(install.disabled, false);
  assert.equal(panel.querySelector('progress').hidden, true);
  assert.equal(f.document.activeElement, install);
  assert.deepEqual(f.calls.filter(([name]) => name === 'install'), []);
  f.bridge.install = async (...args) => { f.calls.push(['install', args]); return f.emit({ status: 'downloaded', canceled: true }); };
  install.click(); await settle();
  assert.deepEqual(f.calls.filter(([name]) => name === 'install'), [['install', []]]);
  assert.equal(install.disabled, false, 'canceling the native confirmation leaves a restart action');
  assert.match(text(panel), /ready to install/);
  assert.equal(panel.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
});

test('automatic preference sends only a boolean and rolls back after a failed save', async t => {
  const f = await fixture(t);
  const panel = f.mount(); await settle();
  const automatic = panel.querySelector('input');
  f.bridge.setAutomatic = async (...args) => { f.calls.push(['setAutomatic', args]); throw new Error('The preference could not be saved.'); };
  automatic.checked = false; automatic.fire('change'); await settle();
  assert.equal(automatic.checked, true);
  assert.equal(automatic.disabled, false);
  assert.match(text(panel), /preference could not be saved/);
  f.bridge.setAutomatic = async (...args) => { f.calls.push(['setAutomatic', args]); return f.emit({ automatic: args[0] }); };
  automatic.checked = false; automatic.fire('change'); await settle();
  assert.equal(automatic.checked, false);
  assert.deepEqual(f.calls.filter(([name]) => name === 'setAutomatic'), [['setAutomatic', [false]], ['setAutomatic', [false]]]);
  assert.deepEqual(f.calls.filter(([name]) => ['check', 'download', 'install'].includes(name)), []);
});

test('failed native operations restore retry actions and render errors as text', async t => {
  const f = await fixture(t, { status: 'available', latestVersion: '1.8.5' });
  let rejectDownload;
  f.bridge.download = (...args) => { f.calls.push(['download', args]); f.emit({ status: 'downloading' }); return new Promise((resolve, reject) => { rejectDownload = reject; }); };
  const panel = f.mount(); await settle();
  const download = findButton(panel, 'Download update');
  download.click(); rejectDownload(new Error('<img src=x onerror=alert(1)>')); await settle();
  assert.equal(download.hidden, false); assert.equal(download.disabled, false);
  assert.equal(panel.querySelector('img'), null);
  assert.match(text(panel), /<img src=x onerror=alert\(1\)>/);
  f.emit({ status: 'downloaded' });
  f.emit({ status: 'error', error: 'Close the other Zelos window first.' });
  assert.equal(findButton(panel, 'Update and restart').hidden, false);
  assert.equal(findButton(panel, 'Update and restart').disabled, false);
  assert.match(text(panel), /Close the other Zelos window first/);
});

test('new native events supersede a stale initial snapshot and unverified release links are not shown', async t => {
  const f = await fixture(t);
  let finish;
  f.bridge.getState = () => new Promise(resolve => { finish = resolve; });
  const panel = f.mount();
  f.emit({ status: 'available', latestVersion: '1.8.5', releaseUrl: 'https://untrusted.example/download.exe' });
  finish({ supported: true, status: 'idle', currentVersion: '1.8.4', automatic: false }); await settle();
  assert.match(text(panel), /1\.8\.5 is available/);
  assert.equal(panel.querySelector('input').checked, true);
  assert.equal(findButton(panel, 'Download update').hidden, false);
  assert.equal(panel.querySelector('a'), null);
});

test('detached Settings release their native subscription and ignore late operation results', async t => {
  const f = await fixture(t);
  let finish;
  f.bridge.check = () => new Promise(resolve => { finish = resolve; });
  const panel = f.mount(); await settle();
  findButton(panel, 'Check for updates').click();
  panel.remove();
  f.emit({ status: 'available', latestVersion: '1.8.5' });
  finish({ supported: true, status: 'downloaded', latestVersion: '1.8.5', automatic: true }); await settle();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.unsubscribed, 1);
  assert.doesNotMatch(text(panel), /ready to install/);
  const next = f.mount(); await settle();
  assert.equal(f.listeners.size, 1);
  next.dispose(); next.dispose();
  assert.equal(f.listeners.size, 0); assert.equal(f.unsubscribed, 2);
});

test('an unsupported development installation keeps manual HTTP updates and explains why', async t => {
  const f = await fixture(t, { supported: false, reason: 'This development build cannot install updates.' });
  const requests = [];
  globalThis.fetch = async (...args) => { requests.push(args); return new Response(JSON.stringify({ demo: true })); };
  const panel = f.mount(); await settle();
  assert.match(text(panel), /development build cannot install updates/);
  assert.equal(panel.querySelector('input'), null);
  assert.equal(f.listeners.size, 0);
  assert.equal(requests.length, 0);
  findButton(panel, 'Check for updates').click(); await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], '/api/updates/check');
  assert.equal(requests[0][1].body, '{}');
  assert.match(text(panel), /website demo cannot check/);
});

test('failed state reads have a retry without claiming the installed app is current', async t => {
  const f = await fixture(t);
  f.bridge.getState = async () => { throw new Error('Update settings are temporarily unavailable.'); };
  const panel = f.mount(); await settle();
  assert.match(text(panel), /temporarily unavailable/);
  assert.doesNotMatch(text(panel), /latest release:/);
  assert.equal(findButton(panel, 'Try again').hidden, false);
  f.bridge.getState = async () => ({ supported: true, status: 'idle', currentVersion: '1.8.4', automatic: false });
  findButton(panel, 'Try again').click(); await settle();
  assert.equal(findButton(panel, 'Try again').hidden, true);
  assert.equal(findButton(panel, 'Check for updates').disabled, false);
  assert.equal(panel.querySelector('input').checked, false);
});
