/**
 * scopes.js — the AI-access picker.
 *
 * This is not an illustration of the scope model, it is the scope model. Every
 * id, label, summary, tool name and default below is lifted from `core/mcp.mjs`
 * in the application, and the two rules that are easy to get wrong are the two
 * that matter most here:
 *
 *   1. **Access is off, not narrow.** Until the master switch is on, every tool
 *      is absent from `tools/list` and refused by `tools/call` even if a client
 *      hardcodes a name it saw earlier.
 *   2. **`mail.bodies` implies `mail.metadata`.** Ticking the body scope turns
 *      its parent on, because a body without its envelope is not a thing the
 *      app can hand over. Nothing else implies anything: turning on the
 *      calendar turns on the calendar.
 *
 * The payload panel shows shapes, not real data — the values are invented, the
 * fields are the ones the scope actually names.
 */

const SCOPES = [
  {
    id: 'board',
    label: 'Board',
    summary: 'The triaged items: headline, why it matters, which bucket, when it is due, '
      + 'who it involves.',
    tools: ['zelos_board', 'zelos_item', 'zelos_search'],
    implies: [],
    sensitive: false,
    on: true,          // pre-ticked when access is switched on
  },
  {
    id: 'calendar',
    label: 'Calendar',
    summary: 'Events in a window: title, start and end, location, attendees. '
      + 'Not the event description.',
    tools: ['zelos_calendar', 'zelos_search'],
    implies: [],
    sensitive: false,
    on: true,
  },
  {
    id: 'mail.metadata',
    label: 'Mail, without the mail',
    summary: 'Sender, subject, date and the short stored snippet. No message body.',
    tools: ['zelos_search', 'zelos_thread'],
    implies: [],
    sensitive: false,
    on: false,
  },
  {
    id: 'mail.bodies',
    label: 'Mail, in full',
    summary: 'The full text of your messages. This is the most exposing choice here: with it on, '
      + 'the AI you connect can read every indexed message end to end.',
    tools: [],         // upgrades the mail.metadata tools rather than adding its own
    implies: ['mail.metadata'],
    sensitive: true,
    on: false,
  },
  {
    id: 'drafts',
    label: 'Drafts',
    summary: 'The replies Zelos has written for you, including their text. Zelos never sends them.',
    tools: ['zelos_drafts'],
    implies: [],
    sensitive: false,
    on: false,
  },
  {
    id: 'people',
    label: 'People',
    summary: 'Who you correspond with and how recently: name, address, message counts. '
      + 'No subjects, no bodies.',
    tools: ['zelos_people'],
    implies: [],
    sensitive: false,
    on: false,
  },
];

const ALL_TOOLS = ['zelos_board', 'zelos_item', 'zelos_calendar', 'zelos_search',
  'zelos_thread', 'zelos_drafts', 'zelos_people'];

/* One lane per scope in the wall animation, in the same order as the list, so a
   tick and the stream it opens are on the same line of sight. */
const LANES = [
  { id: 'board', short: 'BOARD', colour: '#949494' },
  { id: 'calendar', short: 'CAL', colour: '#b5b5b5' },
  { id: 'mail.metadata', short: 'MAIL', colour: '#d4d4d4' },
  /* The one scope the page calls most exposing takes the one warm colour on
     the site — the same --ember its tick and its label already carry, so the
     stream you watch cross the wall is the colour of the thing that crosses a
     boundary everywhere else here. */
  { id: 'mail.bodies', short: 'BODIES', colour: '#878787' },
  { id: 'drafts', short: 'DRAFTS', colour: '#d0d0d0' },
  { id: 'people', short: 'PEOPLE', colour: '#afafaf' },
];

/* Invented, deliberately. A sample payload on a public page should never be a
   real message — see the packaging gate in the app for the same rule. */
const SAMPLE = {
  board: [
    '  {', '    "id": "itm_4c1",', '    "bucket": "owed",',
    '    "headline": "Marcus is waiting on the',
    '                 retainage figure",',
    '    "why": "You said Tuesday. It is Thursday.",',
    '    "due": "2026-08-12"', '  }',
  ].join('\n'),
  calendar: [
    '  {', '    "title": "Site walk — Fairbanks",',
    '    "start": "2026-08-11T14:00",',
    '    "end":   "2026-08-11T15:00",',
    '    "location": "1140 W 9th",',
    '    "attendees": ["marcus@…", "dana@…"]', '  }',
  ].join('\n'),
  'mail.metadata': [
    '  {', '    "from": "marcus@fairbanks.example",',
    '    "subject": "Retainage on invoice 4471",',
    '    "date": "2026-08-07T09:12",',
    '    "snippet": "Just circling back on the',
    '                draw — need the…"',
    '    // 240 characters. no body.', '  }',
  ].join('\n'),
  'mail.bodies': [
    '  {', '    "from": "marcus@fairbanks.example",',
    '    "subject": "Retainage on invoice 4471",',
    '    "date": "2026-08-07T09:12",',
    '    "body": "Just circling back on the draw —',
    '             need the retainage figure before',
    '             Friday or it slips a cycle. Also',
    '             the lien waiver from…"',
    '    // the whole message. every message.', '  }',
  ].join('\n'),
  drafts: [
    '  {', '    "replyTo": "itm_4c1",',
    '    "text": "Marcus — retainage on 4471 is',
    '             $18,400. Waiver this afternoon."', '  }',
  ].join('\n'),
  people: [
    '  {', '    "name": "Marcus Reyes",',
    '    "address": "marcus@fairbanks.example",',
    '    "messages": 214,', '    "lastSeen": "2026-08-07"', '  }',
  ].join('\n'),
};

export { LANES };

export function createScopes(root, gate) {
  const master = root.querySelector('#ai-enabled');
  const masterState = root.querySelector('[data-master-state]');
  const hint = root.querySelector('[data-hint]');
  const list = root.querySelector('[data-scope-list]');
  const toolsEl = root.querySelector('[data-tools]');
  const countEl = root.querySelector('[data-tool-count]');
  const payloadEl = root.querySelector('[data-payload]');
  const footEl = root.querySelector('[data-foot]');
  if (!master || !list) return null;

  const state = new Map(SCOPES.map((s) => [s.id, s.on]));

  /* Build the rows once. Each is a real label element so the whole row is a hit
     target and the checkbox keeps its native keyboard behaviour — this is a
     control, not a picture of one. */
  for (const s of SCOPES) {
    const li = document.createElement('li');
    li.className = 'scope' + (s.sensitive ? ' is-sensitive' : '');
    li.innerHTML = `
      <label>
        <input type="checkbox" data-scope="${s.id}">
        <span class="tick" aria-hidden="true"></span>
        <span class="scope-text">
          <b>${s.label}${s.sensitive ? ' <i>most exposing</i>' : ''}</b>
          <code>${s.id}</code>
          <em>${s.summary}</em>
        </span>
      </label>`;
    list.appendChild(li);
  }

  const boxes = [...list.querySelectorAll('input[data-scope]')];

  function apply(changedId) {
    // mail.bodies implies mail.metadata — enforced on the way in, so the panel
    // can never show a state the app would not accept.
    if (changedId === 'mail.bodies' && state.get('mail.bodies')) {
      state.set('mail.metadata', true);
    }
    // …and dropping the envelope drops the bodies with it, for the same reason.
    if (changedId === 'mail.metadata' && !state.get('mail.metadata')) {
      state.set('mail.bodies', false);
    }
    render();
  }

  function render() {
    const on = master.checked;
    root.classList.toggle('is-live', on);
    masterState.textContent = on ? 'on' : 'off';

    for (const b of boxes) {
      b.checked = on && state.get(b.dataset.scope);
      b.disabled = !on;
    }

    const live = SCOPES.filter((s) => on && state.get(s.id));
    const liveIds = new Set(live.map((s) => s.id));

    // The wall animation takes the same state, not a copy of it.
    if (gate) gate.setState(on, liveIds);

    // A tool is present only if a live scope names it. mail.bodies names none:
    // it upgrades what the mail tools return rather than adding a door.
    const open = new Set();
    for (const s of live) for (const t of s.tools) open.add(t);

    toolsEl.innerHTML = ALL_TOOLS.map((t) => `<li class="tool${open.has(t) ? ' is-open' : ''}">`
      + `<span aria-hidden="true"></span>${t}</li>`).join('');
    countEl.textContent = `${open.size} of ${ALL_TOOLS.length}`;

    if (!on) {
      hint.textContent = 'Nothing is exposed. Every tool is absent from the client’s list, '
        + 'and would be refused even if it asked by name.';
      payloadEl.textContent = '// nothing. tools/list is empty.';
      footEl.textContent = '';
      return;
    }

    hint.textContent = liveIds.size
      ? 'Enforced twice: a scope that is off means its tools are missing from the list AND '
        + 'refused by name.'
      : 'Access is on, but nothing is ticked — which is the same as nothing exposed.';

    // The payload panel shows the most exposing live scope's shape, so the cost
    // of the last tick is what you are looking at.
    const order = ['mail.bodies', 'mail.metadata', 'drafts', 'people', 'calendar', 'board'];
    const shown = order.find((id) => liveIds.has(id));
    payloadEl.textContent = shown
      ? `// ${shown}\n[\n${SAMPLE[shown]}\n]`
      : '// nothing ticked. tools/list is empty.';

    /* The part that is genuinely counter-intuitive, and the reason this panel
       is worth building: with bodies off, body text is not merely withheld from
       the response, it is not searchable. The full-text index is confined to
       the columns the live scopes own, so a word that appears only inside a
       message cannot be used to confirm the message exists. */
    footEl.innerHTML = liveIds.has('mail.bodies')
      ? '<b>Bodies are on.</b> The assistant can read every indexed message end to end, and '
        + 'search inside them. This is the one tick on this page that hands over the mail itself.'
      : liveIds.has('mail.metadata')
        ? '<b>Bodies are off, and that reaches the search index too.</b> A word that appears only '
          + 'inside a message returns nothing — not a hit with the text withheld, nothing. '
          + 'Otherwise the search would be an oracle for confirming any word it could guess.'
        : liveIds.has('board')
          ? '<b>The board is derived from your mail.</b> A headline and its “why” are '
            + 'written about a message and can quote one. Not a contradiction — but not '
            + '“the AI learns nothing about my mail” either.'
          : '';
  }

  master.addEventListener('change', render);
  for (const b of boxes) {
    b.addEventListener('change', () => {
      state.set(b.dataset.scope, b.checked);
      apply(b.dataset.scope);
    });
  }

  render();
  return { render };
}
