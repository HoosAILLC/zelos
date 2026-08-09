/**
 * desktop/preload.js — the entire bridge between the shell and the page.
 *
 * It exposes four read-only strings and no capability whatsoever. That is the
 * point. The board is an ordinary web page that talks to 127.0.0.1 over fetch;
 * it needs nothing from the main process, so it is given nothing — no `require`,
 * no IPC channel, no file access, no "just this one helper". The tray's Sweep
 * now runs inside the main process against the same sweep supervisor the HTTP
 * API uses, so even that needs no channel back into the page.
 *
 * `window.zelos` exists only so the page can tell it is inside the shell
 * rather than a browser tab (the two differ in, for instance, whether telling
 * someone to "open this URL in your browser" makes any sense). Nothing in `ui/`
 * requires it — the same page has to keep working when it is opened from
 * `zelos` on the command line, where no preload runs at all.
 *
 * CommonJS on purpose. This preload runs sandboxed, which means Electron's
 * sandbox loader executes it — not Node's ESM resolver — so the package's
 * `"type": "module"` does not reach it, and an ESM preload would require
 * turning the sandbox off. If this file ever fails to run, the board still
 * loads and still works; that is deliberate, and it is why nothing depends on
 * what it exposes.
 */

const { contextBridge } = require('electron');

try {
  contextBridge.exposeInMainWorld(
    'zelos',
    Object.freeze({
      desktop: true,
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }),
  );
} catch (err) {
  // contextBridge throws if context isolation is ever turned off. The page is
  // more important than the flag, so log and carry on.
  console.error('zelos preload: could not expose window.zelos —', err.message);
}
