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

  let timer = null;
  let inFlight = false;
  let dirty = false;

  async function save() {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    dirty = false;
    status.textContent = 'Saving…';
    status.classList.remove('is-bad');
    try {
      await api.updateDraft(draft.id, { body: area.value, state: 'edited' });
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
          href: `mailto:${encodeURIComponent(draft.to_email)}?subject=${encodeURIComponent(draft.subject || '')}`,
          text: 'Open in your email program',
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
