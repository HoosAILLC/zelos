/**
 * ui/lib/items.js — the item, rendered.
 *
 * One row shape, two sizes: the Now hero and the dense list row. Both are built
 * here so "done" behaves identically everywhere.
 *
 * The done control is a `<button role="checkbox">`, never an `<input>` inside a
 * `<summary>`: a checkbox inside a summary toggles the disclosure on the way to
 * toggling itself, so ticking a row folds it shut under your hand. The tick and
 * the disclosure are separate buttons, side by side, and neither contains the
 * other.
 */

import { el, button, meander } from './dom.js';
import { setItemState } from './store.js';
import { todayKey } from './time.js';
import {
  BUCKET_TAG, severityOf, carriedFor, dueLabel, isOverdue, personLabel,
} from './format.js';

/** A safe external link, or null. The server already screened it; so do we. */
function linkFor(item) {
  const raw = item?.link;
  if (typeof raw !== 'string' || !raw) return null;
  let url;
  try {
    url = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
  return url.href;
}

function tick(item, { label = 'Mark done' } = {}) {
  const done = item.state === 'done';
  const node = el('button', {
    type: 'button',
    class: 'tick',
    role: 'checkbox',
    'aria-checked': done ? 'true' : 'false',
    'aria-label': `${label}: ${item.headline || 'item'}`,
    onclick: () => setItemState(item.id, done ? 'open' : 'done'),
  }, el('span', { class: 'tick-mark', 'aria-hidden': 'true' }));
  return node;
}

function metaLine(item, { tz }) {
  const bits = [];
  const due = dueLabel(item);
  if (due) bits.push({ text: due, class: isOverdue(item) ? 'meta-hot' : '' });
  const who = personLabel(item);
  if (who) bits.push({ text: who, class: '' });
  const carried = carriedFor(item, todayKey(tz));
  if (carried) bits.push({ text: carried, class: 'meta-carried' });
  if (!bits.length) return null;
  return el('p', { class: 'meta mono' }, bits.map((b, i) => el('span', {
    class: `meta-bit ${b.class}`.trim(),
    text: i === 0 ? b.text : `· ${b.text}`,
  })));
}

/**
 * The extra controls. Behind a disclosure because "done" is the answer 90% of
 * the time and three equal buttons make you read all three.
 */
function moreControls(item) {
  const panel = el('div', { class: 'row-more', hidden: true }, [
    button('Snooze', { class: 'btn quiet', onClick: () => setItemState(item.id, 'snoozed') }),
    button('Not a thing', {
      class: 'btn quiet',
      onClick: () => setItemState(item.id, 'dismissed'),
      title: 'Dismiss — it stays in the database, it just leaves the board',
    }),
    item.state === 'snoozed'
      ? button('Wake', { class: 'btn quiet', onClick: () => setItemState(item.id, 'open') })
      : null,
  ]);

  const toggle = el('button', {
    type: 'button',
    class: 'disclosure',
    'aria-expanded': 'false',
    'aria-label': `More options for ${item.headline || 'this item'}`,
    onclick() {
      const open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
    },
  }, el('span', { class: 'disclosure-dots', 'aria-hidden': 'true', text: '···' }));

  return { toggle, panel };
}

/** The dense row used by Today, Owed and the Now list. */
export function itemRow(item, { tz, showBucket = true } = {}) {
  const sev = severityOf(item);
  const { toggle, panel } = moreControls(item);
  const link = linkFor(item);

  return el('article', {
    class: `row sev-${sev}${item.state === 'snoozed' ? ' is-snoozed' : ''}`,
    dataset: { bucket: item.bucket },
  }, [
    el('div', { class: 'row-main' }, [
      tick(item),
      el('div', { class: 'row-body' }, [
        el('div', { class: 'row-head' }, [
          el('h3', { class: 'headline', text: item.headline || '(no headline)' }),
          showBucket ? el('span', { class: 'chip', text: BUCKET_TAG[item.bucket] || item.bucket }) : null,
        ]),
        item.why ? el('p', { class: 'why', text: item.why }) : null,
        metaLine(item, { tz }),
      ]),
      el('div', { class: 'row-tools' }, [
        link ? el('a', {
          class: 'btn quiet',
          href: link,
          rel: 'noreferrer noopener',
          target: '_blank',
          text: 'Open',
        }) : null,
        toggle,
      ]),
    ]),
    panel,
  ]);
}

/**
 * The hero. One item, the one the model ranked first — given the size that says
 * "if you do one thing". Terracotta appears here and almost nowhere else.
 */
export function itemHero(item, { tz } = {}) {
  const link = linkFor(item);
  const carried = carriedFor(item, todayKey(tz));
  const due = dueLabel(item);

  return el('article', { class: `hero sev-${severityOf(item)}` }, [
    el('p', { class: 'hero-eyebrow', text: 'Do this first' }),
    meander({ class: 'hero-rule' }),
    el('h2', { class: 'hero-headline', text: item.headline || '(no headline)' }),
    item.why ? el('p', { class: 'hero-why', text: item.why }) : null,
    el('p', { class: 'hero-meta mono' }, [
      due ? el('span', { class: isOverdue(item) ? 'meta-hot' : '', text: due }) : null,
      personLabel(item) ? el('span', { text: personLabel(item) }) : null,
      carried ? el('span', { class: 'meta-carried', text: carried }) : null,
    ]),
    el('div', { class: 'hero-actions' }, [
      button('Done', { class: 'btn solid', onClick: () => setItemState(item.id, 'done') }),
      button('Snooze', { class: 'btn quiet', onClick: () => setItemState(item.id, 'snoozed') }),
      link ? el('a', {
        class: 'btn quiet',
        href: link,
        rel: 'noreferrer noopener',
        target: '_blank',
        text: 'Open',
      }) : null,
    ]),
  ]);
}

/**
 * A list that never silently drops anything: `visible` rows, then a button that
 * says exactly how many are behind it.
 */
export function foldedList(items, render, { visible = 8, moreLabel = 'show the other' } = {}) {
  const wrap = el('div', { class: 'stack' });
  const head = items.slice(0, visible);
  const tail = items.slice(visible);
  for (const item of head) wrap.appendChild(render(item));

  if (tail.length) {
    const tailWrap = el('div', { class: 'stack', hidden: true },
      tail.map((item) => render(item)));
    const toggle = el('button', {
      type: 'button',
      class: 'fold',
      'aria-expanded': 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        tailWrap.hidden = open;
        this.textContent = open ? `${moreLabel} ${tail.length}` : 'show fewer';
      },
    }, `${moreLabel} ${tail.length}`);
    wrap.appendChild(tailWrap);
    wrap.appendChild(toggle);
  }
  return wrap;
}

/**
 * An empty state with a point of view: what is true, and what to do next.
 * `action` is optional — a state with nothing to do gets a full stop instead.
 */
export function emptyState({ title, detail, action = null }) {
  return el('div', { class: 'empty' }, [
    meander({ class: 'empty-rule' }),
    el('h3', { class: 'empty-title', text: title }),
    detail ? el('p', { class: 'empty-detail', text: detail }) : null,
    action,
  ]);
}
