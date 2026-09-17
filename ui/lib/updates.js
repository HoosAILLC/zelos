import { el, button, replace, focusQuietly } from './dom.js';
import { request } from './api.js';

function officialReleaseUrl(release) {
  const official = `https://github.com/HoosAILLC/zelos/releases/tag/v${release.latestVersion}`;
  return /^\d+\.\d+\.\d+$/.test(release.latestVersion) && release.releaseUrl === official ? official : null;
}

/** Reading native state never starts a network check or a download. */
export function updatesPanel() {
  const bridge = typeof window !== 'undefined' && window.zelos?.desktop === true && window.zelos.updates;
  return bridge && ['getState', 'check', 'download', 'install', 'setAutomatic', 'onState'].every(name => typeof bridge[name] === 'function')
    ? nativeUpdatesPanel(bridge) : manualUpdatesPanel();
}

let panelSequence = 0;
function nativeUpdatesPanel(bridge) {
  const node = el('div', { class: 'stack update-panel' });
  const status = el('p', { class: 'quiet-note', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const details = el('div', { class: 'stack' });
  const progress = el('progress', { max: 100, 'aria-label': 'Update download progress', style: { width: '100%' } });
  const progressText = el('p', { class: 'quiet-note' });
  const preferenceId = `automatic-updates-${++panelSequence}`;
  const automatic = el('input', { class: 'checkbox', type: 'checkbox', id: preferenceId });
  const check = button('Check for updates', { class: 'btn quiet', onClick: () => run('check', check) });
  const download = button('Download update', { class: 'btn solid', onClick: () => run('download', download) });
  const install = button('Update and restart', { class: 'btn solid', onClick: () => run('install', install) });
  const retry = button('Try again', { class: 'btn quiet', onClick: () => loadState() });
  let state = null;
  let stableStatus = 'idle';
  let pending = null;
  let loading = true;
  let localError = '';
  let eventRevision = 0;
  let disposed = false;
  let mounted = false;
  let unsubscribe = null;
  let observer = null;
  let lastLink = null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    if (typeof unsubscribe === 'function') unsubscribe();
    window.removeEventListener?.('pagehide', dispose);
  }
  function active() {
    if (node.isConnected) mounted = true;
    else if (mounted) dispose();
    return !disposed;
  }
  function paint() {
    if (!active()) return;
    const phase = state?.status === 'error' ? stableStatus : state?.status || 'idle';
    const busy = loading || Boolean(pending) || ['checking', 'downloading', 'installing'].includes(phase);
    check.disabled = automatic.disabled = busy || !state;
    automatic.checked = state?.automatic === true;
    check.hidden = retry.hidden = false;
    retry.hidden = Boolean(state) || loading;
    check.hidden = !state;
    download.hidden = phase !== 'available';
    install.hidden = phase !== 'downloaded';
    download.disabled = install.disabled = busy;
    progress.hidden = progressText.hidden = phase !== 'downloading' && pending !== 'download';
    const amount = typeof state?.progress === 'number' && Number.isFinite(state.progress)
      ? Math.max(0, Math.min(100, Math.round(state.progress))) : null;
    if (amount === null) {
      progress.removeAttribute('value');
      progress.removeAttribute('aria-valuenow');
      progressText.textContent = 'Waiting for download progress…';
    } else {
      progress.setAttribute('value', String(amount));
      progress.setAttribute('aria-valuenow', String(amount));
      progressText.textContent = `${amount}% downloaded`;
    }
    const current = typeof state?.currentVersion === 'string' ? state.currentVersion : '';
    const latest = typeof state?.latestVersion === 'string' ? state.latestVersion : '';
    let message = current ? `Zelos ${current} is installed.` : 'Update settings are unavailable.';
    if (loading) message = 'Loading update settings…';
    else if (phase === 'checking' || pending === 'check') message = 'Checking the official Zelos releases…';
    else if (phase === 'downloading' || pending === 'download') message = 'Downloading the update. You can keep using Zelos.';
    else if (phase === 'installing') message = 'Saving your work and preparing the update. Zelos will restart.';
    else if (pending === 'install') message = 'Confirm the update in the Zelos window. Your work is saved before restarting.';
    else if (phase === 'downloaded') message = `${latest ? `Zelos ${latest}` : 'The update'} is ready to install. Restart when you are ready.`;
    else if (phase === 'available') message = `${latest ? `Zelos ${latest}` : 'An update'} is available.${current ? ` You have ${current}.` : ''}`;
    else if (latest && latest === current) message = `You have the latest release: Zelos ${current}.`;
    const error = localError || (!pending && typeof state?.error === 'string' ? state.error : '');
    if (error) message = `The update could not finish. ${error}`;
    if (status.textContent !== message) status.textContent = message;
    const releaseUrl = state ? officialReleaseUrl(state) : null;
    if (releaseUrl !== lastLink) {
      lastLink = releaseUrl;
      replace(details, releaseUrl ? el('a', { class: 'btn quiet', href: releaseUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Release notes' }) : []);
    }
  }
  function accept(next) {
    if (!active() || !next || typeof next.supported !== 'boolean') return;
    if (!next.supported) {
      dispose();
      replace(node, manualUpdatesPanel(typeof next.reason === 'string' ? next.reason : 'In-app updates are available in signed release installations.'));
      return;
    }
    if (!['idle', 'checking', 'available', 'downloading', 'downloaded', 'installing', 'error'].includes(next.status)) return;
    state = next;
    loading = false;
    if (['idle', 'available', 'downloaded'].includes(next.status)) stableStatus = next.status;
    paint();
  }
  async function loadState() {
    if (!active() || pending) return;
    loading = true;
    localError = '';
    paint();
    const revision = eventRevision;
    try {
      const next = await bridge.getState();
      if (active() && revision === eventRevision) {
        accept(next);
        if (!state && !disposed) throw new Error('Update settings could not be read. Try again.');
      }
    } catch (error) {
      if (active() && revision === eventRevision) localError = error?.message || 'Update settings could not be read. Try again.';
    } finally {
      if (active()) { loading = false; paint(); }
    }
  }
  async function run(action, trigger, value) {
    if (!active() || loading || pending || !state || ['checking', 'downloading', 'installing'].includes(state.status)) return;
    const hadFocus = document.activeElement === trigger;
    pending = action;
    localError = '';
    const revision = eventRevision;
    paint();
    try {
      // Native code chooses the release, filesystem destination, and restart
      // confirmation. The only renderer argument is the explicit preference.
      const next = action === 'setAutomatic' ? await bridge.setAutomatic(value) : await bridge[action]();
      if (active() && revision === eventRevision) accept(next);
    } catch (error) {
      if (active()) {
        localError = error?.message || 'Please try again.';
        if (['checking', 'downloading', 'installing'].includes(state?.status)) state = { ...state, status: stableStatus };
      }
    } finally {
      if (active()) {
        pending = null;
        paint();
        if (hadFocus && [document.body, trigger].includes(document.activeElement)) {
          const target = !trigger.hidden && !trigger.disabled ? trigger
            : [install, download, check].find(control => !control.hidden && !control.disabled);
          if (target?.isConnected) focusQuietly(target);
        }
      }
    }
  }
  automatic.addEventListener('change', () => run('setAutomatic', automatic, automatic.checked === true));
  replace(node, [
    el('h3', { text: 'Updates' }),
    el('p', { class: 'quiet-note', text: 'Zelos can check for updates in the background and notify you. Downloads and restarts need your approval. Checks contact the official releases on GitHub; your email, calendar and AI keys are not included.' }),
    el('div', { class: 'check-row' }, [automatic, el('label', { class: 'check-label', for: preferenceId, text: 'Check for updates automatically' })]),
    el('div', { class: 'row-inline' }, [check, download, install, retry]),
    status, progress, progressText, details,
    el('p', { class: 'quiet-note', text: 'Update and restart asks you to confirm, saves open drafts and a private recovery backup, then installs the update and restarts Zelos. If saving or the backup fails, Zelos stays open.' }),
  ]);
  node.dispose = dispose;
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => { active(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener?.('pagehide', dispose, { once: true });
  try {
    unsubscribe = bridge.onState(next => {
      if (!active()) return;
      eventRevision += 1;
      localError = '';
      accept(next);
    });
    if (disposed && typeof unsubscribe === 'function') unsubscribe();
  } catch (error) { localError = error?.message || 'Update notifications could not be connected.'; }
  void loadState();
  return node;
}

/** A browser check is always user-initiated. */
function manualUpdatesPanel(reason = '') {
  const result = el('div', { class: 'stack' });
  const status = el('p', { class: 'quiet-note', role: 'status', 'aria-live': 'polite' });
  const check = button('Check for updates', {
    class: 'btn quiet',
    onClick: async () => {
      if (check.disabled) return;
      const hadFocus = document.activeElement === check;
      check.disabled = true;
      status.textContent = 'Checking the official Zelos releases…';
      replace(result, []);
      try {
        const release = await request('/api/updates/check', { method: 'POST', body: {} });
        if (release?.demo === true) {
          status.textContent = 'This website demo cannot check an installed copy of Zelos. Visit the download page for released installers.';
          return;
        }
        status.textContent = release.updateAvailable
          ? `Zelos ${release.latestVersion} is available. You have ${release.currentVersion}.`
          : release.ahead ? `You have ${release.currentVersion}, newer than the latest public release (${release.latestVersion}).`
            : `You have the latest release: Zelos ${release.currentVersion}.`;
        const official = officialReleaseUrl(release);
        if (!official) throw new Error('The release link could not be verified.');
        const notes = typeof release.notes === 'string' ? release.notes : '';
        replace(result, [
          el('a', { class: 'btn quiet', href: official, target: '_blank', rel: 'noopener noreferrer', text: 'Release notes and downloads' }),
          release.updateAvailable ? el('p', { class: 'quiet-note', text: 'Back up your data, then quit Zelos before replacing the app. Your existing data folder stays in place.' }) : null,
          notes ? el('details', {}, [el('summary', { text: 'What is in this release' }), el('pre', { class: 'code', style: { 'white-space': 'pre-wrap' }, text: notes })]) : null,
        ]);
      } catch (err) {
        status.textContent = `Could not check for updates. ${err.message}`;
      } finally {
        check.disabled = false;
        if (hadFocus && check.isConnected && [document.body, check].includes(document.activeElement)) focusQuietly(check);
      }
    },
  });
  return el('div', { class: 'stack update-panel' }, [
    el('h3', { text: 'Updates' }),
    reason ? el('p', { class: 'quiet-note', text: reason }) : null,
    el('p', { class: 'quiet-note', text: 'Checks GitHub only when you press the button. Your email, calendar and AI keys are not included.' }),
    el('div', { class: 'row-inline' }, check), status, result,
  ]);
}
