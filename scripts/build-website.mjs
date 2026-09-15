import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MEAL_CATALOG } from '../core/meal-catalog.mjs';
import { GROCERY_STORES } from '../core/grocery-stores.mjs';

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

const walk = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(path.join(dir,entry.name)) : [path.join(dir,entry.name)]);

// Everything visual comes from the application on every build. Only explicit
// demo adapters are overlaid; a second checked-in UI cannot silently go stale.
export function previewSource(source) {
  return source.replace(/(['"`])zelos\.(?!demo\.)/g, '$1zelos.demo.')
    .replace(/(['"])\/assets\//g, '$1./assets/');
}

function buildPreview(root, out, version) {
  const target = path.join(out, 'try');
  const adapters = new Set(['lib/api.js','lib/bank-link.js','views/family.js']);
  for (const file of walk(path.join(root,'website/try'))) {
    const relative = path.relative(path.join(root,'website/try'),file).split(path.sep).join('/');
    if (fs.existsSync(path.join(root,'ui',relative)) && !adapters.has(relative)) {
      throw new Error(`Website preview would shadow the current UI: ${relative}. Keep visual changes in ui/.`);
    }
  }
  fs.rmSync(target, {recursive:true, force:true});
  fs.cpSync(path.join(root, 'ui'), target, {recursive:true});
  for (const file of walk(target)) if (file.endsWith('.js')) fs.writeFileSync(file, previewSource(fs.readFileSync(file,'utf8')));
  fs.cpSync(path.join(root, 'website/try'), target, {recursive:true});
  fs.mkdirSync(path.join(target, 'assets'), {recursive:true});
  for (const name of ['icon.svg','brand','meals']) {
    const source = path.join(root,'assets',name);
    if (fs.existsSync(source)) fs.cpSync(source,path.join(target,'assets',name),{recursive:true});
  }
  const apiSource = fs.readFileSync(path.join(root,'ui/lib/api.js'),'utf8');
  const query = /function queryString\([\s\S]*?\n\}/.exec(apiSource)?.[0];
  const endpoints = /export const api = \{[\s\S]*?\n\};/.exec(apiSource)?.[0];
  if (!query || !endpoints) throw new Error('The current app API could not be adapted for the website preview');
  fs.writeFileSync(path.join(target,'lib/endpoints.js'), `// Generated from ui/lib/api.js; every operation uses the fictional transport.\nimport {request,download} from './api.js';\n${query}\n${endpoints}\n`);
  fs.writeFileSync(path.join(target,'lib/demo-version.js'), `export default ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(target,'lib/demo-catalog.js'), `export const recipes=${JSON.stringify(MEAL_CATALOG)};\nexport const stores=${JSON.stringify(GROCERY_STORES)};\n`);
  const index = fs.readFileSync(path.join(target,'index.html'),'utf8')
    .replace('<title>Zelos</title>','<title>Try Zelos — current app preview</title>')
    .replaceAll('href="/','href="./').replaceAll('src="/','src="./')
    .replace('</head>','<meta name="robots" content="noindex">\n<link rel="stylesheet" href="./demo.css">\n<script src="./demo-boot.js"></script>\n</head>')
    .replace('</body>','<script type="module" src="./demo.js"></script>\n</body>');
  fs.writeFileSync(path.join(target,'index.html'),index);
  // Old bookmarks retain their route and now reach the same current preview.
  fs.rmSync(path.join(out,'demo'),{recursive:true,force:true});
  fs.cpSync(target,path.join(out,'demo'),{recursive:true});
}

export function buildWebsite({ root = ROOT, out = path.join(root, '.site-dist') } = {}) {
  const { version: previewVersion } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = readWebsiteRelease(root, previewVersion);
  const { version } = release;
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'website'), out, { recursive: true });
  buildPreview(root,out,previewVersion);
  const scriptHashes = new Set();
  for (const name of fs.readdirSync(out).filter(name => name.endsWith('.html'))) {
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
  const staticRedirects = fs.existsSync(path.join(root,'website/_redirects')) ? fs.readFileSync(path.join(root,'website/_redirects'),'utf8') : '';
  fs.writeFileSync(path.join(out, '_redirects'), `${redirects.join('\n')}\n${staticRedirects}`);
  fs.writeFileSync(path.join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  fs.rmSync(path.join(out, 'demo-data.json'),{force:true});
  console.log(`Built website for published Zelos ${version} with development preview ${previewVersion}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWebsite();
