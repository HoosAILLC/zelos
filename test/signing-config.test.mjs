import test from 'node:test';
import assert from 'node:assert/strict';
import { signingConfig } from '../scripts/signing-config.mjs';

const commit = 'a'.repeat(40);
const mac = { GITHUB_SHA: commit, CSC_LINK: 'fixture-certificate', CSC_KEY_PASSWORD: 'fixture-password',
  MAC_SIGNING_IDENTITY: 'Example Company (ABCDE12345)', APPLE_TEAM_ID: 'ABCDE12345',
  APPLE_ID: 'developer@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-notary-password' };
const azure = { GITHUB_SHA: commit, WINDOWS_SIGNING_PROVIDER: 'azure', WINDOWS_PUBLISHER_NAME: 'Example Company',
  AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/', AZURE_SIGNING_ACCOUNT: 'example',
  AZURE_CERTIFICATE_PROFILE: 'release', AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'fixture-secret' };

test('release configuration requires a source identity and refuses unsupported hosts', () => {
  assert.throws(() => signingConfig({}, 'darwin'), /GITHUB_SHA/);
  assert.throws(() => signingConfig({ ...mac, GITHUB_SHA: 'HEAD' }, 'darwin'), /full source commit/);
  assert.throws(() => signingConfig({ GITHUB_SHA: commit }, 'linux'), /macOS or Windows/);
});

test('Mac release cannot fall back to ad-hoc signing or silently skip notarization', () => {
  for (const key of Object.keys(mac)) {
    const env = { ...mac }; delete env[key];
    assert.throws(() => signingConfig(env, 'darwin'), new RegExp(key));
  }
  for (const identity of ['-', 'Developer ID Application: Example Company (ABCDE12345)', 'Example Company (WRONG12345)']) {
    assert.throws(() => signingConfig({ ...mac, MAC_SIGNING_IDENTITY: identity }, 'darwin'), /MAC_SIGNING_IDENTITY/);
  }
  assert.throws(() => signingConfig({ ...mac, APPLE_TEAM_ID: 'invalid' }, 'darwin'), /APPLE_TEAM_ID/);
  const config = signingConfig(mac, 'darwin');
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.type, 'distribution');
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.dmg.sign, true);
  assert.equal(config.mac.identity, mac.MAC_SIGNING_IDENTITY);
  assert.equal(config.extraMetadata.commit, commit);
});

test('Azure releases require a complete signing account and public publisher name', () => {
  for (const key of Object.keys(azure)) {
    const env = { ...azure }; delete env[key];
    assert.throws(() => signingConfig(env, 'win32'), new RegExp(key));
  }
  const config = signingConfig(azure, 'win32');
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.win.signtoolOptions, undefined);
  assert.equal(config.win.azureSignOptions.publisherName, 'Example Company');
  assert.equal(config.win.azureSignOptions.fileDigest, 'SHA256');
  assert.equal(config.win.azureSignOptions.timestampDigest, 'SHA256');
  for (const extension of ['.exe', '.dll', '.node']) assert.ok(config.win.signExts.includes(extension));
});

test('Azure credentials cannot be directed to an unrelated signing endpoint', () => {
  for (const endpoint of ['http://eus.codesigning.azure.net/', 'https://codesigning.azure.net.example.test/',
    'https://example.test/', 'https://user@eus.codesigning.azure.net/', 'https://eus.codesigning.azure.net/?secret=1']) {
    assert.throws(() => signingConfig({ ...azure, AZURE_SIGNING_ENDPOINT: endpoint }, 'win32'), /Azure Artifact Signing endpoint/);
  }
});

test('certificate signing is explicit, timestamped, and cannot use Azure by accident', () => {
  const env = { GITHUB_SHA: commit, WINDOWS_SIGNING_PROVIDER: 'certificate', WINDOWS_PUBLISHER_NAME: 'Example Company',
    WIN_CSC_LINK: 'fixture-pfx', WIN_CSC_KEY_PASSWORD: 'fixture-password' };
  for (const key of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
    const missing = { ...env }; delete missing[key];
    assert.throws(() => signingConfig(missing, 'win32'), new RegExp(key));
  }
  const config = signingConfig(env, 'win32');
  assert.equal(config.win.azureSignOptions, undefined);
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
  assert.ok(config.win.signtoolOptions.rfc3161TimeStampServer);
  assert.throws(() => signingConfig({ ...env, WINDOWS_SIGNING_PROVIDER: 'none' }, 'win32'), /azure or certificate/);
});

test('generated configuration never embeds certificate material or account passwords', () => {
  for (const [env, platform, privateKeys] of [[mac, 'darwin', ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD']],
    [azure, 'win32', ['AZURE_CLIENT_SECRET']]]) {
    const serialized = JSON.stringify(signingConfig(env, platform));
    for (const key of privateKeys) assert.ok(!serialized.includes(env[key]), `${key} must remain in the build environment`);
  }
});
