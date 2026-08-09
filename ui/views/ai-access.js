/**
 * ui/views/ai-access.js — the panel where someone hands their mail to an AI.
 *
 * This is the most exposing screen in the app, so it is deliberately the least
 * convenient one. Four decisions drive everything below:
 *
 *  1. **It explains before it offers.** Every scope carries a sentence saying
 *     what that scope actually hands over, written as a fact rather than as
 *     reassurance. Someone who reads this page slowly should be able to say out
 *     loud what they allowed. If the copy here ever reads like marketing, it is
 *     wrong.
 *  2. **`mail.bodies` is not a checkbox.** It is the one choice that puts the
 *     full text of everything anyone has written to you on the other end of a
 *     socket, so it is a button that asks and a second button that confirms.
 *     Everything else on this page is a tick.
 *  3. **The server is the only source of truth.** All four routes —
 *     `GET/PUT /api/ai`, `POST /api/ai/tokens`, `DELETE /api/ai/tokens/:id` —
 *     answer with the same payload, so a change is applied by keeping the
 *     response, never by patching a local copy that could drift from what is on
 *     disk. In particular `effectiveScopes` is read rather than recomputed:
 *     `mail.bodies` grants mail headers, and the panel must show that without
 *     pretending the user ticked the headers box.
 *  4. **It degrades honestly.** If this build has no `/api/ai`, the panel says
 *     so in those words and still explains what each scope would hand over. It
 *     never renders a screen of controls that quietly do nothing.
 *
 * A note on state. The settings view re-renders wholesale whenever anything
 * bumps `state.rev` (see ui/app.js), which would rebuild this panel underneath
 * the user. The few things that must survive that — the fetched payload, a
 * minted token that will never be shown again, an open confirmation — live at
 * module scope rather than in the closure.
 */

import { el, button, section, copyText, focusQuietly } from '../lib/dom.js';
import { api, isMissingRoute } from '../lib/api.js';
// Nothing is read from the store: `/api/ai` is the whole of this panel's truth,
// including the install paths it prints, so there is no second copy to drift.
// A cycle: settings.js imports this panel, this panel imports its form helpers.
// Both sides are `export function` declarations, which are initialised before
// either module body runs, so nothing here is touched before it exists.
import { field, input, statusLine } from './settings.js';
import { formatDay, formatTime, humanDelta } from '../lib/time.js';
import { plural } from '../lib/format.js';

/* ------------------------------------------------------------------ scopes */

/**
 * What each scope hands over, in this panel's words.
 *
 * `GET /api/ai` sends a `scopeInfo` entry for every scope — `{id, label,
 * summary, tools, implies, sensitive}` — and that is what drives the list, so a
 * scope added to the closed set later still renders with the server's own
 * description. These longer sentences replace `summary` where they exist,
 * because the short form is accurate but does not make anyone stop, and
 * stopping is the entire job of this list.
 */
const SCOPE_COPY = {
  board: {
    what: 'Every item Zelos has triaged: the headline it wrote, the reason it gave, the bucket, the due date, and the person the item is about — with their address.',
  },
  calendar: {
    what: 'Events in whatever window is asked for: title, start and end, location, and the full attendee list, everyone’s email address included.',
  },
  'mail.metadata': {
    what: 'Who wrote to you, what the subject line said, when it arrived, and the opening lines Zelos keeps as a snippet. The body is withheld — but search runs over the indexed body, so a hit still reveals that a word appears somewhere in a message.',
  },
  'mail.bodies': {
    exposing: true,
    what: 'The entire text of the messages Zelos has indexed. Not a summary and not an extract — the message, as it was written. Zelos cannot tell which of those were written to you in confidence, so it does not try to hold any of them back.',
    also: 'This grants mail headers too, whether or not that box is ticked: a body is returned with the message it belongs to.',
  },
  drafts: {
    what: 'The replies Zelos has drafted on your behalf, in full — including the ones you have not read yet and the ones you decided against.',
  },
  people: {
    what: 'The addresses in your mail, how often each appears, and when you last heard from them. That is a map of who you talk to, which is worth reading on its own, without a single message attached.',
  },
};

/** How each scope is named inside a running sentence. */
const SHORT = {
  board: 'your board',
  calendar: 'your calendar',
  'mail.metadata': 'mail headers',
  'mail.bodies': 'full message text',
  drafts: 'your drafts',
  people: 'your contacts',
};

/**
 * The scope list this panel falls back to when there is no server to ask — the
 * closed set from SPEC-v2 §1, so the "not in this build" screen can still teach
 * what the choices would be.
 */
const FALLBACK_SCOPE_INFO = [
  { id: 'board', label: 'Board', tools: ['zelos_board', 'zelos_item'] },
  { id: 'calendar', label: 'Calendar', tools: ['zelos_calendar'] },
  { id: 'mail.metadata', label: 'Mail, without the mail', tools: ['zelos_search', 'zelos_thread'] },
  { id: 'mail.bodies', label: 'Mail, in full', tools: [], implies: ['mail.metadata'], sensitive: true },
  { id: 'drafts', label: 'Drafts', tools: ['zelos_drafts'] },
  { id: 'people', label: 'People', tools: ['zelos_people'] },
];

/* ------------------------------------------- state that outlives a rebuild */

/** The last payload from any of the four routes. */
let data = null;
/** `'boot' | 'ready' | 'missing' | 'error'`. */
let phase = 'boot';
let loadError = '';
/** A minted token, held only until the user says they have copied it. */
let revealed = null;
/** `{kind:'bodies'|'revoke', id}` — an armed confirmation. */
let pending = null;
/** `{text, tone}` — painted into the live region once it is in the document. */
let announcement = null;

let uid = 0;
const nextId = (prefix) => `${prefix}-ai-${(uid += 1)}`;

/* ---------------------------------------------------------------- reading */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The payload, with every field this panel reads given a safe shape. */
function view() {
  const raw = isObject(data) ? data : {};
  const info = Array.isArray(raw.scopeInfo) && raw.scopeInfo.length ? raw.scopeInfo : FALLBACK_SCOPE_INFO;
  const scopes = isObject(raw.scopes) ? raw.scopes : {};
  const effective = isObject(raw.effectiveScopes) ? raw.effectiveScopes : scopes;
  const rows = Number(raw.maxRows);
  return {
    enabled: raw.enabled === true,
    scopes,
    effective,
    maxRows: Number.isFinite(rows) && rows > 0 ? rows : 50,
    tokens: Array.isArray(raw.tokens) ? raw.tokens.filter(isObject) : [],
    access: Array.isArray(raw.access) ? raw.access.filter(isObject) : [],
    client: isObject(raw.client) ? raw.client : {},
    scopeInfo: info.filter(isObject).map((s) => {
      const copy = SCOPE_COPY[s.id] || {};
      const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
      return {
        id: String(s.id || ''),
        label: String(s.label || s.id || ''),
        tools: strings(s.tools),
        implies: strings(s.implies),
        // `sensitive` is the server's word for it. The local copy names the same
        // scope independently, so a build that dropped the flag still cannot
        // turn mail.bodies into an ordinary tick.
        exposing: s.sensitive === true || copy.exposing === true,
        what: copy.what || (typeof s.summary === 'string' ? s.summary : ''),
        also: copy.also || '',
      };
    }).filter((s) => s.id),
  };
}

/** "a, b and c" — a sentence, not a list. */
function listWords(words) {
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function nameOf(scope) {
  return SHORT[scope.id] || scope.label.toLowerCase();
}

/**
 * One sentence describing what is exposed *right now*, derived from the payload
 * rather than written down beside it — a summary that can drift from the
 * switches it summarises is worse than no summary at all.
 */
function exposureLine(v) {
  const on = v.scopeInfo.filter((s) => v.effective[s.id]).map(nameOf);
  if (!v.enabled) {
    return on.length
      ? `Nothing is exposed. The switch is off, so the ${plural(on.length, 'scope')} ticked below do nothing until you turn it on.`
      : 'Nothing is exposed. The switch is off and no scope is ticked.';
  }
  if (!on.length) {
    return 'The switch is on, but no scope is ticked, so every tool call comes back empty. That is a working configuration — just not a useful one.';
  }
  if (!v.tokens.length) {
    return `${capitalise(listWords(on))} would be readable over HTTP, but no token has been minted yet. A client spawning Zelos directly can already read them.`;
  }
  return `${capitalise(listWords(on))} can be read by ${plural(v.tokens.length, 'token')}, up to ${plural(v.maxRows, 'row')} at a time, until you turn this off.`;
}

/* ---------------------------------------------------------- config blocks */

/**
 * What goes in an AI client's own config file. The stdio form is what a desktop
 * client spawns; the HTTP form is for clients that would rather post. Both are
 * built from the paths the server reported, so what is on screen is where this
 * copy of Zelos actually lives.
 */
function stdioBlock(client) {
  const server = {
    command: typeof client.command === 'string' && client.command ? client.command : 'npx',
    args: Array.isArray(client.args) && client.args.length ? client.args : ['-y', 'zelos-app', 'mcp'],
  };
  if (client.home) server.env = { ZELOS_HOME: client.home };
  return JSON.stringify({ mcpServers: { zelos: server } }, null, 2);
}

function httpBlock(client) {
  return JSON.stringify({
    mcpServers: {
      zelos: {
        type: 'http',
        url: client.httpUrl || `${window.location.origin}/api/mcp`,
        headers: { Authorization: 'Bearer PASTE-THE-TOKEN-YOU-MINTED' },
      },
    },
  }, null, 2);
}

/** A code block with a copy button beside its heading. */
function codeCard(title, text, note, onCopied) {
  return el('div', { class: 'ai-code' }, [
    el('div', { class: 'ai-code-head' }, [
      el('span', { class: 'ai-code-title', text: title }),
      button('Copy', {
        class: 'btn quiet',
        onClick: async () => {
          const ok = await copyText(text);
          onCopied(
            ok ? `${title} block copied.` : 'Could not reach the clipboard — select the block and copy it by hand.',
            ok ? 'good' : 'bad',
          );
        },
      }),
    ]),
    note ? el('p', { class: 'field-hint', text: note }) : null,
    el('pre', { class: 'code' }, el('code', { text })),
  ]);
}

/* --------------------------------------------------------------- one scope */

/**
 * A scope row. `mail.bodies` gets a different one on purpose: an accent edge, a
 * marker, and a button instead of a tick, so that turning it on is an act
 * rather than a stray click on the way past.
 */
function scopeRow(scope, { ticked, effective, grantedBy, readOnly, armed, onToggle, onArm, onCancel }) {
  // A span, not a div: for the ordinary scopes this is wrapped in a <label>,
  // whose content model is phrasing content only.
  const head = el('span', { class: 'scope-head' }, [
    el('span', { class: 'scope-label', text: scope.label }),
    el('code', { class: 'mono scope-name', text: scope.id }),
    scope.exposing ? el('span', { class: 'scope-mark', text: 'the most exposing choice' }) : null,
  ]);

  const body = [
    el('p', { class: 'scope-what', text: scope.what }),
    scope.also ? el('p', { class: 'scope-also', text: scope.also }) : null,
    // Granted, but not by this box. `mail.bodies` carries mail headers with it,
    // and saying nothing here would let someone believe they had closed a door
    // that is still open. The grant is read off the server's `implies`, so it
    // stays true if the closed set ever grows another one.
    grantedBy
      ? el('p', { class: 'scope-granted', text: `On right now because ${grantedBy} is on. Unticking this box changes nothing while that stays on.` })
      : null,
    scope.tools.length
      ? el('p', { class: 'scope-tools' }, [
        el('span', { class: 'scope-tools-label', text: 'Tools' }),
        ...scope.tools.map((t) => el('code', { class: 'mono scope-tool', text: t })),
      ])
      : null,
  ];

  /* --- the ordinary scopes: a tick, a name, a fact ---------------------- */
  if (!scope.exposing) {
    const id = nextId('scope');
    const box = el('input', { class: 'checkbox', type: 'checkbox', id });
    box.checked = ticked;
    if (readOnly) box.disabled = true;
    else box.addEventListener('change', () => onToggle(box.checked));
    return el('div', { class: `scope${effective ? ' is-on' : ''}` }, [
      el('div', { class: 'scope-toggle' }, [
        box,
        el('label', { class: 'scope-toggle-label', for: id }, head),
      ]),
      ...body,
    ]);
  }

  /* --- mail.bodies ------------------------------------------------------ */
  const stateChip = el('span', {
    class: `scope-state${ticked ? ' is-on' : ''}`,
    text: ticked ? 'on — bodies are being handed over' : 'off — bodies are withheld',
  });

  let action = null;
  if (readOnly) {
    action = null;
  } else if (armed) {
    action = el('div', { class: 'scope-confirm', role: 'group', 'aria-label': 'Confirm full message text' }, [
      el('p', { class: 'scope-confirm-q', text: 'Hand over the full text of your mail?' }),
      el('p', { class: 'scope-confirm-what', text: 'From the moment you confirm, anything Zelos has let in can read the whole of every message it has indexed, as often as it likes, until you turn this off. It grants mail headers with it.' }),
      el('div', { class: 'row-inline' }, [
        button('Yes — hand over full message text', {
          class: 'btn solid',
          'data-confirm': 'true',
          onClick: () => onToggle(true),
        }),
        button('Cancel', { class: 'btn quiet', onClick: onCancel }),
      ]),
    ]);
  } else {
    action = el('div', { class: 'row-inline' }, button(
      ticked ? 'Stop handing over message text' : 'Turn on full message text…',
      { class: ticked ? 'btn quiet' : 'btn', onClick: () => (ticked ? onToggle(false) : onArm()) },
    ));
  }

  return el('div', { class: `scope scope-exposing${ticked ? ' is-on' : ''}` }, [
    head,
    stateChip,
    ...body,
    action,
  ]);
}

/* ------------------------------------------------------------- token rows */

function tokenRow(token, { armed, onArm, onCancel, onRevoke }) {
  const label = typeof token.label === 'string' && token.label ? token.label : 'unnamed token';
  const created = token.createdAt
    ? `minted ${formatDay(token.createdAt)}${formatTime(token.createdAt) ? ` at ${formatTime(token.createdAt)}` : ''}`
    : 'minted at an unrecorded time';
  const used = token.lastUsedAt ? `last used ${humanDelta(token.lastUsedAt)}` : 'never used';

  return el('div', { class: 'ai-token' }, [
    el('div', { class: 'ai-token-head' }, [
      el('span', { class: 'ai-token-label', text: label }),
      el('code', { class: 'mono ai-token-id', text: String(token.id || '—') }),
    ]),
    el('p', { class: 'ai-token-meta', text: `${created} · ${used}` }),
    armed
      ? el('div', { class: 'ai-token-confirm', role: 'group', 'aria-label': `Confirm revoking ${label}` }, [
        el('p', { class: 'ai-token-confirm-q', text: `Revoke ${label}? Anything using it stops working the moment you do, and the value cannot be recovered.` }),
        el('div', { class: 'row-inline' }, [
          button('Revoke it', { class: 'btn solid', 'data-confirm': 'true', onClick: onRevoke }),
          button('Keep it', { class: 'btn quiet', onClick: onCancel }),
        ]),
      ])
      : el('div', { class: 'row-inline' }, button('Revoke', { class: 'btn quiet', onClick: onArm })),
  ]);
}

/* --------------------------------------------------------------- log rows */

function logRow(entry) {
  const refused = entry.ok === false;
  const rows = Number(entry.rows);
  const when = entry.at
    ? `${humanDelta(entry.at)}${formatTime(entry.at) ? ` · ${formatTime(entry.at)}` : ''}`
    : 'time not recorded';
  const who = typeof entry.label === 'string' && entry.label
    ? entry.label
    : (typeof entry.client === 'string' ? entry.client : '');

  return el('div', { class: `ai-log-row${refused ? ' is-refused' : ''}` }, [
    el('code', { class: 'mono ai-log-tool', text: String(entry.tool || 'unknown tool') }),
    el('span', { class: 'ai-log-scope', text: String(entry.scope || 'no scope') }),
    el('span', {
      class: 'ai-log-rows mono',
      text: refused ? 'refused' : plural(Number.isFinite(rows) ? rows : 0, 'row'),
    }),
    who ? el('span', { class: 'ai-log-label', text: who }) : null,
    // Last, and pushed to the far edge, so the times line up down the column.
    el('span', { class: 'ai-log-when', text: when }),
  ]);
}

/* -------------------------------------------------------------- the panel */

/**
 * The AI access panel.
 *
 * It takes no `rerender` seam, unlike the other settings panels: it does not
 * write through `saveConfig`, so nothing it does bumps `state.rev`, and every
 * one of its routes hands back the whole state. It repaints itself, and the
 * rest of Settings has nothing to redraw when it does.
 */
export function aiAccessPanel() {
  const wrap = el('div', { class: 'panel panel-ai' });
  const live = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const mintStatus = statusLine();
  let busy = false;

  /** Say something in the live region. Set before a request, painted after. */
  function say(text, tone = 'good') {
    announcement = text ? { text, tone } : null;
  }

  /**
   * A live region only announces when its content *changes* after it is in the
   * document — text baked in at build time is silent. Filling it one frame
   * later is what makes a rebuilt panel still speak.
   */
  function paintLive() {
    if (!announcement) {
      live.textContent = '';
      live.className = 'status';
      return;
    }
    const { text, tone } = announcement;
    live.className = `status is-${tone}`;
    requestAnimationFrame(() => { live.textContent = text; });
  }

  function paint() {
    wrap.replaceChildren(...build());
    paintLive();
    if (pending) {
      const target = wrap.querySelector('[data-confirm]');
      if (target) focusQuietly(target);
    }
  }

  /* ------------------------------------------------------------ requests */

  /**
   * Every route answers with the whole state, so applying a change is keeping
   * the response. Nothing here patches a local copy — a panel that guessed the
   * outcome of a write is a panel that can show a scope as open when the server
   * refused it.
   */
  async function run(work, { message = null, onDone = null } = {}) {
    if (busy) return;
    busy = true;
    try {
      const res = await work();
      data = res;
      phase = 'ready';
      if (message) say(message);
      onDone?.(res);
    } catch (err) {
      if (isMissingRoute(err) && phase === 'boot') {
        phase = 'missing';
      } else if (phase === 'boot') {
        phase = 'error';
        loadError = err.message;
      } else {
        say(`That did not happen: ${err.message}`, 'bad');
      }
    } finally {
      busy = false;
      paint();
    }
  }

  const load = () => run(() => api.ai());

  function setEnabled(next) {
    const v = view();
    const on = v.scopeInfo.filter((s) => v.effective[s.id]).map(nameOf);
    run(() => api.saveAi({ enabled: next }), {
      message: next
        ? (on.length
          ? `AI access is on. ${capitalise(listWords(on))} can now be read.`
          : 'AI access is on, but no scope is ticked, so there is nothing to read yet.')
        : 'AI access is off. Nothing is exposed, and a client holding a token is refused.',
    });
  }

  /**
   * One scope, one write. The server stores exactly what it is given and works
   * out `effectiveScopes` itself, so this must not "helpfully" tick mail
   * headers when bodies goes on — the box a person did not touch stays untouched
   * and the row says where the grant came from instead.
   */
  function setScope(scope, next) {
    const v = view();
    pending = null;
    const noun = capitalise(nameOf(scope));
    const tail = v.enabled ? '' : ' The switch is still off, so nothing is exposed yet.';
    const extra = scope.exposing && next ? ' Mail headers come with it.' : '';
    run(() => api.saveAi({ scopes: { [scope.id]: next } }), {
      message: `${noun} ${next ? 'is now readable' : 'is no longer readable'}.${extra}${tail}`,
    });
  }

  async function mint(label) {
    if (!label) {
      mintStatus.bad('Give the token a name first — you will want to know which client to revoke, months from now.');
      return;
    }
    mintStatus.working('Minting…');
    await run(() => api.mintAiToken(label), {
      onDone: (res) => {
        const value = typeof res?.value === 'string' ? res.value : '';
        if (!value) {
          mintStatus.bad('The server minted a token but did not return its value, so there is nothing to copy. Revoke it below and try again.');
          return;
        }
        revealed = { label, value, id: res?.token?.id || '' };
        mintStatus.clear();
        say('Token minted. Copy it now — this is the only time it is shown.');
      },
    });
  }

  function revoke(token) {
    pending = null;
    run(() => api.revokeAiToken(token.id), {
      onDone: (res) => {
        if (revealed && revealed.id && revealed.id === token.id) revealed = null;
        say(res?.revoked === false
          ? 'That token was already gone.'
          : `${token.label || 'That token'} is revoked. Anything still using it is refused.`);
      },
    });
  }

  /* --------------------------------------------------------------- parts */

  function masterBlock(v) {
    const noteId = nextId('note');
    const control = el('button', {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': v.enabled ? 'true' : 'false',
      'aria-describedby': noteId,
      onclick: () => setEnabled(!v.enabled),
    }, [
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })),
      el('span', { class: 'switch-text', text: v.enabled ? 'AI access is on' : 'AI access is off' }),
    ]);

    return el('div', { class: `ai-master${v.enabled ? ' is-on' : ''}` }, [
      control,
      el('p', {
        class: 'ai-master-note',
        id: noteId,
        text: 'Turning this on lets an AI client read the scopes you tick below, whenever it likes, without asking you again. Turning it off cuts every client off at once, token or no token.',
      }),
      el('p', { class: 'ai-summary', text: exposureLine(v) }),
      live,
    ]);
  }

  function scopeBlock(v, { readOnly = false } = {}) {
    /** Which ticked scope, if any, is what actually opened this one. */
    const grantedBy = (id) => {
      if (v.scopes[id] === true || v.effective[id] !== true) return '';
      const source = v.scopeInfo.find((s) => v.scopes[s.id] === true && s.implies.includes(id));
      return source ? nameOf(source) : '';
    };

    return el('div', { class: 'scope-list' }, v.scopeInfo.map((scope) => scopeRow(scope, {
      ticked: v.scopes[scope.id] === true,
      effective: v.effective[scope.id] === true,
      grantedBy: grantedBy(scope.id),
      readOnly,
      armed: pending?.kind === 'bodies' && pending.id === scope.id,
      onToggle: (next) => setScope(scope, next),
      onArm: () => { pending = { kind: 'bodies', id: scope.id }; paint(); },
      onCancel: () => { pending = null; paint(); },
    })));
  }

  function revealBlock() {
    if (!revealed) return null;
    return el('div', { class: 'ai-reveal', role: 'group', 'aria-label': 'Your new token' }, [
      el('p', { class: 'ai-reveal-eyebrow', text: `Token for ${revealed.label}` }),
      el('p', { class: 'mono ai-reveal-value', text: revealed.value }),
      el('p', {
        class: 'ai-reveal-warn',
        text: 'This is the only time Zelos will show this value. It went into the same store as your mail password, and no route in this app reads a secret back — if you lose it, revoke the token and mint another.',
      }),
      el('div', { class: 'row-inline' }, [
        button('Copy the token', {
          class: 'btn solid',
          onClick: async () => {
            const ok = await copyText(revealed.value);
            mintStatus[ok ? 'good' : 'bad'](ok
              ? 'Copied. Paste it into your client before you hide this.'
              : 'Could not reach the clipboard — select the value above and copy it by hand.');
          },
        }),
        button('I have copied it — hide it', {
          class: 'btn quiet',
          onClick: () => { revealed = null; mintStatus.clear(); paint(); },
        }),
      ]),
    ]);
  }

  function tokenBlock(v) {
    const labelInput = input({ placeholder: 'Claude Desktop on this laptop', maxlength: '60' });
    const submit = () => mint(labelInput.value.trim());
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    return el('div', { class: 'ai-tokens' }, [
      el('p', { class: 'field-hint', text: 'A client connecting over HTTP proves it is allowed by presenting a token. Mint one per client, so revoking one leaves the others working.' }),
      revealBlock(),
      el('div', { class: 'ai-mint' }, [
        field('Name this token', labelInput, { hint: 'Whatever tells you which client it is. You will be reading this list months from now.' }),
        el('div', { class: 'row-inline' }, button('Mint a token', { class: 'btn solid', onClick: submit })),
        mintStatus.node,
      ]),
      v.tokens.length
        ? el('div', { class: 'stack' }, v.tokens.map((token) => tokenRow(token, {
          armed: pending?.kind === 'revoke' && pending.id === token.id,
          onArm: () => { pending = { kind: 'revoke', id: token.id }; paint(); },
          onCancel: () => { pending = null; paint(); },
          onRevoke: () => revoke(token),
        })))
        : el('p', { class: 'quiet-note', text: 'No token has been minted, so nothing can connect over HTTP.' }),
    ]);
  }

  function logBlock(v) {
    return el('div', { class: 'ai-log-wrap' }, [
      el('p', { class: 'field-hint', text: 'One line for every call Zelos answered: the tool that was called, the scope it was spent against, and how many rows went back. It is written on this machine and goes nowhere.' }),
      v.access.length
        ? el('div', { class: 'ai-log' }, v.access.map(logRow))
        : el('p', { class: 'quiet-note', text: 'Nothing has read anything yet.' }),
      el('div', { class: 'row-inline' }, button('Refresh', { class: 'btn quiet', onClick: load })),
    ]);
  }

  function connectBlock(v) {
    const onCopied = (text, tone) => { say(text, tone); paintLive(); };
    const known = Boolean(v.client.command);

    return el('div', { class: 'ai-connect' }, [
      codeCard(
        'Claude Desktop, and anything else that spawns a server',
        stdioBlock(v.client),
        known
          ? 'Those are the real paths to this copy of Zelos. A client that spawns it this way runs it as you, so it presents no token — the switch above and the scopes below it are the whole of what holds.'
          : 'Generic form: this build did not report where it is installed. Replace the command with the path to your own copy.',
        onCopied,
      ),
      el('p', {
        class: 'field-hint',
        text: 'Claude Desktop keeps that file at ~/Library/Application Support/Claude/claude_desktop_config.json on macOS and %APPDATA%\\Claude\\claude_desktop_config.json on Windows. Merge this into what is already there — a file with two mcpServers keys keeps only the last.',
      }),
      codeCard(
        'Any MCP client, over HTTP',
        httpBlock(v.client),
        'Paste a token you minted above in place of the placeholder. This address only answers on this machine, and only while Zelos is running.',
        onCopied,
      ),
    ]);
  }

  function limitsBlock() {
    return el('ul', { class: 'plain-list' }, [
      el('li', { text: 'Every tool here reads. There is no tool that sends a message, edits an item, deletes a row or changes a setting — not a disabled one, none at all.' }),
      el('li', { text: 'A scope that is off is not merely hidden: its tool is absent from the list the client is given, and a call to it is refused.' }),
      el('li', { text: 'The master switch is checked before the token is, so a credential minted and then switched off cannot be used to probe anything.' }),
      el('li', { text: 'This is a door into the database in your Zelos home. It is not a door into your mail server — nothing here can reach back to your provider.' }),
    ]);
  }

  /* --------------------------------------------------------------- build */

  const LEDE = 'Zelos can act as a knowledge source for an AI assistant you already use, over MCP — the protocol Claude Desktop and most current clients speak.';

  function unavailableBody() {
    const v = view();  // empty payload: the fallback scope list, nothing ticked
    return [
      el('p', { class: 'panel-lede', text: LEDE }),
      el('div', { class: 'banner banner-warn', role: 'status' }, [
        el('h3', { class: 'banner-title', text: 'Not available in this build' }),
        el('p', { class: 'banner-detail', text: 'This copy of Zelos does not answer on /api/ai, so there is nothing here to turn on and nothing is exposed. What follows is what the feature would offer and what each choice would hand over, so the decision is already made when a build that has it arrives.' }),
      ]),
      section('What each scope would hand over', {}, scopeBlock(v, { readOnly: true })),
      section('What it would never do', {}, limitsBlock()),
    ];
  }

  function build() {
    if (phase === 'boot') {
      return [
        el('p', { class: 'panel-lede', text: LEDE }),
        el('p', { class: 'quiet-note', text: 'Asking this build what it exposes…' }),
      ];
    }
    if (phase === 'missing') return unavailableBody();
    if (phase === 'error') {
      return [
        el('p', { class: 'panel-lede', text: LEDE }),
        el('div', { class: 'banner banner-warn', role: 'status' }, [
          el('h3', { class: 'banner-title', text: 'This panel could not read its own settings' }),
          el('p', { class: 'banner-detail', text: `${loadError} — until that is answered, treat AI access as unknown rather than off.` }),
          el('div', { class: 'banner-actions' }, button('Try again', { class: 'btn quiet', onClick: load })),
        ]),
      ];
    }

    const v = view();
    return [
      el('p', { class: 'panel-lede', text: `${LEDE} It is off until you turn it on, and what it hands over is exactly what you tick below and nothing else.` }),
      masterBlock(v),
      section('What you are handing over', {
        note: 'Each of these is its own decision. The sentence under a scope is the list of things that leave this machine when it is on — read it before you tick it.',
      }, scopeBlock(v)),
      section('Tokens', {}, tokenBlock(v)),
      section('What your AI has read', {}, logBlock(v)),
      section('Connecting a client', {}, connectBlock(v)),
      section('What it cannot do', {}, [
        el('p', { class: 'field-hint', text: `Any single answer is capped at ${plural(v.maxRows, 'row')}. That is a ceiling on one call, not on the day — a client that wants more asks again, and each ask is a line in the log above.` }),
        limitsBlock(),
      ]),
    ];
  }

  /* ---------------------------------------------------------------- boot */

  paint();
  // A payload from an earlier visit is shown at once; the panel still refreshes,
  // because `lastUsedAt` and the access log move without anyone touching this
  // page — the numbers on this screen are the ones people check.
  load();

  return wrap;
}
