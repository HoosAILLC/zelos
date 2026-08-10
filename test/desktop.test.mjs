/**
 * test/desktop.test.mjs — the Electron shell.
 *
 * Electron itself is not installed (and installing it is not this project's
 * idea of a dependency-free core), so the shell is booted against a stub
 * `electron` module supplied through Node's own module-customisation hooks.
 * That is not a mock of the shell — `desktop/main.js` runs for real, boots the
 * real core in-process, binds a real socket, and builds the real window
 * options, tray menu and navigation guards. Only Chromium is missing.
 *
 * Everything here runs against a temp ZELOS_HOME on an OS-chosen port, so it
 * can never touch the user's own Zelos or collide with one that is running.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyTarget, guardWebContents } from '../desktop/guard.js';
import { clampToDisplays, DEFAULT_BOUNDS, MIN_SIZE, WindowState } from '../desktop/window-state.js';
import { buildAppMenuTemplate, buildTrayMenuTemplate, supportsLoginItem, VIEWS } from '../desktop/menus.js';
import { acquireHomeLock, holdHome, lockHolderState, readHomeLock, startCore } from '../desktop/runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ *
 * guard.js
 * ------------------------------------------------------------------ */

describe('classifyTarget', () => {
  const port = 7777;

  it('calls the board itself internal, on every loopback spelling', () => {
    for (const url of [
      'http://127.0.0.1:7777/',
      'http://127.0.0.1:7777/?t=abc#/now',
      'http://localhost:7777/app.css',
      'http://[::1]:7777/api/state',
    ]) {
      assert.equal(classifyTarget(url, { port }).action, 'internal', url);
    }
  });

  it('sends ordinary web and mail links to the system browser', () => {
    for (const url of ['https://example.com/a', 'http://example.com/', 'mailto:someone@example.com?subject=hi']) {
      assert.equal(classifyTarget(url, { port }).action, 'external', url);
    }
  });

  it('blocks every scheme that could reach this machine', () => {
    for (const url of [
      'file:///etc/passwd',
      'file://' + path.join(REPO, 'core', 'config.mjs'),
      'javascript:fetch("/api/state")',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'blob:http://127.0.0.1:7777/9f',
      'about:blank',
      'chrome://settings',
      'ms-msdt:/id PCWDiagnostic',
      'zoommtg://zoom.us/join?confno=1',
      'not a url at all',
      '',
    ]) {
      assert.equal(classifyTarget(url, { port }).action, 'block', url);
    }
  });

  it('treats another port on this machine as external, not as itself', () => {
    // Ollama on 11434 is still somebody else's server.
    assert.equal(classifyTarget('http://127.0.0.1:11434/v1/models', { port }).action, 'external');
    assert.equal(classifyTarget('http://127.0.0.1/', { port }).action, 'external'); // port 80
  });

  it('fails closed when the server has no port yet', () => {
    for (const noPort of [{}, { port: 0 }, { port: null }, { port: NaN }]) {
      assert.equal(classifyTarget('http://127.0.0.1:7777/', noPort).action, 'external');
    }
  });
});

describe('guardWebContents', () => {
  function harness({ port = 7777 } = {}) {
    const opened = [];
    const warned = [];
    const popups = [];
    const handlers = new Map();
    const contents = {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) || []), handler]);
      },
      setWindowOpenHandler(handler) { contents.windowOpen = handler; },
      windowOpen: null,
    };
    guardWebContents(contents, {
      getPort: () => port,
      openExternal: (url) => opened.push(url),
      logger: { info() {}, warn: (msg, meta) => warned.push(meta?.url ?? msg) },
      onInternalPopup: (url) => popups.push(url),
    });
    const navigate = (url) => {
      let prevented = false;
      const event = { preventDefault: () => { prevented = true; } };
      for (const handler of handlers.get('will-navigate')) handler(event, url);
      return prevented;
    };
    return { contents, opened, warned, popups, navigate, handlers };
  }

  it('lets the board navigate itself and nothing else', () => {
    const h = harness();
    assert.equal(h.navigate('http://127.0.0.1:7777/#/today'), false);
    assert.equal(h.opened.length, 0);

    assert.equal(h.navigate('https://evil.example/steal'), true);
    assert.deepEqual(h.opened, ['https://evil.example/steal']);

    assert.equal(h.navigate('file:///etc/passwd'), true);
    assert.deepEqual(h.opened, ['https://evil.example/steal']); // still just the one
    assert.deepEqual(h.warned, ['file:///etc/passwd']);
  });

  it('guards redirects too, not just clicks', () => {
    const h = harness();
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    for (const handler of h.handlers.get('will-redirect')) handler(event, 'https://elsewhere.example/');
    assert.equal(prevented, true);
    assert.deepEqual(h.opened, ['https://elsewhere.example/']);
  });

  it('never opens a second window, and hands external popups to the browser', () => {
    const h = harness();
    assert.deepEqual(h.contents.windowOpen({ url: 'https://example.com/docs' }), { action: 'deny' });
    assert.deepEqual(h.opened, ['https://example.com/docs']);

    assert.deepEqual(h.contents.windowOpen({ url: 'http://127.0.0.1:7777/#/ask' }), { action: 'deny' });
    assert.deepEqual(h.popups, ['http://127.0.0.1:7777/#/ask']);

    assert.deepEqual(h.contents.windowOpen({ url: 'file:///etc/hosts' }), { action: 'deny' });
    assert.equal(h.opened.length, 1);
  });

  it('refuses a webview', () => {
    const h = harness();
    let prevented = false;
    for (const handler of h.handlers.get('will-attach-webview')) {
      handler({ preventDefault: () => { prevented = true; } });
    }
    assert.equal(prevented, true);
  });
});

/* ------------------------------------------------------------------ *
 * window-state.js
 * ------------------------------------------------------------------ */

describe('clampToDisplays', () => {
  const laptop = { x: 0, y: 0, width: 1680, height: 1020 };
  const secondary = { x: 1680, y: -200, width: 2560, height: 1440 };

  it('keeps a rectangle that is where it says it is', () => {
    const fitted = clampToDisplays({ x: 100, y: 80, width: 1200, height: 800 }, [laptop, secondary]);
    assert.deepEqual(fitted, { x: 100, y: 80, width: 1200, height: 800 });
  });

  it('drops the position when the monitor it was on has gone', () => {
    const fitted = clampToDisplays({ x: 2400, y: 300, width: 1200, height: 800 }, [laptop]);
    assert.deepEqual(fitted, { width: 1200, height: 800 });
  });

  it('keeps a window on the second monitor when there is one', () => {
    const fitted = clampToDisplays({ x: 2400, y: 300, width: 1200, height: 800 }, [laptop, secondary]);
    assert.equal(fitted.x, 2400);
    assert.equal(fitted.y, 300);
  });

  it('puts a straddling window on the display it is mostly on', () => {
    // 280px of this window is on the laptop and 920px is on the second monitor.
    // Taking the first work area that overlapped at all put it back on the
    // laptop — so a window dragged over a boundary teleported to whichever
    // display the OS listed first, which is not the one it was on.
    const fitted = clampToDisplays({ x: 1400, y: 100, width: 1200, height: 800 }, [laptop, secondary]);
    assert.deepEqual(fitted, { x: 1680, y: 100, width: 1200, height: 800 });

    // And the same answer whichever order the displays arrive in.
    assert.deepEqual(
      clampToDisplays({ x: 1400, y: 100, width: 1200, height: 800 }, [secondary, laptop]),
      fitted,
    );
  });

  it('pulls a mostly-offscreen window back on', () => {
    // A corner still on the display: enough to count as visible, not enough to
    // leave where it is.
    const fitted = clampToDisplays({ x: 1500, y: 960, width: 1200, height: 800 }, [laptop]);
    assert.deepEqual(fitted, { x: 480, y: 220, width: 1200, height: 800 });
  });

  it('gives up on a position that barely clips the screen', () => {
    // 80px of overlap is a window you cannot grab; the size survives, the
    // position does not.
    assert.deepEqual(clampToDisplays({ x: 1600, y: 990, width: 1200, height: 800 }, [laptop]), {
      width: 1200, height: 800,
    });
  });

  it('never returns a window too small to use, or bigger than the screen', () => {
    const tiny = clampToDisplays({ x: 10, y: 10, width: 40, height: 10 }, [laptop]);
    assert.equal(tiny.width, MIN_SIZE.width);
    assert.equal(tiny.height, MIN_SIZE.height);

    const huge = clampToDisplays({ x: 0, y: 0, width: 9000, height: 9000 }, [laptop]);
    assert.deepEqual({ width: huge.width, height: huge.height }, { width: laptop.width, height: laptop.height });
  });

  it('falls back to the default size when there is nothing remembered', () => {
    assert.deepEqual(clampToDisplays(null, [laptop]), { ...DEFAULT_BOUNDS });
    assert.deepEqual(clampToDisplays({ width: 1200, height: 800 }, []), { width: 1200, height: 800 });
  });
});

describe('WindowState', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-winstate-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('starts from the defaults and writes what it captured', () => {
    const file = path.join(dir, 'window.json');
    const state = new WindowState({ file });
    assert.deepEqual(state.initial([]), { ...DEFAULT_BOUNDS, minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height });

    state.track(fakeWindow({ x: 42, y: 24, width: 1000, height: 700 }));
    state.capture();

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.bounds, { x: 42, y: 24, width: 1000, height: 700 });
    assert.equal(written.maximized, false);

    // A fresh instance reads it back.
    assert.equal(new WindowState({ file }).initial([]).width, 1000);
  });

  /**
   * The mode is a separate test because it is the one part of the promise that
   * only two of the three platforms can keep, and a skip with a name in the
   * output is honest where an `if` buried in an assertion is not.
   *
   * A window rectangle is not a secret, but this file lives in the Zelos home
   * beside the mail database, and everything Zelos writes there is 0600 — one
   * file written 0644 is the one a later `cp -p` or synced folder carries out
   * wide open. On Windows that promise is not available to make: there are no
   * POSIX modes, `fs.chmod` sets little beyond the read-only flag, and the mode
   * `statSync` reports back is a synthesised 0666 no matter what the writer
   * asked for. What protects the file there is the ACL on the user's profile
   * directory, which is what docs/SECURITY.md says on Windows — so this asserts
   * nothing there rather than asserting something weaker and calling it a pass.
   */
  it('writes it 0600, like everything else in the Zelos home', {
    skip: process.platform === 'win32'
      ? 'Windows has no POSIX file modes: fs.chmod sets little more than the read-only flag and fs.stat reports a synthesised 0666, so a 0600 request is unobservable. At-rest protection on Windows is the profile-directory ACL (see docs/SECURITY.md), which this test cannot speak to.'
      : false,
  }, () => {
    const file = path.join(dir, 'mode.json');
    new WindowState({ file }).track(fakeWindow({ x: 1, y: 2, width: 900, height: 600 })).capture();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('remembers the restored size of a maximised window, not the screen', () => {
    const file = path.join(dir, 'maximised.json');
    const win = fakeWindow({ x: 8, y: 8, width: 1100, height: 760 });
    win.maximized = true;
    win.screenBounds = { x: 0, y: 0, width: 1680, height: 1020 };
    const state = new WindowState({ file });
    state.track(win).capture();

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.maximized, true);
    assert.deepEqual(written.bounds, { x: 8, y: 8, width: 1100, height: 760 });
  });

  it('survives a corrupt file rather than refusing to open a window', () => {
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, '{"bounds": {"width": 12');
    assert.equal(new WindowState({ file }).initial([]).width, DEFAULT_BOUNDS.width);
  });

  function fakeWindow(bounds) {
    return {
      maximized: false,
      screenBounds: null,
      on() { return this; },
      isDestroyed: () => false,
      isMaximized() { return this.maximized; },
      isFullScreen: () => false,
      getNormalBounds: () => bounds,
      getBounds() { return this.screenBounds || bounds; },
    };
  }
});

/* ------------------------------------------------------------------ *
 * menus.js
 * ------------------------------------------------------------------ */

describe('menus', () => {
  const labels = (template) => template.map((item) => item.label ?? item.role ?? item.type);

  it('gives the tray exactly Sweep now, Open Zelos and Quit', () => {
    const fired = [];
    const template = buildTrayMenuTemplate({
      actions: { sweepNow: () => fired.push('sweep'), openBoard: () => fired.push('open'), quit: () => fired.push('quit') },
    });
    assert.deepEqual(labels(template), ['Sweep now', 'Open Zelos', 'separator', 'Quit Zelos']);
    for (const item of template) item.click?.();
    assert.deepEqual(fired, ['sweep', 'open', 'quit']);
  });

  it('builds a macOS menu with the app menu first and a working Edit menu', () => {
    const template = buildAppMenuTemplate({ platform: 'darwin', appName: 'Zelos', actions: {} });
    assert.equal(template[0].label, 'Zelos');
    const edit = template.find((menu) => menu.label === 'Edit');
    for (const role of ['undo', 'cut', 'copy', 'paste', 'selectAll']) {
      assert.ok(edit.submenu.some((item) => item.role === role), `Edit is missing ${role}`);
    }
    // ⌘Q lives in the app menu on macOS and nowhere else.
    const board = template.find((menu) => menu.label === 'Board');
    assert.equal(board.submenu.some((item) => item.role === 'quit'), false);
    assert.ok(template[0].submenu.some((item) => item.role === 'quit'));
  });

  it('puts Quit in the first menu on Windows and Linux', () => {
    const template = buildAppMenuTemplate({ platform: 'win32', actions: {} });
    assert.equal(template[0].label, 'Board');
    assert.ok(template[0].submenu.some((item) => item.role === 'quit'));
    assert.ok(template.find((menu) => menu.label === 'Help').submenu.some((item) => item.label === 'About Zelos'));
  });

  it('gives macOS a ⌘W that closes the window', () => {
    // Without `close` in the Window menu there is no ⌘W anywhere in the app,
    // and ⌘W is the first thing a Mac user reaches for on a window that is
    // meant to be closed and left running.
    for (const platform of ['darwin', 'win32', 'linux']) {
      const template = buildAppMenuTemplate({ platform, actions: {} });
      const window = template.find((menu) => menu.label === 'Window');
      assert.ok(
        window.submenu.some((item) => item.role === 'close'),
        `the Window menu on ${platform} has no close role`,
      );
    }
  });

  it('offers open-at-login where the OS has one, off until it is asked for', () => {
    const set = [];
    const template = buildAppMenuTemplate({
      platform: 'darwin',
      actions: { openAtLogin: () => false, setOpenAtLogin: (want) => set.push(want) },
    });
    const item = template
      .find((menu) => menu.label === 'Board')
      .submenu.find((entry) => entry.label === 'Open Zelos at login');

    assert.ok(item, 'there is no way to make Zelos start with the machine');
    assert.equal(item.type, 'checkbox');
    assert.equal(item.checked, false, 'launch at login must be opt-in');

    // Electron flips `checked` before it calls click, so the item carries the
    // state being asked for.
    item.click({ checked: true });
    item.click({ checked: false });
    assert.deepEqual(set, [true, false]);

    // Ticked when the OS says it is ticked — the OS list is the only state.
    const on = buildAppMenuTemplate({ platform: 'win32', actions: { openAtLogin: () => true } });
    assert.equal(
      on.find((menu) => menu.label === 'Board').submenu.find((entry) => entry.label === 'Open Zelos at login').checked,
      true,
    );
  });

  it('leaves the login-item checkbox off Linux, where it would do nothing', () => {
    assert.equal(supportsLoginItem('linux'), false);
    const template = buildAppMenuTemplate({ platform: 'linux', actions: { openAtLogin: () => false } });
    assert.equal(
      template.find((menu) => menu.label === 'Board').submenu.some((entry) => entry.label === 'Open Zelos at login'),
      false,
    );
  });

  it('routes every view to showView, and reload to the URL the shell holds', () => {
    const seen = [];
    const template = buildAppMenuTemplate({
      platform: 'darwin',
      actions: { showView: (id) => seen.push(id), reloadBoard: () => seen.push('reload') },
    });
    const go = template.find((menu) => menu.label === 'Go');
    for (const item of go.submenu) item.click();
    assert.deepEqual(seen, VIEWS.map((view) => view.id));

    const board = template.find((menu) => menu.label === 'Board');
    board.submenu.find((item) => item.label === 'Reload board').click();
    assert.equal(seen.at(-1), 'reload');
  });
});

/* ------------------------------------------------------------------ *
 * The shell, booted for real against a stub Electron
 * ------------------------------------------------------------------ */

/**
 * The stub is written to a temp file and injected by a resolve hook, so the
 * `import ... from 'electron'` in desktop/main.js resolves to it. Deliberately
 * written without template literals so it can live inside one here.
 */
const ELECTRON_STUB = `
import fs from 'node:fs';

export const recorded = {
  appEvents: new Map(),
  windows: [],
  trays: [],
  applicationMenu: null,
  external: [],
  openedPaths: [],
  errorBoxes: [],
  permission: { request: null, check: null },
  beforeRequest: null,
  quits: 0,
  appName: null,
  messageBoxes: [],
  badgeCount: null,
  dockBadge: null,
  loginItem: null,
};

function push(map, event, handler) {
  const list = map.get(event) || [];
  list.push(handler);
  map.set(event, list);
}

function fire(map, event, ...args) {
  const list = map.get(event) || [];
  for (const handler of list) handler(...args);
  return list.length;
}

class WebContentsStub {
  constructor() {
    this.handlers = new Map();
    this.windowOpenHandler = null;
    this.executed = [];
  }
  on(event, handler) { push(this.handlers, event, handler); return this; }
  once(event, handler) { push(this.handlers, event, handler); return this; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  executeJavaScript(code) { this.executed.push(code); return Promise.resolve(); }
  emit(event, ...args) { return fire(this.handlers, event, ...args); }
}

export class BrowserWindow {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.webContents = new WebContentsStub();
    this.loaded = [];
    this.destroyed = false;
    this.visible = false;
    this.minimized = false;
    this.maximizedState = false;
    this.fullScreenState = false;
    this.bounds = {
      x: typeof options.x === 'number' ? options.x : 120,
      y: typeof options.y === 'number' ? options.y : 90,
      width: options.width,
      height: options.height,
    };
    recorded.windows.push(this);
    // Electron announces every webContents on the app object; the shell's
    // navigation guard is attached from there, so the stub must do it too.
    fire(recorded.appEvents, 'web-contents-created', { preventDefault() {} }, this.webContents);
  }
  on(event, handler) { push(this.handlers, event, handler); return this; }
  once(event, handler) {
    push(this.handlers, event, handler);
    if (event === 'ready-to-show') setImmediate(() => this.emit('ready-to-show'));
    return this;
  }
  emit(event, ...args) { return fire(this.handlers, event, ...args); }
  loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  restore() { this.minimized = false; }
  maximize() { this.maximizedState = true; }
  setFullScreen(value) { this.fullScreenState = value; }
  isMaximized() { return this.maximizedState; }
  isFullScreen() { return this.fullScreenState; }
  isMinimized() { return this.minimized; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return Object.assign({}, this.bounds); }
  getNormalBounds() { return Object.assign({}, this.bounds); }
}
BrowserWindow.getAllWindows = () => recorded.windows;

export const app = {
  isPackaged: false,
  dock: {
    setIcon() {},
    setBadge(text) { recorded.dockBadge = text; },
  },
  requestSingleInstanceLock() { return true; },
  setName(name) { recorded.appName = name; },
  getVersion() { return '1.0.0'; },
  setAboutPanelOptions() {},
  setBadgeCount(n) { recorded.badgeCount = n; return true; },
  // Electron's own default is openAtLogin:false, and a Zelos that has never
  // been asked must look exactly like one that was told no.
  getLoginItemSettings() { return recorded.loginItem || { openAtLogin: false }; },
  setLoginItemSettings(settings) { recorded.loginItem = Object.assign({}, settings); },
  whenReady() { return Promise.resolve(); },
  on(event, handler) { push(recorded.appEvents, event, handler); return this; },
  emit(event, ...args) { return fire(recorded.appEvents, event, ...args); },
  quit() {
    recorded.quits += 1;
    fire(recorded.appEvents, 'before-quit', { preventDefault() {} });
    fire(recorded.appEvents, 'will-quit', { preventDefault() {} });
  },
};

export const Menu = {
  buildFromTemplate(template) { return { template }; },
  setApplicationMenu(menu) { recorded.applicationMenu = menu; },
};

export class Tray {
  constructor(image) {
    this.image = image;
    this.tooltip = '';
    this.menu = null;
    this.handlers = new Map();
    recorded.trays.push(this);
  }
  setToolTip(text) { this.tooltip = text; }
  setContextMenu(menu) { this.menu = menu; }
  on(event, handler) { push(this.handlers, event, handler); return this; }
  emit(event, ...args) { return fire(this.handlers, event, ...args); }
}

export const dialog = {
  showErrorBox(title, content) { recorded.errorBoxes.push({ title, content }); },
  showMessageBox(options) {
    recorded.messageBoxes.push(options);
    return Promise.resolve({ response: 0, options });
  },
};

export const nativeImage = {
  createFromPath(file) {
    const exists = fs.existsSync(file);
    return { file, isEmpty() { return !exists; }, setTemplateImage() {} };
  },
};

export const nativeTheme = { shouldUseDarkColors: false };

export const screen = {
  getAllDisplays() { return [{ workArea: { x: 0, y: 0, width: 1680, height: 1020 } }]; },
};

export const session = {
  defaultSession: {
    setPermissionRequestHandler(handler) { recorded.permission.request = handler; },
    setPermissionCheckHandler(handler) { recorded.permission.check = handler; },
    webRequest: {
      onBeforeRequest(filter, handler) { recorded.beforeRequest = { filter, handler }; },
    },
  },
};

export const shell = {
  openExternal(url) { recorded.external.push(url); return Promise.resolve(''); },
  openPath(target) { recorded.openedPaths.push(target); return Promise.resolve(''); },
};
`;

describe('the shell, booted against a stub Electron', () => {
  let sandbox;
  let home;
  let recorded;
  let main;
  let booted;

  before(async () => {
    // realpath, not the mkdtemp path: on macOS /var/folders is a symlink into
    // /private/var, Node's resolver stores the resolved form, and a hook that
    // hands back the unresolved one gets a *second* copy of the same module.
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-shell-')));
    home = path.join(sandbox, 'home');
    process.env.ZELOS_HOME = home;
    process.env.ZELOS_PORT = '0';          // let the OS pick; never collide
    process.env.ZELOS_LOG_LEVEL = 'error'; // the shell logs a lot on purpose
    // A temp home is not enough. The shell boots the real core, and /api/health
    // calls secrets.backend(), which on an unforced macOS run shells out to
    // /usr/bin/security against the operator's own login keychain — a real
    // credential store, on their real machine, every time the suite runs. Force
    // the file backend so this test stays inside its sandbox.
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';

    const stubPath = path.join(sandbox, 'electron-stub.mjs');
    fs.writeFileSync(stubPath, ELECTRON_STUB);
    const stubUrl = pathToFileURL(stubPath).href;
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'electron') return { url: stubUrl, shortCircuit: true };
        return next(specifier, context);
      },
    });

    ({ recorded } = await import(stubUrl));
    main = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href);
    booted = await main.ready;
    // ready-to-show is delivered on the next turn, as it is in Electron.
    await new Promise((resolve) => setImmediate(resolve));
  });

  after(async () => {
    await main?.shutdown();
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    delete process.env.ZELOS_HOME;
    delete process.env.ZELOS_PORT;
    delete process.env.ZELOS_LOG_LEVEL;
    delete process.env.ZELOS_SECRETS_BACKEND;
  });

  it('boots the core in this process and binds a loopback port', () => {
    assert.equal(booted.ok, true, booted.error?.stack);
    assert.ok(booted.zelos.port > 0);
    assert.equal(booted.zelos.url, `http://127.0.0.1:${booted.zelos.port}/`);
    assert.match(booted.zelos.token, /^[0-9a-f]{64}$/);
    assert.equal(booted.zelos.paths.home, home);
    assert.ok(fs.existsSync(path.join(home, 'zelos.db')), 'the database was not created');
  });

  it('opens the window at the URL that carries the session token', () => {
    const win = recorded.windows.at(0);
    assert.equal(recorded.windows.length, 1);
    assert.deepEqual(win.loaded, [`http://127.0.0.1:${booted.zelos.port}/?t=${booted.zelos.token}`]);
    assert.equal(win.visible, true, 'the window never came out of ready-to-show');
  });

  it('creates that window with no privileges to lend a page', () => {
    const { webPreferences } = recorded.windows[0].options;
    assert.equal(webPreferences.contextIsolation, true);
    assert.equal(webPreferences.nodeIntegration, false);
    assert.equal(webPreferences.nodeIntegrationInWorker, false);
    assert.equal(webPreferences.nodeIntegrationInSubFrames, false);
    assert.equal(webPreferences.sandbox, true);
    assert.equal(webPreferences.webviewTag, false);
    assert.equal(webPreferences.webSecurity, true);
    assert.equal(webPreferences.allowRunningInsecureContent, false);
    // Chromium fetches spellcheck dictionaries from a Google host.
    assert.equal(webPreferences.spellcheck, false);
    assert.equal(webPreferences.preload, path.join(REPO, 'desktop', 'preload.js'));
    assert.ok(fs.existsSync(webPreferences.preload));
  });

  it('serves the board and refuses the API without the token', async () => {
    const base = booted.zelos.url;

    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);

    const denied = await fetch(new URL('/api/health', base));
    assert.equal(denied.status, 401);

    const allowed = await fetch(new URL('/api/health', base), {
      headers: { 'X-Zelos-Token': booted.zelos.token },
    });
    assert.equal(allowed.status, 200);
    const health = await allowed.json();
    assert.equal(health.ok, true);
    assert.equal(health.home, home);
  });

  it('guards the window it opened', () => {
    const contents = recorded.windows[0].webContents;
    const before = recorded.external.length;

    let prevented = false;
    contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://phish.example/login');
    assert.equal(prevented, true);
    assert.equal(recorded.external.at(-1), 'https://phish.example/login');

    prevented = false;
    contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, `${booted.zelos.url}#/owed`);
    assert.equal(prevented, false, 'the board may navigate itself');
    assert.equal(recorded.external.length, before + 1);

    assert.deepEqual(contents.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
  });

  it('cancels any request from the board that is not the board', () => {
    const { filter, handler } = recorded.beforeRequest;
    assert.deepEqual(filter.urls, ['*://*/*']);

    const verdicts = [];
    handler({ url: 'https://telemetry.example/collect' }, (r) => verdicts.push(r.cancel));
    handler({ url: `${booted.zelos.url}app.css` }, (r) => verdicts.push(r.cancel));
    assert.deepEqual(verdicts, [true, false]);
  });

  it('denies every browser permission but the one the copy buttons need', () => {
    const granted = [];
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']) {
      recorded.permission.request(null, permission, (ok) => granted.push([permission, ok]));
      assert.equal(recorded.permission.check(null, permission), permission === 'clipboard-sanitized-write');
    }
    assert.deepEqual(granted, [
      ['media', false],
      ['geolocation', false],
      ['notifications', false],
      ['clipboard-read', false],
      ['clipboard-sanitized-write', true],
    ]);
  });

  it('puts a tray icon up with the three items, and a real image behind it', () => {
    const tray = recorded.trays.at(0);
    assert.ok(tray, 'no tray was created');
    assert.ok(fs.existsSync(tray.image.file), `tray icon missing: ${tray.image.file}`);
    assert.deepEqual(
      tray.menu.template.map((item) => item.label ?? item.type),
      ['Sweep now', 'Open Zelos', 'separator', 'Quit Zelos'],
    );
    assert.match(tray.tooltip, /^Zelos — http:\/\/127\.0\.0\.1:/);
    assert.ok(recorded.applicationMenu, 'no application menu was installed');
  });

  it('runs a sweep from the tray, against the supervisor and not a socket', async () => {
    const sweep = recorded.trays[0].menu.template.find((item) => item.label === 'Sweep now');
    sweep.click();
    assert.equal(booted.zelos.sweepStatus().running, true, 'the tray did not reach the sweep supervisor');

    // With nothing configured the run fails on its own terms — no model key, so
    // no request is ever made — and the shell survives it.
    for (let i = 0; i < 200 && booted.zelos.sweepStatus().running; i++) {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    assert.equal(booted.zelos.sweepStatus().running, false, 'the sweep never finished');

    const health = await (await fetch(new URL('/api/health', booted.zelos.url), {
      headers: { 'X-Zelos-Token': booted.zelos.token },
    })).json();
    assert.equal(health.ok, true);
  });

  it('switches views through a fixed allowlist, never a string from outside', () => {
    const contents = recorded.windows[0].webContents;
    const before = contents.executed.length;
    booted.actions.showView('calendar');
    assert.equal(contents.executed.at(-1), 'window.location.hash = "#/calendar";');

    booted.actions.showView('../../etc/passwd');
    booted.actions.showView('now"; fetch("http://evil.example");//');
    assert.equal(contents.executed.length, before + 1, 'an unknown view id must do nothing at all');
  });

  it('badges the icon after a sweep, and clears it when the board is looked at', async () => {
    const { upsertItem } = await import(pathToFileURL(path.join(REPO, 'core', 'db.mjs')).href);
    upsertItem(booted.zelos.db, {
      key: 'badge-test-1',
      kind: 'reply',
      bucket: 'now',
      headline: 'Somebody is waiting on you',
      severity: 3,
    });
    assert.equal(booted.zelos.attentionCount(), 1);

    // A badge only means anything while the board is not on screen; a window
    // the user is looking at has already told them the number.
    const win = recorded.windows[0];
    win.hide();
    recorded.badgeCount = null;
    booted.zelos.server.zelos.sweeps.relay('done', { ok: true });
    assert.equal(recorded.badgeCount, 1, 'a finished sweep did not badge the icon');

    booted.actions.openBoard();
    assert.equal(recorded.badgeCount, 0, 'opening the board did not clear the badge');
  });

  it('turns launch-at-login on and off, and never turns it on by itself', () => {
    assert.equal(recorded.loginItem, null, 'the shell set a login item nobody asked for');
    assert.equal(booted.actions.openAtLogin(), false);

    booted.actions.setOpenAtLogin(true);
    assert.equal(recorded.loginItem.openAtLogin, true);
    assert.equal(recorded.loginItem.openAsHidden, true, 'a login launch must not steal the screen');
    assert.equal(booted.actions.openAtLogin(), true);

    booted.actions.setOpenAtLogin(false);
    assert.equal(recorded.loginItem.openAtLogin, false);
  });

  it('stops reloading a renderer that keeps dying, and says so', () => {
    const win = recorded.windows[0];
    const contents = win.webContents;
    const before = win.loaded.length;
    const boxes = recorded.messageBoxes.length;

    // The first crash is reloaded at once — that is the glitch case, and it is
    // the only one that happens without a timer.
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(win.loaded.length, before + 1, 'the first crash was not reloaded');
    assert.equal(recorded.messageBoxes.length, boxes, 'one crash is not worth a dialog');

    // The next two back off, so nothing more is loaded synchronously.
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(win.loaded.length, before + 1);

    // The fourth inside the minute is a loop. It gets a dialog instead.
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    const explained = recorded.messageBoxes.slice(boxes);
    assert.equal(explained.length, 2, 'a looping renderer must be explained, not reloaded forever');
    assert.match(explained[0].title, /keeps stopping/);
    assert.match(explained[0].detail, /crashed/);
    assert.equal(win.loaded.length, before + 1, 'the shell reloaded past its own limit');
  });

  it('a board that loads and then dies again is still a loop, and is still stopped', () => {
    // The tempting rule — "a load finished, so forget the crashes" — reads as
    // common sense and is a trap. A renderer running out of memory on a very
    // long board loads FIRST and dies after, so forgetting on a finished load
    // resets the attempt count every lap and the reload runs forever at zero
    // delay: precisely the loop the counter exists to stop. Unrelated crashes
    // are handled by the one-minute window instead, which is tested below.
    const win = recorded.windows[0];
    const contents = win.webContents;

    const boxes = recorded.messageBoxes.length;
    for (let i = 0; i < 4; i++) {
      contents.emit('render-process-gone', {}, { reason: 'oom' });
      // Each reload succeeds — and the next crash arrives anyway.
      contents.emit('did-finish-load');
    }

    assert.ok(recorded.messageBoxes.length > boxes,
      'a renderer that keeps dying after each successful load must eventually be explained');
  });

  it('closing honours the residency rule rather than a hardcoded answer', async () => {
    /* What is being tested here is the WIRING: that the close handler asks
       shouldStayResidentOnClose and does what it says. The rule's own truth
       table is tested separately, further down, where every platform is
       supplied as data instead of being whatever this machine happens to be.

       Asserting a fixed answer here is what went wrong twice: "always stays
       resident" was a macOS assumption that failed on Linux, and "only macOS
       stays resident" was a Linux assumption that failed on Windows — where a
       tray really does exist and really is somewhere to go. */
    const { shouldStayResidentOnClose } = await import(
      pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href);
    const expected = shouldStayResidentOnClose({
      platform: process.platform,
      hasTray: recorded.trays.length > 0,
      autoSweep: booted.zelos.config.sweep.auto === true,
      trayConfirmed: process.env.ZELOS_TRAY_RESIDENT === '1',
    });

    const win = recorded.windows[0];
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });

    assert.equal(prevented, expected,
      expected
        ? 'this platform can keep a scheduled Zelos running, so closing must not end it'
        : 'with nowhere to go, closing must really close rather than hide into nowhere');
    if (expected) assert.equal(win.visible, false, 'it should have gone to the background');

    // Where it was is remembered either way: that is not a residency question.
    const state = JSON.parse(fs.readFileSync(path.join(home, 'window.json'), 'utf8'));
    assert.equal(state.bounds.width, win.options.width);
    assert.equal(state.bounds.height, win.options.height);
  });

  it('holds the data home while it runs, with the pid and the port in it', () => {
    const held = readHomeLock(home);
    assert.ok(held, `nothing is holding ${home}`);
    assert.equal(held.pid, process.pid);
    assert.equal(held.kind, 'desktop');
    assert.equal(held.port, booted.zelos.port, 'the lock does not say where the board is');
  });

  it('closes the server and the database on quit, and lets go of the home', async () => {
    await main.shutdown();
    await assert.rejects(fetch(booted.zelos.url), 'the socket is still open after shutdown');
    assert.equal(readHomeLock(home), null, 'the lock outlived the process that took it');
    assert.equal(fs.existsSync(path.join(home, 'zelos.lock')), false);
  });
});

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

describe('parseShellArgs', () => {
  let parseShellArgs;
  before(async () => {
    ({ parseShellArgs } = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href));
  });

  it('reads the three flags in both spellings', () => {
    assert.deepEqual(parseShellArgs(['--home=/tmp/z', '--port=9999', '--sweep-now']), {
      home: '/tmp/z', port: 9999, sweepNow: true,
    });
    assert.deepEqual(parseShellArgs(['--home', '/tmp/z', '--port', '9999']), {
      home: '/tmp/z', port: 9999, sweepNow: false,
    });
  });

  it('ignores what Chromium and macOS add, rather than refusing to start', () => {
    assert.deepEqual(parseShellArgs(['.', '-psn_0_1234', '--disable-gpu', '--inspect=9229', '--port=0']), {
      home: null, port: 0, sweepNow: false,
    });
  });

  it('ignores a --home that is interpolation garbage, not a directory', () => {
    // `--home=${dir}` with `dir` unset hands us the literal string
    // "undefined"; honouring it once created a live data directory named
    // undefined/ in the working directory.
    for (const bad of [['--home=undefined'], ['--home', 'undefined'], ['--home=null'], ['--home', 'NULL']]) {
      assert.equal(parseShellArgs(bad).home, null, bad.join(' '));
    }
  });

  it('ignores a port that is not one', () => {
    for (const bad of [['--port=nope'], ['--port=70000'], ['--port=-1'], ['--port']]) {
      assert.equal(parseShellArgs(bad).port, null, bad.join(' '));
    }
  });
});

/* ------------------------------------------------------------------ *
 * The lock on the data home
 * ------------------------------------------------------------------ */

/**
 * The case Electron's single-instance lock cannot see: a `zelos` in a terminal
 * and this app, both pointed at one home, both sweeping. These run against
 * their own temp homes and never load the core, except for the one test that
 * has to prove startCore refuses before it opens anything.
 */
describe('the lock on the data home', () => {
  let dir;
  before(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-lock-'))); });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const freshHome = (name) => path.join(dir, name);

  it('reports a second Zelos while the first one is alive, and still starts', () => {
    const home = freshHome('busy');
    const first = acquireHomeLock({ home, kind: 'cli', port: 4321 });

    // Advisory, not exclusive: it never throws, because the diagnosis reads a
    // file to guess whether a process is alive and a guess that is sometimes
    // wrong must not be able to stop somebody starting their own app.
    const second = acquireHomeLock({ home, kind: 'desktop' });
    assert.ok(second.contested, 'a busy home has to be reported');
    // The warning has to name what to quit, and how to clear it if the
    // diagnosis was wrong — that escape hatch is the whole safety net.
    assert.match(second.contested.message, /terminal/);
    assert.match(second.contested.message, new RegExp(`process ${process.pid}\\b`));
    assert.match(second.contested.message, /http:\/\/127\.0\.0\.1:4321\//);
    assert.match(second.contested.message, /delete /);
    assert.equal(second.contested.pid, process.pid);
    assert.equal(second.contested.kind, 'cli');
    assert.equal(second.contested.home, home);
    // The loser owns nothing: releasing it must not take the live lock away.
    second.release();
    assert.equal(readHomeLock(home).pid, process.pid);
    assert.equal(readHomeLock(home).kind, 'cli', 'the first holder still holds it');

    first.release();
    // And once it lets go, the next one walks straight in, uncontested.
    const third = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(third.contested, null);
    assert.equal(readHomeLock(home).kind, 'desktop');
    third.release();
  });

  it('records the port once the board has bound one', () => {
    const home = freshHome('port');
    const held = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).port, null);
    held.setPort(51234);
    assert.equal(readHomeLock(home).port, 51234);
    held.release();
  });

  it('reclaims a lock left behind by a crash rather than locking the user out', () => {
    const home = freshHome('stale');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'zelos.lock');

    // A pid far above any pid_max on any platform this runs on: a process that
    // is certainly not there, which is what a lock left by a crash looks like.
    fs.writeFileSync(file, JSON.stringify({ pid: 2_147_483_646, kind: 'cli', port: 7777 }));
    const afterCrash = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).pid, process.pid, 'a dead pid still held the home');
    afterCrash.release();

    // And a lock file truncated by a hard power-off is not a lock either.
    fs.writeFileSync(file, '{"pid": 12');
    const afterPowerCut = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).pid, process.pid, 'an unreadable lock file locked the user out');
    afterPowerCut.release();
    assert.equal(fs.existsSync(file), false);
  });

  it('will not release a lock that belongs to somebody else', () => {
    const home = freshHome('handover');
    const mine = acquireHomeLock({ home, kind: 'desktop' });
    // Somebody reclaimed it while this instance was shutting down. Releasing
    // here would take the live instance's lock away with us.
    fs.writeFileSync(path.join(home, 'zelos.lock'), JSON.stringify({ pid: 2_147_483_645, kind: 'cli', port: null }));
    mine.release();
    assert.equal(readHomeLock(home).pid, 2_147_483_645);
  });

  it('startCore reports a busy home on its handle rather than refusing to run', async () => {
    const home = freshHome('startcore');
    const held = acquireHomeLock({ home, kind: 'cli', port: 9999 });
    const previous = process.env.ZELOS_HOME;
    try {
      const handle = await startCore({ root: REPO, home, port: 0 });
      try {
        // It started — that is the point. What it must not do is stay quiet
        // about the other instance, because the cost of the overlap (the same
        // mail read twice, the same model calls paid for twice) is invisible.
        assert.ok(handle.contested, 'a busy home has to reach the shell');
        assert.equal(handle.contested.kind, 'cli');
        assert.match(handle.contested.message, /terminal/);
      } finally {
        await handle.stop();
      }
      // And starting must not have taken the live instance's lock with it.
      assert.equal(readHomeLock(home).port, 9999);
      assert.equal(readHomeLock(home).pid, process.pid);
    } finally {
      held.release();
      if (previous === undefined) delete process.env.ZELOS_HOME;
      else process.env.ZELOS_HOME = previous;
    }
  });

  it('takes the lock for a launcher in one call, and says a terminal holds it', () => {
    // The pairing the lock exists for only works if both entry points take it.
    // This is the whole CLI half: one call, released when the process ends.
    const home = freshHome('holdhome');
    const lock = holdHome({ home, kind: 'cli' });
    try {
      assert.equal(readHomeLock(home).kind, 'cli');
      assert.equal(readHomeLock(home).pid, process.pid);
      const shell = acquireHomeLock({ home, kind: 'desktop' });
      assert.ok(shell.contested, 'the app has to be told a terminal got here first');
      assert.equal(shell.contested.kind, 'cli');
      assert.match(shell.contested.message, /terminal/);
      shell.release();
      lock.setPort(5150);
      assert.equal(readHomeLock(home).port, 5150);
    } finally {
      lock.release();
    }
  });

  it('the launcher really takes it — the half that makes the lock mean anything', () => {
    // For a long time only the Electron shell took the lock, so the pairing it
    // was written for (a `zelos` in a terminal plus the app in the tray) was
    // exactly the pairing it could not see. This asserts the CLI entry point
    // holds the home, by reading zelos.mjs rather than by starting a server:
    // booting one here would bind a socket and fight the rest of the suite.
    const source = fs.readFileSync(path.join(REPO, 'zelos.mjs'), 'utf8');
    assert.match(source, /holdHome/, 'zelos.mjs must take the home lock');
    assert.match(source, /kind: 'cli'/, 'and identify itself as the terminal one');
    // And it must not be able to take the app down with it: the import is
    // defensive because a source checkout may have no desktop shell beside it.
    const call = source.slice(source.indexOf('holdHome') - 400, source.indexOf('holdHome') + 200);
    assert.match(call, /try\s*{/, 'the lock must never be able to stop the launcher');
  });
});

/* ------------------------------------------------------------------ *
 * Deciding whether a lock is still held
 * ------------------------------------------------------------------ */

/**
 * The failure this replaces was a permanent one. `EPERM` from `kill(pid, 0)`
 * was read as "alive", so after an unclean exit and a reboot — where the
 * recorded number has very likely been handed to a root-owned daemon — Zelos
 * refused to start and went on refusing, with nothing a user could do about it
 * short of finding a file nobody had told them existed.
 */
describe('lockHolderState', () => {
  const NOW = Date.parse('2026-08-09T12:00:00Z');
  const BOOTED = Date.parse('2026-08-09T09:00:00Z');
  const at = (iso) => iso;
  const state = (record, probe) => lockHolderState(record, { now: NOW, bootedAt: BOOTED, uid: 501, ...probe });

  it('reclaims a pre-boot lock even when it names this very process', () => {
    // The nastiest version of pid reuse: after a reboot the kernel hands the
    // numbers out again from the start, so a lock left by an unclean exit can
    // name the pid THIS process is now running under. Answering "held — this
    // process holds it" there is a refusal justified by a coincidence, and it
    // never clears. The boot rule has to be read before the identity check.
    const verdict = state(
      { pid: process.pid, kind: 'desktop', uid: 501, startedAt: at('2026-08-08T22:00:00Z') },
      { signal: () => 'alive' },
    );
    assert.equal(verdict.held, false);
    assert.match(verdict.why, /booted/);
  });

  it('will not hold on a foreign lock that cannot say when it was taken', () => {
    // A record naming another user and an unsignallable pid, with no readable
    // startedAt, used to be held forever: with no age, neither the boot rule
    // nor the month-old ceiling could ever release it. An unreadable date is a
    // broken lock, and a broken lock must not outrank somebody starting up.
    const verdict = state(
      { pid: 1, kind: 'desktop', uid: 0 },
      { signal: () => 'denied' },
    );
    assert.equal(verdict.held, false);
  });

  it('reclaims a pid handed to something else across a reboot', () => {
    // The reproduction: pid 1, owned by root, answering EPERM. It is alive, it
    // is simply not Zelos — and the lock predates the boot, which settles it
    // whatever the signal says.
    const verdict = state(
      { pid: 1, kind: 'desktop', uid: 501, startedAt: at('2026-08-08T22:00:00Z') },
      { signal: () => 'alive' },
    );
    assert.equal(verdict.held, false, 'a lock written before this boot cannot still be held');
    assert.match(verdict.why, /booted/);
  });

  it('reads EPERM on a lock this user wrote as pid reuse, not as life', () => {
    // A process this user started can always be signalled by this user. So a
    // refusal to signal one is proof the pid belongs to somebody else now.
    const verdict = state(
      { pid: 1, kind: 'cli', uid: 501, startedAt: at('2026-08-09T11:00:00Z') },
      { signal: () => 'denied' },
    );
    assert.equal(verdict.held, false);
    assert.match(verdict.why, /someone else/);
  });

  it('treats a lock with no uid at all as reclaimable when it cannot be probed', () => {
    // Written by an older Zelos, or truncated. Unknowable is not a reason to
    // lock somebody out of their own data.
    assert.equal(
      state({ pid: 1, kind: 'cli', startedAt: at('2026-08-09T11:00:00Z') }, { signal: () => 'denied' }).held,
      false,
    );
  });

  it('still refuses for a Zelos another user is running', () => {
    const record = { pid: 4242, kind: 'cli', uid: 0, startedAt: at('2026-08-09T11:00:00Z') };
    assert.equal(state(record, { signal: () => 'denied' }).held, true, 'sudo zelos is a real holder');
    // ...but not forever. A month of nobody being able to probe it is a lockout.
    assert.equal(
      state({ ...record, startedAt: at('2026-05-01T00:00:00Z') }, { signal: () => 'denied' }).held,
      false,
    );
  });

  it('leaves the ordinary answers where they were', () => {
    const fresh = { pid: 4242, kind: 'desktop', uid: 501, startedAt: at('2026-08-09T11:00:00Z') };
    assert.equal(state(fresh, { signal: () => 'alive' }).held, true);
    assert.equal(state(fresh, { signal: () => 'gone' }).held, false);
    assert.equal(state({ pid: 0 }, { signal: () => 'alive' }).held, false);
    assert.equal(state(null, { signal: () => 'alive' }).held, false);
  });

  it('does not call a clock that moved a reason to reclaim', () => {
    // NTP stepped the clock forward, so the lock looks like it was taken in the
    // future. That is not evidence of anything; the signal decides.
    const record = { pid: 4242, kind: 'desktop', uid: 501, startedAt: at('2027-01-01T00:00:00Z') };
    assert.equal(state(record, { signal: () => 'alive' }).held, true);
    // And a lock a few minutes either side of the boot instant is left alone.
    const borderline = { pid: 4242, kind: 'desktop', uid: 501, startedAt: at('2026-08-09T08:58:00Z') };
    assert.equal(state(borderline, { signal: () => 'alive' }).held, true);
  });
});

/* ------------------------------------------------------------------ *
 * A lock that cannot be taken must not stop Zelos
 * ------------------------------------------------------------------ */

/**
 * A data home on a filesystem with no hard links — an external drive formatted
 * FAT32, a USB stick, a Windows share — answered `ENOTSUP` from `link(2)`, and
 * that error came straight out of `startCore`. Zelos could not be run at all,
 * on account of a lock it does not need to run.
 */
describe('a home on a filesystem that cannot do the lock', () => {
  let dir;
  before(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-nolink-'))); });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /**
   * Make the named fs calls fail for the lock file only, the way FAT32 does.
   * The patch is on the `fs` object runtime.js holds, so only its own explicit
   * calls see it — Node's internals reach their own bindings — and it stands
   * until the body settles, promise or not.
   */
  function withoutLinking(names, body) {
    const real = new Map(names.map((name) => [name, fs[name]]));
    const restore = () => { for (const [name, fn] of real) fs[name] = fn; };
    for (const name of names) {
      fs[name] = (...args) => {
        const target = String(name === 'linkSync' ? args[1] : args[0]);
        if (!target.endsWith('zelos.lock')) return real.get(name).apply(fs, args);
        const err = new Error(`ENOTSUP: operation not supported, ${name.replace('Sync', '')} '${target}'`);
        err.code = 'ENOTSUP';
        throw err;
      };
    }
    let out;
    try {
      out = body();
    } catch (err) {
      restore();
      throw err;
    }
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  }

  it('falls back to an exclusive create, which is still a lock', () => {
    const home = path.join(dir, 'fallback');
    const held = withoutLinking(['linkSync'], () => acquireHomeLock({ home, kind: 'desktop' }));
    try {
      assert.equal(held.degraded, null, 'O_EXCL works here, so the lock is real');
      assert.equal(readHomeLock(home).pid, process.pid);
      const next = acquireHomeLock({ home, kind: 'cli' });
      assert.ok(next.contested, 'a lock taken by O_EXCL still has to be seen by the next process');
      next.release();
    } finally {
      held.release();
    }
  });

  it('runs unlocked, and says so, when nothing exclusive is available', () => {
    const home = path.join(dir, 'unlocked');
    const held = withoutLinking(['linkSync', 'openSync'], () => acquireHomeLock({ home, kind: 'desktop' }));
    assert.ok(held.degraded, 'a lock that was never taken must not be reported as taken');
    assert.equal(held.degraded.code, 'ENOTSUP');
    assert.equal(fs.existsSync(path.join(home, 'zelos.lock')), false);
    // The handle still has to behave like one, since nothing else knows.
    held.setPort(4444);
    assert.equal(held.record.port, 4444);
    held.release();
  });

  it('boots the whole core there rather than refusing to start', async () => {
    const home = path.join(dir, 'boots');
    const previousHome = process.env.ZELOS_HOME;
    const previousSecrets = process.env.ZELOS_SECRETS_BACKEND;
    // The core's secrets backend shells out to the real login keychain on an
    // unforced macOS run; this stays inside its sandbox.
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    try {
      const outcome = await withoutLinking(['linkSync', 'openSync'], () =>
        startCore({ root: REPO, home, port: 0 }).then((handle) => ({ handle }), (error) => ({ error })));
      assert.equal(outcome.error, undefined, `a home with no hard links stopped Zelos: ${outcome.error?.message}`);
      assert.ok(outcome.handle.port > 0, 'nothing bound');
      assert.ok(fs.existsSync(path.join(home, 'zelos.db')), 'the database was never opened');
      await outcome.handle.stop();
    } finally {
      if (previousHome === undefined) delete process.env.ZELOS_HOME;
      else process.env.ZELOS_HOME = previousHome;
      if (previousSecrets === undefined) delete process.env.ZELOS_SECRETS_BACKEND;
      else process.env.ZELOS_SECRETS_BACKEND = previousSecrets;
    }
  });

  it('lets a real reused pid go, rather than refusing forever', () => {
    // pid 1 is init/launchd: owned by root, certainly running, certainly not
    // Zelos. Before this, kill(1, 0) answering EPERM read as "alive" and the
    // refusal it produced could not be cleared by quitting anything.
    const home = path.join(dir, 'pid1');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'zelos.lock');

    fs.writeFileSync(file, JSON.stringify({
      pid: 1, kind: 'desktop', port: 7777, uid: process.getuid?.() ?? null,
      startedAt: new Date(Date.now() - 400 * 24 * 60 * 60_000).toISOString(),
    }));
    const afterReboot = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).pid, process.pid, 'a lock older than the boot still locked the user out');
    afterReboot.release();

    // And the same thing without the reboot to settle it: the record says this
    // user wrote it, so a pid this user may not signal is not this user's Zelos.
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      fs.writeFileSync(file, JSON.stringify({
        pid: 1, kind: 'cli', port: null, uid: process.getuid(), startedAt: new Date().toISOString(),
      }));
      const afterReuse = acquireHomeLock({ home, kind: 'desktop' });
      assert.equal(readHomeLock(home).pid, process.pid, 'a recycled pid still held the home');
      afterReuse.release();
    }
  });

  it('always says how to clear a lock it warns about', () => {
    // The warning is a guess about another process, so the way out of a wrong
    // guess has to be in the warning itself — naming the file, by full path.
    const home = path.join(dir, 'wayout');
    const lockFile = path.join(home, 'zelos.lock');
    const held = acquireHomeLock({ home, kind: 'desktop' });
    try {
      const next = acquireHomeLock({ home, kind: 'cli' });
      assert.ok(next.contested);
      // Compared literally, not as a pattern. This used to build a RegExp out
      // of the path and escape only the dots, which is fine as long as the
      // separator is `/` — on Windows the path is `C:\Users\…\zelos.lock` and
      // every separator is a regex escape, so `\U` and `\z` compiled into
      // something that could not match the path they came from. The assertion
      // is about a literal string appearing in a sentence; `includes` is what
      // that means, and it holds identically on all three platforms.
      assert.ok(
        next.contested.message.includes(`delete ${lockFile}`),
        `the warning must name the file to delete, in full: ${next.contested.message}`,
      );
      assert.equal(next.contested.lockFile, lockFile);
      next.release();
    } finally {
      held.release();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Closing, and crashing
 * ------------------------------------------------------------------ */

describe('what closing the window means', () => {
  let shouldStayResidentOnClose;
  before(async () => {
    ({ shouldStayResidentOnClose } = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href));
  });

  it('hides to the tray only when there is a tray to hide to', () => {
    // The one that mattered: a Linux desktop with no system tray, auto-sweep
    // on, and a close handler that hid the window anyway — leaving an app with
    // no window, no tray icon and no way back to either.
    assert.equal(shouldStayResidentOnClose({ platform: 'linux', hasTray: false, autoSweep: true }), false);
    assert.equal(shouldStayResidentOnClose({ platform: 'win32', hasTray: false, autoSweep: true }), false);

    assert.equal(shouldStayResidentOnClose({ platform: 'win32', hasTray: true, autoSweep: true }), true);
    // A tray with nothing to sweep is still not a reason to outlive the window.
    assert.equal(shouldStayResidentOnClose({ platform: 'win32', hasTray: true, autoSweep: false }), false);
  });

  it('does not believe a Linux tray it cannot see', () => {
    // The case the old check claimed to cover and did not: GNOME without an
    // AppIndicator extension. `new Tray()` does not fail there — it publishes a
    // StatusNotifierItem that nothing displays — so a non-null tray was never
    // evidence, and hiding the window on that evidence hid it into nowhere.
    assert.equal(shouldStayResidentOnClose({ platform: 'linux', hasTray: true, autoSweep: true }), false);
    // Only the person looking at the panel can settle it, so only they can.
    assert.equal(
      shouldStayResidentOnClose({ platform: 'linux', hasTray: true, autoSweep: true, trayConfirmed: true }),
      true,
    );
    // And saying the tray works is not a reason to outlive the window on its own.
    assert.equal(
      shouldStayResidentOnClose({ platform: 'linux', hasTray: false, autoSweep: true, trayConfirmed: true }),
      false,
    );
  });

  it('leaves macOS alone: an app there outlives its windows, tray or no tray', () => {
    assert.equal(shouldStayResidentOnClose({ platform: 'darwin', hasTray: false, autoSweep: false }), true);
    assert.equal(shouldStayResidentOnClose({ platform: 'darwin', hasTray: true, autoSweep: true }), true);
  });
});

describe('planRendererRestart', () => {
  let planRendererRestart;
  before(async () => {
    ({ planRendererRestart } = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href));
  });

  it('reloads the first three crashes, further apart each time, then stops', () => {
    const now = 1_000_000;
    const at = (n) => Array.from({ length: n }, (_, i) => now - (n - 1 - i));

    const delays = [1, 2, 3].map((n) => planRendererRestart(at(n), now));
    assert.deepEqual(delays.map((plan) => plan.action), ['reload', 'reload', 'reload']);
    assert.ok(delays[0].delayMs === 0, 'the first crash should come back at once');
    assert.ok(delays[1].delayMs > delays[0].delayMs, 'the second attempt does not back off');
    assert.ok(delays[2].delayMs > delays[1].delayMs, 'the third attempt does not back off');

    // Four in a minute is a loop, and a loop gets a message rather than a
    // fourth reload nobody sees.
    for (const n of [4, 5, 40]) {
      assert.equal(planRendererRestart(at(n), now).action, 'explain', `${n} crashes`);
    }
  });

  it('forgets crashes that are old news', () => {
    const now = 1_000_000;
    const longAgo = [now - 600_000, now - 500_000, now - 400_000];
    const plan = planRendererRestart([...longAgo, now], now);
    assert.equal(plan.action, 'reload');
    assert.equal(plan.attempt, 1, 'crashes from ten minutes ago are not this crash');
  });
});
