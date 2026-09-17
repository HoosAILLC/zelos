// Shared by the native updater and release QA. No renderer-selected feed or URL.
export const UPDATE_REPOSITORY = 'https://github.com/HoosAILLC/zelos';
const stable = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && value.split('.').every(part => Number.isSafeInteger(Number(part)));

export function validateUpdateBuild({ manifest, feed, packaged, platform, arch }) {
  const value = manifest?.zelosUpdates;
  if (!packaged || !['darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)
      || value?.schemaVersion !== 1 || value.platform !== platform || value.arch !== arch
      || value.channel !== `latest-${arch}` || typeof value.publisher !== 'string' || !value.publisher.trim()
      || !stable(manifest.version)) throw new Error('This build does not support signed in-app updates.');
  if (feed?.provider !== 'github' || feed.owner !== 'HoosAILLC' || feed.repo !== 'zelos'
      || feed.channel !== value.channel || feed.host || feed.token || feed.private || feed.url
      || feed.protocol && feed.protocol !== 'https') throw new Error('The signed update source is invalid.');
  if (platform === 'win32' && (!Array.isArray(feed.publisherName) || feed.publisherName.length !== 1
      || feed.publisherName[0] !== value.publisher)) throw new Error('The Windows update publisher is invalid.');
  if (platform === 'darwin' && !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(value.publisher)) throw new Error('The Mac update publisher is invalid.');
  return { ...value, currentVersion: manifest.version };
}

export function validateUpdateInfo(info, build) {
  if (!stable(info?.version) || info.tag !== `v${info.version}` || info.packages || info.stagingPercentage != null
      || !Array.isArray(info.files) || info.files.length !== 1) throw new Error('The update metadata could not be verified.');
  const filename = build.platform === 'darwin' ? `Zelos-${info.version}-${build.arch}.zip` : `Zelos-${info.version}-setup-${build.arch}.exe`;
  const file = info.files[0];
  if (file?.url !== filename || !Number.isSafeInteger(file.size) || file.size < 1000 || file.size > 2 ** 31
      || typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
      || (info.path != null && info.path !== filename) || (info.sha512 != null && info.sha512 !== file.sha512)) {
    throw new Error('The update file does not match this installation.');
  }
  return { version: info.version, filename, sha512: file.sha512, size: file.size,
    releaseUrl: `${UPDATE_REPOSITORY}/releases/tag/v${info.version}` };
}

export function isNewerVersion(candidate, current) {
  if (!stable(candidate) || !stable(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function allowedUpdateRequest(value, build) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    // GitHub redirects release attachments to these download hosts. Downloaded
    // bytes must still match the feed hash and the platform publisher signature.
    if (['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'releases.githubusercontent.com'].includes(url.hostname)) return true;
    if (url.hostname !== 'github.com') return false;
    const base = '/HoosAILLC/zelos/releases';
    if (url.pathname === `${base}.atom` || url.pathname === `${base}/latest`) return true;
    if (/^\/HoosAILLC\/zelos\/releases\/tag\/v\d+\.\d+\.\d+$/.test(url.pathname)) return true;
    const match = /^\/HoosAILLC\/zelos\/releases\/download\/v(\d+\.\d+\.\d+)\/([^/]+)$/.exec(url.pathname);
    if (!match || !stable(match[1])) return false;
    const feed = `${build.channel}${build.platform === 'darwin' ? '-mac' : ''}.yml`;
    const artifact = build.platform === 'darwin' ? `Zelos-${match[1]}-${build.arch}.zip` : `Zelos-${match[1]}-setup-${build.arch}.exe`;
    return match[2] === feed || match[2] === artifact;
  } catch { return false; }
}
