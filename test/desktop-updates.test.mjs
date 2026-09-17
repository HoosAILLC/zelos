import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createDesktopUpdates, verifyCachedUpdate, updateHandlers, UPDATE_CHANNELS } from '../desktop/updates.js';
import { validateUpdateBuild, validateUpdateInfo, isNewerVersion, allowedUpdateRequest } from '../desktop/update-policy.js';
import { updatePreferences } from '../desktop/update-preferences.js';

const STARTUP = 45_000;
const INTERVAL = 6 * 60 * 60_000;
const bytes = Buffer.alloc(2048, 0x5a);
const digest = crypto.createHash('sha512').update(bytes).digest('base64');
const build = { schemaVersion: 1, platform: 'win32', arch: 'arm64', channel: 'latest-arm64', publisher: 'Zelos Fixture Publisher', currentVersion: '1.8.4' };
const release = (version = '1.8.5', installation = build) => ({ version, tag: `v${version}`,
  files: [{ url: installation.platform === 'darwin' ? `Zelos-${version}-${installation.arch}.zip` : `Zelos-${version}-setup-${installation.arch}.exe`, size: bytes.length, sha512: digest }] });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

class Clock {
  now = 0;
  nextId = 0;
  jobs = new Map();
  set = (callback, milliseconds) => {
    const job = { id: ++this.nextId, at: this.now + milliseconds, callback, unref() {} };
    this.jobs.set(job.id, job); return job;
  };
  clear = job => { if (job) this.jobs.delete(job.id); };
  async advance(milliseconds) {
    const end = this.now + milliseconds;
    for (;;) {
      const job = [...this.jobs.values()].filter(value => value.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!job) break;
      this.now = job.at; this.jobs.delete(job.id); job.callback(); await flush();
    }
    this.now = end; await flush();
  }
}

class FakeUpdater extends EventEmitter {
  calls = [];
  tokens = [];
  constructor(file) {
    super(); this.file = file;
    // electron-updater retains its own error logger; the controller adds a
    // listener for recovery. This keeps late fake events nonfatal too.
    this.on('error', () => {});
    this.result = { updateInfo: release(), isUpdateAvailable: true, cancellationToken: { cancel() {} } };
  }
  set channel(value) { this.selectedChannel = value; this.allowDowngrade = true; }
  get channel() { return this.selectedChannel; }
  checkForUpdates() { this.calls.push('check'); return this.checkImpl ? this.checkImpl() : Promise.resolve(this.result); }
  downloadUpdate(token) { this.calls.push('download'); this.tokens.push(token); return this.downloadImpl ? this.downloadImpl(token) : Promise.resolve([this.file]); }
  quitAndInstall(...args) { this.calls.push(['install', ...args]); if (this.installImpl) return this.installImpl(); }
  closeServerIfExists() { this.calls.push('close'); }
}

function harness(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-updates-test-'));
  const file = path.join(directory, 'cached-update.exe');
  const preferenceFile = path.join(directory, 'preferences.json');
  fs.writeFileSync(file, bytes);
  const clock = new Clock();
  const updater = new FakeUpdater(file);
  const preferences = updatePreferences(preferenceFile);
  const states = [], notifications = [], cancellationTokens = [];
  let prepareCalls = 0, recoveryCalls = 0;
  const controller = createDesktopUpdates({ updater, build, currentVersion: '1.8.4', preferences,
    setTimer: clock.set, clearTimer: clock.clear,
    onState: value => states.push(value), notify: value => { notifications.push(value); return true; },
    prepareInstall: async () => { prepareCalls += 1; return false; },
    recoverInstall: async () => { recoveryCalls += 1; },
    createCancellationToken: () => {
      const token = { cancelled: false, cancel() { this.cancelled = true; } };
      cancellationTokens.push(token); return token;
    },
    ...overrides,
  });
  t.after(() => { controller.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, preferenceFile, clock, updater, preferences, states, notifications, cancellationTokens, controller,
    get prepareCalls() { return prepareCalls; }, get recoveryCalls() { return recoveryCalls; } };
}

test('update support is bound to the packaged platform, architecture, official feed, and publisher', () => {
  const input = { manifest: { version: '1.8.4', zelosUpdates: { ...build } }, packaged: true, platform: 'win32', arch: 'arm64',
    feed: { provider: 'github', owner: 'HoosAILLC', repo: 'zelos', channel: 'latest-arm64', publisherName: [build.publisher] } };
  assert.equal(validateUpdateBuild(input).publisher, build.publisher);
  for (const change of [
    value => { value.packaged = false; }, value => { value.platform = 'linux'; }, value => { value.arch = 'x64'; },
    value => { delete value.manifest.zelosUpdates; }, value => { value.manifest.version = '1.8.4-beta.1'; },
    value => { value.manifest.zelosUpdates.publisher = ''; }, value => { value.manifest.zelosUpdates.channel = 'latest'; },
    value => { value.feed.provider = 'generic'; }, value => { value.feed.owner = 'someone-else'; },
    value => { value.feed.repo = 'another-app'; }, value => { value.feed.channel = 'latest-x64'; },
    value => { value.feed.url = 'https://untrusted.example/feed'; }, value => { value.feed.host = 'untrusted.example'; },
    value => { value.feed.protocol = 'http'; }, value => { value.feed.token = 'negative-fixture'; },
    value => { value.feed.private = true; }, value => { value.feed.publisherName = ['Another Publisher']; },
  ]) { const invalid = structuredClone(input); change(invalid); assert.throws(() => validateUpdateBuild(invalid)); }
  const mac = structuredClone(input);
  mac.platform = mac.manifest.zelosUpdates.platform = 'darwin';
  mac.manifest.zelosUpdates.publisher = 'Developer ID Application: Fixture (ABCDEFGHIJ)';
  assert.equal(validateUpdateBuild(mac).platform, 'darwin');
  mac.manifest.zelosUpdates.publisher = 'Unsigned Fixture';
  assert.throws(() => validateUpdateBuild(mac));
});

test('release metadata rejects foreign paths, wrong architecture, prereleases, ambiguous files, and missing hashes', () => {
  assert.equal(validateUpdateInfo(release(), build).filename, 'Zelos-1.8.5-setup-arm64.exe');
  for (const change of [
    value => { value.version = '1.8.5-beta.1'; }, value => { value.tag = 'v1.8.6'; },
    value => { value.files[0].url = 'https://untrusted.example/Zelos-1.8.5-setup-arm64.exe'; },
    value => { value.files[0].url = 'Zelos-1.8.5-setup-x64.exe'; }, value => { value.files[0].url = '../setup.exe'; },
    value => { delete value.files[0].sha512; }, value => { value.files[0].sha512 = 'not-a-sha512-hash'; },
    value => { value.sha512 = 'different-hash'; }, value => { value.path = 'other.exe'; },
    value => { value.files.push({ ...value.files[0] }); }, value => { value.files[0].size = -1; },
    value => { value.files[0].size = 2 ** 31 + 1; }, value => { value.packages = {}; }, value => { value.stagingPercentage = 10; },
  ]) { const invalid = release(); change(invalid); assert.throws(() => validateUpdateInfo(invalid, build)); }
  assert.equal(isNewerVersion('1.8.5', '1.8.4'), true);
  for (const candidate of ['1.8.4', '1.8.3', '1.8.5-beta.1', '01.9.0', '9007199254740992.0.0']) assert.equal(isNewerVersion(candidate, '1.8.4'), false);
});

test('native update requests allow the bound GitHub release files and reject other repositories or architectures', () => {
  for (const url of [
    'https://github.com/HoosAILLC/zelos/releases.atom',
    'https://github.com/HoosAILLC/zelos/releases/latest',
    'https://github.com/HoosAILLC/zelos/releases/tag/v1.8.5',
    'https://github.com/HoosAILLC/zelos/releases/download/v1.8.5/latest-arm64.yml',
    'https://github.com/HoosAILLC/zelos/releases/download/v1.8.5/Zelos-1.8.5-setup-arm64.exe',
    'https://release-assets.githubusercontent.com/fixture/attachment',
  ]) assert.equal(allowedUpdateRequest(url, build), true, url);
  for (const url of [
    'http://github.com/HoosAILLC/zelos/releases/latest', 'file:///tmp/setup.exe',
    'https://github.com.evil.test/HoosAILLC/zelos/releases/latest', 'https://github.com:8443/HoosAILLC/zelos/releases/latest',
    'https://user:password@github.com/HoosAILLC/zelos/releases/latest',
    'https://github.com/someone/zelos/releases/latest',
    'https://github.com/HoosAILLC/zelos/releases/download/v1.8.5/latest-x64.yml',
    'https://github.com/HoosAILLC/zelos/releases/download/v1.8.5/Zelos-1.8.5-setup-x64.exe',
    'https://github.com/HoosAILLC/zelos/releases/download/v1.8.5/Zelos-1.8.6-setup-arm64.exe',
  ]) assert.equal(allowedUpdateRequest(url, build), false, url);
});

test('missing preferences default to checks while corruption and a saved opt-out never turn checks on', t => {
  const h = harness(t);
  assert.equal(h.preferences.read().automatic, true);
  h.preferences.write({ automatic: false, lastNotifiedVersion: '1.8.5' });
  assert.deepEqual(updatePreferences(h.preferenceFile).read(), { automatic: false, lastNotifiedVersion: '1.8.5' });
  for (const value of ['{broken', 'null', '{}', '{"automatic":"true"}', '{"automatic":1}', '[]']) {
    fs.writeFileSync(h.preferenceFile, value);
    assert.equal(h.preferences.read().automatic, false);
  }
  assert.equal(updatePreferences(h.directory).read().automatic, false, 'an unreadable existing preference cannot enable checks');
  assert.deepEqual(fs.readdirSync(h.directory).filter(name => name.endsWith('.tmp')), []);
});

test('unsupported installations do not schedule checks or start downloads and installs', async t => {
  const h = harness(t, { build: null });
  h.controller.start(); await h.clock.advance(INTERVAL * 2);
  await h.controller.check(); await h.controller.download(); await h.controller.install(); h.controller.setAutomatic(true);
  assert.equal(h.controller.getState().supported, false);
  assert.equal(h.controller.getState().automatic, false);
  assert.deepEqual(h.updater.calls, []); assert.equal(h.clock.jobs.size, 0);
});

test('automatic checks use 45 seconds then six hours, persist opt-out, and never download or install', async t => {
  const h = harness(t);
  assert.equal(h.updater.autoDownload, false); assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.updater.allowDowngrade, false); assert.equal(h.updater.allowPrerelease, false);
  assert.equal(h.updater.disableDifferentialDownload, true); assert.equal(h.updater.disableWebInstaller, true);
  h.controller.start(); await h.clock.advance(STARTUP - 1); assert.deepEqual(h.updater.calls, []);
  await h.clock.advance(1); assert.deepEqual(h.updater.calls, ['check']);
  assert.equal(h.notifications.length, 1); assert.equal(h.preferences.read().lastNotifiedVersion, '1.8.5');
  await h.clock.advance(INTERVAL - 1); assert.equal(h.updater.calls.length, 1);
  await h.clock.advance(1); assert.deepEqual(h.updater.calls, ['check', 'check']);
  assert.equal(h.notifications.length, 1, 'the same update does not repeatedly notify');
  h.controller.setAutomatic(false); await h.clock.advance(INTERVAL * 2);
  assert.equal(h.updater.calls.length, 2); assert.equal(h.preferences.read().automatic, false);
  h.controller.setAutomatic(true); await h.clock.advance(STARTUP);
  assert.equal(h.updater.calls.length, 3);
  assert.equal(h.updater.calls.includes('download'), false); assert.equal(h.prepareCalls, 0);
});

test('manual checks coalesce and do not send an automatic notification', async t => {
  const h = harness(t); const pending = deferred(); h.updater.checkImpl = () => pending.promise;
  const first = h.controller.check(), second = h.controller.check();
  assert.equal(first, second); await flush(); assert.deepEqual(h.updater.calls, ['check']);
  pending.resolve(h.updater.result); await first;
  assert.equal(h.controller.getState().status, 'available'); assert.equal(h.notifications.length, 0);
  const snapshot = h.controller.getState(); snapshot.automatic = false;
  assert.equal(h.controller.getState().automatic, true, 'the renderer receives a detached state');
});

test('invalid metadata and downgrades never become downloadable candidates', async t => {
  const h = harness(t);
  for (const info of [{ ...release(), tag: 'v9.9.9' }, release('1.8.5-beta.1'),
    { ...release(), files: [{ ...release().files[0], sha512: undefined }] }, release('1.8.3')]) {
    h.updater.result = { ...h.updater.result, updateInfo: info };
    await h.controller.check(); await h.controller.download();
    assert.notEqual(h.controller.getState().status, 'available');
  }
  assert.equal(h.updater.calls.includes('download'), false);
});

test('explicit download coalesces, clamps progress, verifies bytes, and never starts installation', async t => {
  const h = harness(t); await h.controller.check();
  const pending = deferred(); h.updater.downloadImpl = () => pending.promise;
  const first = h.controller.download(), second = h.controller.download(); assert.equal(first, second);
  await flush(); assert.equal(h.updater.calls.filter(call => call === 'download').length, 1);
  h.updater.emit('download-progress', { percent: 37.5 }); assert.equal(h.controller.getState().progress, 37.5);
  h.updater.emit('download-progress', { percent: 120 }); assert.equal(h.controller.getState().progress, 100);
  h.updater.emit('download-progress', { percent: -5 }); assert.equal(h.controller.getState().progress, 0);
  h.updater.emit('download-progress', { percent: NaN }); assert.equal(h.controller.getState().progress, 0);
  pending.resolve([h.file]); await first;
  assert.equal(h.controller.getState().status, 'downloaded'); assert.equal(h.controller.getState().progress, 100);
  h.updater.emit('download-progress', { percent: 1 }); assert.equal(h.controller.getState().progress, 100);
  assert.equal(h.prepareCalls, 0); assert.equal(h.updater.calls.some(Array.isArray), false);
});

test('download corruption is rejected and retry receives a fresh cancellation token', async t => {
  const h = harness(t); await h.controller.check();
  fs.writeFileSync(h.file, Buffer.alloc(bytes.length, 0x44));
  await h.controller.download();
  assert.equal(h.controller.getState().status, 'available'); assert.match(h.controller.getState().error, /verified/);
  fs.writeFileSync(h.file, bytes); await h.controller.download();
  assert.equal(h.controller.getState().status, 'downloaded');
  assert.notEqual(h.updater.tokens[0], h.updater.tokens[1]);
});

test('cached updates reject missing, ambiguous, non-file, size-changed, and hash-changed payloads', async t => {
  const h = harness(t); const candidate = validateUpdateInfo(release(), build);
  await verifyCachedUpdate([h.file], candidate);
  for (const files of [[], [h.file, h.file], [null], [h.directory], [path.join(h.directory, 'missing')]]) await assert.rejects(verifyCachedUpdate(files, candidate));
  fs.writeFileSync(h.file, Buffer.from('short')); await assert.rejects(verifyCachedUpdate([h.file], candidate));
  fs.writeFileSync(h.file, Buffer.alloc(bytes.length, 0x44)); await assert.rejects(verifyCachedUpdate([h.file], candidate));
});

test('same-size cache tampering before installation is rejected before save or backup starts', async t => {
  const h = harness(t); await h.controller.check(); await h.controller.download();
  fs.writeFileSync(h.file, Buffer.alloc(bytes.length, 0x44));
  await h.controller.install();
  assert.equal(h.controller.getState().status, 'available'); assert.ok(h.controller.getState().error);
  assert.equal(h.prepareCalls, 0); assert.equal(h.updater.calls.some(Array.isArray), false);
});

test('cache tampering during confirmation or backup is rechecked before handoff and recovers the open app', async t => {
  const h = harness(t, { prepareInstall: async () => {
    fs.writeFileSync(h.file, Buffer.alloc(bytes.length, 0x44));
    return true;
  } });
  await h.controller.check(); await h.controller.download(); await h.controller.install();
  assert.equal(h.updater.calls.some(Array.isArray), false);
  assert.equal(h.controller.getState().status, 'downloaded');
  assert.equal(h.recoveryCalls, 1);
});

test('canceling confirmation or failing save/backup keeps the downloaded update available for retry', async t => {
  let mode = 'cancel', preparations = 0;
  const h = harness(t, { prepareInstall: async () => { preparations += 1; if (mode === 'fail') throw new Error('fixture backup failure'); return mode === 'ready'; } });
  await h.controller.check(); await h.controller.download();
  await h.controller.install(); assert.equal(h.controller.getState().status, 'downloaded'); assert.equal(h.controller.getState().error, undefined);
  mode = 'fail'; await h.controller.install(); assert.equal(h.controller.getState().status, 'downloaded'); assert.ok(h.controller.getState().error);
  assert.equal(h.updater.calls.some(Array.isArray), false);
  mode = 'ready'; await h.controller.install();
  assert.deepEqual(h.updater.calls.filter(Array.isArray), [['install', true, true]]); assert.equal(preparations, 3);
});

test('installation timeout and late updater errors recover once and leave a retryable downloaded update', async t => {
  const h = harness(t, { prepareInstall: async () => true });
  await h.controller.check(); await h.controller.download(); await h.controller.install();
  await h.clock.advance(120_000);
  assert.equal(h.controller.getState().status, 'downloaded'); assert.equal(h.recoveryCalls, 1);
  await h.controller.install(); h.updater.emit('error', new Error('negative fixture installer error')); await flush();
  assert.equal(h.controller.getState().status, 'downloaded'); assert.equal(h.recoveryCalls, 2);
  h.updater.emit('error', new Error('late duplicate')); await flush(); assert.equal(h.recoveryCalls, 2);
});

test('a new installation cannot overlap recovery from a failed installer', async t => {
  const recovery = deferred(); let preparations = 0;
  const h = harness(t, { prepareInstall: async () => { preparations += 1; return true; }, recoverInstall: () => recovery.promise });
  await h.controller.check(); await h.controller.download(); await h.controller.install();
  h.updater.emit('error', new Error('installer failed'));
  await h.controller.install(); assert.equal(preparations, 1);
  recovery.resolve(); await flush();
  await h.controller.install(); assert.equal(preparations, 2);
});

test('check timeout ignores late responses and synchronous failures can be retried', async t => {
  const h = harness(t); const delayed = deferred(); h.updater.checkImpl = () => delayed.promise;
  const first = h.controller.check(); await flush(); await h.clock.advance(30_000); await first;
  assert.equal(h.controller.getState().status, 'error');
  delayed.resolve(h.updater.result); await flush(); assert.equal(h.controller.getState().status, 'error');
  h.updater.checkImpl = () => { throw new Error('synchronous negative fixture'); };
  await h.controller.check(); assert.equal(h.controller.getState().status, 'error');
  h.updater.checkImpl = null; await h.controller.check(); assert.equal(h.controller.getState().status, 'available');
});

test('download timeout cancels its token and a fresh explicit retry can complete', async t => {
  const h = harness(t); await h.controller.check();
  const delayed = deferred(); h.updater.downloadImpl = () => delayed.promise;
  const first = h.controller.download(); await flush(); await h.clock.advance(20 * 60_000); await first;
  assert.equal(h.controller.getState().status, 'available'); assert.equal(h.updater.tokens[0].cancelled, true);
  delayed.resolve([h.file]); await flush(); assert.equal(h.controller.getState().status, 'available');
  h.updater.downloadImpl = null; await h.controller.download(); assert.equal(h.controller.getState().status, 'downloaded');
  assert.notEqual(h.updater.tokens[0], h.updater.tokens[1]);
});

test('disposing while confirmation is open cannot subsequently invoke an installer', async t => {
  const preparation = deferred();
  const h = harness(t, { prepareInstall: () => preparation.promise });
  await h.controller.check(); await h.controller.download();
  const operation = h.controller.install(); await flush();
  h.controller.dispose(); const emissions = h.states.length;
  preparation.resolve(true); await operation;
  assert.equal(h.updater.calls.some(Array.isArray), false);
  assert.equal(h.states.length, emissions); assert.equal(h.clock.jobs.size, 0);
  assert.equal(h.updater.listenerCount('download-progress'), 0); assert.equal(h.updater.listenerCount('error'), 1);
});

test('disposing before deferred work starts prevents both new network checks and downloads', async t => {
  const checking = harness(t);
  const pendingCheck = checking.controller.check(); checking.controller.dispose(); await pendingCheck;
  assert.equal(checking.updater.calls.includes('check'), false);
  const downloading = harness(t); await downloading.controller.check();
  const pendingDownload = downloading.controller.download(); downloading.controller.dispose(); await pendingDownload;
  assert.equal(downloading.updater.calls.includes('download'), false);
  assert.equal(downloading.clock.jobs.size, 0);
});

test('automatic cadence survives a timer firing while another update check is already in progress', async t => {
  const h = harness(t, { checkTimeoutMs: 120_000 }); const delayed = deferred(); h.updater.checkImpl = () => delayed.promise;
  h.controller.start();
  const manual = h.controller.check(); await flush();
  await h.clock.advance(STARTUP);
  delayed.resolve(h.updater.result); await manual; await flush();
  h.updater.checkImpl = null;
  const before = h.updater.calls.length;
  await h.clock.advance(INTERVAL);
  assert.equal(h.updater.calls.length, before + 1);
});

test('automatic checks resume after their timer encounters an ongoing download', async t => {
  const h = harness(t, { downloadTimeoutMs: INTERVAL * 3 });
  h.controller.start(); await h.clock.advance(STARTUP);
  const delayed = deferred(); h.updater.downloadImpl = () => delayed.promise;
  const download = h.controller.download(); await flush();
  await h.clock.advance(INTERVAL);
  assert.equal(h.updater.calls.filter(call => call === 'check').length, 1);
  delayed.reject(new Error('interrupted fixture download')); await download;
  await h.clock.advance(INTERVAL);
  assert.equal(h.updater.calls.filter(call => call === 'check').length, 2);
});

test('disabling automatic checks suppresses notification and rescheduling after an already-started check finishes', async t => {
  const h = harness(t); const delayed = deferred(); h.updater.checkImpl = () => delayed.promise;
  h.controller.start(); await h.clock.advance(STARTUP);
  h.controller.setAutomatic(false);
  delayed.resolve(h.updater.result); await flush();
  assert.equal(h.notifications.length, 0);
  assert.equal(h.preferences.read().automatic, false);
  assert.equal(h.clock.jobs.size, 0);
  await h.clock.advance(INTERVAL * 2);
  assert.equal(h.updater.calls.filter(call => call === 'check').length, 1);
});

test('IPC rejects foreign frames and all arbitrary arguments before invoking native operations', async () => {
  const owner = { frame: 'trusted board' }; const calls = [];
  const controller = Object.fromEntries(['getState', 'check', 'download', 'install', 'setAutomatic'].map(method => [method, (...args) => { calls.push([method, args]); return { supported: true }; }]));
  const handlers = updateHandlers({ controller, isBoard: event => event === owner });
  for (const [channel, handler] of Object.entries(handlers)) {
    assert.equal((await handler({ frame: 'foreign' }, ...(channel === UPDATE_CHANNELS.automatic ? [true] : []))).supported, false);
    assert.equal((await handler(owner, 'https://untrusted.example/update.exe')).supported, false);
    assert.equal((await handler(owner, { path: '/tmp/update.exe' })).supported, false);
    assert.equal((await handler(owner, true, false)).supported, false);
  }
  assert.deepEqual(calls, []);
  for (const channel of [UPDATE_CHANNELS.state, UPDATE_CHANNELS.check, UPDATE_CHANNELS.download, UPDATE_CHANNELS.install]) await handlers[channel](owner);
  assert.equal(handlers[UPDATE_CHANNELS.automatic](owner).supported, false);
  await handlers[UPDATE_CHANNELS.automatic](owner, false);
  assert.deepEqual(calls, [['getState', []], ['check', []], ['download', []], ['install', []], ['setAutomatic', [false]]]);
});
