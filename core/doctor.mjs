/**
 * core/doctor.mjs — "why isn't this working?", answered without a stack trace.
 *
 * `zelos doctor` is for the person who followed the instructions and got
 * nothing. Every check here ends in either "this is fine" or a sentence that
 * names the next thing to *do* — not the exception that was thrown. An error
 * message a user cannot act on is the same as no message at all.
 *
 * Three rules shape this file:
 *
 *  1. **It diagnoses; it does not repair.** The home-directory check reads the
 *     mode off disk *before* anything calls `paths()`, because `paths()`
 *     tightens the permissions as a side effect. A doctor that quietly fixes
 *     what it is measuring cannot tell you what was wrong.
 *  2. **It only talks to what you configured.** The model endpoint, your IMAP
 *     hosts and your calendar URLs — the same three outbound sockets the rest
 *     of Zelos is allowed. Nothing else, ever.
 *  3. **It never reads a secret out loud.** It reports whether a credential is
 *     *present*, never its value, and never puts one in a return value that a
 *     UI might render.
 *
 * `diagnose()` returns a plain JSON-safe report so the Settings screen can show
 * the same findings the terminal does.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, paths, validateConfig } from './config.mjs';
import { backend as secretBackend, getSecret as readSecret } from './secrets.mjs';
import { isLocalAddress, listModels } from './llm.mjs';
import { guessImapHost, testConnection as testImapConnection } from './sources/imap.mjs';
import { testConnection as testCalDavConnection } from './sources/caldav.mjs';
import { parseICS } from './sources/ics.mjs';
import { safeUrl } from './safety.mjs';

/** The floor is node:sqlite, which landed in 22.5.0. Below that nothing runs. */
export const MIN_NODE = '22.5.0';

/** Below this major, node:sqlite is still behind an experimental flag. */
const STABLE_SQLITE_MAJOR = 24;

/** pass = fine · warn = worth knowing · fail = broken · skip = nothing to check */
export const STATUSES = Object.freeze(['pass', 'warn', 'fail', 'skip']);

const MAX_ICS_BYTES = 8 * 1024 * 1024;

const DEFAULT_DEPS = Object.freeze({
  backend: secretBackend,
  getSecret: readSecret,
  listModels,
  testImap: testImapConnection,
  testCalDav: testCalDavConnection,
  fetchImpl: (...args) => globalThis.fetch(...args),
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function check(id, label, status, detail, action = null) {
  return { id, label, status, detail: String(detail ?? ''), action: action ? String(action) : null };
}

function errorText(err) {
  return err?.message || String(err ?? 'unknown error');
}

/** "22.5.0" vs "26.3.0" — numeric, segment by segment, prerelease tags ignored. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Where Zelos lives, worked out WITHOUT creating anything. `paths()` would be
 * the obvious call, but it mkdirs and chmods on the way — which is exactly the
 * condition the home check exists to observe.
 */
function homeDirPath() {
  const override = process.env.ZELOS_HOME;
  return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), '.zelos');
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

function checkNode(version = process.versions.node) {
  const label = 'Node.js';
  if (compareVersions(version, MIN_NODE) < 0) {
    return check(
      'node', label, 'fail',
      `This is Node ${version}. Zelos needs ${MIN_NODE} or newer — that is the release that added the built-in SQLite it keeps everything in.`,
      'Install the current Node from nodejs.org (take the defaults), close this terminal, open a new one, and run zelos again.',
    );
  }
  const major = Number.parseInt(String(version).split('.')[0], 10) || 0;
  if (major < STABLE_SQLITE_MAJOR) {
    return check(
      'node', label, 'warn',
      `Node ${version} works, but its SQLite module is still experimental.`,
      'If Zelos fails to open its database, start it with: node --experimental-sqlite zelos.mjs. Upgrading to the current Node removes the flag entirely.',
    );
  }
  return check('node', label, 'pass', `Node ${version}`);
}

function checkHome(home) {
  const label = 'Data folder';
  let stat;
  try {
    stat = fs.statSync(home);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return check(
        'home', label, 'warn',
        `${home} does not exist yet.`,
        'That is normal before the first launch — Zelos creates it, locked to your account, when it starts. Run zelos once.',
      );
    }
    return check(
      'home', label, 'fail',
      `${home} cannot be read: ${errorText(err)}`,
      `Check that the folder exists and belongs to you, or start Zelos with --home pointing somewhere you own.`,
    );
  }

  if (!stat.isDirectory()) {
    return check(
      'home', label, 'fail',
      `${home} is a file, not a folder.`,
      `Move or delete ${home}, then start Zelos again — it will create the folder itself.`,
    );
  }

  try {
    fs.accessSync(home, fs.constants.W_OK | fs.constants.R_OK);
  } catch {
    return check(
      'home', label, 'fail',
      `${home} exists but this account cannot write to it.`,
      `Give yourself access — on macOS or Linux: chmod u+rwx "${home}" — or start Zelos with --home pointing at a folder you own.`,
    );
  }

  const mode = stat.mode & 0o777;
  // Windows does not use POSIX modes; reporting one would be theatre.
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    return check(
      'home', label, 'fail',
      `${home} is readable by other accounts on this machine (mode ${mode.toString(8).padStart(3, '0')}). Your mail cache and your board live in there.`,
      `Zelos tightens this itself the next time it starts. Lock it down now with: chmod 700 "${home}" — and if it keeps coming back open, something else on this machine is widening it.`,
    );
  }

  const db = path.join(home, 'zelos.db');
  const detail = process.platform === 'win32'
    ? `${home}${fs.existsSync(db) ? ' · database present' : ' · no database yet'}`
    : `${home} (mode ${mode.toString(8).padStart(3, '0')})${fs.existsSync(db) ? ' · database present' : ' · no database yet'}`;
  return check('home', label, 'pass', detail);
}

function checkConfig(config, configFile, loadError) {
  const label = 'Settings file';
  if (loadError) {
    return check(
      'config', label, 'fail',
      `Zelos could not read its settings: ${loadError}`,
      `Look at ${configFile}. If it is damaged, move it aside — Zelos writes a fresh one with the defaults on the next launch.`,
    );
  }
  const { ok, errors } = validateConfig(config);
  if (!ok) {
    const shown = errors.slice(0, 6).map((e) => `${e.path || '(root)'} ${e.message}`).join('; ');
    const more = errors.length > 6 ? ` (and ${errors.length - 6} more)` : '';
    return check(
      'config', label, 'fail',
      `${errors.length} setting${errors.length === 1 ? '' : 's'} will not load: ${shown}${more}`,
      `Fix these in Settings inside the app, or edit ${configFile} directly and restart Zelos.`,
    );
  }
  if (!fs.existsSync(configFile)) {
    return check(
      'config', label, 'warn',
      'No settings file has been written yet — Zelos is running on its defaults.',
      'Nothing to do: the first change you save in Settings creates it.',
    );
  }
  return check('config', label, 'pass', `${configFile} · valid`);
}

async function checkSecrets(deps) {
  const label = 'Secret store';
  let info;
  try {
    info = await deps.backend();
  } catch (err) {
    return check(
      'secrets', label, 'fail',
      `Zelos could not work out where to keep your passwords: ${errorText(err)}`,
      'Unset ZELOS_SECRETS_BACKEND if you set it, or set it to encrypted-file to use the built-in encrypted store.',
    );
  }
  if (!info.writable) {
    return check(
      'secrets', label, 'fail',
      `The ${info.name} store cannot be written, so mail passwords and API keys have nowhere to go.`,
      'Check that your Zelos data folder is writable (the line above), then run zelos doctor again.',
    );
  }
  if (info.name === 'encrypted-file') {
    return check(
      'secrets', label, 'warn',
      `Using the built-in encrypted file. ${info.note}`,
      'Nothing is broken. If you would rather your system keychain held these: on Linux install a keyring (gnome-keyring or KWallet) and log back in; on macOS and Windows the system store is used automatically.',
    );
  }
  return check('secrets', label, 'pass', `${info.name} · ${info.note}`);
}

async function checkModelKey(config, deps) {
  const label = 'Model key';
  const model = config?.model ?? {};
  const address = String(model.baseUrl ?? '').trim().replace(/\/+$/, '');
  // A model nobody has chosen yet means "not set up", not "broken". The
  // difference is the whole point of the exit code: `zelos doctor` fails when
  // something is wrong, not when someone simply has not finished yet.
  const chosen = String(model.model ?? '').trim();

  if (!address) {
    return { result: check('model.key', label, 'skip', 'No model endpoint is set, so there is no key to check.'), key: null };
  }
  if (isLocalAddress(address)) {
    return {
      result: check('model.key', label, 'pass', `${address} runs on this machine — no API key needed.`),
      key: null,
    };
  }
  if (!model.keyRef) {
    return {
      result: check(
        'model.key', label, chosen ? 'fail' : 'warn',
        `${address} is not on this machine, so it needs an API key, and no place to keep one is configured.`,
        'Open Settings → Model, pick your provider again and save. That sets up where the key is stored.',
      ),
      key: null,
    };
  }
  let key = null;
  try {
    key = await deps.getSecret(model.keyRef);
  } catch (err) {
    return {
      result: check(
        'model.key', label, 'fail',
        `Zelos could not read the key it stored for ${model.keyRef}: ${errorText(err)}`,
        'See the secret store line above — that is where this failed. Re-entering the key in Settings → Model usually settles it.',
      ),
      key: null,
    };
  }
  if (!key) {
    return {
      result: check(
        'model.key', label, chosen ? 'fail' : 'warn',
        chosen
          ? `No API key is stored for ${address}, so every sweep will fail before it starts.`
          : `Zelos has not been pointed at a model yet, and no API key is stored for ${address}.`,
        'Open Settings → Model and paste your provider key. Zelos puts it in your system secret store — it is never written into the settings file, and it never appears in a log. If you would rather nothing left this machine at all, run Ollama or LM Studio and pick that instead; local models need no key.',
      ),
      key: null,
    };
  }
  return {
    result: check('model.key', label, 'pass', `A key is stored for ${address} under ${model.keyRef}.`),
    key,
  };
}

async function checkModelEndpoint(config, deps, { key, keyChecked, timeoutMs, signal }) {
  const label = 'Model';
  const model = config?.model ?? {};
  const address = String(model.baseUrl ?? '').trim().replace(/\/+$/, '');
  const chosen = String(model.model ?? '').trim();

  if (!address) {
    return check(
      'model', label, 'fail',
      'No model endpoint is set, so Zelos cannot think about anything it reads.',
      'Open Zelos, go to Settings → Model, and pick a provider. If you want nothing to leave this machine at all, run Ollama or LM Studio and choose that.',
    );
  }
  if (!keyChecked) {
    return check(
      'model', label, 'skip',
      `Not checked — ${address} needs a key first (see above).`,
      'Store the key, then run zelos doctor again.',
    );
  }

  const local = isLocalAddress(address);
  let models;
  try {
    models = await deps.listModels({
      protocol: model.protocol,
      baseUrl: address,
      apiKey: key,
      timeoutMs,
      retries: 0,
      signal,
    });
  } catch (err) {
    const status = err?.status ?? null;
    if (status === 401 || status === 403) {
      return check(
        'model', label, 'fail',
        `${address} refused the stored key (HTTP ${status}).`,
        'The key is wrong, revoked, or belongs to a different provider. Generate a fresh one in your provider\'s console and paste it into Settings → Model.',
      );
    }
    if (status === 404 || status === 405) {
      // The host answered — it just does not publish a model list. That is a
      // reachable endpoint, which is what this check is actually asking.
      return check(
        'model', label, 'pass',
        `${address} answered (it does not offer a model list, which is normal for some servers).`,
      );
    }
    if (status === 429) {
      return check(
        'model', label, 'warn',
        `${address} answered, but is rate-limiting right now (HTTP 429).`,
        'Nothing is misconfigured. Wait a minute and sweep again; if it never clears, check your plan limits with the provider.',
      );
    }
    if (status && status >= 500) {
      return check(
        'model', label, 'warn',
        `${address} answered with a server error (HTTP ${status}).`,
        'That is their end, not yours. Try again shortly.',
      );
    }
    return check(
      'model', label, 'fail',
      errorText(err),
      local
        ? `Nothing is listening at ${address}. Start your local model first — for Ollama that is: ollama serve — then run zelos doctor again. Check the port too: Ollama is 11434, LM Studio 1234, llama.cpp 8080.`
        : `Zelos could not reach ${address}. Check the base URL in Settings → Model against your provider's documentation, and check this machine's internet connection.`,
    );
  }

  if (!chosen) {
    const sample = models.slice(0, 4).map((m) => m.id).join(', ');
    return check(
      'model', label, 'warn',
      `${address} is reachable, but no model has been chosen yet, so sweeps will not run.`,
      sample
        ? `Open Settings → Model and pick one. This endpoint offers: ${sample}${models.length > 4 ? ', and others' : ''}.`
        : 'Open Settings → Model and pick one.',
    );
  }
  if (models.length && !models.some((m) => m.id === chosen)) {
    const sample = models.slice(0, 4).map((m) => m.id).join(', ');
    return check(
      'model', label, 'warn',
      `${address} is reachable, but does not list "${chosen}".`,
      `Either the name has a typo or the model has not been pulled. Available here: ${sample}${models.length > 4 ? ', and others' : ''}. ${local ? `To fetch it in Ollama: ollama pull ${chosen}` : 'Pick one of those in Settings → Model.'}`,
    );
  }
  return check(
    'model', label, 'pass',
    `${chosen} at ${address}${local ? ' (on this machine)' : ''}${models.length ? ` · ${models.length} model${models.length === 1 ? '' : 's'} available` : ''}`,
  );
}

async function checkMailAccount(account, deps, { timeoutMs }) {
  const name = account.label || account.host || account.id;
  const id = `mail.${account.id}`;
  const label = `Mail · ${name}`;
  const guess = guessImapHost(account.user || '');

  if (!account.host) {
    return check(id, label, 'fail', 'No IMAP server is set for this account.',
      `Open Settings → Mail and fill in the server.${guess.host ? ` For ${account.user || 'that address'} it is usually ${guess.host}, port ${guess.port}.` : ''}`);
  }

  let pass = null;
  try {
    pass = account.keyRef ? await deps.getSecret(account.keyRef) : null;
  } catch (err) {
    return check(id, label, 'fail', `Zelos could not read the stored password: ${errorText(err)}`,
      'See the secret store line above. Re-entering the password in Settings → Mail usually settles it.');
  }
  if (!pass) {
    return check(
      id, label, 'fail',
      `No password is stored for ${name}, so Zelos cannot sign in.`,
      `Open Settings → Mail and enter it. ${guess.note}`,
    );
  }

  // `requireTls` is forwarded so this connects under the same rule the sweep
  // will. A diagnosis that signs in where the real run would refuse to is not a
  // diagnosis, it is a second, more permissive client — and it would report an
  // account as healthy on the morning its mail stops arriving.
  const result = await deps.testImap({
    host: account.host,
    port: account.port ?? 993,
    secure: account.secure !== false,
    user: account.user,
    pass,
    requireTls: account.requireTls ?? null,
    timeoutMs,
  });

  if (!result?.ok) {
    const reason = result?.error || 'the connection failed';
    // A refusal to send the password in the clear has to be recognised before
    // the sign-in advice below, because its wording mentions the password and
    // would otherwise be read as a rejected credential. Nothing was rejected:
    // nothing was sent, on purpose, and the fix is a port rather than a
    // different password.
    if (/still in the clear/i.test(reason)) {
      return check(
        id, label, 'fail',
        `${account.host}: ${reason}`,
        `Zelos stopped before your password left this machine. Use the TLS port in Settings → Mail — ${guess.host ? `${guess.host}:${guess.port}` : 'usually 993'} — and if this host really is a local bridge that cannot do TLS, turn requireTls off for this account.`,
      );
    }
    const authish = /auth|login|credential|password|invalid|denied/i.test(reason);
    return check(
      id, label, 'fail',
      `${account.host}: ${reason}`,
      authish
        ? `Most sign-in failures here are not a wrong password — they are a provider that refuses ordinary passwords over IMAP. ${guess.note}`
        : `Check the server and port in Settings → Mail (${account.host}:${account.port ?? 993}${account.secure === false ? ', STARTTLS' : ', TLS'}). If they are right, the server may be blocking IMAP for this account — that is a setting in your provider's web mail.`,
    );
  }

  const names = new Set((result.mailboxes ?? []).map((m) => (typeof m === 'string' ? m : m.name)));
  const wanted = Array.isArray(account.mailboxes) && account.mailboxes.length ? account.mailboxes : ['INBOX'];
  const missing = wanted.filter((m) => names.size && !names.has(m));
  if (missing.length) {
    return check(
      id, label, 'warn',
      `Signed in to ${account.host}, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the server.`,
      `Zelos will read nothing from ${missing.length === 1 ? 'that folder' : 'those folders'}. Pick from what the server actually has: ${[...names].slice(0, 8).join(', ')}${names.size > 8 ? ', …' : ''}`,
    );
  }
  return check(id, label, 'pass', `Signed in to ${account.host} · ${names.size} folder${names.size === 1 ? '' : 's'} · reading ${wanted.join(', ')}`);
}

/** Read a fetch Response with a hard byte cap, so a huge .ics cannot OOM us. */
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`the calendar is larger than ${maxBytes} bytes`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function checkCalendar(calendar, deps, { timeoutMs, signal }) {
  const name = calendar.label || calendar.url || calendar.id;
  const id = `calendar.${calendar.id}`;
  const label = `Calendar · ${name}`;

  if (!calendar.url) {
    return check(id, label, 'fail', 'This calendar has no address.',
      'Open Settings → Calendars and paste the subscription link (it ends in .ics), the CalDAV server address, or the path to a local file.');
  }

  if (calendar.kind === 'file') {
    try {
      const stat = fs.statSync(calendar.url);
      if (!stat.isFile()) throw new Error('that path is not a file');
      if (stat.size > MAX_ICS_BYTES) throw new Error(`the file is larger than ${MAX_ICS_BYTES} bytes`);
      const parsed = parseICS(fs.readFileSync(calendar.url, 'utf8'));
      return check(id, label, 'pass', `${calendar.url} · ${parsed.vevents.length} entr${parsed.vevents.length === 1 ? 'y' : 'ies'}`);
    } catch (err) {
      return check(id, label, 'fail', `${calendar.url}: ${errorText(err)}`,
        'Check the path in Settings → Calendars. It must be a readable .ics file on this machine.');
    }
  }

  if (calendar.kind === 'caldav') {
    let pass = null;
    try {
      pass = calendar.keyRef ? await deps.getSecret(calendar.keyRef) : null;
    } catch { /* reported as a connection failure below */ }
    const result = await deps.testCalDav({ url: calendar.url, user: calendar.user || '', pass, timeoutMs, signal });
    if (!result?.ok) {
      return check(id, label, 'fail', `${calendar.url}: ${result?.error || 'the connection failed'}`,
        'Check the server address, the username and the password in Settings → Calendars. iCloud and Fastmail need an app-specific password here, not your account password.');
    }
    return check(id, label, 'pass', `${result.calendars.length} calendar${result.calendars.length === 1 ? '' : 's'} at ${calendar.url}`);
  }

  // webcal: is how Apple and friends publish an https .ics.
  const url = safeUrl(String(calendar.url).replace(/^webcal:/i, 'https:'));
  if (!url || !/^https?:/i.test(url)) {
    return check(id, label, 'fail', `${calendar.url} is not an http, https or webcal address.`,
      'Open Settings → Calendars and paste the subscription link your calendar provider gives you — it starts with https:// or webcal:// and usually ends in .ics.');
  }

  const headers = { Accept: 'text/calendar, text/plain;q=0.5' };
  try {
    if (calendar.user && calendar.keyRef) {
      const pass = await deps.getSecret(calendar.keyRef);
      if (pass) headers.Authorization = `Basic ${Buffer.from(`${calendar.user}:${pass}`).toString('base64')}`;
    }
  } catch { /* try unauthenticated; the server's answer is the real diagnosis */ }

  try {
    // The caller's signal must not replace the timeout — a calendar host that
    // accepts the connection and then says nothing would hang the diagnosis
    // forever, which is the one thing a diagnostic may never do.
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = await deps.fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      const advice = response.status === 401 || response.status === 403
        ? 'That link needs credentials, or it has been revoked. Re-copy the subscription link from your calendar provider.'
        : response.status === 404
          ? 'That link no longer exists. Re-copy the subscription link from your calendar provider.'
          : 'Open the link in a browser: whatever it shows you is what Zelos is getting.';
      return check(id, label, 'fail', `${url} answered ${response.status} ${response.statusText}`, advice);
    }
    const parsed = parseICS(await readCapped(response, MAX_ICS_BYTES));
    if (!parsed.vevents.length) {
      return check(id, label, 'warn', `${url} is reachable but has no entries in it.`,
        'That is fine if the calendar really is empty. If it should not be, check you copied the link for the right calendar.');
    }
    return check(id, label, 'pass', `${parsed.calname || url} · ${parsed.vevents.length} entr${parsed.vevents.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    return check(id, label, 'fail', `${url}: ${errorText(err)}`,
      'Check the address in Settings → Calendars, and that this machine can reach it. A subscription link that works in a browser will work here.');
  }
}

/* ------------------------------------------------------------------ *
 * diagnose
 * ------------------------------------------------------------------ */

/**
 * Run every check.
 *
 * -> {ok, status, checks:[{id,label,status,detail,action}], counts, home, node, ms}
 *
 * `ok` is true only when nothing failed. Warnings do not make it false: "you
 * have not connected mail yet" is a fact about a new install, not a fault.
 */
export async function diagnose({ config = null, timeoutMs = 10_000, signal, deps = {} } = {}) {
  const startedMs = Date.now();
  const d = { ...DEFAULT_DEPS, ...deps };
  const checks = [];

  // Before anything resolves paths(): that call creates and chmods the folder.
  const home = homeDirPath();
  checks.push(checkNode());
  checks.push(checkHome(home));

  let cfg = config;
  let loadError = null;
  let configFile = path.join(home, 'config.json');
  try {
    const where = paths();
    configFile = where.configFile;
    if (!cfg) cfg = loadConfig();
  } catch (err) {
    loadError = errorText(err);
  }
  checks.push(checkConfig(cfg, configFile, loadError));

  checks.push(await checkSecrets(d));

  if (cfg) {
    const { result: keyCheck, key } = await checkModelKey(cfg, d);
    checks.push(keyCheck);
    checks.push(await checkModelEndpoint(cfg, d, {
      key,
      keyChecked: keyCheck.status === 'pass',
      timeoutMs,
      signal,
    }));

    const mail = (Array.isArray(cfg.mail) ? cfg.mail : []).filter((a) => a && a.enabled);
    if (!mail.length) {
      checks.push(check(
        'mail', 'Mail', 'warn',
        'No mail account is switched on.',
        'Open Settings → Mail to add one. Zelos reads over IMAP with BODY.PEEK, so nothing is marked as read, and it never sends.',
      ));
    } else {
      // One at a time: several TLS logins to the same provider at once is how a
      // diagnostic gets itself rate-limited.
      for (const account of mail) {
        checks.push(await checkMailAccount(account, d, { timeoutMs }));
      }
    }

    const calendars = (Array.isArray(cfg.calendars) ? cfg.calendars : []).filter((c) => c && c.enabled);
    if (!calendars.length) {
      checks.push(check(
        'calendar', 'Calendars', 'warn',
        'No calendar is switched on.',
        'Open Settings → Calendars and paste a subscription link (.ics), a CalDAV address, or the path to a local file. Zelos only ever reads.',
      ));
    } else {
      for (const calendar of calendars) {
        checks.push(await checkCalendar(calendar, d, { timeoutMs, signal }));
      }
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1;

  /* `ok` and `ready` are two different questions, and conflating them would
     make one of them useless. `ok` is "nothing is broken" — it is what the exit
     code reports, so a fresh install that has simply not been set up yet does
     not look like a fault. `ready` is "Zelos can actually do its job": a model
     to think with, and at least one source to think about. */
  const sources = (Array.isArray(cfg?.mail) ? cfg.mail : []).filter((a) => a?.enabled).length
    + (Array.isArray(cfg?.calendars) ? cfg.calendars : []).filter((c) => c?.enabled).length;
  const ready = counts.fail === 0 && Boolean(String(cfg?.model?.model ?? '').trim()) && sources > 0;

  return {
    ok: counts.fail === 0,
    ready,
    status: counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass',
    checks,
    counts,
    home,
    node: process.versions.node,
    ranAt: new Date().toISOString(),
    ms: Date.now() - startedMs,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const MARKS = { pass: '✓', warn: '!', fail: '✕', skip: '·' };
const RULE = '━'.repeat(58);

/** Greedy wrap that never breaks a word, so a path stays copy-pasteable. */
function wrap(text, width, indent) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`);
}

/** The terminal report. Same findings as the JSON, in sentences. */
export function formatReport(report, { width = 76 } = {}) {
  const out = ['', '  ZELOS DOCTOR', `  ${RULE}`, ''];

  const labelWidth = Math.max(...report.checks.map((c) => c.label.length), 12);
  const detailIndent = ' '.repeat(2 + 1 + 2 + labelWidth + 2);
  const actionIndent = '       ';

  for (const c of report.checks) {
    const head = `  ${MARKS[c.status] ?? '·'}  ${c.label.padEnd(labelWidth)}  `;
    const detail = wrap(c.detail, Math.max(24, width - detailIndent.length), detailIndent);
    out.push(`${head}${(detail[0] ?? '').trimStart()}`);
    out.push(...detail.slice(1));
    if (c.action) {
      // The arrow marks the sentence that tells you what to do next.
      const action = wrap(c.action, Math.max(28, width - actionIndent.length - 3), `${actionIndent}   `);
      out.push(`${actionIndent}→  ${(action[0] ?? '').trimStart()}`);
      out.push(...action.slice(1));
    }
    out.push('');
  }

  out.push(`  ${RULE}`);
  const { pass, warn, fail, skip } = report.counts;
  const parts = [`${pass} fine`];
  if (warn) parts.push(`${warn} worth knowing`);
  if (fail) parts.push(`${fail} broken`);
  if (skip) parts.push(`${skip} not checked`);
  out.push(`  ${parts.join(' · ')}`);
  if (fail) {
    out.push('  Fix the lines marked ✕ — each one says what to do — then run zelos doctor again.');
  } else if (!report.ready) {
    out.push('  Nothing is broken. Zelos is not finished being set up yet: the ! lines');
    out.push('  are what is left, and each one says where to do it.');
  } else if (warn) {
    out.push('  Nothing is broken. The ! lines are things worth knowing about.');
  } else {
    out.push('  Everything checks out.');
  }
  out.push('');
  return `${out.join('\n')}\n`;
}

/**
 * One call for the launcher: run the checks, render them, hand back the exit
 * code. Non-zero means something is genuinely wrong, never merely unfinished.
 */
export async function doctor(options = {}) {
  const report = await diagnose(options);
  return { code: report.ok ? 0 : 1, report, text: formatReport(report) };
}
