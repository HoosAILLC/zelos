/** Manual release checks. No account data, credentials or automatic requests. */
const REPOSITORY = 'https://github.com/HoosAILLC/zelos';
export const RELEASES_URL = `${REPOSITORY}/releases`;
export const RELEASE_API = 'https://api.github.com/repos/HoosAILLC/zelos/releases/latest';
const MAX_RESPONSE_BYTES = 1_048_576;

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) throw new Error('The release has an unrecognised version number.');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function describeRelease(release, currentVersion, checkedAt) {
  const latestVersion = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  if (!versionParts(latestVersion) || release.tag_name !== `v${latestVersion}` || release.draft !== false || release.prerelease !== false) {
    throw new Error('GitHub did not return a published stable Zelos release.');
  }
  const releaseUrl = `${RELEASES_URL}/tag/v${latestVersion}`;
  if (release.html_url !== releaseUrl || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('The release details could not be verified.');
  }
  const wanted = [
    [`Zelos-${latestVersion}-arm64.dmg`, 'Mac · Apple silicon'],
    [`Zelos-${latestVersion}-x64.dmg`, 'Mac · Intel'],
    [`Zelos-${latestVersion}-setup-x64.exe`, 'Windows · most PCs'],
    [`Zelos-${latestVersion}-setup-arm64.exe`, 'Windows · Arm'],
  ];
  const downloads = wanted.flatMap(([name, label]) => {
    const matches = (Array.isArray(release.assets) ? release.assets : []).filter(asset => asset?.name === name);
    const url = `${REPOSITORY}/releases/download/v${latestVersion}/${name}`;
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].browser_download_url !== url || !Number.isSafeInteger(matches[0].size) || matches[0].size <= 0) return [];
    return [{ name, label, url }];
  });
  const compared = compareVersions(latestVersion, currentVersion);
  return {
    currentVersion, latestVersion, updateAvailable: compared > 0, ahead: compared < 0,
    releaseUrl, publishedAt: release.published_at,
    notes: typeof release.body === 'string' ? release.body.slice(0, 6_000) : '',
    downloads, checkedAt,
  };
}

async function readRelease(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('The release response was too large.');
  }
  if (!response.body) throw new Error('GitHub returned an empty release response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('The release response was too large.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
    catch { throw new Error('GitHub returned unreadable release details.'); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One checker per server: coalesce concurrent clicks and cache only success. */
export function createUpdateChecker({ currentVersion, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8_000, cacheMs = 300_000 } = {}) {
  if (!versionParts(currentVersion)) throw new Error('The installed Zelos version is invalid.');
  let cached = null, cachedAt = 0, inFlight = null;
  return async function checkForUpdates() {
    if (cached && now() - cachedAt >= 0 && now() - cachedAt < cacheMs) return structuredClone(cached);
    if (inFlight) return structuredClone(await inFlight);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('The update check timed out. Try again when you are online.'));
      }, timeoutMs);
    });
    const read = (async () => {
      let response;
      try {
        response = await fetchImpl(RELEASE_API, {
          signal: controller.signal, redirect: 'error',
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Zelos-update-check' },
        });
      } catch {
        throw new Error('Could not reach GitHub. Check your connection and try again.');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 403 || response.status === 429) throw new Error('GitHub is limiting update checks. Please try again later.');
        throw new Error('GitHub could not provide release details. Please try again later.');
      }
      return describeRelease(await readRelease(response), currentVersion, new Date(now()).toISOString());
    })();
    inFlight = Promise.race([read, timeout]);
    try {
      const result = await inFlight;
      cached = result;
      cachedAt = now();
      return structuredClone(result);
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  };
}
