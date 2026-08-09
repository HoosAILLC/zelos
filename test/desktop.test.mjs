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
import { buildAppMenuTemplate, buildTrayMenuTemplate, VIEWS } from '../desktop/menus.js';

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
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('starts from the defaults and writes what it captured', () => {
    const file = path.join(dir, 'window.json');
    const state = new WindowState({ file });
    assert.deepEqual(state.initial([]), { ...DEFAULT_BOUNDS, minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height });

    state.track(fakeWindow({ x: 42, y: 24, width: 1000, height: 700 }));
    state.capture();

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.bounds, { x: 42, y: 24, width: 1000, height: 700 });
    assert.equal(written.maximized, false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // A fresh instance reads it back.
    assert.equal(new WindowState({ file }).initial([]).width, 1000);
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
  dock: { setIcon() {} },
  requestSingleInstanceLock() { return true; },
  setName(name) { recorded.appName = name; },
  getVersion() { return '1.0.0'; },
  setAboutPanelOptions() {},
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
  showMessageBox(options) { return Promise.resolve({ response: 0, options }); },
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
    fs.rmSync(sandbox, { recursive: true, force: true });
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

  it('keeps running in the tray when the window is closed, and remembers where it was', () => {
    const win = recorded.windows[0];
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'closing the window must not end a scheduled Zelos');
    assert.equal(win.visible, false);

    const state = JSON.parse(fs.readFileSync(path.join(home, 'window.json'), 'utf8'));
    assert.equal(state.bounds.width, win.options.width);
    assert.equal(state.bounds.height, win.options.height);
  });

  it('closes the server and the database on quit', async () => {
    await main.shutdown();
    await assert.rejects(fetch(booted.zelos.url), 'the socket is still open after shutdown');
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

  it('ignores a port that is not one', () => {
    for (const bad of [['--port=nope'], ['--port=70000'], ['--port=-1'], ['--port']]) {
      assert.equal(parseShellArgs(bad).port, null, bad.join(' '));
    }
  });
});
