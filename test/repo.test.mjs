/**
 * test/repo.test.mjs — the promises the product makes about itself.
 *
 * "Zero third-party dependencies" and "it starts even with nothing configured"
 * are not implementation details a unit test can reach. They are properties of
 * the repository and of the built program, and the only honest way to check
 * them is to read every import in the tree and to actually run the thing.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * This file's whole method is to *run the real program*, which makes it the one
 * place where a test can reach out and touch the operator's own machine. Every
 * child below inherits this process's environment, so the sandbox has to be set
 * here, once, rather than remembered at each spawn:
 *
 *  - `ZELOS_HOME` so no child can read or create the real `~/.zelos`. Tests that
 *    care about a specific home still pass their own, which wins.
 *  - `ZELOS_SECRETS_BACKEND` because a temp home does not sandbox the secret
 *    store: on macOS `secrets.backend()` shells out to `/usr/bin/security`
 *    against the login keychain, and `/api/health` calls it on every launch.
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-repo-'));
process.env.ZELOS_HOME = path.join(SANDBOX, 'home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';

after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

/* ================================================================== *
 * The suite's own blast radius
 * ================================================================== */

describe('the test suite stays inside its sandbox', () => {
  /**
   * A temp `ZELOS_HOME` does not sandbox the secret store. `secrets.backend()`
   * *detects* a backend, and on an unforced macOS run that detection shells out
   * to `/usr/bin/security` against the operator's own login keychain — their
   * real credentials, on their real machine — no matter where ZELOS_HOME points.
   * `GET /api/health` calls it, so merely booting the server is enough.
   *
   * Two files did exactly that: `desktop.test.mjs` booted the core in-process
   * and `repo.test.mjs` spawned the real CLI, and neither forced a backend. So
   * any test that can reach the real secret store has to pin it to the file
   * backend, which lives in the temp home and dies with it.
   */
  test('no test file lets the secret store auto-detect the real keychain', () => {
    // Reaching core/secrets.mjs — directly, through core/server.mjs or
    // core/ai-access.mjs (which stores AI tokens), or by running the program
    // itself — is what makes detection possible.
    //
    // Read as text, never with a shell grep: two of these files embed NUL bytes
    // as attack payloads, and grep silently skips a file it decides is binary.
    const REACHES = /\.\.\/core\/(server|secrets|ai-access)\.mjs|zelos\.mjs|desktop\/main\.js/;
    const unforced = [];
    let reaching = 0;

    for (const name of fs.readdirSync(path.join(ROOT, 'test')).sort()) {
      if (!name.endsWith('.test.mjs')) continue;
      const src = fs.readFileSync(path.join(ROOT, 'test', name), 'utf8');
      if (!REACHES.test(src)) continue;
      reaching += 1;
      if (!/ZELOS_SECRETS_BACKEND\s*[=:]/.test(src)) unforced.push(name);
    }

    assert.ok(reaching >= 5, `only ${reaching} test files were examined — the scan is broken`);
    assert.deepEqual(unforced, [], 'these tests can reach the real secret store and do not force a backend:\n  '
      + `${unforced.join('\n  ')}\n`
      + "Add process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file' before the core modules load.");
  });
});

/* ================================================================== *
 * Zero dependencies
 * ================================================================== */

describe('the dependency claim', () => {
  test('package.json declares no dependencies of any kind', () => {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
      assert.ok(
        pkg[field] === undefined || Object.keys(pkg[field]).length === 0,
        `package.json.${field} is populated: ${JSON.stringify(pkg[field])}`,
      );
    }
  });

  test('there is no lockfile and no node_modules at the root', () => {
    for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'node_modules']) {
      assert.ok(!fs.existsSync(path.join(ROOT, name)), `${name} exists at the repository root`);
    }
  });

  test('the package is ESM and points at the launcher', () => {
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.bin.zelos, './zelos.mjs');
    assert.ok(fs.existsSync(path.join(ROOT, 'zelos.mjs')));
  });

  /**
   * `node --test <dir>` — what SPEC §11 writes — stopped working in Node 24,
   * where positional arguments became glob patterns: the pattern `test/` matches
   * the directory itself and Node then tries to import a directory. So the test
   * script has to name the files, and this checks that whatever it names still
   * points at the real suite. It cannot simply run `npm test`, because that would
   * run this file, which would run `npm test`.
   */
  test('the test script points at the suite in test/', () => {
    const script = pkg.scripts?.test;
    assert.ok(script, 'package.json has no test script');
    assert.match(script, /\bnode\b[^&|]*--test\b/, `the test script must invoke node --test: ${script}`);

    const args = script
      .replace(/^.*?--test\b/, '')
      .split(/\s+/)
      .map((a) => a.replace(/^["']|["']$/g, ''))
      .filter((a) => a && !a.startsWith('-'));
    assert.ok(args.length > 0, `the test script must name what it runs, not sweep the tree: ${script}`);

    const suite = new Set(fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')));
    assert.ok(suite.size >= 10, 'the suite should not have shrunk');

    const matched = new Set();
    for (const arg of args) {
      assert.ok(arg.startsWith('test/'), `the test script reaches outside test/: ${arg}`);
      for (const file of fs.globSync(arg, { cwd: ROOT })) matched.add(path.basename(file));
    }
    assert.deepEqual(
      [...suite].filter((f) => !matched.has(f)),
      [],
      'the test script does not reach every file in test/',
    );
  });
});

/* ================================================================== *
 * Every import, read rather than assumed
 * ================================================================== */

/**
 * Mask comments, string bodies and regex literals so an import-looking phrase
 * inside a comment or a test fixture cannot be mistaken for a real import.
 *
 * The mask is the same length as the source, character for character, so an
 * offset in the mask is the same offset in the file. That matters: the mask is
 * what gets pattern-matched, and the literal it points at is then read back
 * exactly, escapes and all, from `literals`.
 *
 * `/` is ambiguous in JavaScript, so regex literals are recognised the usual
 * way: a `/` in value position opens a regex, a `/` after an operand is
 * division. Getting that wrong would corrupt the quote state and silently hide
 * imports, so the suite also asserts on how much the scan recovers.
 */
function maskSource(src) {
  const mask = Array.from(src);
  const literals = new Map(); // index of the opening quote -> raw inner text
  const blank = (from, to) => {
    for (let k = from; k < to && k < src.length; k += 1) {
      if (src[k] !== '\n') mask[k] = ' ';
    }
  };

  let i = 0;
  let prev = '';
  const inValuePosition = () => prev === '' || '({[,;:!&|?+-*/%=<>~^'.includes(prev);

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const stop = src.indexOf('\n', i);
      blank(i, stop === -1 ? src.length : stop);
      i = stop === -1 ? src.length : stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const stop = src.indexOf('*/', i + 2);
      const end = stop === -1 ? src.length : stop + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const open = i;
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      literals.set(open, src.slice(open + 1, i));
      blank(open + 1, i); // the quotes stay, so patterns can anchor on them
      i += 1;
      prev = c;
      continue;
    }
    if (c === '/' && inValuePosition()) {
      const open = i;
      i += 1;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') break;
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i += 1;
      }
      blank(open, i + 1);
      i += 1;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return { mask: mask.join(''), literals };
}

/** Every module specifier in one file. */
function specifiersIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const { mask, literals } = maskSource(src);
  const found = new Set();

  const patterns = [
    /(?:^|[\s;}])(?:import|export)\b[^;]*?\bfrom\s*['"]/g,
    /(?:^|[^.\w$])import\s*\(\s*['"]/g,
    /(?:^|[^.\w$])require\s*\(\s*['"]/g,
    /(?:^|[\s;}])import\s*['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(mask))) {
      const quoteAt = m.index + m[0].length - 1;
      const value = literals.get(quoteAt);
      if (value !== undefined) found.add(value);
    }
  }
  return found;
}

/** A relative specifier -> the file it actually loads, or null. */
function resolveModule(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function filesUnder(...roots) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(p).sort()) walk(path.join(p, entry));
    } else if (/\.(mjs|js)$/.test(p)) {
      out.push(p);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  return out;
}

const SCANNED = filesUnder('core', 'ui', 'test', 'zelos.mjs');
/**
 * Every module Node considers built in — plus the ones it does not list.
 *
 * `builtinModules` omits anything still marked experimental, and on the older
 * runtimes Zelos supports that includes `node:sqlite` and `node:test` — the
 * two most load-bearing imports in the project. The zero-dependency guard read
 * that omission as "these are third-party packages" and failed on exactly the
 * versions it was most important to check. They are builtins on every runtime
 * this project runs on, so they are named here rather than discovered.
 */
const ALWAYS_BUILTIN = ['sqlite', 'test', 'test/reporters'];
const BUILTINS = new Set(
  [...builtinModules, ...ALWAYS_BUILTIN].flatMap((m) => [m, `node:${m}`]),
);

/**
 * Why several assertions below stop at the Windows line. Zelos's at-rest
 * protection on macOS and Linux is POSIX modes — 0700 on the home, 0600 on
 * everything in it. Windows does not implement them: chmod there sets little
 * more than the read-only flag and stat synthesises a mode, so asserting one
 * would be testing Node's emulation rather than anything Zelos did. The claim
 * is skipped there, out loud and with a reason, and docs/SECURITY.md says what
 * does protect the data on Windows instead.
 */
const WINDOWS_NO_POSIX_MODES = process.platform === 'win32'
  ? 'POSIX modes are not implemented on Windows; see docs/SECURITY.md section 5.'
  : false;

describe('every import in core/, ui/ and test/', () => {
  test('the scan actually found the imports (a broken scanner must not pass)', () => {
    assert.ok(SCANNED.length >= 30, `expected to scan the whole tree, found ${SCANNED.length} files`);
    const total = SCANNED.reduce((n, f) => n + specifiersIn(f).size, 0);
    assert.ok(total >= 80, `expected to recover many specifiers, recovered ${total}`);
  });

  test('resolves to a node: builtin or a relative path — nothing else', () => {
    const offenders = [];
    for (const file of SCANNED) {
      for (const spec of specifiersIn(file)) {
        const relative = spec.startsWith('./') || spec.startsWith('../');
        if (relative || BUILTINS.has(spec)) continue;
        offenders.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `third-party or bare imports found:\n  ${offenders.join('\n  ')}`);
  });

  test('every builtin is imported with the node: prefix', () => {
    const bare = [];
    for (const file of SCANNED) {
      for (const spec of specifiersIn(file)) {
        if (!spec.startsWith('node:') && BUILTINS.has(spec)) {
          bare.push(`${path.relative(ROOT, file)} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(bare, [], `use node: on builtins:\n  ${bare.join('\n  ')}`);
  });

  test('every relative import points at a file that exists', () => {
    const missing = [];
    for (const file of SCANNED) {
      for (const spec of specifiersIn(file)) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        const target = path.resolve(path.dirname(file), spec);
        const ok = fs.existsSync(target)
          || fs.existsSync(`${target}.mjs`)
          || fs.existsSync(`${target}.js`)
          || fs.existsSync(path.join(target, 'index.js'));
        if (!ok) missing.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
    assert.deepEqual(missing, [], `imports that do not resolve:\n  ${missing.join('\n  ')}`);
  });

  /**
   * The file existing is not the same as the name existing. `import { doctor }
   * from './core/doctor.mjs'` against a module that exports `diagnose` resolves
   * fine, loads fine, and is `undefined` at the call site — a crash on the one
   * code path nobody ran. Modules here are written by different hands against a
   * written contract, so the names are exactly where they drift.
   *
   * This reads the declared exports rather than importing, on purpose: importing
   * every module would run its top-level code, and some of it opens files.
   */
  test('every named import is actually exported by the file it names', () => {
    const exportsCache = new Map();

    const exportedNames = (file) => {
      if (exportsCache.has(file)) return exportsCache.get(file);
      const names = new Set();
      exportsCache.set(file, names);                     // cycle-safe
      const { mask, literals } = maskSource(fs.readFileSync(file, 'utf8'));
      // export function f / class C / const x / let x / var x
      for (const m of mask.matchAll(
        /(?:^|[\s;}])export\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g,
      )) names.add(m[1]);
      // export { a, b as c } [from './x']
      for (const m of mask.matchAll(/(?:^|[\s;}])export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
          const t = part.trim();
          if (!t) continue;
          const bits = t.split(/\s+as\s+/);
          const name = (bits[1] ?? bits[0]).trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      }
      // export * from './x' — pull the re-exported module's names in too.
      const star = /(?:^|[\s;}])export\s*\*\s*from\s*['"]/g;
      let m;
      while ((m = star.exec(mask))) {
        const spec = literals.get(m.index + m[0].length - 1);
        const target = spec && resolveModule(file, spec);
        if (target) for (const n of exportedNames(target)) names.add(n);
      }
      return names;
    };

    const drift = [];
    let checked = 0;
    for (const file of SCANNED) {
      const { mask, literals } = maskSource(fs.readFileSync(file, 'utf8'));
      // import [d,] { a, b as c } from './x'   and   export { a } from './x'
      const re = /(?:^|[\s;}])(?:import|export)\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]/g;
      let m;
      while ((m = re.exec(mask))) {
        const spec = literals.get(m.index + m[0].length - 1);
        if (!spec || (!spec.startsWith('./') && !spec.startsWith('../'))) continue;
        const target = resolveModule(file, spec);
        if (!target) continue;                            // the test above owns that
        const have = exportedNames(target);
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
          checked += 1;
          if (!have.has(name)) {
            drift.push(`${path.relative(ROOT, file)} imports { ${name} } from ${spec}, which does not export it`);
          }
        }
      }
    }

    assert.ok(checked >= 100, `only ${checked} named imports were checked — the scan is broken`);
    assert.deepEqual(drift, [], `imported names that do not exist:\n  ${drift.join('\n  ')}`);
  });

  test('no UI file loads anything over the network', () => {
    const offenders = [];
    for (const file of filesUnder('ui')) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
        // A URL in a comment is prose; one in code would be a fetch.
        const line = src.slice(0, m.index).split('\n').pop();
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], `the UI must work offline:\n  ${offenders.join('\n  ')}`);
  });
});

/* ================================================================== *
 * The program itself
 * ================================================================== */

function run(command, args, { env = {}, killAfter = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    if (killAfter) killAfter(child, () => stdout, () => stderr);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe('the command line', () => {
  test('--help explains itself and exits 0', async () => {
    const { code, stdout } = await run(process.execPath, ['zelos.mjs', '--help']);
    assert.equal(code, 0);
    for (const flag of ['--port', '--home', '--no-open', '--sweep-now', '--version', '--help']) {
      assert.ok(stdout.includes(flag), `--help does not document ${flag}`);
    }
    assert.ok(/127\.0\.0\.1/.test(stdout), '--help should say where it listens');
  });

  test('--version prints the package version and nothing else', async () => {
    const { code, stdout } = await run(process.execPath, ['zelos.mjs', '--version']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  test('neither --help nor --version creates a Zelos home', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-noop-'));
    fs.rmSync(home, { recursive: true, force: true });
    await run(process.execPath, ['zelos.mjs', '--help'], { env: { ZELOS_HOME: home } });
    await run(process.execPath, ['zelos.mjs', '--version'], { env: { ZELOS_HOME: home } });
    assert.equal(fs.existsSync(home), false, 'printing help should not touch the disk');
  });

  test('an unknown flag fails loudly instead of starting', async () => {
    const { code, stderr } = await run(process.execPath, ['zelos.mjs', '--not-a-flag']);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown option/);
  });
});

describe('a first launch with nothing configured', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-firstrun-')), 'never-created');
  let child;
  let origin;
  let token;
  let exited;

  before(async () => {
    // The home does not exist at all: no directory, no config, no database.
    assert.equal(fs.existsSync(home), false);

    let stdout = '';
    let stderr = '';
    child = spawn(process.execPath, ['zelos.mjs', '--no-open', '--port', '0'], {
      cwd: ROOT,
      env: { ...process.env, ZELOS_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));

    const deadline = Date.now() + 20_000;
    for (;;) {
      const m = /Open\s+(http:\/\/\S+)/.exec(stdout);
      if (m) {
        const parsed = new URL(m[1]);
        origin = parsed.origin;
        token = parsed.searchParams.get('t');
        assert.equal(parsed.hostname, '127.0.0.1', 'Zelos must never bind a routable address');
        return;
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`zelos never printed its URL.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(() => {
    child?.kill('SIGKILL');
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  });

  test('the launch URL carries a fresh 32-byte session token', () => {
    assert.match(token ?? '', /^[0-9a-f]{64}$/);
  });

  test('it serves a health check that admits nothing is configured', async () => {
    const res = await fetch(`${origin}/api/health`, { headers: { 'X-Zelos-Token': token } });
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.equal(health.ok, true);
    assert.equal(health.model.configured, false, 'an unconfigured launch should say so, not pretend');
    assert.equal(health.home, home);
  });

  test('it laid out its home the way it says it does', () => {
    assert.ok(fs.existsSync(home), 'the home directory should have been created');
    for (const dir of ['logs', 'cache']) {
      assert.ok(fs.existsSync(path.join(home, dir)), `${dir}/ was not created`);
    }
    assert.ok(fs.existsSync(path.join(home, 'zelos.db')), 'the database should have been created and migrated');
  });

  test('the home is 0700', { skip: WINDOWS_NO_POSIX_MODES }, () => {
    assert.equal(fs.statSync(home).mode & 0o777, 0o700, 'the Zelos home must not be group- or world-readable');
  });

  test('the config the first save writes holds no secrets', async () => {
    const res = await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { 'X-Zelos-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: { name: 'Nemo Hale' } }),
    });
    assert.equal(res.status, 200);

    const file = path.join(home, 'config.json');
    if (!WINDOWS_NO_POSIX_MODES) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!/"(pass|password|apiKey|api_key|secret)"\s*:/i.test(raw),
      `config.json contains a secret-shaped field:\n${raw}`);
    const cfg = JSON.parse(raw);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.identity.name, 'Nemo Hale');
    assert.equal(cfg.model.keyRef, 'model.default', 'the config stores a reference, never a key');
  });

  test('nothing on disk records the session token', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (fs.readFileSync(full).includes(token)) offenders.push(path.relative(home, full));
      }
    };
    walk(home);
    assert.deepEqual(offenders, [], 'the session token must live in memory and the URL, nowhere else');
  });

  /**
   * The UI and the server are written as separate files by separate hands, and
   * nothing in either one fails to load when they disagree — a view that calls a
   * route the router never learned just gets a 404 at runtime, which the UI
   * politely swallows as "not in this build". That is exactly how a whole
   * feature ships dead: `ui/views/onboarding.js` called `/api/sample-data`, the
   * router had no such route, and the "Try it with sample data" button quietly
   * hid itself instead of failing.
   *
   * So: every /api/ path any file in ui/ names must exist on the running server,
   * with the method that file uses in the Allow list.
   *
   * OPTIONS is the probe on purpose. It matches no route, so the router answers
   * from the table alone — 404 for a path it does not have, 405 plus `allowed`
   * for one it does — without ever running a handler. Nothing is swept, no model
   * is called, no stream is opened.
   */
  test('every /api path the UI calls exists on the server, with the method it uses', async () => {
    // A path literal, then the method named in the same call (default GET).
    const CALL = /(['"`])(\/api\/[^'"`]*)\1/g;
    const wanted = new Map();   // path -> {methods:Set, where:Set}

    for (const file of filesUnder('ui')) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(CALL)) {
        const literal = m[2]
          .replace(/\$\{[^}]*\}/g, 'probe-id')    // `/api/drafts/${id}` -> /api/drafts/probe-id
          .split('?')[0];
        // The method, if this call names one before the next call begins.
        const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 240);
        const verb = /^\s*,\s*\{[^}]*?\bmethod:\s*'([A-Z]+)'/.exec(tail);
        const entry = wanted.get(literal) || { methods: new Set(), where: new Set() };
        entry.methods.add(verb ? verb[1] : 'GET');
        entry.where.add(path.relative(ROOT, file));
        wanted.set(literal, entry);
      }
    }

    assert.ok(wanted.size >= 15, `the scan found only ${wanted.size} API paths in ui/ — it is broken`);

    const missing = [];
    const wrongMethod = [];
    for (const [apiPath, { methods, where }] of wanted) {
      const res = await fetch(`${origin}${apiPath}`, {
        method: 'OPTIONS',
        headers: { 'X-Zelos-Token': token },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) {
        missing.push(`${apiPath} (called from ${[...where].join(', ')})`);
        continue;
      }
      assert.equal(res.status, 405, `${apiPath} answered OPTIONS with ${res.status}, so this probe proves nothing`);
      const allowed = new Set(body.allowed || []);
      for (const verb of methods) {
        if (!allowed.has(verb)) {
          wrongMethod.push(`${verb} ${apiPath} — server allows ${[...allowed].join(', ') || 'nothing'} (called from ${[...where].join(', ')})`);
        }
      }
    }

    assert.deepEqual(missing, [], `the UI calls routes the server does not have:\n  ${missing.join('\n  ')}`);
    assert.deepEqual(wrongMethod, [], `the UI calls routes with a method they refuse:\n  ${wrongMethod.join('\n  ')}`);
  });

  test('SIGINT stops it cleanly', async () => {
    child.kill('SIGINT');
    assert.equal(await exited, 0, 'Ctrl-C should be a clean exit, not a hang or a crash');
  });
});
