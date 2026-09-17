import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { prepareRelease } from '../scripts/prepare-release.mjs';
import { publishRelease } from '../scripts/publish-release.mjs';
import { releaseAssetSpecs, releaseChecksums } from '../scripts/release-signatures.mjs';
import { releaseUpdateSpecs } from '../scripts/release-updates.mjs';

const version = '1.8.4';
const commit = 'a'.repeat(40);
const env = { GITHUB_REF_NAME: `v${version}`, GITHUB_SHA: commit };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-release-signing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'release-assets');
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  write('package.json', { version });
  write('desktop/package.json', { version });
  write('docs/RELEASE-NOTES.md', 'Release notes.');
  const specs = releaseAssetSpecs(version);
  for (const [index, spec] of specs.entries()) {
    const bytes = Buffer.alloc(2000 + index, index + 1);
    write(`release-assets/${spec.name}`, bytes);
    if (spec.platform) write(`release-assets/${spec.name}.signature.json`, {
      schemaVersion: 1, ...spec, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), version, commit,
      publisher: 'Example Software, Inc.', checks: spec.platform === 'darwin' ? ['codesign', 'gatekeeper', 'notarization'] : ['authenticode', 'timestamp'],
    });
  }
  const receipt = (index = 0) => `release-assets/${specs[index].name}.signature.json`;
  const updateReceipt = (change, index = 0) => {
    const value = JSON.parse(fs.readFileSync(path.join(root, receipt(index)), 'utf8'));
    change(value); write(receipt(index), value);
  };
  const updateManifest = (change) => {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
    change(value); write('release-assets/release.json', value);
  };
  return { root, dir, specs, write, receipt, updateReceipt, updateManifest };
}

function blockedPublish(f, pattern = /./) {
  let calls = 0;
  assert.throws(() => publishRelease({ root: f.root, env, execute: () => { calls++; } }), pattern);
  assert.equal(calls, 0, 'Invalid release evidence must fail before invoking GitHub');
}

test('preparation binds all six native signing receipts to exact installer bytes and leaves source unsigned', (t) => {
  const f = fixture(t);
  const release = prepareRelease({ root: f.root, env });
  assert.equal(release.version, version); assert.equal(release.commit, commit);
  assert.equal(release.assets.length, 7);
  assert.deepEqual(release.assets.map((asset) => [asset.name, asset.signing?.platform, asset.signing?.arch]), [
    ['Zelos-1.8.4-arm64.dmg', 'darwin', 'arm64'],
    ['Zelos-1.8.4-x64.dmg', 'darwin', 'x64'],
    ['Zelos-1.8.4-setup-arm64.exe', 'win32', 'arm64'],
    ['Zelos-1.8.4-setup-x64.exe', 'win32', 'x64'],
    ['Zelos-1.8.4-arm64.zip', 'darwin', 'arm64'],
    ['Zelos-1.8.4-x64.zip', 'darwin', 'x64'],
    ['zelos-source.zip', undefined, undefined],
  ]);
  for (const asset of release.assets.filter(asset => asset.signing)) {
    assert.deepEqual(asset.signing, JSON.parse(fs.readFileSync(path.join(f.dir, `${asset.name}.signature.json`), 'utf8')));
    assert.equal(asset.signing.sha256, asset.sha256);
    assert.equal(asset.signing.publisher, 'Example Software, Inc.');
  }
  assert.equal(Object.hasOwn(release.assets.at(-1), 'signing'), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'zelos-source.zip.signature.json')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'SHA256SUMS.txt'), 'utf8'), releaseChecksums([...release.assets, ...release.updateFeeds]));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json'), 'utf8')), release);
});

for (const index of [0, 1, 2, 3, 4, 5]) test(`preparation refuses a missing receipt for installer ${index + 1}`, (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, f.receipt(index)));
  assert.throws(() => prepareRelease({ root: f.root, env }), /Missing signing receipt/);
  assert.equal(fs.existsSync(path.join(f.dir, 'release.json')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'SHA256SUMS.txt')), false);
});

for (const [label, change, pattern] of [
  ['schema version', (r) => { r.schemaVersion = 2; }, /Invalid signing receipt/],
  ['installer name', (r) => { r.name = '../other.dmg'; }, /name mismatch/],
  ['digest', (r) => { r.sha256 = 'b'.repeat(64); }, /sha256 mismatch/],
  ['version', (r) => { r.version = '1.8.3'; }, /version mismatch/],
  ['source commit', (r) => { r.commit = 'c'.repeat(40); }, /commit mismatch/],
  ['platform', (r) => { r.platform = 'win32'; }, /platform mismatch/],
  ['architecture', (r) => { r.arch = 'x64'; }, /arch mismatch/],
  ['publisher', (r) => { r.publisher = '  '; }, /Invalid signing receipt/],
  ['publisher controls', (r) => { r.publisher = 'Example\nPublisher'; }, /Invalid signing receipt/],
  ['unknown public fields', (r) => { r.privateDiagnostic = 'must not publish'; }, /Invalid signing receipt/],
  ['missing macOS notarization', (r) => { r.checks = ['codesign', 'gatekeeper']; }, /missing required darwin checks/],
  ['duplicate checks', (r) => { r.checks = ['codesign', 'codesign', 'notarization']; }, /missing required darwin checks/],
  ['checks as prose', (r) => { r.checks = 'codesign gatekeeper notarization'; }, /missing required darwin checks/],
]) test(`preparation rejects a receipt with invalid ${label}`, (t) => {
  const f = fixture(t); f.updateReceipt(change);
  assert.throws(() => prepareRelease({ root: f.root, env }), pattern);
});

test('Windows signing requires both Authenticode and a timestamp', (t) => {
  const f = fixture(t); f.updateReceipt((r) => { r.checks = ['authenticode']; }, 2);
  assert.throws(() => prepareRelease({ root: f.root, env }), /missing required win32 checks/);
});

test('preparation refuses changed installer bytes even when the filename is unchanged', (t) => {
  const f = fixture(t); fs.appendFileSync(path.join(f.dir, f.specs[0].name), 'tampered');
  assert.throws(() => prepareRelease({ root: f.root, env }), /sha256 mismatch/);
});

test('preparation rejects malformed JSON and oversized receipt files', (t) => {
  const f = fixture(t); f.write(f.receipt(), '{invalid');
  assert.throws(() => prepareRelease({ root: f.root, env }), /Invalid signing receipt JSON/);
  f.write(f.receipt(), ' '.repeat(65 * 1024));
  assert.throws(() => prepareRelease({ root: f.root, env }), /Invalid signing receipt/);
});

test('preparation requires matching release tag, desktop version, and full commit', (t) => {
  const f = fixture(t);
  assert.throws(() => prepareRelease({ root: f.root, env: { ...env, GITHUB_REF_NAME: 'v1.8.3' } }), /must match/);
  assert.throws(() => prepareRelease({ root: f.root, env: { ...env, GITHUB_SHA: 'abc1234' } }), /full source commit/);
  f.write('desktop/package.json', { version: '1.8.3' });
  assert.throws(() => prepareRelease({ root: f.root, env }), /must match/);
});

test('publish includes only the complete verified set and its public signing receipts', (t) => {
  const f = fixture(t); const prepared = prepareRelease({ root: f.root, env });
  f.write('release-assets/unverified-extra.exe', Buffer.alloc(2000));
  let invocation;
  const result = publishRelease({ root: f.root, env, execute: (...args) => { invocation = args; } });
  assert.deepEqual(result, prepared);
  assert.equal(invocation[0], 'gh');
  const args = invocation[1];
  assert.deepEqual(args.slice(0, 3), ['release', 'create', `v${version}`]);
  const files = args.slice(3, args.indexOf('--verify-tag')).map((file) => path.basename(file));
  assert.deepEqual(files, [...f.specs.map(({ name }) => name), ...f.specs.filter(spec => spec.platform).map(({ name }) => `${name}.signature.json`), ...releaseUpdateSpecs(version).map(spec => spec.name), 'SHA256SUMS.txt', 'release.json']);
  assert.equal(files.includes('unverified-extra.exe'), false);
  assert.equal(files.includes('zelos-source.zip.signature.json'), false);
});

for (const [label, change, pattern] of [
  ['missing asset set', (r) => { delete r.assets; }, /missing its signed asset set/],
  ['missing installer', (r) => { r.assets.shift(); }, /exactly the four installers/],
  ['duplicated installer', (r) => { r.assets[1] = r.assets[0]; }, /exactly the four installers/],
  ['path traversal', (r) => { r.assets[0].name = '../stolen.dmg'; }, /exactly the four installers/],
  ['missing signing metadata', (r) => { delete r.assets[0].signing; }, /missing signing metadata/],
  ['tampered publisher', (r) => { r.assets[0].signing.publisher = 'Other Publisher'; }, /signing metadata changed/],
  ['removed verification check', (r) => { r.assets[0].signing.checks.pop(); }, /missing required darwin checks/],
  ['tampered asset digest', (r) => { r.assets[0].sha256 = 'b'.repeat(64); }, /Release asset changed/],
  ['tampered size', (r) => { r.assets[0].size++; }, /Release asset changed/],
  ['false source signing claim', (r) => { r.assets.at(-1).signing = r.assets[0].signing; }, /source archive must not claim/],
]) test(`publish refuses ${label} before invoking GitHub`, (t) => {
  const f = fixture(t); prepareRelease({ root: f.root, env }); f.updateManifest(change); blockedPublish(f, pattern);
});

test('publish rechecks native receipts instead of trusting prepared metadata alone', (t) => {
  const f = fixture(t); prepareRelease({ root: f.root, env });
  f.updateReceipt((r) => { r.publisher = 'Other Publisher'; });
  blockedPublish(f, /signing metadata changed/);
  fs.rmSync(path.join(f.root, f.receipt()));
  blockedPublish(f, /Missing signing receipt/);
});

test('publish refuses modified installer or source bytes after preparation', (t) => {
  const f = fixture(t); prepareRelease({ root: f.root, env });
  fs.appendFileSync(path.join(f.dir, 'zelos-source.zip'), 'tampered');
  blockedPublish(f, /Release asset changed: zelos-source.zip/);
});

test('publish refuses modified checksums and release identity after preparation', (t) => {
  const f = fixture(t); prepareRelease({ root: f.root, env });
  f.write('release-assets/SHA256SUMS.txt', 'different checksums');
  blockedPublish(f, /checksum file changed/);
  let calls = 0;
  assert.throws(() => publishRelease({ root: f.root, env: { ...env, GITHUB_SHA: 'c'.repeat(40) }, execute: () => { calls++; } }), /identity mismatch/);
  assert.equal(calls, 0);
});

test('update feeds bind exactly one signed native payload to its final SHA-512 and size', (t) => {
  const f = fixture(t);
  const release = prepareRelease({ root: f.root, env });
  const specs = releaseUpdateSpecs(version);
  assert.deepEqual(specs.map(spec => spec.name), ['latest-arm64-mac.yml', 'latest-x64-mac.yml', 'latest-arm64.yml', 'latest-x64.yml']);
  assert.equal(release.updateFeeds.length, 4);
  for (const spec of specs) {
    const bytes = fs.readFileSync(path.join(f.dir, spec.payload));
    const raw = fs.readFileSync(path.join(f.dir, spec.name));
    const feed = JSON.parse(raw);
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
    assert.deepEqual(feed, { version, files: [{ url: spec.payload, sha512, size: bytes.length }], path: spec.payload, sha512 });
    assert.deepEqual(release.updateFeeds.find(feed => feed.name === spec.name), {
      name: spec.name, size: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    });
  }
});

for (const spec of releaseUpdateSpecs(version)) test(`publish requires unchanged ${spec.name}`, (t) => {
  const f = fixture(t); prepareRelease({ root: f.root, env });
  const file = path.join(f.dir, spec.name);
  const original = fs.readFileSync(file);
  const feed = JSON.parse(original);
  feed.files[0].url = 'https://untrusted.example/update.zip';
  fs.writeFileSync(file, JSON.stringify(feed));
  blockedPublish(f, /Update feed changed/);
  fs.writeFileSync(file, original);
  fs.rmSync(file);
  blockedPublish(f, /Missing update release file/);
});

for (const [label, change, pattern] of [
  ['missing feeds', r => { delete r.updateFeeds; }, /all four update feeds/],
  ['incomplete feeds', r => { r.updateFeeds.pop(); }, /all four update feeds/],
  ['duplicate feed', r => { r.updateFeeds[1] = r.updateFeeds[0]; }, /Update feed metadata changed/],
  ['changed feed checksum', r => { r.updateFeeds[0].sha256 = 'd'.repeat(64); }, /Update feed metadata changed/],
  ['changed feed size', r => { r.updateFeeds[0].size++; }, /Update feed metadata changed/],
  ['unknown feed metadata', r => { r.updateFeeds[0].privateKey = 'not-public'; }, /Update feed metadata changed/],
]) test(`publish rejects ${label} before GitHub runs`, t => {
  const f = fixture(t); prepareRelease({ root: f.root, env }); f.updateManifest(change); blockedPublish(f, pattern);
});

test('preparation replaces pre-verification builder feeds with final payload hashes', t => {
  const f = fixture(t);
  const spec = releaseUpdateSpecs(version)[0];
  f.write(`release-assets/${spec.name}`, 'outdated metadata from before native verification');
  const bytes = Buffer.alloc(4321, 42);
  f.write(`release-assets/${spec.payload}`, bytes);
  const index = f.specs.findIndex(asset => asset.name === spec.payload);
  f.updateReceipt(receipt => { receipt.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); }, index);
  prepareRelease({ root: f.root, env });
  const feed = JSON.parse(fs.readFileSync(path.join(f.dir, spec.name), 'utf8'));
  assert.equal(feed.files[0].sha512, crypto.createHash('sha512').update(bytes).digest('base64'));
  assert.equal(feed.files[0].size, bytes.length);
});

test('feeds from another architecture cannot be swapped between channels', t => {
  const f = fixture(t); prepareRelease({ root: f.root, env });
  fs.copyFileSync(path.join(f.dir, 'latest-arm64.yml'), path.join(f.dir, 'latest-x64.yml'));
  blockedPublish(f, /Update feed changed: latest-x64.yml/);
});
