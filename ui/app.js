/**
 * ui/app.js — the shell: chrome, routing, and the one render loop.
 *
 * Two decisions here are worth knowing about.
 *
 * 1. **The main view re-renders on `state.rev`, not on every store event.** A
 *    sweep emits progress several times a second; rebuilding the view on each
 *    one would wipe out a draft someone is halfway through typing. The chrome
 *    (counts, sweep line) is cheap and repaints on every event — but the quick
 *    capture panel inside it DOES hold input, so the chrome is updated in
 *    place around a panel that is built exactly once and never rebuilt. And
 *    because "the data changed" can arrive while a cursor is inside a form in
 *    the view too, a board-driven re-render is deferred until that field blurs.
 *
 * 2. **Nothing is ever assembled from a string.** Every node below comes from
 *    ui/lib/dom.js, which has no innerHTML path at all — a subject line is text,
 *    whatever it contains.
 */

import { el, button, meander, replace, focusQuietly } from './lib/dom.js';
import {
  state, subscribe, refresh, watchSweeps, watchBoard, startSweep, railCounts, timezone,
  needsOnboarding, applyAccent, currentAccent, notify, nowMark,
} from './lib/store.js';
import { api, hasToken } from './lib/api.js';
import { BUCKET_LABEL, sweepSummary, tokenLine } from './lib/format.js';
import { humanDelta, formatDay } from './lib/time.js';

import { renderNow } from './views/now.js';
import { renderToday } from './views/today.js';
import { renderOwed } from './views/owed.js';
import { renderCalendar, tickNowLine } from './views/calendar.js';
import { renderSearch } from './views/search.js';
import { renderAsk } from './views/ask.js';
import { renderSettings } from './views/settings.js';
import { renderOnboarding } from './views/onboarding.js';

// Search carries no count. Every other number in the rail is a claim about work
// that is waiting; "how many things could you find" is not one, and a badge
// there would read as one.
const VIEWS = [
  { id: 'now', label: 'Now', render: renderNow, countKey: 'now' },
  { id: 'today', label: 'Today', render: renderToday, countKey: 'today' },
  { id: 'owed', label: 'Owed', render: renderOwed, countKey: 'drafts' },
  { id: 'calendar', label: 'Calendar', render: renderCalendar, countKey: 'events' },
  { id: 'search', label: 'Search', render: renderSearch, countKey: null },
  { id: 'ask', label: 'Ask', render: renderAsk, countKey: null },
  { id: 'settings', label: 'Settings', render: renderSettings, countKey: null },
];

/** Which view owns each bucket, so a count in the rail is also a way in. */
const BUCKET_ROUTE = {
  now: '#/now',
  today: '#/today',
  soon: '#/today',
  money: '#/today',
  waiting: '#/owed',
  promised: '#/owed',
  note: '#/now',
};

const root = document.getElementById('app');

let route = { view: 'now', sub: null };
let lastRenderKey = '';

function parseHash() {
  const raw = (window.location.hash || '#/now').replace(/^#\/?/, '');
  const [view, sub] = raw.split('/');
  if (view === 'welcome') return { view: 'welcome', sub: null };
  const known = VIEWS.find((v) => v.id === view);
  return { view: known ? known.id : 'now', sub: sub || null };
}

function navigate(hash) {
  if (window.location.hash === hash) {
    render({ force: true });
    return;
  }
  window.location.hash = hash;
}

/* ------------------------------------------------------------------ chrome */

/**
 * Say something in a live region, in the one way that actually reaches a screen
 * reader: as a MUTATION of a region that is already in the document.
 *
 * Text baked into a node before it is inserted is never announced, and neither
 * is text carried in on a node that replaces the old one — which is exactly how
 * the sweep line and every toast in this app came to be silent. Both were built
 * complete and then swapped in. So the regions below are created empty, kept
 * for the life of the page where they can be, and filled a frame later.
 * ui/views/ai-access.js does the same thing for the same reason.
 */
const announced = new WeakMap();

function announce(node, text) {
  const value = text || '';
  if (announced.get(node) === value) return;
  announced.set(node, value);
  requestAnimationFrame(() => {
    // A newer announcement may have overtaken this one between frames.
    if (announced.get(node) === value) node.textContent = value;
  });
}

/**
 * The sweep line: one node, built once, repainted in place. Its text is the
 * live region above, so this line is where "Sweeping…", "Sweep finished" and a
 * sweep's failure are spoken as well as shown.
 */
function buildSweepLine() {
  const textNode = el('p', { class: 'sweepline-text mono', 'aria-live': 'polite' });
  // The day's token spend sits OUTSIDE the live region: it is a fact to glance
  // at, not an announcement, and reading it aloud on every sweep tick would
  // bury the progress it sits beside.
  const tokenNode = el('p', { class: 'sweepline-tokens mono' });
  const fillNode = el('div', { class: 'sweepbar-fill', style: { width: '0%' } });
  const barNode = el('div', { class: 'sweepbar' }, fillNode);
  return {
    node: el('div', { class: 'sweepline' }, [textNode, tokenNode, barNode]),
    textNode,
    tokenNode,
    barNode,
    fillNode,
  };
}

function paintSweepLine(parts) {
  const s = state.sweep;
  const last = state.board.runs?.last;

  const text = s.running
    ? (s.message || 'Sweeping…')
    : s.error
      ? s.error
      : last
        ? `Swept ${humanDelta(last.ended_at || last.started_at)}${sweepSummary(last) ? ` · ${sweepSummary(last)}` : ''}`
        : 'Never swept';

  const pct = s.running && s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;

  parts.node.className = `sweepline${s.running ? ' is-running' : ''}${s.error ? ' is-bad' : ''}`;
  parts.textNode.setAttribute('aria-busy', s.running ? 'true' : 'false');
  announce(parts.textNode, text);
  parts.tokenNode.textContent = tokenLine(state.board.tokens, nowMark().key);
  parts.barNode.className = `sweepbar${pct === null && s.running ? ' is-indeterminate' : ''}`;
  parts.fillNode.style.width = s.running ? `${pct ?? 100}%` : '0%';
}

/** Quick capture. It is a note to yourself; the next sweep reads it. */
function capturePanel() {
  const box = el('textarea', {
    class: 'capture-field',
    rows: '2',
    'aria-label': 'A note for the next sweep',
    placeholder: 'Remind me to chase the survey invoice…',
  });
  const status = el('span', { class: 'status', role: 'status' });
  const panel = el('form', { class: 'capture', hidden: true }, [
    box,
    el('div', { class: 'row-inline' }, [
      el('button', { type: 'submit', class: 'btn solid', text: 'Keep it' }),
      status,
    ]),
  ]);
  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    status.textContent = 'Saving…';
    try {
      await api.capture(text);
      box.value = '';
      status.textContent = 'Kept. The next sweep will read it.';
    } catch (err) {
      status.textContent = err.message;
    }
  });

  const toggle = button('Note', {
    class: 'btn quiet',
    'aria-expanded': 'false',
    onClick: (e) => {
      const btn = e.currentTarget;
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
      if (!open) focusQuietly(box);
    },
  });

  return { toggle, panel, box };
}

/**
 * The chrome, built ONCE and updated in place ever after.
 *
 * The old shape — rebuild the whole topbar on every store emit — destroyed the
 * capture panel each time a sweep ticked or the minute clock fired, taking a
 * half-typed note (and the "Kept." status, and keyboard focus) with it. So the
 * nodes that hold or frame user input are created here exactly once and kept;
 * everything around them (date, sweep line, rail counts, tab bar, toast) is
 * either a plain text update or an input-free node that is swapped wholesale.
 */
let chrome = null;

function buildChrome() {
  const capture = capturePanel();
  const dateNode = el('p', { class: 'topbar-date mono' });
  const sweepBtn = button('Sweep now', {
    class: 'btn solid',
    onClick: () => startSweep('auto'),
  });
  const sweep = buildSweepLine();
  const topbarNode = el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar-row' }, [
      el('a', { class: 'wordmark', href: '#/now' }, [
        el('span', { class: 'wordmark-name', text: 'Zelos' }),
        el('span', { class: 'wordmark-greek', 'aria-hidden': 'true', text: 'ΖΗΛΟΣ' }),
      ]),
      dateNode,
      el('div', { class: 'topbar-actions' }, [capture.toggle, sweepBtn]),
    ]),
    capture.panel,
    sweep.node,
  ]);
  return {
    topbarNode,
    dateNode,
    sweepBtn,
    sweep,
    capture,
    railNode: rail(route.view),
    tabbarNode: tabbar(route.view),
    // The toast lives in a slot so showing and clearing it never moves its
    // siblings. The slot is display:contents, so it is not a grid item and the
    // shell's named areas are undisturbed.
    toastSlot: el('div', { class: 'toast-slot' }),
  };
}

function railLink(view, counts, current) {
  const count = view.countKey ? counts[view.countKey] || 0 : 0;
  return el('a', {
    class: `nav-link${view.id === current ? ' is-current' : ''}`,
    href: `#/${view.id}`,
    'aria-current': view.id === current ? 'page' : null,
  }, [
    el('span', { class: 'nav-label', text: view.label }),
    view.countKey ? el('span', { class: `nav-count mono${count ? ' has-some' : ''}`, text: String(count) }) : null,
    el('span', { class: 'nav-marker', 'aria-hidden': 'true' }),
  ]);
}

function rail(current) {
  const counts = railCounts();
  return el('nav', { class: 'rail', 'aria-label': 'Sections' }, [
    el('div', { class: 'nav' }, VIEWS.map((v) => railLink(v, counts, current))),
    meander({ class: 'rail-rule' }),
    el('div', { class: 'rail-buckets' }, [
      el('h2', { class: 'rail-heading', text: 'The board' }),
      el('ul', { class: 'bucket-list' }, Object.keys(BUCKET_LABEL).map((bucket) => el('li', {},
        el('a', { class: `bucket-line${counts[bucket] ? '' : ' is-zero'}`, href: BUCKET_ROUTE[bucket] }, [
          el('span', { class: 'bucket-name', text: BUCKET_LABEL[bucket] }),
          el('span', { class: 'bucket-count mono', text: String(counts[bucket] || 0) }),
        ])))),
    ]),
    // `label` has a default ("Claude"), so it is not evidence of anything —
    // only `configured` is. Naming a model the app cannot call would be a lie
    // told in the calmest possible typeface.
    el('p', { class: 'rail-foot mono', text: state.health?.model?.configured
      ? `${state.health.model.label}${state.health.model.local ? ' · local' : ''}`
      : 'no model yet' }),
  ]);
}

function tabbar(current) {
  const counts = railCounts();
  return el('nav', { class: 'tabbar', 'aria-label': 'Sections' }, VIEWS.map((v) => {
    const count = v.countKey ? counts[v.countKey] || 0 : 0;
    return el('a', {
      class: `tab${v.id === current ? ' is-current' : ''}`,
      href: `#/${v.id}`,
      'aria-current': v.id === current ? 'page' : null,
    }, [
      el('span', { class: 'tab-label', text: v.label }),
      // Always present, even when empty: an absent count row makes that tab's
      // label sit a line lower than its neighbours'.
      el('span', { class: 'tab-count mono', text: v.countKey && count ? String(count) : ' ' }),
      el('span', { class: 'tab-marker', 'aria-hidden': 'true' }),
    ]);
  }));
}

/**
 * The toast, as {node, text}. Its message node is left EMPTY here and filled by
 * announce() once the toast is in the document — a role="status" element that
 * arrives with its text already written is read by nobody, which meant every
 * failed save and every Undo offer in this app was silent.
 */
function toastBar() {
  if (!state.toast) return null;
  const action = state.toast.action;
  const text = el('p');
  const node = el('div', { class: `toast toast-${state.toast.tone}`, role: 'status' }, [
    text,
    action ? button(action.label, {
      class: 'link',
      onClick: () => {
        // Clear first: the action usually re-renders, and a toast describing an
        // undone thing must not outlive the undo it offered.
        const run = action.run;
        notify(null);
        run();
      },
    }) : null,
    button('Dismiss', { class: 'link', onClick: () => notify(null) }),
  ]);
  return { node, text };
}

/* ------------------------------------------------------------- whole screens */

function bootScreen() {
  return el('div', { class: 'screen' }, [
    el('p', { class: 'screen-mark', text: 'ΖΗΛΟΣ' }),
    meander(),
    el('p', { class: 'screen-line', text: 'Opening the board…' }),
  ]);
}

function fatalScreen() {
  const f = state.fatal;
  return el('div', { class: 'screen' }, [
    el('p', { class: 'screen-mark', text: 'ΖΗΛΟΣ' }),
    meander(),
    el('h1', { class: 'screen-title', text: f.title }),
    el('p', { class: 'screen-line', text: f.detail }),
    el('div', { class: 'row-inline' }, [
      button('Try again', { class: 'btn solid', onClick: () => refresh() }),
    ]),
  ]);
}

function noTokenScreen() {
  return el('div', { class: 'screen' }, [
    el('p', { class: 'screen-mark', text: 'ΖΗΛΟΣ' }),
    meander(),
    el('h1', { class: 'screen-title', text: 'This page has no session key' }),
    el('p', { class: 'screen-line', text: 'Zelos mints a token every launch and puts it in the URL it printed. Any page in your browser can reach 127.0.0.1, so without that token this one is refused — which is the point. Open the address from the terminal that started Zelos.' }),
  ]);
}

/* ------------------------------------------------------------------- render */

function renderKey() {
  return [
    route.view,
    route.sub || '',
    state.phase,
    state.rev,
    state.fatal ? '1' : '0',
    needsOnboarding() ? 'ob' : '-',
    // Deliberately not the toast: it lives in the chrome, which repaints on
    // every event, so putting it here would rebuild the view — and a draft
    // someone is typing — every time a save failed.
  ].join('|');
}

function currentView() {
  const ctx = {
    tz: timezone(),
    navigate,
    sub: route.sub,
    rerender: () => render({ force: true }),
  };
  if (route.view === 'welcome' || needsOnboarding()) return renderOnboarding(ctx);
  const view = VIEWS.find((v) => v.id === route.view) || VIEWS[0];
  return view.render(ctx);
}

let main = null;
let chromeWrap = null;
/** 'chrome' | 'bare' | null — which skeleton is currently in the root. */
let layout = null;
/** The toast object last painted into its slot. Reference identity is the
 *  change signal, because notify() always mints a fresh object. */
let paintedToast = null;

/**
 * A board refresh that lands while the cursor is inside a form field would
 * rebuild the view under the user's hands: the Owed draft they are typing, a
 * settings field half-filled, every open disclosure snapped shut. So a render
 * caused by data (a background sweep finishing, mostly) is QUEUED while a text
 * field inside <main> has focus, and runs when that field blurs. A forced
 * render — the user's own navigation — is never deferred: they asked for it.
 */
let renderQueued = false;

function editingInMain() {
  const active = document.activeElement;
  if (!active || !main || !main.contains(active)) return false;
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT';
}

/**
 * When the queued render is allowed to run. Two things must both be over: the
 * editing (no text field in <main> holds focus) and the CLICK THAT ENDED IT.
 * A click on a button blurs the field at pointerdown, and flushing right then
 * would replace that button before pointerup — the click the user is mid-way
 * through would land on nothing. So while the pointer is down the flush waits,
 * and the pointerup handler re-schedules it for after the click has dispatched.
 */
let pointerHeld = false;

function flushQueuedRender() {
  if (renderQueued && !pointerHeld && !editingInMain()) {
    renderQueued = false;
    render({ force: true });
  }
}

document.addEventListener('pointerdown', () => { pointerHeld = true; });
document.addEventListener('pointerup', () => {
  pointerHeld = false;
  // setTimeout from inside pointerup runs after the click event dispatches,
  // so the button the user pressed is still the button they release on.
  if (renderQueued) setTimeout(flushQueuedRender, 0);
});
document.addEventListener('pointercancel', () => {
  pointerHeld = false;
  if (renderQueued) setTimeout(flushQueuedRender, 0);
});

document.addEventListener('focusout', () => {
  if (!renderQueued) return;
  // Focus may be mid-flight to the next field of the same form; let it land
  // before deciding, or tabbing between draft fields would flush the render.
  setTimeout(flushQueuedRender, 0);
});

function render({ force = false } = {}) {
  const key = renderKey();
  if (!force && key === lastRenderKey && main) {
    paintChrome();
    return;
  }
  if (!force && layout === 'chrome' && state.phase === 'ready' && editingInMain()) {
    renderQueued = true;
    paintChrome();
    return;
  }
  renderQueued = false;
  lastRenderKey = key;

  if (!hasToken()) {
    replace(root, noTokenScreen());
    main = null;
    chromeWrap = null;
    layout = null;
    return;
  }
  if (state.phase === 'boot') {
    replace(root, bootScreen());
    main = null;
    chromeWrap = null;
    layout = null;
    return;
  }
  if (state.phase === 'down' && state.fatal) {
    replace(root, fatalScreen());
    main = null;
    chromeWrap = null;
    layout = null;
    return;
  }

  const onboarding = route.view === 'welcome' || needsOnboarding();
  if (onboarding) {
    // The flow gets the whole window: no rail, no tab bar, nothing to click past.
    main = el('main', { class: 'main', id: 'main', tabindex: '-1' }, currentView());
    chromeWrap = null;
    layout = 'bare';
    replace(root, el('div', { class: 'shell shell-bare' }, main));
    return;
  }

  // The skeleton survives re-renders. Rebuilding it would re-parent the topbar
  // — and re-parenting a focused textarea blurs it, which is the note-wipe bug
  // in a different coat. Only the view's own content is replaced.
  if (layout !== 'chrome') {
    main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
    chromeWrap = el('div', { class: 'chrome' });
    layout = 'chrome';
    replace(root, el('div', { class: 'shell' }, [
      el('a', { class: 'skip-link', href: '#main', text: 'Skip to content' }),
      chromeWrap,
      main,
    ]));
    // Arriving at the board from a different skeleton — onboarding, mostly —
    // is a navigation in everything but the hash, and it inherits whatever
    // scroll depth the last screen was read at. onRoute() cannot see this
    // transition (the view name is 'now' on both sides), so the top-of-page
    // rule is applied here, where the skeleton itself changes hands.
    window.scrollTo(0, 0);
  }
  replace(main, currentView());
  paintChrome();
}

/**
 * Chrome repaints on every store event — but only around the capture panel,
 * never through it. The panel and its toggle are the same nodes for the life of
 * the page; the date, the sweep button and the whole sweep line are text and
 * attribute updates on nodes that also persist (the sweep line has to persist —
 * its text is a live region, and a region that is replaced rather than mutated
 * announces nothing); the rail, tab bar and toast hold no input, so they are
 * rebuilt and swapped in place with replaceWith, which cannot touch anything a
 * person is typing into.
 */
function paintChrome() {
  if (!chromeWrap) return;
  if (!chrome) chrome = buildChrome();
  if (chrome.topbarNode.parentNode !== chromeWrap) {
    replace(chromeWrap, [chrome.topbarNode, chrome.railNode, chrome.tabbarNode, chrome.toastSlot]);
  }

  // The date comes from the ROLLED key, not from the board's `now` string: a
  // window open past midnight has a stale string and a correct key, and the
  // header must say the day the reader is living in.
  const nm = nowMark();
  chrome.dateNode.textContent = nm.key ? formatDay(nm.key) : '';
  chrome.sweepBtn.textContent = state.sweep.running ? 'Sweeping…' : 'Sweep now';
  chrome.sweepBtn.disabled = state.sweep.running;

  paintSweepLine(chrome.sweep);

  const freshRail = rail(route.view);
  chrome.railNode.replaceWith(freshRail);
  chrome.railNode = freshRail;

  const freshTabs = tabbar(route.view);
  chrome.tabbarNode.replaceWith(freshTabs);
  chrome.tabbarNode = freshTabs;

  // The toast is rebuilt only when the toast itself changed. paintChrome runs
  // on every emit — sweep progress arrives several times a second — and
  // rebuilding an action toast that often would replace its Undo button under
  // a hovering cursor, mid-press.
  if (paintedToast !== state.toast) {
    paintedToast = state.toast;
    const built = toastBar();
    replace(chrome.toastSlot, built && built.node);
    if (built) announce(built.text, state.toast.message);
  }
  measureTopbar();
}

/**
 * The one document-level keyboard shortcut: Escape closes the capture panel
 * and hands focus back to the button that opened it, so the keyboard user is
 * exactly where they were. It lives on the document because the key should
 * work from inside the textarea and from anywhere else alike; there are no
 * other shortcuts, and this listener must stay the only one.
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!chrome || chrome.capture.panel.hidden || !chrome.capture.panel.isConnected) return;
  chrome.capture.panel.hidden = true;
  chrome.capture.toggle.setAttribute('aria-expanded', 'false');
  focusQuietly(chrome.capture.toggle);
});

/**
 * The rail sticks below the header, and the header's height is not a constant:
 * a wrapped sweep error makes it two lines taller, and narrowing the window
 * re-wraps the header row.
 *
 * Measuring only after a paint is not enough — nothing repaints on a resize, so
 * the rail would keep a stale offset and either slide under the header or hang
 * a gap below it until the next store event. An observer on the bar itself
 * catches every cause of a height change: reflow, resize, and a font landing.
 */
const topbarWatcher = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
    const height = entries[entries.length - 1]?.target.getBoundingClientRect().height;
    if (height) document.documentElement.style.setProperty('--topbar-h', `${Math.round(height)}px`);
  })
  : null;

function measureTopbar() {
  const bar = chromeWrap?.querySelector('.topbar');
  if (!bar) return;
  document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  // The topbar node persists now, but re-observing is cheap and keeps this
  // correct if the shell was ever rebuilt around it.
  topbarWatcher?.disconnect();
  topbarWatcher?.observe(bar);
}

function onRoute() {
  const before = route.view;
  route = parseHash();
  render({ force: true });
  if (before !== route.view) {
    // A new view starts at its top. Same-view re-renders (a deferred board
    // refresh, a settings save) deliberately do NOT pass through here, so they
    // never yank the scroll position out from under the reader.
    window.scrollTo(0, 0);
    if (main) focusQuietly(main);
  }
}

/* --------------------------------------------------------------------- boot */

applyAccent(currentAccent());
route = parseHash();
render();

window.addEventListener('hashchange', onRoute);
subscribe(() => {
  applyAccent(currentAccent());
  render();
});

// Keep "3h ago", the header date and the calendar's now-line honest without a
// data refetch. paintChrome is safe on a timer now: it updates text around the
// capture panel instead of rebuilding the topbar, so a half-typed note never
// notices the minute passing.
setInterval(() => {
  paintChrome();
  tickNowLine();
}, 60_000);

refresh().then(() => {
  watchSweeps();
  // ...and a slow heartbeat under it, so a window left open overnight wakes up
  // on the right day instead of holding yesterday's board until someone
  // reloads. It refetches through the store, so it defers around a half-typed
  // draft exactly as a finished sweep does.
  watchBoard();
});
