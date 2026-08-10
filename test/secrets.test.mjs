import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-secrets-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const secrets = await import('../core/secrets.mjs');
const {
  backend, setSecret, getSecret, deleteSecret, listRefs,
  describeCommand, resetBackendCache, SERVICE,
} = secrets;

const mode = (p) => fs.statSync(p).mode & 0o777;

/**
 * POSIX modes are the whole at-rest story on macOS and Linux, and Windows does
 * not implement them: fs.chmod there sets little more than the read-only flag,
 * and fs.stat reports a synthesised 0666 no matter what Zelos asked for. A
 * `0600` assertion on Windows would therefore succeed or fail for reasons that
 * have nothing to do with the guarantee it exists to protect, so the mode
 * claims are split out and skipped there by name rather than being weakened for
 * every platform to accommodate one. docs/SECURITY.md §5 and §7 say the same
 * thing to the user: on Windows the protection of the fallback store is its
 * encryption, not its mode.
 *
 * node:test prints this string as the reason, so a reader of the Windows run
 * learns why the gap is there instead of finding a silent hole.
 */
const WINDOWS_NO_POSIX_MODES = process.platform === 'win32'
  ? 'POSIX modes are not implemented on Windows: chmod sets little more than the read-only flag, so this could not assert what it claims (docs/SECURITY.md §5)'
  : false;

function useHome(name) {
  process.env.ZELOS_HOME = path.join(HOME_ROOT, name);
  resetBackendCache();
}

function forceFallback(name) {
  useHome(name);
  process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
  resetBackendCache();
}

function unforce() {
  delete process.env.ZELOS_SECRETS_BACKEND;
  resetBackendCache();
}

test.after(() => {
  delete process.env.ZELOS_SECRETS_BACKEND;
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------- argv containment */

test('no command line can carry a secret — describeCommand never receives one', () => {
  // The structural guarantee: the only function that builds argv takes a
  // backend, an action and a ref. There is no parameter a value could ride in.
  assert.equal(describeCommand.length, 1);
  const arg = describeCommand.toString().match(/\(\s*\{([^}]*)\}/)[1];
  assert.match(arg, /name/);
  assert.match(arg, /action/);
  assert.match(arg, /ref/);
  assert.ok(!/value|password|secret/i.test(arg), `describeCommand takes no value: ${arg}`);

  for (const name of ['macos-keychain', 'windows-dpapi', 'libsecret', 'encrypted-file']) {
    for (const action of ['set', 'get', 'has', 'delete']) {
      const desc = describeCommand({ name, action, ref: 'mail.m_9f3a1c' });
      if (!desc) continue;
      for (const a of desc.args) {
        assert.equal(typeof a, 'string');
        assert.ok(!/hunter2/.test(a));
      }
      assert.ok(desc.args.includes('mail.m_9f3a1c') || name === 'windows-dpapi');
    }
  }
});

test('macOS argv matches the spec, and the value is written to stdin twice', () => {
  const set = describeCommand({ name: 'macos-keychain', action: 'set', ref: 'model.default' });
  assert.equal(set.file, '/usr/bin/security');
  assert.deepEqual(set.args, ['add-generic-password', '-U', '-s', SERVICE, '-a', 'model.default', '-w']);
  assert.equal(set.args.at(-1), '-w', 'nothing may follow -w');
  // security prompts "password data" AND "retype password"; one write leaves an
  // empty password stored with exit code 0.
  assert.equal(set.stdinWrites, 2);

  const get = describeCommand({ name: 'macos-keychain', action: 'get', ref: 'model.default' });
  assert.deepEqual(get.args, ['find-generic-password', '-g', '-s', SERVICE, '-a', 'model.default']);
  assert.equal(get.stdinWrites, 0);
  assert.equal(get.stderrSafe, false, '-g prints the password on stderr; it must never be logged');

  assert.equal(describeCommand({ name: 'macos-keychain', action: 'delete', ref: 'model.default' }).args[0], 'delete-generic-password');
  assert.throws(() => describeCommand({ name: 'macos-keychain', action: 'exfiltrate', ref: 'model.default' }), TypeError);
  assert.throws(() => describeCommand({ name: 'macos-keychain', action: 'get', ref: '../../etc/passwd' }), TypeError);
});

test('Windows DPAPI passes an encoded script and the path by env, never the value', () => {
  const set = describeCommand({ name: 'windows-dpapi', action: 'set', ref: 'mail.m_1' });
  assert.equal(set.file, 'powershell.exe');
  assert.ok(set.args.includes('-NoProfile') && set.args.includes('-NonInteractive'));
  const script = Buffer.from(set.args[set.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  // The value arrives on stdin, and the script decodes those bytes as UTF-8
  // itself. Reading through [Console]::In instead would decode with whatever
  // code page the machine's locale sets, which round-trips by accident on a
  // single-byte locale and corrupts non-ASCII on a Japanese or Chinese one.
  assert.match(script, /OpenStandardInput\(\)/, 'the value arrives on stdin');
  assert.match(script, /UTF8\.GetString/, 'and is decoded as UTF-8 rather than by locale');
  assert.ok(!/\[Console\]::In\b/.test(script), 'Console.In would inherit the console code page');
  assert.match(script, /ConvertFrom-SecureString/);
  assert.ok(!/-Key\b/.test(script), 'CurrentUser DPAPI scope, not a hardcoded key');
  assert.match(set.env.ZELOS_SECRET_FILE, /Zelos[\\/]secrets[\\/]mail\.m_1\.dpapi$/);
  assert.equal(set.stdinWrites, 1);

  const get = describeCommand({ name: 'windows-dpapi', action: 'get', ref: 'mail.m_1' });
  const getScript = Buffer.from(get.args.at(-1), 'base64').toString('utf16le');
  assert.match(getScript, /SecureStringToBSTR/);
  // Same argument in the other direction: the value leaves as UTF-8 bytes.
  assert.match(getScript, /UTF8\.GetBytes/, 'the value is encoded as UTF-8 on the way out');
  assert.ok(!/\[Console\]::Out\b/.test(getScript), 'Console.Out would use the console code page');
  assert.equal(describeCommand({ name: 'windows-dpapi', action: 'delete', ref: 'mail.m_1' }), null);
});

test('libsecret argv matches secret-tool, value on stdin', () => {
  const set = describeCommand({ name: 'libsecret', action: 'set', ref: 'mail.m_2' });
  assert.deepEqual(set.args, ['store', '--label=Zelos', 'service', SERVICE, 'account', 'mail.m_2']);
  assert.equal(set.stdinWrites, 1);
  assert.deepEqual(describeCommand({ name: 'libsecret', action: 'get', ref: 'mail.m_2' }).args,
    ['lookup', 'service', SERVICE, 'account', 'mail.m_2']);
  assert.deepEqual(describeCommand({ name: 'libsecret', action: 'delete', ref: 'mail.m_2' }).args,
    ['clear', 'service', SERVICE, 'account', 'mail.m_2']);
});

test('the module exposes no way to enumerate values', () => {
  const exported = Object.keys(secrets).sort();
  for (const forbidden of ['listSecrets', 'getAllSecrets', 'dumpSecrets', 'exportSecrets', 'allSecrets']) {
    assert.ok(!exported.includes(forbidden), `${forbidden} must not exist`);
  }
  assert.ok(exported.includes('listRefs'));
});

/* ------------------------------------------------ encrypted-file fallback */

test('encrypted-file fallback: honest note, real round-trip', async () => {
  forceFallback('fallback');
  const home = process.env.ZELOS_HOME;

  const b = await backend();
  assert.equal(b.name, 'encrypted-file');
  assert.equal(b.writable, true);
  assert.match(b.note, /AES-256-GCM/);
  assert.match(b.note, /does NOT protect against a process already running as this user/);

  const value = 'sk-ant-api03-Ω-"quoted"-\\slash-hunter2';
  await setSecret('model.default', value);
  assert.equal(await getSecret('model.default'), value);

  const store = path.join(home, 'secrets.enc');
  const seed = path.join(home, '.seed');
  assert.match(fs.readFileSync(seed, 'utf8').trim(), /^[0-9a-f]{64}$/);

  const raw = fs.readFileSync(store, 'utf8');
  assert.ok(!raw.includes('hunter2'), 'plaintext must not appear in the store');
  assert.ok(!raw.includes('sk-ant'), 'plaintext must not appear in the store');
  const env = JSON.parse(raw);
  assert.equal(env.kdf.name, 'scrypt');
  assert.equal(env.kdf.N, 32768);
  assert.match(env.kdf.salt, /^[0-9a-f]{32}$/);
  assert.match(env.iv, /^[0-9a-f]{24}$/);
  assert.match(env.tag, /^[0-9a-f]{32}$/);

  await setSecret('mail.m_9f3a1c', 'imap-password');
  assert.deepEqual(await listRefs(), ['mail.m_9f3a1c', 'model.default']);
  assert.equal(await getSecret('model.default'), value, 'a second secret does not disturb the first');

  await setSecret('model.default', 'replaced');
  assert.equal(await getSecret('model.default'), 'replaced');

  assert.deepEqual(await deleteSecret('model.default'), { ok: true, deleted: true });
  assert.equal(await getSecret('model.default'), null);
  assert.deepEqual(await listRefs(), ['mail.m_9f3a1c']);
  assert.deepEqual(await deleteSecret('model.default'), { ok: true, deleted: false });
});

test('encrypted-file fallback: the store and the seed are 0600', { skip: WINDOWS_NO_POSIX_MODES }, async () => {
  // The seed matters as much as the store: it is the key, it sits beside the
  // ciphertext, and a mode that let another account read it would give away
  // everything the encryption was protecting.
  forceFallback('fallback-modes');
  const home = process.env.ZELOS_HOME;
  await setSecret('model.default', 'sk-ant-api03-mode-check');

  assert.equal(mode(path.join(home, 'secrets.enc')), 0o600);
  assert.equal(mode(path.join(home, '.seed')), 0o600);
});

test('encrypted-file fallback: a tampered ciphertext fails closed', async () => {
  forceFallback('tampered');
  const home = process.env.ZELOS_HOME;
  await setSecret('model.default', 'original-value');

  const file = path.join(home, 'secrets.enc');
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ct = Buffer.from(env.ct, 'base64');
  ct[0] ^= 0xff; // flip a bit: GCM must reject it, not hand back garbage
  fs.writeFileSync(file, JSON.stringify({ ...env, ct: ct.toString('base64') }));

  assert.equal(await getSecret('model.default'), null);
  const aside = fs.readdirSync(home).filter((f) => f.startsWith('secrets.enc.unreadable-'));
  assert.equal(aside.length, 1, 'the unreadable ciphertext is preserved, not deleted');

  // The user can carry on: a fresh store is written on the next set.
  await setSecret('model.default', 'new-value');
  assert.equal(await getSecret('model.default'), 'new-value');
});

test('encrypted-file fallback: a lost seed cannot be brute-forced from the file', async () => {
  forceFallback('seedless');
  await setSecret('model.default', 'value-behind-the-seed');
  const home = process.env.ZELOS_HOME;
  const before = fs.readFileSync(path.join(home, 'secrets.enc'), 'utf8');

  fs.rmSync(path.join(home, '.seed'));
  assert.equal(await getSecret('model.default'), null, 'no seed, no plaintext');
  const aside = fs.readdirSync(home).find((f) => f.startsWith('secrets.enc.unreadable-'));
  assert.equal(fs.readFileSync(path.join(home, aside), 'utf8'), before, 'the old ciphertext is kept as-is');
});

test('refs and values are validated before anything is spawned', async () => {
  forceFallback('validation');
  await assert.rejects(() => setSecret('../etc/passwd', 'x'), TypeError);
  await assert.rejects(() => setSecret('has space', 'x'), TypeError);
  await assert.rejects(() => setSecret('model.default', ''), TypeError);
  await assert.rejects(() => setSecret('model.default', 42), TypeError);
  await assert.rejects(() => setSecret('model.default', 'has\0nul'), TypeError);
  await assert.rejects(() => getSecret('nope!'), TypeError);
  await assert.rejects(() => deleteSecret('nope!'), TypeError);
});

/* --------------------------------------------- the backend this machine uses */

/**
 * These two let detection run, which means they use the REAL credential store
 * of whatever machine they are on — the operator's login keychain on macOS,
 * their keyring on Linux, their DPAPI profile on Windows. They write an item
 * and delete it, under a ref of their own, so nothing of the user's is touched.
 * It is still their keychain, and running a project's tests should not put
 * anything in it.
 *
 * So they are held to the same gate as the live DPAPI round-trip below: a
 * throwaway CI runner, or not at all. On a developer's own machine the
 * encrypted-file fallback tests above cover the same store-read-delete contract
 * without leaving the repository.
 *
 * test/repo.test.mjs has a guard for this, but it is textual — it checks that a
 * file mentions ZELOS_SECRETS_BACKEND, which this file does, so it passed while
 * these two tests quietly opted back out. The guard now looks for the opt-out
 * as well; this comment exists so the next person to add an `unforce()` knows
 * why it is watched.
 */
const REAL_STORE_ONLY_ON_CI = process.env.CI
  ? false
  : "this test uses the machine's real credential store, so it runs only on a throwaway CI runner "
    + '(set CI=1 if you genuinely want it to touch your keychain)';

test('this machine\'s real backend round-trips a hostile-looking value', { skip: REAL_STORE_ONLY_ON_CI }, async (t) => {
  useHome('native');
  unforce();
  const b = await backend();

  if (b.name === 'encrypted-file') {
    t.diagnostic('no system keychain on this machine; the fallback is covered above');
    return;
  }
  assert.equal(b.name, { darwin: 'macos-keychain', win32: 'windows-dpapi', linux: 'libsecret' }[process.platform]);
  assert.ok(b.note.length > 40);

  // A ref of our own so a real "model.default" is never touched, and the
  // keychain is left exactly as we found it.
  const ref = `test.zelos-${crypto.randomBytes(6).toString('hex')}`;
  const value = 'p@ss "word" with spaces & $tuff \\ and ünïcode ✓';
  try {
    await setSecret(ref, value);
    assert.equal(await getSecret(ref), value, `${b.name} must round-trip the value byte for byte`);

    const refs = await listRefs();
    assert.ok(refs.includes(ref));
    for (const r of refs) {
      assert.equal(typeof r, 'string');
      assert.notEqual(r, value, 'listRefs returns refs, never values');
    }

    await setSecret(ref, 'second-value');
    assert.equal(await getSecret(ref), 'second-value', 'set must overwrite, not duplicate');

    assert.equal(await getSecret(`${ref}-absent`), null);
  } finally {
    await deleteSecret(ref).catch(() => {});
  }
  assert.equal(await getSecret(ref), null, 'delete really removes it');
  assert.ok(!(await listRefs()).includes(ref));
});

test('the index file records refs and nothing else', { skip: REAL_STORE_ONLY_ON_CI }, async (t) => {
  useHome('index');
  unforce();
  const b = await backend();
  if (b.name === 'encrypted-file') return; // no index file in that mode

  const ref = `test.zelos-${crypto.randomBytes(6).toString('hex')}`;
  const indexFile = path.join(process.env.ZELOS_HOME, 'secrets.index.json');
  try {
    await setSecret(ref, 'a-value-that-must-not-be-indexed');
    const text = fs.readFileSync(indexFile, 'utf8');
    assert.ok(!text.includes('a-value-that-must-not-be-indexed'));
    assert.deepEqual(JSON.parse(text), { refs: [ref] });

    // The contents above are the claim that holds everywhere. The mode is the
    // POSIX half, and it is a subtest so that it can skip by name on Windows
    // without taking the contents check with it.
    await t.test('and the index is written 0600', { skip: WINDOWS_NO_POSIX_MODES }, () => {
      assert.equal(mode(indexFile), 0o600);
    });
  } finally {
    await deleteSecret(ref).catch(() => {});
  }
});

/* ---------------------------------------- the live Windows DPAPI backend */

/**
 * Why this one test is allowed to let detection run.
 *
 * docs/SECURITY.md tells a Windows user that their keys are held by DPAPI at
 * CurrentUser scope. Until this test, nothing proved it. `describeCommand` is
 * checked above, but that only asserts the *shape* of an argv; the store and
 * read path in `secrets.mjs` runs solely when `detect()` actually returns
 * 'windows-dpapi'.
 *
 * The two "native backend" tests above do let detection run — but both of them
 * return quietly when it lands on 'encrypted-file', so a green Windows leg is
 * equally consistent with DPAPI working and with Windows never having reached
 * DPAPI at all. That is the gap: a documented security property whose evidence
 * cannot distinguish "it works" from "it was skipped".
 *
 * So this test asserts the detected backend rather than tolerating it, and then
 * puts a real secret through PowerShell. Letting detection run is the deliberate
 * exception to the force-the-file-backend rule that test/repo.test.mjs enforces,
 * and it is only safe because of the gate below: `win32` AND `CI` together mean
 * a throwaway GitHub runner whose profile is destroyed with the job. A
 * developer's own Windows box has neither, so their DPAPI store is never written
 * to. If you are tempted to relax this gate, the thing you would be relaxing is
 * "Zelos's test suite does not write into your credential store".
 */
const DPAPI_LIVE_ONLY = process.platform === 'win32' && process.env.CI
  ? false
  : 'the live DPAPI round-trip runs only on Windows CI, because letting the backend '
    + `auto-detect writes into the running account's real DPAPI store (platform=${process.platform}, `
    + `CI=${process.env.CI ? 'set' : 'unset'})`;

/**
 * A ref no real installation could ever produce. Zelos's own refs are
 * "model.default" and "mail.m_<hex>"; nothing generates this shape, so a blob
 * left behind by a crashed run is identifiable as litter at a glance, and a
 * cleanup that misfires cannot take a real secret with it.
 */
const DPAPI_REF = `zelos-ci-throwaway.dpapi-live.${crypto.randomBytes(6).toString('hex')}`;

/**
 * Everything a naive implementation gets wrong, in one string: both kinds of
 * quote, the two characters PowerShell expands inside a double-quoted string
 * (`$` and a backtick), a backslash, an embedded newline, Latin-1 accents, a
 * character that exists in no single-byte code page, and several kilobytes of
 * tail so the value could not have fitted in a command line even if someone
 * tried to put it there.
 *
 * It deliberately does NOT end in a newline. The value reaches PowerShell on
 * stdin newline-terminated, so the script has to strip that terminator, and it
 * does so with `-replace '\r?\n$',''` — which in .NET removes the whole trailing
 * run of line breaks, not just the one Zelos added. A value that genuinely ends
 * in a newline therefore cannot survive this backend. That is a defect in the
 * backend rather than in this test, and asserting it here would be writing the
 * bug down as correct behaviour.
 */
const DPAPI_VALUE = [
  'sk-ant-api03-"double" and \'single\' quotes',
  'a $variable, a `backtick`, a \\backslash\\ and a 100% percent',
  'accents: ü é ñ, and a check mark outside every single-byte page: ✓',
  `long tail: ${'zelos-'.repeat(600)}end`,
].join('\n');

/**
 * Node's own diff truncates a multi-kilobyte string, and the failure this test
 * is most likely to catch is an encoding one — where the strings look identical
 * in a terminal and differ by a code point. So report the first divergence by
 * number, with a little context either side.
 */
function firstDifference(expected, actual) {
  if (typeof actual !== 'string') return `got ${typeof actual} (${JSON.stringify(actual)}) instead of a string`;
  const codes = (s, at) => [...s.slice(Math.max(0, at - 8), at + 8)]
    .map((ch) => `${JSON.stringify(ch)}=U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');
  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
    if (expected[i] === actual[i]) continue;
    return `first difference at index ${i} of ${expected.length}\n`
      + `  expected: ${codes(expected, i)}\n`
      + `  actual:   ${codes(actual, i)}`;
  }
  return `lengths differ: expected ${expected.length}, got ${actual.length}`;
}

test('Windows CI: DPAPI is the detected backend and really round-trips a secret', { skip: DPAPI_LIVE_ONLY }, async (t) => {
  useHome('dpapi-live');
  unforce();

  // Registered before anything is written, so it still runs when an assertion
  // below throws. A DPAPI blob lives in %LOCALAPPDATA%, outside the temp home
  // that test.after removes, so nothing else would ever clear it.
  t.after(async () => { await deleteSecret(DPAPI_REF).catch(() => {}); });

  const b = await backend();
  assert.equal(b.name, 'windows-dpapi',
    `Windows detection chose ${b.name}. If powershell.exe cannot be probed on this machine, Zelos silently `
    + 'stores keys in the encrypted file while docs/SECURITY.md and the note in the UI both tell the user '
    + 'their operating system is holding them. That mismatch is the defect, not this assertion.');
  assert.match(b.note, /DPAPI/);

  // The module's own idea of where the blob goes, rather than a second copy of
  // that path logic here — a test that guessed the path could pass against a
  // backend that had written somewhere else entirely.
  const blob = describeCommand({ name: 'windows-dpapi', action: 'set', ref: DPAPI_REF }).env.ZELOS_SECRET_FILE;

  await setSecret(DPAPI_REF, DPAPI_VALUE);

  assert.ok(fs.existsSync(blob), `setSecret reported success but wrote no blob at ${blob}`);
  // WriteAllText emits no BOM on .NET Framework, but strip one anyway: a BOM
  // would fail the hex check below for a reason that has nothing to do with
  // whether the secret survived.
  const onDisk = fs.readFileSync(blob, 'utf8').replace(/^\uFEFF/, '').trim();
  assert.match(onDisk, /^[0-9A-Fa-f]+$/, 'ConvertFrom-SecureString should leave a hex DPAPI blob, nothing else');
  for (const fragment of ['sk-ant-api03', 'backslash', 'check mark']) {
    assert.ok(!onDisk.includes(fragment), `the DPAPI blob contains plaintext (${fragment}) — it was not encrypted`);
  }

  const got = await getSecret(DPAPI_REF);
  assert.equal(got, DPAPI_VALUE,
    `DPAPI did not hand back what it was given.\n${firstDifference(DPAPI_VALUE, got)}\n`
    + 'The usual cause is console encoding: the value crosses stdin and stdout as bytes, and PowerShell '
    + 'decodes them with the console code page rather than UTF-8 unless the script sets both '
    + '[Console]::InputEncoding and [Console]::OutputEncoding to UTF8.');

  const refs = await listRefs();
  assert.ok(refs.includes(DPAPI_REF), 'a stored ref must appear in listRefs');
  for (const r of refs) assert.notEqual(r, DPAPI_VALUE, 'listRefs returns refs, never values');

  assert.deepEqual(await deleteSecret(DPAPI_REF), { ok: true, deleted: true });
  assert.equal(fs.existsSync(blob), false, 'delete must remove the DPAPI blob, not just forget the ref');
  assert.equal(await getSecret(DPAPI_REF), null, 'a deleted secret must read back as absent');
  assert.ok(!(await listRefs()).includes(DPAPI_REF), 'a deleted ref must leave the index');
  assert.deepEqual(await deleteSecret(DPAPI_REF), { ok: true, deleted: false }, 'deleting twice is not an error');
});
