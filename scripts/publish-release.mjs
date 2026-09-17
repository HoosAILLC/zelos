import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertReleaseIdentity, releaseChecksums, signatureReceiptNames, verifyReleaseAssets } from './release-signatures.mjs';

export function publishRelease({ root = process.cwd(), env = process.env, execute = execFileSync } = {}) {
  const dir = path.join(root, 'release-assets');
  const release = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
  const tag = env.GITHUB_REF_NAME;
  assertReleaseIdentity(release.version, release.commit);
  if (tag !== `v${release.version}` || env.GITHUB_SHA !== release.commit) throw new Error('Release identity mismatch');
  if (!Array.isArray(release.assets)) throw new Error('Release manifest is missing its signed asset set');
  // Preparation is not a permanent permission to publish: recheck the complete
  // installer set, its signing metadata, and the receipts immediately before gh.
  const assets = verifyReleaseAssets({ dir, version: release.version, commit: release.commit, manifestAssets: release.assets });
  if (fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8') !== releaseChecksums(assets)) throw new Error('Release checksum file changed');
  const files = [...assets.map((asset) => asset.name), ...signatureReceiptNames(assets)].map((name) => path.join(dir, name));
  // Publish only the verified set. Receipts are public CI records; the embedded
  // OS signatures and Apple's notarization remain the signing trust source.
  const args = ['release', 'create', tag, ...files, path.join(dir, 'SHA256SUMS.txt'),
    path.join(dir, 'release.json'), '--verify-tag', '--title', `Zelos ${release.version}`,
    '--notes-file', path.join(root, 'docs/RELEASE-NOTES.md')];
  execute('gh', args, { stdio: 'inherit', cwd: root, env });
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) publishRelease();
