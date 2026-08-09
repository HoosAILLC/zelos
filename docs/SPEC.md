# Zelos — build spec & integration contract

**Zelos** is a local-first second brain. It reads your mail and your calendar, thinks about
them with a model *you* choose, and gives you one page: what needs you now, what you owe, what
owes you, and what's coming. Nothing is uploaded anywhere except the calls you make to the
model you picked — and that model can be running on your own machine.

Named for **Ζῆλος / Zelos**, the Greek daimon of zeal and devotion — one of the four winged
enforcers who stood beside Zeus with Nike, Kratos and Bia.

---

## 0. Non-negotiable constraints

1. **ZERO third-party runtime dependencies.** `package.json` has no `dependencies` and no
   `devDependencies`. Everything is Node 26 built-ins: `node:sqlite`, `node:http`, `node:tls`,
   `node:crypto`, `node:test`, global `fetch`. If you think you need a package, you don't —
   write it. This is the product's central trust claim; breaking it breaks the product.
   (The Electron shell in `desktop/` is the one exception and lives in its own package.json.)
2. **Nothing leaves the machine except model calls.** No telemetry, no analytics, no update
   pings, no CDN fonts, no remote images. The only outbound sockets permitted are: the user's
   IMAP host, the user's calendar URL, and the user's configured model `baseUrl`.
3. **Server binds `127.0.0.1` only.** Never `0.0.0.0`.
4. **Mail is attacker-controlled input.** Every byte from a message or an event is untrusted.
   The model's output is *data*, never instructions — the app never evaluates, executes, shells
   out to, or navigates to anything derived from model output or message content.
5. **Never send mail automatically.** Drafts are drafts. Sending requires a human click, always.
6. **Secrets never touch disk in plaintext, never appear in argv, never get logged.**
7. **ESM only** (`.mjs`, or `.js` with `"type":"module"`). Node 26 target.
8. Every module ships tests in `test/` runnable with `node --test`.

## 1. Layout

```
zelos/
  package.json          name/bin/scripts, NO dependencies
  zelos.mjs           CLI entry: parse flags, open db, start server, print URL, open browser
  core/
    config.mjs  secrets.mjs  db.mjs  llm.mjs  safety.mjs  triage.mjs  sweep.mjs  server.mjs
    log.mjs     time.mjs
    sources/imap.mjs  sources/mime.mjs  sources/ics.mjs  sources/caldav.mjs
  ui/  index.html  app.css  app.js  (plus any split modules; all served from disk)
  test/  *.test.mjs
  desktop/  main.js  preload.js  package.json   (Electron shell — its own deps)
  assets/  icon.png  fonts/
  docs/  SPEC.md  README.md  SECURITY.md
```

## 2. Data at rest

Home dir: `process.env.ZELOS_HOME || path.join(os.homedir(), '.zelos')`, mode `0700`.
Contains `config.json` (mode 0600, **no secrets**), `zelos.db`, `logs/`, `cache/`.

### Config shape (`core/config.mjs` owns this)

```jsonc
{
  "version": 1,
  "identity": { "name": "", "email": "", "timezone": "" },      // timezone from Intl if blank
  "model": {
    "protocol": "anthropic",          // "anthropic" | "openai"  — WIRE PROTOCOL, not a company
    "label": "Claude",
    "baseUrl": "https://api.anthropic.com",
    "model": "",
    "keyRef": "model.default",        // secrets ref; NEVER the key itself
    "maxTokens": 8192,
    "temperature": 0
  },
  "mail": [{
    "id": "m_xxx", "enabled": true, "label": "Work",
    "host": "", "port": 993, "secure": true, "user": "", "keyRef": "mail.m_xxx",
    "mailboxes": ["INBOX"], "sentMailbox": "Sent",
    "lookbackDays": 14, "maxMessages": 400
  }],
  "calendars": [{
    "id": "c_xxx", "enabled": true, "label": "Personal",
    "kind": "ics",                    // "ics" | "caldav" | "file"
    "url": "", "user": "", "keyRef": null
  }],
  "sweep": { "intervalMinutes": 30, "activeHours": [6, 23], "auto": true },
  "ui": { "theme": "marble" },        // "marble" | "blackfigure"
  "privacy": { "maxItemsPerSweep": 150, "sendBodies": true, "bodyChars": 4000 }
}
```

`privacy.sendBodies:false` means only headers + snippets go to the model — a real setting that
must actually change what is sent, and the UI must say so honestly.

### Exports

```js
// core/config.mjs
export const DEFAULTS
export function paths()                    // {home, db, configFile, logsDir, cacheDir}
export function loadConfig()               // deep-merged over DEFAULTS; creates home dir 0700
export function saveConfig(patch)          // deep merge, atomic write (tmp + rename), 0600, returns config
export function validateConfig(cfg)        // -> {ok, errors:[{path,message}]}
export function newId(prefix)              // e.g. newId('m') -> 'm_9f3a1c'
```

```js
// core/secrets.mjs   — refs are short opaque strings like "model.default", "mail.m_9f3a1c"
export async function backend()            // {name, writable, note}  name: macos-keychain|windows-dpapi|libsecret|encrypted-file
export async function setSecret(ref, value)
export async function getSecret(ref)       // string | null
export async function deleteSecret(ref)
export async function listRefs()           // [ref] — refs only, never values
```

Backends, in order of preference per platform:
- **macOS**: `/usr/bin/security` generic passwords, service `com.zelos.app`, account = ref.
  **The password must not appear in argv** (`ps` shows it). Invoke `security add-generic-password
  -U -s <svc> -a <ref> -w` with **no value after `-w`** and write the value + `\n` to stdin —
  `security` prompts and reads it there. Read back with `find-generic-password -w`.
- **Windows**: PowerShell DPAPI (`ConvertTo-SecureString`/`ConvertFrom-SecureString` at
  CurrentUser scope), blob stored under `%LOCALAPPDATA%\Zelos\secrets`. Value goes in over
  **stdin**, never as a command-line argument.
- **Linux**: `secret-tool` if present.
- **Fallback (any platform)**: `secrets.enc` in the Zelos home, mode 0600 — AES-256-GCM,
  key = `scrypt(machineSeed, randomSaltStoredInFile, N=2**15)` where `machineSeed` is a random
  32-byte value generated once and stored in `.seed` (0600). `backend().note` must state
  plainly that this protects at rest but not against a process running as this user. The UI
  surfaces that note verbatim.

### Schema (`core/db.mjs`)

`open(dbPath)` sets `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
`migrate(db)` is idempotent and versioned via `PRAGMA user_version`.

```sql
messages(id TEXT PRIMARY KEY,       -- sha256(sourceId|uid|messageId) hex, 16 chars
         source_id TEXT, uid INTEGER, message_id TEXT, thread_key TEXT,
         folder TEXT, direction TEXT,             -- 'in' | 'out'
         from_name TEXT, from_email TEXT, to_json TEXT, cc_json TEXT,
         subject TEXT, sent_at TEXT,              -- ISO8601 with offset
         snippet TEXT, body TEXT, has_attach INTEGER,
         flags_json TEXT, fetched_at TEXT)
events(id TEXT PRIMARY KEY,          -- sha256(calendarId|uid|recurrenceId)
       calendar_id TEXT, uid TEXT, recurrence_id TEXT,
       title TEXT, description TEXT, location TEXT,
       starts_at TEXT, ends_at TEXT, all_day INTEGER,   -- ISO8601 WITH explicit offset
       organizer TEXT, attendees_json TEXT, rsvp TEXT, status TEXT, url TEXT,
       fetched_at TEXT)
items(id TEXT PRIMARY KEY, kind TEXT, bucket TEXT, headline TEXT, why TEXT,
      person TEXT, person_email TEXT, due_at TEXT, severity INTEGER, link TEXT,
      source_refs_json TEXT, payload_json TEXT,
      first_seen TEXT, seen_runs INTEGER, last_seen_run TEXT,
      state TEXT, state_at TEXT, updated_at TEXT)      -- state: open|done|dismissed|snoozed
drafts(id TEXT PRIMARY KEY, item_id TEXT, to_email TEXT, subject TEXT, body TEXT,
       state TEXT, created_at TEXT, updated_at TEXT)   -- state: pending|edited|used|discarded
captures(id TEXT PRIMARY KEY, text TEXT, created_at TEXT, processed_at TEXT)
runs(id TEXT PRIMARY KEY, kind TEXT, started_at TEXT, ended_at TEXT, ok INTEGER,
     model TEXT, tokens_in INTEGER, tokens_out INTEGER, error TEXT, stats_json TEXT)
kv(k TEXT PRIMARY KEY, v TEXT)
search USING fts5(title, body, ref UNINDEXED, kind UNINDEXED, tokenize='porter unicode61')
```

`bucket` is a closed set: `now | today | soon | waiting | promised | note | money`.
`severity` is 0–3. Buckets and severities are validated in code, not trusted from the model.

## 3. `core/llm.mjs` — the model adapter

Two wire protocols cover every mainstream provider. **The protocol is not the company.**

- `openai` → `POST {baseUrl}/chat/completions`, `Authorization: Bearer <key>`.
  Covers OpenAI, Google Gemini (OpenAI-compatible endpoint), Groq, Mistral, DeepSeek, xAI,
  Together, OpenRouter, Fireworks, Cerebras, **Ollama, LM Studio, llama.cpp, vLLM, LocalAI**.
- `anthropic` → `POST {baseUrl}/v1/messages`, headers `x-api-key` + `anthropic-version:
  2023-06-01`, system prompt at **top level** (not a message), `max_tokens` required.

```js
export class LLMError extends Error {}   // .status, .address, .retriable
export async function complete(opts)     // -> {text, usage:{input,output}, model, raw}
export async function *stream(opts)      // yields {type:'delta',text} … {type:'done',usage}
export async function listModels({protocol, baseUrl, apiKey, signal})  // -> [{id,label}]
export async function probeLocal({signal})   // -> [{label, baseUrl, protocol:'openai', models:[]}]
export function extractJSON(text)            // tolerant: strips ```json fences, finds outermost {...}
export const PRESETS                         // see below
export function isLocalAddress(baseUrl)      // localhost/127.0.0.1/::1/*.local/192.168./10./172.16-31.
```

`opts`: `{protocol, baseUrl, model, apiKey, system, messages:[{role,content}], maxTokens,
temperature, json:boolean, timeoutMs=120000, signal, retries=3}`.

Rules — these are load-bearing, they came from a previous build:
- **A missing API key is only an error for non-local addresses.** Keyless local models must
  just work.
- **`extractJSON` must recover from fences and surrounding prose** — small local models wrap
  their output even when told not to.
- Retry `408, 409, 429, 5xx` with exponential backoff + jitter, honouring `Retry-After`.
  **Never retry a 401/403.**
- Every thrown error names the address that failed, so a user can tell "my key is wrong" from
  "my Ollama isn't running."
- Streaming parses SSE for both protocols (`data: ` lines; anthropic
  `content_block_delta`/`message_delta`, openai `choices[].delta.content`).
- `json:true` sets `response_format:{type:'json_object'}` on `openai` when the endpoint is
  non-local; it must **not** be sent to local endpoints (many reject it) — instead rely on
  prompt + `extractJSON`.

`PRESETS` entries: `{id, label, protocol, baseUrl, docsUrl, keyUrl, local:boolean,
suggestedModels:[], keyless:boolean, note}`. Include at minimum: Anthropic, OpenAI, Google
Gemini, Groq, Mistral, DeepSeek, xAI, Together, OpenRouter, Fireworks, Cerebras, Ollama,
LM Studio, llama.cpp, vLLM, LocalAI.

Probe targets for `probeLocal`: Ollama `http://127.0.0.1:11434/v1`, LM Studio
`http://127.0.0.1:1234/v1`, llama.cpp `http://127.0.0.1:8080/v1`, vLLM
`http://127.0.0.1:8000/v1`. Probe = `GET {baseUrl}/models` with a 1200ms timeout, all in
parallel, failures silent.

**Testing**: stand up a real `node:http` mock server implementing both protocols and assert on
**what hits the socket** — URL path, headers, body shape — not on a stub's return value.

## 4. `core/sources/imap.mjs` + `mime.mjs` — zero-dependency IMAP

IMAP4rev1 over `node:tls` (`secure:true`, port 993) or `node:net` + `STARTTLS`.

```js
export class ImapClient {
  constructor({host, port, secure, user, pass, timeoutMs = 30000, logger})
  async connect()                     // resolves after greeting
  async login()                       // LOGIN, or AUTHENTICATE PLAIN if LOGINDISABLED
  async capabilities()                // -> Set<string>
  async listMailboxes()               // -> [{name, delimiter, flags:[], specialUse}]
  async select(mailbox)               // -> {exists, uidValidity, uidNext, flags}
  async search(criteria)              // e.g. ['SINCE','01-Aug-2026'] -> [uid]
  async fetch(uids, items)            // -> [{uid, ...parsed}]
  async logout()
  async close()
}
export async function fetchRecent(opts)  // the one function the engine calls
export async function testConnection({host,port,secure,user,pass}) // -> {ok, capabilities, mailboxes, error}
export function guessImapHost(email)     // gmail/icloud/outlook/yahoo/fastmail/proton-bridge -> {host,port,note}
```

`fetchRecent({host,port,secure,user,pass, mailbox='INBOX', sinceDays=14, limit=400, onProgress})`
returns newest-first:

```js
{ uid, messageId, inReplyTo, references:[], threadKey,
  from:{name,email}, to:[{name,email}], cc:[],
  subject, date /* ISO8601 with offset */, snippet /* ≤240 chars, plain */,
  text /* decoded plain body */, hasAttachments, flags:[], folder }
```

Protocol details you must get right — these are the ones that bite:
- **Literals.** `{123}\r\n` means "the next 123 **bytes** are data, ignore CRLF inside them."
  A line-splitting parser corrupts every message with a `)` or `\r\n` in a header. Parse as a
  byte stream with an explicit literal-length state, not `split('\r\n')`.
- Buffer by **bytes**, not strings — multibyte UTF-8 splits across TCP chunks.
- Tagged responses (`A007 OK|NO|BAD`) resolve the command; untagged (`*`) accumulate.
  Support pipelining of at most one in-flight command (simplest correct model: a queue).
- `UID FETCH` and `UID SEARCH`, never sequence numbers — sequence numbers shift underneath you.
- Fetch cheaply first:
  `UID FETCH <set> (UID FLAGS INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC
  SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID)])`, then pull only the `text/plain`
  part by its BODYSTRUCTURE part number. **`BODY.PEEK`, never `BODY`** — `BODY` sets `\Seen`
  and marking a user's mail read is unacceptable.
- If there is no `text/plain` part, take `text/html` and strip it (see `mime.mjs`).
- Chunk `UID FETCH` sets (≤ 100 uids per command) — some servers choke on huge sets.
- Handle `* BYE`, idle timeouts, and TLS errors by rejecting all pending commands with a
  message that names the host.
- `guessImapHost` must return the app-password note for Gmail/iCloud/Yahoo — those providers
  require one and users will otherwise think the app is broken.

```js
// core/sources/mime.mjs
export function decodeWords(str)                 // RFC 2047 =?utf-8?B?..?= / ?Q?..?=, adjacent-word folding
export function decodeTransfer(buf, encoding)    // base64 | quoted-printable | 7bit | 8bit | binary
export function decodeCharset(buf, charset)      // utf-8, iso-8859-*, windows-125*, us-ascii via TextDecoder; unknown -> utf-8 lossy
export function parseAddressList(str)            // -> [{name,email}] ; groups, quoted names, comments
export function parseHeaders(buf)                // -> Map (unfolded, lowercase keys, repeats kept)
export function htmlToText(html)                 // strip script/style, block-level -> \n, entities, collapse
export function parseDate(str)                   // RFC 5322 -> ISO8601 with offset, or null
export function threadKeyFor({messageId, inReplyTo, references, subject})
```

**Testing**: a mock IMAP server over `node:net` that replays realistic responses (including a
literal containing `\r\n)` , a base64 UTF-8 subject, a multipart/alternative body, and a
`NO [AUTHENTICATIONFAILED]`). Assert the client's emitted command lines and the parsed output.

## 5. `core/sources/ics.mjs` + `caldav.mjs`

```js
// ics.mjs
export function unfold(text)                 // RFC5545 line unfolding (CRLF + space/tab)
export function parseICS(text)               // -> {vevents:[VEvent], vtimezones:Map, calname}
export function expand(vevents, {from, to, max = 1500, tzid})  // -> [Event]
export function parseICS_toEvents(text, {from, to})            // convenience
```

`Event`: `{uid, recurrenceId, title, description, location, startsAt, endsAt, allDay,
organizer, attendees:[{name,email,rsvp}], rsvp, status, url, calendarName}`.

Get these right:
- **`startsAt`/`endsAt` are ISO8601 strings carrying an explicit offset** (`2026-08-11T14:00:00-04:00`)
  or, for all-day, a bare `YYYY-MM-DD` with `allDay:true`. Downstream code reads wall-clock time
  **off the string with a regex** — it must never round-trip through `new Date()` and re-express
  in the viewer's zone. Do not lose the offset.
- Forms to handle: `DTSTART;VALUE=DATE:20260811`, `DTSTART;TZID=America/New_York:20260811T140000`,
  `DTSTART:20260811T180000Z`, floating local time (no Z, no TZID).
- Resolve `TZID` offsets using `Intl.DateTimeFormat(tz,{timeZoneName:'longOffset'})` for the
  instant in question — that gets DST right without shipping a tz database. Fall back to the
  embedded `VTIMEZONE` only if `Intl` rejects the id.
- `RRULE` support: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`
  (incl. `2TU`, `-1FR`), `BYMONTHDAY`, `BYMONTH`, `WKST`. Plus `EXDATE`, `RDATE`, and
  `RECURRENCE-ID` overrides which **replace** the generated instance with that UID.
- Hard-cap expansion at `max` instances and never loop forever on a malformed rule.
- Escaping: `\n \, \; \\` in TEXT values.

```js
// caldav.mjs  — reuses the ics parser
export async function discover({url, user, pass})   // PROPFIND current-user-principal -> calendar-home-set -> calendar list
export async function fetchRange({url, user, pass, from, to})  // REPORT calendar-query -> [icsText]
export async function testConnection({url,user,pass})          // -> {ok, calendars:[{href,name}], error}
```
Hand-rolled minimal XML parsing is fine (namespace-agnostic: match on local names). Basic auth.
Follow one redirect. iCloud/Fastmail/Nextcloud shapes are the targets.

## 6. `core/safety.mjs`

```js
export function safeUrl(u)              // -> string|null ; ONLY http/https/mailto. Blocks javascript:, data:, vbscript:, file:
export function screenContent(s)        // throws SafetyError on <script|iframe|object|embed|svg|link|meta, javascript:, data:text/html, vbscript:, on…=
export function cap(str, n)             // truncate + ellipsis, always returns a string
export function wrapUntrusted(label, text)   // fenced, delimiter-collision-proof block for prompts
export function scrubForPrompt(text)    // neutralise obvious injection framing in untrusted text
export function validateSweep(obj)      // deep shape/enum/length validation, returns {ok,value,errors}
export class SafetyError extends Error {}
```

`wrapUntrusted` must make it structurally clear to the model where untrusted data starts and
ends, and `scrubForPrompt` must neutralise the common framings without mangling real prose —
document what it does and does not catch in `docs/SECURITY.md`. The honest position, which the
docs must state: prompt-injection defence in depth is *mitigation*, not a proof. The real
guarantee is that **Zelos never acts on model output** — it renders it, and a human clicks.

## 7. `core/triage.mjs` + `core/sweep.mjs`

```js
// triage.mjs
export function buildSweepPrompt({identity, now, messages, events, captures, priorItems, privacy})
   // -> {system, messages, budget:{approxChars}}
export const SWEEP_JSON_SHAPE     // documented shape, mirrored in the prompt
export function mergeSweep(db, parsed, {runId, now})  // upsert items, carry firstSeen/seenRuns
```

The model returns:
```jsonc
{
  "first": "item id it ranks as do-this-first, or null",
  "items": [{
    "key": "stable-slug-derived-from-the-thing-itself",
    "bucket": "now|today|soon|waiting|promised|note|money",
    "headline": "imperative, ≤90 chars, reads without decoding",
    "why": "≤240 chars, concrete",
    "person": "", "personEmail": "",
    "dueAt": "ISO or null", "severity": 0,
    "sourceRefs": ["msg:<id>", "evt:<id>", "cap:<id>"],
    "link": "https://… or null",
    "draft": { "to": "", "subject": "", "body": "" }   // optional; only for waiting/promised
  }],
  "notes": ["short observations"]
}
```

Hard rules, enforced in **code** after the model — not by asking nicely:
- **At most 4 items may be `now`.** If the model returns more, keep the 4 highest-severity and
  demote the rest to `today`. A board where everything is urgent has no signal.
- **At most 10 `today`.** The rest become `soon`.
- `bucket` and `severity` are clamped to their legal sets.
- `link` runs through `safeUrl`; every string through `cap` and `screenContent`.
- `sourceRefs` must resolve to rows that actually exist; drop the ones that don't.
- `key` is what identity is carried on: an item whose `key` matches an existing open item keeps
  its `first_seen` and increments `seen_runs`. Items not returned this run are **not deleted** —
  they keep their state, and the UI shows how long a thing has been carried.
- Drafts are never auto-sent and never contain `[placeholders]` — a draft with a bracketed
  placeholder is rejected as not-ready and logged.

```js
// sweep.mjs
export async function runSweep({db, config, mode = 'auto', onProgress, signal})
   // -> {runId, ok, stats:{messages, events, items, now, tokensIn, tokensOut, ms}, error?}
export function shouldRunFull(db, config, now)     // light/full decision
export function nextRunAt(config, now)
export class Scheduler { start(); stop(); status() }  // interval + active-hours aware, in-process
```

Light vs full: a **light** run re-fetches sources and recomputes derived state (staleness,
counts, ordering) **without** calling the model. A **full** run calls the model. Go full when
there is new mail/events since the last full run, or when >4h have passed. `onProgress` emits
`{phase, message, done, total}` for the SSE stream.

## 8. `core/server.mjs` + `zelos.mjs`

`createServer({db, config, scheduler})` → a `node:http` server. Binds `127.0.0.1`, port from
`ZELOS_PORT` or 7777, incrementing to find a free one.

**Local security model — required, not optional.** Any web page in the user's browser can send
requests to `127.0.0.1`. So:
- A random 32-byte hex `sessionToken` is minted per launch and printed in the launch URL as
  `?t=…`. The UI stores it and sends it as `X-Zelos-Token` on every API call.
- Every `/api/*` request requires a matching token. Reject with 401 otherwise.
- Reject any request whose `Origin` header is present and is not the server's own origin.
- No CORS headers, ever. `Access-Control-Allow-Origin` must not appear anywhere.
- Static file serving is path-traversal-proof (resolve, then assert the resolved path is inside
  `ui/`).
- Response headers: `Content-Security-Policy: default-src 'self'; img-src 'self' data:;
  style-src 'self' 'unsafe-inline'; connect-src 'self'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`.

Routes (JSON in/out unless noted):

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ok, version, home, backend, model:{configured,label}}` |
| GET | `/api/state` | | full board: `{items[], events[], drafts[], runs:{last}, counts, notes[], first}` |
| POST | `/api/sweep` | `{mode}` | `{runId}` — starts, returns immediately |
| GET | `/api/sweep/stream` | | **SSE** progress events |
| POST | `/api/items/:id/state` | `{state}` | updated item |
| POST | `/api/capture` | `{text}` | `{id}` |
| GET/PUT | `/api/config` | config patch | `{config, errors}` — **never returns secrets** |
| POST | `/api/secrets` | `{ref, value}` | `{ok}` — write-only, no read route exists |
| DELETE | `/api/secrets/:ref` | | `{ok}` |
| POST | `/api/model/test` | `{protocol,baseUrl,model,keyRef}` | `{ok, sample, ms, error}` |
| GET | `/api/model/list` | `?protocol&baseUrl&keyRef` | `[{id,label}]` |
| GET | `/api/model/presets` | | `PRESETS` |
| GET | `/api/local/probe` | | detected local runtimes |
| POST | `/api/mail/test` | mail account | `{ok, mailboxes, error}` |
| POST | `/api/calendar/test` | calendar | `{ok, calendars, error}` |
| POST | `/api/ask` | `{question}` | **SSE** streamed answer grounded in FTS5 hits |
| PUT | `/api/drafts/:id` | `{body,state}` | draft |
| GET | `/api/search` | `?q` | FTS5 results |

`zelos.mjs`: flags `--port --home --no-open --sweep-now --version --help`. On start: migrate,
print a clean banner with the URL, open the browser unless `--no-open` (macOS `open`, Windows
`start`, Linux `xdg-open`), start the scheduler if `sweep.auto`, handle SIGINT cleanly.
If the model is not configured, still start — the UI's job is to walk the user through setup.

## 9. `ui/` — the face

Zero build step, zero dependencies, no CDN. Plain ES modules, hand-written CSS.
Must work offline. All fonts self-hosted in `assets/fonts` (or a good system stack).

**Design identity.** Zelos is Greek — but the *app* is the quiet half of that identity. It is
not a pottery museum; it is an operator's board that happens to be carved from the same stone
as the marketing site.

- Palette: bone/marble ground `#F4EFE6`, ink `#171310`, one accent — **terracotta `#C1440E`**.
  Supporting: aged olive `#6B6A4B`, lapis `#1F3A6E` used only for calendar time.
  Dark theme "black-figure": ground `#12100E`, terracotta unchanged, bone as the type colour.
- Colour carries meaning, never decoration: terracotta = needs you. Everything else is ink on
  bone. If the whole page is terracotta, the design has failed.
- A **meander (Greek key) rule** is the one ornament — used as a section divider and as the
  active-tab indicator. Drawn in CSS/SVG, never an image.
- Type: a humanist serif for headlines with real classical proportion, a clean sans for UI, a
  mono for numbers/times. No system-ui-only stack for the headline — it must have character.
- Layout: left rail at ≥60rem showing every bucket's count inline (nothing needs a click to
  read); bottom tab bar under that. Content column caps at ~52rem; two columns only ≥80rem.
- Views: **Now · Today · Owed · Calendar · Ask · Settings**.
  - *Now*: the single `first` item as a hero, then ≤4 now items, then "Worth knowing" notes.
  - *Today*: dense rows sorted by severity/due, 8 visible, rest folded behind "show the other N"
    — nothing is ever silently dropped.
  - *Owed*: three rosters — drafts ready to send, you owe them, they owe you. Draft bodies in
    auto-growing textareas with edit/discard/copy; edits persist to the server.
  - *Calendar*: a real time-grid week view. Chips absolutely positioned from wall-clock minutes
    read **off the ISO string**. Overlaps packed by cluster-then-greedy-column. Today marked, a
    now-line. Day/Week/Month segmented control. Month cells sort conflicts first.
  - *Ask*: streaming answer over your own indexed context, with the sources it used listed.
  - *Settings*: model, mail, calendars, sweep, privacy, data (export/wipe), about.
- **First-run onboarding** is a real, designed flow, not a form dump: pick a model (local
  runtimes detected and offered first), paste a key, connect mail, connect a calendar, first
  sweep — with honest progress and an escape hatch at every step.
- Accessibility: real `<button>`s, visible focus rings, `aria-live` on sweep progress,
  checkboxes as `role="checkbox"` (a checkbox inside a `<summary>` toggles the disclosure —
  keep them as separate controls), 44px minimum touch targets, works at 375px.
- Never `innerHTML` with server or model data. Build nodes, set `textContent`.
- Motion is subtle and honours `prefers-reduced-motion`; no reveal animation may leave content
  hidden if its animation never runs.

## 10. `desktop/` — the Electron shell

Own `package.json` (Electron + electron-builder are allowed there and only there). `main.js`
spawns the core in-process (import `createServer` directly — do not fork a second Node), opens
a `BrowserWindow` at the local URL with the token, `contextIsolation:true`, `nodeIntegration:false`,
a tray icon with "Sweep now / Open / Quit", and blocks navigation to any non-local origin.
Build targets: macOS `dmg` (arm64 + x64) and Windows `nsis`. Document plainly in the README
that unsigned builds warn on first open and how to get past it.

## 11. Tests

`npm test` → `node --test test/`. Required coverage:
- llm: both protocols against a mock server, asserting URL/headers/body; retry and no-retry-on-401;
  keyless local; `extractJSON` on fenced/prose-wrapped output; SSE streaming for both protocols.
- imap: mock server; literal containing CRLF and `)`; RFC2047 subject; multipart/alternative;
  auth failure; BODY.PEEK asserted in the emitted command.
- mime: encoded words, charsets, address lists with quoted names and groups, html→text.
- ics: all four DTSTART forms; DST boundary; each RRULE feature; EXDATE; RECURRENCE-ID override;
  runaway-rule cap.
- safety: every blocked scheme and tag; `screenContent` on real injection payloads.
- triage: the `now ≤ 4` clamp; bucket/severity clamping; firstSeen/seenRuns carry-forward;
  placeholder-draft rejection; dangling sourceRef drop.
- server: token required; `Origin` rejection; path traversal blocked; secrets have no read route.

Tests must not touch the real `~/.zelos` — always `ZELOS_HOME` in a temp dir. No test may
make a real network call to a third party.
