/**
 * Release receipts record the signing checks performed by native CI jobs.
 * They are a release provenance gate, not cryptographic signatures themselves:
 * the embedded OS signatures and Apple's notarization remain the trust source.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CHECKS = Object.freeze({
  darwin: Object.freeze(['codesign', 'gatekeeper', 'notarization']),
  win32: Object.freeze(['authenticode', 'timestamp']),
});
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertReleaseIdentity(version, commit) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '')) {
    throw new Error('Release requires a valid version and full source commit');
  }
}

export function releaseAssetSpecs(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Invalid release version');
  return [
    { name: `Zelos-${version}-arm64.dmg`, platform: 'darwin', arch: 'arm64' },
    { name: `Zelos-${version}-x64.dmg`, platform: 'darwin', arch: 'x64' },
    { name: `Zelos-${version}-setup-arm64.exe`, platform: 'win32', arch: 'arm64' },
    { name: `Zelos-${version}-setup-x64.exe`, platform: 'win32', arch: 'x64' },
    { name: `Zelos-${version}-arm64.zip`, platform: 'darwin', arch: 'arm64' },
    { name: `Zelos-${version}-x64.zip`, platform: 'darwin', arch: 'x64' },
    { name: 'zelos-source.zip' },
  ];
}

function regularFile(file, label, { maxBytes = Infinity } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`Missing ${label}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`Invalid ${label}`);
  return fs.readFileSync(file);
}

/** Validate all fields against the actual installer, never a guessed suffix. */
export function verifySignatureReceipt(receipt, { name, sha256, version, commit, platform, arch }) {
  const invalid = () => { throw new Error(`Invalid signing receipt for ${name}`); };
  if (!object(receipt) || receipt.schemaVersion !== 1 || !CHECKS[platform]) invalid();
  const keys = ['schemaVersion', 'name', 'sha256', 'version', 'commit', 'platform', 'arch', 'publisher', 'checks'];
  if (Object.keys(receipt).some((key) => !keys.includes(key))) invalid();
  for (const [key, expected] of Object.entries({ name, sha256, version, commit, platform, arch })) {
    if (receipt[key] !== expected) throw new Error(`Signing receipt ${key} mismatch: ${name}`);
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.sha256 || '') || typeof receipt.publisher !== 'string'
      || !receipt.publisher.trim() || receipt.publisher.length > 1000 || /[\u0000-\u001f\u007f]/.test(receipt.publisher)) invalid();
  const required = CHECKS[platform];
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== required.length
      || required.some((check) => receipt.checks.filter((entry) => entry === check).length !== 1)) {
    throw new Error(`Signing receipt is missing required ${platform} checks: ${name}`);
  }
  // Keep a canonical copy of the public schema in release.json. Unknown fields
  // are refused above because the receipt itself is also a public artifact.
  return { schemaVersion: 1, name, sha256, version, commit, platform, arch,
    publisher: receipt.publisher.trim(), checks: [...required] };
}

function readReceipt(dir, identity) {
  const file = `${identity.name}.signature.json`;
  const bytes = regularFile(path.join(dir, file), `signing receipt: ${file}`, { maxBytes: 64 * 1024 });
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid signing receipt JSON: ${file}`); }
  return verifySignatureReceipt(receipt, identity);
}

/**
 * Recompute every digest and, when publishing, compare both the manifest and
 * fresh receipts. An unsigned installer or partial asset list is never valid.
 * Source archives intentionally have no OS signing requirement.
 */
export function verifyReleaseAssets({ dir, version, commit, manifestAssets } = {}) {
  assertReleaseIdentity(version, commit);
  const specs = releaseAssetSpecs(version);
  if (manifestAssets !== undefined && (!Array.isArray(manifestAssets) || manifestAssets.length !== specs.length
      || specs.some(({ name }) => manifestAssets.filter((asset) => object(asset) && asset.name === name).length !== 1))) {
    throw new Error('Release manifest must contain exactly the four installers, two Mac update archives, and source archive');
  }
  return specs.map((spec) => {
    const bytes = regularFile(path.join(dir, spec.name), `release asset: ${spec.name}`);
    if (bytes.length < 1000) throw new Error(`Empty or invalid release asset: ${spec.name}`);
    const asset = { name: spec.name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const declared = manifestAssets?.find((item) => item.name === spec.name);
    if (declared && (declared.sha256 !== asset.sha256 || declared.size !== asset.size)) throw new Error(`Release asset changed: ${spec.name}`);
    if (spec.platform) {
      const identity = { ...spec, version, commit, sha256: asset.sha256 };
      asset.signing = readReceipt(dir, identity);
      if (declared) {
        if (!object(declared.signing)) throw new Error(`Release manifest is missing signing metadata: ${spec.name}`);
        const signing = verifySignatureReceipt(declared.signing, identity);
        if (JSON.stringify(signing) !== JSON.stringify(asset.signing)) throw new Error(`Release signing metadata changed: ${spec.name}`);
      }
    } else if (declared && Object.hasOwn(declared, 'signing')) {
      throw new Error('The source archive must not claim OS signing verification');
    }
    return asset;
  });
}

export function releaseChecksums(assets) {
  return assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join('');
}

export function signatureReceiptNames(assets) {
  return assets.filter((asset) => asset.signing).map((asset) => `${asset.name}.signature.json`);
}
