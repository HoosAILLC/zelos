/**
 * core/config.mjs — where Zelos lives on disk, and what it believes.
 *
 * Two rules govern this file:
 *
 *  1. config.json NEVER contains a secret. It carries `keyRef` strings that name
 *     an entry in the secret store (core/secrets.mjs) and nothing else. Anything
 *     that looks like a credential is stripped on the way in, loudly.
 *  2. A save is atomic. Config is written to a temp file in the same directory,
 *     fsync'd, chmod'd 0600, and then renamed over the target. rename(2) on the
 *     same filesystem is atomic, so a crash mid-save leaves the old config
 *     intact — never a half-written one that refuses to parse on next launch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { localTimezone } from './time.mjs';
import { log } from './log.mjs';

/** Keys whose value is a credential. Never written to config.json. */
const SECRET_KEYS = new Set([
  'pass', 'password', 'passwd', 'apikey', 'api_key', 'key', 'token', 'secret', 'credentials',
]);

const PROTOCOLS = ['anthropic', 'openai'];
const CALENDAR_KINDS = ['ics', 'caldav', 'file'];
/* One theme (black). The only appearance choice is the accent, and it is
   validated as a six-digit hex because it is written straight into a CSS
   custom property — anything else must never reach the stylesheet. */
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/** Refs are opaque handles ("model.default", "mail.m_9f3a1c"). They end up as a
 *  keychain account name and as a filename, so the charset is deliberately tight. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

export function isValidRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 64 && REF_RE.test(ref);
}

/**
 * Defaults for one mail account. Exported so the UI can build a blank one.
 *
 * `requireTls` is deliberately three-valued. `secure: true` is implicit TLS on
 * 993 and needs no help; `secure: false` starts in the clear and upgrades only
 * if the server offers STARTTLS, which a machine in the middle can simply
 * decline to advertise. `requireTls` is the standing instruction about that:
 * `true` means never send the password over an unencrypted socket, `false`
 * means the plaintext is deliberate, and `null` — which is what every config
 * written before this existed says — means decide from the host, requiring it
 * everywhere except loopback. Loopback is where Proton Bridge and its kind
 * live, which is the whole reason plaintext is still an option.
 *
 * It is stored as null rather than resolved to a boolean on the way in on
 * purpose: a resolved `false` would survive the user later pointing the same
 * account at a real mail server, and go on permitting cleartext for a host
 * nobody ever meant it for.
 */
export const MAIL_ACCOUNT_DEFAULTS = deepFreeze({
  id: '',
  enabled: true,
  label: '',
  host: '',
  port: 993,
  secure: true,
  requireTls: null,
  user: '',
  keyRef: '',
  mailboxes: ['INBOX'],
  sentMailbox: 'Sent',
  lookbackDays: 14,
  maxMessages: 400,
});

/** Defaults for one calendar. Exported so the UI can build a blank one. */
export const CALENDAR_DEFAULTS = deepFreeze({
  id: '',
  enabled: true,
  label: '',
  kind: 'ics',
  url: '',
  user: '',
  keyRef: null,
});

export const DEFAULTS = deepFreeze({
  version: 1,
  identity: { name: '', email: '', timezone: '' },
  model: {
    protocol: 'anthropic',
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    model: '',
    keyRef: 'model.default',
    maxTokens: 8192,
    temperature: 0,
  },
  mail: [],
  calendars: [],
  sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true },
  ui: { accent: '#5b8cff' },
  privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
});

/* ------------------------------------------------------------------ paths */

/**
 * The literal strings "undefined" and "null" are treated as no override at
 * all. They are what an undefined JavaScript value becomes when a launcher
 * interpolates it into an environment variable (`ZELOS_HOME=${home}` with
 * `home` unset), and honouring them once put a live data directory named
 * `undefined/` in the current working directory. Garbage that specific is
 * worth naming rather than resolving.
 */
function homeDir() {
  const override = process.env.ZELOS_HOME;
  const trimmed = override ? override.trim() : '';
  const garbage = trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null';
  return trimmed && !garbage ? path.resolve(override) : path.join(os.homedir(), '.zelos');
}

/**
 * mkdir -p at 0700. mkdir's `mode` is masked by the process umask, and an
 * already-existing directory keeps whatever mode it had, so tighten explicitly
 * afterwards — this directory holds the database and, on the fallback backend,
 * the encrypted secret store.
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode & 0o077) fs.chmodSync(dir, 0o700);
  } catch (err) {
    throw new Error(`cannot create Zelos directory ${dir}: ${err.message}`);
  }
}

export function paths() {
  const home = homeDir();
  const logsDir = path.join(home, 'logs');
  const cacheDir = path.join(home, 'cache');
  ensureDir(home);
  ensureDir(logsDir);
  ensureDir(cacheDir);
  return {
    home,
    db: path.join(home, 'zelos.db'),
    configFile: path.join(home, 'config.json'),
    logsDir,
    cacheDir,
  };
}

/* ------------------------------------------------------------------ merge */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge. Objects merge key-by-key; arrays REPLACE wholesale — merging
 * `mail` element-by-element would make it impossible to remove an account.
 * `undefined` in the patch means "leave alone"; `null` means "set to null"
 * (calendars legitimately carry `keyRef: null`).
 */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

/**
 * Remove anything credential-shaped, anywhere in the tree, and say so. This is
 * the last line of defence for rule 1: even if a route or a UI form hands us a
 * password, it does not reach the disk.
 */
function stripSecrets(value, at = '', found = []) {
  if (Array.isArray(value)) return value.map((v, i) => stripSecrets(v, `${at}[${i}]`, found));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const where = at ? `${at}.${k}` : k;
    if (SECRET_KEYS.has(k.toLowerCase())) {
      found.push(where);
      continue;
    }
    out[k] = stripSecrets(v, where, found);
  }
  if (!at && found.length) {
    log.warn('config: refused to store credential fields', { paths: found });
  }
  return out;
}

/* ------------------------------------------------------------------ ids */

/** e.g. newId('m') -> 'm_9f3a1c' */
export function newId(prefix) {
  const p = String(prefix ?? '').trim();
  if (!/^[a-z]{1,8}$/.test(p)) throw new TypeError(`newId: prefix must be 1-8 lowercase letters, got ${JSON.stringify(prefix)}`);
  return `${p}_${crypto.randomBytes(3).toString('hex')}`;
}

/* ------------------------------------------------------------------ shape */

/**
 * The five sections whose value has to BE an object for the rest of the program
 * to read the config at all. `loadConfig` dereferences `identity.timezone` on
 * its last line, and zelos.mjs, the server and the UI go straight at `model.*`,
 * `sweep.*`, `ui.accent` and `privacy.*` the moment they have a config in hand.
 *
 * `deepMerge` lets a scalar replace an object on purpose — that is how a patch
 * sets a `keyRef` to null — so `{"identity": 5}` merges cleanly, serialises
 * cleanly, and then kills the next launch with a raw stack trace before
 * `validateConfig` ever gets to say "identity must be an object". `5`, `"Nemo"`,
 * `false` and `null` all do it: under strict mode the assignment to a primitive
 * throws just as the dereference of null does.
 *
 * Both halves of that are handled, and deliberately not in the same direction:
 *
 *  - a SAVE that would produce one is refused before anything reaches the disk,
 *    because the caller is sending nonsense and should be told so;
 *  - a FILE that already holds one is repaired on the way in, because
 *    `zelos doctor` tells the user to edit config.json by hand and a typo there
 *    must not brick the app that is supposed to report the typo.
 *
 * `mail` and `calendars` need no entry here: `normalizeAccounts` already
 * replaces a non-array with an empty one.
 */
const SECTIONS = ['identity', 'model', 'sweep', 'ui', 'privacy'];

/** Which of the five sections are not objects. Names only — never values. */
function malformedSections(cfg) {
  return SECTIONS.filter((key) => !isPlainObject(cfg[key]));
}

/* ------------------------------------------------------------------ load */

function readRaw(configFile) {
  let text;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('config: unreadable, using defaults', { error: err.message });
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    // A config we cannot parse is a config somebody will want to look at.
    // Move it aside rather than overwriting it on the next save.
    const aside = `${configFile}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(configFile, aside);
      log.warn('config: unparseable, moved aside', { aside, error: err.message });
    } catch {
      log.warn('config: unparseable and could not be moved aside', { error: err.message });
    }
    return {};
  }
}

/** Give every account the full shape and a stable id, so callers never guess. */
function normalizeAccounts(cfg) {
  cfg.mail = (Array.isArray(cfg.mail) ? cfg.mail : [])
    .filter(isPlainObject)
    .map((a) => {
      const acct = deepMerge(structuredClone(MAIL_ACCOUNT_DEFAULTS), a);
      if (!acct.id) acct.id = newId('m');
      if (!acct.keyRef) acct.keyRef = `mail.${acct.id}`;
      if (!Array.isArray(acct.mailboxes) || acct.mailboxes.length === 0) acct.mailboxes = ['INBOX'];
      return acct;
    });
  cfg.calendars = (Array.isArray(cfg.calendars) ? cfg.calendars : [])
    .filter(isPlainObject)
    .map((c) => {
      const cal = deepMerge(structuredClone(CALENDAR_DEFAULTS), c);
      if (!cal.id) cal.id = newId('c');
      return cal;
    });
  return cfg;
}

export function loadConfig() {
  const { configFile } = paths();
  const cfg = normalizeAccounts(deepMerge(structuredClone(DEFAULTS), stripSecrets(readRaw(configFile))));
  // A section somebody hand-edited into a scalar is put back before anything
  // reads through it. Loud, because the values in it are gone: this is the one
  // place that notices, and the alternative was a stack trace at launch.
  for (const key of malformedSections(cfg)) {
    log.warn('config: section is not an object, using its defaults', {
      section: key,
      found: cfg[key] === null ? 'null' : typeof cfg[key],
    });
    cfg[key] = structuredClone(DEFAULTS[key]);
  }
  // Resolved at read time, not persisted: a machine that moves should follow.
  if (!cfg.identity.timezone) cfg.identity.timezone = localTimezone();
  return cfg;
}

/* ------------------------------------------------------------------ save */

/**
 * Atomic write: temp file in the SAME directory (rename is only atomic within a
 * filesystem), fsync the contents, chmod explicitly (umask can widen the mode
 * passed to open), rename over the target, then fsync the directory so the
 * rename itself is durable.
 */
export function writeFileAtomic(file, contents, mode = 0o600) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Some platforms refuse to fsync a directory. The rename already happened.
  }
}

export function saveConfig(patch = {}) {
  // Checked before paths() so a caller that hands over a scalar or an array
  // does not even create the directory: `deepMerge` would return that value as
  // the whole config, and the first thing to touch it would throw from
  // somewhere further in with no clue whose fault it was.
  if (!isPlainObject(patch)) {
    throw new TypeError(`saveConfig: patch must be an object, got ${patch === null ? 'null' : typeof patch}`);
  }
  const { configFile } = paths();
  // Merge over what is ON DISK, not over the resolved config, so runtime-filled
  // values (a timezone inferred from Intl) never get frozen into the file.
  const raw = stripSecrets(readRaw(configFile));
  // A section the FILE already got wrong is dropped rather than merged, so the
  // DEFAULTS underneath show through and this save quietly repairs it. Refusing
  // on it instead would leave a hand-edited typo blocking every later save —
  // including the one the user makes in Settings to correct it.
  for (const key of SECTIONS) {
    if (!Object.hasOwn(raw, key) || isPlainObject(raw[key])) continue;
    log.warn('config: dropping a malformed section from the file on disk', { section: key });
    delete raw[key];
  }
  const merged = normalizeAccounts(
    deepMerge(deepMerge(structuredClone(DEFAULTS), raw), stripSecrets(patch)),
  );
  // Anything still malformed came from the PATCH, so refuse it here — before
  // the write, not after. This used to persist first and only find out on the
  // last line, when its own loadConfig() threw: the caller got a 500, the
  // running process kept serving its in-memory snapshot as if nothing had
  // happened, and config.json was left holding a value no later launch could
  // read. A save that cannot be loaded back is not a save.
  const broken = malformedSections(merged);
  if (broken.length) {
    throw new TypeError(`config: ${broken.join(', ')} must be ${broken.length > 1 ? 'objects' : 'an object'} — nothing was written`);
  }
  writeFileAtomic(configFile, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return loadConfig();
}

/* ------------------------------------------------------------------ validate */

const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function checkUrl(errors, at, value, { schemes, required }) {
  if (!isStr(value) || !value.trim()) {
    if (required) errors.push({ path: at, message: 'is required' });
    return;
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    errors.push({ path: at, message: `is not a valid URL: ${value}` });
    return;
  }
  if (!schemes.includes(u.protocol)) {
    errors.push({ path: at, message: `must use ${schemes.join(' or ')} (got ${u.protocol})` });
  }
}

function checkRef(errors, at, value, { allowNull = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (!allowNull) errors.push({ path: at, message: 'is required' });
    return;
  }
  if (!isValidRef(value)) {
    errors.push({ path: at, message: 'must be a short ref like "model.default" (letters, digits, . _ -)' });
  }
}

/** -> {ok, errors:[{path, message}]} */
export function validateConfig(cfg) {
  const errors = [];
  if (!isPlainObject(cfg)) return { ok: false, errors: [{ path: '', message: 'config must be an object' }] };

  const leaked = [];
  stripSecrets(cfg, '', leaked);
  for (const p of leaked) errors.push({ path: p, message: 'credentials must live in the secret store, not in config.json' });

  if (!isInt(cfg.version, 1, 1000)) errors.push({ path: 'version', message: 'must be a positive integer' });

  const id = cfg.identity;
  if (!isPlainObject(id)) errors.push({ path: 'identity', message: 'must be an object' });
  else {
    if (!isStr(id.name)) errors.push({ path: 'identity.name', message: 'must be a string' });
    if (!isStr(id.email)) errors.push({ path: 'identity.email', message: 'must be a string' });
    else if (id.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id.email)) errors.push({ path: 'identity.email', message: 'is not an email address' });
    if (!isStr(id.timezone)) errors.push({ path: 'identity.timezone', message: 'must be a string' });
    else if (id.timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: id.timezone }); }
      catch { errors.push({ path: 'identity.timezone', message: `unknown IANA timezone: ${id.timezone}` }); }
    }
  }

  const m = cfg.model;
  if (!isPlainObject(m)) errors.push({ path: 'model', message: 'must be an object' });
  else {
    if (!PROTOCOLS.includes(m.protocol)) errors.push({ path: 'model.protocol', message: `must be one of ${PROTOCOLS.join(', ')}` });
    if (!isStr(m.label)) errors.push({ path: 'model.label', message: 'must be a string' });
    checkUrl(errors, 'model.baseUrl', m.baseUrl, { schemes: ['http:', 'https:'], required: true });
    if (!isStr(m.model)) errors.push({ path: 'model.model', message: 'must be a string' });
    checkRef(errors, 'model.keyRef', m.keyRef, { allowNull: true });
    if (!isInt(m.maxTokens, 1, 1_000_000)) errors.push({ path: 'model.maxTokens', message: 'must be an integer between 1 and 1000000' });
    if (typeof m.temperature !== 'number' || !(m.temperature >= 0 && m.temperature <= 2)) errors.push({ path: 'model.temperature', message: 'must be a number between 0 and 2' });
  }

  if (!Array.isArray(cfg.mail)) errors.push({ path: 'mail', message: 'must be an array' });
  else {
    const seen = new Set();
    cfg.mail.forEach((a, i) => {
      const at = `mail[${i}]`;
      if (!isPlainObject(a)) { errors.push({ path: at, message: 'must be an object' }); return; }
      if (!isStr(a.id) || !a.id) errors.push({ path: `${at}.id`, message: 'is required' });
      else if (seen.has(a.id)) errors.push({ path: `${at}.id`, message: `duplicate account id ${a.id}` });
      else seen.add(a.id);
      if (!isBool(a.enabled)) errors.push({ path: `${at}.enabled`, message: 'must be a boolean' });
      if (!isStr(a.label)) errors.push({ path: `${at}.label`, message: 'must be a string' });
      if (a.enabled && (!isStr(a.host) || !a.host.trim())) errors.push({ path: `${at}.host`, message: 'is required for an enabled account' });
      if (a.enabled && (!isStr(a.user) || !a.user.trim())) errors.push({ path: `${at}.user`, message: 'is required for an enabled account' });
      if (!isInt(a.port, 1, 65535)) errors.push({ path: `${at}.port`, message: 'must be a port number' });
      if (!isBool(a.secure)) errors.push({ path: `${at}.secure`, message: 'must be a boolean' });
      if (a.requireTls !== null && !isBool(a.requireTls)) errors.push({ path: `${at}.requireTls`, message: 'must be true, false, or null to decide from the host' });
      checkRef(errors, `${at}.keyRef`, a.keyRef, { allowNull: !a.enabled });
      if (!Array.isArray(a.mailboxes) || a.mailboxes.length === 0 || !a.mailboxes.every(isStr)) errors.push({ path: `${at}.mailboxes`, message: 'must be a non-empty array of mailbox names' });
      if (!isStr(a.sentMailbox)) errors.push({ path: `${at}.sentMailbox`, message: 'must be a string' });
      if (!isInt(a.lookbackDays, 1, 365)) errors.push({ path: `${at}.lookbackDays`, message: 'must be an integer between 1 and 365' });
      if (!isInt(a.maxMessages, 1, 5000)) errors.push({ path: `${at}.maxMessages`, message: 'must be an integer between 1 and 5000' });
    });
  }

  if (!Array.isArray(cfg.calendars)) errors.push({ path: 'calendars', message: 'must be an array' });
  else {
    const seen = new Set();
    cfg.calendars.forEach((c, i) => {
      const at = `calendars[${i}]`;
      if (!isPlainObject(c)) { errors.push({ path: at, message: 'must be an object' }); return; }
      if (!isStr(c.id) || !c.id) errors.push({ path: `${at}.id`, message: 'is required' });
      else if (seen.has(c.id)) errors.push({ path: `${at}.id`, message: `duplicate calendar id ${c.id}` });
      else seen.add(c.id);
      if (!isBool(c.enabled)) errors.push({ path: `${at}.enabled`, message: 'must be a boolean' });
      if (!isStr(c.label)) errors.push({ path: `${at}.label`, message: 'must be a string' });
      if (!CALENDAR_KINDS.includes(c.kind)) errors.push({ path: `${at}.kind`, message: `must be one of ${CALENDAR_KINDS.join(', ')}` });
      else if (c.kind === 'file') {
        if (c.enabled && (!isStr(c.url) || !c.url.trim())) errors.push({ path: `${at}.url`, message: 'is required for an enabled calendar' });
      } else {
        // webcal: is how Apple and friends publish an https .ics; the fetcher normalises it.
        checkUrl(errors, `${at}.url`, c.url, { schemes: ['http:', 'https:', 'webcal:'], required: !!c.enabled });
      }
      if (!isStr(c.user)) errors.push({ path: `${at}.user`, message: 'must be a string' });
      checkRef(errors, `${at}.keyRef`, c.keyRef, { allowNull: true });
    });
  }

  const s = cfg.sweep;
  if (!isPlainObject(s)) errors.push({ path: 'sweep', message: 'must be an object' });
  else {
    if (!isInt(s.intervalMinutes, 5, 1440)) errors.push({ path: 'sweep.intervalMinutes', message: 'must be an integer between 5 and 1440' });
    if (!Array.isArray(s.activeHours) || s.activeHours.length !== 2 || !s.activeHours.every((h) => isInt(h, 0, 23))) {
      errors.push({ path: 'sweep.activeHours', message: 'must be [startHour, endHour] with each 0-23' });
    } else if (s.activeHours[0] >= s.activeHours[1]) {
      errors.push({ path: 'sweep.activeHours', message: 'start hour must be before end hour' });
    }
    if (!isBool(s.auto)) errors.push({ path: 'sweep.auto', message: 'must be a boolean' });
  }

  if (!isPlainObject(cfg.ui)) errors.push({ path: 'ui', message: 'must be an object' });
  else if (!ACCENT_RE.test(String(cfg.ui.accent ?? ''))) errors.push({ path: 'ui.accent', message: 'must be a six-digit hex colour like #5b8cff' });

  const p = cfg.privacy;
  if (!isPlainObject(p)) errors.push({ path: 'privacy', message: 'must be an object' });
  else {
    if (!isInt(p.maxItemsPerSweep, 1, 1000)) errors.push({ path: 'privacy.maxItemsPerSweep', message: 'must be an integer between 1 and 1000' });
    if (!isBool(p.sendBodies)) errors.push({ path: 'privacy.sendBodies', message: 'must be a boolean' });
    if (!isInt(p.bodyChars, 200, 100_000)) errors.push({ path: 'privacy.bodyChars', message: 'must be an integer between 200 and 100000' });
  }

  return { ok: errors.length === 0, errors };
}
