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
import { state, startSweep, itemsInBucket, snoozedItems, boardNotes } from '../lib/store.js';
import { humanDelta, instant } from '../lib/time.js';

const MAX_NOW_ROWS = 4;

/**
 * What a sweep on this home is missing before it can succeed at all — 'model',
 * 'sources' — or null. One rule, read by the empty state and by the failure
 * banner, so the two cannot disagree about whether "Sweep again" is advice.
 */
function missingSetup() {
  if (!state.health?.model?.configured) return 'model';
  // Mail, calendars, and the connector sources in Settings → Sources: a home
  // reading only GitHub is a home with something to read, and under a whole
  // failure the banner must offer "Sweep again", not "Connect a source".
  const hasSources = (state.config?.mail?.length || 0) + (state.config?.calendars?.length || 0)
    + (state.config?.sources?.length || 0) > 0;
  return hasSources ? null : 'sources';
}

/**
 * Why the board is empty is a different screen every time, and each one has to
 * say what to do next. "Nothing here" with no explanation is the failure mode
 * this function exists to avoid.
 */
function emptyForContext(navigate) {
  const missing = missingSetup();
  const last = state.board.runs?.last;

  if (missing === 'model') {
    return emptyState({
      title: 'No model yet',
      detail: 'Zelos reads your mail and calendar and thinks about them with a model you choose — including one running on this machine. Nothing happens until you pick one.',
      action: button('Choose a model', { class: 'btn solid', onClick: () => navigate('#/settings/model') }),
    });
  }
  if (missing === 'sources') {
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
      detail: last.error || 'It failed without saying why. Run from a terminal, the reason is in that terminal — Zelos keeps no log file of its own. In the desktop app it is in desktop.log, under Board → Show logs.',
      action: button('Try again', { class: 'btn solid', onClick: () => startSweep('full') }),
    });
  }
  return emptyState({
    title: 'Nothing needs you.',
    detail: `Swept ${humanDelta(last.ended_at || last.started_at)}. ${sweepSummary(last)}`.trim(),
  });
}

/**
 * Which of the two sweep failures the board is living with — 'whole', 'partial'
 * or neither.
 *
 * A run that lost ONE source comes back `ok: true`. A revoked app password, a
 * 404'd `.ics`, a Sent folder that is not called Sent: the sweep shrugs, writes
 * `stats.sourcesFailed`, and the board just gets quieter — while this view said
 * "Nothing needs you." and named the failure nowhere. `sourcesFailed` and
 * `sources[]` are written by every sweep and, until this function existed, were
 * read by nothing in the app; the CLI printed the list, the screen people
 * actually look at did not.
 *
 * `sources[]` is the better signal because it carries the reason, but a run
 * that died before the count was taken has one and not the other, so both are
 * consulted and the larger wins.
 */
function sweepTrouble() {
  const last = state.board.runs?.last;
  if (state.sweep.error || (last && last.ok === false)) return 'whole';
  const named = (last?.stats?.sources || []).filter((s) => s && s.ok === false).length;
  const counted = Number(last?.stats?.sourcesFailed) || 0;
  return Math.max(named, counted) > 0 ? 'partial' : null;
}

/**
 * The failed-sweep banner. Persistent, specific, and it names the source.
 *
 * Two failures, two tones, two sentences. "The last sweep failed" over a run
 * that read four sources out of five is a lie in the alarming direction, and it
 * would send the reader looking for a broken app instead of a dead password.
 */
function failureBanner(trouble, navigate) {
  const last = state.board.runs?.last;
  const live = state.sweep.error;
  // Under a whole failure on a home with no model or nothing to read,
  // "Sweep again" is the failure again: the one action on the screen ran the
  // same run that wrote the banner. What is missing is a setting, so the
  // action opens it.
  const missing = trouble === 'whole' ? missingSetup() : null;
  const failedSources = (last?.stats?.sources || []).filter((s) => s && s.ok === false);
  const counted = Math.max(failedSources.length, Number(last?.stats?.sourcesFailed) || 0);
  const whole = trouble === 'whole';
  const message = whole
    ? (live || last?.error || 'The last sweep failed.')
    : `${plural(counted, 'source')} could not be read. Everything else on the board is from this sweep — whatever those hold is not.`;

  return el('div', { class: `banner ${whole ? 'banner-bad' : 'banner-warn'}`, role: 'status' }, [
    el('h3', {
      class: 'banner-title',
      text: whole ? 'The last sweep failed' : 'The last sweep could not read everything',
    }),
    el('p', { class: 'banner-detail', text: message }),
    failedSources.length
      ? el('ul', { class: 'banner-list' }, failedSources.map((s) =>
        el('li', { text: `${s.label}: ${s.error}` })))
      : null,
    el('div', { class: 'banner-actions' }, [
      missing === 'model'
        ? button('Choose a model', { class: 'btn solid', onClick: () => navigate('#/settings/model') })
        : missing === 'sources'
          ? button('Connect a source', { class: 'btn solid', onClick: () => navigate('#/settings/mail') })
          : button('Sweep again', { class: 'btn solid', onClick: () => startSweep('full') }),
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
  // Through the store, not off state.board directly: the rail's "Worth
  // knowing" row counts the same list, and the two filtering it separately is
  // how they came to print different numbers side by side.
  const notes = boardNotes();
  const noteItems = itemsInBucket('note');

  const body = el('div', { class: 'view view-now' });
  const trouble = sweepTrouble();
  const banner = trouble ? failureBanner(trouble, navigate) : null;
  if (banner) body.appendChild(banner);

  if (!hero) {
    // When the banner is up it has already said what failed and offered the
    // retry. Repeating both in the empty state — same fact, two boxes, two
    // buttons — reads like the app panicking, so under a banner the empty
    // state is just the plain shell. After a PARTIAL failure the sweep did
    // finish, so "the board fills in when a sweep finishes" would be the
    // reassurance this whole banner exists to withdraw.
    //
    // The title has to carry that too, not only the detail. Branching the
    // detail alone still left "Nothing on the board yet." as the largest text
    // on an empty screen, and "yet" is the whole reassurance: it says the board
    // is between sweeps and will fill in. After a partial failure the board is
    // as full as it is ever going to get from this run, and the part nobody has
    // seen is the part that could not be read. Two titles, because they are two
    // different states of the world.
    //
    // The one case the plain shell gets wrong: a WHOLE failure on a home with
    // no model, or nothing to read. "The board fills in when a sweep finishes"
    // is a promise about a sweep that cannot, and the context-aware empty
    // state — the only place "Choose a model" lives — went missing the moment
    // the first scheduled run failed, which on such a home is thirty minutes
    // in. So there it comes back under the banner, which has already swapped
    // its own action to match.
    if (trouble === 'whole' && missingSetup()) {
      body.appendChild(emptyForContext(navigate));
    } else {
      body.appendChild(banner
        ? emptyState(trouble === 'partial'
          ? {
            title: 'Nothing on the board — and not everything was read',
            detail: 'Nothing Zelos could read needs you. The sources named above went unread, '
              + 'and whatever they hold is not on this board.',
          }
          : {
            title: 'Nothing on the board yet.',
            detail: 'The board fills in when a sweep finishes.',
          })
        : emptyForContext(navigate));
    }
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

  // The snoozed, folded and dimmed at the very bottom: off the board but never
  // off the record. Each row says when it comes back, and Wake lives in the
  // row's own disclosure. Soonest return first.
  const snoozed = snoozedItems().sort((a, b) =>
    (instant(a.snoozed_until) ?? Infinity) - (instant(b.snoozed_until) ?? Infinity));
  if (snoozed.length) {
    const panel = el('div', { class: 'worth-body', hidden: true },
      el('div', { class: 'stack' }, snoozed.map((item) => itemRow(item, { tz, showBucket: false }))));
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
      el('span', { text: 'Snoozed' }),
      el('span', { class: 'mono worth-count', text: String(snoozed.length) }),
    ]);
    body.appendChild(el('section', { class: 'section worth' }, [toggle, meander(), panel]));
  }

  return body;
}
