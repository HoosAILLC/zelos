import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Quiet the shared logger before core/log.mjs is evaluated, and make absolutely
// sure nothing in this file can reach the real ~/.zelos.
process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-config-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const { DEFAULTS, MAIL_ACCOUNT_DEFAULTS, paths, loadConfig, saveConfig, validateConfig, newId, isValidRef } =
  await import('../core/config.mjs');

const mode = (p) => fs.statSync(p).mode & 0o777;

/**
 * POSIX modes are the whole at-rest story on macOS and Linux, and Windows does
 * not implement them: fs.chmod there sets little more than the read-only flag,
 * and fs.stat reports a synthesised 0777/0666 no matter what Zelos asked for.
 * A `0700` assertion on Windows would therefore succeed or fail for reasons
 * that have nothing to do with the guarantee it exists to protect, so the mode
 * claims are split out and skipped there by name rather than being weakened
 * for every platform to accommodate one. docs/SECURITY.md §5 tells the user the
 * same thing: on Windows the real access control is the NTFS ACL the user
 * profile already carries, which Zelos does not currently set.
 *
 * node:test prints this string as the reason, so a reader of the Windows run
 * learns why the gap is there instead of finding a silent hole.
 */
const WINDOWS_NO_POSIX_MODES = process.platform === 'win32'
  ? 'POSIX modes are not implemented on Windows: chmod sets little more than the read-only flag, so this could not assert what it claims (docs/SECURITY.md §5)'
  : false;

function freshHome(name) {
  const home = path.join(HOME_ROOT, name);
  process.env.ZELOS_HOME = home;
  return home;
}

/**
 * Point the platform's idea of "the user's home" at a sandbox. os.homedir()
 * reads $HOME on macOS and Linux and %USERPROFILE% on Windows, so a test that
 * only sets HOME leaves Windows resolving the fallback home to the real
 * profile — and paths() would then create a live ~/.zelos on the CI runner.
 * Both are set, and both are restored to *absence* rather than to the string
 * "undefined", which is what assigning an undefined value to process.env does.
 */
function withSandboxedUserHome(dir, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.after(() => {
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('paths() creates the home where it says and never touches the real one', () => {
  const home = freshHome('paths');
  const p = paths();

  assert.equal(p.home, home);
  assert.equal(p.configFile, path.join(home, 'config.json'));
  assert.equal(p.db, path.join(home, 'zelos.db'));
  assert.equal(p.logsDir, path.join(home, 'logs'));
  assert.equal(p.cacheDir, path.join(home, 'cache'));

  // That the three directories are created at all is the half that matters on
  // every platform, and it used to be asserted only as a side effect of asking
  // for their mode — which left nothing checking it where modes are a fiction.
  for (const dir of [p.home, p.logsDir, p.cacheDir]) {
    assert.ok(fs.statSync(dir).isDirectory(), `${dir} must exist as a directory`);
  }
  assert.ok(!p.home.includes(os.homedir() + path.sep + '.zelos'));
});

test('paths() creates the home, logs and cache at 0700', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  freshHome('paths-mode');
  const p = paths();
  assert.equal(mode(p.home), 0o700);
  assert.equal(mode(p.logsDir), 0o700);
  assert.equal(mode(p.cacheDir), 0o700);
});

test('paths() treats ZELOS_HOME=undefined as no override, not a directory name', () => {
  // A launcher that interpolates an unset variable produces the literal
  // string "undefined" — the old code resolved it to <cwd>/undefined and put
  // a real data directory there. The user's home is sandboxed so the fallback
  // lands inside HOME_ROOT instead of the real ~/.zelos on any platform.
  const fakeHome = path.join(HOME_ROOT, 'fake-user');
  try {
    withSandboxedUserHome(fakeHome, () => {
      for (const junk of ['undefined', 'null', ' Undefined ', 'NULL']) {
        process.env.ZELOS_HOME = junk;
        const p = paths();
        assert.equal(p.home, path.join(fakeHome, '.zelos'), JSON.stringify(junk));
        assert.ok(!fs.existsSync(path.resolve(process.cwd(), junk.trim())), JSON.stringify(junk));
      }
    });
  } finally {
    freshHome('after-junk');
  }
});

test('paths() tightens a home somebody left world-readable', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  const home = freshHome('loose');
  fs.mkdirSync(home, { recursive: true, mode: 0o755 });
  fs.chmodSync(home, 0o755);
  assert.equal(mode(home), 0o755);

  paths();
  assert.equal(mode(home), 0o700);
});

/**
 * The Windows-meaningful half of the test above. Tightening cannot be observed
 * there, but the code path that would do the tightening still runs on every
 * launch — ensureDir() stats an existing directory, sees the 0777 Windows
 * synthesises, and calls chmod on it. If that ever threw, Zelos would refuse to
 * start on Windows for a directory that was perfectly fine.
 */
test('paths() adopts a home that already exists instead of failing on it', () => {
  const home = freshHome('pre-existing');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });

  const p = paths();
  assert.equal(p.home, home);
  assert.ok(fs.statSync(p.cacheDir).isDirectory(), 'the missing sibling is filled in');
  assert.equal(paths().home, home, 'and a second call is a no-op, not an error');
});

test('loadConfig() returns the full default shape with a resolved timezone', () => {
  freshHome('load-defaults');
  const cfg = loadConfig();

  assert.equal(cfg.version, 1);
  assert.equal(cfg.model.protocol, 'anthropic');
  assert.equal(cfg.model.keyRef, 'model.default');
  assert.deepEqual(cfg.mail, []);
  assert.deepEqual(cfg.calendars, []);
  assert.deepEqual(cfg.sweep, { intervalMinutes: 30, activeHours: [6, 23], auto: true });
  assert.equal(cfg.privacy.sendBodies, true);
  assert.ok(cfg.identity.timezone.length > 0, 'timezone is filled from Intl when blank');

  // Mutating the result must not poison the next caller.
  cfg.model.maxTokens = 1;
  assert.equal(loadConfig().model.maxTokens, 8192);
  assert.equal(DEFAULTS.model.maxTokens, 8192);
  assert.ok(Object.isFrozen(DEFAULTS));
});

test('saveConfig() deep-merges and leaves untouched keys alone', () => {
  const home = freshHome('save');
  saveConfig({ identity: { name: 'Nemo' }, model: { model: 'claude-x', maxTokens: 4096 } });
  const after = saveConfig({ model: { temperature: 0.4 } });

  assert.equal(after.identity.name, 'Nemo');
  assert.equal(after.model.model, 'claude-x');
  assert.equal(after.model.maxTokens, 4096, 'second save must not reset the first');
  assert.equal(after.model.temperature, 0.4);

  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(onDisk.model.model, 'claude-x');
  assert.equal(onDisk.identity.timezone, '', 'a timezone resolved at runtime is not frozen into the file');
});

test('saveConfig() writes config.json 0600', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  const home = freshHome('save-mode');
  saveConfig({ identity: { name: 'Nemo' } });
  assert.equal(mode(path.join(home, 'config.json')), 0o600);
});

test('saveConfig() replaces arrays wholesale so an account can be removed', () => {
  freshHome('arrays');
  const two = saveConfig({
    mail: [
      { id: 'm_aaa', host: 'a.example', user: 'a@example.com' },
      { id: 'm_bbb', host: 'b.example', user: 'b@example.com' },
    ],
  });
  assert.equal(two.mail.length, 2);
  assert.equal(two.mail[0].port, 993, 'account defaults are filled in');
  assert.equal(two.mail[0].keyRef, 'mail.m_aaa', 'keyRef derives from the account id');
  assert.deepEqual(two.mail[0].mailboxes, ['INBOX']);

  const one = saveConfig({ mail: [{ id: 'm_bbb', host: 'b.example', user: 'b@example.com' }] });
  assert.equal(one.mail.length, 1);
  assert.equal(one.mail[0].id, 'm_bbb');
});

test('accounts without an id get one, and it is stable across loads', () => {
  freshHome('ids');
  const saved = saveConfig({ mail: [{ host: 'imap.example', user: 'x@example.com' }] });
  const id = saved.mail[0].id;
  assert.match(id, /^m_[0-9a-f]{6}$/);
  assert.equal(loadConfig().mail[0].id, id);
});

test('a secret handed to saveConfig() never reaches the disk', () => {
  const home = freshHome('secrets');
  const cfg = saveConfig({
    model: { apiKey: 'sk-ant-should-never-persist', keyRef: 'model.default' },
    mail: [{ id: 'm_ccc', host: 'imap.example', user: 'u@example.com', pass: 'hunter2', keyRef: 'mail.m_ccc' }],
  });

  assert.equal(cfg.model.apiKey, undefined);
  assert.equal(cfg.mail[0].pass, undefined);
  assert.equal(cfg.mail[0].keyRef, 'mail.m_ccc');

  const text = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('sk-ant-should-never-persist'));
  assert.ok(!/"pass"|"apiKey"/.test(text));
});

test('a write that dies before the rename leaves the old config intact', () => {
  const home = freshHome('atomic');
  const file = path.join(home, 'config.json');
  saveConfig({ identity: { name: 'Original' }, model: { model: 'first' } });
  const before = fs.readFileSync(file, 'utf8');

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated crash between write and rename'); };
  try {
    assert.throws(() => saveConfig({ identity: { name: 'Replacement' } }), /simulated crash/);
  } finally {
    fs.renameSync = realRename;
  }

  // Old contents byte-for-byte, still parseable, and no debris left behind.
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(JSON.parse(before).identity.name, 'Original');
  assert.equal(loadConfig().identity.name, 'Original');
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);

  // And the next save still works.
  assert.equal(saveConfig({ identity: { name: 'Replacement' } }).identity.name, 'Replacement');
});

test('a truncated temp file from an earlier crash is ignored', () => {
  const home = freshHome('debris');
  saveConfig({ identity: { name: 'Survivor' } });
  fs.writeFileSync(path.join(home, '.config.json.4242.deadbeef.tmp'), '{"identity":{"name":"Half-writ');

  assert.equal(loadConfig().identity.name, 'Survivor');
  assert.equal(saveConfig({ model: { model: 'still-fine' } }).identity.name, 'Survivor');
});

test('an unparseable config is moved aside rather than silently obeyed', () => {
  const home = freshHome('corrupt');
  const file = path.join(home, 'config.json');
  saveConfig({ identity: { name: 'Before' } });
  fs.writeFileSync(file, '{"identity": {"name": "trunc');

  const cfg = loadConfig();
  assert.equal(cfg.identity.name, '', 'falls back to defaults');
  const aside = fs.readdirSync(home).filter((f) => f.startsWith('config.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.match(fs.readFileSync(path.join(home, aside[0]), 'utf8'), /trunc/);
});

test('validateConfig() passes a real config and names every bad field', () => {
  freshHome('validate');
  const good = saveConfig({
    identity: { name: 'Nemo', email: 'nemo@example.com', timezone: 'America/Indianapolis' },
    model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', keyRef: 'model.default' },
    mail: [{ id: 'm_ddd', host: 'imap.example.com', user: 'nemo@example.com', keyRef: 'mail.m_ddd' }],
    calendars: [{ id: 'c_eee', kind: 'ics', url: 'https://cal.example.com/x.ics' }],
  });
  assert.deepEqual(validateConfig(good), { ok: true, errors: [] });

  const bad = validateConfig({
    ...good,
    version: 0,
    identity: { name: 'Nemo', email: 'not-an-email', timezone: 'Mars/Olympus_Mons' },
    model: { ...good.model, protocol: 'telepathy', baseUrl: 'ftp://nope', maxTokens: 0, temperature: 9, keyRef: 'bad ref!' },
    mail: [{ ...good.mail[0], port: 99999, lookbackDays: 0, mailboxes: [] }],
    calendars: [{ ...good.calendars[0], kind: 'runes', url: 'javascript:alert(1)' }],
    sweep: { intervalMinutes: 1, activeHours: [23, 6], auto: 'yes' },
    ui: { accent: 'neon' },
    privacy: { maxItemsPerSweep: 0, sendBodies: 1, bodyChars: 5 },
  });

  assert.equal(bad.ok, false);
  const at = bad.errors.map((e) => e.path);
  for (const p of [
    'version', 'identity.email', 'identity.timezone',
    'model.protocol', 'model.baseUrl', 'model.maxTokens', 'model.temperature', 'model.keyRef',
    'mail[0].port', 'mail[0].lookbackDays', 'mail[0].mailboxes',
    'calendars[0].kind', 'sweep.intervalMinutes', 'sweep.activeHours', 'sweep.auto',
    'ui.accent', 'privacy.maxItemsPerSweep', 'privacy.sendBodies', 'privacy.bodyChars',
  ]) {
    assert.ok(at.includes(p), `expected an error at ${p}, got ${at.join(', ')}`);
  }
  for (const e of bad.errors) assert.equal(typeof e.message, 'string');
});

test('validateConfig() rejects a config carrying a credential', () => {
  freshHome('validate-secret');
  const cfg = loadConfig();
  cfg.mail = [{ ...MAIL_ACCOUNT_DEFAULTS, id: 'm_fff', host: 'h', user: 'u', keyRef: 'mail.m_fff', password: 'hunter2' }];
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path === 'mail[0].password' && /secret store/.test(e.message)));
});

test('validateConfig() rejects non-objects and duplicate ids', () => {
  freshHome('validate-shape');
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig('nope').errors[0].path, '');

  const cfg = saveConfig({ mail: [{ id: 'm_dup', host: 'a', user: 'a' }] });
  cfg.mail.push({ ...cfg.mail[0] });
  assert.ok(validateConfig(cfg).errors.some((e) => /duplicate account id/.test(e.message)));
});

test('newId() and isValidRef()', () => {
  assert.match(newId('m'), /^m_[0-9a-f]{6}$/);
  assert.notEqual(newId('c'), newId('c'));
  assert.throws(() => newId('M'), TypeError);
  assert.throws(() => newId('mail account'), TypeError);
  assert.throws(() => newId(''), TypeError);

  assert.ok(isValidRef('model.default'));
  assert.ok(isValidRef('mail.m_9f3a1c'));
  assert.ok(!isValidRef('../escape'));
  assert.ok(!isValidRef('has space'));
  assert.ok(!isValidRef(''));
  assert.ok(!isValidRef('a'.repeat(65)));
});

/**
 * REGRESSION. A mail account with `secure: false` upgraded to TLS only if the
 * server said it could, so a capability list with STARTTLS stripped out of it
 * got the password in the clear and nobody was told. `requireTls` is the
 * standing instruction about that, and it has to survive a config written
 * before it existed — which is every config there is.
 */
test('requireTls defaults to "decide from the host" and is never pinned on the way in', () => {
  freshHome('require-tls');
  assert.equal(MAIL_ACCOUNT_DEFAULTS.requireTls, null);

  const saved = saveConfig({ mail: [{ host: 'imap.example.com', user: 'nemo@example.com' }] });
  assert.equal(saved.mail[0].requireTls, null,
    'an account written before the option existed must not be frozen to a boolean');
  assert.equal(validateConfig(saved).ok, true, JSON.stringify(validateConfig(saved).errors));

  // The account is later pointed at a local bridge and told to allow cleartext.
  const off = saveConfig({ mail: [{ ...saved.mail[0], host: '127.0.0.1', port: 1143, secure: false, requireTls: false }] });
  assert.equal(off.mail[0].requireTls, false, 'an explicit permission has to round-trip through a save');
  assert.equal(validateConfig(off).ok, true);

  const on = saveConfig({ mail: [{ ...off.mail[0], requireTls: true }] });
  assert.equal(on.mail[0].requireTls, true);
  assert.equal(validateConfig(on).ok, true);
});

test('requireTls accepts only true, false and null', () => {
  freshHome('require-tls-validate');
  const base = saveConfig({ mail: [{ host: 'imap.example.com', user: 'nemo@example.com' }] });
  for (const junk of ['yes', 'false', 0, 1, {}, []]) {
    const cfg = structuredClone(base);
    cfg.mail[0].requireTls = junk;
    const result = validateConfig(cfg);
    assert.equal(result.ok, false, JSON.stringify(junk));
    assert.ok(result.errors.some((e) => e.path === 'mail[0].requireTls'), JSON.stringify(junk));
  }
});
