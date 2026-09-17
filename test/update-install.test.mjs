import test from 'node:test';
import assert from 'node:assert/strict';
import { updateInstallation } from '../desktop/update-install.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flushTasks = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const calls = [];
  const faults = {};
  const gates = {};
  let confirmation = 1, enabled = true, busy = false, allowed = true;
  const privateBackup = 'fixture-private-recovery/zelos-before-update.zip';
  const record = async (name, ...args) => {
    calls.push([name, ...args]);
    if (gates[name]) await gates[name].promise;
    if (faults[name]) throw faults[name];
  };
  const win = {
    webContents: { identity: 'fixture-board' },
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    setEnabled(value) { calls.push(['enabled', value]); enabled = value; },
  };
  const core = {
    closed: false,
    async createBackup(...args) { await record('backup', ...args); },
    async stop() {
      await record('stop');
      core.closed = true;
      if (faults.afterStop) throw faults.afterStop;
    },
  };
  const installation = updateInstallation({
    getCore: () => core, getWindow: () => win, canStart: () => allowed,
    appVersion: '1.8.4',
    dialogs: { async showMessageBox(...args) {
      const warning = args.length === 1;
      await record(warning ? 'recovery-dialog' : 'confirmation', ...args);
      return { response: warning ? 0 : confirmation };
    } },
    flush: async contents => { await record('flush', contents); },
    backupPath: async value => { await record('backup-path', value); return privateBackup; },
    capture: () => { calls.push(['capture']); },
    setBusy: value => { calls.push(['busy', value]); busy = value; },
    markStopped: () => { calls.push(['marked-stopped']); },
    reopen: async () => { await record('reopen'); },
  });
  return { installation, calls, faults, gates, win, core, privateBackup,
    set confirmation(value) { confirmation = value; },
    set allowed(value) { allowed = value; },
    get enabled() { return enabled; }, get busy() { return busy; } };
}

const nextRelease = { latestVersion: '1.8.5' };

test('canceling update confirmation leaves the current app running without flushing, backing up, or stopping', async () => {
  const f = fixture(); f.confirmation = 0;
  assert.equal(await f.installation.prepare(nextRelease), false);
  assert.equal(f.core.closed, false); assert.equal(f.enabled, true); assert.equal(f.busy, false);
  assert.deepEqual(f.calls.map(([name]) => name), ['busy', 'confirmation', 'busy', 'enabled']);
  const [, window, dialog] = f.calls.find(([name]) => name === 'confirmation');
  assert.equal(window, f.win);
  assert.deepEqual(dialog.buttons, ['Not now', 'Update and restart']);
  assert.equal(dialog.defaultId, 0); assert.equal(dialog.cancelId, 0);
  assert.match(dialog.detail, /save your drafts.*private recovery backup/);
});

test('restart preparation confirms, flushes drafts, finishes its private recovery backup, then stops and marks the core', async () => {
  const f = fixture();
  f.gates.backup = deferred();
  const preparing = f.installation.prepare(nextRelease); await flushTasks();
  assert.equal(f.core.closed, false, 'backup must finish before closing the data store');
  assert.equal(f.calls.some(([name]) => name === 'stop'), false);
  assert.equal(f.enabled, false); assert.equal(f.busy, true);
  f.gates.backup.resolve(); assert.equal(await preparing, true);
  assert.deepEqual(f.calls.map(([name]) => name), [
    'busy', 'confirmation', 'enabled', 'flush', 'backup-path', 'backup', 'capture', 'stop', 'marked-stopped',
  ]);
  assert.deepEqual(f.calls.find(([name]) => name === 'flush'), ['flush', f.win.webContents]);
  assert.deepEqual(f.calls.find(([name]) => name === 'backup-path'), ['backup-path', f.core]);
  assert.deepEqual(f.calls.find(([name]) => name === 'backup'), ['backup', f.privateBackup, { appVersion: '1.8.4' }]);
  assert.equal(f.core.closed, true); assert.equal(f.enabled, false); assert.equal(f.busy, true);
});

for (const failure of ['flush', 'backup-path', 'backup']) {
  test(`failed ${failure} leaves the current app enabled and allows a later retry`, async () => {
    const f = fixture(); const error = new Error(`negative fixture ${failure} failure`); f.faults[failure] = error;
    await assert.rejects(f.installation.prepare(nextRelease), value => value === error);
    assert.equal(f.core.closed, false); assert.equal(f.enabled, true); assert.equal(f.busy, false);
    assert.equal(f.calls.some(([name]) => ['stop', 'marked-stopped', 'recovery-dialog', 'reopen'].includes(name)), false);
    if (failure === 'flush') assert.equal(f.calls.some(([name]) => name === 'backup'), false);
    delete f.faults[failure]; f.confirmation = 0;
    assert.equal(await f.installation.prepare(nextRelease), false, 'failure must release the preparation lock');
  });
}

test('a stop failure before the core closes keeps the existing app usable', async () => {
  const f = fixture(); const error = new Error('negative fixture stop failure'); f.faults.stop = error;
  await assert.rejects(f.installation.prepare(nextRelease), value => value === error);
  assert.equal(f.core.closed, false); assert.equal(f.enabled, true); assert.equal(f.busy, false);
  assert.equal(f.calls.some(([name]) => name === 'marked-stopped' || name === 'reopen'), false);
});

test('a failure after the core closes marks it stopped and reopens from the preserved data', async () => {
  const f = fixture(); const error = new Error('negative fixture failure after closing'); f.faults.afterStop = error;
  await assert.rejects(f.installation.prepare(nextRelease), value => value === error);
  assert.equal(f.core.closed, true);
  assert.deepEqual(f.calls.slice(-3).map(([name]) => name), ['marked-stopped', 'recovery-dialog', 'reopen']);
  assert.equal(f.calls.filter(([name]) => name === 'marked-stopped').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'reopen').length, 1);
  assert.equal(f.calls.some(([name, value]) => name === 'enabled' && value === true), false,
    'a window attached to a closed core must not be re-enabled');
});

test('recovery is a no-op while running and coalesces duplicate recovery requests after stopping', async () => {
  const f = fixture();
  await f.installation.recover(); assert.deepEqual(f.calls, []);
  await f.installation.prepare(nextRelease);
  f.gates['recovery-dialog'] = deferred();
  const first = f.installation.recover();
  const second = f.installation.recover(); await flushTasks();
  assert.equal(f.calls.filter(([name]) => name === 'recovery-dialog').length, 1);
  assert.equal(f.calls.some(([name]) => name === 'reopen'), false);
  f.gates['recovery-dialog'].resolve(); await Promise.all([first, second]);
  await f.installation.recover();
  assert.equal(f.calls.filter(([name]) => name === 'reopen').length, 1);
});

test('recovery still reopens the app if its explanatory dialog fails', async () => {
  const f = fixture(); await f.installation.prepare(nextRelease);
  const error = new Error('negative fixture dialog failure'); f.faults['recovery-dialog'] = error;
  await assert.rejects(f.installation.recover(), value => value === error);
  assert.equal(f.calls.filter(([name]) => name === 'reopen').length, 1);
});

test('a pending confirmation cannot start a second preparation or duplicate the backup', async () => {
  const f = fixture(); f.gates.confirmation = deferred(); f.confirmation = 0;
  const first = f.installation.prepare(nextRelease);
  await assert.rejects(f.installation.prepare(nextRelease), /Finish the current operation/);
  assert.equal(f.calls.filter(([name]) => name === 'confirmation').length, 1);
  assert.equal(f.calls.some(([name]) => name === 'backup'), false);
  f.gates.confirmation.resolve(); assert.equal(await first, false);
  assert.equal(f.busy, false);
});

test('maintenance conflicts and unavailable windows reject preparation before prompting or changing data', async () => {
  const f = fixture(); f.allowed = false;
  await assert.rejects(f.installation.prepare(nextRelease), /Finish the current operation/);
  assert.deepEqual(f.calls, []);
  f.allowed = true; f.win.destroyed = true;
  await assert.rejects(f.installation.prepare(nextRelease), /not ready to update/);
  assert.deepEqual(f.calls, []);
  f.win.destroyed = false; f.core.closed = true;
  await assert.rejects(f.installation.prepare(nextRelease), /not ready to update/);
  assert.deepEqual(f.calls, []);
});
