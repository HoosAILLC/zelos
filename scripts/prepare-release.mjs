import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const desktop = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${version}` || desktop.version !== version) throw new Error('Release tag and app versions must match');
const commit = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Release requires the full source commit');
const dir = 'release-assets';
const names = [`Zelos-${version}-arm64.dmg`, `Zelos-${version}-x64.dmg`,
  `Zelos-${version}-setup-arm64.exe`, `Zelos-${version}-setup-x64.exe`, 'zelos-source.zip'];
const assets = names.map((name) => {
  const file = path.join(dir, name);
  const bytes = fs.readFileSync(file);
  if (bytes.length < 1000) throw new Error(`Empty or invalid release asset: ${name}`);
  return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), assets.map((a) => `${a.sha256}  ${a.name}\n`).join(''));
fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify({ version, commit, assets }, null, 2)}\n`);
console.log(`Verified ${assets.length} assets for ${tag}`);
