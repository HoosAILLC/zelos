/**
 * ui/app.js — the shell: chrome, routing, and the one render loop.
 *
 * Two decisions here are worth knowing about.
 *
 * 1. **The main view re-renders on `state.rev`, not on every store event.** A
 *    sweep emits progress several times a second; rebuilding the view on each
 *    one would wipe out a draft someone is halfway through typing. The chrome
 *    (counts, sweep line) is cheap and holds no input, so it repaints on every
 *    event; the view waits for the data underneath it to actually change.
 *
 * 2. **Nothing is ever assembled from a string.** Every node below comes from
 *    ui/lib/dom.js, which has no innerHTML path at all — a subject line is text,
 *    whatever it contains.
 */

import { el, button, meander, replace, focusQuietly } from './lib/dom.js';
import {
  state, subscribe, refresh, watchSweeps, startSweep, railCounts, timezone,
  needsOnboarding, applyAccent, currentAccent, notify, nowMark,
} from './lib/store.js';
import { api, hasToken } from './lib/api.js';
import { BUCKET_LABEL, sweepSummary } from './lib/format.js';
import { humanDelta, formatDay } from './lib/time.js';

import { renderNow } from './views/now.js';
import { renderToday } from './views/today.js';
import { renderOwed } from './views/owed.js';
import { renderCalendar, tickNowLine } from './views/calendar.js';
import { renderAsk } from './views/ask.js';
import { renderSettings } from './views/settings.js';
import { renderOnboarding } from './views/onboarding.js';

const VIEWS = [
  { id: 'now', label: 'Now', render: renderNow, countKey: 'now' },
  { id: 'today', label: 'Today', render: renderToday, countKey: 'today' },
  { id: 'owed', label: 'Owed', render: renderOwed, countKey: 'drafts' },
  { id: 'calendar', label: 'Calendar', render: renderCalendar, countKey: 'events' },
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

function sweepLine() {
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

  return el('div', { class: `sweepline${s.running ? ' is-running' : ''}${s.error ? ' is-bad' : ''}` }, [
    el('p', {
      class: 'sweepline-text mono',
      'aria-live': 'polite',
      'aria-busy': s.running ? 'true' : 'false',
      text,
    }),
    el('div', { class: `sweepbar${pct === null && s.running ? ' is-indeterminate' : ''}` },
      el('div', { class: 'sweepbar-fill', style: { width: s.running ? `${pct ?? 100}%` : '0%' } })),
  ]);
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

  return { toggle, panel };
}

function topbar() {
  const { toggle, panel } = capturePanel();
  const nm = nowMark();

  return el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar-row' }, [
      el('a', { class: 'wordmark', href: '#/now' }, [
        el('span', { class: 'wordmark-name', text: 'Zelos' }),
        el('span', { class: 'wordmark-greek', 'aria-hidden': 'true', text: 'ΖΗΛΟΣ' }),
      ]),
      el('p', { class: 'topbar-date mono', text: nm.key ? formatDay(state.board.now) : '' }),
      el('div', { class: 'topbar-actions' }, [
        toggle,
        button(state.sweep.running ? 'Sweeping…' : 'Sweep now', {
          class: 'btn solid',
          disabled: state.sweep.running,
          onClick: () => startSweep('auto'),
        }),
      ]),
    ]),
    panel,
    sweepLine(),
  ]);
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
      el('span', { class: 'tab-count mono', text: v.countKey && count ? String(count) : ' ' }),
      el('span', { class: 'tab-marker', 'aria-hidden': 'true' }),
    ]);
  }));
}

function toastBar() {
  if (!state.toast) return null;
  return el('div', { class: `toast toast-${state.toast.tone}`, role: 'status' }, [
    el('p', { text: state.toast.message }),
    button('Dismiss', { class: 'link', onClick: () => notify(null) }),
  ]);
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

function render({ force = false } = {}) {
  const key = renderKey();
  if (!force && key === lastRenderKey && main) {
    paintChrome();
    return;
  }
  lastRenderKey = key;

  if (!hasToken()) {
    replace(root, noTokenScreen());
    main = null;
    return;
  }
  if (state.phase === 'boot') {
    replace(root, bootScreen());
    main = null;
    return;
  }
  if (state.phase === 'down' && state.fatal) {
    replace(root, fatalScreen());
    main = null;
    return;
  }

  const onboarding = route.view === 'welcome' || needsOnboarding();
  main = el('main', { class: 'main', id: 'main', tabindex: '-1' }, currentView());

  if (onboarding) {
    // The flow gets the whole window: no rail, no tab bar, nothing to click past.
    chromeWrap = null;
    replace(root, el('div', { class: 'shell shell-bare' }, main));
    return;
  }

  chromeWrap = el('div', { class: 'chrome' });
  replace(root, el('div', { class: 'shell' }, [
    el('a', { class: 'skip-link', href: '#main', text: 'Skip to content' }),
    chromeWrap,
    main,
  ]));
  paintChrome();
}

/** Chrome repaints on every store event; it holds no user input. */
function paintChrome() {
  if (!chromeWrap) return;
  replace(chromeWrap, [topbar(), rail(route.view), tabbar(route.view), toastBar()]);
  measureTopbar();
}

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
  // paintChrome builds a new topbar node each time, so the observer follows it.
  topbarWatcher?.disconnect();
  topbarWatcher?.observe(bar);
}

function onRoute() {
  const before = route.view;
  route = parseHash();
  render({ force: true });
  if (before !== route.view && main) focusQuietly(main);
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

// Keep "3h ago" and the calendar's now-line honest without a data refetch —
// and without re-rendering the calendar, which would throw the user's scroll
// position back to the top every sixty seconds.
setInterval(() => {
  paintChrome();
  tickNowLine();
}, 60_000);

refresh().then(() => {
  watchSweeps();
});
