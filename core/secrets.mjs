/**
 * core/secrets.mjs — the only place a credential is allowed to exist.
 *
 * Zelos stores IMAP passwords and model API keys. config.json holds a `keyRef`
 * ("model.default", "mail.m_9f3a1c"); the value behind that ref lives here.
 *
 * Three properties this module is responsible for, in order of importance:
 *
 *  1. **A secret never appears in argv.** `ps` shows every process's command line
 *     to every other process running as this user. `describeCommand()` — the one
 *     function that builds a command line — takes no value parameter at all, so
 *     it is structurally incapable of leaking one. Values travel on stdin.
 *  2. **A secret never lands on disk in plaintext.** Platform keychain first;
 *     the fallback file is AES-256-GCM.
 *  3. **There is no way to enumerate values.** `listRefs()` returns refs. There
 *     is deliberately no `listSecrets`, and the HTTP layer has no read route.
 *
 * Backend order per SPEC §2: macOS keychain, Windows DPAPI, libsecret, then the
 * encrypted-file fallback. Set ZELOS_SECRETS_BACKEND to force one (used by the
 * tests to exercise the fallback on a machine that has a keychain).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { paths, isValidRef, writeFileAtomic } from './config.mjs';
import { log } from './log.mjs';

export const SERVICE = 'com.zelos.app';

const BACKEND_NAMES = ['macos-keychain', 'windows-dpapi', 'libsecret', 'encrypted-file'];

/** `security` exits 44 for "item not found"; we borrow it for the DPAPI script. */
const NOT_FOUND_EXIT = 44;

const NOTES = {
  'macos-keychain':
    'Stored in your macOS login keychain (service "com.zelos.app"). Zelos never writes the value to disk itself and never passes it on a command line.',
  'windows-dpapi':
    'Encrypted with Windows DPAPI at CurrentUser scope, so only your Windows account can decrypt it. Zelos never passes the value on a command line.',
  libsecret:
    'Stored in your desktop keyring via secret-tool (service "com.zelos.app"). Zelos never passes the value on a command line.',
  'encrypted-file':
    'No system keychain was available, so secrets are stored in an AES-256-GCM encrypted file in your Zelos home, mode 0600, keyed by a random machine seed in .seed. This protects the file at rest — a copied disk or a stray backup is unreadable. It does NOT protect against a process already running as this user: that process can read .seed and decrypt the file exactly as Zelos does. Install a system keychain for stronger protection.',
};

/* ------------------------------------------------------------ subprocess */

/**
 * Run a command, feed `input` to stdin, capture output. Never uses a shell, so
 * nothing here is interpretable by /bin/sh.
 */
function run(file, args, { input = null, env = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errOut = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errOut.push(d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
      });
    });
    // A tool that exits before reading stdin gives us EPIPE; that is not an error
    // we can do anything about, and the close handler reports the real reason.
    child.stdin.on('error', () => {});
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/* --------------------------------------------------------- command shapes */

function psEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/*
 * Both scripts move bytes themselves rather than letting PowerShell choose.
 *
 * `[Console]::In` and `[Console]::Out` decode and encode using the console's
 * code page — CP437 on a US runner, CP1252 on much of Europe, CP932 in Japan.
 * Zelos writes UTF-8 on stdin and reads UTF-8 back, so on a single-byte locale
 * the two mistakes are inverses and cancel: the bytes survive by accident. On a
 * double-byte locale (Japanese, Chinese, Korean) the mapping is not reversible,
 * and an IMAP password with any non-ASCII character in it comes back corrupted
 * — silently, surfacing weeks later as a login failure nobody can explain.
 *
 * So the standard streams are opened raw and encoded explicitly. This is also
 * why the trailing newline is removed by an exact `EndsWith` test rather than
 * by `-replace '\r?\n$'`: .NET's `$` matches before a final newline as well as
 * at the very end, so that pattern ate the whole trailing run and a secret that
 * legitimately ended in a blank line could not be stored.
 *
 * The terminator is matched as a string built from `[char]10` / `[char]13`
 * rather than as an escape, and cast to `[string]` explicitly because
 * `String.EndsWith(char)` does not exist in the .NET Framework that Windows
 * PowerShell 5.1 runs on — PowerShell would coerce it, and relying on that is
 * how the previous version of this line looked correct and was not. PowerShell escapes with a backtick, not a backslash, so `"\r\n"`
 * written here is the four literal characters and matches nothing — which is
 * exactly how it shipped once, passing every local check and failing only on a
 * real Windows runner. A backtick cannot appear in these scripts anyway: they
 * are JavaScript template literals, and it would end the string.
 */
// String.raw so the PowerShell regex escapes survive JavaScript's own escaping.
const DPAPI_SET = String.raw`
$ErrorActionPreference='Stop'
$in=[Console]::OpenStandardInput()
$ms=New-Object System.IO.MemoryStream
$in.CopyTo($ms)
$v=[Text.Encoding]::UTF8.GetString($ms.ToArray())
$lf=[string][char]10
$cr=[string][char]13
if($v.EndsWith($lf)){$v=$v.Substring(0,$v.Length-1); if($v.EndsWith($cr)){$v=$v.Substring(0,$v.Length-1)}}
$p=$env:ZELOS_SECRET_FILE
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
$blob=ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $v -AsPlainText -Force)
[System.IO.File]::WriteAllText($p,$blob)
`;

const DPAPI_GET = String.raw`
$ErrorActionPreference='Stop'
$p=$env:ZELOS_SECRET_FILE
if(-not (Test-Path -LiteralPath $p)){ exit ${NOT_FOUND_EXIT} }
$ss=ConvertTo-SecureString -String ([System.IO.File]::ReadAllText($p))
$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
try{
  $bytes=[Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))
  $out=[Console]::OpenStandardOutput()
  $out.Write($bytes,0,$bytes.Length)
  $out.Flush()
}
finally{ [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
`;

/**
 * The single source of truth for every command line this module runs.
 *
 * It takes a backend name, an action and a ref — and **no value**. That is the
 * guarantee: a secret cannot end up in argv because the code that builds argv
 * never receives one. Returns null when the action needs no subprocess.
 *
 * `stdinWrites` is how many times the value must be written, newline-terminated:
 * macOS `security` prompts "password data for new item:" *and* "retype password
 * for new item:", and on a mismatch it silently stores an EMPTY password.
 *
 * `stderrSafe:false` means the command prints the secret on stderr (macOS
 * `find-generic-password -g` does), so that stream must never reach a log or an
 * error message.
 */
export function describeCommand({ name, action, ref }) {
  if (!isValidRef(ref)) throw new TypeError(`secrets: invalid ref ${JSON.stringify(ref)}`);
  if (!BACKEND_NAMES.includes(name)) throw new TypeError(`secrets: unknown backend ${name}`);

  if (name === 'macos-keychain') {
    switch (action) {
      case 'set':
        return { file: '/usr/bin/security', args: ['add-generic-password', '-U', '-s', SERVICE, '-a', ref, '-w'], stdinWrites: 2, stderrSafe: true };
      case 'get':
        // -g prints "password: <value>" (or "password: 0x<hex>") on STDERR.
        return { file: '/usr/bin/security', args: ['find-generic-password', '-g', '-s', SERVICE, '-a', ref], stdinWrites: 0, stderrSafe: false };
      case 'has':
        return { file: '/usr/bin/security', args: ['find-generic-password', '-s', SERVICE, '-a', ref], stdinWrites: 0, stderrSafe: true };
      case 'delete':
        return { file: '/usr/bin/security', args: ['delete-generic-password', '-s', SERVICE, '-a', ref], stdinWrites: 0, stderrSafe: true };
      default:
        throw new TypeError(`secrets: unknown action ${action}`);
    }
  }

  if (name === 'windows-dpapi') {
    const env = { ZELOS_SECRET_FILE: dpapiFile(ref) };
    const ps = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncoded(script)];
    switch (action) {
      case 'set':
        return { file: 'powershell.exe', args: ps(DPAPI_SET), env, stdinWrites: 1, stderrSafe: true };
      case 'get':
        return { file: 'powershell.exe', args: ps(DPAPI_GET), env, stdinWrites: 0, stderrSafe: true };
      case 'has':
      case 'delete':
        return null; // plain file existence / unlink
      default:
        throw new TypeError(`secrets: unknown action ${action}`);
    }
  }

  if (name === 'libsecret') {
    switch (action) {
      case 'set':
        return { file: 'secret-tool', args: ['store', '--label=Zelos', 'service', SERVICE, 'account', ref], stdinWrites: 1, stderrSafe: true };
      case 'get':
      case 'has':
        return { file: 'secret-tool', args: ['lookup', 'service', SERVICE, 'account', ref], stdinWrites: 0, stderrSafe: true };
      case 'delete':
        return { file: 'secret-tool', args: ['clear', 'service', SERVICE, 'account', ref], stdinWrites: 0, stderrSafe: true };
      default:
        throw new TypeError(`secrets: unknown action ${action}`);
    }
  }

  return null; // encrypted-file is pure JS
}

function dpapiFile(ref) {
  const base = process.env.LOCALAPPDATA || path.join(paths().home, 'dpapi');
  return path.join(base, 'Zelos', 'secrets', `${ref}.dpapi`);
}

/* ------------------------------------------------------------- detection */

let cachedBackend = null;
let cachedKey = null;

function detectionKey() {
  return `${process.platform}|${process.env.ZELOS_SECRETS_BACKEND || ''}|${paths().home}`;
}

async function probeMacKeychain() {
  try {
    fs.accessSync('/usr/bin/security', fs.constants.X_OK);
  } catch {
    return false;
  }
  try {
    const { code } = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', 'zelos.probe'], { timeoutMs: 8000 });
    // 0 = an item is there, 44 = reachable and empty. Anything else (locked
    // keychain, no keychain in a headless session) means we should not rely on it.
    return code === 0 || code === NOT_FOUND_EXIT;
  } catch {
    return false;
  }
}

async function probePowershell() {
  try {
    const { code } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeoutMs: 15_000 });
    return code === 0;
  } catch {
    return false;
  }
}

async function probeSecretTool() {
  try {
    const { code, stderr } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', 'zelos.probe'], { timeoutMs: 8000 });
    // Not-found is exit 1 with nothing on stderr. A missing keyring daemon
    // complains about D-Bus, and then storing would fail later instead of now.
    if (/dbus|d-bus|cannot create|no such secret|failed/i.test(stderr)) return false;
    return code === 0 || code === 1;
  } catch {
    return false;
  }
}

async function detect() {
  const forced = process.env.ZELOS_SECRETS_BACKEND;
  if (forced) {
    if (!BACKEND_NAMES.includes(forced)) throw new Error(`ZELOS_SECRETS_BACKEND must be one of ${BACKEND_NAMES.join(', ')}`);
    return forced;
  }
  if (process.platform === 'darwin' && (await probeMacKeychain())) return 'macos-keychain';
  if (process.platform === 'win32' && (await probePowershell())) return 'windows-dpapi';
  if (process.platform === 'linux' && (await probeSecretTool())) return 'libsecret';
  return 'encrypted-file';
}

/** -> {name, writable, note} */
export async function backend() {
  const key = detectionKey();
  if (cachedBackend && cachedKey === key) return cachedBackend;
  const name = await detect();
  let writable = true;
  try {
    fs.accessSync(paths().home, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  cachedBackend = Object.freeze({ name, writable, note: NOTES[name] });
  cachedKey = key;
  return cachedBackend;
}

/** Testing seam: forget the probed backend so a changed environment is re-read. */
export function resetBackendCache() {
  cachedBackend = null;
  cachedKey = null;
}

/* --------------------------------------------------------------- the index
 * External keychains cannot be enumerated without prompting the user for
 * access to every item, so the refs Zelos has written are tracked in a small
 * index file. It holds refs and nothing else — never a value.
 */

function indexFile() {
  return path.join(paths().home, 'secrets.index.json');
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    const refs = Array.isArray(parsed?.refs) ? parsed.refs.filter(isValidRef) : [];
    return [...new Set(refs)].sort();
  } catch {
    return [];
  }
}

function writeIndex(refs) {
  const unique = [...new Set(refs.filter(isValidRef))].sort();
  writeFileAtomic(indexFile(), `${JSON.stringify({ refs: unique }, null, 2)}\n`, 0o600);
}

function rememberRef(ref) {
  const refs = readIndex();
  if (!refs.includes(ref)) writeIndex([...refs, ref]);
}

function forgetRef(ref) {
  const refs = readIndex();
  if (refs.includes(ref)) writeIndex(refs.filter((r) => r !== ref));
}

/* ------------------------------------------------- encrypted-file backend */

const AAD = Buffer.from('zelos.secrets.v1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const keyCache = new Map();

function seedFile() {
  return path.join(paths().home, '.seed');
}

function storeFile() {
  return path.join(paths().home, 'secrets.enc');
}

/** 32 random bytes, generated once per machine, mode 0600. */
function machineSeed() {
  const file = seedFile();
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    log.warn('secrets: .seed was malformed, generating a new one — existing encrypted secrets will need re-entering');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const seed = crypto.randomBytes(32);
  writeFileAtomic(file, `${seed.toString('hex')}\n`, 0o600);
  return seed;
}

function deriveKey(seed, saltHex) {
  // Keyed on the seed's contents, not its path: a rotated or lost seed must
  // miss the cache, or a stale key would "decrypt" a file it no longer owns.
  const cacheKey = `${crypto.createHash('sha256').update(seed).digest('hex')}|${saltHex}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = crypto.scryptSync(seed, Buffer.from(saltHex, 'hex'), 32, {
    ...SCRYPT,
    // 128 * N * r bytes is scrypt's working set; the default 32MB cap is below
    // what N=2^15 needs, so it has to be raised or scryptSync throws.
    maxmem: 256 * SCRYPT.N * SCRYPT.r,
  });
  keyCache.set(cacheKey, key);
  return key;
}

function readEncryptedStore() {
  const file = storeFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const env = JSON.parse(raw);
    const key = deriveKey(machineSeed(), env.kdf.salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // Wrong seed or a damaged file. Keep the ciphertext — if the seed turns up,
    // it is still recoverable — but let the user carry on with a fresh store.
    const aside = `${file}.unreadable-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* nothing more we can do */ }
    log.error('secrets: encrypted store could not be decrypted; moved aside, secrets must be re-entered', { aside, error: err.message });
    return {};
  }
}

function writeEncryptedStore(store) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(machineSeed(), salt.toString('hex'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(store), 'utf8')), cipher.final()]);
  const envelope = {
    v: 1,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, len: 32, salt: salt.toString('hex') },
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ct: ct.toString('base64'),
  };
  writeFileAtomic(storeFile(), `${JSON.stringify(envelope)}\n`, 0o600);
}

/* --------------------------------------------------------------- the API */

function assertRef(ref) {
  if (!isValidRef(ref)) throw new TypeError(`secrets: invalid ref ${JSON.stringify(ref)}`);
}

function assertValue(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('secrets: value must be a non-empty string');
  if (value.includes('\0')) throw new TypeError('secrets: value must not contain a NUL byte');
  if ((name === 'macos-keychain' || name === 'libsecret') && /[\r\n]/.test(value)) {
    // Both tools read the value as a line from stdin; a newline would truncate it.
    throw new TypeError(`secrets: the ${name} backend cannot store a value containing a line break`);
  }
}

function stdinFor(desc, value) {
  if (!desc.stdinWrites) return null;
  return `${value}\n`.repeat(desc.stdinWrites);
}

export async function setSecret(ref, value) {
  assertRef(ref);
  const { name } = await backend();
  assertValue(name, value);

  if (name === 'encrypted-file') {
    const store = readEncryptedStore();
    store[ref] = value;
    writeEncryptedStore(store);
    return { ok: true, backend: name };
  }

  if (name === 'windows-dpapi') {
    const desc = describeCommand({ name, action: 'set', ref });
    const { code, stderr } = await run(desc.file, desc.args, { input: stdinFor(desc, value), env: desc.env });
    if (code !== 0) throw new Error(`secrets: DPAPI write failed for ${ref} (exit ${code}) ${stderr.trim()}`);
    rememberRef(ref);
    return { ok: true, backend: name };
  }

  const desc = describeCommand({ name, action: 'set', ref });
  const { code, stderr } = await run(desc.file, desc.args, { input: stdinFor(desc, value) });
  if (code !== 0) throw new Error(`secrets: ${desc.file} failed for ${ref} (exit ${code}) ${stderr.trim()}`);
  if (/passwords don't match/i.test(stderr)) {
    // security "succeeds" with exit 0 here and stores an empty password.
    throw new Error(`secrets: keychain rejected the value for ${ref} (prompt mismatch); nothing usable was stored`);
  }
  rememberRef(ref);
  return { ok: true, backend: name };
}

/**
 * `security find-generic-password -g` writes one of:
 *    password: "plain ascii value"
 *    password: 0x636166C3A9  "caf\303\251"
 * The hex form is used whenever the value is not printable ASCII (which includes
 * any value containing a quote or a backslash), so the two forms never collide
 * and the quoted form can be taken literally.
 */
function parseKeychainPassword(stderr) {
  const m = /^password: (?:0x([0-9A-Fa-f]+)\s+)?"([\s\S]*)"\s*$/m.exec(stderr);
  if (!m) return null;
  if (m[1]) return Buffer.from(m[1], 'hex').toString('utf8');
  return m[2];
}

export async function getSecret(ref) {
  assertRef(ref);
  const { name } = await backend();

  if (name === 'encrypted-file') {
    const store = readEncryptedStore();
    return Object.hasOwn(store, ref) ? store[ref] : null;
  }

  const desc = describeCommand({ name, action: 'get', ref });
  const { code, stdout, stderr } = await run(desc.file, desc.args, { env: desc.env });
  if (code === NOT_FOUND_EXIT || (name === 'libsecret' && code === 1)) return null;
  if (code !== 0) {
    // stderr may carry the value itself on macOS — never include it.
    throw new Error(`secrets: could not read ${ref} from ${name} (exit ${code})`);
  }
  if (name === 'macos-keychain') return parseKeychainPassword(stderr);
  if (name === 'libsecret') return stdout.replace(/\n$/, '');
  return stdout;
}

export async function deleteSecret(ref) {
  assertRef(ref);
  const { name } = await backend();

  if (name === 'encrypted-file') {
    const store = readEncryptedStore();
    const existed = Object.hasOwn(store, ref);
    if (existed) {
      delete store[ref];
      writeEncryptedStore(store);
    }
    return { ok: true, deleted: existed };
  }

  if (name === 'windows-dpapi') {
    let deleted = true;
    try {
      fs.unlinkSync(dpapiFile(ref));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      deleted = false;
    }
    forgetRef(ref);
    return { ok: true, deleted };
  }

  const desc = describeCommand({ name, action: 'delete', ref });
  const { code, stderr } = await run(desc.file, desc.args);
  forgetRef(ref);
  if (code === NOT_FOUND_EXIT || (name === 'libsecret' && code === 1)) return { ok: true, deleted: false };
  if (code !== 0) throw new Error(`secrets: could not delete ${ref} from ${name} (exit ${code}) ${stderr.trim()}`);
  return { ok: true, deleted: true };
}

async function hasSecret(name, ref) {
  if (name === 'windows-dpapi') return fs.existsSync(dpapiFile(ref));
  const desc = describeCommand({ name, action: 'has', ref });
  try {
    const { code } = await run(desc.file, desc.args, { env: desc.env });
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Refs only — this module exposes no way to enumerate values, and the HTTP layer
 * has no read route at all.
 */
export async function listRefs() {
  const { name } = await backend();
  if (name === 'encrypted-file') return Object.keys(readEncryptedStore()).sort();

  const known = readIndex();
  const alive = [];
  for (const ref of known) {
    if (await hasSecret(name, ref)) alive.push(ref);
  }
  // Something deleted outside Zelos (Keychain Access, say) should not linger.
  if (alive.length !== known.length) writeIndex(alive);
  return alive;
}
