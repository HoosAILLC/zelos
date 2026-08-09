/**
 * desktop/main.js — the Electron shell.
 *
 * A window, a tray icon, a menu bar, and the Zelos core running in this same
 * process. That last part is the design: `runtime.js` imports `createServer`
 * and calls it here rather than forking `zelos.mjs` as a child, so there is
 * one process, one sqlite handle, one lifecycle, and no pipe between the tray
 * and the thing the tray is driving.
 *
 * What the shell is careful about:
 *
 *   - The window is pointed at the local board and nothing else. `guard.js`
 *     classifies every navigation and every window-open; anything that is not
 *     this server's own origin either goes to the system browser or is refused
 *     outright. Mail is attacker-controlled, and a link in it must never be
 *     able to load inside a window that holds the session token.
 *   - The renderer has no privileges: context isolation on, node integration
 *     off, sandbox on, `<webview>` off, and a preload that exposes four strings.
 *   - The session cancels every outbound request that is not the board itself,
 *     and denies every permission but the one the Owed view's copy buttons use.
 *     Spellcheck is off because Chromium fetches its dictionaries from Google,
 *     and this app does not talk to anyone the user did not configure.
 *
 * `ready` is exported so the shell can be booted and inspected without a
 * packaged build; it resolves rather than rejects, because a shell that throws
 * on start would leave the user with no window and no message.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, screen, session, shell,
} from 'electron';

import { classifyTarget, guardWebContents } from './guard.js';
import { buildAppMenuTemplate, buildTrayMenuTemplate, VIEWS } from './menus.js';
import { startCore } from './runtime.js';
import { WindowState } from './window-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where `core/`, `ui/` and `assets/` live. In development they are one level up
 * from this file. In a build they are copied into `Contents/Resources` (see
 * `extraResources` in package.json) — outside the asar, so the core is loaded
 * by the plain ESM loader from plain files, exactly as it is in development.
 */
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(HERE, '..');

const APP_NAME = 'Zelos';
/** ui/app.css: marble ground and black-figure ground. Kills the white flash. */
const GROUND = { light: '#F4EFE6', dark: '#12100E' };
/** The one permission the board needs: the Owed view copies drafts. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

let zelos = null;      // the running core (runtime.js handle)
let mainWindow = null;
let tray = null;
let windowState = null;
let quitting = false;
let shuttingDown = null;

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

/**
 * The same three flags the CLI has. Unknown arguments are ignored rather than
 * rejected: Chromium adds its own switches, macOS appends `-psn_…` when an app
 * is launched from Finder, and neither is an error.
 */
export function parseShellArgs(argv = []) {
  const flags = { home: null, port: null, sweepNow: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => (inline === null ? argv[++i] ?? '' : inline);

    switch (name) {
      case '--home': {
        // Reject the literal strings "undefined" and "null" alongside the
        // empty value: they are what a wrapper script produces when it
        // interpolates an unset variable into `--home=${dir}`, and passing
        // them through once created a real data directory named `undefined/`.
        const dir = value();
        const junk = dir.trim().toLowerCase();
        if (dir && junk !== 'undefined' && junk !== 'null') flags.home = dir;
        break;
      }
      case '--port': {
        const raw = value();
        // 0 means "any free port" — how the tests avoid colliding with a
        // Zelos the user is actually running. An empty value is not a zero.
        const port = raw === '' ? NaN : Number(raw);
        if (Number.isInteger(port) && port >= 0 && port <= 65535) flags.port = port;
        break;
      }
      case '--sweep-now':
        flags.sweepNow = true;
        break;
      default:
        break;
    }
  }
  return flags;
}

function portFromEnv() {
  const raw = process.env.ZELOS_PORT;
  if (raw === undefined || raw === '') return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

const currentConfig = () => zelos?.server?.zelos?.config ?? zelos?.config ?? null;

/**
 * Whether closing the window should leave Zelos running.
 *
 * macOS: always — an app there outlives its windows, and quitting is ⌘Q.
 * Elsewhere: only when Zelos is set to sweep on a schedule, because that
 * schedule is the only reason a windowless Zelos is any use. With auto-sweep
 * off, closing the window closes the app, which is what a Windows user expects.
 */
function staysResidentOnClose() {
  if (process.platform === 'darwin') return true;
  return currentConfig()?.sweep?.auto === true;
}

function createWindow() {
  windowState = new WindowState({ file: path.join(zelos.paths.home, 'window.json') });
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);

  const win = new BrowserWindow({
    ...windowState.initial(workAreas),
    show: false, // shown on ready-to-show, so the first paint is the board
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light,
    // Linux takes its window icon from the process, not the desktop file.
    ...(process.platform === 'linux' ? { icon: path.join(ROOT, 'assets', 'icon.png') } : {}),
    webPreferences: {
      preload: path.join(HERE, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Chromium downloads hunspell dictionaries from a Google host the first
      // time spellcheck runs. Nothing leaves this machine that the user did not
      // configure, so spellcheck is off.
      spellcheck: false,
    },
  });

  windowState.track(win);
  if (windowState.maximized) win.maximize();
  if (windowState.fullScreen) win.setFullScreen(true);

  win.once('ready-to-show', () => win.show());

  win.on('close', (event) => {
    if (quitting || !staysResidentOnClose()) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { mainWindow = null; });

  // A renderer that died takes the board with it; reloading the URL we hold
  // brings it back with its token, which a plain reload would not.
  win.webContents.on('render-process-gone', (_event, details) => {
    zelos?.logger.error('desktop: the board renderer stopped', { reason: details?.reason });
    if (!quitting && !win.isDestroyed()) win.loadURL(zelos.tokenUrl);
  });

  win.loadURL(zelos.tokenUrl);
  mainWindow = win;
  return win;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (zelos) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * Switch the board to one of its views. The id is checked against a fixed list
 * before it is put in a string — nothing here is ever derived from a message, a
 * calendar event or model output, and the allowlist is what makes that provable
 * at a glance.
 */
function showView(id) {
  if (!VIEWS.some((view) => view.id === id)) return;
  showWindow();
  mainWindow?.webContents
    .executeJavaScript(`window.location.hash = ${JSON.stringify(`#/${id}`)};`)
    .catch((err) => zelos?.logger.warn('desktop: could not switch view', { view: id, error: err.message }));
}

/* ------------------------------------------------------------------ *
 * Session hardening
 * ------------------------------------------------------------------ */

function hardenSession(ses) {
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    if (!granted) zelos?.logger.warn('desktop: denied a permission request', { permission });
    callback(granted);
  });
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));

  // The renderer's CSP already says `default-src 'self'`. This is the same rule
  // enforced a second time, one layer down, where a CSP bypass would not reach:
  // no http(s) request leaves this window for anywhere but the board.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const verdict = classifyTarget(details.url, { port: zelos?.port ?? 0 });
    if (verdict.action !== 'internal') {
      zelos?.logger.warn('desktop: cancelled an outbound request from the board', { url: verdict.url });
    }
    callback({ cancel: verdict.action !== 'internal' });
  });
}

/* ------------------------------------------------------------------ *
 * Tray and menus
 * ------------------------------------------------------------------ */

function trayImage() {
  // macOS wants a monochrome mask it can invert with the menu bar; everyone
  // else wants the coloured mark. Electron picks up the @2x file on its own.
  const file = path.join(HERE, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
  const image = nativeImage.createFromPath(file);
  if (process.platform === 'darwin' && !image.isEmpty()) image.setTemplateImage(true);
  return image;
}

function createTray(actions) {
  try {
    const image = trayImage();
    if (image.isEmpty()) throw new Error(`tray icon missing or unreadable`);
    tray = new Tray(image);
    tray.setToolTip(`${APP_NAME} — ${zelos.url}`);
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({ actions })));
    // On Windows and Linux a left click is how people expect to reopen a
    // tray app; on macOS a click opens the menu, so this is not wired there.
    if (process.platform !== 'darwin') tray.on('click', () => actions.openBoard());
  } catch (err) {
    tray = null;
    zelos?.logger.warn('desktop: no tray icon; use the window and the menu bar', { error: err.message });
  }
  return tray;
}

function openLocalPath(target) {
  shell.openPath(target).then((problem) => {
    if (problem) zelos?.logger.warn('desktop: could not open a local path', { target, problem });
  });
}

function buildActions() {
  return {
    sweepNow: () => {
      // A person asking for a sweep by hand means the full thing — sources
      // re-fetched and the model consulted — which is what --sweep-now does too.
      zelos?.sweepNow('full');
      showWindow();
    },
    openBoard: () => showWindow(),
    showView,
    reloadBoard: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(zelos.tokenUrl);
    },
    openDataFolder: () => openLocalPath(zelos.paths.home),
    openLogs: () => openLocalPath(zelos.paths.logsDir),
    openInstallNotes: () => openLocalPath(path.join(ROOT, 'docs', 'INSTALL.md')),
    openSecurityNotes: () => openLocalPath(path.join(ROOT, 'docs', 'SECURITY.md')),
    about: () => {
      dialog.showMessageBox({
        type: 'info',
        title: `About ${APP_NAME}`,
        message: `${APP_NAME} ${app.getVersion()}`,
        detail: [
          'A local-first second brain.',
          '',
          `Board   ${zelos?.url ?? 'not running'}`,
          `Data    ${zelos?.paths.home ?? ''}`,
          '',
          'Listening on 127.0.0.1 only. Nothing leaves this machine except the',
          'calls to the model you chose.',
        ].join('\n'),
        buttons: ['OK'],
      });
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Shutdown
 * ------------------------------------------------------------------ */

function beginShutdown() {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    try {
      windowState?.capture();
      await zelos?.stop();
    } catch {
      // Quitting is not allowed to fail; whatever did not close is about to
      // stop existing anyway.
    } finally {
      zelos = null;
      app.quit();
    }
  })();
  return shuttingDown;
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function bootstrap() {
  // One Zelos per machine: two would fight over the same database and the
  // second would bind a different port, so the URL in the banner would be a lie.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { ok: false, reason: 'another copy of Zelos is already running' };
  }

  app.setName(APP_NAME);
  app.on('second-instance', () => showWindow());

  // A page must never be able to raise an HTTP-auth or proxy prompt.
  app.on('login', (event) => event.preventDefault());

  app.on('activate', () => showWindow());

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return; // macOS apps outlive their windows
    if (staysResidentOnClose()) return;        // the schedule is still running in the tray
    app.quit();
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', (event) => {
    if (shuttingDown) return; // second pass: everything is closed, let it go
    event.preventDefault();
    beginShutdown();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { quitting = true; app.quit(); });
  }

  // whenReady() is called before the first await so its listener is attached
  // while the ready event is still ahead of us; the core boots alongside it
  // rather than after it, because none of that work needs Chromium.
  const ready = app.whenReady();
  const flags = parseShellArgs(process.argv.slice(1));
  const booting = startCore({
    root: ROOT,
    home: flags.home,
    port: flags.port ?? portFromEnv(),
  }).then((handle) => ({ handle }), (error) => ({ error }));

  await ready;
  const booted = await booting;

  if (booted.error) {
    const detail = [
      booted.error.message,
      '',
      `Zelos keeps its data in ${process.env.ZELOS_HOME || '~/.zelos'}.`,
      'If another copy is already running, quit that one first.',
    ].join('\n');
    dialog.showErrorBox(`${APP_NAME} could not start`, detail);
    app.quit();
    return { ok: false, error: booted.error };
  }

  zelos = booted.handle;
  hardenSession(session.defaultSession);

  // Every webContents, not just the first window: a guard that only covers the
  // window you remembered to guard is not a guard. Registered here, after the
  // core is up, so it has the real port and the real logger from the start —
  // nothing has created a webContents before this line.
  const logger = zelos.logger;
  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents, {
      // Read at event time, not captured: after shutdown there is no port, and
      // "no port" means nothing counts as internal.
      getPort: () => zelos?.port ?? 0,
      openExternal: (url) => shell.openExternal(url),
      logger,
      onInternalPopup: (url) => mainWindow?.loadURL(url),
    });
  });

  if (typeof app.setAboutPanelOptions === 'function') {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: 'MIT licensed. Local-first: nothing leaves this machine except the model calls you configure.',
    });
  }
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  const actions = buildActions();
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({ appName: APP_NAME, actions })));
  createTray(actions);
  createWindow();

  if (flags.sweepNow) zelos.sweepNow('full');

  zelos.logger.info('desktop: shell ready', { url: zelos.url, root: ROOT });
  return { ok: true, zelos, window: mainWindow, tray, actions, flags };
}

/**
 * Kicked off at import, which is how an Electron main script runs. The promise
 * is exported — and resolves on failure rather than rejecting — so a test can
 * boot the shell against a stub Electron and inspect what it built.
 */
export const ready = bootstrap();

/** Exported for the same reason: a test has to be able to put it back down. */
export function shutdown() {
  return beginShutdown();
}
