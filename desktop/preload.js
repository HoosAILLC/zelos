/**
 * desktop/preload.js — the entire bridge between the shell and the page.
 *
 * It exposes app identity, fixed data-folder and backup actions, and a bounded
 * update API. Update actions carry no paths or URLs; only the automatic-check
 * preference accepts a boolean. Its one subscription strips the Electron event
 * and delivers public update state. Native dialogs select every backup path
 * and confirm replacement; paths and secret bytes never cross this bridge.
 * The board is an ordinary web page that talks
 * to 127.0.0.1 over fetch; it needs almost nothing from the main process, so
 * it is given almost nothing — no `require`, no open IPC channel, no file
 * access, no "just one more helper". The tray's Sweep now runs inside the
 * main process against the same sweep supervisor the HTTP API uses, so even
 * that needs no channel back into the page.
 *
 * `showHome` exists because Settings → Your data tells a person to erase
 * everything by dragging the folder to the Trash, and a sentence that says
 * "this folder" has to be able to show it. It carries no argument — the
 * shell reveals its own data home and nothing the page names — and hands
 * back only whether it did. The channel name is a fixed string on both
 * sides; test/desktop.test.mjs checks the two spellings agree.
 *
 * `window.zelos` also exists so the page can tell it is inside the shell
 * rather than a browser tab (the two differ in, for instance, whether telling
 * someone to "open this URL in your browser" makes any sense). Nothing in
 * `ui/` requires it — the same page has to keep working when it is opened
 * from `zelos` on the command line, where no preload runs at all, and where
 * Settings offers "Copy the folder path" instead.
 *
 * CommonJS on purpose. This preload runs sandboxed, which means Electron's
 * sandbox loader executes it — not Node's ESM resolver — so the package's
 * `"type": "module"` does not reach it, and an ESM preload would require
 * turning the sandbox off. If this file ever fails to run, the board still
 * loads and still works; that is deliberate, and it is why nothing depends on
 * what it exposes.
 */

const { contextBridge, ipcRenderer } = require('electron');

const SHOW_HOME_CHANNEL = 'zelos:show-home';

try {
  contextBridge.exposeInMainWorld(
    'zelos',
    Object.freeze({
      desktop: true,
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      showHome: () => ipcRenderer.invoke(SHOW_HOME_CHANNEL).then((shown) => shown === true, () => false),
      createBackup: () => ipcRenderer.invoke('zelos:create-backup').catch(() => ({ ok: false, error: 'The backup could not finish. Please try again.' })),
      restoreBackup: () => ipcRenderer.invoke('zelos:restore-backup').catch(() => ({ ok: false, error: 'The restore could not finish. Please try again.' })),
      updates: Object.freeze({
        getState: () => ipcRenderer.invoke('zelos:updates-state'),
        check: () => ipcRenderer.invoke('zelos:updates-check'),
        download: () => ipcRenderer.invoke('zelos:updates-download'),
        install: () => ipcRenderer.invoke('zelos:updates-install'),
        setAutomatic: value => typeof value === 'boolean' ? ipcRenderer.invoke('zelos:updates-automatic', value) : Promise.reject(new TypeError('Expected a boolean update preference.')),
        onState: callback => {
          if (typeof callback !== 'function') return () => {};
          const listener = (_event, state) => callback(state);
          ipcRenderer.on('zelos:updates-changed', listener);
          return () => ipcRenderer.removeListener('zelos:updates-changed', listener);
        },
      }),
    }),
  );
} catch (err) {
  // contextBridge throws if context isolation is ever turned off. The page is
  // more important than the flag, so log and carry on.
  console.error('zelos preload: could not expose window.zelos —', err.message);
}
