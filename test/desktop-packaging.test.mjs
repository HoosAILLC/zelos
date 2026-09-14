import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {prepareRuntimeDependencies} from '../desktop/prepare-runtime.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_PACKAGE = ['report', 'er'].join('');
const json = (file, value) => {fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value));};
function fixture(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-package-deps-')));
  t.after(() => fs.rmSync(sandbox, {recursive: true, force: true, maxRetries: 3}));
  const root = path.join(sandbox, 'source');
  json(path.join(root, 'package.json'), {version: '1.0.0', dependencies: {reporter: '1.0.0'}});
  const packages = {
    '': {dependencies: {reporter: '1.0.0'}},
    'node_modules/reporter': {version: '1.0.0'},
    'node_modules/reporter/node_modules/encoding': {version: '2.0.0'},
    'node_modules/build-only': {version: '3.0.0', dev: true},
    'node_modules/reporter/node_modules/debug-only': {version: '4.0.0', dev: true},
  };
  for (const [name, info] of Object.entries(packages)) {
    if (name) json(path.join(root, name, 'package.json'), {name: name.split('/').at(-1), version: info.version, main: 'index.cjs'});
  }
  json(path.join(root, 'package-lock.json'), {version: '1.0.0', lockfileVersion: 3, packages});
  fs.writeFileSync(path.join(root, 'node_modules/reporter/index.cjs'), 'module.exports = require(' + JSON.stringify(['encod', 'ing'].join('')) + ") + ':' + require('node:fs').readFileSync(require('node:path').join(__dirname,'font.dat'),'utf8');");
  fs.writeFileSync(path.join(root, 'node_modules/reporter/font.dat'), 'font-data');
  fs.writeFileSync(path.join(root, 'node_modules/reporter/node_modules/encoding/index.cjs'), "module.exports = 'encoded';");
  return {root, sandbox, packages};
}

test('desktop staging ships working transitive runtime modules and data without development tools', t => {
  const {root, sandbox} = fixture(t);
  const result = prepareRuntimeDependencies({root});
  assert.equal(result.packages.length, 2);
  assert.equal(fs.existsSync(path.join(result.directory, 'build-only')), false);
  assert.equal(fs.existsSync(path.join(result.directory, 'reporter/node_modules/debug-only')), false);
  // Move the result outside the checkout and delete original modules: a smoke
  // test inside the source tree can accidentally resolve an unshipped module.
  const resource = path.join(sandbox, 'installed/Resources');
  fs.mkdirSync(resource, {recursive: true});
  fs.cpSync(result.directory, path.join(resource, 'node_modules'), {recursive: true});
  fs.rmSync(path.join(root, 'node_modules'), {recursive: true});
  const require = createRequire(path.join(resource, 'package.json'));
  assert.equal(require(FIXTURE_PACKAGE), 'encoded:font-data');
  assert.ok(require.resolve(FIXTURE_PACKAGE).startsWith(path.join(resource, 'node_modules') + path.sep));
});

test('missing or stale locked dependencies fail packaging instead of producing a broken installer', t => {
  const {root} = fixture(t);
  fs.rmSync(path.join(root, 'node_modules/reporter/node_modules/encoding'), {recursive: true});
  assert.throws(() => prepareRuntimeDependencies({root}), /Missing runtime dependency/);
  json(path.join(root, 'node_modules/reporter/node_modules/encoding/package.json'), {version: '9.0.0'});
  assert.throws(() => prepareRuntimeDependencies({root}), /version does not match/);
});

test('staging refuses a changed dependency manifest or traversal in the lockfile', t => {
  const {root, packages} = fixture(t);
  json(path.join(root, 'package.json'), {version: '1.0.0', dependencies: {reporter: '2.0.0'}});
  assert.throws(() => prepareRuntimeDependencies({root}), /manifest and lockfile disagree/);
  json(path.join(root, 'package.json'), {version: '1.0.0', dependencies: {reporter: '1.0.0'}});
  json(path.join(root, 'package-lock.json'), {version: '1.0.0', packages: {...packages, 'node_modules/../../outside': {version: '1.0.0'}}});
  assert.throws(() => prepareRuntimeDependencies({root}), /Invalid runtime dependency path/);
});

test('a second staging run removes stale packages left by an older build', t => {
  const {root} = fixture(t), first = prepareRuntimeDependencies({root});
  fs.mkdirSync(path.join(first.directory, 'obsolete'));
  fs.writeFileSync(path.join(first.directory, 'obsolete/old.js'), 'old build');
  prepareRuntimeDependencies({root});
  assert.equal(fs.existsSync(path.join(first.directory, 'obsolete')), false);
});

test('desktop resources resolve the staged dependencies alongside core on macOS and Windows', () => {
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package.json'), 'utf8'));
  const rule = desktop.build.extraResources.find(resource => resource.to === 'node_modules');
  assert.equal(rule?.from, '.runtime-node-modules', 'production modules must be beside resources/core, not inside resources/app');
  for (const command of ['pack', 'dist', 'dist:mac', 'dist:win']) assert.equal(desktop.scripts['pre' + command], 'node prepare-runtime.js');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/desktop.yml'), 'utf8');
  for (const label of ['windows-latest', 'windows-11-arm', 'macos-15-intel', 'macos-15']) assert.ok(workflow.includes('os: ' + label));
  assert.match(workflow, /--\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /npm ci --omit=dev --ignore-scripts/);
  assert.match(workflow, /node scripts\/check-desktop\.mjs/);
});
