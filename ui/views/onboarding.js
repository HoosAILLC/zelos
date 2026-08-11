/**
 * ui/views/onboarding.js — first run.
 *
 * The shortest honest path, in that order of words.
 *
 * *Shortest*: the first screen is one decision, and every version of it ends in a
 * usable app. If a model is already running on this machine, there is a single
 * button that adopts it and opens the board. If there is not, the biggest button
 * on the screen is "Skip and look around" — because the board is legible with
 * nothing connected, and a first screen that demands a hostname and a password
 * before it shows you anything is where people close the tab.
 *
 * *Honest*: nothing here claims a thing is set up when it is not. The local probe
 * says which ports it tried and stops; the sample data says out loud that it is
 * invented and can be removed in one click; the sweep step says plainly when it
 * has nothing to sweep.
 *
 * The later steps are not a funnel, they are a menu. Each mounts the same panel
 * Settings uses, so there is exactly one implementation of "configure a mailbox",
 * and every one of them can be walked past.
 */

import { el, button, meander } from '../lib/dom.js';
import { modelPanel, mailPanel, calendarPanel } from './settings.js';
import {
  state, subscribe, startSweep, markOnboarded, refresh, saveConfig, notify,
} from '../lib/store.js';
import { api, request, ApiError } from '../lib/api.js';
import { sweepSummary } from '../lib/format.js';

const STEPS = ['start', 'model', 'mail', 'calendar', 'sweep'];
const STEP_LABELS = {
  start: 'Start',
  model: 'Model',
  mail: 'Mail',
  calendar: 'Calendar',
  sweep: 'First sweep',
};

let step = 'start';

/**
 * The probes are per-session facts, not per-render ones. Caching them here keeps
 * a rerender from re-scanning four ports and re-asking the server whether it
 * knows about sample data every time somebody clicks.
 */
let localProbe = null;      // null = not asked yet | {found:[]} | {error:''}
let sampleState = null;     // null = not asked yet | {supported:false} | {supported:true, ...status}

function go(stepId, rerender) {
  step = stepId;
  rerender();
}

function next(rerender) {
  const i = STEPS.indexOf(step);
  go(STEPS[Math.min(STEPS.length - 1, i + 1)], rerender);
}

function finish(navigate) {
  markOnboarded(true);
  step = 'start';
  navigate('#/now');
}

function progressRail(rerender) {
  return el('ol', { class: 'ob-rail', 'aria-label': 'Setup steps, all optional' }, STEPS.map((id, i) => {
    const done = STEPS.indexOf(step) > i;
    return el('li', { class: `ob-step${id === step ? ' is-current' : ''}${done ? ' is-done' : ''}` },
      el('button', {
        type: 'button',
        class: 'ob-step-btn',
        'aria-current': id === step ? 'step' : null,
        onclick: () => go(id, rerender),
      }, [
        el('span', { class: 'ob-step-num mono', text: String(i + 1) }),
        el('span', { class: 'ob-step-label', text: STEP_LABELS[id] }),
      ]));
  }));
}

/**
 * `actions` overrides the default row wholesale — the start screen swaps its own
 * in once the probes land, because which button is the *biggest* one depends on
 * what came back.
 */
function shell(rerender, navigate, { title, lede, body, primary = null, skip = 'Do this later', actions = null }) {
  return el('div', { class: 'view view-onboarding' }, [
    el('header', { class: 'ob-head' }, [
      el('p', { class: 'ob-mark', text: 'ΖΗΛΟΣ' }),
      progressRail(rerender),
    ]),
    meander({ class: 'ob-rule' }),
    el('h1', { class: 'ob-title', text: title }),
    lede ? el('p', { class: 'ob-lede', text: lede }) : null,
    el('div', { class: 'ob-body' }, body),
    actions || el('div', { class: 'ob-actions' }, [
      primary,
      step === 'sweep'
        ? button('Go to the board', { class: 'btn quiet', onClick: () => finish(navigate) })
        : skip && button(skip, { class: 'btn quiet', onClick: () => next(rerender) }),
      button('Skip setup entirely', { class: 'link', onClick: () => finish(navigate) }),
    ]),
  ]);
}

/** When something is wrong, the answer is a command, not a shrug. */
function doctorNote(reason) {
  return el('p', { class: 'quiet-note' }, [
    `${reason} For a plain-English check of Node, this folder's permissions, the model and your sources, run `,
    el('span', { class: 'code mono', text: 'zelos doctor' }),
    ' in the terminal that started Zelos.',
  ]);
}

/* ------------------------------------------------------------- sample data */

/**
 * The sample dataset is served by the local API, so the button only exists when
 * the running build actually offers it — a 404 here means this copy of Zelos has
 * no sample route, and an offer that cannot be honoured is worse than no offer.
 *
 *   GET    /api/sample-data  -> {installed, seededAt, counts, summary}
 *   POST   /api/sample-data  -> seeds the demo week into the current home
 *   DELETE /api/sample-data  -> removes exactly what it added
 */
const sampleApi = {
  status: () => request('/api/sample-data'),
  load: () => request('/api/sample-data', { method: 'POST' }),
  clear: () => request('/api/sample-data', { method: 'DELETE' }),
};

async function readSampleState() {
  if (sampleState) return sampleState;
  try {
    const status = await sampleApi.status();
    sampleState = { supported: true, ...status };
  } catch (err) {
    const missing = err instanceof ApiError && (err.status === 404 || err.status === 405);
    sampleState = missing ? { supported: false } : { supported: false, error: err.message };
  }
  return sampleState;
}

async function loadSample(rerender, navigate) {
  try {
    await sampleApi.load();
    sampleState = null;
    await refresh({ silent: true });
    notify('Sample data loaded. Every row is marked, and one click removes it.', { tone: 'info' });
    finish(navigate);
  } catch (err) {
    notify(`Could not load the sample data: ${err.message}`, { tone: 'warn' });
    rerender();
  }
}

async function clearSample(rerender) {
  try {
    await sampleApi.clear();
    sampleState = null;
    await refresh({ silent: true });
    notify('Sample data removed. Nothing else was touched.', { tone: 'info' });
  } catch (err) {
    notify(`Could not clear the sample data: ${err.message}`, { tone: 'warn' });
  }
  rerender();
}

/* -------------------------------------------------------------- local model */

/** One click: adopt the runtime that is already running and open the board. */
async function adoptRuntime(runtime, rerender, navigate, status) {
  const model = runtime.models?.[0]?.id || '';
  status.textContent = `Pointing Zelos at ${runtime.label}…`;
  status.className = 'ob-outcome status is-working';
  try {
    await saveConfig({
      model: {
        protocol: 'openai',
        label: runtime.label,
        baseUrl: runtime.baseUrl,
        model,
      },
    });
    await refresh({ silent: true });
  } catch (err) {
    status.textContent = err.message;
    status.className = 'ob-outcome status is-bad';
    return;
  }
  if (!model) {
    // Honest rather than convenient: the runtime is up, but it has nothing
    // loaded, and pretending otherwise means a sweep that fails later.
    status.textContent = `${runtime.label} is running but has not pulled a model yet. Pull one, then pick it under Model.`;
    status.className = 'ob-outcome status is-bad';
    rerender();
    return;
  }
  finish(navigate);
}

/** The body of the start screen: what is on this machine, and nothing else. */
function runtimeBlock(rerender, navigate) {
  // `.ob-outcome` collapses when empty, so an unused slot costs no vertical gap.
  const status = el('p', { class: 'ob-outcome status', 'aria-live': 'polite' });
  const list = el('div', { class: 'runtime-list' },
    el('p', { class: 'quiet-note', text: 'Looking for a model already running on this machine…' }));

  const paint = () => {
    if (!localProbe) return;
    if (localProbe.error) {
      list.replaceChildren(doctorNote(`Zelos could not check for a local model: ${localProbe.error}.`));
      return;
    }
    if (!localProbe.found.length) {
      list.replaceChildren(el('p', { class: 'quiet-note', text: 'Nothing answered on the four ports Zelos checks — Ollama on 11434, LM Studio on 1234, llama.cpp on 8080, vLLM on 8000. It does not look anywhere else, and it will not go hunting on the network. You can point it at a hosted provider under Model whenever you like.' }));
      return;
    }
    list.replaceChildren(...localProbe.found.map((rt) => el('div', { class: 'runtime' }, [
      el('div', { class: 'runtime-body' }, [
        el('span', { class: 'runtime-label', text: rt.label }),
        el('span', { class: 'mono runtime-url', text: rt.baseUrl }),
        el('span', {
          class: 'quiet-note',
          text: rt.models?.length
            ? `${rt.models.length} model${rt.models.length === 1 ? '' : 's'} loaded — Zelos will use ${rt.models[0].id}`
            : 'no model pulled yet',
        }),
      ]),
      // The pill sits in `.runtime`, not in `.runtime-body`: the body is a grid,
      // and a grid child stretches, which turns a pill into a full-width bar.
      el('span', { class: 'badge-local', text: 'on this machine' }),
      button(`Use ${rt.label}`, {
        class: 'btn solid',
        onClick: () => adoptRuntime(rt, rerender, navigate, status),
      }),
    ])));
  };

  paint();
  return { node: el('div', { class: 'stack' }, [list, status]), paint, status };
}

/* ------------------------------------------------------------- start screen */

function startScreen(rerender, navigate) {
  const runtimes = runtimeBlock(rerender, navigate);
  const sampleNote = el('div', { class: 'ob-outcome' });
  const actions = el('div', { class: 'ob-actions' },
    button('Skip and look around', { class: 'btn solid', onClick: () => finish(navigate) }));

  /**
   * The action row, painted from whatever the probes have answered so far.
   *
   * This ran behind `if (!actions.isConnected) return;`, which was never true
   * when it mattered. The synchronous call below happens twelve lines before
   * `shell()` puts `actions` in a tree, so the first pass always bailed, and
   * the two `.finally` callbacks that made up for it are gated on the
   * module-level probe caches — so on the SECOND build of this screen, with
   * both probes already answered, neither ran and the row kept its
   * placeholder. What was lost: "Use Ollama and open the board", "Try it with
   * sample data", "Choose a model", "Connect mail and a calendar", and the
   * demo-week note. Sample data has no other way in anywhere in the app, and
   * `watchBoard` rebuilds this screen every three minutes and on every
   * tab-visibility change, so the row emptied itself while nobody touched it.
   *
   * There is nothing here that needs a live node — `replaceChildren` on a
   * detached element is perfectly ordinary — so the guard is simply gone.
   */
  const paintActions = () => {
    const found = localProbe?.found?.length ? localProbe.found[0] : null;
    const usable = found && found.models?.length;
    const sample = sampleState?.supported ? sampleState : null;

    const row = [];
    if (usable) {
      // A model is already here. One click is the whole of setup.
      row.push(button(`Use ${found.label} and open the board`, {
        class: 'btn solid',
        onClick: () => adoptRuntime(found, rerender, navigate, runtimes.status),
      }));
      row.push(button('Skip and look around', { class: 'btn quiet', onClick: () => finish(navigate) }));
    } else {
      // Nothing running. The most prominent thing on the screen stays the exit.
      row.push(button('Skip and look around', { class: 'btn solid', onClick: () => finish(navigate) }));
    }

    if (sample && !sample.installed) {
      row.push(button('Try it with sample data', { class: 'btn quiet', onClick: () => loadSample(rerender, navigate) }));
    } else if (sample && sample.installed) {
      row.push(button('Clear the sample data', { class: 'btn quiet', onClick: () => clearSample(rerender) }));
    }

    if (!usable) row.push(button('Choose a model', { class: 'btn quiet', onClick: () => go('model', rerender) }));
    row.push(button('Connect mail and a calendar', { class: 'link', onClick: () => go('mail', rerender) }));
    actions.replaceChildren(...row);

    if (sample) {
      sampleNote.replaceChildren(el('p', {
        class: 'quiet-note',
        text: sample.installed
          ? `The demo week is loaded. ${sample.summary || ''} Every row of it starts with “Sample ·”, and clearing removes exactly those rows and nothing of yours.`.trim()
          : `${sample.summary || 'A made-up week at a small studio, so the board has something on it before you connect anything.'} It loads into this same home, every row of it marked, and one click takes it back out.`,
      }));
    } else if (sampleState && sampleState.error) {
      sampleNote.replaceChildren(el('p', { class: 'quiet-note', text: `Sample data is not available: ${sampleState.error}` }));
    }
  };

  paintActions();

  if (!localProbe) {
    api.probeLocal()
      .then((found) => { localProbe = { found: Array.isArray(found) ? found : [] }; })
      .catch((err) => { localProbe = { found: [], error: err.message }; })
      .finally(() => { runtimes.paint(); paintActions(); });
  }
  if (!sampleState) {
    readSampleState().finally(paintActions);
  }

  return shell(rerender, navigate, {
    title: 'Zelos reads what arrived, and tells you what needs you.',
    lede: 'Mail and calendar in, one page out: what needs you now, what you owe, what owes you, what is coming. '
      + 'It runs on this machine and stores everything in one directory you control. You can look at it before you connect anything.',
    body: el('div', { class: 'stack' }, [
      runtimes.node,
      sampleNote,
      el('ul', { class: 'ob-points' }, [
        el('li', { text: 'Mail is fetched over IMAP straight from your server, read-only in practice — Zelos uses BODY.PEEK, so nothing it reads gets marked read.' }),
        el('li', { text: 'The thinking is done by a model you choose. Choose one running here and nothing leaves the machine at all.' }),
        el('li', { text: 'Zelos never sends mail. It writes drafts; you press send, somewhere else.' }),
      ]),
    ]),
    actions,
  });
}

/* -------------------------------------------------------------- sweep step */

/** The sweep step's live progress. Subscribes itself; detaches when removed. */
function sweepProgress() {
  const line = el('p', { class: 'ob-progress-line', 'aria-live': 'polite' });
  const bar = el('div', { class: 'ob-bar' }, el('div', { class: 'ob-bar-fill' }));
  const fill = bar.firstChild;
  const outcome = el('div', { class: 'ob-outcome' });

  const paint = () => {
    const s = state.sweep;
    if (s.running) {
      line.textContent = s.message || 'Working…';
      const pct = s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;
      bar.classList.toggle('is-indeterminate', pct === null);
      fill.style.width = pct === null ? '100%' : `${pct}%`;
      outcome.replaceChildren();
      return;
    }
    if (s.error) {
      line.textContent = 'The sweep stopped.';
      bar.classList.remove('is-indeterminate');
      fill.style.width = '0%';
      outcome.replaceChildren(
        el('p', { class: 'status is-bad', text: s.error }),
        doctorNote('That is usually a source or a model that cannot be reached.'),
      );
      return;
    }
    if (s.lastResult) {
      line.textContent = 'Done.';
      bar.classList.remove('is-indeterminate');
      fill.style.width = '100%';
      outcome.replaceChildren(el('p', { class: 'status is-good', text: sweepSummary({ stats: s.lastResult.stats }) || 'The board is up to date.' }));
      return;
    }
    line.textContent = 'Not started.';
    fill.style.width = '0%';
  };

  const unsubscribe = subscribe(() => {
    if (!line.isConnected) {
      unsubscribe();
      return;
    }
    paint();
  });
  paint();

  return el('div', { class: 'ob-progress' }, [line, bar, outcome]);
}

/* ------------------------------------------------------------------ render */

export function renderOnboarding(ctx) {
  const { rerender, navigate } = ctx;

  if (step === 'start') return startScreen(rerender, navigate);

  if (step === 'model') {
    return shell(rerender, navigate, {
      title: 'Choose who does the thinking.',
      lede: 'Local runtimes are listed first because they are the only configuration where “nothing leaves this machine” is unconditional. A hosted key works exactly as well, and your mail summaries go to that provider and nowhere else.',
      body: modelPanel({ compact: true, onDone: () => next(rerender) }),
      primary: button('Next', { class: 'btn solid', onClick: () => next(rerender) }),
    });
  }

  if (step === 'mail') {
    return shell(rerender, navigate, {
      title: 'Point it at a mailbox.',
      lede: 'This is the step people fall off, and it is worth knowing why before you start: Gmail, iCloud and Yahoo will all refuse your normal password here. '
        + 'Two-factor accounts do not hand it to third-party programs at all — you generate a separate app password in your provider’s security settings and paste that instead. '
        + 'The provider’s own note appears under the host once you pick one, and “Test the connection” proves it works before you move on.',
      body: mailPanel({ compact: true, rerender, onDone: () => rerender() }),
      primary: button('Next', { class: 'btn solid', onClick: () => next(rerender) }),
    });
  }

  if (step === 'calendar') {
    return shell(rerender, navigate, {
      title: 'And a calendar.',
      lede: 'A subscription URL, a CalDAV account, or a file on disk. Times keep the offset your calendar published them with, so nothing slides when you travel.',
      body: calendarPanel({ compact: true, rerender, onDone: () => rerender() }),
      primary: button('Next', { class: 'btn solid', onClick: () => next(rerender) }),
    });
  }

  const ready = Boolean(state.health?.model?.configured)
    && ((state.config?.mail?.length || 0) + (state.config?.calendars?.length || 0)) > 0;

  return shell(rerender, navigate, {
    title: 'Run the first sweep.',
    lede: ready
      ? 'This fetches your recent mail and calendar, then asks your model to read the pile once. It takes as long as it takes; the progress below is real.'
      : 'A sweep needs a model and at least one source. Go back and add one, or head to the board — everything still works, there is just nothing to read yet.',
    body: el('div', { class: 'stack' }, [
      sweepProgress(),
      !ready ? el('p', { class: 'quiet-note', text: 'Missing: '
        + [!state.health?.model?.configured ? 'a model' : null,
          !((state.config?.mail?.length || 0) + (state.config?.calendars?.length || 0)) ? 'a source' : null]
          .filter(Boolean).join(' and ') + '.' }) : null,
    ]),
    primary: button(state.sweep.running ? 'Sweeping…' : 'Sweep now', {
      class: 'btn solid',
      disabled: !ready || state.sweep.running,
      onClick: async () => {
        await startSweep('full');
        await refresh({ silent: true });
      },
    }),
  });
}
