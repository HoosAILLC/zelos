// Run only on a native release QA runner. Receipts record these OS checks;
// the embedded signatures, not the JSON receipts, establish publisher trust.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateUpdateBuild } from '../desktop/update-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const arch = process.argv[2];
if (!['arm64', 'x64'].includes(arch) || arch !== process.arch) throw new Error('Signature and startup verification require the native installer architecture');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Verification requires macOS or Windows');
const commit = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Verification requires a full source commit');
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = process.platform === 'darwin' ? `Zelos-${version}-${arch}.dmg` : `Zelos-${version}-setup-${arch}.exe`;
const installer = path.resolve('desktop/dist', name);
const artifacts = [installer];
if (process.platform === 'darwin') artifacts.push(path.resolve('desktop/dist', `Zelos-${version}-${arch}.zip`));
// A failed recheck cannot leave stale passing evidence behind.
for (const artifact of artifacts) fs.rmSync(`${artifact}.signature.json`, { force: true });
for (const artifact of artifacts) if (!fs.existsSync(artifact)) throw new Error(`Missing release payload: ${path.basename(artifact)}`);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
  // Do not include command arguments: notarization credentials can appear there.
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} verification failed (${result.error?.code || result.status}); no signing receipt was produced.`);
  return (result.stdout || '') + (result.stderr || '');
}
function inspectPayload(appDirectory, publisher) {
  const resources = path.join(appDirectory, process.platform === 'darwin' ? 'Resources' : 'resources');
  const app = JSON.parse(fs.readFileSync(path.join(resources, 'app/package.json'), 'utf8'));
  const core = JSON.parse(fs.readFileSync(path.join(resources, 'package.json'), 'utf8'));
  if (app.version !== version || core.version !== version || app.commit !== commit) throw new Error('Installed payload does not match the release version and source commit');
  const marker = app.zelosUpdates;
  if (marker?.schemaVersion !== 1 || marker.channel !== `latest-${arch}` || marker.platform !== process.platform
      || marker.arch !== arch || marker.publisher !== publisher) throw new Error('Installed payload has an incorrect signed update configuration');
  // Resolve the parser from the packaged updater's production dependencies so
  // native QA also catches a missing updater dependency in the actual payload.
  const require = createRequire(path.join(resources, 'app/package.json'));
  const { load } = require('js-yaml');
  const feed = load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
  validateUpdateBuild({ manifest: app, feed, packaged: true, platform: process.platform, arch });
  const runtimeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CSC_|WIN_CSC_|APPLE_|AZURE_)/.test(key)));
  run(process.execPath, ['scripts/check-desktop.mjs'], {
    timeout: 180000, env: { ...runtimeEnv, ZELOS_PACKAGED_APP_DIR: appDirectory },
  });
}
let verification;
if (process.platform === 'darwin') {
  const team = process.env.APPLE_TEAM_ID;
  const identity = process.env.MAC_SIGNING_IDENTITY?.trim();
  if (!/^[A-Z0-9]{10}$/.test(team || '') || !identity) throw new Error('Mac verification requires APPLE_TEAM_ID and MAC_SIGNING_IDENTITY');
  const expectedPublisher = `Developer ID Application: ${identity}`;
  const inspectSignature = (file, app = false) => {
    run('codesign', ['--verify', '--strict', ...(app ? ['--deep'] : []), '--verbose=2', file]);
    const details = run('codesign', ['--display', '--verbose=4', file]);
    const lines = details.split(/\r?\n/);
    if (!lines.includes(`Authority=${expectedPublisher}`) || !lines.includes(`TeamIdentifier=${team}`) || !lines.some(line => line.startsWith('Timestamp='))) throw new Error('Mac signature has the wrong publisher/team or lacks a secure timestamp');
    if (app && !/flags=.*\bruntime\b/.test(details)) throw new Error('Mac app does not have hardened runtime enabled');
  };
  const inspectApp = app => {
    inspectSignature(app, true);
    run('xcrun', ['stapler', 'validate', app]);
    const assessment = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    if (!assessment.includes('source=Notarized Developer ID')) throw new Error('Gatekeeper did not recognize the notarized app');
    inspectPayload(path.join(app, 'Contents'), expectedPublisher);
  };
  inspectSignature(installer);
  // electron-builder notarizes and staples the app; also notarize and staple
  // the outer, signed DMG so offline first-open assessment covers the download.
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']) if (!process.env[key]) throw new Error(`DMG notarization requires ${key}`);
  const response = JSON.parse(run('xcrun', ['notarytool', 'submit', installer,
    '--apple-id', process.env.APPLE_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id', team, '--wait', '--timeout', '30m', '--output-format', 'json'], { timeout: 1900000 }));
  if (response.status !== 'Accepted') throw new Error('Apple did not accept the disk image for notarization');
  run('xcrun', ['stapler', 'staple', installer]);
  run('xcrun', ['stapler', 'validate', installer]);
  inspectSignature(installer);
  const diskAssessment = run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', installer]);
  if (!diskAssessment.includes('source=Notarized Developer ID')) throw new Error('Gatekeeper did not recognize the notarized disk image');
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-signed-dmg-'));
  let mounted = false;
  try {
    run('hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount]);
    mounted = true;
    inspectApp(path.join(mount, 'Zelos.app'));
  } finally {
    if (mounted) run('hdiutil', ['detach', mount]);
    fs.rmSync(mount, { recursive: true, force: true });
  }
  // Squirrel.Mac installs the ZIP, not the DMG. Verify the actual extracted
  // archive independently; validating the app's staple does not mutate it.
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-signed-update-'));
  try {
    run('ditto', ['-x', '-k', artifacts[1], extracted]);
    inspectApp(path.join(extracted, 'Zelos.app'));
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
  verification = { publisher: expectedPublisher, checks: ['codesign', 'gatekeeper', 'notarization'] };
} else {
  const appDirectory = process.env.ZELOS_PACKAGED_APP_DIR;
  const publisher = process.env.WINDOWS_PUBLISHER_NAME;
  if (!appDirectory || !publisher) throw new Error('Windows verification requires the installed app directory and expected publisher');
  verification = JSON.parse(run('pwsh', ['-NoProfile', '-NonInteractive', '-File', 'scripts/verify-windows-signature.ps1',
    '-Installer', installer, '-AppDirectory', appDirectory,
    '-Uninstaller', path.join(appDirectory, 'Uninstall Zelos.exe'), '-Publisher', publisher]));
  inspectPayload(appDirectory, publisher);
}
for (const artifact of artifacts) {
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  const artifactName = path.basename(artifact);
  fs.writeFileSync(`${artifact}.signature.json`, JSON.stringify({ schemaVersion: 1, name: artifactName, sha256, version, commit,
    platform: process.platform, arch, ...verification }, null, 2) + '\n');
  console.log(`Verified publisher signature and native startup: ${artifactName}`);
}
