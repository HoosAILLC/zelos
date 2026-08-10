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

after(() => fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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

    /* Setting the variable once at the top is not the same as keeping it set.
       A test can DELETE it again — that is what `unforce()` in secrets.test.mjs
       does — and detection then runs against the operator's own login keychain
       for the rest of the file. The textual check above passed happily while
       exactly that was happening, which is how two tests came to be writing
       into a real keychain on every developer machine that ran the suite. */
    const optOut = [];
    for (const name of testFiles()) {
      const src = fs.readFileSync(path.join(ROOT, 'test', name), 'utf8');
      const lines = src.split('\n');
      for (const [index, line] of lines.entries()) {
        if (COMMENT.test(line) || !UNFORCE.test(line)) continue;
        const verdict = classifyUnforce(lines, index, indentOf(line), line);
        if (!verdict) optOut.push(`${name}:${index + 1} — ${line.trim()}`);
      }
    }
    assert.deepEqual(optOut, [], 'these un-force the secret backend where nothing establishes it is safe, '
      + 'so they use the real keychain of whatever machine runs them:\n  '
      + `${optOut.join('\n  ')}\n`
      + 'Put it in a teardown hook, make it a conditional restore, or call it from a helper '
      + 'whose every caller is gated on process.env.CI, the way test/secrets.test.mjs does.');

    assert.deepEqual(unforced, [], 'these tests can reach the real secret store and do not force a backend:\n  '
      + `${unforced.join('\n  ')}\n`
      + "Add process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file' before the core modules load.");
  });

  /**
   * The guard above is only worth having if it can SEE the suite, and the
   * version it replaced could not. It decided where a delete sat by asking
   * which of `after(` and `\ntest(` came last anywhere earlier in the file, and
   * a separate clause waved through every file containing the string
   * `process.env.CI` at all.
   *
   * Both are measured failures, not theory. Injecting an unconditional delete
   * into every test body in the suite and replaying the old guard left 261 of
   * 975 bodies — 27% — unflagged, including **100%** of cli.test.mjs,
   * mcp.test.mjs, integration.test.mjs, repo.test.mjs and secrets.test.mjs:
   * exactly the five files that spawn the real CLI or boot the real core. Those
   * files open with a module-level `after(` and declare their tests inside a
   * `describe(`, so `\ntest(` never matched, `lastTest` was −1 for the whole
   * file, and every delete below read as teardown. The `process.env.CI` clause
   * covered the rest: secrets.test.mjs mentions it, so any delete anywhere in
   * that file was excused.
   *
   * So the classifier is now fail-CLOSED — a site it cannot place is a
   * complaint, not a shrug — and this replays the same measurement against it.
   * The injection points are found with a deliberately dumber locator than the
   * classifier's own (any line that opens a `test(`/`it(` with a string, at any
   * indentation, in any nesting), because the whole defect was a locator that
   * only knew two shapes.
   */
  test('the guard sees every test body in the suite, not the 73% it used to', () => {
    const bodies = [];
    const unflagged = [];
    for (const name of testFiles()) {
      const lines = fs.readFileSync(path.join(ROOT, 'test', name), 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/\b(?:test|it)\s*\(\s*['"`]/.test(line)) continue;
        // The first statement of that body: one line down, one level in.
        const site = index + 1;
        const indent = indentOf(line) + 2;
        bodies.push(`${name}:${site}`);
        if (classifyUnforce(lines, site, indent, INJECTED)) unflagged.push(`${name}:${site} — ${line.trim()}`);
      }
    }

    assert.ok(bodies.length >= 900, `only ${bodies.length} test bodies were found — the sweep is broken`);
    for (const file of ['cli.test.mjs', 'mcp.test.mjs', 'integration.test.mjs', 'repo.test.mjs', 'secrets.test.mjs']) {
      assert.ok(bodies.some((b) => b.startsWith(`${file}:`)), `${file} contributed no test bodies to the sweep`);
    }
    assert.deepEqual(unflagged, [], `${unflagged.length} of ${bodies.length} test bodies could take an `
      + 'unconditional delete of ZELOS_SECRETS_BACKEND without the guard saying anything:\n  '
      + `${unflagged.join('\n  ')}`);
  });
});

/* ================================================================== *
 * The legs only CI can run
 * ================================================================== */

/**
 * Three of the four credential backends can only be exercised where a real one
 * exists, so the tests for them are gated on an environment a developer's
 * machine does not have — and a gate is a promise made in one file and kept in
 * another. Nothing linked them. `LIBSECRET_LIVE_ONLY` reads an environment
 * variable that only .github/workflows/ci.yml sets; delete that job, or rename
 * the variable on either side, and the test does not fail, it stops running,
 * silently, forever. That is the same shape as the vacuous pass the gate exists
 * to end.
 *
 * So the workflow and the suite are held to naming each other. This cannot
 * prove the job is green — only a push can — but it can prove the two halves
 * still refer to the same thing.
 */
describe('the workflow runs what only it can run', () => {
  const workflowSource = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  /* Comments are stripped before anything is looked for. That file explains
     itself at length, and this whole test would otherwise be satisfied by the
     paragraph describing the step rather than by the step. */
  const workflow = workflowSource.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const secretsTest = fs.readFileSync(path.join(ROOT, 'test', 'secrets.test.mjs'), 'utf8');

  test('the Linux keyring leg installs one, runs on a bus, and sets the flag the gate reads', () => {
    for (const pkg of ['libsecret-tools', 'gnome-keyring', 'dbus-x11']) {
      assert.match(workflow, new RegExp(`\\b${pkg}\\b`),
        `ci.yml installs no ${pkg}, so detection on that leg falls back to the encrypted file and the `
        + 'libsecret backend goes unexecuted again');
    }
    assert.match(workflow, /dbus-run-session/,
      'the keyring daemon needs a session bus; without one secret-tool cannot reach it');
    assert.match(workflow, /ZELOS_LIBSECRET_LIVE:/, 'ci.yml sets no ZELOS_LIBSECRET_LIVE');
    // `\b` will not do here: `_` is a word character, so it would match a
    // renamed ZELOS_LIBSECRET_LIVE_SOMETHING and the two halves could drift
    // apart while this stayed green. The name has to end where it ends.
    assert.match(secretsTest, /process\.env\.ZELOS_LIBSECRET_LIVE(?![\w$])/,
      'test/secrets.test.mjs no longer reads the variable ci.yml sets, so the live leg runs nothing');
  });

  /**
   * The two "leave nothing behind" steps look at a service name written into
   * the YAML by hand. Rename SERVICE in core/secrets.mjs and they keep passing
   * while searching for something no test could ever have stored — a check that
   * has quietly become a decoration.
   */
  test('the credential-litter checks name the service the code actually uses', () => {
    const secrets = fs.readFileSync(path.join(ROOT, 'core', 'secrets.mjs'), 'utf8');
    const service = /export const SERVICE = '([^']+)'/.exec(secrets);
    assert.ok(service, 'core/secrets.mjs no longer exports SERVICE as a literal');

    for (const tool of ['security find-generic-password', 'secret-tool search']) {
      const line = workflow.split('\n').find((l) => l.includes(tool));
      assert.ok(line, `ci.yml has no ${tool} step, so nothing checks that leg's credential store is clean`);
      assert.ok(line.includes(service[1]),
        `${tool} in ci.yml searches for something other than ${service[1]}: ${line.trim()}`);
    }
  });

  /**
   * `CI` is what tells three tests they are on a throwaway runner and may write
   * into a real credential store. GitHub sets it for every step of every job,
   * including through `shell: bash` on Windows, so the workflow never needs to —
   * and the moment it sets one by hand, that gate means nothing wherever it was
   * set. ci.yml says this in a comment; this is the comment with teeth.
   */
  test('the workflow never sets CI by hand', () => {
    const offenders = workflow.split('\n').filter((line) => /^\s*CI\s*:/.test(line));
    assert.deepEqual(offenders, [], `ci.yml sets CI itself: ${offenders.join('; ')}`);
  });
});

/* ------------------------------------------------------------------ *
 * The classifier the two tests above share.
 *
 * It answers one question about one site: is there something HERE that makes
 * un-forcing the secret backend safe? Three answers count, and each of them is
 * a property of the ten or so lines around the site rather than of the file:
 *
 *   1. a teardown hook — the file putting the environment back on its way out;
 *   2. a conditional restore — the same intent written inline;
 *   3. a helper whose every caller is a test gated on process.env.CI, which is
 *      how test/secrets.test.mjs reaches a real store on a throwaway runner and
 *      nowhere else.
 *
 * Anything else is a complaint. That is the important half: the old guard
 * answered "safe" whenever it could not tell, which is how a blind spot the
 * size of five files stayed quiet. If this fires on something legitimate, the
 * fix is to give the site one of the three shapes — not to widen the pattern.
 * ------------------------------------------------------------------ */

/** What an injected hazard looks like: unconditional, unexplained. */
const INJECTED = 'delete process.env.ZELOS_SECRETS_BACKEND;';

/** How far above a site a hook or a helper may be and still enclose it. */
const HOOK_REACH = 40;
const HELPER_REACH = 6;

const HOOK = /^\s*(?:(?:test|t)\.)?(?:after|afterEach)\s*\(/;
const TEST_DECL = /^\s*(?:await\s+)?(?:t\.)?(?:test|it)(?:\.(?:only|skip|todo|concurrent))?\s*\(/;
const HELPER = /^\s*(?:async\s+)?function\s+(\w+)\s*\(/;

/**
 * A delete that is really a delete. `const INJECTED = 'delete process.env.…'`
 * in this very file is a string, and the prose above quotes the same statement
 * inside a comment; neither un-forces anything. Requiring the character in
 * front to be the start of the line, whitespace, or a closing paren separates
 * the statement from every way of naming it.
 */
const UNFORCE = /(?:^|[\s)])delete\s+process\.env\.ZELOS_SECRETS_BACKEND/;

/** A line that is only prose. The suite's comments talk about all of this. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, '  ').length;

function testFiles() {
  return fs.readdirSync(path.join(ROOT, 'test')).filter((n) => n.endsWith('.test.mjs')).sort();
}

/**
 * Walk up from `index` looking for a line that matches `opener` at a shallower
 * indent, giving up after `reach` lines or at the first test declaration —
 * because a test declaration between the two means the site is inside the test,
 * not inside whatever came before it. This is what the old `lastIndexOf` could
 * not express: a module-level `after(` on line 37 does not enclose line 600.
 */
function encloser(lines, index, indent, opener, reach) {
  for (let i = index - 1; i >= 0 && index - i <= reach; i -= 1) {
    const line = lines[i];
    if (!line.trim() || COMMENT.test(line)) continue;
    if (indentOf(line) >= indent) continue;
    // The opener is read first: `test.after(` opens a hook and also reads as a
    // test declaration, and it is the hook that matters.
    const m = opener.exec(line);
    if (m) return m;
    if (TEST_DECL.test(line)) return null;
  }
  return null;
}

/** The nearest test declaration above `index` that could contain it. */
function enclosingTest(lines, index, indent) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim() || indentOf(line) >= indent) continue;
    if (TEST_DECL.test(line)) return i;
  }
  return -1;
}

/**
 * Is this test declaration gated on CI? Either it says so in the header, or its
 * `skip:` names a constant whose definition does. `REAL_STORE_ONLY_ON_CI` and
 * `DPAPI_LIVE_ONLY` in test/secrets.test.mjs are both the second shape.
 */
function gatedOnCI(lines, declLine) {
  const header = lines.slice(declLine, declLine + 3).join('\n');
  if (/process\.env\.CI/.test(header)) return true;
  const named = /\bskip\s*:\s*([A-Za-z_$][\w$]*)/.exec(header);
  if (!named) return false;
  const src = lines.join('\n');
  // `$` is a legal identifier character and a regex anchor, so the name is
  // escaped rather than interpolated raw.
  const definition = new RegExp(`\\nconst ${named[1].replace(/\$/g, '\\$')}\\s*=([\\s\\S]{0,600})`).exec(src);
  return Boolean(definition && /process\.env\.CI/.test(definition[1]));
}

/** -> a reason the site is safe, or null, which means "complain about it". */
function classifyUnforce(lines, index, indent, text) {
  // A conditional restore — `if (previous === undefined) delete …` — puts the
  // environment back the way it was found. The hazard is the UNCONDITIONAL
  // delete mid-run, which is what turns detection loose on a real keychain.
  if (/\bif\s*\(/.test(text) && /\b(previous|prior|saved|original)/i.test(text)) return 'conditional restore';

  if (encloser(lines, index, indent, HOOK, HOOK_REACH)) return 'teardown hook';

  const helper = encloser(lines, index, indent, HELPER, HELPER_REACH);
  if (helper) {
    const name = helper[1];
    const callers = [];
    for (const [i, line] of lines.entries()) {
      if (i === index || HELPER.test(line) || COMMENT.test(line)) continue;
      if (!new RegExp(`\\b${name}\\s*\\(`).test(line)) continue;
      const decl = enclosingTest(lines, i, indentOf(line));
      if (decl < 0 || !gatedOnCI(lines, decl)) return null;
      callers.push(i);
    }
    // A helper nobody calls proves nothing, and neither does one called from
    // module scope, where there is no gate to read.
    return callers.length > 0 ? `helper ${name}(), called only from CI-gated tests` : null;
  }

  return null;
}

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
    try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    /* A temp directory that Windows still holds a handle on is litter, not a
       test result. The OS clears it; failing the whole run over it reports a
       defect that does not exist and hides the ones that do. */
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
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

  /* Killing a process is asynchronous, and on Windows the files it had open
     stay locked until it is actually reaped — so removing the directory in the
     same tick raced the exit and failed with EPERM, which took the whole file
     down with it. Wait for the exit that was just asked for, then clean up. */
  after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5_000))]);
    }
    try {
    fs.rmSync(path.dirname(home), { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch (err) {
    /* A temp directory that Windows still holds a handle on is litter, not a
       test result. The OS clears it; failing the whole run over it reports a
       defect that does not exist and hides the ones that do. */
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
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

  /* Windows has no POSIX signals: process.kill(pid,'SIGINT') there terminates
     the process outright rather than delivering something a handler can catch,
     so this cannot test a graceful shutdown on that platform — it would only
     be testing that a killed process stops. What goes untested as a result is
     real and worth naming: whether Ctrl-C on Windows closes the database and
     releases the port cleanly is unverified. */
  test('SIGINT stops it cleanly', { skip: process.platform === 'win32'
    ? 'Windows does not deliver POSIX signals; a graceful Ctrl-C cannot be tested here'
    : false }, async () => {
    child.kill('SIGINT');
    assert.equal(await exited, 0, 'Ctrl-C should be a clean exit, not a hang or a crash');
  });
});
