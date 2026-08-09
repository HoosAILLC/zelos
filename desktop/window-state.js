/**
 * desktop/window-state.js — remember where the window was.
 *
 * Small feature, two failure modes worth writing code against:
 *
 *   1. The saved rectangle belongs to a monitor that is no longer there. A
 *      window restored at x:-1600 on a laptop that left its desk is a window
 *      the user cannot find. So a restored position is only honoured if enough
 *      of it lands on a work area that exists *now*; otherwise the size is kept
 *      and the position is dropped, which lets the OS centre it.
 *   2. The bounds are read while the window is maximised or full-screen, so the
 *      "restored" size becomes the screen size and un-maximising does nothing.
 *      `getNormalBounds()` is the one that survives that.
 *
 * The clamp is a pure function of a rectangle and a list of work areas, so the
 * awkward multi-monitor cases can be tested without a monitor.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BOUNDS = Object.freeze({ width: 1180, height: 820 });
export const MIN_SIZE = Object.freeze({ width: 420, height: 520 });

/** How much of the window has to be on a real display for the position to count. */
const MIN_VISIBLE = Object.freeze({ width: 120, height: 40 });

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function overlap(a, b) {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Fit a remembered rectangle to the displays that exist now.
 * `workAreas` is `screen.getAllDisplays().map(d => d.workArea)`.
 * Returns `{width, height}` alone when the position cannot be trusted.
 */
export function clampToDisplays(bounds, workAreas = []) {
  const width = Math.max(MIN_SIZE.width, Math.round(Number(bounds?.width) || DEFAULT_BOUNDS.width));
  const height = Math.max(MIN_SIZE.height, Math.round(Number(bounds?.height) || DEFAULT_BOUNDS.height));

  const x = Number.isFinite(bounds?.x) ? Math.round(bounds.x) : null;
  const y = Number.isFinite(bounds?.y) ? Math.round(bounds.y) : null;
  if (x === null || y === null || !Array.isArray(workAreas) || workAreas.length === 0) {
    return { width, height };
  }

  const rect = { x, y, width, height };
  const home = workAreas.find((area) => {
    const o = overlap(rect, area);
    return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height;
  });
  if (!home) return { width, height };

  const w = Math.min(width, home.width);
  const h = Math.min(height, home.height);
  return {
    x: clamp(x, home.x, home.x + home.width - w),
    y: clamp(y, home.y, home.y + home.height - h),
    width: w,
    height: h,
  };
}

function readJSONFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // No file yet, or a truncated one from a hard power-off. Either way the
    // defaults are correct and losing a window position is not worth a dialog.
    return null;
  }
}

/** Atomic, 0600 — it lives beside the database in the Zelos home. */
function writeJSONFile(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class WindowState {
  #file;
  #state;
  #timer = null;
  #window = null;
  #debounceMs;

  constructor({ file, debounceMs = 400 }) {
    if (!file) throw new TypeError('WindowState needs a file path');
    this.#file = file;
    this.#debounceMs = debounceMs;
    const stored = readJSONFile(file);
    this.#state = {
      bounds: stored?.bounds && typeof stored.bounds === 'object' ? stored.bounds : { ...DEFAULT_BOUNDS },
      maximized: stored?.maximized === true,
      fullScreen: stored?.fullScreen === true,
    };
  }

  get file() {
    return this.#file;
  }

  /** Options to hand straight to `new BrowserWindow(...)`. */
  initial(workAreas = []) {
    return {
      ...clampToDisplays(this.#state.bounds, workAreas),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
    };
  }

  get maximized() {
    return this.#state.maximized;
  }

  get fullScreen() {
    return this.#state.fullScreen;
  }

  /**
   * Follow a window. Moves and resizes are coalesced — a drag emits dozens of
   * events and none of them is worth an fsync.
   */
  track(win) {
    this.#window = win;
    const later = () => {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.capture(), this.#debounceMs);
      this.#timer.unref?.();
    };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      win.on(event, later);
    }
    // The last word, written synchronously: after `close` there is no later.
    win.on('close', () => this.capture());
    return this;
  }

  /** Read the window's current geometry and persist it. */
  capture() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const win = this.#window;
    if (!win || win.isDestroyed?.()) return this.#state;

    // While maximised or full-screen, plain getBounds() is the screen — the
    // size to restore to is the one underneath it.
    const bounds = (win.getNormalBounds?.() ?? win.getBounds?.()) || this.#state.bounds;
    this.#state = {
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      maximized: win.isMaximized?.() === true,
      fullScreen: win.isFullScreen?.() === true,
    };
    this.save();
    return this.#state;
  }

  save() {
    try {
      writeJSONFile(this.#file, { version: 1, ...this.#state });
    } catch {
      // A window position is not worth failing a shutdown over.
    }
    return this.#state;
  }
}
