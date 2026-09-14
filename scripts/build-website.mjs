import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe } from '../core/connectors/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function downloadNames(version) {
  return {
    'Zelos-mac-apple-silicon.dmg': `Zelos-${version}-arm64.dmg`,
    'Zelos-mac-intel.dmg': `Zelos-${version}-x64.dmg`,
    'Zelos-windows-x64.exe': `Zelos-${version}-setup-x64.exe`,
    'Zelos-windows-arm64.exe': `Zelos-${version}-setup-arm64.exe`,
    'zelos-source.zip': 'zelos-source.zip',
    'SHA256SUMS.txt': 'SHA256SUMS.txt',
  };
}

export function readWebsiteRelease(root, previewVersion) {
  // Tag builds carry an exact manifest prepared from all five release assets.
  // Website-only updates retain the separately verified, published release.
  const prepared = path.join(root, 'release-assets/release.json');
  const hasPrepared = fs.existsSync(prepared);
  const file = hasPrepared ? prepared : path.join(root, 'website/release.json');
  const release = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (hasPrepared && release.version !== previewVersion) {
    throw new Error('Release assets do not match this website preview version');
  }
  if (!/^\d+\.\d+\.\d+$/.test(release.version || '') || !/^[a-f0-9]{40}$/.test(release.commit || '')) {
    throw new Error('Website downloads require a verified release version and source commit');
  }
  const names = Object.values(downloadNames(release.version)).filter((name) => name !== 'SHA256SUMS.txt');
  if (!Array.isArray(release.assets) || release.assets.length !== names.length || names.some((name) => {
    const assets = release.assets.filter((asset) => asset.name === name);
    return assets.length !== 1 || !Number.isSafeInteger(assets[0].size) || assets[0].size < 1000 ||
      !/^[a-f0-9]{64}$/.test(assets[0].sha256 || '');
  })) {
    throw new Error('Website downloads require a complete release manifest with installer and source checksums');
  }
  return release;
}

export function buildWebsite({ root = ROOT } = {}) {
  const out = path.join(root, '.site-dist');
  const { version: previewVersion } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = readWebsiteRelease(root, previewVersion);
  const { version } = release;
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'website'), out, { recursive: true });
  fs.cpSync(path.join(root, 'ui'), path.join(out, 'demo'), { recursive: true });
  // The adapter keeps all demo data and mutations in memory using the current UI.
  fs.cpSync(path.join(root, 'website/demo'), path.join(out, 'demo'), { recursive: true });
  fs.mkdirSync(path.join(out, 'demo/assets'), { recursive: true });
  fs.copyFileSync(path.join(root, 'assets/icon.svg'), path.join(out, 'demo/assets/icon.svg'));
  fs.cpSync(path.join(root, 'assets/brand'), path.join(out, 'demo/assets/brand'), { recursive: true });
  const data = JSON.parse(fs.readFileSync(path.join(root, 'website/demo-data.json'), 'utf8'));
  fs.writeFileSync(path.join(out, 'demo/lib/demo-data.js'), `export default ${JSON.stringify({ ...data, version: previewVersion })};\n`);
  fs.writeFileSync(path.join(out, 'demo/lib/connectors.js'), `export default ${JSON.stringify(describe())};\n`);
  let html = fs.readFileSync(path.join(out, 'demo/index.html'), 'utf8')
    .replace('<title>Zelos</title>', '<title>Zelos — live demo</title>')
    .replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./')
    .replace('</head>', '<link rel="stylesheet" href="./demo.css">\n</head>')
    .replace('</body>', '<script type="module" src="./demo-banner.js"></script>\n</body>');
  fs.writeFileSync(path.join(out, 'demo/index.html'), html);
  const scriptHashes = new Set();
  for (const name of ['index.html', 'help.html', 'privacy.html']) {
    const target = path.join(out, name);
    const page = fs.readFileSync(target, 'utf8').replaceAll('{{VERSION}}', version).replaceAll('{{PREVIEW_VERSION}}', previewVersion);
    fs.writeFileSync(target, page);
    for (const match of page.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      scriptHashes.add(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
    }
  }
  const headers = path.join(out, '_headers');
  fs.writeFileSync(headers, fs.readFileSync(headers, 'utf8').replace('{{SCRIPT_HASHES}}', [...scriptHashes].join(' ')));
  const base = `https://github.com/HoosAILLC/zelos/releases/download/v${version}`;
  const downloads = downloadNames(version);
  const redirects = Object.entries(downloads).flatMap(([alias, name]) =>
    [...new Set([alias, alias.toLowerCase()])].map((a) => `/downloads/${a} ${base}/${name} 302!`));
  fs.writeFileSync(path.join(out, '_redirects'), `${redirects.join('\n')}\n`);
  fs.writeFileSync(path.join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  fs.rmSync(path.join(out, 'demo-data.json'));
  console.log(`Built website for published Zelos ${version} with development preview ${previewVersion}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWebsite();
