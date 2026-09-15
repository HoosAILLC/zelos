/**
 * test/release.test.mjs — the promises a release build leans on.
 *
 * Cutting a release spans files nothing at runtime ever compares. The checks
 * here are cheap and textual, and each exists because the seam it pins could
 * otherwise only go red at the far end of a 40-minute two-OS CI build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildWebsite, readWebsiteRelease, previewSource } from '../scripts/build-website.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the root and desktop manifests carry the same version', { skip: !fs.existsSync(path.join(ROOT,'desktop')) && 'Desktop packaging is absent in npm deployment.' }, () => {
  /* The release pipeline reads both, and never side by side: the staging
     script derives the artifact names it expects from the root package.json,
     while electron-builder stamps `${version}` from desktop/package.json into
     the names it actually writes. Both fields are edited by hand, so a
     one-sided bump builds installers named for the old version — and the
     mismatch surfaces only after both runners have finished. This is the one
     place the two fields meet before any CI minutes are spent. */
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  assert.equal(desktop.version, root.version,
    'package.json and desktop/package.json disagree on the version — a release bump edits both');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/package-lock.json'), 'utf8'));
  assert.equal(lock.version, root.version);
  assert.equal(lock.packages[''].version, root.version);
});

test('the website previews the current UI while retaining verified published downloads', { skip: !fs.existsSync(path.join(ROOT,'website')) && 'Website packaging is absent in npm deployment.' }, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(),'zelos-release-website-'));
  t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  buildWebsite({root:ROOT,out:output});
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const release = readWebsiteRelease(ROOT, version);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const source of walk(path.join(ROOT, 'ui'))) {
    const relative = path.relative(path.join(ROOT, 'ui'), source);
    if (relative === 'index.html' || fs.existsSync(path.join(ROOT,'website/try',relative))) continue;
    const text=fs.readFileSync(source,'utf8');
    for(const route of ['try','demo']) assert.equal(fs.readFileSync(path.join(output, route, relative), 'utf8'), relative.endsWith('.js')?previewSource(text):text, route+'/'+relative);
  }
  for (const name of ['zelos-icon-32.png', 'zelos-favicon.svg', 'zelos-icon-180.png', 'zelos-wordmark-white.png', 'zelos-mark-white.png']) {
    assert.deepEqual(fs.readFileSync(path.join(output, 'demo/assets/brand', name)),
      fs.readFileSync(path.join(ROOT, 'assets/brand', name)), `The demo must include its referenced brand asset ${name}`);
  }
  const data = fs.readFileSync(path.join(output, 'try/lib/demo-version.js'), 'utf8');
  assert.equal(JSON.parse(data.replace(/^export default /, '').replace(/;\s*$/, '')), version);
  assert.deepEqual(fs.readFileSync(path.join(output,'try/index.html')),fs.readFileSync(path.join(output,'demo/index.html')));
  assert.match(fs.readFileSync(path.join(output,'try/index.html'),'utf8'),/zelos-launch/);
  assert.match(fs.readFileSync(path.join(output,'try/lib/endpoints.js'),'utf8'),/mealLibrary:/);
  assert.equal(fs.existsSync(path.join(ROOT,'website/try/app.js')),false,'The preview must not keep a stale app fork');
  assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), new RegExp(release.version.replaceAll('.', '\\.')));
  assert.match(fs.readFileSync(path.join(output,'download.html'),'utf8'),new RegExp(release.version.replaceAll('.', '\\.')));
  for(const name of fs.readdirSync(output).filter(name=>name.endsWith('.html')))assert.doesNotMatch(fs.readFileSync(path.join(output,name),'utf8'),/\{\{(?:PREVIEW_)?VERSION\}\}/,name);
  const redirects = fs.readFileSync(path.join(output, '_redirects'), 'utf8').trim().split('\n');
  for (const alias of ['Zelos-mac-apple-silicon.dmg', 'Zelos-mac-intel.dmg', 'Zelos-windows-x64.exe', 'Zelos-windows-arm64.exe', 'zelos-source.zip']) {
    const route = redirects.find((line) => line.startsWith(`/downloads/${alias} `));
    assert.ok(route, `Missing download alias ${alias}`);
    assert.ok(route.includes(`/releases/download/v${release.version}/`), `Unpublished download ${route}`);
  }
  assert.ok(!fs.readFileSync(path.join(output, 'demo/lib/api.js'), 'utf8').includes("const TOKEN_KEY = 'zelos.token'"), 'The demo must use its in-memory adapter');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'release.json'), 'utf8')), release);
});

function releaseManifest(version) {
  return { version, commit: 'a'.repeat(40), assets: [
    `Zelos-${version}-arm64.dmg`, `Zelos-${version}-x64.dmg`,
    `Zelos-${version}-setup-arm64.exe`, `Zelos-${version}-setup-x64.exe`, 'zelos-source.zip',
  ].map((name) => ({ name, size: 2000, sha256: 'b'.repeat(64) })) };
}

function websiteFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-website-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('package.json', { version: '1.8.4' });
  write('website/release.json', releaseManifest('1.8.1'));
  write('website/demo-data.json', { fictional: true });
  write('website/try/lib/api.js', '// demo adapter\n');
  write('ui/lib/api.js', `function queryString(values = {}) {\n  return new URLSearchParams(values).toString();\n}\nexport const api = {\n  state: () => request('/api/state'),\n};\n`);
  write('website/_headers', "/*\n  Content-Security-Policy: script-src 'self' {{SCRIPT_HASHES}}\n");
  for (const name of ['index', 'help', 'privacy']) {
    write(`website/${name}.html`, '<p>Version {{VERSION}}; preview {{PREVIEW_VERSION}}</p>');
  }
  write('ui/index.html', '<head><title>Zelos</title></head><body></body>');
  write('assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  write('assets/brand/zelos-favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return { root, write };
}

test('website-only builds never derive installer URLs from an unreleased preview version', (t) => {
  const { root } = websiteFixture(t);
  const out = buildWebsite({ root });
  for (const page of ['index', 'help', 'privacy']) {
    assert.equal(fs.readFileSync(path.join(out, `${page}.html`), 'utf8'), '<p>Version 1.8.1; preview 1.8.4</p>');
  }
  const routes = fs.readFileSync(path.join(out, '_redirects'), 'utf8').trim().split('\n');
  assert.equal(routes.length, 11);
  assert.ok(routes.every((route) => route.includes('/releases/download/v1.8.1/')));
  assert.ok(routes.some((route) => route.endsWith('/Zelos-1.8.1-setup-arm64.exe 302!')));
  assert.doesNotMatch(routes.join('\n'), /1\.8\.4/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8')), releaseManifest('1.8.1'));
  const data = fs.readFileSync(path.join(out, 'try/lib/demo-version.js'), 'utf8');
  assert.equal(JSON.parse(data.replace(/^export default /, '').replace(/;\s*$/, '')), '1.8.4');
});

test('a prepared tag-release manifest overrides the published version and preserves exact evidence', (t) => {
  const { root, write } = websiteFixture(t);
  const release = releaseManifest('1.8.4');
  release.commit = 'c'.repeat(40);
  write('release-assets/release.json', release);
  const out = buildWebsite({ root });
  assert.equal(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), '<p>Version 1.8.4; preview 1.8.4</p>');
  const routes = fs.readFileSync(path.join(out, '_redirects'), 'utf8').trim().split('\n');
  assert.ok(routes.every((route) => route.includes('/releases/download/v1.8.4/')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8')), release);
});

test('website builds reject missing, incomplete, or mismatched download evidence before writing output', (t) => {
  const { root, write } = websiteFixture(t);
  fs.rmSync(path.join(root, 'website/release.json'));
  assert.throws(() => buildWebsite({ root }), /ENOENT/);
  for (const mutate of [
    (r) => { r.assets.pop(); },
    (r) => { r.assets[1] = r.assets[0]; },
    (r) => { r.assets[0].size = 0; },
    (r) => { r.assets[0].sha256 = ''; },
    (r) => { r.commit = 'unknown'; },
    (r) => { r.version = '../1.8.1'; },
  ]) {
    const release = releaseManifest('1.8.1');
    mutate(release);
    write('website/release.json', release);
    assert.throws(() => buildWebsite({ root }), /Website downloads require/);
  }
  write('website/release.json', releaseManifest('1.8.1'));
  write('release-assets/release.json', releaseManifest('1.8.2'));
  assert.throws(() => buildWebsite({ root }), /Release assets do not match/);
  assert.equal(fs.existsSync(path.join(root, '.site-dist')), false);
});

test('CI installs the shell\'s build tools from the lockfile, with no fallback', { skip: !fs.existsSync(path.join(ROOT,'.github')) && 'CI workflow is absent in npm deployment.' }, () => {
  /* desktop/.gitignore keeps package-lock.json tracked on purpose: an app
     that asks people to trust an unsigned build should pin exactly what went
     into it. `npm ci` is that pin's enforcement, and `npm ci || npm install`
     undoes it in precisely the case npm ci exists to catch — a lockfile that
     no longer satisfies package.json — by resolving whatever is newest that
     day and building green, with the workflow log as the only trace. A stale
     lockfile must fail the build loudly; the fix is a one-commit regen. */
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf8');
  assert.match(workflow, /^\s*run: npm ci\s*$/m,
    'the workflow no longer installs the shell\'s build tools with npm ci alone');
  assert.doesNotMatch(workflow, /npm ci\s*\|\|/,
    'a fallback after npm ci ships whatever resolves that day instead of what the lockfile pinned');
});


test('every marketing page receives version substitution and its own inline-data CSP hash',t=>{
  const {root,write}=websiteFixture(t);
  write('website/features.html','<p>{{VERSION}} / {{PREVIEW_VERSION}}</p><script type="application/ld+json">{"name":"Features"}</script>');
  write('website/watch.html','<p>{{PREVIEW_VERSION}}</p><script type="application/ld+json">{"name":"Films"}</script>');
  write('website/_redirects','/old-features /features 301\n');
  const output=buildWebsite({root});
  assert.match(fs.readFileSync(path.join(output,'features.html'),'utf8'),/1\.8\.1 \/ 1\.8\.4/);
  assert.doesNotMatch(fs.readFileSync(path.join(output,'watch.html'),'utf8'),/\{\{/);
  assert.equal((fs.readFileSync(path.join(output,'_headers'),'utf8').match(/sha256-/g)||[]).length,2);
  assert.match(fs.readFileSync(path.join(output,'_redirects'),'utf8'),/\/old-features \/features 301/);
});

test('website preview refuses a stale application fork outside its explicit adapters',t=>{
  const {root,write}=websiteFixture(t);
  write('ui/app.js','// the current app\n');write('website/try/app.js','// a stale snapshot\n');
  assert.throws(()=>buildWebsite({root}),/shadow the current UI: app.js/);
});
