/**
 * ui/views/settings.js — the machine room.
 *
 * Every panel here writes through the server's own routes: config through
 * PUT /api/config, credentials through POST /api/secrets. Note what is missing —
 * there is no route that reads a secret back, so this file can show you that a
 * key is *stored* and never what it is. That is deliberate in core/server.mjs
 * and it is why the key fields below always start empty.
 *
 * The model panel offers local runtimes first. A model on your own machine is
 * the configuration where Zelos's central claim — nothing leaves the machine —
 * is unconditionally true, so it goes at the top, not in an "advanced" drawer.
 */

import { el, button, meander, section, copyText } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, saveConfig, setAccent, applyAccent, currentAccent, DEFAULT_ACCENT, markOnboarded } from '../lib/store.js';
import { plural } from '../lib/format.js';
import { aiAccessPanel } from './ai-access.js';

const PANELS = [
  { id: 'model', label: 'Model' },
  { id: 'mail', label: 'Mail' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'sweep', label: 'Sweeps' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'ai', label: 'AI access' },
  { id: 'data', label: 'Data' },
  { id: 'about', label: 'About' },
];

let uid = 0;
const nextId = (prefix) => `${prefix}-${(uid += 1)}`;

/**
 * Common IMAP hosts, as a typing aid only. core/sources/imap.mjs has the real
 * `guessImapHost`, but no route exposes it — rather than duplicate its logic
 * client-side, this is a plain datalist of hostnames and the app-password note
 * those providers require, which users otherwise read as "Zelos is broken".
 */
const IMAP_HINTS = [
  { host: 'imap.gmail.com', label: 'Gmail', note: 'Gmail needs an app password, not your account password.' },
  { host: 'imap.mail.me.com', label: 'iCloud', note: 'iCloud needs an app-specific password.' },
  { host: 'outlook.office365.com', label: 'Outlook / Microsoft 365' },
  { host: 'imap.mail.yahoo.com', label: 'Yahoo', note: 'Yahoo needs an app password.' },
  { host: 'imap.fastmail.com', label: 'Fastmail', note: 'Fastmail wants an app password too.' },
  { host: '127.0.0.1', label: 'Proton Bridge', note: 'Proton Bridge listens on 127.0.0.1:1143 without TLS.' },
];

/* ------------------------------------------------------------ form helpers */

export function field(labelText, control, { hint = null, id = null } = {}) {
  const controlId = id || nextId('f');
  control.id = controlId;
  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', for: controlId, text: labelText }),
    control,
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  ]);
}

export function input(props = {}) {
  return el('input', { class: 'input', type: 'text', ...props });
}

export function select(options, { value = '', ...props } = {}) {
  const node = el('select', { class: 'input', ...props },
    options.map((o) => el('option', { value: o.value, text: o.label })));
  node.value = value;
  return node;
}

export function checkbox(labelText, { checked = false, onChange, hint = null } = {}) {
  const id = nextId('c');
  const box = el('input', { class: 'checkbox', type: 'checkbox', id });
  box.checked = checked;
  if (onChange) box.addEventListener('change', () => onChange(box.checked));
  return el('div', { class: 'field field-check' }, [
    el('div', { class: 'check-row' }, [box, el('label', { class: 'check-label', for: id, text: labelText })]),
    hint ? el('p', { class: 'field-hint', text: hint }) : null,
  ]);
}

/** A status line that can say "working", "good" or exactly what went wrong. */
export function statusLine() {
  const node = el('p', { class: 'status', role: 'status' });
  return {
    node,
    clear() { node.textContent = ''; node.className = 'status'; },
    working(text) { node.textContent = text; node.className = 'status is-working'; },
    good(text) { node.textContent = text; node.className = 'status is-good'; },
    bad(text) { node.textContent = text; node.className = 'status is-bad'; },
  };
}

function randomId(prefix) {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/* --------------------------------------------------------------- the model */

/**
 * The model panel, shared with onboarding. `onDone` fires after a save that
 * leaves the model usable, which is what lets the onboarding flow advance.
 */
export function modelPanel({ compact = false, onDone = null } = {}) {
  const cfg = state.config?.model || {};
  const draft = {
    protocol: cfg.protocol || 'anthropic',
    label: cfg.label || '',
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    keyRef: cfg.keyRef || 'model.default',
  };

  const status = statusLine();
  const localWrap = el('div', { class: 'runtime-list' }, el('p', { class: 'quiet-note', text: 'Looking for a model running on this machine…' }));
  const presetWrap = el('div', { class: 'preset-grid' });
  const formWrap = el('div', { class: 'chosen' });

  const keyStored = () => state.secretRefs.includes(draft.keyRef);
  const isLocal = () => /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:|\/|$)/i.test(draft.baseUrl || '');

  function drawForm() {
    const modelInput = input({ value: draft.model, placeholder: 'model id, e.g. llama3.1:8b', list: 'zelos-models' });
    modelInput.addEventListener('input', () => { draft.model = modelInput.value.trim(); });

    const baseInput = input({ value: draft.baseUrl, placeholder: 'https://…' });
    baseInput.addEventListener('input', () => { draft.baseUrl = baseInput.value.trim(); });

    const keyInput = el('input', {
      class: 'input',
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: keyStored() ? 'a key is stored — type a new one to replace it' : 'paste your API key',
    });

    const datalist = el('datalist', { id: 'zelos-models' });
    const suggestions = el('div', { class: 'suggestions' });

    async function loadModels() {
      suggestions.replaceChildren(el('span', { class: 'quiet-note', text: 'Asking the endpoint what it has…' }));
      try {
        const models = await api.listModels({
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          keyRef: draft.keyRef,
        });
        datalist.replaceChildren(...models.map((m) => el('option', { value: m.id })));
        suggestions.replaceChildren(
          el('span', { class: 'quiet-note', text: `${plural(models.length, 'model')} available. ` }),
          ...models.slice(0, 8).map((m) => button(m.id, {
            class: 'pill',
            onClick: () => { draft.model = m.id; modelInput.value = m.id; },
          })),
        );
      } catch (err) {
        suggestions.replaceChildren(el('span', { class: 'quiet-note', text: `Could not list models: ${err.message}` }));
      }
    }

    async function save() {
      if (!draft.baseUrl || !draft.model) {
        status.bad('A base URL and a model id are both required.');
        return false;
      }
      status.working('Saving…');
      try {
        if (keyInput.value.trim()) {
          await api.setSecret(draft.keyRef, keyInput.value.trim());
          keyInput.value = '';
        }
        await saveConfig({
          model: {
            protocol: draft.protocol,
            label: draft.label || draft.model,
            baseUrl: draft.baseUrl,
            model: draft.model,
            keyRef: draft.keyRef,
          },
        });
        status.good('Saved.');
        return true;
      } catch (err) {
        status.bad(err.message);
        return false;
      }
    }

    async function test() {
      status.working(`Calling ${draft.baseUrl}…`);
      try {
        const result = await api.testModel({
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          model: draft.model,
          keyRef: draft.keyRef,
        });
        if (result.ok) status.good(`Answered in ${result.ms}ms: “${result.sample}”`);
        else status.bad(result.error || 'The endpoint refused the call.');
        return result.ok;
      } catch (err) {
        status.bad(err.message);
        return false;
      }
    }

    formWrap.replaceChildren(
      el('div', { class: 'chosen-head' }, [
        el('span', { class: 'chosen-label', text: draft.label || 'Custom endpoint' }),
        el('span', { class: 'mono chosen-proto', text: draft.protocol }),
        isLocal() ? el('span', { class: 'badge-local', text: 'on this machine' }) : null,
      ]),
      field('Base URL', baseInput, { hint: 'Where the requests go. Nothing else is contacted.' }),
      field('Model', modelInput, {
        hint: isLocal() ? 'Whatever your runtime has pulled.' : 'The provider’s model id, exactly as they spell it.',
      }),
      datalist,
      el('div', { class: 'row-inline' }, [
        button('List available models', { class: 'btn quiet', onClick: loadModels }),
        suggestions,
      ]),
      isLocal() && !keyStored()
        ? el('p', { class: 'field-hint', text: 'Local runtimes usually need no key, and Zelos will not invent one.' })
        : field('API key', keyInput, {
          hint: keyStored()
            ? 'A key is already stored for this slot. Zelos cannot show it back to you — there is no route that reads a secret.'
            : 'Stored in your OS keychain where one is available, never in config.json, never in a log.',
        }),
      el('div', { class: 'row-inline' }, [
        button('Save', {
          class: 'btn solid',
          onClick: async () => {
            const ok = await save();
            if (ok && onDone) onDone();
          },
        }),
        button('Test the connection', { class: 'btn quiet', onClick: test }),
        keyStored()
          ? button('Forget the stored key', {
            class: 'btn quiet',
            onClick: async () => {
              try {
                await api.deleteSecret(draft.keyRef);
                await saveConfig({});
                status.good('Key deleted.');
                drawForm();
              } catch (err) {
                status.bad(err.message);
              }
            },
          })
          : null,
      ]),
      status.node,
    );
  }

  function choose(next) {
    Object.assign(draft, next);
    drawForm();
    formWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  api.probeLocal().then((found) => {
    if (!found?.length) {
      localWrap.replaceChildren(el('p', { class: 'quiet-note', text: 'No local runtime answered on the usual ports (Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000). Start one and reopen this panel, or pick a hosted provider below.' }));
      return;
    }
    localWrap.replaceChildren(...found.map((rt) => el('div', { class: 'runtime' }, [
      el('div', { class: 'runtime-body' }, [
        el('span', { class: 'runtime-label', text: rt.label }),
        el('span', { class: 'mono runtime-url', text: rt.baseUrl }),
        el('span', { class: 'quiet-note', text: `${plural(rt.models?.length || 0, 'model')} loaded` }),
      ]),
      button('Use this', {
        class: 'btn solid',
        onClick: () => choose({
          protocol: 'openai',
          label: rt.label,
          baseUrl: rt.baseUrl,
          model: rt.models?.[0]?.id || '',
        }),
      }),
    ])));
  }).catch((err) => {
    localWrap.replaceChildren(el('p', { class: 'quiet-note', text: `Could not probe for local runtimes: ${err.message}` }));
  });

  api.presets().then((presets) => {
    presetWrap.replaceChildren(...(presets || []).filter((p) => !p.local).map((p) => el('button', {
      type: 'button',
      class: 'preset',
      onclick: () => choose({
        protocol: p.protocol,
        label: p.label,
        baseUrl: p.baseUrl,
        model: p.suggestedModels?.[0] || '',
      }),
    }, [
      el('span', { class: 'preset-label', text: p.label }),
      el('span', { class: 'preset-note', text: p.note || '' }),
    ])));
  }).catch(() => {
    presetWrap.replaceChildren(el('p', { class: 'quiet-note', text: 'Could not load the provider list.' }));
  });

  drawForm();

  return el('div', { class: 'panel panel-model' }, [
    !compact ? el('p', { class: 'panel-lede', text: 'Zelos talks to exactly one model endpoint, and you choose it. A runtime on this machine keeps everything local; a hosted key means your mail summaries go to that provider and nowhere else.' }) : null,
    section('On this machine', {}, localWrap),
    section('Hosted providers', {}, presetWrap),
    section('Endpoint', {}, formWrap),
  ]);
}

/* ---------------------------------------------------------------- mail */

function mailForm(account, { onSaved, onCancel }) {
  const draft = { ...account };
  const status = statusLine();

  const hostInput = input({ value: draft.host, placeholder: 'imap.example.com', list: 'zelos-imap-hosts' });
  const hostList = el('datalist', { id: 'zelos-imap-hosts' },
    IMAP_HINTS.map((h) => el('option', { value: h.host, label: h.label })));
  const noteLine = el('p', { class: 'field-hint', text: '' });
  const syncNote = () => {
    const hit = IMAP_HINTS.find((h) => h.host === hostInput.value.trim());
    noteLine.textContent = hit?.note || '';
  };
  hostInput.addEventListener('input', () => { draft.host = hostInput.value.trim(); syncNote(); });
  syncNote();

  const labelInput = input({ value: draft.label, placeholder: 'Work' });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const userInput = input({ value: draft.user, placeholder: 'you@example.com', autocomplete: 'off' });
  userInput.addEventListener('input', () => { draft.user = userInput.value.trim(); });

  const portInput = input({ type: 'number', value: String(draft.port), min: '1', max: '65535' });
  portInput.addEventListener('input', () => { draft.port = Number(portInput.value) || 993; });

  const passInput = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    placeholder: state.secretRefs.includes(draft.keyRef) ? 'a password is stored — type a new one to replace it' : 'app password',
  });

  const mailboxInput = input({ value: (draft.mailboxes || ['INBOX']).join(', ') });
  mailboxInput.addEventListener('input', () => {
    draft.mailboxes = mailboxInput.value.split(',').map((s) => s.trim()).filter(Boolean);
  });

  const lookbackInput = input({ type: 'number', value: String(draft.lookbackDays), min: '1', max: '365' });
  lookbackInput.addEventListener('input', () => { draft.lookbackDays = Number(lookbackInput.value) || 14; });

  const maxInput = input({ type: 'number', value: String(draft.maxMessages), min: '10', max: '5000' });
  maxInput.addEventListener('input', () => { draft.maxMessages = Number(maxInput.value) || 400; });

  let secure = draft.secure !== false;

  async function persistPassword() {
    if (!passInput.value) return;
    await api.setSecret(draft.keyRef, passInput.value);
    passInput.value = '';
  }

  return el('div', { class: 'account-form' }, [
    hostList,
    field('Name it', labelInput),
    field('IMAP host', hostInput),
    noteLine,
    el('div', { class: 'grid-2' }, [
      field('Port', portInput),
      checkbox('TLS on connect (port 993)', { checked: secure, onChange: (v) => { secure = v; } }),
    ]),
    field('Username', userInput),
    field('Password', passInput, {
      hint: 'Goes straight to your OS keychain. It is never written to config.json, never passed on a command line, and never logged.',
    }),
    el('div', { class: 'grid-2' }, [
      field('Mailboxes', mailboxInput, { hint: 'Comma separated.' }),
      field('Look back (days)', lookbackInput),
    ]),
    field('Most messages per sweep', maxInput),
    el('div', { class: 'row-inline' }, [
      button('Save account', {
        class: 'btn solid',
        onClick: async () => {
          if (!draft.host || !draft.user) {
            status.bad('A host and a username are both required.');
            return;
          }
          status.working('Saving…');
          try {
            await persistPassword();
            const others = (state.config.mail || []).filter((m) => m.id !== draft.id);
            await saveConfig({ mail: [...others, { ...draft, secure }] });
            status.good('Saved.');
            onSaved();
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
      button('Test the connection', {
        class: 'btn quiet',
        onClick: async () => {
          status.working(`Connecting to ${draft.host}…`);
          try {
            await persistPassword();
            const result = await api.testMail({
              host: draft.host,
              port: draft.port,
              secure,
              user: draft.user,
              keyRef: draft.keyRef,
            });
            if (result.ok) status.good(`Connected. ${plural((result.mailboxes || []).length, 'mailbox', 'mailboxes')} visible.`);
            else status.bad(result.error || 'The server refused the connection.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
      button('Cancel', { class: 'btn quiet', onClick: onCancel }),
    ]),
    status.node,
  ]);
}

export function mailPanel({ compact = false, onDone = null, rerender } = {}) {
  const accounts = state.config?.mail || [];
  const wrap = el('div', { class: 'panel panel-mail' });

  if (!compact) {
    wrap.appendChild(el('p', { class: 'panel-lede', text: 'Zelos reads mail over IMAP, directly from your server. Messages are stored in the database in your Zelos home and nowhere else. BODY.PEEK is used throughout, so reading your mail does not mark it read.' }));
  }

  const list = el('div', { class: 'stack' }, accounts.length
    ? accounts.map((account) => el('div', { class: 'account' }, [
      el('div', { class: 'account-head' }, [
        el('span', { class: 'account-label', text: account.label || account.user }),
        el('span', { class: 'mono account-host', text: `${account.host}:${account.port}` }),
        account.enabled === false ? el('span', { class: 'chip', text: 'off' }) : null,
      ]),
      el('p', { class: 'quiet-note', text: `${account.user} · ${(account.mailboxes || []).join(', ')} · last ${account.lookbackDays} days` }),
      el('div', { class: 'row-inline' }, [
        button(account.enabled === false ? 'Enable' : 'Disable', {
          class: 'btn quiet',
          onClick: async () => {
            const next = (state.config.mail || []).map((m) => (m.id === account.id ? { ...m, enabled: account.enabled === false } : m));
            await saveConfig({ mail: next });
            rerender?.();
          },
        }),
        button('Edit', {
          class: 'btn quiet',
          onClick: () => {
            editor.replaceChildren(mailForm(account, {
              onSaved: () => rerender?.(),
              onCancel: () => editor.replaceChildren(),
            }));
          },
        }),
        button('Remove', {
          class: 'btn quiet',
          onClick: async () => {
            const next = (state.config.mail || []).filter((m) => m.id !== account.id);
            await saveConfig({ mail: next });
            await api.deleteSecret(account.keyRef).catch(() => {});
            rerender?.();
          },
        }),
      ]),
    ]))
    : el('p', { class: 'quiet-note', text: 'No mailbox connected yet.' }));

  const editor = el('div', { class: 'editor' });

  const addButton = button('Add a mailbox', {
    class: 'btn solid',
    onClick: () => {
      const id = randomId('m');
      editor.replaceChildren(mailForm({
        id,
        enabled: true,
        label: '',
        host: '',
        port: 993,
        secure: true,
        user: '',
        keyRef: `mail.${id}`,
        mailboxes: ['INBOX'],
        sentMailbox: 'Sent',
        lookbackDays: 14,
        maxMessages: 400,
      }, {
        onSaved: () => { onDone?.(); rerender?.(); },
        onCancel: () => editor.replaceChildren(),
      }));
    },
  });

  wrap.appendChild(list);
  wrap.appendChild(el('div', { class: 'row-inline' }, addButton));
  wrap.appendChild(editor);
  return wrap;
}

/* ------------------------------------------------------------- calendars */

function calendarForm(calendar, { onSaved, onCancel }) {
  const draft = { ...calendar };
  const status = statusLine();

  const labelInput = input({ value: draft.label, placeholder: 'Personal' });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const kindSelect = select([
    { value: 'ics', label: 'Subscription URL (.ics / webcal)' },
    { value: 'caldav', label: 'CalDAV account' },
    { value: 'file', label: 'A file on this machine' },
  ], { value: draft.kind || 'ics' });
  kindSelect.addEventListener('change', () => { draft.kind = kindSelect.value; });

  const urlInput = input({ value: draft.url, placeholder: 'https://…  or  /Users/you/calendar.ics' });
  urlInput.addEventListener('input', () => { draft.url = urlInput.value.trim(); });

  const userInput = input({ value: draft.user || '', placeholder: 'only for CalDAV or a protected URL', autocomplete: 'off' });
  userInput.addEventListener('input', () => { draft.user = userInput.value.trim(); });

  const passInput = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'optional' });

  async function persistPassword() {
    if (!passInput.value) return;
    if (!draft.keyRef) draft.keyRef = `calendar.${draft.id}`;
    await api.setSecret(draft.keyRef, passInput.value);
    passInput.value = '';
  }

  return el('div', { class: 'account-form' }, [
    field('Name it', labelInput),
    field('Kind', kindSelect),
    field('Address', urlInput, { hint: 'webcal:// links work; Zelos rewrites them to https.' }),
    field('Username', userInput),
    field('Password', passInput),
    el('div', { class: 'row-inline' }, [
      button('Save calendar', {
        class: 'btn solid',
        onClick: async () => {
          if (!draft.url) {
            status.bad('An address is required.');
            return;
          }
          status.working('Saving…');
          try {
            await persistPassword();
            const others = (state.config.calendars || []).filter((c) => c.id !== draft.id);
            await saveConfig({ calendars: [...others, draft] });
            status.good('Saved.');
            onSaved();
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
      button('Test it', {
        class: 'btn quiet',
        onClick: async () => {
          status.working('Fetching…');
          try {
            await persistPassword();
            const result = await api.testCalendar({
              kind: draft.kind,
              url: draft.url,
              user: draft.user,
              keyRef: draft.keyRef,
            });
            if (result.ok) {
              const name = result.calendars?.[0]?.name || 'calendar';
              status.good(`${name}: ${plural(result.events ?? 0, 'event')} found.`);
            } else {
              status.bad(result.error || 'Nothing came back.');
            }
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
      button('Cancel', { class: 'btn quiet', onClick: onCancel }),
    ]),
    status.node,
  ]);
}

export function calendarPanel({ compact = false, onDone = null, rerender } = {}) {
  const calendars = state.config?.calendars || [];
  const wrap = el('div', { class: 'panel panel-calendars' });
  const editor = el('div', { class: 'editor' });

  if (!compact) {
    wrap.appendChild(el('p', { class: 'panel-lede', text: 'Times are kept exactly as your calendar publishes them — with their own UTC offset — so an event at 2pm in New York stays at 2pm whatever zone this machine thinks it is in.' }));
  }

  wrap.appendChild(el('div', { class: 'stack' }, calendars.length
    ? calendars.map((calendar) => el('div', { class: 'account' }, [
      el('div', { class: 'account-head' }, [
        el('span', { class: 'account-label', text: calendar.label || calendar.url }),
        el('span', { class: 'mono account-host', text: calendar.kind }),
      ]),
      el('p', { class: 'quiet-note', text: calendar.url }),
      el('div', { class: 'row-inline' }, [
        button('Edit', {
          class: 'btn quiet',
          onClick: () => editor.replaceChildren(calendarForm(calendar, {
            onSaved: () => rerender?.(),
            onCancel: () => editor.replaceChildren(),
          })),
        }),
        button('Remove', {
          class: 'btn quiet',
          onClick: async () => {
            await saveConfig({ calendars: (state.config.calendars || []).filter((c) => c.id !== calendar.id) });
            rerender?.();
          },
        }),
      ]),
    ]))
    : el('p', { class: 'quiet-note', text: 'No calendar connected yet.' })));

  wrap.appendChild(el('div', { class: 'row-inline' }, button('Add a calendar', {
    class: 'btn solid',
    onClick: () => {
      const id = randomId('c');
      editor.replaceChildren(calendarForm({
        id, enabled: true, label: '', kind: 'ics', url: '', user: '', keyRef: null,
      }, {
        onSaved: () => { onDone?.(); rerender?.(); },
        onCancel: () => editor.replaceChildren(),
      }));
    },
  })));
  wrap.appendChild(editor);
  return wrap;
}

/* ----------------------------------------------------------------- sweeps */

function sweepPanel() {
  const cfg = state.config?.sweep || { intervalMinutes: 30, activeHours: [6, 23], auto: true };
  const status = statusLine();

  const intervalInput = input({ type: 'number', value: String(cfg.intervalMinutes), min: '5', max: '1440' });
  const fromInput = input({ type: 'number', value: String(cfg.activeHours?.[0] ?? 6), min: '0', max: '23' });
  const toInput = input({ type: 'number', value: String(cfg.activeHours?.[1] ?? 23), min: '1', max: '24' });
  let auto = cfg.auto !== false;

  return el('div', { class: 'panel' }, [
    el('p', { class: 'panel-lede', text: 'A sweep fetches your sources and, when there is something new, asks your model to re-read the board. Between model calls it still re-derives staleness and ordering, which costs nothing.' }),
    checkbox('Sweep on a schedule', { checked: auto, onChange: (v) => { auto = v; } }),
    el('div', { class: 'grid-2' }, [
      field('Every (minutes)', intervalInput),
      field('Between these hours', el('div', { class: 'row-inline' }, [fromInput, el('span', { class: 'mono', text: 'and' }), toInput])),
    ]),
    el('div', { class: 'row-inline' }, [
      button('Save', {
        class: 'btn solid',
        onClick: async () => {
          status.working('Saving…');
          try {
            await saveConfig({
              sweep: {
                intervalMinutes: Number(intervalInput.value) || 30,
                activeHours: [Number(fromInput.value) || 0, Number(toInput.value) || 24],
                auto,
              },
            });
            status.good('Saved. The schedule picks it up on the next tick.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
    ]),
    status.node,
  ]);
}

/* ---------------------------------------------------------------- privacy */

function privacyPanel() {
  const cfg = state.config?.privacy || { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 };
  const status = statusLine();
  let sendBodies = cfg.sendBodies !== false;
  const charsInput = input({ type: 'number', value: String(cfg.bodyChars), min: '200', max: '20000' });
  const maxInput = input({ type: 'number', value: String(cfg.maxItemsPerSweep), min: '10', max: '1000' });

  return el('div', { class: 'panel' }, [
    el('p', { class: 'panel-lede', text: 'What leaves this machine is exactly one thing: the request Zelos makes to the model endpoint you configured. There is no telemetry, no analytics, no update check and no remote font.' }),
    checkbox('Send message bodies to the model', {
      checked: sendBodies,
      onChange: (v) => { sendBodies = v; },
      hint: 'Off means the model sees only headers and the first couple of lines. It will be worse at judging what matters, and it will say less about why. This setting genuinely changes what is sent — it is not a label.',
    }),
    el('div', { class: 'grid-2' }, [
      field('Characters of each body', charsInput),
      field('Most items per sweep', maxInput),
    ]),
    el('div', { class: 'row-inline' }, [
      button('Save', {
        class: 'btn solid',
        onClick: async () => {
          status.working('Saving…');
          try {
            await saveConfig({
              privacy: {
                sendBodies,
                bodyChars: Number(charsInput.value) || 4000,
                maxItemsPerSweep: Number(maxInput.value) || 150,
              },
            });
            status.good('Saved.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
    ]),
    status.node,
  ]);
}

/* ------------------------------------------------------------------- data */

function dataPanel() {
  const status = statusLine();
  const home = state.health?.home || '(unknown)';

  async function exportAll() {
    status.working('Gathering…');
    try {
      const [board, config] = await Promise.all([api.state(), api.config()]);
      const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        version: state.health?.version || null,
        config: config.config,
        board,
      }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `zelos-export-${Date.now()}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      status.good('Exported. It contains no secrets — those live in the keychain, not the database.');
    } catch (err) {
      status.bad(err.message);
    }
  }

  return el('div', { class: 'panel' }, [
    el('p', { class: 'panel-lede', text: 'Everything Zelos knows is in one directory. Back it up by copying it; delete it and Zelos forgets.' }),
    field('Zelos home', input({ value: home, readonly: true })),
    el('div', { class: 'row-inline' }, [
      button('Export a JSON snapshot', { class: 'btn solid', onClick: exportAll }),
      button('Copy the path', {
        class: 'btn quiet',
        onClick: async () => {
          const ok = await copyText(home);
          if (ok) status.good('Path copied.');
          else status.bad('Could not reach the clipboard.');
        },
      }),
    ]),
    section('Deleting everything', {
      note: 'Zelos deliberately has no route that wipes your data — a local server that can destroy the database on request is a local server a stray web page can point at. Do it yourself, with the app closed:',
    }, [
      el('pre', { class: 'code' }, el('code', { text: `rm -rf "${home}"` })),
      el('p', { class: 'quiet-note', text: 'Stored passwords and API keys live in your OS keychain under the service com.zelos.app and are not in that directory. Remove them with your keychain tool.' }),
    ]),
    status.node,
  ]);
}

/* ------------------------------------------------------------------ about */

function aboutPanel() {
  const backend = state.health?.backend || { name: 'unknown', writable: false, note: '' };
  return el('div', { class: 'panel panel-about' }, [
    el('dl', { class: 'facts' }, [
      el('dt', { text: 'Version' }), el('dd', { class: 'mono', text: state.health?.version || '—' }),
      el('dt', { text: 'Home' }), el('dd', { class: 'mono', text: state.health?.home || '—' }),
      el('dt', { text: 'Secret store' }), el('dd', { class: 'mono', text: backend.name }),
      el('dt', { text: 'Model' }),
      el('dd', {
        class: 'mono',
        // `label` carries a default, so it is not evidence that anything works.
        text: state.health?.model?.configured
          ? `${state.health.model.label} · ${state.config?.model?.baseUrl || ''}`
          : 'not configured',
      }),
    ]),
    backend.note ? section('What the secret store protects', {}, el('p', { class: 'panel-lede', text: backend.note })) : null,
    section('Where Zelos stands', {}, [
      el('ul', { class: 'plain-list' }, [
        el('li', { text: 'The server binds 127.0.0.1 and nothing else. Every API call carries a session token minted at launch; no CORS header is ever sent, so a page in another tab cannot read one.' }),
        el('li', { text: 'The only outbound connections are the ones you configured: your IMAP host, your calendar address, your model endpoint.' }),
        el('li', { text: 'Mail is attacker-controlled input, and so is anything the model writes after reading it. Zelos never executes, shells out to, or navigates to anything derived from either. It renders them, and you click.' }),
        el('li', { text: 'Drafts are drafts. Zelos has no send path at all — not a disabled button, no code.' }),
        el('li', { text: 'Prompt-injection defences here are mitigation, not proof. The guarantee is the one above: nothing acts on model output but you.' }),
      ]),
    ]),
    section('Start over', {}, [
      el('p', { class: 'quiet-note', text: 'Run the first-time setup again. Nothing is deleted; it just walks you back through the choices.' }),
      el('div', { class: 'row-inline' }, button('Run setup again', {
        class: 'btn quiet',
        onClick: () => {
          markOnboarded(false);
          window.location.hash = '#/welcome';
        },
      })),
    ]),
  ]);
}

/* --------------------------------------------------------- appearance */

/**
 * Zelos is black, always. The only appearance choice is the accent — one hex
 * that the stylesheet derives everything else from, including the light behind
 * the glass. A handful of presets for people who want to be done in one click,
 * plus a real colour input for people who have a hex in mind.
 */
const ACCENT_PRESETS = [
  { hex: '#5b8cff', name: 'Blue' },
  { hex: '#38bdf8', name: 'Ice' },
  { hex: '#34d399', name: 'Jade' },
  { hex: '#c084fc', name: 'Violet' },
  { hex: '#f472b6', name: 'Rose' },
  { hex: '#fb923c', name: 'Ember' },
  { hex: '#e2b714', name: 'Gold' },
  { hex: '#94a3b8', name: 'Steel' },
];

function appearancePanel() {
  const accent = currentAccent();

  const swatches = el('div', { class: 'accent-row', role: 'group', 'aria-label': 'Accent colour' },
    ACCENT_PRESETS.map((p) => {
      const chosen = p.hex === accent;
      const b = el('button', {
        type: 'button',
        class: `accent-swatch${chosen ? ' is-chosen' : ''}`,
        title: p.name,
        'aria-label': `${p.name} accent`,
        'aria-pressed': chosen ? 'true' : 'false',
        onclick: () => { setAccent(p.hex); rerenderAccent(); },
      });
      // A hex from our own closed list, set as a property rather than
      // interpolated into a style string.
      b.style.setProperty('--swatch', p.hex);
      return b;
    }));

  const custom = el('input', {
    type: 'color',
    class: 'accent-input',
    id: 'accent-custom',
    value: accent,
    oninput: (e) => { applyAccent(e.target.value); },      // live, every drag
    onchange: (e) => { setAccent(e.target.value); rerenderAccent(); }, // persist on release
  });

  function rerenderAccent() {
    for (const b of swatches.querySelectorAll('.accent-swatch')) {
      const on = b.title.toLowerCase() === (ACCENT_PRESETS.find((p) => p.hex === currentAccent())?.name || '').toLowerCase();
      b.classList.toggle('is-chosen', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    custom.value = currentAccent();
  }

  return el('div', { class: 'accent-choice' }, [
    el('p', { class: 'field-note', text:
      'Zelos is black. The accent is the one colour on screen — it marks the thing that needs you, and nothing else.' }),
    swatches,
    el('div', { class: 'accent-custom-row' }, [
      el('label', { class: 'field-label', for: 'accent-custom', text: 'Or pick your own' }),
      custom,
      el('button', {
        type: 'button',
        class: 'btn quiet',
        text: 'Reset to blue',
        onclick: () => { setAccent(DEFAULT_ACCENT); rerenderAccent(); },
      }),
    ]),
  ]);
}

/* ----------------------------------------------------------------- render */

export function renderSettings(ctx) {
  const panel = ctx.sub || 'model';
  const rerender = ctx.rerender;

  const tabs = el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Settings sections' },
    PANELS.map((p) => el('button', {
      type: 'button',
      class: 'subtab',
      role: 'tab',
      'aria-selected': p.id === panel ? 'true' : 'false',
      onclick: () => ctx.navigate(`#/settings/${p.id}`),
      text: p.label,
    })));

  let body;
  if (panel === 'mail') body = mailPanel({ rerender });
  else if (panel === 'calendars') body = calendarPanel({ rerender });
  else if (panel === 'sweep') body = sweepPanel();
  else if (panel === 'privacy') body = privacyPanel();
  else if (panel === 'ai') body = aiAccessPanel();
  else if (panel === 'data') body = dataPanel();
  else if (panel === 'about') body = aboutPanel();
  else body = modelPanel({});

  const errors = state.configErrors || [];

  return el('div', { class: 'view view-settings' }, [
    el('div', { class: 'settings-head' }, [
      el('h1', { class: 'view-title', text: 'Settings' }),
      appearancePanel(),
    ]),
    meander(),
    tabs,
    errors.length
      ? el('div', { class: 'banner banner-warn', role: 'status' }, [
        el('h3', { class: 'banner-title', text: 'Still incomplete' }),
        el('ul', { class: 'banner-list' }, errors.map((e) => el('li', { text: `${e.path}: ${e.message}` }))),
      ])
      : null,
    body,
  ]);
}
