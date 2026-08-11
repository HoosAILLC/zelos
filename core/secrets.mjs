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
 *
 * Detection runs once and is then *pinned*: the first successful write records
 * the store in `secrets.backend.json`, and from then on that record beats the
 * probe — see "the backend on record" below for why a probe that changes its
 * mind is how a user's credentials end up in two places at once.
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
    // 0 = an item is there, 44 = reachable and empty. Anything else means we
    // should not rely on it.
    //
    // This form omits -g, so it asks for attributes and never for the item's
    // data — the branch that prompts, and the branch a locked keychain refuses.
    // A locked keychain therefore probably answers 44 here and passes. An
    // earlier version of this comment named a locked keychain and a headless
    // session as the reasons for a non-zero exit; that was asserted rather than
    // measured, and settling it means running `security` against whatever login
    // keychain the machine has, which this module's tests are not allowed to
    // do. The honest half is narrow: a code other than 0 or 44 is an answer we
    // do not understand. The ways we know of to get one are the 8s timeout, a
    // refused spawn, and a sandbox denial.
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

async function probeBackend() {
  if (process.platform === 'darwin' && (await probeMacKeychain())) return 'macos-keychain';
  if (process.platform === 'win32' && (await probePowershell())) return 'windows-dpapi';
  if (process.platform === 'linux' && (await probeSecretTool())) return 'libsecret';
  return 'encrypted-file';
}

/* -------------------------------------------------- the backend on record
 * A probe is a guess about this instant, and it decided where every credential
 * for the rest of the process went — `backend()` caches under
 * `platform|env|home`, with no probe result in the key, so nothing could revise
 * it. One 8-second timeout, one spawn refused by a sandbox, one secret-tool
 * losing its race with the keyring daemon at session start, and a password
 * typed that afternoon landed in `secrets.enc` — a file the docs tell users is
 * "only present if your system has no keychain". The next launch probed
 * successfully, went back to the keychain, and read the OLD value out of it:
 * a rotated password silently ignored, authentication failing for a reason
 * nothing on screen could explain.
 *
 * So the store a home actually committed to is written down at the first
 * successful setSecret, and from then on the record beats the probe. A
 * disagreement now surfaces as a real error from the tool that is missing
 * ("could not read model.default from macos-keychain") instead of a quiet move
 * to a second store. Two deliberate exceptions:
 *
 *  - ZELOS_SECRETS_BACKEND still wins outright. That is a person saying it on
 *    purpose, and it is how the tests reach the fallback on a machine with a
 *    keychain. It does NOT move the record: `recordBackend` leaves a usable
 *    record alone, so a forced run over a home that has already committed puts
 *    the value somewhere a later unforced run will not look. That is the price
 *    of "the first store to hold a secret wins", and it is deliberate — an
 *    override is not evidence about where the rest of this home's credentials
 *    are. It is not left silent either: `core/doctor.mjs:405-414` reads this
 *    same record, notices the override, and says in as many words that
 *    anything saved while it is set lands elsewhere and will not be found
 *    without it. (An earlier version of this comment claimed the record *was*
 *    updated. It never was, and doctor's text was the honest one.)
 *  - A record naming a backend that cannot exist on this platform is ignored:
 *    that is a home copied from another machine, which is a migration rather
 *    than a flaky probe.
 */

function backendRecordFile() {
  return path.join(paths().home, 'secrets.backend.json');
}

/** Which platform each backend needs. null means "works anywhere". */
const BACKEND_PLATFORM = {
  'macos-keychain': 'darwin',
  'windows-dpapi': 'win32',
  libsecret: 'linux',
  'encrypted-file': null,
};

function readBackendRecord() {
  try {
    const parsed = JSON.parse(fs.readFileSync(backendRecordFile(), 'utf8'));
    return BACKEND_NAMES.includes(parsed?.backend) ? parsed.backend : null;
  } catch {
    return null;
  }
}

function usableHere(name) {
  const needs = BACKEND_PLATFORM[name];
  return needs === null || needs === process.platform;
}

/**
 * Called only after a value really landed somewhere. The first store to hold a
 * secret wins; later calls leave the record alone, because the whole point is
 * that it does not move under a home that has credentials in it. The one
 * rewrite is a record naming a backend this platform does not have — the home
 * has moved machines, and the old name is now unreachable.
 */
function recordBackend(name) {
  const recorded = readBackendRecord();
  if (recorded === name) return;
  if (recorded && usableHere(recorded)) return;
  try {
    writeFileAtomic(backendRecordFile(), `${JSON.stringify({ backend: name }, null, 2)}\n`, 0o600);
  } catch (err) {
    // Losing the record costs the protection above, not the secret that was
    // just stored — so this is a warning, not a failed write.
    log.warn('secrets: could not record which store this home uses', { error: err.message });
  }
}

/**
 * Reconcile a probe with the record. Exported for the same reason
 * `describeCommand` is: it is the whole of the decision, it is pure, and a test
 * can put every combination through it on any platform without going anywhere
 * near a real credential store — which no test of `detect()` itself can do.
 */
export function chooseBackend({ probed, recorded, platform = process.platform }) {
  if (!recorded || recorded === probed) return probed;
  const needs = BACKEND_PLATFORM[recorded];
  if (needs && needs !== platform) return probed;
  return recorded;
}

async function detect() {
  const forced = process.env.ZELOS_SECRETS_BACKEND;
  if (forced) {
    if (!BACKEND_NAMES.includes(forced)) throw new Error(`ZELOS_SECRETS_BACKEND must be one of ${BACKEND_NAMES.join(', ')}`);
    return forced;
  }
  const probed = await probeBackend();
  const recorded = readBackendRecord();
  const chosen = chooseBackend({ probed, recorded });
  if (recorded && recorded !== probed) {
    // Three distinct situations, and they must not share a sentence. The
    // record-wins case has two shapes, because `probeBackend` only ever names
    // encrypted-file as a *fallback*: if the record is an OS store then the
    // probe failed, and if the record is encrypted-file then the probe
    // succeeded and the OS store is back. Saying "it did not answer just now"
    // about encrypted-file — which is a file on disk and always answers — is
    // the opposite of what happened, and it is the more common of the two,
    // since it is what every home that ever fell back looks like from then on.
    let message;
    if (chosen !== recorded) {
      message = `secrets: this folder last used ${recorded}, which does not exist on ${process.platform} — using ${probed}, and anything held by ${recorded} will need re-entering`;
    } else if (recorded === 'encrypted-file') {
      message = `secrets: ${probed} is available again, but this folder's secrets are in secrets.enc — staying there, because a keychain this home has never written to would answer with stale items or nothing at all`;
    } else {
      message = `secrets: ${recorded} is where this folder's secrets were stored, but it did not answer just now — staying with it rather than starting a second store in ${probed}`;
    }
    log.warn(message, { recorded, probed, chosen });
  }
  return chosen;
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

/**
 * Move a file out of the way instead of writing over it.
 *
 * `writeFileAtomic()` renames the replacement into place, so the bytes that
 * were there are unlinked the instant it returns. That is fine for a config
 * file and fatal for a key: the old `machineSeed()` minted and wrote a
 * replacement as a side effect of being *asked to read* `.seed`, and the
 * ciphertext was then set aside three lines later under the comment "if the
 * seed turns up, it is still recoverable" — with the seed it needed already
 * destroyed. A rename costs nothing and keeps both halves on disk.
 *
 * Callers pass a shared stamp so a seed and the store it keys land as
 * `.seed.unreadable-1754800000000` / `secrets.enc.unreadable-1754800000000` and
 * are obviously a pair to whoever has to put them back together.
 */
function setAside(file, stamp) {
  const aside = `${file}.unreadable-${stamp}`;
  try {
    fs.renameSync(file, aside);
    return aside;
  } catch {
    return null; // nothing more we can do
  }
}

/**
 * The seed if there is a usable one, and NOTHING written either way.
 *
 * Reading is split from minting because the two used to be the same function,
 * and every caller that only wanted to look — `getSecret()`, which the
 * background sweep and `zelos doctor` both call — could destroy the key. The
 * damage needed no deliberate act: a sync client appending a conflict line, a
 * stray leading byte, a duplicated line, a truncation of a few characters.
 * All of those leave the original 64 hex characters sitting on disk, and all of
 * them used to be answered by overwriting them.
 *
 * `state` is 'ok' | 'absent' | 'malformed'. Nothing tries to salvage a seed out
 * of a malformed file: a file holding two different 64-hex tokens would have us
 * guessing which one keys the store, and guessing wrong writes a fresh store
 * over a recoverable one. The file is kept instead, so a person can pick the
 * right characters out of it by hand — which is exactly how the audit that
 * found this recovered a secret it had proved was still intact.
 */
function readSeed() {
  const file = seedFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { seed: null, state: 'absent' };
    throw err;
  }
  const hex = text.trim();
  if (/^[0-9a-f]{64}$/.test(hex)) return { seed: Buffer.from(hex, 'hex'), state: 'ok' };
  return { seed: null, state: 'malformed' };
}

/**
 * 32 random bytes, generated once per machine, mode 0600 — minted only when
 * there is nothing a new seed would strand.
 *
 * Anything still on disk that the new seed cannot open is moved aside first,
 * under one shared timestamp. In practice `readEncryptedStore()` has already
 * done that by the time a write gets here; the check stays because it is the
 * invariant that makes minting safe at all, and a future caller that reaches
 * this without reading first must not be the one that breaks it.
 */
function ensureSeed() {
  const { seed, state } = readSeed();
  if (seed) return seed;

  const stamp = Date.now();
  const asideSeed = state === 'malformed' ? setAside(seedFile(), stamp) : null;
  const asideStore = fs.existsSync(storeFile()) ? setAside(storeFile(), stamp) : null;
  if (asideSeed || asideStore) {
    log.warn('secrets: no usable .seed, so a new one was generated — anything it could not open was moved aside and those secrets must be re-entered',
      { seed: asideSeed, store: asideStore });
  }
  const fresh = crypto.randomBytes(32);
  writeFileAtomic(seedFile(), `${fresh.toString('hex')}\n`, 0o600);
  return fresh;
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
  // Reading never mints. There is ciphertext in front of us, so a seed created
  // here would be a seed created *for a store it cannot open* — and the write
  // that created it would take the real key with it.
  const { seed, state } = readSeed();
  if (!seed) {
    const stamp = Date.now();
    const asideSeed = state === 'malformed' ? setAside(seedFile(), stamp) : null;
    const asideStore = setAside(file, stamp);
    log.error(state === 'malformed'
      ? 'secrets: .seed is damaged, so the encrypted store cannot be opened; both were moved aside under one timestamp and are recoverable together if the 64 hex characters can be salvaged. Secrets must be re-entered.'
      : 'secrets: .seed is missing, so the encrypted store cannot be opened; the ciphertext was moved aside. Secrets must be re-entered.',
      { seed: asideSeed, store: asideStore });
    return {};
  }

  try {
    const env = JSON.parse(raw);
    const key = deriveKey(seed, env.kdf.salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // A well-formed seed that is the wrong one, or a damaged file. Keep the
    // ciphertext — if the right seed turns up, it is still recoverable — and
    // keep the seed on disk too: it is valid, it is what the next store will be
    // keyed by, and it costs nothing to leave where it is.
    const aside = setAside(file, Date.now());
    log.error('secrets: encrypted store could not be decrypted; moved aside, secrets must be re-entered', { aside, error: err.message });
    return {};
  }
}

function writeEncryptedStore(store) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(ensureSeed(), salt.toString('hex'));
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

  // Each path records the backend only after the value is really in it: the
  // record exists to say "this home's credentials are HERE", and a failed write
  // has not put anything anywhere.
  if (name === 'encrypted-file') {
    const store = readEncryptedStore();
    store[ref] = value;
    writeEncryptedStore(store);
    recordBackend(name);
    return { ok: true, backend: name };
  }

  if (name === 'windows-dpapi') {
    const desc = describeCommand({ name, action: 'set', ref });
    const { code, stderr } = await run(desc.file, desc.args, { input: stdinFor(desc, value), env: desc.env });
    if (code !== 0) throw new Error(`secrets: DPAPI write failed for ${ref} (exit ${code}) ${stderr.trim()}`);
    rememberRef(ref);
    recordBackend(name);
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
  recordBackend(name);
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

/**
 * Three answers, not two: 'yes', 'no', and 'unknown' for a probe that could not
 * be run or would not say.
 *
 * The boolean version could not tell "the user deleted it" from "the keyring
 * did not answer", and `listRefs()` wrote the shrunken list back — so one
 * locked keyring, one unlock prompt answered slower than the 15-second timeout,
 * one D-Bus hiccup, and `secrets.index.json` was permanently emptied. The
 * values themselves survived in the keychain, which is what made it so quiet:
 * mail kept syncing, while Ask started answering "no model is configured yet"
 * and Settings showed placeholders until every password was re-entered.
 */
async function hasSecret(name, ref) {
  if (name === 'windows-dpapi') {
    const blob = dpapiFile(ref);
    if (fs.existsSync(blob)) return 'yes';
    // The blob lives under %LOCALAPPDATA%, and dpapiFile() falls back to the
    // Zelos home when that variable is missing — so a relaunch without it looks
    // in a directory Zelos has never written to, where every ref reads as
    // deleted. A missing directory is not an empty store; it is the wrong
    // address.
    return fs.existsSync(path.dirname(blob)) ? 'no' : 'unknown';
  }

  const desc = describeCommand({ name, action: 'has', ref });
  try {
    const { code, stderr } = await run(desc.file, desc.args, { env: desc.env });
    if (code === 0) return 'yes';
    if (name === 'libsecret' && code === 1) {
      // secret-tool spends exit 1 on both "no such item" and "the keyring did
      // not answer" — probeSecretTool() above already knows this and reads
      // stderr to tell them apart. Not-found is exit 1 with nothing on stderr,
      // so anything printed there means we could not ask.
      return stderr.trim() ? 'unknown' : 'no';
    }
    if (code === NOT_FOUND_EXIT) return 'no';
    return 'unknown';
  } catch {
    // Spawn refused, or run()'s timeout fired and SIGKILLed the tool. Both mean
    // the question was never answered, which is the one thing this must not
    // report as an answer.
    return 'unknown';
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
  let answered = true;
  for (const ref of known) {
    const state = await hasSecret(name, ref);
    // A ref we could not ask about stays in the list. Zelos wrote it, nothing
    // has said it is gone, and the caller's next getSecret() will find out for
    // real — whereas dropping it turns a five-second keyring stall into a UI
    // that says the account was never set up.
    if (state !== 'no') alive.push(ref);
    if (state === 'unknown') answered = false;
  }
  // Something deleted outside Zelos (Keychain Access, say) should not linger —
  // but only prune when every probe actually answered. Pruning on a partial
  // answer is what made a transient failure permanent: the index is the only
  // record that a keychain item is ours, and there is no way to rebuild it.
  if (answered && alive.length !== known.length) writeIndex(alive);
  return alive;
}
