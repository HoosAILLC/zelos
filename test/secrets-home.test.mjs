import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-secret-homes-'));
process.env.ZELOS_HOME = path.join(scratch, 'initial');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
const { describeCommand, setSecret, getSecret, deleteSecret, listRefs, resetBackendCache } = await import('../core/secrets.mjs');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function useHome(name) {
  process.env.ZELOS_HOME = path.join(scratch, name);
  fs.mkdirSync(process.env.ZELOS_HOME, { recursive: true });
  resetBackendCache();
  return process.env.ZELOS_HOME;
}

function addresses() {
  return ['macos-keychain', 'libsecret', 'windows-dpapi'].map((name) => {
    const command = describeCommand({ name, action: 'get', ref: 'model.default' });
    return name === 'windows-dpapi' ? command.env.ZELOS_SECRET_FILE : command.args.at(-1);
  });
}

test('independent homes have distinct OS credential identities which survive moving a home', (t) => {
  const priorLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(scratch, 'os-store');
  t.after(() => { if (priorLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = priorLocal; });
  const first = useHome('identity-personal');
  const personal = addresses();
  useHome('identity-work');
  const work = addresses();
  for (let i = 0; i < personal.length; i++) assert.notEqual(personal[i], work[i]);
  useHome('identity-personal');
  assert.deepEqual(addresses(), personal, 'restarting must keep the same identities');
  const moved = path.join(scratch, 'identity-moved');
  fs.renameSync(first, moved);
  process.env.ZELOS_HOME = moved;
  resetBackendCache();
  assert.deepEqual(addresses(), personal, 'moving the existing home must retain access');
});

test('a damaged credential namespace is reported without replacing it', () => {
  const home = useHome('damaged-namespace');
  const file = path.join(home, 'secrets.namespace.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => addresses(), /namespace/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

const needsExecutableStub = process.platform === 'win32'
  ? 'the fake secret-tool is a POSIX executable; backend address separation is tested on every OS'
  : false;

function fakeKeyring(t, name, { gateLegacy = false } = {}) {
  const directory = path.join(scratch, name);
  fs.mkdirSync(directory);
  const database = path.join(directory, 'keyring.json');
  const file = path.join(directory, 'secret-tool');
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--audit-stub') { console.log('isolated-keyring'); process.exit(0); }
const file = ${JSON.stringify(database)};
const gate = ${JSON.stringify(gateLegacy)};
const started = ${JSON.stringify(path.join(directory, 'legacy-read-started'))};
const released = ${JSON.stringify(path.join(directory, 'legacy-read-released'))};
const mutation = ${JSON.stringify(path.join(directory, 'mutation-started'))};
let entries = {}; try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const key = args[args.indexOf('service') + 1] + '|' + args[args.indexOf('account') + 1];
if (args[0] === 'store') {
  entries[key] = fs.readFileSync(0, 'utf8').replace(/\\n$/, '');
  fs.writeFileSync(file, JSON.stringify(entries));
  if (entries[key] === 'replacement-test-key') fs.writeFileSync(mutation, 'set');
} else if (args[0] === 'lookup') {
  if (!(key in entries)) process.exit(1);
  if (gate && key === 'com.zelos.app|model.default') {
    fs.writeFileSync(started, 'reading');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(released) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(released)) process.exit(2);
  }
  console.log(entries[key]);
} else if (args[0] === 'clear') {
  fs.writeFileSync(mutation, 'delete');
  if (!(key in entries)) process.exit(1);
  delete entries[key]; fs.writeFileSync(file, JSON.stringify(entries));
} else process.exit(2);
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = directory + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; resetBackendCache(); });
  assert.equal(spawnSync('secret-tool', ['--audit-stub'], { encoding: 'utf8' }).stdout.trim(), 'isolated-keyring',
    'prove the fake binary is selected before allowing any credential operation');
  process.env.ZELOS_SECRETS_BACKEND = 'libsecret';
  resetBackendCache();
  return database;
}

test('saving and deleting the same ref in a new home never reads or changes another home', { skip: needsExecutableStub }, async (t) => {
  fakeKeyring(t, 'separate-keyring');
  useHome('personal');
  await setSecret('model.default', 'personal-test-key');
  useHome('work');
  assert.equal(await getSecret('model.default'), null);
  assert.deepEqual(await deleteSecret('model.default'), { ok: true, deleted: false });
  await setSecret('model.default', 'work-test-key');
  useHome('personal');
  assert.equal(await getSecret('model.default'), 'personal-test-key');
  useHome('work');
  await deleteSecret('model.default');
  assert.deepEqual(await listRefs(), []);
  useHome('personal');
  assert.equal(await getSecret('model.default'), 'personal-test-key');
  assert.deepEqual(await listRefs(), ['model.default']);
});

test('legacy indexed credentials remain readable until an explicit scoped save, without changing another legacy home', { skip: needsExecutableStub }, async (t) => {
  const database = fakeKeyring(t, 'legacy-keyring');
  fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
  for (const name of ['legacy-personal', 'legacy-work']) {
    const home = useHome(name);
    fs.writeFileSync(path.join(home, 'secrets.index.json'), JSON.stringify({ refs: ['model.default'] }));
  }
  useHome('legacy-personal');
  assert.deepEqual(await listRefs(), ['model.default']);
  assert.equal(await getSecret('model.default'), 'legacy-test-key');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(database, 'utf8'))), ['com.zelos.app|model.default'],
    'legacy compatibility reads must not write a scoped replacement');
  await setSecret('model.default', 'personal-replacement');
  useHome('legacy-work');
  assert.equal(await getSecret('model.default'), 'legacy-test-key');
  await deleteSecret('model.default');
  assert.equal(await getSecret('model.default'), null, 'a deletion must not resurrect the legacy ref');
  useHome('legacy-personal');
  assert.equal(await getSecret('model.default'), 'personal-replacement');
  assert.equal(JSON.parse(fs.readFileSync(database, 'utf8'))['com.zelos.app|model.default'], 'legacy-test-key');
  useHome('unrelated-new-home');
  assert.equal(await getSecret('model.default'), null, 'new homes never inherit legacy credentials');
});

test('a damaged legacy index cannot create an empty migration record, and restoring it recovers access', { skip: needsExecutableStub }, async (t) => {
  const database = fakeKeyring(t, 'damaged-index-keyring');
  const home = useHome('damaged-index-home');
  const index = path.join(home, 'secrets.index.json');
  const namespace = path.join(home, 'secrets.namespace.json');
  fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
  fs.writeFileSync(index, '{corrupt');
  await assert.rejects(getSecret('model.default'), /index/i);
  assert.equal(fs.existsSync(namespace), false, 'do not permanently record an empty legacy ref list');
  assert.equal(fs.readFileSync(index, 'utf8'), '{corrupt', 'leave the damaged index available for recovery');
  fs.writeFileSync(index, JSON.stringify({ refs: ['model.default'] }));
  assert.equal(await getSecret('model.default'), 'legacy-test-key');
  assert.deepEqual(await listRefs(), ['model.default']);
});

for (const action of ['set', 'delete']) {
  test(`a ${action} queued during a legacy read preserves the newest credential state`, { skip: needsExecutableStub }, async (t) => {
    const database = fakeKeyring(t, `race-${action}-keyring`, { gateLegacy: true });
    const home = useHome(`race-${action}-home`);
    fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
    fs.writeFileSync(path.join(home, 'secrets.index.json'), JSON.stringify({ refs: ['model.default'] }));
    const directory = path.dirname(database);
    const released = path.join(directory, 'legacy-read-released');
    const waitFor = async (file, milliseconds) => {
      const deadline = Date.now() + milliseconds;
      while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      return fs.existsSync(file);
    };
    const read = getSecret('model.default');
    assert.equal(await waitFor(path.join(directory, 'legacy-read-started'), 3000), true);
    const change = action === 'set'
      ? setSecret('model.default', 'replacement-test-key')
      : deleteSecret('model.default');
    // Without serialization the mutation reaches the backend while the old
    // value is held above. With serialization it queues, so release after the
    // bounded wait and let the queued mutation follow the read.
    await waitFor(path.join(directory, 'mutation-started'), 1000);
    fs.writeFileSync(released, 'continue');
    await Promise.all([read, change]);
    assert.equal(await getSecret('model.default'), action === 'set' ? 'replacement-test-key' : null);
  });

  test(`a ${action} in another process is not overwritten by an older legacy read`, { skip: needsExecutableStub }, async (t) => {
    const database = fakeKeyring(t, `process-race-${action}-keyring`, { gateLegacy: true });
    const home = useHome(`process-race-${action}-home`);
    fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
    fs.writeFileSync(path.join(home, 'secrets.index.json'), JSON.stringify({ refs: ['model.default'] }));
    const directory = path.dirname(database);
    const started = path.join(directory, 'legacy-read-started');
    const released = path.join(directory, 'legacy-read-released');
    const read = getSecret('model.default');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(fs.existsSync(started), true, 'hold the old read before the other process changes the key');
    let change;
    try {
      const script = `
        const { setSecret, deleteSecret } = await import(${JSON.stringify(new URL('../core/secrets.mjs', import.meta.url).href)});
        ${action === 'set' ? "await setSecret('model.default', 'replacement-test-key');" : "await deleteSecret('model.default');"}
      `;
      change = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    } finally {
      fs.writeFileSync(released, 'continue');
    }
    await read;
    assert.equal(change.status, 0, change.stderr || change.error?.message);
    assert.equal(await getSecret('model.default'), action === 'set' ? 'replacement-test-key' : null);
    assert.equal(JSON.parse(fs.readFileSync(database, 'utf8'))['com.zelos.app|model.default'], 'legacy-test-key',
      'other legacy homes keep their shared key');
  });
}
