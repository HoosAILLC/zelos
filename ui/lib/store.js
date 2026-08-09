/**
 * ui/lib/store.js — one copy of the truth, and the sweep stream that keeps it
 * honest.
 *
 * Everything the views render lives here: /api/health, /api/config and the
 * board from /api/state. Views subscribe; nothing reaches into another view.
 *
 * `now` deserves a note. The board carries the server's `now` as an ISO string
 * in the *user's configured* zone, and the calendar positions its now-line from
 * that string's wall-clock minutes. Ticking that forward with the local clock
 * would be wrong the moment the two zones differ, so the tick is applied as
 * elapsed milliseconds since the payload arrived — a duration, which is the same
 * in every zone.
 */

import { api, openStream, ApiError } from './api.js';
import { minutesIntoDay, dayKey, localTimezone } from './time.js';

const ACCENT_KEY = 'zelos.accent';
const ONBOARDED_KEY = 'zelos.onboarded';

/** Blank board, so a view rendered before the first fetch has real shapes. */
const EMPTY_BOARD = Object.freeze({
  items: [],
  counts: { now: 0, today: 0, soon: 0, waiting: 0, promised: 0, note: 0, money: 0 },
  events: [],
  drafts: [],
  runs: { last: null },
  notes: [],
  first: null,
  now: null,
});

export const state = {
  /** 'boot' until the first health+state pair lands, then 'ready' or 'down'. */
  phase: 'boot',
  /**
   * Bumped whenever the *content* of the board or the config changes. The app
   * shell re-renders the current view on a change of `rev`, not on every emit —
   * a sweep-progress tick must not rebuild a draft textarea under someone's
   * cursor.
   */
  rev: 0,
  /** Set when the server itself is unreachable — a designed screen, not a toast. */
  fatal: null,
  health: null,
  config: null,
  configErrors: [],
  secretRefs: [],
  board: EMPTY_BOARD,
  boardAt: 0,
  sweep: { running: false, phase: '', message: '', done: 0, total: 0, error: null, lastResult: null },
  /** Non-fatal, dismissible: a save that failed, a draft that would not persist. */
  toast: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error('a subscriber threw', err);
    }
  }
}

export function notify(message, { tone = 'info' } = {}) {
  state.toast = message ? { message, tone, at: Date.now() } : null;
  emit();
}

/* ------------------------------------------------------------------- accent */

/**
 * There is one theme — black — and one colour choice on top of it. Everything
 * in the stylesheet derives from this single hex via color-mix, including the
 * ambient light behind the glass, so this is genuinely the only value stored.
 */
export const DEFAULT_ACCENT = '#5b8cff';

/** Six digit hex only. Anything else is refused rather than written to a CSS
 *  custom property, where a hostile string would land unescaped in a style. */
export function isAccent(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

export function currentAccent() {
  const fromConfig = state.config?.ui?.accent;
  if (isAccent(fromConfig)) return fromConfig.toLowerCase();
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    if (isAccent(stored)) return stored.toLowerCase();
  } catch {
    /* storage disabled; fall through to the default */
  }
  return DEFAULT_ACCENT;
}

export function applyAccent(accent) {
  const hex = isAccent(accent) ? accent.toLowerCase() : DEFAULT_ACCENT;
  document.documentElement.style.setProperty('--accent', hex);
  try {
    localStorage.setItem(ACCENT_KEY, hex);
  } catch {
    /* the property above is what actually colours the app */
  }
  return hex;
}

export async function setAccent(accent) {
  const hex = applyAccent(accent);
  if (state.config) state.config = { ...state.config, ui: { ...state.config.ui, accent: hex } };
  emit();
  try {
    await saveConfig({ ui: { accent: hex } });
  } catch (err) {
    notify(`Accent not saved: ${err.message}`, { tone: 'warn' });
  }
}

/* -------------------------------------------------------------- onboarding */

/**
 * Onboarding is "have you finished it", not "is anything configured" — a user
 * who deliberately skipped every step must not be dragged back through the flow
 * on the next launch. The mark lives in localStorage rather than config.json
 * because it is a fact about this browser profile, not about the account.
 */
export function onboardingDone() {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markOnboarded(done = true) {
  try {
    if (done) localStorage.setItem(ONBOARDED_KEY, '1');
    else localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    /* the flow still completes; it will simply offer itself again */
  }
}

export function needsOnboarding() {
  if (onboardingDone()) return false;
  return !state.health?.model?.configured;
}

/* ------------------------------------------------------------------ loading */

export async function loadHealth() {
  state.health = await api.health();
  return state.health;
}

export async function loadConfig() {
  const res = await api.config();
  state.config = res.config;
  state.configErrors = res.errors || [];
  state.secretRefs = res.secretRefs || [];
  state.rev += 1;
  return state.config;
}

export async function loadBoard() {
  const board = await api.state();
  state.board = { ...EMPTY_BOARD, ...board };
  state.boardAt = Date.now();
  state.rev += 1;
  return state.board;
}

export async function saveConfig(patch) {
  const res = await api.saveConfig(patch);
  state.config = res.config;
  state.configErrors = res.errors || [];
  state.secretRefs = res.secretRefs || [];
  state.rev += 1;
  emit();
  return res;
}

/** health + config + board, in parallel. The first one is what boots the app. */
export async function refresh({ silent = false } = {}) {
  try {
    await Promise.all([loadHealth(), loadConfig(), loadBoard()]);
    state.phase = 'ready';
    state.fatal = null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      state.fatal = {
        title: 'This tab has lost its key',
        detail: 'Zelos mints a new session token every launch. Reopen the app from the terminal window that started it — the URL there carries the token.',
      };
    } else {
      state.fatal = {
        title: 'Zelos is not answering',
        detail: err.message,
      };
    }
    state.phase = 'down';
  }
  if (!silent) emit();
  return state;
}

export async function refreshBoard() {
  try {
    await loadBoard();
    emit();
  } catch (err) {
    notify(`Could not refresh the board: ${err.message}`, { tone: 'warn' });
  }
}

/* ------------------------------------------------------------------- sweeps */

export async function startSweep(mode = 'auto') {
  state.sweep = { ...state.sweep, error: null, message: 'Starting…', running: true };
  emit();
  try {
    await api.sweep(mode);
  } catch (err) {
    // 409 means one is already in flight, which is not an error the user caused.
    state.sweep = {
      ...state.sweep,
      running: err instanceof ApiError && err.status === 409,
      error: err instanceof ApiError && err.status === 409 ? null : err.message,
    };
    emit();
  }
}

/**
 * Follow /api/sweep/stream forever. The stream survives across sweeps, so a
 * dropped connection means the server restarted or the laptop slept — reconnect
 * with a backoff rather than leaving the board silently stale.
 */
export function watchSweeps() {
  let delay = 1_000;
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      try {
        await openStream('/api/sweep/stream', {
          onEvent(event, data) {
            delay = 1_000;
            if (event === 'hello') {
              state.sweep = { ...state.sweep, running: Boolean(data?.running) };
            } else if (event === 'started') {
              state.sweep = { running: true, phase: 'start', message: 'Sweeping…', done: 0, total: 0, error: null, lastResult: null };
            } else if (event === 'progress') {
              state.sweep = {
                ...state.sweep,
                running: true,
                phase: String(data?.phase || ''),
                message: String(data?.message || ''),
                done: Number(data?.done) || 0,
                total: Number(data?.total) || 0,
              };
            } else if (event === 'done') {
              state.sweep = { running: false, phase: 'done', message: 'Sweep finished', done: 0, total: 0, error: null, lastResult: data || null };
              refreshBoard();
              loadHealth().catch(() => {});
            } else if (event === 'failed') {
              state.sweep = {
                running: false,
                phase: 'failed',
                message: 'Sweep failed',
                done: 0,
                total: 0,
                error: String(data?.error || 'the sweep failed'),
                lastResult: data || null,
              };
              refreshBoard();
            }
            emit();
          },
        });
      } catch {
        // Transport failure; the retry below is the whole recovery story.
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  };

  run();
  return () => { stopped = true; };
}

/* ------------------------------------------------------------------- derived */

export function timezone() {
  return state.config?.identity?.timezone || localTimezone();
}

/** The user's "now" as {key, minutes}, ticked forward by elapsed duration. */
export function nowMark() {
  const iso = state.board.now;
  const base = minutesIntoDay(iso);
  if (base === null) return { key: null, minutes: null };
  const elapsed = Math.max(0, Date.now() - state.boardAt) / 60_000;
  const minutes = base + elapsed;
  // Past midnight the key is stale too; roll it rather than draw the line at 25:00.
  if (minutes >= 1440) return { key: null, minutes: null };
  return { key: dayKey(iso), minutes };
}

export function itemsInBucket(bucket) {
  return state.board.items.filter((i) => i.bucket === bucket && i.state !== 'done' && i.state !== 'dismissed');
}

export function openDrafts() {
  return state.board.drafts.filter((d) => d.state === 'pending' || d.state === 'edited');
}

/** What the rail shows: every bucket, plus the two counts that are not buckets. */
export function railCounts() {
  const counts = state.board.counts || EMPTY_BOARD.counts;
  return {
    ...counts,
    drafts: openDrafts().length,
    events: eventsToday().length,
  };
}

export function eventsToday() {
  const { key } = nowMark();
  if (!key) return [];
  return state.board.events.filter((e) => dayKey(e.starts_at) === key);
}

/* -------------------------------------------------------------- item actions */

export async function setItemState(id, next) {
  const before = state.board.items;
  // Optimistic: the board is the user's own decision surface, and a round-trip
  // of latency on "done" makes it feel broken. A failure puts the row back.
  state.board = {
    ...state.board,
    items: before.map((i) => (i.id === id ? { ...i, state: next } : i)),
  };
  state.rev += 1;
  emit();
  try {
    await api.setItemState(id, next);
    await loadBoard();
  } catch (err) {
    state.board = { ...state.board, items: before };
    notify(`Could not update that item: ${err.message}`, { tone: 'warn' });
  }
  state.rev += 1;
  emit();
}
