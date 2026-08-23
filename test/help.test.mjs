/**
 * test/help.test.mjs — "Ask Claude to walk me through this."
 *
 * core/help.mjs writes the message the app hands to Claude or ChatGPT for
 * one setup screen. It is pure, so this suite can read EVERY message it can
 * write — every step, every provider, every platform, both client states —
 * and hold each one to the same rules:
 *
 *  1. Privacy. No email address, no key, no password, no path under the
 *     person's home, no config file name. The message may name the step,
 *     the provider's NAME, the platform, and Zelos's own pages. This is the
 *     load-bearing test: the link opens in a browser, the message is in the
 *     URL, and a URL is kept by history, sent as a Referer, and shown on a
 *     shared screen. The inputs are hostile here on purpose — an address as
 *     the provider, a key as the sign-in — and the message has to come out
 *     clean anyway.
 *  2. Fit. Under 3500 characters, so the address bar never cuts it off.
 *  3. Fidelity. The controls the message tells the person to press are the
 *     controls ui/views/onboarding.js and settings.js draw, read out of those
 *     files; the provider pages are the ones the app itself links, read off
 *     core/sources/imap.mjs and core/llm.mjs rather than retyped.
 *  4. Manner. The rules for Claude, word for word, on every message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* core/help.mjs imports the mail provider table, which imports the secret
   store. Nothing here reads a secret, but the store detects its backend at
   first use and on a Mac that detection would be the login keychain. Pinned
   to the file backend in a temp home, like every suite that can reach it. */
process.env.ZELOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-help-home-'));
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const help = await import('../core/help.mjs');
const { describeProvider } = await import('../core/sources/imap.mjs');
const { PRESETS } = await import('../core/llm.mjs');

const {
  helpPrompt, helpLinks, platformName, providerName, aiName, calendarName,
  HELP_STEPS, HELP_PLATFORMS, HELP_PROVIDERS, HELP_AIS, HELP_CALENDARS, HELP_RULES, HELP_MAX_CHARS,
} = help;

/** What GET /api/guides answers, with reserved hosts — the shape core/server.mjs serves. */
const GUIDES = {
  microsoftSetup: 'https://docs.example/oauth#microsoft',
  calendars: {
    google: { settings: 'https://calendar.example/settings' },
    icloud: { caldav: 'https://caldav.example/', appPasswords: 'https://appleid.example/manage' },
    outlook: { calendar: 'https://outlook.example/calendar/' },
  },
};

/** The providers each step can be asked about, including "none yet". */
function providersFor(step) {
  if (step === 'email') return [null, ...HELP_PROVIDERS];
  if (step === 'ai') return [null, ...HELP_AIS];
  if (step === 'calendar') return [null, ...HELP_CALENDARS];
  return [null];
}

/** Every message the module can write, with the arguments that wrote it. */
function everyMessage(extra = {}) {
  const out = [];
  for (const step of HELP_STEPS) {
    for (const platform of HELP_PLATFORMS) {
      for (const provider of providersFor(step)) {
        for (const clientReady of [false, true]) {
          const args = { step, provider, platform, clientReady, guides: GUIDES, ...extra };
          out.push({ args, ...helpPrompt(args) });
        }
      }
    }
  }
  return out;
}

const label = ({ step, provider, platform, clientReady }) => `${step}/${provider ?? '-'}/${platform}/${clientReady ? 'client' : 'no-client'}`;

/* ------------------------------------------------------------- coverage */

test('every step × provider × platform produces a titled message, and the space is not small', () => {
  const all = everyMessage();
  assert.ok(all.length >= 120, `only ${all.length} messages — the sweep is broken`);
  for (const m of all) {
    assert.equal(typeof m.prompt, 'string', label(m.args));
    assert.ok(m.prompt.length > 600, `${label(m.args)}: ${m.prompt.length} characters is not a message`);
    assert.ok(m.title && typeof m.title === 'string', `${label(m.args)}: no title`);
  }
  assert.throws(() => helpPrompt({ step: 'something-else' }), TypeError);
  assert.throws(() => helpPrompt({}), TypeError);
});

/* -------------------------------------------------------------- privacy */

/**
 * The hunt. Each pattern is a thing that must never be in a URL the app
 * opens: an address, the two key prefixes the providers use, a path under a
 * home on either platform, the name of the secret ref and of the config file.
 */
const LEAKS = [
  [/@[a-z0-9-]+\.[a-z]{2,}/i, 'an email address'],
  [/\bsk-/, 'a key prefix'],
  [/GOCSPX/, 'a Google client secret'],
  [/\/Users\//, 'a path under /Users'],
  [/\/home\//, 'a path under /home'],
  [/[A-Za-z]:\\/, 'a Windows path'],
  [/keyRef/, 'the secret ref'],
  [/config\.json/, 'the config file'],
  [/secrets\.enc|\.seed/, 'the secret store'],
];

test('no message carries an address, a key, a home path or a config file', () => {
  for (const m of everyMessage()) {
    for (const [re, what] of LEAKS) {
      assert.doesNotMatch(m.prompt, re, `${label(m.args)} carries ${what}: …${m.prompt.slice(Math.max(0, m.prompt.search(re) - 40), m.prompt.search(re) + 40)}…`);
    }
  }
});

test('PRIVACY: hostile inputs — an address, a key, a path — never reach the message', () => {
  const address = 'nemo.underwood@marchetti.example';
  const key = 'sk-ant-api03-ZZZZZZZZ';
  const home = '/Users/nemo/.zelos/config.json';
  for (const step of HELP_STEPS) {
    for (const provider of [address, key, home, 'C:\\Users\\nemo\\AppData', 'GOCSPX-abc', `frank@gmail.com`]) {
      const { prompt } = helpPrompt({ step, provider, signIn: address, platform: home, clientReady: key, guides: GUIDES });
      assert.ok(!prompt.includes(address), `${step}: the address went through as the provider`);
      assert.ok(!prompt.includes('marchetti'), `${step}: the domain went through as the provider`);
      assert.ok(!prompt.includes(key), `${step}: the key went through`);
      assert.ok(!prompt.includes('nemo'), `${step}: the person's name went through`);
      assert.ok(!prompt.includes('AppData'), `${step}: the Windows path went through`);
      for (const [re, what] of LEAKS) assert.doesNotMatch(prompt, re, `${step} with ${provider}: ${what}`);
    }
  }
  // And the link: the same message, once encoded, carries no more than the message did.
  const links = helpLinks({ step: 'email', provider: address, signIn: key, guides: GUIDES });
  assert.ok(!decodeURIComponent(links.claude).includes('marchetti'));
  assert.ok(!decodeURIComponent(links.chatgpt).includes('marchetti'));
});

test('the provider is reduced to a closed list, and an address or a domain becomes "unknown"', () => {
  assert.equal(providerName('Gmail'), 'gmail');
  assert.equal(providerName('Google Workspace'), 'workspace');
  assert.equal(providerName('iCloud Mail'), 'icloud');
  assert.equal(providerName('Outlook / Microsoft'), 'outlook');
  assert.equal(providerName('Microsoft 365'), 'microsoft365');
  assert.equal(providerName('Yahoo Mail'), 'yahoo');
  assert.equal(providerName('AOL Mail'), 'aol');
  assert.equal(providerName('Fastmail'), 'fastmail');
  assert.equal(providerName('Zoho Mail'), 'zoho');
  assert.equal(providerName('Proton Mail'), 'proton');
  for (const raw of HELP_PROVIDERS) assert.equal(providerName(raw), raw);
  assert.equal(providerName('nemo@marchetti.example'), 'unknown');
  assert.equal(providerName('marchetti.example'), 'unknown');
  assert.equal(providerName('imap.marchetti.example'), 'unknown');
  assert.equal(providerName(''), null);
  assert.equal(providerName(null), null);
  assert.equal(aiName('Claude'), 'anthropic');
  assert.equal(aiName('OpenAI'), 'openai');
  assert.equal(aiName('Ollama'), 'local');
  assert.equal(aiName('local'), 'local');
  assert.equal(aiName('something@else.com'), null);
  assert.equal(calendarName('google'), 'google');
  assert.equal(calendarName('iPhone or Mac (iCloud)'), 'icloud');
  assert.equal(calendarName('Outlook'), 'outlook');
  assert.equal(calendarName('other'), null);
});

/* ----------------------------------------------------------------- fit */

test('every message is under the address-bar budget, and the budget is the one the module states', () => {
  assert.equal(HELP_MAX_CHARS, 3500);
  let longest = 0;
  for (const m of everyMessage()) {
    assert.ok(m.prompt.length < HELP_MAX_CHARS, `${label(m.args)} is ${m.prompt.length} characters`);
    longest = Math.max(longest, m.prompt.length);
  }
  // Headroom, not a bare pass: a message that lands within a sentence of the
  // limit is one edit from being cut off.
  assert.ok(longest <= HELP_MAX_CHARS - 200, `the longest message is ${longest} characters — less than 200 from the limit`);
});

/* --------------------------------------------------------------- manner */

test('every message ends with the rules for Claude, word for word, and starts with what Zelos is', () => {
  assert.equal(HELP_RULES.length, 5);
  for (const m of everyMessage()) {
    for (const rule of HELP_RULES) assert.ok(m.prompt.includes(rule), `${label(m.args)} is missing the rule “${rule}”`);
    assert.match(m.prompt, /^You are helping someone set up Zelos\. Zelos is a free program on the person’s own computer that reads their email and calendar with an AI they choose; it has no server/);
    assert.match(m.prompt, /never sends, moves or deletes mail/);
    assert.match(m.prompt, /helping them through its setup screens/);
    assert.match(m.prompt, /Start by asking, in one short question, what they see on the screen right now\.$/);
    assert.match(m.prompt, /^The screen they are on:/m, `${label(m.args)} never says which screen`);
  }
});

test('the platform is said in the person\'s words, and comes from what the server calls itself', () => {
  assert.equal(platformName('darwin'), 'mac');
  assert.equal(platformName('win32'), 'windows');
  assert.equal(platformName('linux'), 'linux');
  assert.equal(platformName('mac'), 'mac');
  assert.equal(platformName('windows'), 'windows');
  assert.equal(platformName(), 'mac');
  assert.equal(platformName('/Users/nemo'), 'mac', 'junk does not become a platform');
  const line = { mac: 'They are on a Mac.', windows: 'They are on a Windows PC.', linux: 'They are on a Linux computer.' };
  for (const m of everyMessage()) {
    assert.ok(m.prompt.includes(line[m.args.platform]), `${label(m.args)} does not say which computer`);
    for (const other of HELP_PLATFORMS.filter((p) => p !== m.args.platform)) {
      assert.ok(!m.prompt.includes(line[other]), `${label(m.args)} says it is also a ${other}`);
    }
  }
  // process.platform's own names are accepted, so the route can pass it straight through.
  assert.ok(helpPrompt({ step: 'install', platform: 'win32' }).prompt.includes('Windows protected your PC'));
  assert.ok(helpPrompt({ step: 'install', platform: 'darwin' }).prompt.includes('Open Anyway'));
});

/* ------------------------------------------------------------- the links */

test('the two links are https, open a new chat, and decode back to the exact message', () => {
  for (const step of HELP_STEPS) {
    const links = helpLinks({ step, provider: step === 'email' ? 'gmail' : null, guides: GUIDES });
    assert.deepEqual(Object.keys(links).sort(), ['chatgpt', 'claude', 'prompt', 'title']);
    assert.match(links.claude, /^https:\/\/claude\.ai\/new\?q=/);
    assert.match(links.chatgpt, /^https:\/\/chatgpt\.com\/\?q=/);
    assert.equal(new URL(links.claude).searchParams.get('q'), links.prompt, `${step}: the Claude link does not carry the message`);
    assert.equal(new URL(links.chatgpt).searchParams.get('q'), links.prompt, `${step}: the ChatGPT link does not carry the message`);
    // encodeURIComponent, not encodeURI: an ampersand or a hash in the message
    // must not end the query string.
    assert.equal(links.claude, `https://claude.ai/new?q=${encodeURIComponent(links.prompt)}`);
    assert.ok(!/[^A-Za-z0-9%\-_.!~*'()]/.test(links.claude.slice('https://claude.ai/new?q='.length)), `${step}: the query is not fully encoded`);
    assert.ok(links.claude.length < 12_000, `${step}: the encoded link is ${links.claude.length} characters`);
  }
});

/* ------------------------------------------------------------- fidelity */

/** The words on the screens, read out of the files that draw them. */
const onboardingSrc = fs.readFileSync(path.join(ROOT, 'ui', 'views', 'onboarding.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(ROOT, 'ui', 'views', 'settings.js'), 'utf8');
const screens = `${onboardingSrc}\n${settingsSrc}`;

/** The quoted controls a message names, and the step that names them. */
const CONTROLS = {
  general: ['Zelos reads your email and calendar, and tells you what needs you.', 'It never sends, moves or deletes anything. Everything stays on this computer.', 'Set up Zelos', 'Look around with made-up data first', 'Skip the rest'],
  ai: ['Pick the AI that reads your mail.', 'Claude, by Anthropic', 'OpenAI, who make ChatGPT', 'Press Create Key and copy it.', 'Paste it here.', 'Your key', 'Check it works', 'More choices', 'Advanced', 'a key is saved — paste a new one to replace it', 'Paste the key first'],
  email: ['Connect your email.', 'Add an email account', 'Your email address', 'Get an app password', 'App password', 'Connect', 'Server settings (for experts)'],
  calendar: ['Add your calendar.', 'Google Calendar', 'iPhone or Mac (iCloud)', 'Outlook', 'Something else', 'Check it works and save', 'The secret address', 'Your Apple ID email', 'The app-specific password', 'The ICS link'],
  'first-check': ['Read my mail for the first time.', 'Read my mail now', 'Go to the board', 'Zelos can’t read anything yet — it still needs an AI (step 2) and an email account (step 3).', 'The check stopped.'],
};

test('the controls a message tells the person to press are the ones the screens draw', () => {
  for (const [step, controls] of Object.entries(CONTROLS)) {
    const provider = step === 'email' ? 'gmail' : null;
    const { prompt } = helpPrompt({ step, provider, guides: GUIDES });
    for (const control of controls) {
      assert.ok(screens.includes(control), `${step}: “${control}” is not on any screen — the message would name a control that does not exist`);
      assert.ok(prompt.includes(control), `${step}: the message does not name “${control}”`);
    }
  }
  // The provider-specific controls, each on the screen that has it.
  for (const [provider, controls] of [
    ['gmail', ['Sign in with Google', 'Use an app password instead']],
    ['outlook', ['Sign in with Microsoft', 'Show me how']],
    ['proton', ['Continue with Bridge settings', 'Test the connection', 'Save']],
    ['unknown', ['Server settings (for experts)', 'Test the connection', 'Save']],
  ]) {
    const { prompt } = helpPrompt({ step: 'email', provider, clientReady: true, guides: GUIDES });
    for (const control of controls) {
      assert.ok(screens.includes(control), `${provider}: “${control}” is not on any screen`);
      assert.ok(prompt.includes(control) || helpPrompt({ step: 'email', provider, clientReady: false, guides: GUIDES }).prompt.includes(control), `${provider}: the message does not name “${control}”`);
    }
  }
});

test('the email message names the provider\'s real app-password page, read off the provider table', () => {
  const pages = {
    gmail: describeProvider('someone@gmail.com').appPasswordUrl,
    workspace: describeProvider('someone@gmail.com').appPasswordUrl,
    icloud: describeProvider('someone@icloud.com').appPasswordUrl,
    yahoo: describeProvider('someone@yahoo.com').appPasswordUrl,
    aol: describeProvider('someone@aol.com').appPasswordUrl,
    fastmail: describeProvider('someone@fastmail.com').appPasswordUrl,
    zoho: describeProvider('someone@zoho.com').appPasswordUrl,
  };
  assert.match(pages.gmail, /^https:\/\/myaccount\.google\.com\/apppasswords$/, 'the provider table no longer points Gmail at its app-password page');
  for (const [provider, page] of Object.entries(pages)) {
    assert.match(page, /^https:\/\//, `${provider}: the table has no page`);
    const { prompt } = helpPrompt({ step: 'email', provider, guides: GUIDES });
    assert.ok(prompt.includes(page), `${provider}: the message does not name ${page}`);
    assert.ok(prompt.includes('Get an app password'), `${provider}: the message does not name the button that opens it`);
  }
  // Gmail: the sign-in path when this install can run it, the password path always.
  const ready = helpPrompt({ step: 'email', provider: 'gmail', clientReady: true, guides: GUIDES }).prompt;
  const notReady = helpPrompt({ step: 'email', provider: 'gmail', clientReady: false, guides: GUIDES }).prompt;
  assert.match(ready, /Sign in with Google/);
  assert.doesNotMatch(notReady, /Sign in with Google/, 'a Gmail card with no client is told to press a button it does not have');
  for (const p of [ready, notReady]) {
    assert.match(p, /2-Step Verification/);
    assert.match(p, /16 letters/);
    assert.match(p, /Zelos has worked out that their email is with Gmail\./);
  }
  // Workspace is Gmail underneath, and says so.
  assert.match(helpPrompt({ step: 'email', provider: 'workspace', guides: GUIDES }).prompt, /Google Workspace[\s\S]*Gmail underneath/);
  // The sign-in the guess named stands in for a provider the app did not send.
  assert.match(helpPrompt({ step: 'email', signIn: 'google', guides: GUIDES }).prompt, /their email is with Gmail/);
  assert.match(helpPrompt({ step: 'email', signIn: 'microsoft', guides: GUIDES }).prompt, /Outlook\.com, Hotmail, Live or MSN/);
});

test('iCloud: the app-specific password, where Apple keeps it, and the two boxes on the card', () => {
  const { prompt } = helpPrompt({ step: 'email', provider: 'icloud', guides: GUIDES });
  assert.match(prompt, /Zelos has worked out that their email is with iCloud Mail\./);
  assert.match(prompt, /Sign-In and Security/);
  assert.match(prompt, /App-Specific Passwords/);
  assert.match(prompt, /Two-factor authentication has to be on/);
  assert.ok(prompt.includes(describeProvider('someone@icloud.com').appPasswordUrl));
});

test('Outlook and Microsoft 365: no password, the device code, and the one-time setup only when this install has no client', () => {
  for (const provider of ['outlook', 'microsoft365']) {
    const notReady = helpPrompt({ step: 'email', provider, clientReady: false, guides: GUIDES }).prompt;
    const ready = helpPrompt({ step: 'email', provider, clientReady: true, guides: GUIDES }).prompt;
    for (const p of [notReady, ready]) {
      assert.match(p, /Sign in with Microsoft/, provider);
      assert.match(p, /microsoft\.com\/devicelogin/, provider);
    }
    assert.match(notReady, /one-time setup at Microsoft’s website/, provider);
    assert.match(notReady, /Show me how/, provider);
    assert.ok(notReady.includes(GUIDES.microsoftSetup), `${provider}: the setup guide is not the page /api/guides serves`);
    assert.doesNotMatch(ready, /one-time setup/, `${provider}: a shipped client is still sent to the setup page`);
    assert.doesNotMatch(ready, /Show me how/, provider);
  }
  assert.match(helpPrompt({ step: 'email', provider: 'outlook', guides: GUIDES }).prompt, /there is no password to paste/i);
  assert.match(helpPrompt({ step: 'email', provider: 'microsoft365', guides: GUIDES }).prompt, /work or school/);
});

test('an unknown provider is sent to "Server settings (for experts)" — the one message that may say IMAP', () => {
  const { prompt } = helpPrompt({ step: 'email', provider: 'unknown', guides: GUIDES });
  assert.match(prompt, /A provider Zelos does not know/);
  assert.match(prompt, /Server settings \(for experts\)/);
  assert.match(prompt, /IMAP host/);
  assert.match(prompt, /993/);
  assert.match(prompt, /Test the connection/);
  assert.match(prompt, /Try “Connect” with their normal password first/);
  // No message outside the Email step uses the protocol's name; the
  // calendar's one CalDAV is the iCloud address, marked "for experts".
  for (const m of everyMessage()) {
    if (m.args.step !== 'email') assert.doesNotMatch(m.prompt, /\bIMAP\b/, `${label(m.args)} says IMAP`);
    if (m.args.step !== 'calendar') assert.doesNotMatch(m.prompt, /CalDAV/, `${label(m.args)} says CalDAV`);
  }
  // And a message with no provider at all asks, and lists the shapes rather than every step of each.
  const none = helpPrompt({ step: 'email', guides: GUIDES }).prompt;
  assert.match(none, /Ask them who their email is with/);
  assert.match(none, /Gmail:/);
  assert.match(none, /iCloud:/);
  assert.match(none, /Outlook\.com or Hotmail:/);
});

test('the AI message names the two key pages the cards link, and the one button', () => {
  const anthropic = PRESETS.find((p) => p.id === 'anthropic').keyUrl;
  const openai = PRESETS.find((p) => p.id === 'openai').keyUrl;
  assert.match(anthropic, /^https:\/\//);
  assert.match(openai, /^https:\/\//);
  const both = helpPrompt({ step: 'ai' }).prompt;
  assert.ok(both.includes(anthropic), 'no provider chosen: Anthropic’s page is missing');
  assert.ok(both.includes(openai), 'no provider chosen: OpenAI’s page is missing');
  assert.match(both, /Claude is the recommended one/);
  const claude = helpPrompt({ step: 'ai', provider: 'Claude' }).prompt;
  assert.ok(claude.includes(anthropic));
  assert.ok(!claude.includes(openai), 'the Claude card is told about OpenAI’s page');
  assert.match(claude, /Press “Create Key”/);
  const gpt = helpPrompt({ step: 'ai', provider: 'OpenAI' }).prompt;
  assert.ok(gpt.includes(openai));
  assert.ok(!gpt.includes(anthropic), 'the OpenAI card is told about Anthropic’s page');
  assert.match(gpt, /Create new secret key/);
  // The card's own three lines, per company, as settings.js's GUIDED_PROVIDERS spells them.
  for (const [prompt, lines] of [
    [claude, ['1. Open Anthropic’s key page', '2. Press Create Key and copy it.', 'Working. Zelos will use Claude.']],
    [gpt, ['1. Open OpenAI’s key page', '2. Press Create new secret key and copy it.', 'Working. Zelos will use OpenAI.']],
  ]) {
    for (const line of lines) {
      assert.ok(prompt.includes(line), `the message does not say “${line}”`);
      assert.ok(settingsSrc.includes(line.replace(/^\d\. /, '').replace(/^Open /, '').replace(/^Working\. Zelos will use .*$/, 'Working. Zelos will use')), `settings.js no longer draws “${line}”`);
    }
  }
  const local = helpPrompt({ step: 'ai', provider: 'Ollama' }).prompt;
  assert.match(local, /already running on this computer/);
  assert.doesNotMatch(local, /Getting a key from/, 'a local runtime is sent for a key');
  assert.ok(!local.includes(anthropic) && !local.includes(openai), 'a local runtime is given a key page');
  for (const p of [both, claude, gpt]) {
    assert.match(p, /Check it works/);
    assert.match(p, /pay-as-you-go/i);
    assert.doesNotMatch(p, /[$€£]\s?\d|\d\s?(a|per) month/i, 'a price was invented');
  }
});

test('the calendar message gives the three calendars their real steps, and the pages /api/guides serves', () => {
  const all = helpPrompt({ step: 'calendar', guides: GUIDES }).prompt;
  assert.match(all, /Ask which calendar they use/);
  assert.match(all, /Secret address in iCal format/);
  assert.match(all, /App-Specific Passwords/);
  assert.match(all, /Publish a calendar/);
  assert.ok(all.includes(GUIDES.calendars.google.settings));
  assert.ok(all.includes(GUIDES.calendars.icloud.appPasswords));
  assert.ok(all.includes(GUIDES.calendars.icloud.caldav));
  assert.ok(all.includes(GUIDES.calendars.outlook.calendar));
  const google = helpPrompt({ step: 'calendar', provider: 'google', guides: GUIDES }).prompt;
  assert.match(google, /They chose “Google Calendar”\./);
  assert.doesNotMatch(google, /Publish a calendar/, 'the Google card is told Outlook’s steps');
  const icloud = helpPrompt({ step: 'calendar', provider: 'iPhone or Mac (iCloud)', guides: GUIDES }).prompt;
  assert.match(icloud, /They chose “iPhone or Mac \(iCloud\)”\./);
  assert.match(icloud, /Your Apple ID email/);
  // Without the guides the pages are named, not linked, and nothing breaks.
  const bare = helpPrompt({ step: 'calendar', provider: 'outlook' }).prompt;
  assert.match(bare, /Open Outlook’s calendar on the web — the link on the card/);
  assert.doesNotMatch(bare, /https:\/\/outlook/);
});

test('the first-check message says what "Read my mail now" does, and does not do', () => {
  const { prompt } = helpPrompt({ step: 'first-check' });
  assert.match(prompt, /Read my mail now/);
  assert.match(prompt, /fetches the recent mail/);
  assert.match(prompt, /asks the AI they chose to read through it once/);
  assert.match(prompt, /marks nothing as read, moves nothing, deletes nothing and sends nothing/);
  assert.match(prompt, /every half hour during the day/);
  assert.match(prompt, /Settings › Schedule/);
});

test('the install message is the first-open warning for the platform, in the words docs/INSTALL.md uses', () => {
  const mac = helpPrompt({ step: 'install', platform: 'mac' }).prompt;
  assert.match(mac, /Apple could not verify/);
  assert.match(mac, /press “Done”, not “Move to Trash”/);
  assert.match(mac, /Privacy & Security/);
  assert.match(mac, /Open Anyway/);
  assert.doesNotMatch(mac, /Windows protected/);
  const win = helpPrompt({ step: 'install', platform: 'windows' }).prompt;
  assert.match(win, /Windows protected your PC/);
  assert.match(win, /More info/);
  assert.match(win, /Run anyway/);
  assert.doesNotMatch(win, /Open Anyway/);
  const linux = helpPrompt({ step: 'install', platform: 'linux' }).prompt;
  assert.match(linux, /Linux shows no warning/);
  // Every claim is one docs/INSTALL.md makes, so the two cannot drift apart.
  const install = fs.readFileSync(path.join(ROOT, 'docs', 'INSTALL.md'), 'utf8');
  for (const phrase of ['Open Anyway', 'Move to Trash', 'Privacy & Security', 'Windows protected your PC', 'More info', 'Run anyway']) {
    assert.ok(install.includes(phrase), `docs/INSTALL.md no longer says “${phrase}”`);
  }
  // No install path: the Windows one is under the person's home.
  assert.doesNotMatch(win, /AppData|Program Files/);
});

test('the general message describes the five steps and the two buttons of the Welcome screen', () => {
  const { prompt } = helpPrompt({ step: 'general' });
  assert.match(prompt, /Welcome, AI, Email, Calendar, Done/);
  assert.match(prompt, /every one can be skipped/);
  assert.match(prompt, /Set up Zelos/);
  assert.match(prompt, /Look around with made-up data first/);
  assert.match(prompt, /Find out first what they want/);
});
