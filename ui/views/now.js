/**
 * ui/views/now.js — the page you open first.
 *
 * The whole discipline of this view is subtraction. One hero, at most four
 * others, and everything else folded away. core/triage.mjs already clamps `now`
 * to four in code; this view is what that clamp is for.
 */

import { el, button, meander, section } from '../lib/dom.js';
import { itemHero, itemRow, emptyState } from '../lib/items.js';
import { byUrgency, sweepSummary, plural } from '../lib/format.js';
import { state, startSweep, itemsInBucket } from '../lib/store.js';
import { humanDelta } from '../lib/time.js';

const MAX_NOW_ROWS = 4;

/**
 * Why the board is empty is a different screen every time, and each one has to
 * say what to do next. "Nothing here" with no explanation is the failure mode
 * this function exists to avoid.
 */
function emptyForContext(navigate) {
  const configured = Boolean(state.health?.model?.configured);
  const last = state.board.runs?.last;
  const hasSources = (state.config?.mail?.length || 0) + (state.config?.calendars?.length || 0) > 0;

  if (!configured) {
    return emptyState({
      title: 'No model yet',
      detail: 'Zelos reads your mail and calendar and thinks about them with a model you choose — including one running on this machine. Nothing happens until you pick one.',
      action: button('Choose a model', { class: 'btn solid', onClick: () => navigate('#/settings/model') }),
    });
  }
  if (!hasSources) {
    return emptyState({
      title: 'Nothing to read yet',
      detail: 'Connect a mailbox or a calendar and Zelos will have something to think about. Both stay on this machine.',
      action: button('Connect a source', { class: 'btn solid', onClick: () => navigate('#/settings/mail') }),
    });
  }
  if (!last) {
    return emptyState({
      title: 'Ready for the first sweep',
      detail: 'A sweep fetches your recent mail and calendar, then asks your model what actually needs you.',
      action: button('Sweep now', { class: 'btn solid', onClick: () => startSweep('full') }),
    });
  }
  if (last.ok === false) {
    return emptyState({
      title: 'The last sweep did not finish',
      detail: last.error || 'It failed without saying why. The log in your Zelos home has the detail.',
      action: button('Try again', { class: 'btn solid', onClick: () => startSweep('full') }),
    });
  }
  return emptyState({
    title: 'Nothing needs you.',
    detail: `Swept ${humanDelta(last.ended_at || last.started_at)}. ${sweepSummary(last)}`.trim(),
  });
}

/** The failed-sweep banner. Persistent, specific, and it names the source. */
function failureBanner() {
  const last = state.board.runs?.last;
  const live = state.sweep.error;
  if (!live && !(last && last.ok === false)) return null;
  const message = live || last.error || 'The last sweep failed.';
  const failedSources = (last?.stats?.sources || []).filter((s) => s && s.ok === false);

  return el('div', { class: 'banner banner-bad', role: 'status' }, [
    el('h3', { class: 'banner-title', text: 'The last sweep failed' }),
    el('p', { class: 'banner-detail', text: message }),
    failedSources.length
      ? el('ul', { class: 'banner-list' }, failedSources.map((s) =>
        el('li', { text: `${s.label}: ${s.error}` })))
      : null,
    el('div', { class: 'banner-actions' }, [
      button('Sweep again', { class: 'btn solid', onClick: () => startSweep('full') }),
    ]),
  ]);
}

export function renderNow(ctx) {
  const { tz, navigate } = ctx;
  const nowItems = itemsInBucket('now').sort(byUrgency);
  const firstId = state.board.first;
  const hero = nowItems.find((i) => i.id === firstId)
    || state.board.items.find((i) => i.id === firstId && i.state === 'open')
    || nowItems[0]
    || null;
  const rest = nowItems.filter((i) => i.id !== hero?.id).slice(0, MAX_NOW_ROWS);
  const notes = (state.board.notes || []).filter((n) => typeof n === 'string' && n.trim());
  const noteItems = itemsInBucket('note');

  const body = el('div', { class: 'view view-now' });
  const banner = failureBanner();
  if (banner) body.appendChild(banner);

  if (!hero) {
    body.appendChild(emptyForContext(navigate));
  } else {
    body.appendChild(itemHero(hero, { tz }));
    if (rest.length) {
      body.appendChild(section('Then these', { count: rest.length }, [
        el('div', { class: 'stack' }, rest.map((item) => itemRow(item, { tz, showBucket: false }))),
      ]));
    }
  }

  if (notes.length || noteItems.length) {
    const panel = el('div', { class: 'worth-body', hidden: true }, [
      notes.length
        ? el('ul', { class: 'notes' }, notes.map((n) => el('li', { text: n })))
        : null,
      noteItems.length
        ? el('div', { class: 'stack' }, noteItems.map((item) => itemRow(item, { tz, showBucket: false })))
        : null,
    ]);
    const toggle = el('button', {
      type: 'button',
      class: 'worth-toggle',
      'aria-expanded': 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
      },
    }, [
      el('span', { text: 'Worth knowing' }),
      el('span', { class: 'mono worth-count', text: String(notes.length + noteItems.length) }),
    ]);

    body.appendChild(el('section', { class: 'section worth' }, [toggle, meander(), panel]));
  }

  const todayCount = state.board.counts.today || 0;
  if (todayCount) {
    body.appendChild(el('p', { class: 'handoff' }, [
      el('span', { text: `${plural(todayCount, 'other thing')} for today. ` }),
      button('Open Today', { class: 'link', onClick: () => navigate('#/today') }),
    ]));
  }

  return body;
}
