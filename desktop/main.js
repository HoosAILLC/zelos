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
 *     off, sandbox on, `<webview>` off, and a preload that exposes four strings
 *     and one function — "show the Zelos folder", answered only for the
 *     board's own window and carrying nothing the page chose.
 *   - The session cancels every outbound request that is not the board itself —
 *     on every scheme Chromium will put on the network, WebSockets included,
 *     and not only the http(s) a scheme wildcard would have shown it — and
 *     denies every permission but the one the Owed view's copy buttons use.
 *     Spellcheck is off because Chromium fetches its dictionaries from Google,
 *     and this app does not talk to anyone the user did not configure.
 *   - Nothing here assumes it succeeded. There may be no tray icon, so closing
 *     the window may have nowhere to hide to; the renderer may die repeatedly,
 *     so a reload is rationed rather than automatic; and another Zelos may
 *     already hold the data home, which the shell reports instead of quietly
 *     becoming the second scheduler sweeping one database.
 *
 * `ready` is exported so the shell can be booted and inspected without a
 * packaged build; it resolves rather than rejects, because a shell that throws
 * on start would leave the user with no window and no message.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell,
} from 'electron';

import { classifyTarget, guardWebContents } from './guard.js';
import { buildAppMenuTemplate, buildTrayMenuTemplate, VIEWS } from './menus.js';
import { startCore } from './runtime.js';
import { clampToDisplays, WindowState } from './window-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where `core/`, `ui/` and `assets/` live. In development they are one level up
 * from this file. In a build they are copied into `Contents/Resources` (see
 * `extraResources` in package.json) — outside the asar, so the core is loaded
 * by the plain ESM loader from plain files, exactly as it is in development.
 */
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(HERE, '..');

const APP_NAME = 'Zelos';

/**
 * The commit this build was cut from, read off the package.json beside this
 * file. CI writes it there at packaging time (`-c.extraMetadata.commit=` in
 * .github/workflows/desktop.yml), because three builds that all said
 * "Zelos 1.0.0" in About and shared a filename were three builds nobody could
 * tell apart — and the one the operator ran for a day predated every fix.
 * A source checkout carries no stamp and a build made by hand may not either;
 * that reads as the plain version, never as an error, so the shell starts the
 * same way with or without it. Anything that is not a sha is treated as no
 * stamp rather than shown.
 */
export function readBuildCommit(dir) {
  try {
    const { commit } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof commit === 'string' && /^[0-9a-f]{7,40}$/i.test(commit.trim()) ? commit.trim() : '';
  } catch {
    return '';
  }
}

/**
 * "1.1.0 (a1b2c3d)" when stamped, "1.1.0" when not. CI stamps the whole sha —
 * a short one that happens to be all digits is a number by the time
 * electron-builder's argument parser has seen it — and seven characters is
 * what a person holds up against `git log`.
 */
export function versionLabel(version, commit = '') {
  return commit ? `${version} (${commit.slice(0, 7)})` : String(version);
}

const BUILD_COMMIT = readBuildCommit(HERE);

/** ui/app.css: marble ground and black-figure ground. Kills the white flash. */
const GROUND = { light: '#F4EFE6', dark: '#12100E' };
/** The one permission the board needs: the Owed view copies drafts. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * How long a renderer crash is remembered, and how long the shell waits before
 * each restart. A renderer that dies once is a glitch and reloading it instantly
 * is the right answer; one that dies on every load is a bug, and the fourth
 * silent reload inside a minute only hides the message. Three attempts, then a
 * dialog that says what happened and where to look.
 */
const CRASH_WINDOW_MS = 60_000;
const CRASH_RELOAD_DELAYS_MS = Object.freeze([0, 750, 3_000]);

let zelos = null;      // the running core (runtime.js handle)
let mainWindow = null;
let tray = null;
let actions = null;
let windowState = null;
let quitting = false;
let shuttingDown = null;
let crashes = [];      // timestamps of recent render-process-gone events
let crashTimer = null;

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
 * macOS: always — an app there outlives its windows, quitting is ⌘Q, and the
 * dock icon is the way back in whether or not a tray icon was ever created.
 * Windows: when Zelos sweeps on a schedule and a tray icon was made. There a
 * `Tray` is a `Shell_NotifyIcon` that the shell itself owns; it may end up in
 * the overflow flyout, but it exists and it can be clicked.
 *
 * Linux is the one this function is careful about, and the reason it takes a
 * fourth argument. A `Tray` there is a StatusNotifierItem published on the
 * session bus, and publishing succeeds whether or not anything is watching:
 * GNOME without an AppIndicator extension, a bare tiling WM, a session where
 * the panel died — `new Tray()` returns an object in every one of them and
 * throws in none. So `tray !== null` is not evidence that a tray exists, and
 * treating it as evidence is what once hid the window into nowhere, leaving an
 * app with no window, no icon and no way back short of killing it. Nothing
 * Electron exposes can prove the icon is on screen, so the honest answer is
 * that on Linux this cannot be detected: closing the window closes the app
 * unless the person running it has said out loud that their tray works, with
 * `ZELOS_TRAY_RESIDENT=1`. Losing a background sweep is recoverable in one
 * click; losing the way back into the app is not.
 */
export function shouldStayResidentOnClose({
  platform = process.platform, hasTray = false, autoSweep = false, trayConfirmed = false,
} = {}) {
  if (platform === 'darwin') return true;
  if (!hasTray || autoSweep !== true) return false;
  if (platform === 'linux') return trayConfirmed === true;
  return true;
}

function staysResidentOnClose() {
  return shouldStayResidentOnClose({
    platform: process.platform,
    hasTray: tray !== null,
    autoSweep: currentConfig()?.sweep?.auto === true,
    trayConfirmed: process.env.ZELOS_TRAY_RESIDENT === '1',
  });
}

/**
 * What to do about a renderer that just died, given when the previous ones did.
 * Pure, and exported, because the interesting case — the fourth crash in a
 * minute — is one nobody wants to reproduce by hand.
 */
export function planRendererRestart(history = [], now = Date.now()) {
  const recent = history.filter((at) => Number.isFinite(at) && now - at < CRASH_WINDOW_MS);
  const attempt = recent.length; // this crash included; the caller records it first
  if (attempt < 1 || attempt > CRASH_RELOAD_DELAYS_MS.length) {
    return { action: 'explain', attempt, delayMs: 0 };
  }
  return { action: 'reload', attempt, delayMs: CRASH_RELOAD_DELAYS_MS[attempt - 1] };
}

/**
 * The count of things asking for something now, on the dock or taskbar icon.
 *
 * `setBadgeCount` is macOS and Linux-with-Unity; Windows has no equivalent that
 * does not involve shipping a second icon, and a platform without a badge is
 * not a failure — the board still says the same number. So this degrades to
 * nothing, quietly, everywhere it is not supported.
 */
function setBadge(count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  try {
    if (typeof app.setBadgeCount === 'function') app.setBadgeCount(n);
    else if (process.platform === 'darwin' && typeof app.dock?.setBadge === 'function') {
      app.dock.setBadge(n > 0 ? String(n) : '');
    }
  } catch (err) {
    zelos?.logger.info('desktop: this desktop has no badge to set', { error: err.message });
  }
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

  // Looking at the board is what "I have seen these" means, so the badge is
  // cleared by the window coming forward and not by any button in it.
  win.on('focus', () => setBadge(0));
  win.on('show', () => setBadge(0));

  win.on('close', (event) => {
    if (quitting || !staysResidentOnClose()) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { mainWindow = null; });

  /* There is deliberately no "the load finished, so forget the crashes" hook
     here. It reads as common sense and it is a trap: the commonest repeating
     crash — a renderer running out of memory on a very long board — happens
     AFTER a load finishes, so clearing the record there resets the attempt
     count on every lap and the reload loop runs forever at zero delay, which is
     the exact outcome the counter exists to stop. Unrelated crashes hours apart
     are already handled, by the sliding CRASH_WINDOW_MS filter below: a crash
     older than a minute is not counted at all. */

  // A renderer that died takes the board with it; reloading the URL we hold
  // brings it back with its token, which a plain reload would not. But a crash
  // that repeats is a crash that will repeat, and an unconditional reload turns
  // it into a loop the user watches forever without ever being told anything.
  win.webContents.on('render-process-gone', (_event, details) => {
    zelos?.logger.error('desktop: the board renderer stopped', { reason: details?.reason });
    if (quitting || win.isDestroyed()) return;

    const now = Date.now();
    crashes = [...crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const plan = planRendererRestart(crashes, now);

    // At most one restart is ever pending. A crash that arrives while the last
    // one is still waiting supersedes it — two timers would reload twice for a
    // window that only died once, which is the loop this exists to prevent.
    if (crashTimer) {
      clearTimeout(crashTimer);
      crashTimer = null;
    }

    if (plan.action === 'explain') {
      zelos?.logger.error('desktop: giving up on reloading the board', { attempts: plan.attempt });
      dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} — the board keeps stopping`,
        message: 'The board window has stopped several times in a row.',
        detail: [
          `Zelos reloaded it ${CRASH_RELOAD_DELAYS_MS.length} times and it stopped again each time, so it has`,
          'stopped trying rather than loop.',
          '',
          `The sweeps are still running: ${zelos?.url ?? 'the board'} works in a browser, and the`,
          'tray menu still sweeps.',
          '',
          `Reason given: ${details?.reason ?? 'unknown'}`,
          `Logs: ${zelos?.paths.logsDir ?? ''}`,
          '',
          'Board ▸ Reload board tries again.',
        ].join('\n'),
        buttons: ['OK'],
      });
      return;
    }

    const reload = () => {
      crashTimer = null;
      if (quitting || win.isDestroyed() || !zelos) return;
      win.loadURL(zelos.tokenUrl);
    };
    if (plan.delayMs === 0) {
      reload();
      return;
    }
    crashTimer = setTimeout(reload, plan.delayMs);
    crashTimer.unref?.();
  });

  win.loadURL(zelos.tokenUrl);
  mainWindow = win;
  return win;
}

/**
 * Put a window back on a display that exists, before anyone is shown it.
 *
 * `WindowState.initial()` clamps the remembered rectangle, and for a long time
 * that was the only place it happened — which covers a window that is created
 * and then lives until the app ends. A tray-resident Zelos is not that one:
 * `close` hides the window instead of destroying it (see
 * `shouldStayResidentOnClose` — Windows with a tray, or Linux with
 * `ZELOS_TRAY_RESIDENT=1`), so it can sit hidden for hours holding a rectangle
 * on a monitor that gets unplugged in the meantime. `show()` honours that
 * rectangle exactly, and the board reappears at x:2600 on a machine whose only
 * work area now ends at 1680 — the failure `window-state.js:6-11` exists to
 * prevent, one `show()` away from the clamp that prevents it.
 *
 * macOS is not the platform this is written for: Electron does not set
 * `enableLargerThanScreen`, so AppKit constrains the frame onto a real screen
 * on `makeKeyAndOrderFront:` whether or not anybody asked. There the clamp
 * agrees with what the OS was going to do anyway, which is exactly why nothing
 * is set when the rectangle comes back unchanged — this must not turn into a
 * move event on every ⌘Tab back into an app that was never lost.
 */
function fitToDisplays(win) {
  // A maximised or full-screen window is wearing the OS's rectangle, not ours.
  // Setting bounds under one is how a window nobody asked to restore gets
  // restored, and the size to keep is already saved by WindowState.
  if (win.isMaximized?.() === true || win.isFullScreen?.() === true) return;
  const bounds = win.getNormalBounds?.() ?? win.getBounds?.();
  if (!bounds) return;

  const fitted = clampToDisplays(bounds, screen.getAllDisplays().map((display) => display.workArea));
  if (typeof fitted.x !== 'number') {
    // Nothing that exists overlaps it any more, so there is no corrected
    // position to move to — only a screen to start over on. Same answer
    // `initial()` gives by returning a size with no position and letting the
    // window manager place it.
    zelos?.logger.info('desktop: the window was on a display that is gone; centring it', { bounds });
    win.center?.();
    return;
  }
  if (fitted.x === bounds.x && fitted.y === bounds.y
      && fitted.width === bounds.width && fitted.height === bounds.height) return;
  zelos?.logger.info('desktop: pulled the window back onto a display that exists', { from: bounds, to: fitted });
  win.setBounds?.(fitted);
}

function showWindow() {
  setBadge(0);
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (zelos) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) {
    fitToDisplays(mainWindow); // it may have been hidden on a monitor that left
    mainWindow.show();
  }
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
  // no request leaves this window for anywhere but the board.
  //
  // The pattern is `<all_urls>` and not the `*://*/*` that reads like it means
  // the same thing. It does not: `*` in a match pattern's scheme position is
  // http and https and nothing else, so a `new WebSocket('wss://…')` sailed
  // straight past the layer this comment sells as the one a CSP bypass cannot
  // reach. Measured against the pinned Electron 43.3.0 with five requests on
  // five schemes: `*://*/*` delivered three, `<all_urls>` delivered five, and
  // the two it had been missing were `ws:` and `wss:`. (`file:`, `data:` and
  // `blob:` are not part of that difference — Chromium refuses those in the
  // renderer before they ever become network requests.)
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
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

/**
 * The one request the page can make of the shell: show the Zelos folder.
 *
 * Settings → Your data tells a person to erase everything by dragging the
 * folder to the Trash, and a sentence that says "this folder" has to be able
 * to put it on screen — `rm -rf` in a code block was the previous answer,
 * and the audit's reader would not type it. The channel takes no argument
 * and reveals only the shell's own data home; the page cannot name a path.
 * Answered only for the board's own window, because the preload is attached
 * to that window alone and any other sender is by definition not the board.
 * `showItemInFolder` selects the folder in its parent rather than opening it,
 * which is the view a person drags from.
 */
export const SHOW_HOME_CHANNEL = 'zelos:show-home';

export function showHomeHandler({ getHome, isBoard, reveal }) {
  return (event) => {
    if (!isBoard(event?.sender)) return false;
    const home = getHome();
    if (!home) return false;
    reveal(home);
    return true;
  };
}

function installShowHome() {
  ipcMain.handle(SHOW_HOME_CHANNEL, showHomeHandler({
    getHome: () => zelos?.paths.home ?? '',
    isBoard: (sender) => Boolean(sender) && Boolean(mainWindow) && !mainWindow.isDestroyed() && sender === mainWindow.webContents,
    reveal: (home) => shell.showItemInFolder(home),
  }));
}

function installAppMenu() {
  if (!actions) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({ appName: APP_NAME, actions })));
}

/**
 * The About dialog, as data. Pure so a test can hold what the dialog says up
 * against the build stamp without Electron; `commit` may be empty, see
 * readBuildCommit.
 */
export function aboutText({ version, commit = '', url = null, home = '' }) {
  return {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} ${versionLabel(version, commit)}`,
    detail: [
      'A local-first second brain.',
      '',
      `Board   ${url ?? 'not running'}`,
      `Data    ${home}`,
      '',
      'Listening on 127.0.0.1 only. Nothing leaves this machine except the',
      'calls to the model you chose and to the sources you added.',
    ].join('\n'),
    buttons: ['OK'],
  };
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
    /**
     * The OS's own login-items list is the state; nothing is mirrored into
     * config.json, so the two can never disagree. Reading it is wrapped because
     * the call does not exist on every platform and throws on some of them.
     */
    openAtLogin: () => {
      try {
        return app.getLoginItemSettings?.().openAtLogin === true;
      } catch {
        return false;
      }
    },
    setOpenAtLogin: (want) => {
      const openAtLogin = want === true;
      try {
        // Only `openAtLogin`, and deliberately. This used to pass
        // `openAsHidden` too, under a comment promising that a Zelos launched
        // at login would sweep without putting a window in front of whatever
        // the person sat down to do — a promise nothing here could keep.
        // Electron 43 marks the flag deprecated and does not implement it on
        // macOS 13 and up; it does not exist on Windows, where menus.js offers
        // the same checkbox; and the counterpart it is supposed to set,
        // `getLoginItemSettings().wasOpenedAsHidden`, is read nowhere in this
        // repo, so even where the OS answered true the window would still be
        // created and shown at its full size. An argument that changes nothing
        // is cheap; the sentence above it, which a reader would have believed,
        // is not.
        app.setLoginItemSettings({ openAtLogin });
        zelos?.logger.info('desktop: login item changed', { openAtLogin });
      } catch (err) {
        zelos?.logger.warn('desktop: this platform would not set the login item', { error: err.message });
      }
      // The checkbox's state is read when the template is built, so the menu is
      // rebuilt rather than left showing what it showed a moment ago.
      installAppMenu();
    },

    openDataFolder: () => openLocalPath(zelos.paths.home),
    openLogs: () => openLocalPath(zelos.paths.logsDir),
    openInstallNotes: () => openLocalPath(path.join(ROOT, 'docs', 'INSTALL.md')),
    openSecurityNotes: () => openLocalPath(path.join(ROOT, 'docs', 'SECURITY.md')),
    about: () => {
      dialog.showMessageBox(aboutText({
        version: app.getVersion(),
        commit: BUILD_COMMIT,
        url: zelos?.url,
        home: zelos?.paths.home ?? '',
      }));
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
      if (crashTimer) {
        clearTimeout(crashTimer);
        crashTimer = null;
      }
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
  // This half only ever sees another Electron app — a CLI `zelos` is invisible
  // to it — so the real exclusion is the lock runtime.js takes on the data
  // home. This stays because it is the only one that can raise the window that
  // is already open instead of showing a dialog about it.
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
    // Whatever went wrong, the error's own words come first: it is the only
    // part of this that knows what actually happened. The lines after it are
    // orientation — where the data lives — and nothing is guessed at, because
    // a confident wrong diagnosis sends people looking in the wrong place.
    const detail = [
      booted.error.message,
      '',
      `Zelos keeps its data in ${process.env.ZELOS_HOME || '~/.zelos'}.`,
      ...(booted.error.lockFile ? ['', `The file it was reading is ${booted.error.lockFile}.`] : []),
    ].join('\n');
    dialog.showErrorBox(`${APP_NAME} could not start`, detail);
    app.quit();
    return { ok: false, error: booted.error, holder: null };
  }

  zelos = booted.handle;

  /* A home that looks busy is a warning, never a refusal — the diagnosis reads
     a file on disk and can be wrong, and being wrong must not cost somebody
     their app. So it is put to the person, with the safe choice as the default
     button and the consequence spelled out rather than implied. */
  if (zelos.contested) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: `${APP_NAME} may already be running`,
      message: `${APP_NAME} may already be running`,
      detail: zelos.contested.message,
      buttons: ['Quit', 'Open anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 0) {
      app.quit();
      return { ok: false, error: null, holder: zelos.contested };
    }
  }
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
    });
  });

  if (typeof app.setAboutPanelOptions === 'function') {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: versionLabel(app.getVersion(), BUILD_COMMIT),
      copyright: 'MIT licensed. Local-first: nothing leaves this machine except the model calls you configure and the sources you add.',
    });
  }
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  actions = buildActions();
  installAppMenu();
  createTray(actions);
  createWindow();
  installShowHome();

  // The badge is the only thing a swept-in-the-background Zelos says while its
  // window is shut. It is set when a sweep ends — from the clock or by hand,
  // both come through the same supervisor — and cleared the moment the board is
  // looked at, which is what makes it a count of things not yet seen.
  zelos.onSweep((event) => {
    if (event !== 'done' && event !== 'failed') return;
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      setBadge(0);
      return;
    }
    setBadge(zelos?.attentionCount() ?? 0);
  });

  if (flags.sweepNow) zelos.sweepNow('full');

  zelos.logger.info('desktop: shell ready', {
    url: zelos.url,
    root: ROOT,
    version: versionLabel(app.getVersion(), BUILD_COMMIT),
  });
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
