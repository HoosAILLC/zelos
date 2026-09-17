// Keep the data-safety transaction independent of Electron and the downloader.
export function updateInstallation({ getCore, getWindow, dialogs, flush, appVersion,
  backupPath, capture = () => {}, canStart = () => true, setBusy = () => {},
  markStopped = () => {}, reopen = async () => {},
}) {
  let active = false, stopped = false, recovering = false;
  async function recover() {
    if (!stopped || recovering) return;
    recovering = true;
    try {
      await dialogs.showMessageBox({ type: 'warning', buttons: ['Reopen Zelos'], defaultId: 0,
        message: 'The update could not finish',
        detail: 'Your data and recovery backup are safe. Zelos will reopen so you can continue using it and try again later.' });
    } finally { await reopen(); }
  }
  async function prepare(state) {
    if (active || stopped || !canStart()) throw new Error('Finish the current operation before updating.');
    const core = getCore(), win = getWindow();
    if (!core || core.closed || !win || win.isDestroyed()) throw new Error('Zelos is not ready to update.');
    active = true; setBusy(true);
    try {
      const choice = await dialogs.showMessageBox(win, { type: 'question', title: 'Update Zelos',
        message: `Update to Zelos ${state.latestVersion} and restart?`,
        detail: 'Zelos will save your drafts and make a private recovery backup before closing. Your data and settings stay in place. Close any other Zelos or connected AI clients first.',
        buttons: ['Not now', 'Update and restart'], defaultId: 0, cancelId: 0, noLink: true });
      if (choice.response !== 1) return false;
      win.setEnabled?.(false);
      await flush(win.webContents);
      await core.createBackup(await backupPath(core), { appVersion });
      capture();
      await core.stop();
      if (!core.closed) throw new Error('The data store did not close.');
      stopped = true;
      markStopped();
      return true;
    } catch (error) {
      if (core.closed) { stopped = true; markStopped(); await recover(); }
      throw error;
    } finally {
      active = false;
      if (!stopped) { setBusy(false); if (!win.isDestroyed()) win.setEnabled?.(true); }
    }
  }
  return { prepare, recover };
}
