import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseIdentity, releaseChecksums, verifyReleaseAssets } from './release-signatures.mjs';
import { writeReleaseUpdateFeeds } from './release-updates.mjs';

export function prepareRelease({ root = process.cwd(), env = process.env } = {}) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const desktop = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  const tag = env.GITHUB_REF_NAME;
  if (tag !== `v${version}` || desktop.version !== version) throw new Error('Release tag and app versions must match');
  const commit = env.GITHUB_SHA;
  assertReleaseIdentity(version, commit);
  const dir = path.join(root, 'release-assets');
  // Native jobs produce a receipt only after verifying the finished installer.
  // Every receipt must bind those checks to these exact bytes and this commit.
  const assets = verifyReleaseAssets({ dir, version, commit });
  const updateFeeds = writeReleaseUpdateFeeds({ dir, version, assets });
  const release = { version, commit, assets, updateFeeds };
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), releaseChecksums([...assets, ...updateFeeds]));
  fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = prepareRelease();
  console.log(`Verified ${release.assets.length} assets, six signing receipts, and four update feeds for v${release.version}`);
}
