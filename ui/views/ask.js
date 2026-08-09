/**
 * ui/views/ask.js — a question against your own index.
 *
 * The answer is streamed from POST /api/ask, which grounds it in FTS5 hits over
 * your mail, calendar, items and notes. The sources arrive first, as their own
 * SSE event, and they are rendered before a single token of the answer — so what
 * the model was allowed to look at is visible whether or not you like what it
 * said.
 *
 * This view owns a persistent root node. A sweep finishing mid-answer must not
 * re-render the transcript out from under a stream that is still running.
 */

import { el, button, meander } from '../lib/dom.js';
import { emptyState } from '../lib/items.js';
import { openStream, ApiError } from '../lib/api.js';
import { state } from '../lib/store.js';

let root = null;
let transcript = null;
let form = null;
let field = null;
let askButton = null;
let controller = null;
let navigateTo = null;

const KIND_LABEL = { message: 'mail', event: 'calendar', item: 'board', capture: 'note' };

function sourceList(sources) {
  if (!sources.length) return null;
  return el('div', { class: 'sources' }, [
    el('p', { class: 'sources-title mono', text: 'read from' }),
    el('ul', { class: 'sources-list' }, sources.map((s) => el('li', { class: 'source' }, [
      el('span', { class: 'source-kind mono', text: KIND_LABEL[s.kind] || s.kind || 'source' }),
      el('span', { class: 'source-title', text: s.title || s.ref }),
      s.excerpt ? el('span', { class: 'source-excerpt', text: s.excerpt }) : null,
    ]))),
  ]);
}

function exchange(question) {
  const answer = el('div', { class: 'answer', 'aria-live': 'polite', 'aria-busy': 'true' });
  const sourcesSlot = el('div', { class: 'sources-slot' });
  const node = el('article', { class: 'exchange' }, [
    el('p', { class: 'question' }, [
      el('span', { class: 'question-mark mono', text: 'Q' }),
      el('span', { text: question }),
    ]),
    sourcesSlot,
    answer,
  ]);
  return { node, answer, sourcesSlot };
}

async function ask(question) {
  if (controller) controller.abort();
  controller = new AbortController();

  const { node, answer, sourcesSlot } = exchange(question);
  transcript.prepend(node);
  answer.textContent = 'Thinking…';
  answer.classList.add('is-waiting');
  askButton.disabled = true;
  askButton.textContent = 'Answering…';

  let started = false;
  const write = (text) => {
    if (!started) {
      answer.textContent = '';
      answer.classList.remove('is-waiting');
      started = true;
    }
    answer.appendChild(document.createTextNode(text));
  };

  try {
    await openStream('/api/ask', {
      method: 'POST',
      body: { question },
      signal: controller.signal,
      onEvent(event, data) {
        if (event === 'sources') {
          sourcesSlot.replaceChildren();
          const list = sourceList(Array.isArray(data) ? data : []);
          if (list) sourcesSlot.appendChild(list);
        } else if (event === 'delta') {
          write(String(data?.text ?? ''));
        } else if (event === 'error') {
          write(`\n\n${String(data?.error || 'the model stopped answering')}`);
          answer.classList.add('is-bad');
        }
      },
    });
    if (!started) {
      answer.textContent = 'The model returned nothing.';
      answer.classList.remove('is-waiting');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      answer.classList.remove('is-waiting');
      answer.classList.add('is-bad');
      answer.textContent = err instanceof ApiError && err.status === 409
        ? 'No model is configured yet. Pick one in Settings and ask again.'
        : err.message;
    }
  } finally {
    answer.setAttribute('aria-busy', 'false');
    askButton.disabled = false;
    askButton.textContent = 'Ask';
    controller = null;
  }
}

function build() {
  field = el('textarea', {
    class: 'ask-field',
    rows: '2',
    placeholder: 'What did Marcus say about the survey?',
    'aria-label': 'Your question',
  });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  askButton = el('button', { type: 'submit', class: 'btn solid', text: 'Ask' });

  form = el('form', { class: 'ask-form' }, [
    field,
    el('div', { class: 'ask-actions' }, [
      askButton,
      el('span', { class: 'ask-hint mono', text: '⌘↵' }),
    ]),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = field.value.trim();
    if (!question) return;
    field.value = '';
    ask(question);
  });

  transcript = el('div', { class: 'transcript' });

  root = el('div', { class: 'view view-ask' }, [
    el('p', { class: 'ask-lede', text: 'Ask about your own mail, calendar and notes. The answer is grounded in what Zelos has indexed on this machine — and it lists what it read.' }),
    form,
    meander(),
    transcript,
  ]);
}

export function renderAsk(ctx) {
  navigateTo = ctx.navigate;
  if (!root) build();

  if (!state.health?.model?.configured) {
    return el('div', { class: 'view view-ask' }, emptyState({
      title: 'Ask needs a model',
      detail: 'Questions are answered by the model you choose — an API you hold the key to, or a runtime on this machine. Nothing is asked of anything you have not configured.',
      action: button('Choose a model', { class: 'btn solid', onClick: () => navigateTo('#/settings/model') }),
    }));
  }
  return root;
}
