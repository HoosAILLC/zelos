// Feed files are generated from final, verified release bytes, never from the
// builder's pre-verification metadata. JSON is a strict subset of YAML.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function releaseUpdateSpecs(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Invalid update version');
  return ['darwin', 'win32'].flatMap(platform => ['arm64', 'x64'].map(arch => ({
    name: `latest-${arch}${platform === 'darwin' ? '-mac' : ''}.yml`, platform, arch,
    payload: platform === 'darwin' ? `Zelos-${version}-${arch}.zip` : `Zelos-${version}-setup-${arch}.exe`,
  })));
}

function readRegular(dir, name, maxBytes = Infinity) {
  const file = path.join(dir, name);
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`Missing update release file: ${name}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`Invalid update release file: ${name}`);
  return fs.readFileSync(file);
}

function expectedFeeds({ dir, version, assets }) {
  return releaseUpdateSpecs(version).map(spec => {
    const asset = assets?.find(asset => asset.name === spec.payload);
    if (!asset?.signing || asset.signing.version !== version || asset.signing.platform !== spec.platform
        || asset.signing.arch !== spec.arch) throw new Error(`Update payload lacks verified signing: ${spec.payload}`);
    const payload = readRegular(dir, spec.payload);
    if (payload.length !== asset.size || crypto.createHash('sha256').update(payload).digest('hex') !== asset.sha256) {
      throw new Error(`Update payload changed: ${spec.payload}`);
    }
    const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
    const bytes = Buffer.from(JSON.stringify({ version,
      files: [{ url: spec.payload, sha512, size: payload.length }],
      path: spec.payload, sha512,
    }, null, 2) + '\n');
    return { bytes, metadata: { name: spec.name, size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
  });
}

export function writeReleaseUpdateFeeds(options) {
  const feeds = expectedFeeds(options);
  for (const { bytes, metadata } of feeds) fs.writeFileSync(path.join(options.dir, metadata.name), bytes);
  return feeds.map(feed => feed.metadata);
}

export function verifyReleaseUpdateFeeds({ manifestFeeds, ...options }) {
  const expected = expectedFeeds(options);
  if (!Array.isArray(manifestFeeds) || manifestFeeds.length !== expected.length) throw new Error('Release requires all four update feeds');
  for (const { bytes, metadata } of expected) {
    const matching = manifestFeeds.filter(feed => feed?.name === metadata.name);
    if (matching.length !== 1 || Object.keys(matching[0]).length !== 3
        || matching[0].size !== metadata.size || matching[0].sha256 !== metadata.sha256) {
      throw new Error(`Update feed metadata changed: ${metadata.name}`);
    }
    if (!readRegular(options.dir, metadata.name, 64 * 1024).equals(bytes)) throw new Error(`Update feed changed: ${metadata.name}`);
  }
  return expected.map(feed => feed.metadata);
}
