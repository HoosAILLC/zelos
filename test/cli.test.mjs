/**
 * test/cli.test.mjs — the package, and the four things you can type.
 *
 * Two halves:
 *
 *  1. **The package.** `npm pack` is run for real, the tarball is extracted to
 *     a temp directory, and the program is run from that clean copy with no
 *     `node_modules` anywhere near it. "It has no dependencies" and "the
 *     published tarball works" are claims about an artefact; the only honest
 *     way to check them is to build the artefact and run it.
 *
 *  2. **The command line.** `zelos`, `zelos sweep`, `zelos doctor`, `zelos mcp`.
 *     Every subprocess here gets a throwaway ZELOS_HOME and is forced onto the
 *     encrypted-file secret backend, so no test can touch the real ~/.zelos or
 *     the operator's keychain. The only sockets opened are to mock servers on
 *     127.0.0.1.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* Nothing in this file may resolve the real home. Set it before importing any
   module that reads it, and give every subprocess its own. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-cli-test-'));
process.env.ZELOS_HOME = path.join(SCRATCH, 'default-home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';

const { diagnose, formatReport, compareVersions, MIN_NODE } = await import('../core/doctor.mjs');
const { parseArgs, COMMANDS, browserLaunchPlan, openBrowser } = await import('../zelos.mjs');

after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

let homeCounter = 0;
function freshHome(seed = null) {
  const home = path.join(SCRATCH, `home-${homeCounter += 1}`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (seed) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(seed, null, 2), { mode: 0o600 });
  return home;
}

function run(args, { home, cwd = ROOT, env = {}, stdin = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['zelos.mjs', ...args], {
      cwd,
      env: {
        ...process.env,
        ZELOS_HOME: home ?? freshHome(),
        ZELOS_SECRETS_BACKEND: 'encrypted-file',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`zelos ${args.join(' ')} did not finish in ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** A local HTTP server. Nothing in this suite ever leaves 127.0.0.1. */
async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ================================================================== *
 * 1. The package
 * ================================================================== */

describe('package.json is ready to publish as zelos-app', () => {
  test('it is named, binned and engined the way npx needs', () => {
    assert.equal(pkg.name, 'zelos-app');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.bin.zelos, './zelos.mjs');
    // 22.13, not 22.5: `node:sqlite` needed --experimental-sqlite until then,
    // and core/db.mjs imports it at module load, so an earlier runtime does not
    // fail on some feature nobody uses — it fails on the first line.
    assert.equal(pkg.engines.node, '>=22.13.0');
    assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  });

  test('it points at the site and at the source, not at a placeholder', () => {
    assert.equal(pkg.homepage, 'https://zelos-app.netlify.app');
    // `repository` is where the code is, which is not where the product is.
    // Pointing it at the site made `npm repo` open a marketing page and left
    // "free and open source" with nowhere to go.
    assert.match(String(pkg.repository?.url ?? ''), /github\.com\/[^/]+\/zelos(\.git)?$/);
    assert.match(String(pkg.bugs?.url ?? ''), /github\.com\/[^/]+\/zelos\/issues$/);
  });

  test('no dependencies, of any kind', () => {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
      assert.ok(
        pkg[field] === undefined || Object.keys(pkg[field]).length === 0,
        `package.json.${field} is populated: ${JSON.stringify(pkg[field])}`,
      );
    }
  });

  /**
   * `npx zelos-app` on a machine that has never seen Zelos must not run code
   * chosen by the package at install time. No install hook is the point: there
   * is nothing to audit because there is nothing to run.
   */
  test('nothing runs at install time', () => {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'preprepare', 'postprepare']) {
      assert.equal(pkg.scripts?.[hook], undefined, `package.json declares a ${hook} script`);
    }
  });

  test('the files allowlist names exactly what ships', () => {
    // README.md is listed even though npm would include it regardless: the
    // allowlist is read by people as the definition of what ships, and a file
    // that ships without appearing in it makes the list a half-truth.
    assert.deepEqual(pkg.files,
      ['core/', 'ui/', 'assets/', 'docs/*.md', 'zelos.mjs', 'README.md', 'LICENSE']);
  });
});

describe('npm pack produces a tarball that runs', () => {
  const packDir = path.join(SCRATCH, 'pack');
  const extractDir = path.join(SCRATCH, 'extract');
  let tarball = null;
  let entries = [];
  let extracted = null;

  before(async () => {
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    const packed = await new Promise((resolve, reject) => {
      const child = spawn('npm', ['pack', '--json', '--pack-destination', packDir], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`npm pack exited ${code}: ${err}`));
        else resolve(out);
      });
    });
    tarball = path.join(packDir, JSON.parse(packed)[0].filename);

    entries = (await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-tzf', tarball], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
    })).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^package\//, ''));

    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', tarball, '-C', extractDir], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
    extracted = path.join(extractDir, 'package');
  });

  test('the tarball carries the app and its docs', () => {
    for (const wanted of ['package.json', 'zelos.mjs', 'LICENSE', 'core/server.mjs', 'core/doctor.mjs', 'ui/index.html', 'ui/app.css', 'docs/INSTALL.md', 'docs/SECURITY.md']) {
      assert.ok(entries.includes(wanted), `${wanted} is missing from the tarball`);
    }
    assert.ok(entries.some((e) => e.startsWith('assets/')), 'no assets shipped');
  });

  test('it does not carry the tests, the Electron shell, or the screenshots', () => {
    const strays = entries.filter((e) => /^(test|desktop)\//.test(e) || e.startsWith('docs/shots/'));
    assert.deepEqual(strays, [], `the tarball ships files it should not:\n  ${strays.join('\n  ')}`);
  });

  test('nothing outside the allowlist sneaks in', () => {
    const allowed = (e) => e === 'package.json' || e === 'zelos.mjs' || e === 'LICENSE'
      || e === 'README.md'
      || e.startsWith('core/') || e.startsWith('ui/') || e.startsWith('assets/')
      || /^docs\/[^/]+\.md$/.test(e);
    const strays = entries.filter((e) => !allowed(e));
    assert.deepEqual(strays, [], `unexpected files in the tarball:\n  ${strays.join('\n  ')}`);
  });

  test('the extract has no node_modules and no lockfile', () => {
    for (const name of ['node_modules', 'package-lock.json', 'npm-shrinkwrap.json']) {
      assert.ok(!fs.existsSync(path.join(extracted, name)), `${name} is present in the extract`);
    }
  });

  test('--version runs from the clean extract', async () => {
    const home = freshHome();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['zelos.mjs', '--version'], {
        cwd: extracted,
        env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
  });

  test('--help runs from the clean extract and names every command', async () => {
    const home = freshHome();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['zelos.mjs', '--help'], {
        cwd: extracted,
        env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    for (const command of ['zelos sweep', 'zelos doctor', 'zelos mcp']) {
      assert.ok(result.stdout.includes(command), `--help does not mention ${command}`);
    }
  });

  test('the bin the tarball declares is the file the tarball contains', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
    assert.equal(shipped.name, 'zelos-app');
    assert.ok(fs.existsSync(path.join(extracted, shipped.bin.zelos)), 'bin points at a file the tarball does not have');
  });
});

/* ================================================================== *
 * 2. Argument parsing
 * ================================================================== */

describe('parseArgs', () => {
  test('a bare invocation is still exactly what it was', () => {
    assert.deepEqual(parseArgs([]), {
      command: 'run', port: null, home: null, open: true, sweepNow: false,
      mode: null, json: false, version: false, help: false,
    });
    const flags = parseArgs(['--port=7788', '--home', '/tmp/z', '--no-open', '--sweep-now']);
    assert.equal(flags.command, 'run');
    assert.equal(flags.port, 7788);
    assert.equal(flags.home, '/tmp/z');
    assert.equal(flags.open, false);
    assert.equal(flags.sweepNow, true);
  });

  test('every command in the closed set parses', () => {
    for (const command of COMMANDS) {
      assert.equal(parseArgs([command]).command, command);
    }
  });

  test('help and version work as words as well as flags', () => {
    assert.equal(parseArgs(['help']).help, true);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['version']).version, true);
    assert.equal(parseArgs(['-v']).version, true);
  });

  test('a flag that would do nothing is an error, not a shrug', () => {
    assert.throws(() => parseArgs(['doctor', '--port', '7777']), /--port does not apply/);
    assert.throws(() => parseArgs(['--mode', 'full']), /--mode does not apply/);
    assert.throws(() => parseArgs(['mcp', '--json']), /--json does not apply/);
    // …but they are fine where they belong.
    assert.equal(parseArgs(['sweep', '--mode', 'light']).mode, 'light');
    assert.equal(parseArgs(['doctor', '--json']).json, true);
  });

  test('nonsense is refused with something readable', () => {
    assert.throws(() => parseArgs(['frobnicate']), /unknown command frobnicate/);
    assert.throws(() => parseArgs(['--not-a-flag']), /unknown option/);
    assert.throws(() => parseArgs(['sweep', 'again']), /unexpected argument again/);
    assert.throws(() => parseArgs(['sweep', '--mode', 'sideways']), /--mode must be one of/);
    assert.throws(() => parseArgs(['--home']), /--home needs a value/);
  });
});

/* ================================================================== *
 * 3. doctor — the diagnosis
 * ================================================================== */

const SILENT_DEPS = {
  backend: async () => ({ name: 'macos-keychain', writable: true, note: 'Stored in your login keychain.' }),
  getSecret: async () => null,
  listModels: async () => { throw new Error('listModels should not have been called'); },
  testImap: async () => { throw new Error('testImap should not have been called'); },
  testCalDav: async () => { throw new Error('testCalDav should not have been called'); },
  fetchImpl: async () => { throw new Error('fetch should not have been called'); },
};

const byId = (report, id) => report.checks.find((c) => c.id === id);

describe('doctor', () => {
  test('compareVersions orders releases numerically, not alphabetically', () => {
    assert.equal(compareVersions('22.5.0', MIN_NODE), 0);
    assert.equal(compareVersions('9.0.0', '22.5.0'), -1); // "9" > "2" as text
    assert.equal(compareVersions('26.3.0', '22.5.0'), 1);
    assert.equal(compareVersions('22.4.9', '22.5.0'), -1);
    assert.equal(compareVersions('26.0.0-nightly', '26.0.0'), 0);
  });

  test('a brand-new install is not broken, just unfinished', async () => {
    process.env.ZELOS_HOME = freshHome();
    const report = await diagnose({ deps: SILENT_DEPS });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === 'fail'), null, 2));
    assert.equal(report.ready, false, 'nothing is configured, so it cannot be ready');
    assert.equal(byId(report, 'node').status, 'pass');
    assert.equal(byId(report, 'home').status, 'pass');
    assert.equal(byId(report, 'mail').status, 'warn');
    assert.equal(byId(report, 'calendar').status, 'warn');
  });

  test('a settings file that will not load is a failure that names the setting', async () => {
    process.env.ZELOS_HOME = freshHome({ version: 1, sweep: { intervalMinutes: 2 }, ui: { accent: 'blue' } });
    const report = await diagnose({ deps: SILENT_DEPS });
    const config = byId(report, 'config');
    assert.equal(config.status, 'fail');
    assert.match(config.detail, /sweep\.intervalMinutes/);
    assert.match(config.detail, /ui\.accent/);
    assert.match(config.action, /config\.json/);
    assert.equal(report.ok, false);
  });

  test('a home directory other accounts can read is a failure, and says how to close it', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX modes do not apply on Windows');
    const home = freshHome();
    fs.chmodSync(home, 0o755);
    process.env.ZELOS_HOME = home;
    const report = await diagnose({ deps: SILENT_DEPS });
    const check = byId(report, 'home');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /readable by other accounts/);
    assert.match(check.action, /chmod 700/);
  });

  test('a missing home is a note about the first launch, not an error', async () => {
    process.env.ZELOS_HOME = path.join(SCRATCH, 'never-created-home');
    const report = await diagnose({ deps: SILENT_DEPS });
    const check = byId(report, 'home');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /does not exist yet/);
    assert.equal(report.ok, true);
  });

  test('a secret store that cannot be written is a failure', async () => {
    process.env.ZELOS_HOME = freshHome();
    const report = await diagnose({
      deps: { ...SILENT_DEPS, backend: async () => ({ name: 'macos-keychain', writable: false, note: 'x' }) },
    });
    assert.equal(byId(report, 'secrets').status, 'fail');
    assert.equal(report.ok, false);
  });

  test('the encrypted-file fallback is surfaced with its own note, and is not a failure', async () => {
    process.env.ZELOS_HOME = freshHome();
    const note = 'This protects the file at rest but not against a process running as you.';
    const report = await diagnose({
      deps: { ...SILENT_DEPS, backend: async () => ({ name: 'encrypted-file', writable: true, note }) },
    });
    const check = byId(report, 'secrets');
    assert.equal(check.status, 'warn');
    assert.ok(check.detail.includes(note), 'the backend note must be repeated verbatim');
    assert.equal(report.ok, true);
  });

  test('a remote model with a chosen model and no stored key is a failure', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
    });
    const report = await diagnose({ deps: SILENT_DEPS });
    const key = byId(report, 'model.key');
    assert.equal(key.status, 'fail');
    assert.match(key.action, /Settings/);
    // With no key there is nothing to reach the endpoint with, so it is not
    // probed — a second failure that only says "401" would teach nobody anything.
    assert.equal(byId(report, 'model').status, 'skip');
    assert.equal(report.ok, false);
  });

  test('a local model needs no key and is probed anyway', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: { ...SILENT_DEPS, listModels: async () => [{ id: 'llama3.2', label: 'llama3.2' }] },
    });
    assert.equal(byId(report, 'model.key').status, 'pass');
    assert.match(byId(report, 'model.key').detail, /no API key needed/i);
    assert.equal(byId(report, 'model').status, 'pass');
    assert.equal(report.ok, true);
  });

  test('a local model that is not running says how to start it', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        listModels: async () => { throw Object.assign(new Error('Could not reach the model at http://127.0.0.1:11434/v1 (ECONNREFUSED)'), { status: null }); },
      },
    });
    const model = byId(report, 'model');
    assert.equal(model.status, 'fail');
    assert.match(model.action, /ollama serve/);
    assert.equal(report.ok, false);
  });

  test('a key the provider refuses is reported as a key problem, not a network one', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'sk-stored-key',
        listModels: async () => { throw Object.assign(new Error('rejected'), { status: 401 }); },
      },
    });
    const model = byId(report, 'model');
    assert.equal(model.status, 'fail');
    assert.match(model.detail, /refused the stored key/);
    assert.match(model.action, /Settings → Model/);
  });

  test('a model the endpoint does not offer is a warning that lists what it does', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'llama-4-typo', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: { ...SILENT_DEPS, listModels: async () => [{ id: 'qwen2.5', label: 'qwen2.5' }] },
    });
    const model = byId(report, 'model');
    assert.equal(model.status, 'warn');
    assert.match(model.detail, /does not list "llama-4-typo"/);
    assert.match(model.action, /qwen2\.5/);
    assert.equal(report.ok, true, 'a typo in a model name is not a broken machine');
  });

  test('an endpoint with no model list is still a reachable endpoint', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: { ...SILENT_DEPS, listModels: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } },
    });
    assert.equal(byId(report, 'model').status, 'pass');
  });

  test('a mail account with no stored password says which password the provider wants', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_1', enabled: true, label: 'Work', host: 'imap.gmail.com', port: 993, secure: true, user: 'someone@gmail.com', keyRef: 'mail.m_1' }],
    });
    const report = await diagnose({ deps: SILENT_DEPS });
    const check = byId(report, 'mail.m_1');
    assert.equal(check.status, 'fail');
    assert.match(check.action, /App Password/i);
    assert.equal(report.ok, false);
  });

  test('a mail sign-in that is refused explains why an ordinary password fails', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_2', enabled: true, label: 'Work', host: 'imap.gmail.com', port: 993, secure: true, user: 'someone@gmail.com', keyRef: 'mail.m_2' }],
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'hunter2',
        testImap: async () => ({ ok: false, capabilities: [], mailboxes: [], error: '[AUTHENTICATIONFAILED] Invalid credentials' }),
      },
    });
    const check = byId(report, 'mail.m_2');
    assert.equal(check.status, 'fail');
    assert.match(check.action, /app password/i);
  });

  /**
   * REGRESSION. `requireTls` reached core/sources/imap.mjs from nowhere: not
   * from the sweep, not from the mail test, and not from here. A doctor that
   * signs in where the real run would refuse is not a diagnosis — it is a second,
   * more permissive client, reporting an account healthy on the morning its mail
   * quietly stops arriving.
   */
  test('doctor connects under the account\'s own TLS rule, and says what to do when it refuses', async () => {
    const seen = [];
    const testImap = async (opts) => {
      seen.push(opts);
      return { ok: false, capabilities: [], mailboxes: [], error: 'IMAP 127.0.0.1:1143 — this connection is still in the clear and the server never offered STARTTLS, so your password was not sent.' };
    };

    process.env.ZELOS_HOME = freshHome({
      mail: [
        { id: 'm_strict', enabled: true, label: 'Bridge', host: '127.0.0.1', port: 1143, secure: false, user: 'a@example.com', keyRef: 'mail.m_strict', requireTls: true },
        { id: 'm_quiet', enabled: true, label: 'Work', host: 'imap.fastmail.com', port: 993, secure: true, user: 'b@fastmail.com', keyRef: 'mail.m_quiet' },
        { id: 'm_open', enabled: true, label: 'Local', host: '127.0.0.1', port: 1144, secure: false, user: 'c@example.com', keyRef: 'mail.m_open', requireTls: false },
      ],
    });
    const report = await diagnose({ deps: { ...SILENT_DEPS, getSecret: async () => 'hunter2', testImap } });

    assert.deepEqual(seen.map((o) => o.requireTls), [true, null, false],
      'each account is tested under its own rule, and one that never said becomes null, not false');

    // The refusal must not be dressed up as a rejected credential: nothing was
    // rejected, because nothing was sent.
    const strict = byId(report, 'mail.m_strict');
    assert.equal(strict.status, 'fail');
    assert.match(strict.action, /requireTls/);
    assert.ok(!/App Password|app password/.test(strict.action),
      'a refusal to use cleartext is not a password problem and must not be described as one');
  });

  test('a mailbox the server does not have is a warning that lists the real ones', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_3', enabled: true, label: 'Work', host: 'imap.fastmail.com', port: 993, secure: true, user: 'a@fastmail.com', keyRef: 'mail.m_3', mailboxes: ['INBOX', 'Projects'] }],
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'app-password',
        listModels: async () => [], // a key exists, so the endpoint does get probed
        testImap: async () => ({ ok: true, capabilities: [], mailboxes: [{ name: 'INBOX' }, { name: 'Archive' }], error: null }),
      },
    });
    const check = byId(report, 'mail.m_3');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /Projects/);
    assert.match(check.action, /Archive/);
    assert.equal(report.ok, true);
  });

  test('a disabled account is not checked at all', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_off', enabled: false, label: 'Old', host: 'imap.example.com', user: 'x@example.com', keyRef: 'mail.m_off' }],
    });
    // SILENT_DEPS throws if anything network-shaped is called.
    const report = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(report, 'mail.m_off'), undefined);
    assert.equal(byId(report, 'mail').status, 'warn');
  });

  test('a calendar link that answers 404 is a failure that says to re-copy it', async (t) => {
    const mock = await mockServer((req, res) => { res.writeHead(404); res.end('gone'); });
    t.after(() => mock.close());
    process.env.ZELOS_HOME = freshHome({
      calendars: [{ id: 'c_1', enabled: true, label: 'Team', kind: 'ics', url: `${mock.origin}/team.ics`, user: '', keyRef: null }],
    });
    const report = await diagnose({ deps: { ...SILENT_DEPS, fetchImpl: (...args) => globalThis.fetch(...args) } });
    const check = byId(report, 'calendar.c_1');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /404/);
    assert.match(check.action, /re-copy/i);
  });

  test('a calendar link that answers with a calendar passes', async (t) => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Team',
      'BEGIN:VEVENT', 'UID:1@zelos', 'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z',
      'SUMMARY:Standup', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    const mock = await mockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(ics);
    });
    t.after(() => mock.close());
    process.env.ZELOS_HOME = freshHome({
      calendars: [{ id: 'c_2', enabled: true, label: 'Team', kind: 'ics', url: `${mock.origin}/team.ics`, user: '', keyRef: null }],
    });
    const report = await diagnose({ deps: { ...SILENT_DEPS, fetchImpl: (...args) => globalThis.fetch(...args) } });
    const check = byId(report, 'calendar.c_2');
    assert.equal(check.status, 'pass', check.detail);
    assert.match(check.detail, /1 entry/);
  });

  test('a local .ics file calendar is read off disk', async () => {
    const home = freshHome();
    const file = path.join(home, 'mine.ics');
    fs.writeFileSync(file, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:2@zelos\r\nDTSTART:20260811T180000Z\r\nSUMMARY:Lunch\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      calendars: [{ id: 'c_3', enabled: true, label: 'Mine', kind: 'file', url: file, user: '', keyRef: null }],
    }));
    process.env.ZELOS_HOME = home;
    const report = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(report, 'calendar.c_3').status, 'pass');

    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      calendars: [{ id: 'c_4', enabled: true, label: 'Gone', kind: 'file', url: path.join(home, 'missing.ics'), user: '', keyRef: null }],
    }));
    const broken = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(broken, 'calendar.c_4').status, 'fail');
  });

  test('every failure and every warning ends in something to do', async () => {
    process.env.ZELOS_HOME = freshHome({
      version: 1,
      sweep: { intervalMinutes: 1 },
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
      mail: [{ id: 'm_9', enabled: true, label: 'Work', host: '', port: 993, secure: true, user: 'me@gmail.com', keyRef: 'mail.m_9' }],
      calendars: [{ id: 'c_9', enabled: true, label: 'Bad', kind: 'ics', url: 'ftp://example.com/x.ics', user: '', keyRef: null }],
    });
    const report = await diagnose({ deps: SILENT_DEPS });
    const actionless = report.checks
      .filter((c) => (c.status === 'fail' || c.status === 'warn') && !c.action)
      .map((c) => c.id);
    assert.deepEqual(actionless, [], `these say what is wrong but not what to do: ${actionless.join(', ')}`);
    for (const c of report.checks) {
      assert.ok(c.detail.length > 0, `${c.id} has no detail`);
      assert.ok(['pass', 'warn', 'fail', 'skip'].includes(c.status), `${c.id} has status ${c.status}`);
    }
  });

  test('no stored secret is ever repeated back in the report', async () => {
    const sentinel = 'sk-do-not-print-me-0000';
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
      mail: [{ id: 'm_s', enabled: true, label: 'Work', host: 'imap.fastmail.com', port: 993, secure: true, user: 'a@fastmail.com', keyRef: 'mail.m_s' }],
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => sentinel,
        listModels: async () => [{ id: 'claude-opus-5', label: 'Claude' }],
        testImap: async () => ({ ok: true, capabilities: [], mailboxes: [{ name: 'INBOX' }], error: null }),
      },
    });
    assert.ok(!JSON.stringify(report).includes(sentinel), 'the report contains a secret value');
    assert.ok(!formatReport(report).includes(sentinel), 'the printed report contains a secret value');
    assert.equal(report.ok, true);
    assert.equal(report.ready, true, 'a model and a source are configured and both answer');
  });

  test('the printed report puts an arrow on every action', async () => {
    process.env.ZELOS_HOME = freshHome({ sweep: { intervalMinutes: 1 } });
    const report = await diagnose({ deps: SILENT_DEPS });
    const text = formatReport(report);
    // Only the line that opens an action carries the marker in that column;
    // "Settings → Model" inside a sentence must not be counted.
    const arrows = (text.match(/^ {7}→ {2}/gm) ?? []).length;
    const actions = report.checks.filter((c) => c.action).length;
    assert.equal(arrows, actions, 'every action line should be marked, and nothing else should be');
    assert.match(text, /ZELOS DOCTOR/);
    assert.ok(text.split('\n').every((line) => line.length <= 100), 'the report should not need a wide terminal');
  });
});

/* ================================================================== *
 * 4. The subcommands, as processes
 * ================================================================== */

describe('zelos doctor, from the command line', () => {
  test('a fresh home exits 0 and reads like sentences', async () => {
    const { code, stdout } = await run(['doctor']);
    assert.equal(code, 0);
    assert.match(stdout, /ZELOS DOCTOR/);
    assert.match(stdout, /Node\.js/);
    assert.match(stdout, /Nothing is broken/);
  });

  test('a broken settings file exits 1', async () => {
    const home = freshHome({ version: 1, ui: { accent: 'not-a-colour' } });
    const { code, stdout } = await run(['doctor'], { home });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /ui\.accent/);
  });

  test('--json prints the same findings as machine-readable data', async () => {
    const home = freshHome({ version: 1, ui: { accent: 'not-a-colour' } });
    const { code, stdout } = await run(['doctor', '--json'], { home });
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, false);
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.some((c) => c.id === 'config' && c.status === 'fail'));
    assert.equal(report.home, home);
  });
});

describe('zelos sweep, from the command line', () => {
  test('with nothing configured it fails, says why, and points at doctor', async () => {
    const { code, stdout } = await run(['sweep']);
    assert.equal(code, 1);
    assert.match(stdout, /Sweep failed/);
    assert.match(stdout, /zelos doctor/);
  });

  test('against a model on this machine it runs, summarises, and exits 0', async (t) => {
    const board = {
      first: null,
      items: [],
      notes: ['Nothing needs you right now.'],
    };
    let hits = 0;
    const mock = await mockServer((req, res) => {
      hits += 1;
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'mock-local',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(board) } }],
          usage: { prompt_tokens: 120, completion_tokens: 34 },
        }));
      });
    });
    t.after(() => mock.close());

    const home = freshHome({
      model: { protocol: 'openai', baseUrl: `${mock.origin}/v1`, label: 'Local', model: 'mock-local', keyRef: 'model.default' },
    });
    const { code, stdout, stderr } = await run(['sweep'], { home });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.equal(hits, 1, 'the sweep should have called the model exactly once');
    assert.match(stdout, /ZELOS SWEEP/);
    assert.match(stdout, /Full sweep finished/);
    assert.match(stdout, /Board/);
    assert.match(stdout, /120 tokens in, 34 out/);
  });

  test('--mode light never calls the model', async (t) => {
    let hits = 0;
    const mock = await mockServer((req, res) => {
      hits += 1;
      res.writeHead(500);
      res.end('{}');
    });
    t.after(() => mock.close());
    const home = freshHome({
      model: { protocol: 'openai', baseUrl: `${mock.origin}/v1`, label: 'Local', model: 'mock-local', keyRef: 'model.default' },
    });
    const { code, stdout } = await run(['sweep', '--mode', 'light'], { home });
    assert.equal(code, 0, stdout);
    assert.equal(hits, 0, 'a light sweep must not reach the model');
    assert.match(stdout, /Light sweep finished/);
  });

  test('--json emits the run result and nothing else on stdout', async () => {
    const home = freshHome();
    const { code, stdout } = await run(['sweep', '--json'], { home });
    assert.equal(code, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    assert.ok(result.runId, 'the result should name its run');
    assert.ok(result.error, 'a failed run should carry its reason');
  });
});

describe('zelos mcp, from the command line', () => {
  test('it serves JSON-RPC on stdout and exits 0 when stdin closes', async () => {
    const { code, stdout } = await run(['mcp'], { stdin: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' });
    assert.equal(code, 0);
    const lines = stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `stdout must carry JSON-RPC and nothing else:\n${stdout}`);
    assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} });
  });

  test('the launch banner never reaches the JSON-RPC channel', async () => {
    const { stdout } = await run(['mcp'], { stdin: '' });
    assert.equal(stdout, '', `zelos mcp wrote to stdout with no request pending:\n${stdout}`);
  });
});

describe('the bare invocation is untouched', () => {
  test('it still starts a server on 127.0.0.1 and prints a tokened URL', async () => {
    const home = freshHome();
    const child = spawn(process.execPath, ['zelos.mjs', '--no-open', '--port', '0'], {
      cwd: ROOT,
      env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    try {
      const deadline = Date.now() + 20_000;
      let url = null;
      while (!url) {
        const m = /Open\s+(http:\/\/\S+)/.exec(stdout);
        if (m) url = new URL(m[1]);
        else if (child.exitCode !== null || Date.now() > deadline) throw new Error(`no URL was printed:\n${stdout}`);
        else await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(url.hostname, '127.0.0.1');
      assert.match(url.searchParams.get('t') ?? '', /^[0-9a-f]{64}$/);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Opening the browser
 * ------------------------------------------------------------------ */

describe('the session token never reaches a command line', () => {
  /**
   * REGRESSION. The launch URL was handed to `open`/`xdg-open`/`cmd` as an
   * argument, so for the length of the launch — and, on Linux, for the whole
   * life of the browser — the session token sat in an argument vector any
   * co-resident process could read. That token is the entire local API.
   * core/secrets.mjs refuses to put a password in argv for exactly this reason;
   * these tests hold the launcher to the same rule.
   */
  const TOKEN = 'f3a1c9'.repeat(10) + 'abcd';
  const URL_WITH_TOKEN = `http://127.0.0.1:7777/?t=${TOKEN}`;
  const PLATFORMS = ['darwin', 'win32', 'linux', 'freebsd'];

  /** Just enough of a ChildProcess for openBrowser to drive. */
  function fakeChild(seen) {
    const stdin = { writes: [], on() {}, end(chunk) { if (chunk !== undefined) stdin.writes.push(String(chunk)); } };
    seen.stdin = stdin;
    return { on() {}, unref() {}, stdin };
  }

  test('no platform hands the token to a child process as an argument', () => {
    for (const platform of PLATFORMS) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, platform });
      assert.ok(plan, `${platform} produced no plan at all`);
      const argv = [plan.command, ...plan.args].join(' ');
      assert.ok(!argv.includes(TOKEN), `${platform} put the session token in argv: ${argv}`);
      assert.ok(!plan.target.includes(TOKEN) || plan.stdin !== null,
        `${platform} routed the tokened URL through something that is not stdin`);
    }
  });

  test('macOS and Windows pass the URL on stdin, so it opens without pasting', () => {
    for (const platform of ['darwin', 'win32']) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, platform });
      assert.deepEqual(plan.args, [], `${platform} should need no arguments at all`);
      assert.ok(plan.stdin.includes(URL_WITH_TOKEN), `${platform} did not send the URL on stdin`);
      assert.equal(plan.handsOverToken, true);
    }
    assert.equal(browserLaunchPlan({ url: URL_WITH_TOKEN, platform: 'darwin' }).command, 'osascript');
    assert.equal(browserLaunchPlan({ url: URL_WITH_TOKEN, platform: 'win32' }).command, 'cmd');
  });

  test('a platform with no private opener opens the tokenless address instead', () => {
    // xdg-open takes a positional argument and execs a browser with another, so
    // there is no private route at all: the user pastes what the banner printed.
    for (const platform of ['linux', 'freebsd']) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, platform });
      assert.equal(plan.command, 'xdg-open');
      assert.deepEqual(plan.args, ['http://127.0.0.1:7777/']);
      assert.equal(plan.stdin, null);
      assert.equal(plan.handsOverToken, false, 'the user has to be told they must paste');
    }
  });

  test('a one-time handoff is used everywhere, and carries no token', () => {
    const handoffUrl = 'http://127.0.0.1:7777/h/9f3a1c7e5b2d4088';
    for (const platform of PLATFORMS) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, handoffUrl, platform });
      const everything = [plan.command, ...plan.args, plan.stdin ?? ''].join(' ');
      assert.ok(!everything.includes(TOKEN), `${platform} leaked the token alongside the handoff`);
      assert.ok(everything.includes(handoffUrl), `${platform} did not use the handoff`);
      assert.equal(plan.handsOverToken, true);
      assert.equal(plan.stdin, null, 'a spent nonce is safe in argv, so the plain opener is fine');
    }
  });

  test('openBrowser spawns nothing that carries the token in argv', () => {
    for (const platform of PLATFORMS) {
      const seen = {};
      const spawn = (command, args, options) => {
        seen.command = command;
        seen.args = args;
        seen.options = options;
        return fakeChild(seen);
      };
      assert.equal(openBrowser(browserLaunchPlan({ url: URL_WITH_TOKEN, platform }), { spawn }), true);
      assert.ok(!JSON.stringify([seen.command, seen.args]).includes(TOKEN),
        `${platform} spawned ${seen.command} ${JSON.stringify(seen.args)}`);
      if (seen.stdin.writes.length) {
        assert.ok(seen.stdin.writes.join('').includes(URL_WITH_TOKEN), `${platform} wrote nothing usable to stdin`);
      }
    }
  });

  /**
   * REGRESSION, and the reason the one above was not enough. The launcher gated
   * the whole handoff on `typeof server.zelos.mintHandoff === 'function'` and
   * the server exposed no such function, so the branch was permanently false and
   * every launch went on putting the token in argv. A test that supplies its own
   * handoff URL cannot see that; this one asks the real server for one.
   */
  test('the server mints a handoff the launcher can actually open', async () => {
    const { createServer, listen } = await import('../core/server.mjs');
    const dbm = await import('../core/db.mjs');
    const handle = dbm.open(':memory:');
    dbm.migrate(handle);
    const server = createServer({ db: handle });
    const { url: origin, tokenUrl } = await listen(server, { port: 0 });

    try {
      assert.equal(typeof server.zelos.mintHandoff, 'function',
        'the launcher checks for exactly this before it will open a browser privately');

      // The two lines main() runs, verbatim.
      const at = server.zelos.mintHandoff();
      const handoffUrl = new URL(at, origin).href;

      for (const platform of PLATFORMS) {
        const plan = browserLaunchPlan({ url: tokenUrl, handoffUrl, platform });
        const everything = [plan.command, ...plan.args, plan.stdin ?? ''].join(' ');
        assert.ok(!everything.includes(server.sessionToken),
          `${platform} still launches with the token: ${everything}`);
        assert.ok(everything.includes(handoffUrl), `${platform} did not use the server's handoff`);
        assert.equal(plan.handsOverToken, true, `${platform} would make the user paste`);
      }

      // And the address the launcher built is one this server answers: a handoff
      // the browser cannot spend is the same dead branch with extra steps.
      const res = await fetch(handoffUrl, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `/?t=${server.sessionToken}`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      dbm.close(handle);
    }
  });

  test('anything that is not one of our own launch URLs is not run at all', () => {
    const bad = [
      'http://evil.example/?t=x',
      'https://127.0.0.1:7777/?t=x',
      'http://127.0.0.1:7777/?t=a&calc=1',
      'http://127.0.0.1:7777/" ; rm -rf ~',
      'http://127.0.0.1:7777/?t=$(id)',
      'file:///etc/passwd',
      'not a url at all',
      '',
      null,
      undefined,
    ];
    for (const url of bad) {
      assert.equal(browserLaunchPlan({ url, platform: 'win32' }), null, JSON.stringify(url));
      assert.equal(browserLaunchPlan({ url: URL_WITH_TOKEN, handoffUrl: url, platform: 'darwin' }).stdin !== null, true,
        `a bad handoff (${JSON.stringify(url)}) must fall back, never be run`);
    }
    assert.equal(openBrowser(null, { spawn: () => { throw new Error('nothing should have been spawned'); } }), false);
  });
});
