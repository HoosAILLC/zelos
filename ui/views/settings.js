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
/* `request` rather than a named method on `api`: this panel is the only reader
   of /api/connectors, and a one-line wrapper in ui/lib/api.js would be a second
   place to look for a call that has exactly one call site. */
import { api, request } from '../lib/api.js';
import { state, saveConfig, setAccent, applyAccent, currentAccent, DEFAULT_ACCENT, markOnboarded } from '../lib/store.js';
import { plural } from '../lib/format.js';
import { aiAccessPanel } from './ai-access.js';

const PANELS = [
  { id: 'you', label: 'You' },
  { id: 'model', label: 'Model' },
  { id: 'mail', label: 'Mail' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'sources', label: 'Sources' },
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
export const IMAP_HINTS = [
  { host: 'imap.gmail.com', label: 'Gmail', note: 'Gmail needs an app password, not your account password.' },
  { host: 'imap.mail.me.com', label: 'iCloud', note: 'iCloud needs an app-specific password.' },
  /* This preset shipped with no note at all, which read as "nothing special
     here" — the one provider where that is furthest from true. Microsoft ended
     password sign-in for personal Outlook, Hotmail, Live and MSN accounts on
     16 September 2024, app passwords included, so the shipped path for one of
     the two largest consumer mail providers was an authentication failure in the
     middle of onboarding with nothing anywhere saying why. */
  {
    host: 'outlook.office365.com',
    label: 'Outlook / Microsoft 365',
    note: 'Microsoft stopped accepting passwords for personal Outlook, Hotmail, Live and MSN accounts on 16 September 2024, '
      + 'and app passwords went with them. Set “How Zelos signs in” to “Sign in with Microsoft” below. '
      + 'A work or school account may still take a password if your administrator has left IMAP switched on.',
  },
  { host: 'imap.mail.yahoo.com', label: 'Yahoo', note: 'Yahoo needs an app password.' },
  { host: 'imap.fastmail.com', label: 'Fastmail', note: 'Fastmail wants an app password too.' },
  { host: '127.0.0.1', label: 'Proton Bridge', note: 'Proton Bridge listens on 127.0.0.1:1143 without TLS.' },
];

/**
 * The password question, in words rather than in a boolean.
 *
 * core/config.mjs stores `requireTls` three ways on purpose: `null` means
 * "decide from the address" — required everywhere except a server on this
 * machine — while `true` and `false` are standing instructions that outlive the
 * address they were given for. A checkbox has two states and would have to
 * flatten "decide" into one of them, which is the sort of small lie that turns
 * into a password sent in the clear to a host nobody meant to excuse. So it is
 * three named choices, and the safe one is what an account gets by default.
 *
 * The labels say what the choice costs, not what protocol it selects. Nobody
 * configuring their mail should have to know what STARTTLS is to understand
 * that the third option lets a stranger on the café wifi read their password.
 */
/**
 * How a mail account signs in.
 *
 * Two, and the second exists because Microsoft removed the first for personal
 * Outlook, Hotmail, Live and MSN on 16 September 2024 — app passwords included.
 * The values are the ones core/config.mjs validates (`MAIL_AUTH_METHODS`) and
 * core/connectors/imap.mjs reads off the account; a third option would need all
 * three to agree, which is why they are not spelled out anywhere else in ui/.
 */
export const MAIL_AUTH_CHOICES = [
  { value: 'password', label: 'A password (everything except personal Microsoft mail)' },
  { value: 'xoauth2', label: 'Sign in with Microsoft' },
];

export const TLS_CHOICES = [
  { value: 'auto', label: 'Decide from the address (recommended)' },
  { value: 'require', label: 'Never send my password unencrypted' },
  { value: 'allow', label: 'Let this one server take it unencrypted' },
];

/** The stored value for a chosen option. Anything unrecognised is the safe one. */
export function requireTlsFor(choice) {
  if (choice === 'require') return true;
  if (choice === 'allow') return false;
  return null;
}

/** The option to show for a stored value. Only a real boolean moves it off "auto". */
export function tlsChoiceFor(requireTls) {
  if (requireTls === true) return 'require';
  if (requireTls === false) return 'allow';
  return 'auto';
}

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

/* --------------------------------------------------- the connector registry */

/**
 * Every connector this build has, as core/connectors/index.mjs describes it.
 *
 * This panel used to hold its own list of source kinds — three `<option>`s
 * spelled out in `calendarForm`, and nothing at all for `config.sources`. That
 * is the same defect the sweep had before the registry: a second list, in a file
 * that knows nothing about the sources it names, which nobody remembers to edit.
 * Everything below is drawn from the manifest instead, so a connector added to
 * core/connectors/ appears in the pickers, gets its own fields, and asks for its
 * own credential by name, with no edit to this file at all.
 *
 * Fetched once per page load and cached, because the answer is a property of the
 * build and cannot change while the tab is open. A failure clears the cache so
 * the next attempt is a real one rather than the same rejection replayed — a
 * server restarted while Settings was open would otherwise stay broken until the
 * page was reloaded.
 */
let connectorsPromise = null;

export function connectorManifests() {
  if (!connectorsPromise) {
    connectorsPromise = request('/api/connectors')
      .then((payload) => (Array.isArray(payload?.connectors) ? payload.connectors : []))
      .catch((err) => { connectorsPromise = null; throw err; });
  }
  return connectorsPromise;
}

/** The manifests stored under one config key, in the order the registry lists them. */
export const manifestsFor = (manifests, configKey) =>
  (Array.isArray(manifests) ? manifests : []).filter((m) => m && m.configKey === configKey);

/** One manifest by type, or null. */
export const manifestFor = (manifests, type) =>
  (Array.isArray(manifests) ? manifests : []).find((m) => m && m.type === type) || null;

/**
 * The picker for one config key: the registry's types, labelled with the
 * sentence each connector wrote for exactly this control.
 */
export const kindOptions = (manifests, configKey) =>
  manifestsFor(manifests, configKey).map((m) => ({ value: m.type, label: m.option }));

/**
 * A link, but only to somewhere a link can go.
 *
 * `credential.url` is where a user mints the token this source needs, and it
 * arrives as data over HTTP. It comes from a manifest in this build rather than
 * from a mail message, so this is not the difference between safe and unsafe —
 * but `javascript:` in an href is a script that runs on click, and a field this
 * file assigns without looking is exactly the shape of the hole ui/lib/dom.js
 * exists to close. http and https, or no link.
 */
function mintLink(href) {
  const raw = String(href ?? '').trim();
  if (!/^https?:[/][/]\S+$/i.test(raw)) return null;
  return el('a', { class: 'link', href: raw, target: '_blank', rel: 'noreferrer noopener', text: raw });
}

/**
 * The controls for one connector's `fields[]`, and the two questions a form asks
 * of them: what did the user type, and what did they leave blank that they
 * cannot.
 *
 * Six field types, because core/connectors/index.mjs's FIELD_TYPES is six and
 * says why: each one already had a control here. `int` reads back as a number
 * and everything else as a string, because that is what `settings` has to hold —
 * a connector reading `Number(settings.maxItems)` off the string "50" works
 * today and stops working the day somebody compares it to a number.
 *
 * A blank optional field is OMITTED rather than stored as '', so the connector's
 * own default applies. Storing the empty string would be a user choosing
 * "nothing" for a value they never touched.
 */
export function fieldControls(manifest, values = {}) {
  const stored = values && typeof values === 'object' ? values : {};
  const controls = [];

  for (const f of manifest?.fields ?? []) {
    const current = stored[f.name];
    const initial = current === undefined || current === null ? f.default : current;

    if (f.type === 'bool') {
      let checked = initial === true;
      controls.push({
        field: f,
        node: checkbox(f.label, { checked, onChange: (v) => { checked = v; }, hint: f.hint || null }),
        read: () => checked,
      });
      continue;
    }

    if (f.type === 'choice') {
      const options = (f.choices ?? []).map((c) => (c && typeof c === 'object'
        ? { value: String(c.value), label: String(c.label ?? c.value) }
        : { value: String(c), label: String(c) }));
      const node = select(options, { value: initial === undefined ? '' : String(initial) });
      controls.push({ field: f, node: field(f.label, node, { hint: f.hint || null }), read: () => node.value });
      continue;
    }

    const node = f.type === 'int'
      ? input({
        type: 'number',
        value: initial === undefined || initial === null ? '' : String(initial),
        ...(Number.isFinite(f.min) ? { min: String(f.min) } : {}),
        ...(Number.isFinite(f.max) ? { max: String(f.max) } : {}),
      })
      : input({
        value: initial === undefined || initial === null ? '' : String(initial),
        placeholder: f.placeholder || '',
        autocomplete: 'off',
        ...(f.type === 'url' ? { spellcheck: 'false' } : {}),
      });

    controls.push({
      field: f,
      node: field(f.label, node, { hint: f.hint || null }),
      read: () => {
        const raw = String(node.value ?? '').trim();
        if (!raw) return undefined;
        if (f.type !== 'int') return raw;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      },
    });
  }

  return {
    nodes: controls.map((c) => c.node),
    read() {
      const out = {};
      for (const c of controls) {
        const v = c.read();
        if (v !== undefined) out[c.field.name] = v;
      }
      return out;
    },
    missing() {
      return controls
        .filter((c) => c.field.required && String(c.read() ?? '').trim() === '')
        .map((c) => c.field);
    },
  };
}

/**
 * The one credential a source may have, asked for in the connector's own words.
 *
 * `credential: null` and `{required: false}` are different facts and the whole
 * difference is visible here: a connector with nothing to paste gets no field at
 * all, not a field marked optional. core/connectors/file.mjs is the case that
 * makes it matter — a calendar file on this machine has no password to be
 * missing, and offering a box for one is how a user comes to believe their .ics
 * failed because they left it empty.
 */
export function credentialControl(manifest, { keyRef = '', stored = false } = {}) {
  const credential = manifest?.credential;
  if (!credential) return null;

  const node = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: stored
      ? 'one is stored — type a new one to replace it'
      : `paste your ${credential.label.toLowerCase()}`,
  });
  const link = mintLink(credential.url);
  return {
    input: node,
    keyRef,
    node: el('div', null, [
      field(credential.label, node, {
        hint: [
          credential.help || '',
          credential.required ? '' : 'Only if this source needs one.',
          'It goes straight to your OS keychain: never into config.json, never into a log, and there is no route that reads it back.',
        ].filter(Boolean).join(' '),
      }),
      link ? el('p', { class: 'field-hint' }, ['Mint one at ', link]) : null,
    ]),
  };
}

/* ------------------------------------------------------------------- you */

/**
 * The best guess Zelos has for "you", taken from the first mailbox that is
 * switched on.
 *
 * `identity.email` had a schema, a validator, and readers in the scorer and in
 * the prompt — and nothing a user could reach ever set it. It stayed `''`, so
 * `sameEmail(a, '')` was false for every message and the two branches at
 * core/triage.mjs:434-435 (+6 for a message addressed To: you, −2 for one you
 * were merely Cc'd on) never fired once. Reproduced at the item cap: a message
 * written straight to the user was cut from the sweep prompt entirely while
 * newer Cc-only rollups survived.
 *
 * So there are two writers, not one. The panel below is the explicit one; the
 * mail form is the other, filling this in from the account being saved when
 * nothing is set, because an install that has been running for months should
 * not have to find a new tab to stop being wrong.
 *
 * Exported so it can be tested for what it is — a pure function over the
 * config — rather than grepped for.
 */
export function defaultIdentityEmail(config) {
  const accounts = Array.isArray(config?.mail) ? config.mail : [];
  const first = accounts.find((a) => a && a.enabled !== false
    && typeof a.user === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.user.trim()));
  return first ? first.user.trim() : '';
}

function youPanel() {
  const identity = state.config?.identity || {};
  const status = statusLine();
  const stored = String(identity.email || '').trim();
  const guess = defaultIdentityEmail(state.config);

  const nameInput = input({ value: identity.name || '', placeholder: 'Nemo Hale', autocomplete: 'off' });
  const emailInput = input({
    type: 'email',
    value: stored || guess,
    placeholder: 'you@example.com',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  // Read at read time and never persisted: core/config.mjs resolves an empty
  // timezone from this machine on every load, so a laptop that moves follows.
  // Writing it back here would freeze the zone it was in the day it was typed.
  const tzInput = input({ value: identity.timezone || '', readonly: true });

  return el('div', { class: 'panel panel-you' }, [
    el('p', { class: 'panel-lede', text: 'Two facts about you, used in two places and nowhere else. Neither leaves this machine except inside the request to the model endpoint you chose.' }),
    field('Your name', nameInput, {
      hint: 'Signs the drafts. Left blank, every prompt reads “name: (not set — do not invent one)” and drafts come back unsigned, with nothing on screen to say why.',
    }),
    field('Your email address', emailInput, {
      hint: !stored && guess
        ? `Zelos has not been told this yet, so the address of your first mailbox is filled in above. Press Save to use it. It is how a message written straight to you is ranked ahead of one you were only copied on — until it is set, that ranking does nothing at all.`
        : 'How a message written straight to you is ranked ahead of one you were only copied on, and how Zelos tells your own replies from everyone else’s.',
    }),
    field('Timezone', tzInput, {
      hint: 'Read from this machine every time Zelos starts, so it follows you rather than sticking where you were. Not editable here on purpose.',
    }),
    el('div', { class: 'row-inline' }, [
      button('Save', {
        class: 'btn solid',
        onClick: async () => {
          const email = emailInput.value.trim();
          // Refused here rather than as a 400 from PUT /api/config: the server's
          // rule is core/config.mjs:436 and this is the same rule, said where
          // the person typing can see which field it is about.
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            status.bad(`“${email}” is not an email address. Leave it blank if you would rather not say.`);
            return;
          }
          status.working('Saving…');
          try {
            await saveConfig({ identity: { name: nameInput.value.trim(), email } });
            status.good('Saved. The next sweep uses it.');
          } catch (err) {
            status.bad(err.message);
          }
        },
      }),
    ]),
    status.node,
  ]);
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

/**
 * The name this server gives its sent folder, from the SPECIAL-USE flag the
 * IMAP client already reads.
 *
 * `core/sweep.mjs`'s `mailboxesFor()` appends `account.sentMailbox` to every
 * fetch and the stored default is the bare word "Sent" — right for Fastmail and
 * a plain Dovecot, wrong for Gmail (`[Gmail]/Sent Mail`), Microsoft 365
 * (`Sent Items`) and iCloud (`Sent Messages`), which are three of the eight
 * providers this app hardcodes and the three largest. Until this field existed
 * the value had no writer anywhere in `ui/`, so those accounts reported
 * `Mailbox doesn't exist: Sent` on every sweep, forever, while the run itself
 * stayed `ok: true` and the board simply never learned what the user had
 * already answered.
 *
 * `listMailboxes()` has computed `specialUse: 'sent'` from the server's own
 * `\Sent` flag since the client was written (core/sources/imap.mjs:1176), and
 * `testConnection` has returned it, and nothing outside a test had ever read
 * it. This is that reader: press "Test the connection" and the right name
 * arrives without anyone having to know their provider's spelling.
 *
 * What is typed wins over the flag — but only if the server actually has it.
 * A name that is not on the server is not a preference, it is a typo, and
 * silently keeping it is how this defect looked like nothing at all.
 */
export function sentMailboxFromTest(mailboxes, current = '') {
  const list = Array.isArray(mailboxes) ? mailboxes : [];
  const names = new Set(list.map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean));
  const flagged = list.find((m) => m && typeof m === 'object' && m.specialUse === 'sent')?.name || '';
  const chosen = String(current ?? '').trim();
  if (chosen && names.has(chosen)) return chosen;
  return flagged || chosen;
}

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

  const sentInput = input({ value: draft.sentMailbox ?? 'Sent', placeholder: 'Sent' });
  sentInput.addEventListener('input', () => { draft.sentMailbox = sentInput.value.trim(); });

  const lookbackInput = input({ type: 'number', value: String(draft.lookbackDays), min: '1', max: '365' });
  lookbackInput.addEventListener('input', () => { draft.lookbackDays = Number(lookbackInput.value) || 14; });

  const maxInput = input({ type: 'number', value: String(draft.maxMessages), min: '10', max: '5000' });
  maxInput.addEventListener('input', () => { draft.maxMessages = Number(maxInput.value) || 400; });

  let secure = draft.secure !== false;

  const tlsSelect = select(TLS_CHOICES, { value: tlsChoiceFor(draft.requireTls) });
  // Read off the control at the moment it is needed rather than mirrored into a
  // variable on change: saving and testing must never be able to disagree about
  // what is on screen, and this is the one setting where disagreeing means the
  // password goes out under rules the user was never shown.
  const requireTls = () => requireTlsFor(tlsSelect.value);

  async function persistPassword() {
    if (!passInput.value) return;
    await api.setSecret(draft.keyRef, passInput.value);
    passInput.value = '';
  }

  /* ---------------------------------------------------------------- *
   * "Sign in with Microsoft"
   * ---------------------------------------------------------------- *
   * Microsoft stopped accepting passwords for personal Outlook, Hotmail, Live
   * and MSN on 16 September 2024, and app passwords went with them — so the
   * preset in IMAP_HINTS above was, until this existed, an instruction to do
   * something impossible, offered during onboarding.
   *
   * The client ID and tenant are the USER'S. Zelos ships neither, and cannot:
   * an application id belonging to Zelos would need Microsoft publisher
   * verification, which is a vendor approving a published app — the same wall
   * that keeps Gmail out (docs/OAUTH.md). What a person registers in their own
   * Entra tenant needs no approval from anybody, which is the whole reason this
   * flow is reachable at all.
   *
   * No timing lives here. The server runs the RFC 8628 poll loop with its
   * back-off; this asks "has anything changed" on a fixed two seconds, which is
   * a UI refresh rate and not a protocol constant. If those two ever have to
   * agree, the wrong one is this one.
   */
  const authSelect = select(MAIL_AUTH_CHOICES, { value: draft.auth === 'xoauth2' ? 'xoauth2' : 'password' });
  const authMethod = () => (authSelect.value === 'xoauth2' ? 'xoauth2' : 'password');

  const clientIdInput = input({ value: draft.oauth?.clientId || '', placeholder: '00000000-0000-0000-0000-000000000000', autocomplete: 'off' });
  const tenantInput = input({ value: draft.oauth?.tenantId || 'common', placeholder: 'common', autocomplete: 'off' });

  const signInStatus = statusLine();
  const codeBox = el('div', { class: 'device-code' });
  let poll = null;
  let flowId = null;

  const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

  /* The panel is rebuilt whenever the account form is, and an interval that
     outlives its node keeps calling a server about a sign-in nobody is watching
     — and keeps a finished flow's verdict from ever being read. */
  const landed = (flow) => {
    stopPolling();
    flowId = null;
    codeBox.replaceChildren();
    if (flow.state === 'connected') {
      signInStatus.good('Signed in. The token is in your keychain; Zelos will refresh it on its own.');
      draft.auth = 'xoauth2';
    } else if (flow.state === 'cancelled') {
      signInStatus.bad('Sign-in cancelled.');
    } else {
      signInStatus.bad(flow.error || flow.message || 'Microsoft refused the sign-in.');
    }
  };

  const showCode = (flow) => {
    codeBox.replaceChildren(
      el('p', { class: 'quiet-note', text: 'Open the address below and type this code. Leave this panel open.' }),
      el('p', { class: 'device-code-value', text: flow.userCode || '' }),
      el('a', {
        href: /^https:\/\//.test(flow.verificationUri || '') ? flow.verificationUri : '#',
        target: '_blank',
        rel: 'noopener noreferrer',
        text: flow.verificationUri || '',
      }),
      button('Give up', {
        class: 'btn quiet',
        onClick: async () => {
          const id = flowId;
          stopPolling();
          flowId = null;
          codeBox.replaceChildren();
          signInStatus.working('Sign-in cancelled.');
          if (id) await api.cancelMailOAuth(id).catch(() => {});
        },
      }),
    );
  };

  async function startMicrosoftSignIn() {
    if (!draft.user) { signInStatus.bad('Fill in the username first — it is the mailbox being signed in to.'); return; }
    if (!clientIdInput.value.trim()) { signInStatus.bad('The application (client) ID from your Entra app registration is required.'); return; }
    draft.oauth = { clientId: clientIdInput.value.trim(), tenantId: tenantInput.value.trim() || 'common' };
    stopPolling();
    signInStatus.working('Asking Microsoft for a code…');
    try {
      const flow = await api.beginMailOAuth({
        keyRef: draft.keyRef,
        clientId: draft.oauth.clientId,
        tenantId: draft.oauth.tenantId,
      });
      flowId = flow.id;
      if (flow.state !== 'pending') { landed(flow); return; }
      signInStatus.working('Waiting for you to finish in the browser…');
      showCode(flow);
      poll = setInterval(async () => {
        try {
          const now = await api.mailOAuthStatus(flowId);
          if (now.state === 'pending') { showCode(now); return; }
          landed(now);
        } catch (err) {
          // A 404 means the server restarted or the flow expired; either way
          // there is nothing left to wait for, and silently spinning forever is
          // the one outcome worse than saying so.
          stopPolling();
          codeBox.replaceChildren();
          signInStatus.bad(err.message || 'The sign-in is no longer waiting.');
        }
      }, 2000);
    } catch (err) {
      signInStatus.bad(err.message || 'Could not start the sign-in.');
    }
  }

  const microsoftBlock = el('div', { class: 'stack' }, [
    field('Application (client) ID', clientIdInput, {
      hint: 'From your own app registration in Microsoft Entra — Zelos ships no client ID, because one belonging to Zelos would need Microsoft to verify a published app, and this whole flow exists to avoid asking a vendor for permission. Register an app, switch on “Allow public client flows”, and paste its Application (client) ID here.',
    }),
    field('Directory (tenant) ID', tenantInput, {
      hint: 'Leave it as “common” for a personal Outlook, Hotmail, Live or MSN account. A work or school mailbox needs the tenant its administrator gives you.',
    }),
    el('div', { class: 'row-inline' }, [
      button('Sign in with Microsoft', { class: 'btn solid', onClick: startMicrosoftSignIn }),
    ]),
    signInStatus.node,
    codeBox,
  ]);

  const passwordBlock = el('div', { class: 'stack' }, [
    field('Password', passInput, {
      hint: 'Goes straight to your OS keychain. It is never written to config.json, never passed on a command line, and never logged.',
    }),
  ]);

  const credentialSlot = el('div', {});
  const paintCredential = () => {
    const xo = authMethod() === 'xoauth2';
    credentialSlot.replaceChildren(xo ? microsoftBlock : passwordBlock);
    tlsSelect.closest('.field')?.toggleAttribute('hidden', xo);
    if (!xo) { stopPolling(); codeBox.replaceChildren(); }
  };
  authSelect.addEventListener('change', () => {
    draft.auth = authMethod();
    paintCredential();
  });

  return el('div', { class: 'account-form' }, [
    hostList,
    field('Name it', labelInput),
    field('IMAP host', hostInput),
    noteLine,
    el('div', { class: 'grid-2' }, [
      field('Port', portInput),
      checkbox('TLS on connect (port 993)', { checked: secure, onChange: (v) => { secure = v; } }),
    ]),
    field('Sending your password', tlsSelect, {
      hint: 'Zelos will not send your password until the connection is encrypted. Left to decide, it insists on that everywhere except a server running on this machine — which is where Proton Bridge and its kind live, and the only reason an unencrypted connection is still offered at all. Allow one anywhere else and anyone sharing your network, or sitting anywhere between you and your mail server, can read the password and the mail.',
    }),
    field('Username', userInput),
    field('How Zelos signs in', authSelect, {
      hint: 'Microsoft stopped accepting passwords for personal Outlook, Hotmail, Live and MSN mail on 16 September 2024, and app passwords stopped working with them. Everything else on this list still takes a password — Gmail and Yahoo want an app password rather than your account one.',
    }),
    credentialSlot,
    el('div', { class: 'grid-2' }, [
      field('Mailboxes', mailboxInput, { hint: 'Comma separated.' }),
      field('Look back (days)', lookbackInput),
    ]),
    field('Sent folder', sentInput, {
      hint: 'Read as well as the mailboxes above, because “you promised” is mined from what you wrote — without it that half of the board cannot exist. Gmail calls it “[Gmail]/Sent Mail”, Microsoft 365 “Sent Items”, iCloud “Sent Messages”. Press “Test the connection” and Zelos fills in whatever this server flags as its own. Leave it blank to read nothing outbound.',
    }),
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
            const patch = {
              mail: [...others, { ...draft, secure, requireTls: requireTls(), sentMailbox: sentInput.value.trim() }],
            };
            // The second writer for identity.email — see defaultIdentityEmail
            // above. An install that predates the You panel has `''` there, and
            // `sameEmail(a, '')` is false for every message, so the scorer's
            // To:/Cc: branches are dead and the sweep does not know which
            // replies are the user's own. This is the moment the address is
            // both known and confirmed by hand, so it is the moment to adopt
            // it — announced rather than silent, and only when nothing is set.
            const known = String(state.config?.identity?.email ?? '').trim();
            const adopted = !known && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.user) ? draft.user : '';
            if (adopted) patch.identity = { email: adopted };
            await saveConfig(patch);
            status.good(adopted
              ? `Saved. Zelos will also treat ${adopted} as your own address — change it under Settings → You.`
              : 'Saved.');
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
            // `requireTls` goes with it, or this is not a test of this account.
            // Without it the button connected under looser rules than the sweep
            // will, so the one moment a user is told "this works" was the moment
            // least like the 07:00 run — and the only one they are awake for.
            const result = await api.testMail({
              host: draft.host,
              port: draft.port,
              secure,
              user: draft.user,
              keyRef: draft.keyRef,
              requireTls: requireTls(),
            });
            if (result.ok) {
              const seen = `Connected. ${plural((result.mailboxes || []).length, 'mailbox', 'mailboxes')} visible.`;
              // The reader for the SPECIAL-USE flag: it has been on the wire and
              // in this response object all along with nowhere to land.
              const suggested = sentMailboxFromTest(result.mailboxes, sentInput.value);
              if (suggested && suggested !== sentInput.value.trim()) {
                sentInput.value = suggested;
                draft.sentMailbox = suggested;
                status.good(`${seen} This server calls its sent folder “${suggested}” — filled in below. Save the account to keep it.`);
              } else {
                status.good(seen);
              }
            } else status.bad(result.error || 'The server refused the connection.');
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
        // Null, not false: a new account has not excused anything yet, and the
        // blank this form opens on has to be the same blank core/config.mjs
        // would have written.
        requireTls: null,
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

/**
 * The calendar editor.
 *
 * The kind picker is the registry's `calendars` connectors and their own
 * `option` sentences — it used to be three `<option>` elements written out here,
 * which is why a fourth calendar kind would have been invisible to the only
 * screen that can create one.
 *
 * `fields[]` plays no part: a calendar's address, username and keyRef are the
 * ENVELOPE core/config.mjs stores for every calendar, not per-connector
 * settings, and all three calendar connectors declare `fields: []` for the same
 * reason core/connectors/imap.mjs does. What the manifest does drive is the
 * credential — whether there is one at all, what it is called, and what to say
 * about it — and that is the part that was wrong before: `file` has
 * `credential: null`, and this form asked for a username and password to read a
 * path on the user's own disk.
 */
export function calendarForm(calendar, { manifests = [], onSaved, onCancel }) {
  const draft = { ...calendar };
  const status = statusLine();
  const options = kindOptions(manifests, 'calendars');

  const labelInput = input({ value: draft.label, placeholder: 'Personal' });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const kindSelect = select(options, { value: draft.kind || options[0]?.value || '' });

  const urlInput = input({ value: draft.url, placeholder: 'https://…  or  /Users/you/calendar.ics' });
  urlInput.addEventListener('input', () => { draft.url = urlInput.value.trim(); });

  const userInput = input({ value: draft.user || '', placeholder: 'only for a protected address', autocomplete: 'off' });
  userInput.addEventListener('input', () => { draft.user = userInput.value.trim(); });

  /* The sign-in half of the form, redrawn whenever the kind changes. Both
     controls live or die together: a username with no password to go with it
     authenticates nothing, so a connector that declares no credential gets
     neither, and says so instead. */
  const signIn = el('div', null);
  let credential = null;
  function drawCredential() {
    const manifest = manifestFor(manifests, kindSelect.value);
    credential = credentialControl(manifest, {
      keyRef: draft.keyRef || `calendar.${draft.id}`,
      stored: state.secretRefs.includes(draft.keyRef),
    });
    signIn.replaceChildren(...(credential
      ? [field('Username', userInput), credential.node]
      : [el('p', { class: 'quiet-note', text: `${manifest?.option || 'This kind of calendar'} needs no username and no password.` })]));
  }
  kindSelect.addEventListener('change', drawCredential);
  drawCredential();

  /* The kind is read off the control where it is needed rather than mirrored
     into `draft` on change — the same rule the TLS selector states above, and
     for a version of the same reason. A mirror starts out of step: a calendar
     saved with no kind at all shows the first option and would have been stored
     as `kind: ''` unless the user happened to touch the picker, which
     `validateConfig` then refuses with a message about a control they never
     saw. */
  const kindNow = () => kindSelect.value;

  async function persistPassword() {
    if (!credential?.input.value) return;
    if (!draft.keyRef) draft.keyRef = `calendar.${draft.id}`;
    await api.setSecret(draft.keyRef, credential.input.value);
    credential.input.value = '';
  }

  return el('div', { class: 'account-form' }, [
    field('Name it', labelInput),
    field('Kind', kindSelect),
    field('Address', urlInput, { hint: 'webcal:// links work; Zelos rewrites them to https.' }),
    signIn,
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
            await saveConfig({ calendars: [...others, { ...draft, kind: kindNow() }] });
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
            // The kind goes with it, from the same control the save reads, or
            // this is a test of a different calendar from the one about to be
            // stored — the mail form makes the same point about requireTls.
            const result = await api.testCalendar({
              kind: kindNow(),
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

/**
 * Open an editor once the registry has answered.
 *
 * Every form below is a pure function of the manifests, which arrive over HTTP —
 * so the fetch happens on the click that needs it rather than during a render.
 * A render that awaited would either block the panel or paint a picker with
 * nothing in it, and a picker with nothing in it is how a user concludes their
 * build supports no calendars.
 */
async function openEditor(editor, status, build) {
  status.working('Reading what this build can connect to…');
  try {
    const manifests = await connectorManifests();
    status.clear();
    editor.replaceChildren(build(manifests));
  } catch (err) {
    status.bad(`Zelos could not say what kinds of source it has: ${err.message}`);
  }
}

export function calendarPanel({ compact = false, onDone = null, rerender } = {}) {
  const calendars = state.config?.calendars || [];
  const wrap = el('div', { class: 'panel panel-calendars' });
  const editor = el('div', { class: 'editor' });
  const status = statusLine();

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
          onClick: () => openEditor(editor, status, (manifests) => calendarForm(calendar, {
            manifests,
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
      /* The blank a new calendar opens on comes from the registry, not from the
         string 'ics': the first `calendars` connector is what the picker will be
         showing, and a literal here is a default that can disagree with the
         control under it. */
      openEditor(editor, status, (manifests) => calendarForm({
        id,
        enabled: true,
        label: '',
        kind: kindOptions(manifests, 'calendars')[0]?.value || '',
        url: '',
        user: '',
        keyRef: null,
      }, {
        manifests,
        onSaved: () => { onDone?.(); rerender?.(); },
        onCancel: () => editor.replaceChildren(),
      }));
    },
  })));
  wrap.appendChild(editor);
  wrap.appendChild(status.node);
  return wrap;
}

/* ------------------------------------------------------------------ sources */

/**
 * The editor for `config.sources` — the third place config keeps a source, and
 * until now the one with no screen at all.
 *
 * There is nothing about any particular connector in this function, and that is
 * the whole point of it: the picker is the registry's `sources` connectors, the
 * body is whatever `fields[]` that connector declared, and the credential is the
 * one it asked for in the words it asked for it. A feed, a ticket queue and a
 * repository each get a form nobody wrote.
 *
 * Changing the kind rebuilds the body and DROPS the settings, which is right
 * rather than merely easy: `settings` is keyed by field name, and two connectors
 * that both happen to declare `url` mean entirely different addresses by it.
 * Carrying values across would hand a new connector a URL for somebody else's
 * service and call it configured.
 */
export function sourceForm(source, { manifests = [], onSaved, onCancel }) {
  const draft = { ...source };
  const status = statusLine();
  const options = kindOptions(manifests, 'sources');

  const typeSelect = select(options, { value: draft.type || options[0]?.value || '' });
  const labelInput = input({ value: draft.label || '', placeholder: 'Alder notices' });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const body = el('div', { class: 'stack' });
  let controls = fieldControls(null);
  let credential = null;

  function drawBody() {
    const manifest = manifestFor(manifests, typeSelect.value);
    // The stored settings belong to the stored type. See the docstring.
    const values = manifest && manifest.type === source.type ? source.settings : {};
    controls = fieldControls(manifest, values);
    credential = credentialControl(manifest, {
      keyRef: draft.keyRef || `${typeSelect.value}.${draft.id}`,
      stored: state.secretRefs.includes(draft.keyRef),
    });
    body.replaceChildren(
      ...controls.nodes,
      credential ? credential.node : el('p', { class: 'quiet-note', text: 'This source needs no credential.' }),
    );
  }
  typeSelect.addEventListener('change', drawBody);
  drawBody();

  return el('div', { class: 'account-form' }, [
    field('What is it', typeSelect),
    field('Name it', labelInput, { hint: 'What the board calls anything that arrives from here.' }),
    body,
    el('div', { class: 'row-inline' }, [
      button('Save source', {
        class: 'btn solid',
        onClick: async () => {
          const type = typeSelect.value;
          if (!type) {
            status.bad('Pick what kind of source this is.');
            return;
          }
          const missing = controls.missing();
          if (missing.length) {
            const names = missing.map((f) => `“${f.label}”`).join(', ');
            status.bad(`${names} ${missing.length === 1 ? 'is' : 'are'} required.`);
            return;
          }
          status.working('Saving…');
          try {
            /* The keyRef is minted only when there is something to put behind
               it. core/config.mjs mints `${type}.${id}` on load for a source
               that has a type, and this is the same string — a keyRef written
               under one name and read under another is a password that is
               there and cannot be found. */
            if (credential?.input.value) {
              if (!draft.keyRef) draft.keyRef = `${type}.${draft.id}`;
              await api.setSecret(draft.keyRef, credential.input.value);
              credential.input.value = '';
            }
            const others = (state.config.sources || []).filter((s) => s.id !== draft.id);
            await saveConfig({
              sources: [...others, {
                ...draft,
                type,
                label: labelInput.value.trim(),
                settings: controls.read(),
              }],
            });
            status.good('Saved. The next sweep reads it.');
            onSaved();
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

export function sourcesPanel({ rerender } = {}) {
  const sources = state.config?.sources || [];
  const wrap = el('div', { class: 'panel panel-sources' });
  const editor = el('div', { class: 'editor' });
  const status = statusLine();

  wrap.appendChild(el('p', { class: 'panel-lede', text: 'Everything that is neither mail nor a calendar. Zelos only ever reads: a source here is fetched on the sweep, stored in your Zelos home, and nothing is ever written back to it.' }));

  wrap.appendChild(el('div', { class: 'stack' }, sources.length
    ? sources.map((src) => el('div', { class: 'account' }, [
      el('div', { class: 'account-head' }, [
        el('span', { class: 'account-label', text: src.label || src.id }),
        el('span', { class: 'mono account-host', text: src.type }),
        src.enabled === false ? el('span', { class: 'chip', text: 'off' }) : null,
      ]),
      el('div', { class: 'row-inline' }, [
        button(src.enabled === false ? 'Enable' : 'Disable', {
          class: 'btn quiet',
          onClick: async () => {
            const next = (state.config.sources || []).map((s) => (s.id === src.id ? { ...s, enabled: src.enabled === false } : s));
            await saveConfig({ sources: next });
            rerender?.();
          },
        }),
        button('Edit', {
          class: 'btn quiet',
          onClick: () => openEditor(editor, status, (manifests) => sourceForm(src, {
            manifests,
            onSaved: () => rerender?.(),
            onCancel: () => editor.replaceChildren(),
          })),
        }),
        button('Remove', {
          class: 'btn quiet',
          onClick: async () => {
            await saveConfig({ sources: (state.config.sources || []).filter((s) => s.id !== src.id) });
            if (src.keyRef) await api.deleteSecret(src.keyRef).catch(() => {});
            rerender?.();
          },
        }),
      ]),
    ]))
    : el('p', { class: 'quiet-note', text: 'Nothing else connected yet.' })));

  wrap.appendChild(el('div', { class: 'row-inline' }, button('Add a source', {
    class: 'btn solid',
    onClick: () => {
      const id = randomId('s');
      openEditor(editor, status, (manifests) => sourceForm({
        id,
        enabled: true,
        label: '',
        type: kindOptions(manifests, 'sources')[0]?.value || '',
        keyRef: null,
        settings: {},
      }, {
        manifests,
        onSaved: () => rerender?.(),
        onCancel: () => editor.replaceChildren(),
      }));
    },
  })));
  wrap.appendChild(editor);
  wrap.appendChild(status.node);
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

/**
 * A tab that announces "tab, selected" while pointing at nothing is worse than
 * a plain button, and that is what this strip was: `role="tablist"`,
 * `role="tab"` and `aria-selected` were all set, while the panel had no
 * `role="tabpanel"`, no `aria-labelledby`, and the tabs had no `id` and no
 * `aria-controls`. A screen-reader user was told there were eight tabs and
 * given no way to find out what any of them controlled.
 *
 * Finished here rather than dropped, because ui/app.js's `refocusSelectedTab()`
 * now finds the pressed tab again after the sub-route rebuild by selecting on
 * `[role="tab"][aria-selected="true"]` — the roles are load-bearing.
 *
 * Two things the plain APG pattern has to be adapted for:
 *
 *  - Only ONE panel is ever in the document; changing tabs re-renders the view.
 *    So `aria-controls` is set on the selected tab only. Pointing the other
 *    seven at ids that do not exist is a dangling reference, which several
 *    screen readers report as an empty relationship rather than as no
 *    relationship — worse than the omission it would be fixing.
 *  - The ids are fixed strings, not `nextId()` counters. They have to survive
 *    every rebuild, and a counter that ticks on each render would leave
 *    `aria-labelledby` pointing at the id the tab had one paint ago.
 */
const tabId = (id) => `settings-tab-${id}`;
const panelId = (id) => `settings-panel-${id}`;

export function renderSettings(ctx) {
  const panel = ctx.sub || 'model';
  const rerender = ctx.rerender;

  // Arrow keys move between tabs, the way a tablist is expected to. Activation
  // follows selection because a panel here costs one render, and the roving
  // tabindex below means this only ever fires on the selected tab.
  const onTabKey = (event) => {
    const here = PANELS.findIndex((p) => p.id === panel);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (here + 1) % PANELS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (here - 1 + PANELS.length) % PANELS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = PANELS.length - 1;
    if (next < 0 || here < 0) return;
    event.preventDefault();
    ctx.navigate(`#/settings/${PANELS[next].id}`);
  };

  const tabs = el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Settings sections' },
    PANELS.map((p) => {
      const selected = p.id === panel;
      return el('button', {
        type: 'button',
        class: 'subtab',
        id: tabId(p.id),
        role: 'tab',
        'aria-selected': selected ? 'true' : 'false',
        // Only the live panel exists to be controlled; see above.
        'aria-controls': selected ? panelId(p.id) : null,
        // Roving tabindex: one stop for the whole strip, arrows inside it.
        tabindex: selected ? '0' : '-1',
        onclick: () => ctx.navigate(`#/settings/${p.id}`),
        onkeydown: onTabKey,
        text: p.label,
      });
    }));

  let body;
  if (panel === 'you') body = youPanel();
  else if (panel === 'mail') body = mailPanel({ rerender });
  else if (panel === 'calendars') body = calendarPanel({ rerender });
  else if (panel === 'sources') body = sourcesPanel({ rerender });
  else if (panel === 'sweep') body = sweepPanel();
  else if (panel === 'privacy') body = privacyPanel();
  else if (panel === 'ai') body = aiAccessPanel();
  else if (panel === 'data') body = dataPanel();
  else if (panel === 'about') body = aboutPanel();
  else body = modelPanel({});

  // The other half of the relationship the tabs now name. `tabindex="-1"` is
  // not for keyboard order — every panel here has focusable content of its own —
  // it is so the panel can be given focus programmatically without becoming one
  // more tab stop after the strip.
  body.setAttribute('id', panelId(panel));
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', tabId(panel));
  body.setAttribute('tabindex', '-1');

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
