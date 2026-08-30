/**
 * ui/views/owed.js — three rosters: drafts, what you owe, what you are owed.
 *
 * Drafts are the one place in Zelos where the model wrote something you might
 * put your name on, so the affordances are deliberate: the body is an editable
 * textarea that grows to fit, edits persist through PUT /api/drafts, and there
 * is no send button anywhere — Zelos never sends mail, by design. Copy, paste,
 * click send yourself.
 */

import { el, button, section, autogrow, copyText } from '../lib/dom.js';
import { itemRow, foldedList, emptyState } from '../lib/items.js';
import { byUrgency } from '../lib/format.js';
import { state, itemsInBucket, openDrafts, refreshBoard, notify } from '../lib/store.js';
import { api } from '../lib/api.js';

const SAVE_DEBOUNCE_MS = 900;

/**
 * Where a mailto address stops being honoured. Real email programs cut the
 * whole thing off somewhere shortly past two thousand characters, and the
 * failure is silent — the compose window opens with most of the reply gone.
 * Under the limit the body rides along whole; past it, the longest clean
 * start that fits, and the card says so.
 */
const MAILTO_LIMIT = 1900;

/**
 * The "Open in your email program" address: recipient, subject and body,
 * with the body's line breaks as CRLF the way RFC 6068 spells them. Returns
 * `{href, truncated}` — truncated when only the start of the body fits.
 */
export function mailtoDraft(to, subject, body) {
  const head = `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject || '')}&body=`;
  const crlf = String(body || '').replace(/\r?\n/g, '\r\n');
  const whole = head + encodeURIComponent(crlf);
  if (whole.length <= MAILTO_LIMIT) return { href: whole, truncated: false };
  // Binary search for the longest start that fits once encoded — the encoded
  // length is not proportional to the raw one, so no arithmetic shortcut.
  const fit = (n) => {
    let cut = crlf.slice(0, n);
    // Never end on half of a two-part character: encodeURIComponent refuses it.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return cut;
  };
  let lo = 0;
  let hi = crlf.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((head + encodeURIComponent(fit(mid))).length <= MAILTO_LIMIT) lo = mid;
    else hi = mid - 1;
  }
  return { href: head + encodeURIComponent(fit(lo)), truncated: true };
}

/**
 * One draft. Local edit state lives on the node, not in the store — re-rendering
 * the whole view under someone's cursor because a sweep finished would be worse
 * than a stale count.
 */
function draftCard(draft, itemsById) {
  const item = itemsById.get(draft.item_id) || null;
  const status = el('span', { class: 'draft-status mono', role: 'status', text: 'Saved' });
  const area = el('textarea', {
    class: 'draft-body',
    spellcheck: 'true',
    'aria-label': `Draft to ${draft.to_email || 'unknown recipient'}`,
  });
  area.value = draft.body || '';
  autogrow(area, { min: 120 });

  // The mailto is rebuilt from the LIVE textarea at the moment it is used, so
  // the words that travel are the words on screen — not the body as fetched.
  const mailto = () => mailtoDraft(draft.to_email, draft.subject, area.value);
  const note = el('p', {
    class: 'quiet-note draft-note',
    text: 'Only the start of the reply fits in a new email — Copy the text and paste the whole thing.',
  });
  const syncNote = () => { note.hidden = !(draft.to_email && mailto().truncated); };
  syncNote();

  let timer = null;
  let inFlight = false;
  let dirty = false;

  async function save() {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    dirty = false;
    const body = area.value;
    // The board's copy is patched before the request goes out: a deferred
    // re-render can flush the moment this textarea blurs, and a rebuilt card
    // reads `state.board.drafts` — which still held the body fetched before
    // the edit, so the user watched their own words revert while the server
    // was saving them.
    state.board = {
      ...state.board,
      drafts: state.board.drafts.map((d) => (d.id === draft.id ? { ...d, body, state: 'edited' } : d)),
    };
    status.textContent = 'Saving…';
    status.classList.remove('is-bad');
    try {
      await api.updateDraft(draft.id, { body, state: 'edited' });
      status.textContent = 'Saved';
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('is-bad');
    } finally {
      inFlight = false;
      if (dirty) save();
    }
  }

  area.addEventListener('input', () => {
    status.textContent = 'Editing…';
    status.classList.remove('is-bad');
    syncNote();
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  });
  area.addEventListener('blur', () => {
    if (status.textContent === 'Editing…') {
      clearTimeout(timer);
      save();
    }
  });

  return el('article', { class: 'draft' }, [
    el('div', { class: 'draft-head' }, [
      el('div', { class: 'draft-to' }, [
        el('span', { class: 'draft-label mono', text: 'To' }),
        el('span', { class: 'draft-addr', text: draft.to_email || '(no address)' }),
      ]),
      status,
    ]),
    el('h3', { class: 'draft-subject', text: draft.subject || '(no subject)' }),
    item ? el('p', { class: 'draft-because', text: item.headline }) : null,
    area,
    el('div', { class: 'draft-actions' }, [
      button('Copy the text', {
        class: 'btn solid',
        onClick: async (e) => {
          const ok = await copyText(area.value);
          const btn = e.currentTarget;
          btn.textContent = ok ? 'Copied' : 'Copy failed';
          setTimeout(() => { btn.textContent = 'Copy the text'; }, 1_600);
        },
      }),
      draft.to_email
        ? el('a', {
          class: 'btn quiet',
          href: mailto().href,
          text: 'Open in your email program',
          // At CLICK time, so edits ride along: navigation reads the href
          // after the handler runs, and the handler has just rewritten it.
          onclick() {
            this.setAttribute('href', mailto().href);
            syncNote();
          },
        })
        : null,
      button('Discard', {
        class: 'btn quiet',
        onClick: async () => {
          try {
            await api.updateDraft(draft.id, { state: 'discarded' });
            await refreshBoard();
          } catch (err) {
            notify(`Could not discard that draft: ${err.message}`, { tone: 'warn' });
          }
        },
      }),
    ]),
    note,
  ]);
}

export function renderOwed(ctx) {
  const { tz } = ctx;
  const drafts = openDrafts();
  const promised = itemsInBucket('promised').sort(byUrgency);
  const waiting = itemsInBucket('waiting').sort(byUrgency);
  const itemsById = new Map(state.board.items.map((i) => [i.id, i]));

  const body = el('div', { class: 'view view-owed' });

  if (!drafts.length && !promised.length && !waiting.length) {
    body.appendChild(emptyState({
      title: 'Nobody is waiting on anybody',
      detail: 'When a check finds a reply you owe, a promise you made, or a question of yours that went unanswered, it lands here — with a reply already written where one helps.',
    }));
    return body;
  }

  // "Ready to send" and "never sends mail" in one breath was the audit's
  // complaint; the heading now says whose words these are and the note says
  // where the sending happens.
  body.appendChild(section('Replies it wrote for you', {
    count: drafts.length,
    note: 'Open one in your email program, check it, and press send there. Zelos never sends anything itself.',
  }, drafts.length
    ? el('div', { class: 'stack' }, drafts.map((d) => draftCard(d, itemsById)))
    : el('p', { class: 'quiet-note', text: 'No drafts waiting.' })));

  body.appendChild(section('You owe them', { count: promised.length },
    promised.length
      ? foldedList(promised, (item) => itemRow(item, { tz, showBucket: false }), { visible: 8 })
      : el('p', { class: 'quiet-note', text: 'Nothing outstanding from you.' })));

  body.appendChild(section('They owe you', { count: waiting.length },
    waiting.length
      ? foldedList(waiting, (item) => itemRow(item, { tz, showBucket: false }), { visible: 8 })
      : el('p', { class: 'quiet-note', text: 'Nothing outstanding to you.' })));

  return body;
}
