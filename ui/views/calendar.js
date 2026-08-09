/**
 * ui/views/calendar.js — a real time grid.
 *
 * The rule that governs every number in this file: a chip's position comes from
 * the wall-clock minutes in the event's own ISO string, read with a regex
 * (ui/lib/time.js, mirroring core/time.mjs). Passing `2026-08-11T14:00:00-04:00`
 * through `new Date()` and asking for `getHours()` re-expresses it in the
 * viewer's zone — open the same calendar on a laptop set to UTC and every chip
 * slides four hours. So Date is never consulted for placement here.
 *
 * Overlaps are packed cluster-then-greedy-column (see format.js `packColumns`),
 * and month cells sort conflicts first so a triple-booked day cannot hide behind
 * "+4".
 */

import { el, button, meander } from '../lib/dom.js';
import { emptyState } from '../lib/items.js';
import {
  dayKey, addDaysToKey, startOfWeekKey, weekdayOfKey, dayName, monthName, formatTime,
} from '../lib/time.js';
import { eventSpanOnDay, eventTimeLabel, packColumns, conflictsFirst } from '../lib/format.js';
import { state, nowMark } from '../lib/store.js';

const MODES = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

/**
 * View state survives re-renders; it is a place you are looking, not data.
 * A phone opens on Day: seven columns in 375px is a grid you can see but not
 * read, and Week is one tap away.
 */
const view = {
  mode: window.matchMedia?.('(min-width: 48rem)').matches === false ? 'day' : 'week',
  anchor: null,
};

/** Where the grid scrolls to on open — 7am, not midnight. */
const DEFAULT_SCROLL_HOUR = 7;
const MIN_CHIP_MINUTES = 22;

function anchorKey() {
  const today = nowMark().key || dayKey(state.board.now) || dayKey(new Date().toISOString());
  if (!view.anchor) view.anchor = today;
  return view.anchor;
}

function move(days) {
  view.anchor = addDaysToKey(anchorKey(), days);
}

function keysForRange() {
  const key = anchorKey();
  if (view.mode === 'day') return [key];
  if (view.mode === 'week') {
    const start = startOfWeekKey(key, 0);
    return Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
  }
  // Month: whole weeks covering the month, so the grid is always rectangular.
  const first = `${key.slice(0, 7)}-01`;
  const start = startOfWeekKey(first, 0);
  const cells = [];
  for (let i = 0; i < 42; i += 1) cells.push(addDaysToKey(start, i));
  // Trim a trailing all-next-month week; six rows are only needed sometimes.
  while (cells.length > 35 && cells[cells.length - 7].slice(0, 7) !== key.slice(0, 7)) {
    cells.length -= 7;
  }
  return cells;
}

/** Every event that touches `key`, already clamped to that day's minutes. */
function spansForDay(key) {
  const out = [];
  for (const event of state.board.events) {
    const span = eventSpanOnDay(event, key);
    if (span) out.push({ event, ...span });
  }
  return out;
}

function rangeTitle(keys) {
  if (view.mode === 'day') {
    const k = keys[0];
    const [y, m, d] = k.split('-').map(Number);
    return `${dayName(weekdayOfKey(k))}, ${monthName(m)} ${d}, ${y}`;
  }
  if (view.mode === 'week') {
    const [a, b] = [keys[0], keys[keys.length - 1]];
    const [ya, ma, da] = a.split('-').map(Number);
    const [yb, mb, db] = b.split('-').map(Number);
    const left = `${monthName(ma).slice(0, 3)} ${da}`;
    const right = ma === mb ? `${db}` : `${monthName(mb).slice(0, 3)} ${db}`;
    return `${left} – ${right}${ya === yb ? `, ${yb}` : `, ${ya} – ${yb}`}`;
  }
  const [y, m] = anchorKey().split('-').map(Number);
  return `${monthName(m)} ${y}`;
}

/* ------------------------------------------------------------------ chrome */

function segmented(rerender) {
  const group = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Calendar range' },
    MODES.map((mode) => el('button', {
      type: 'button',
      class: 'seg',
      'aria-pressed': view.mode === mode.id ? 'true' : 'false',
      onclick: () => { view.mode = mode.id; rerender(); },
      text: mode.label,
    })));
  return group;
}

function toolbar(keys, rerender) {
  const step = view.mode === 'day' ? 1 : view.mode === 'week' ? 7 : 0;
  return el('div', { class: 'cal-bar' }, [
    el('div', { class: 'cal-nav' }, [
      button('‹', {
        class: 'btn icon',
        'aria-label': 'Previous',
        onClick: () => {
          if (step) move(-step);
          else {
            const [y, m] = anchorKey().split('-').map(Number);
            const pm = m === 1 ? 12 : m - 1;
            const py = m === 1 ? y - 1 : y;
            view.anchor = `${py}-${String(pm).padStart(2, '0')}-01`;
          }
          rerender();
        },
      }),
      button('Today', {
        class: 'btn quiet',
        onClick: () => { view.anchor = nowMark().key || dayKey(state.board.now); rerender(); },
      }),
      button('›', {
        class: 'btn icon',
        'aria-label': 'Next',
        onClick: () => {
          if (step) move(step);
          else {
            const [y, m] = anchorKey().split('-').map(Number);
            const nm = m === 12 ? 1 : m + 1;
            const ny = m === 12 ? y + 1 : y;
            view.anchor = `${ny}-${String(nm).padStart(2, '0')}-01`;
          }
          rerender();
        },
      }),
    ]),
    el('h2', { class: 'cal-title', text: rangeTitle(keys) }),
    segmented(rerender),
  ]);
}

/* ----------------------------------------------------------------- time grid */

function chip({ event, start, end, col, cols }, { today, nowMinutes, compact }) {
  const height = Math.max(MIN_CHIP_MINUTES, end - start);
  const past = today && nowMinutes !== null && nowMinutes >= end;
  const live = today && nowMinutes !== null && nowMinutes >= start && nowMinutes < end;
  const width = 100 / cols;
  // Under about 45 minutes the chip is one line tall, so stacking time above
  // title hides the title entirely. Those chips go horizontal instead.
  const short = height < 45;

  return el('article', {
    class: `chip-ev${short ? ' is-short' : ''}${past ? ' is-past' : ''}${live ? ' is-live' : ''}${cols > 1 ? ' is-packed' : ''}`,
    style: {
      top: `calc(${start} * var(--min-h))`,
      height: `calc(${height} * var(--min-h))`,
      left: `${col * width}%`,
      width: `${width}%`,
    },
    title: `${eventTimeLabel(event)} — ${event.title || '(untitled)'}`,
  }, [
    el('span', { class: 'chip-time mono', text: formatTime(event.starts_at) }),
    el('span', { class: 'chip-title', text: event.title || '(untitled)' }),
    !compact && event.location ? el('span', { class: 'chip-where', text: event.location }) : null,
  ]);
}

function dayColumn(key, { todayKeyStr, nowMinutes, compact }) {
  const spans = spansForDay(key).filter((s) => !s.allDay);
  const packed = packColumns(spans);
  const isToday = key === todayKeyStr;

  return el('div', {
    class: `cal-col${isToday ? ' is-today' : ''}`,
    dataset: { day: key },
  }, [
    ...packed.map((entry) => chip(entry, { today: isToday, nowMinutes, compact })),
    isToday && nowMinutes !== null
      ? el('div', {
        class: 'now-line',
        style: { top: `calc(${nowMinutes} * var(--min-h))` },
        'aria-hidden': 'true',
      }, el('span', { class: 'now-dot' }))
      : null,
  ]);
}

function allDayStrip(keys) {
  const rows = keys.map((key) => spansForDay(key).filter((s) => s.allDay));
  if (!rows.some((r) => r.length)) return null;
  return el('div', { class: 'cal-allday' }, [
    el('div', { class: 'cal-gutter-cell mono', text: 'all day' }),
    el('div', { class: 'cal-allday-days', style: { '--cols': String(keys.length) } },
      rows.map((row) => el('div', { class: 'cal-allday-cell' },
        row.map(({ event }) => el('span', { class: 'chip-allday', text: event.title || '(untitled)' }))))),
  ]);
}

function timeGrid(keys) {
  const { key: todayKeyStr, minutes: nowMinutes } = nowMark();
  const compact = keys.length > 1;

  const head = el('div', { class: 'cal-head', style: { '--cols': String(keys.length) } }, [
    el('div', { class: 'cal-gutter-cell' }),
    el('div', { class: 'cal-head-days' }, keys.map((key) => {
      const [, , d] = key.split('-').map(Number);
      return el('div', { class: `cal-head-cell${key === todayKeyStr ? ' is-today' : ''}` }, [
        el('span', { class: 'cal-head-dow', text: dayName(weekdayOfKey(key)).slice(0, 3) }),
        el('span', { class: 'cal-head-num mono', text: String(d) }),
      ]);
    })),
  ]);

  const hours = el('div', { class: 'cal-gutter' }, Array.from({ length: 24 }, (_, h) => el('div', {
    class: 'cal-hour mono',
    style: { top: `calc(${h * 60} * var(--min-h))` },
    text: h === 0 ? '' : formatTime(`2026-01-01T${String(h).padStart(2, '0')}:00:00`),
  })));

  const days = el('div', { class: 'cal-days', style: { '--cols': String(keys.length) } },
    keys.map((key) => dayColumn(key, { todayKeyStr, nowMinutes, compact })));

  const scroller = el('div', { class: 'cal-scroll' }, [
    el('div', { class: 'cal-body' }, [hours, days]),
  ]);

  // Open at the working day rather than at 00:00.
  //
  // Two frames, not one. A rAF callback runs BEFORE the layout of the frame it
  // belongs to, so a scroller attached in this same task still reports
  // scrollHeight === clientHeight there; the assignment is silently clamped to
  // zero and the grid opens at midnight. The second frame is after layout.
  //
  // Even two is not a guarantee: if the grid has not been given its height yet
  // the assignment clamps to zero again, silently, and the user gets midnight.
  // So the result is checked and retried a bounded number of times — never a
  // loop, and it stops the moment the scroller is genuinely scrollable.
  /**
   * How many title lines each chip can actually show.
   *
   * Measured rather than derived: the chip's height comes from `--min-h`, which
   * differs between the week grid and the day grid, and a constant copied out of
   * the stylesheet would be wrong in one of them the first time either changed.
   * The measurement runs after layout, once per render.
   */
  const budgetChipTitles = () => {
    for (const title of days.querySelectorAll('.chip-title')) {
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) continue;
      title.style.setProperty('--chip-lines', String(Math.max(1, Math.floor(title.clientHeight / lineHeight))));
    }
  };

  const openAtWorkingDay = (attempt = 0) => {
    if (!scroller.isConnected) return;
    const minH = parseFloat(getComputedStyle(scroller).getPropertyValue('--min-h')) || 0.8;
    const target = nowMinutes !== null && keys.includes(todayKeyStr)
      ? Math.max(0, nowMinutes - 120)
      : DEFAULT_SCROLL_HOUR * 60;
    scroller.scrollTop = target * minH;
    if (scroller.scrollTop === 0 && target > 0 && attempt < 5) {
      requestAnimationFrame(() => openAtWorkingDay(attempt + 1));
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(() => {
    budgetChipTitles();
    openAtWorkingDay();
  }));

  return el('div', { class: `cal-grid mode-${view.mode}`, style: { '--cols': String(keys.length) } }, [
    head,
    allDayStrip(keys),
    scroller,
  ]);
}

/* --------------------------------------------------------------------- month */

const MONTH_VISIBLE = 3;

function monthCell(key, { todayKeyStr, monthPrefix }) {
  const spans = conflictsFirst(spansForDay(key));
  const [, , d] = key.split('-').map(Number);
  const outside = key.slice(0, 7) !== monthPrefix;
  const hasConflict = spans.some((s) => s.conflict);

  const list = el('div', { class: 'month-list' });
  const shown = spans.slice(0, MONTH_VISIBLE);
  for (const span of shown) list.appendChild(monthEntry(span));

  const cell = el('div', {
    class: `month-cell${outside ? ' is-outside' : ''}${key === todayKeyStr ? ' is-today' : ''}${hasConflict ? ' has-conflict' : ''}`,
  }, [
    el('div', { class: 'month-num-row' }, [
      el('span', { class: 'month-num mono', text: String(d) }),
      hasConflict ? el('span', { class: 'month-flag', title: 'Overlapping events', text: 'clash' }) : null,
    ]),
    list,
  ]);

  if (spans.length > MONTH_VISIBLE) {
    const rest = spans.slice(MONTH_VISIBLE);
    const restWrap = el('div', { class: 'month-list', hidden: true }, rest.map(monthEntry));
    list.after(restWrap);
    cell.appendChild(el('button', {
      type: 'button',
      class: 'month-more',
      'aria-expanded': 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        restWrap.hidden = open;
        this.textContent = open ? `+${rest.length} more` : 'fewer';
      },
    }, `+${rest.length} more`));
  }
  return cell;
}

function monthEntry({ event, conflict }) {
  return el('div', { class: `month-ev${conflict ? ' is-conflict' : ''}` }, [
    el('span', { class: 'month-ev-time mono', text: event.all_day ? '' : formatTime(event.starts_at) }),
    el('span', { class: 'month-ev-title', text: event.title || '(untitled)' }),
  ]);
}

function monthGrid(keys) {
  const { key: todayKeyStr } = nowMark();
  const monthPrefix = anchorKey().slice(0, 7);
  return el('div', { class: 'month' }, [
    el('div', { class: 'month-dow' }, Array.from({ length: 7 }, (_, i) =>
      el('span', { class: 'month-dow-cell', text: dayName(i).slice(0, 3) }))),
    el('div', { class: 'month-cells' }, keys.map((key) => monthCell(key, { todayKeyStr, monthPrefix }))),
  ]);
}

/**
 * Move the now-line without rebuilding the grid.
 *
 * Re-rendering the calendar once a minute would be simpler and would also throw
 * the user's scroll position back to the top every sixty seconds. The line is
 * the only thing that actually changed, so it is the only thing that moves.
 */
export function tickNowLine() {
  const line = document.querySelector('.cal-days .now-line');
  if (!line) return;
  const { minutes } = nowMark();
  if (minutes === null) {
    line.remove();
    return;
  }
  line.style.top = `calc(${minutes} * var(--min-h))`;
}

/* -------------------------------------------------------------------- render */

export function renderCalendar(ctx) {
  const rerender = ctx.rerender;
  const keys = keysForRange();
  const body = el('div', { class: 'view view-calendar' }, [toolbar(keys, rerender), meander()]);

  // "No calendar connected" is a claim about the CONFIG, so it branches on the
  // config. Branching on the events list alone told a connected calendar with a
  // quiet fortnight that it did not exist — and hid the grid, which was the
  // only way to scroll to a week that has something in it. The events check
  // that remains covers the one case config can't: the demo seeds events into
  // the database without adding a config entry, and a demo board with a week
  // of meetings deserves its grid, not a setup card.
  if ((state.config?.calendars?.length || 0) === 0 && !state.board.events.length) {
    body.appendChild(emptyState({
      title: 'No calendar connected',
      detail: 'Add an .ics subscription, a CalDAV account or a local file in Settings, and your week appears here. The grid is drawn from the times in your calendar, in your calendar’s own zone.',
      action: button('Connect a calendar', { class: 'btn solid', onClick: () => ctx.navigate('#/settings/calendars') }),
    }));
    return body;
  }

  body.appendChild(view.mode === 'month' ? monthGrid(keys) : timeGrid(keys));
  return body;
}
