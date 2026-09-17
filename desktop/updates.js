import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateUpdateInfo, isNewerVersion } from './update-policy.js';

export const UPDATE_CHANNELS = Object.freeze({
  state: 'zelos:updates-state', check: 'zelos:updates-check', download: 'zelos:updates-download',
  install: 'zelos:updates-install', automatic: 'zelos:updates-automatic', changed: 'zelos:updates-changed',
});

export async function verifyCachedUpdate(files, candidate) {
  if (!Array.isArray(files) || files.length !== 1 || typeof files[0] !== 'string') throw new Error('Missing cached update');
  const stat = await fs.promises.lstat(files[0]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.size) throw new Error('Changed cached update');
  const hash = crypto.createHash('sha512');
  for await (const bytes of fs.createReadStream(files[0])) hash.update(bytes);
  if (hash.digest('base64') !== candidate.sha512) throw new Error('Changed cached update');
}

export function createDesktopUpdates({ updater = null, build = null, currentVersion, reason,
  preferences, onState = () => {}, notify = () => false, prepareInstall = async () => false,
  recoverInstall = async () => {}, verifyDownload = verifyCachedUpdate, createCancellationToken = () => undefined,
  setTimer = setTimeout, clearTimer = clearTimeout, startupMs = 45_000, intervalMs = 6 * 60 * 60_000,
  checkTimeoutMs = 30_000, downloadTimeoutMs = 20 * 60_000, installTimeoutMs = 120_000,
} = {}) {
  const supported = Boolean(updater && build);
  let preference = preferences?.read() || { automatic: true, lastNotifiedVersion: '' };
  let state = { supported, status: 'idle', currentVersion, automatic: supported && preference.automatic,
    ...(supported ? {} : { reason: reason || 'Install a signed release to use in-app updates. You can still check and download updates manually.' }) };
  let disposed = false, checking = null, downloading = null, installing = null;
  let timer, installTimer, token, candidate = null, files = null, prepared = false, recovering = false;
  const getState = () => structuredClone(state);
  const change = patch => { if (!disposed) { state = { ...state, ...patch }; onState(getState()); } return getState(); };
  const schedule = delay => {
    if (timer) clearTimer(timer);
    timer = null;
    if (supported && state.automatic && !disposed) {
      timer = setTimer(() => { timer = null; void check(true).finally(() => schedule(intervalMs)); }, delay);
      timer?.unref?.();
    }
  };
  async function bounded(promise, milliseconds, cancel = () => {}) {
    let timeout;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timeout = setTimer(() => { cancel(); reject(new Error('Update operation timed out')); }, milliseconds);
      })]);
    } finally { clearTimer(timeout); }
  }
  async function installFailed() {
    if (recovering || disposed) return;
    recovering = true;
    clearTimer(installTimer);
    change({ status: 'downloaded', error: 'The update could not be installed. Your data and recovery backup have been kept.' });
    const needsRecovery = prepared;
    prepared = false;
    if (needsRecovery) await recoverInstall().catch(() => {});
    recovering = false;
  }
  const progress = value => {
    if (state.status === 'downloading' && Number.isFinite(value?.percent)) change({ progress: Math.min(100, Math.max(0, value.percent)) });
  };
  const updaterError = () => { if (state.status === 'installing' && prepared) void installFailed(); };
  if (supported) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.channel = build.channel;
    // Setting channel can enable downgrades in electron-updater; set these last.
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableDifferentialDownload = true;
    updater.disableWebInstaller = true;
    updater.on('download-progress', progress);
    updater.on('error', updaterError);
  }

  function check(background = false) {
    if (!supported || disposed || downloading || installing || ['downloaded', 'installing'].includes(state.status) || (background && !state.automatic)) return Promise.resolve(getState());
    if (checking) return checking;
    candidate = null; files = null;
    change({ status: 'checking', error: undefined, progress: undefined });
    checking = Promise.resolve().then(async () => {
      try {
        if (disposed) return getState();
        const result = await bounded(updater.checkForUpdates(), checkTimeoutMs);
        if (disposed) return getState();
        const checked = validateUpdateInfo(result?.updateInfo, build);
        const available = result.isUpdateAvailable === true && isNewerVersion(checked.version, currentVersion);
        token = result.cancellationToken;
        if (available) candidate = checked;
        change({ status: available ? 'available' : 'idle', latestVersion: checked.version, releaseUrl: checked.releaseUrl });
        if (background && state.automatic && available && preference.lastNotifiedVersion !== checked.version) {
          if (notify(getState())) {
            preference = { ...preference, lastNotifiedVersion: checked.version };
            try { preferences?.write(preference); } catch { /* A notification does not block update checks. */ }
          }
        }
      } catch {
        change({ status: 'error', error: 'Could not check for a verified update. Check your connection and try again. You can also use the official downloads page.' });
      } finally { checking = null; }
      return getState();
    });
    return checking;
  }

  function download() {
    if (downloading) return downloading;
    if (!supported || disposed || !candidate || checking || installing || ['downloaded', 'installing'].includes(state.status)) return Promise.resolve(getState());
    change({ status: 'downloading', error: undefined, progress: 0 });
    downloading = Promise.resolve().then(async () => {
      try {
        if (disposed) return getState();
        token = createCancellationToken();
        const downloaded = await bounded(updater.downloadUpdate(token), downloadTimeoutMs, () => token?.cancel());
        await verifyDownload(downloaded, candidate);
        if (!disposed) { files = downloaded; change({ status: 'downloaded', progress: 100 }); }
      } catch {
        files = null;
        change({ status: 'available', progress: undefined, error: 'The update could not be downloaded and verified. Please try again.' });
      } finally { downloading = null; }
      return getState();
    });
    return downloading;
  }

  function install() {
    if (installing) return installing;
    if (!supported || disposed || recovering || !candidate || !files || state.status !== 'downloaded') return Promise.resolve(getState());
    change({ status: 'installing', error: undefined });
    prepared = false;
    installing = Promise.resolve().then(async () => {
      let verified = false;
      try {
        if (disposed) return getState();
        await verifyDownload(files, candidate);
        verified = true;
        if (disposed) return getState();
        prepared = await prepareInstall(getState());
        if (disposed) return getState();
        if (!prepared) return change({ status: 'downloaded' });
        // Confirmation and backup can take time. Verify the same bytes and
        // publisher again immediately before the native installer sees them.
        await verifyDownload(files, candidate);
        if (disposed) return getState();
        installTimer = setTimer(() => { void installFailed(); }, installTimeoutMs);
        installTimer?.unref?.();
        updater.quitAndInstall(true, true);
      } catch {
        if (prepared) await installFailed();
        else if (!verified) {
          files = null;
          change({ status: 'available', progress: undefined, error: 'The cached update could not be verified. Download it again before installing.' });
        }
        else change({ status: 'downloaded', error: 'Zelos could not prepare the update. It stayed open so you can finish saving or backing up and try again.' });
      } finally { installing = null; }
      return getState();
    });
    return installing;
  }

  function setAutomatic(value) {
    if (!supported || disposed || typeof value !== 'boolean') return getState();
    try {
      const updated = { ...preference, automatic: value };
      preferences?.write(updated);
      preference = updated;
      change({ automatic: value, error: undefined });
      schedule(startupMs);
    } catch { change({ error: 'The update preference could not be saved. Please try again.' }); }
    return getState();
  }
  return { getState, check: () => check(false), download, install, setAutomatic,
    start: () => schedule(startupMs),
    dispose() {
      disposed = true; clearTimer(timer); clearTimer(installTimer); token?.cancel();
      updater?.removeListener('download-progress', progress);
      updater?.removeListener('error', updaterError);
      updater?.closeServerIfExists?.();
    },
  };
}

export function updateHandlers({ controller, isBoard }) {
  const denied = () => ({ supported: false, status: 'error', automatic: false, error: 'Updates are only available in the Zelos desktop board.' });
  const fixed = method => (event, ...args) => isBoard(event) && args.length === 0 ? controller[method]() : denied();
  return {
    [UPDATE_CHANNELS.state]: fixed('getState'), [UPDATE_CHANNELS.check]: fixed('check'),
    [UPDATE_CHANNELS.download]: fixed('download'), [UPDATE_CHANNELS.install]: fixed('install'),
    [UPDATE_CHANNELS.automatic]: (event, ...args) => isBoard(event) && args.length === 1 && typeof args[0] === 'boolean' ? controller.setAutomatic(args[0]) : denied(),
  };
}
