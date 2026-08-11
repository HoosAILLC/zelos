/**
 * core/connectors/todoist.mjs — the Todoist tasks that are due today or already late.
 *
 * The twin of core/connectors/linear.mjs and deliberately the same shape: a task
 * assigned to you with a date on it is an obligation, so it arrives at the board
 * as a message (`sink: 'messages'`) rather than as an entry in the day's
 * schedule. The long note at the top of linear.mjs explains the four decisions
 * both files share — the read-time `date`, the missing `uid`, identity from an
 * id that cannot move, and a `note` rather than a silent trim — and they are not
 * restated here. What follows is only what is different about Todoist, and there
 * are four things, each of which has already been a bug somewhere.
 *
 *  1. A DUE VALUE HAS THREE SHAPES AND ONLY ONE OF THEM MAY BE CONVERTED
 *     THROUGH A TIMEZONE. Todoist returns `due.date` as a bare `YYYY-MM-DD` for
 *     a task with no time on it, and `due.datetime` for one with a time — and
 *     `due.datetime` is itself two different things. Feeding a bare date to
 *     `new Date()` reads it as UTC midnight; re-expressing that in any zone west
 *     of Greenwich lands it on the day BEFORE — so every task due today would
 *     read as one day overdue, for every user in the Americas, all the time. A
 *     datetime that carries an offset needs exactly the conversion the bare date
 *     must not get: `2026-08-12T02:00:00Z` is nine in the evening on the 11th in
 *     New York, and reading its day key straight off the string calls a task due
 *     tonight "due tomorrow" and drops it out of today. And the third shape —
 *     `2026-08-12T01:00:00`, a time with NO offset, which is what Todoist sends
 *     for a task given a time in a workspace with no fixed zone — is a WALL
 *     CLOCK, the digits the user typed, with no instant in it to convert. It has
 *     to be read the way a bare date is; `new Date()` resolves it against the
 *     MACHINE's zone, which is not the user's. `dueDayKey` below is six lines
 *     and every branch is load-bearing.
 *
 *  2. TODOIST'S PRIORITY IS NUMBERED BACKWARDS FROM THE ONE PEOPLE SEE, AND
 *     BACKWARDS FROM LINEAR'S. In the API `priority: 4` is the most urgent and 1
 *     is the default; in the app those are "P1" and "P4". Linear runs the other
 *     way — 1 is Urgent and 0 means none — so a helper shared between these two
 *     files would rank one of them exactly upside down. That is most of why
 *     there is no shared helper: two vendors, opposite polarity, one line each,
 *     named in the file that owns it.
 *
 *  3. A RECURRING TASK KEEPS ITS ID. Finish "water the plants" today and
 *     tomorrow's occurrence comes back as the same task id with a new due date.
 *     That is correct for `messageId` and it is why identity is built on the id:
 *     one standing obligation, re-armed, updating one row in place — not a new
 *     row every day forever.
 *
 *  4. THE FILTER IS A DIFFERENT ENDPOINT, NOT A PARAMETER ON THIS ONE. Under
 *     the old REST v2 API a filter rode along as `GET /tasks?filter=…`. API v1
 *     removed it: "The filter and lang parameters were removed: A new dedicated
 *     endpoint has been created specifically for filtering tasks:
 *     /api/v1/tasks/filter" — Todoist's own v1 migration guide. Doist's own SDK
 *     settles both halves of the shape: `TASKS_FILTER_PATH = "tasks/filter"`,
 *     and the expression travels as `query`, beside `lang` and a `limit` capped
 *     at 200. The plain list endpoint takes `project_id`, `section_id`,
 *     `parent_id`, `label`, `ids` and `limit` — no filter of any kind.
 *
 *     This connector shipped addressing the removed parameter on the unfiltered
 *     endpoint, which is the worst shape this bug has. `GET /api/v1/tasks` is a
 *     perfectly valid request: it answers 200 with EVERY active task in the
 *     account and ignores the parameter it does not know. So the user's whole
 *     selection criterion was dropped in silence — `dueness` sorts undated tasks
 *     last and future-dated ones after due-today, so any list shorter than
 *     "Tasks to keep" got its remaining slots padded with tasks due weeks out,
 *     under a source whose own label promises "due today or overdue". Nothing
 *     threw, nothing warned, and the editable filter field did nothing at all.
 *
 * The filter is the user's, with a default Zelos chooses. Todoist's filter
 * grammar is a real query language and it is theirs, not ours: shipping
 * `overdue | today` as the default and leaving the box editable means a person
 * with shared projects can write `(overdue | today) & assigned to: me` without
 * waiting for a release, and means this file never has to grow a second opinion
 * about what "mine" means in somebody else's workspace.
 */

import { AuthError, RateLimitError } from './http.mjs';
import { dayKey, daysBetweenKeys, toZonedISO, todayKey, wallClock } from '../time.mjs';

const ORIGIN = 'https://api.todoist.com';
/**
 * NOT `/api/v1/tasks`. See note 4 at the top: that endpoint has no filter
 * parameter and never refuses one, so pointing a filtered read at it is a
 * request that succeeds and answers the wrong question.
 */
export const ENDPOINT = `${ORIGIN}/api/v1/tasks/filter`;

/** The name this endpoint gives the filter expression. `filter` is the v2 one. */
export const QUERY_PARAM = 'query';

/** Todoist's page ceiling for this endpoint — the SDK types `limit` as 1…200. */
const PAGE = 200;

/**
 * The paging loop's stop.
 *
 * "Due today or overdue" is a small list by construction — it is a day's work,
 * not a backlog — so three pages is 600 tasks and already far past the point
 * where a board is the wrong tool. It exists to bound a cursor that has stopped
 * advancing, which is the failure mode a `while (next_cursor)` loop has.
 */
const MAX_PAGES = 3;

/** The hard ceiling, whatever the user asked to keep. */
const MAX_ROWS = 200;

const DEFAULT_KEEP = 50;
const DEFAULT_FILTER = 'overdue | today';

const SNIPPET_CHARS = 240;
const BODY_CHARS = 4_000;

/** A stranger's error text goes into `runs.error` and into /api/state. Bound it. */
const ERROR_CHARS = 300;

/** The window the declared budget is spent over. */
const BUDGET_MS = 15 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const collapse = (s) => str(s).replace(/\s+/g, ' ').trim();

/**
 * The filter as it appears in a sentence the user reads.
 *
 * Their own text, so quoting it is safe — but it is a free text field with no
 * ceiling on it, and it is quoted into `sources[].error` and into a `zelos
 * doctor` row that is printed whole (core/doctor.mjs:80 puts no cap on
 * `errorText`). A 4,000-character filter would push the vendor's own sentence
 * out past ERROR_CHARS, which is the half that says what went wrong.
 */
const shortFilter = (f) => (f.length > 120 ? `${f.slice(0, 119)}…` : f);

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.round(n), max));
}

/**
 * The API's priority number as the label the user actually sees.
 *
 * 4 -> P1, 1 -> P4. See note 2 at the top: this is inverted from the app and
 * inverted again from Linear's, and it is written as one expression here so
 * there is one place to be wrong. 1 is the default every task carries, so it is
 * reported as nothing rather than as "P4" — a board full of "P4" says less than
 * a board that only mentions priority when somebody set one.
 */
export function priorityLabel(priority) {
  const n = Number(priority);
  if (!Number.isInteger(n) || n < 2 || n > 4) return '';
  return `P${5 - n}`;
}

/**
 * The day a due value falls on, in the reader's own zone.
 *
 * Note 1 at the top is the whole justification. A bare `YYYY-MM-DD` is a DAY and
 * has no instant to convert; a timestamp WITH AN OFFSET is an INSTANT and has no
 * day until a zone is named. Getting either backwards moves the answer by one
 * day, which is the entire difference between "due today" and "overdue" — the
 * one distinction this connector exists to make.
 *
 * The third shape is the one that shipped broken. `2026-08-12T01:00:00` carries
 * no offset, so it names no instant — it is a wall clock, exactly as a bare date
 * is, and it must be read off the string. It used to fall through to
 * `toZonedISO`, whose `new Date(text)` resolves an offset-less timestamp against
 * whatever zone the HOST MACHINE is in. That is not the user's zone:
 * core/sweep.mjs:135-138 supports the two differing on purpose, because a laptop
 * set to UTC belonging to somebody in New York is an ordinary thing.
 *
 * Measured — one pure function, identical arguments, only the machine's TZ
 * varied: `dueDayKey('2026-08-12T01:00:00', 'America/New_York')` answered
 * 2026-08-12 under TZ=America/New_York and 2026-08-11 under TZ=UTC, Asia/Tokyo
 * and Pacific/Kiritimati. One day early is `Overdue by 1 day`, a `\Flagged` row,
 * +10 in `scoreInbound` (core/triage.mjs:434) and a model told that an
 * obligation is late when it is not. One day late — `2026-08-11T23:00:00` read
 * under Asia/Tokyo — reads "Due in 1 day" and drops out of today entirely.
 */
export function dueDayKey(raw, timezone) {
  const text = collapse(raw);
  const w = wallClock(text);
  if (!w) return null;
  if (w.dateOnly || w.offset === null) return dayKey(text);
  return dayKey(toZonedISO(text, timezone || undefined) || text);
}

/** The due value Todoist offered, preferring the one that carries a time. */
export function dueValueOf(task) {
  const due = task?.due;
  if (!due || typeof due !== 'object') return '';
  /* `datetime` first: a task with a time on it has BOTH, and `date` is then the
     bare day, which would throw away the evening deadline that makes it urgent. */
  return collapse(due.datetime) || collapse(due.date);
}

/** Positive is days overdue, 0 is due today, negative is days still to run. */
export function dueness(task, today, timezone) {
  const key = dueDayKey(dueValueOf(task), timezone);
  if (!key) return { key: null, overdueDays: null };
  const days = daysBetweenKeys(key, today);
  return { key, overdueDays: days === null ? null : days };
}

/** The sentence the board reads first. Overdue and due-today must not look alike. */
export function duePhrase({ key, overdueDays }) {
  if (key === null || overdueDays === null) return 'No due date';
  if (overdueDays > 0) return `Overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'} — was due ${key}`;
  if (overdueDays === 0) return `Due today, ${key}`;
  const ahead = -overdueDays;
  return `Due in ${ahead} day${ahead === 1 ? '' : 's'}, ${key}`;
}

/**
 * Most overdue first.
 *
 * The same reasoning as linear.mjs: core/sweep.mjs:717 truncates with
 * `kept.slice(0, maxRows)` and the trim below does the same, so emission order
 * decides which obligations survive a cap. Todoist returns tasks in its own
 * order — roughly project then day order — and keeping it would let a cap of 50
 * drop a task three weeks late in favour of one due at five o'clock.
 */
function byUrgency(a, b) {
  const ax = a.overdueDays === null ? -Infinity : a.overdueDays;
  const bx = b.overdueDays === null ? -Infinity : b.overdueDays;
  if (ax !== bx) return bx - ax;
  // Then by the API's priority, which really is highest-first at 4. A tie after
  // that falls back to the id so the board does not reshuffle between sweeps.
  const ap = Number(a.task?.priority) || 0;
  const bp = Number(b.task?.priority) || 0;
  if (ap !== bp) return bp - ap;
  return str(a.task?.id).localeCompare(str(b.task?.id));
}

/**
 * A refusal the vendor put in the BODY, turned back into the class sweep reacts to.
 *
 * This is linear.mjs's `graphqlError` applied to Todoist's own error shape, and
 * it is here because the header says this file inherits linear's note 2 — which
 * it did not, in code. Todoist documents 4xx for these, and
 * core/connectors/http.mjs already promotes a 401/403 to `AuthError`; this is
 * the belt for the case where a refusal arrives inside a 200 or inside a status
 * the transport passes through. Without it every non-task body produced one
 * sentence — "the endpoint or its version has changed" — as a plain `Error`, so
 * a dead token sent the reader hunting for an API change AND never reached
 * core/sweep.mjs:740's AuthError arm, which means it was retried every sweep
 * forever instead of resting for AUTH_BLOCK_MS.
 *
 * Returns null for a body that states no error, so a healthy answer is never
 * rewritten into a failure.
 */
export function todoistError(body, describe) {
  const list = Array.isArray(body?.errors) ? body.errors : [];
  const fromList = list
    .map((e) => collapse(typeof e === 'string' ? e : (e?.message ?? e?.error)))
    .filter(Boolean)
    .join('; ');
  /* `{"error": "...", "error_code": 15, "error_tag": "..."}` is Todoist's own
     in-band shape; the array is what a gateway in front of it tends to send. */
  const text = (fromList || collapse(body?.error ?? body?.error_message)).slice(0, ERROR_CHARS);
  if (!text) return null;

  const code = [
    str(body?.error_tag),
    ...list.map((e) => str(e?.extensions?.code)),
  ].join(' ').toUpperCase();

  if (/AUTH|UNAUTHENTICATED|FORBIDDEN|TOKEN/.test(code) || /invalid (api )?token|authenticat|unauthoriz/i.test(text)) {
    return new AuthError(
      `${describe} rejected the API token: ${text}. Check it in Settings — Zelos will not keep trying with the one it has.`,
    );
  }
  if (/RATE.?LIMIT|TOO_MANY/.test(code) || /rate limit|too many requests/i.test(text)) {
    /* No `Retry-After` to read — this arrived in a body, so the transport's
       header path never ran, and the declared window is the only number there
       is. It is also the right one: the next sweep is a better retry than a
       sleep inside this one. */
    return new RateLimitError(`${describe} is rate limiting this source: ${text}`, { retryAfterMs: BUDGET_MS });
  }
  /* Quoting the vendor here is safe in a way quoting a non-JSON body is not:
     this text came out of a JSON `error` field, so it is the vendor's own
     sentence about the request, not a captive portal's HTML. It is what tells a
     user their filter does not parse. */
  return new Error(`${describe} refused the request: ${text}`);
}

/** -> {tasks, nextCursor}. Accepts both shapes this endpoint has answered with. */
export function readPage(text, describe) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    /* Deliberately does not quote what came back: this message reaches
       `sources[].error`, /api/state and the settings export, and a non-JSON
       answer is a captive portal's sign-in page or a proxy's error page. */
    throw new Error(`${describe} answered with something that is not JSON — a proxy or a sign-in page is probably answering for it`);
  }
  /* A bare array is what the older REST endpoint answered with and `results` is
     what the versioned one answers with. Accepting both is not defensive
     clutter: the path this connector reads has `/api/v1/` in it, so the shape is
     explicitly versioned, and a reader that only knows one of them turns a
     working credential into "Todoist returned nothing" with no way to tell the
     difference from an empty list. */
  const tasks = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null;
  if (tasks === null) {
    /* Ask the body why before guessing. This only runs when there is no task
       list, so a healthy answer never reaches it. */
    const stated = todoistError(body, describe);
    if (stated) throw stated;
    throw new Error(`${describe} answered with JSON that holds no task list — the endpoint or its version has changed`);
  }
  return { tasks, nextCursor: Array.isArray(body) ? '' : collapse(body?.next_cursor) };
}

function rowFor(entry, { now, identityEmail }) {
  const task = entry.task;
  const id = str(task?.id);
  const title = collapse(task?.content) || '(untitled task)';
  const priority = priorityLabel(task?.priority);
  const url = collapse(task?.url);
  const labels = (Array.isArray(task?.labels) ? task.labels : []).map(collapse).filter(Boolean);
  const recurring = task?.due?.is_recurring === true;
  /* Todoist's own phrasing of the due date — "every day", "tomorrow at 9am" — is
     the only place a recurrence rule is legible at all, and it is what the user
     typed. Kept beside the computed day key rather than instead of it: the key
     is what the model copies into `dueAt`, the phrase is what makes "every
     Friday" visible. */
  const spoken = collapse(task?.due?.string);

  /* The one line that has to carry the weight — `renderMessage`
     (core/triage.mjs:540) prints the snippet under every message it shows the
     model, so this is what survives a run trimmed to headers and snippets. */
  const line = [
    duePhrase(entry),
    recurring && spoken ? `repeats ${spoken}` : '',
    priority,
  ].filter(Boolean).join(' · ');

  const description = collapse(task?.description).slice(0, BODY_CHARS);
  const body = [
    line,
    description ? `\n\n${description}` : '',
    '\n\nA task on your own Todoist list',
    labels.length ? ` · ${labels.join(', ')}` : '',
    url ? `\n${url}` : '',
  ].join('');

  return {
    /* Namespaced so it can never collide with a Message-ID from a real mailbox,
       and built on the id because a recurring task keeps its id across
       occurrences — see note 3 at the top. NO `uid` key: see linear.mjs. */
    messageId: `todoist:task:${id}`,
    /* Todoist has no readable identifier to group on the way Linear has
       `ENG-412`, so the thread key is the message id. One task, one thread. */
    threadKey: `todoist:task:${id}`,
    /* The tasks endpoint names a project by id and never by word, and turning
       one into the other is a second endpoint, a second rate-limit line and a
       second way for this read to fail — for a field nothing on the board reads
       except the MCP listing (core/mcp.mjs:473). The source's own label is what
       a person sees; this stays the vendor. */
    folder: 'Todoist',
    direction: 'in',
    from: { name: 'Todoist', email: '' },
    /* The list is the user's own — that is the premise of reading it with the
       user's own token — and saying so earns `scoreInbound`'s "addressed to you"
       credit (core/triage.mjs:437) rather than leaving a personal to-do looking
       like a broadcast. The address is `identity.email`, the one the user
       declared as theirs, because Todoist's task payload names no account and a
       second call to learn one would be a second endpoint and a second failure
       for a field that only has to say "you". Empty when they never filled it
       in; an invented address would be worse than none. */
    to: identityEmail ? [{ name: '', email: identityEmail }] : [],
    cc: [],
    subject: title,
    date: now,
    snippet: line.slice(0, SNIPPET_CHARS),
    text: body.trim(),
    hasAttachments: false,
    /* The bluntest of the three ways an overdue task outweighs a due-today one:
       `\Flagged` is +10 in `scoreInbound` (core/triage.mjs:434) and prints as
       `[flagged]` in the header the model reads, so the overdue rows are the
       last to be dropped when the context budget bites. Nothing sets `\Seen` —
       an open task is unhandled, which is what the mark means. */
    flags: entry.overdueDays !== null && entry.overdueDays > 0 ? ['\\Flagged'] : [],
  };
}

export default {
  type: 'todoist',
  family: 'todoist',
  label: 'Todoist',
  option: 'Todoist tasks due today or overdue',
  configKey: 'sources',
  sink: 'messages',

  credential: {
    label: 'API token',
    help: 'Your own API token, from Todoist → Settings → Integrations → Developer. Zelos ships no Todoist app and no client secret, so there is nothing to authorise and no callback.',
    url: 'https://app.todoist.com/app/settings/integrations/developer',
    required: true,
    /* A plain bearer token, which is the default `send` shape — no `name` and no
       `prefix`, so core/connectors/http.mjs:231 sends `Authorization: Bearer …`.
       The contrast with linear.mjs is the point of reading the two together:
       Linear needs `prefix: ''` because the prefixed form is the OAuth one, and
       Todoist needs the prefix because it only accepts that form. Copying one
       manifest onto the other breaks both. */
    send: { as: 'header' },
  },

  origins: [ORIGIN],

  fields: [
    {
      name: 'filter',
      type: 'text',
      label: 'Todoist filter',
      default: DEFAULT_FILTER,
      hint: 'Todoist’s own filter syntax. The default is everything late plus everything due today. If you share projects, "(overdue | today) & assigned to: me" keeps other people’s tasks off your board.',
    },
    {
      name: 'maxItems',
      type: 'int',
      label: 'Tasks to keep',
      default: DEFAULT_KEEP,
      min: 1,
      max: MAX_ROWS,
      hint: 'The most overdue are kept first, so lowering this drops what is least urgent.',
    },
  ],

  limits: {
    /* Two sweeps a minute apart is a mistake, not a workflow, and the rows are
       in the database either way. */
    minIntervalMs: 60_000,
    minGapMs: 250,
    /* Deliberately far under whatever Todoist's published ceiling is, and it is
       written as Zelos's own restraint rather than as a claim about the vendor:
       a sweep needs three calls at the very most, so the budget's only real job
       is to stop a paging loop that has gone wrong. Guessing high at somebody
       else's limit is how a connector discovers it by being throttled. */
    budget: { calls: 60, perMs: BUDGET_MS },
    maxRows: MAX_ROWS,
  },

  async collect(ctx) {
    const settings = ctx.source?.settings && typeof ctx.source.settings === 'object' ? ctx.source.settings : {};
    const filter = collapse(settings.filter) || DEFAULT_FILTER;
    const keep = clampInt(settings.maxItems, DEFAULT_KEEP, 1, MAX_ROWS);
    const timezone = str(ctx.timezone);
    /* The user's day, from the user's zone. `ctx.now` is already zoned
       (core/sweep.mjs:533 calls `nowISO(tz)`) so its own day key is the answer. */
    const today = dayKey(str(ctx.now)) || todayKey(timezone || undefined);

    /* KEYED BY TASK ID, NOT PUSHED INTO A LIST. The failure MAX_PAGES exists to
       bound is a cursor that stops advancing — and a cursor that stops advancing
       hands back the SAME page again. Concatenating it spends the user's "Tasks
       to keep" on copies: measured against a server holding 30 distinct tasks
       behind a non-advancing cursor, the connector emitted 50 rows carrying 17
       distinct ids, `upsertMessages` collapsed them to 17 stored rows, and 13
       real obligations never reached the board while the note claimed 40 "least
       urgent" had been dropped. MAX_PAGES bounds the request count; only this
       bounds the row set, which is where the damage lands. First occurrence
       wins — a repeated page is the same task, not a newer one. */
    const byId = new Map();
    /* Counted and dropped, never given a row. A task with no id would get
       `messageId: 'todoist:task:'` — the id EVERY id-less task gets — so they
       all hash to one `messageRowId` and overwrite each other: three rows handed
       to `upsertMessages`, two rows in the database, one obligation gone with no
       error and a count of 3 reported to the board. fireflies.mjs already
       settled this ("a transcript with no id is dropped rather than given a
       colliding row id"); silently losing one is worse than saying so. */
    let unidentified = 0;
    /* Did the walk end with a cursor still in hand? That is a different loss
       from the keep-cap's and it must not be reported as the same one. */
    let truncated = false;
    /* The vendor's sentence, when a later page failed and earlier pages did not. */
    let cutShort = null;
    let pagesRead = 0;
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (ctx.signal?.aborted === true) {
        truncated = pagesRead > 0 && Boolean(cursor);
        break;
      }
      /* The filter is the only thing in the query string and the credential is
         in a header, which is the rule core/connectors/index.mjs:138 states and
         core/connectors/http.mjs enforces by having no `as: 'query'` at all: a
         token in a URL lands in the vendor's access log, in every proxy's, and
         in ours. A filter in one is a filter the user wrote and can see.

         `query`, not `filter` — see note 4. */
      const url = new URL(ENDPOINT);
      url.searchParams.set(QUERY_PARAM, filter);
      url.searchParams.set('limit', String(PAGE));
      if (cursor) url.searchParams.set('cursor', cursor);

      let read;
      try {
        const res = await ctx.http.get(url.href, { accept: 'application/json' });
        read = readPage(res.text, new URL(res.url || ENDPOINT).host);
      } catch (err) {
        /* PAGES ALREADY READ ARE NOT THROWN AWAY. A throw from page two used to
           discard page one as well, so a two-page sweep stored zero rows
           including the page that arrived intact — and the user was told a
           budget was spent rather than that some of their tasks were missing.
           (The transport defect that made that the NORMAL case, a missing
           `x-ratelimit-remaining` read as zero remaining, is fixed in
           core/connectors/http.mjs. This is the connector's half: a lost page
           must not cost the rows already in hand.)

           Two failures still propagate. Nothing in hand means there is nothing
           to salvage and the sweep needs the real reason. And an `AuthError`
           propagates even with rows in hand, because it is the one error whose
           CLASS is load-bearing: core/sweep.mjs keys a six-hour rest on it, and
           a revoked token downgraded to "some tasks are missing" would be
           retried every sweep forever while the board quietly stopped
           updating — worse than losing one page. */
        if (pagesRead === 0 || err instanceof AuthError) throw err;
        cutShort = collapse(err?.message).slice(0, ERROR_CHARS);
        truncated = true;
        break;
      }
      pagesRead += 1;
      for (const task of read.tasks) {
        if (!task || typeof task !== 'object') continue;
        const id = str(task.id);
        if (!id) { unidentified += 1; continue; }
        if (!byId.has(id)) byId.set(id, task);
      }
      if (!read.nextCursor) break;
      cursor = read.nextCursor;
      /* Out of pages with the vendor still offering more. */
      if (page === MAX_PAGES - 1) truncated = true;
    }

    const ranked = [...byId.values()]
      /* A completed task should never be in a "today or overdue" answer, but the
         field exists in the payload under two names across versions and a
         checked task on the board is a promise the product broke. Cheap. */
      .filter((task) => task.is_completed !== true && task.checked !== true)
      .map((task) => ({ task, ...dueness(task, today, timezone) }))
      .sort(byUrgency);

    const kept = ranked.slice(0, keep);
    const rows = kept.map((entry) => rowFor(entry, {
      now: str(ctx.now),
      identityEmail: collapse(ctx.identityEmail).toLowerCase(),
    }));

    const overdue = kept.filter((e) => e.overdueDays !== null && e.overdueDays > 0).length;
    const dueToday = kept.filter((e) => e.overdueDays === 0).length;
    ctx.emit(`${ctx.label}: ${overdue} overdue, ${dueToday} due today`, rows.length, rows.length);

    /* Reported rather than swallowed, for the reason spelled out in linear.mjs:
       the sweep renders a note as `ok: false` with the sentence in `error`, and
       obligations quietly dropped are the failure this product exists to
       prevent. THREE losses are possible and they are said separately, because
       only ONE of them is ordered. What the keep-cap drops really is the least
       urgent — `ranked` is sorted before it is sliced. What a stopped page walk
       drops was never fetched at all, and Todoist returns tasks in ITS order
       (see `byUrgency`), so the most overdue task in the account may be among
       the ones never seen. Folding the second into the first is the note telling
       the user something false about their own list. */
    const shown = shortFilter(filter);
    const notes = [];
    const dropped = ranked.length - kept.length;
    if (dropped > 0) {
      notes.push(`Todoist returned ${ranked.length} tasks for "${shown}" and this source keeps ${keep} — the ${dropped} least urgent were dropped. Raise "Tasks to keep" in Settings if that is too few.`);
    }
    if (truncated) {
      notes.push(cutShort
        ? `Todoist stopped answering part-way through "${shown}" (${cutShort}), so this is only what had already been read. The tasks that are missing are not necessarily the least urgent.`
        : `"${shown}" matches more than the ${MAX_PAGES * PAGE} tasks this source reads in one sweep, so the rest were never fetched. They are not necessarily the least urgent — narrow the filter in Settings.`);
    }
    if (unidentified > 0) {
      notes.push(`${unidentified} task${unidentified === 1 ? '' : 's'} arrived with no id and ${unidentified === 1 ? 'was' : 'were'} dropped — a task with no id cannot be stored without overwriting another one.`);
    }
    const note = notes.length ? notes.join(' ') : null;

    /* NO `cursor` KEY. The Todoist cursor paginates ONE answer and is spent when
       the answer ends; it is not a sync token and holding it across sweeps would
       ask for page two of a list that no longer exists. And even a real sync
       token would be wrong here for the reason linear.mjs gives: what changes
       about these rows between sweeps is that the clock moved. */
    return { parts: [{ label: '', rows, error: null, note }] };
  },

  /**
   * What `zelos doctor` asks Todoist.
   *
   * It runs THE USER'S OWN FILTER, one page of it, rather than a cheap "is this
   * token valid" call. A filter with a typo in it is the most likely thing to be
   * wrong with this source and a token probe cannot see it — Todoist answers a
   * nonsense filter with an error, and this is the command a stuck person runs.
   *
   * The failure is returned rather than thrown: core/doctor.mjs:945 would catch
   * a throw and describe it as a fault inside Zelos, which sends the reader to
   * the wrong place when the answer is "your filter does not parse".
   */
  async check(source, ctx) {
    const settings = source?.settings && typeof source.settings === 'object' ? source.settings : {};
    const filter = collapse(settings.filter) || DEFAULT_FILTER;
    const shown = shortFilter(filter);
    /* THE USER'S ZONE WHEN DOCTOR HAS ONE TO GIVE. `todayKey()` and a `''`
       timezone both fall back to the machine's zone, so the overdue count in
       the pass line was measured somewhere the user does not live — the same
       one-day error `dueDayKey` above exists to prevent, printed in the one
       command a stuck person runs. It is read defensively because
       `checkContext` (core/doctor.mjs:846) does not thread `identity.timezone`
       through yet; when it does, this needs no further edit. Both halves take
       the same zone either way, so the comparison is at least self-consistent. */
    const timezone = str(ctx?.timezone);
    const today = todayKey(timezone || undefined);
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set(QUERY_PARAM, filter);
      url.searchParams.set('limit', String(PAGE));
      const res = await ctx.http.get(url.href, { accept: 'application/json' });
      const { tasks } = readPage(res.text, new URL(res.url || ENDPOINT).host);
      const overdue = tasks.filter((t) => {
        const d = dueness(t, today, timezone);
        return d.overdueDays !== null && d.overdueDays > 0;
      }).length;
      return {
        status: 'pass',
        detail: `"${shown}" matches ${tasks.length} task${tasks.length === 1 ? '' : 's'}${overdue ? `, ${overdue} of them overdue` : ''}`,
      };
    } catch (err) {
      /* THE FILTER IS NAMED IN THE FAILURE, because the docstring above says the
         filter is the whole reason this probe runs the user's own query — and
         the verdict used to be `Todoist: api.todoist.com returned 400` with the
         one fact the probe exists to surface withheld, under an action that led
         with the token. A refused credential is the exception and is the only
         case where the token really is the first thing to check; core/sweep.mjs
         and the transport both classify that one for us. */
      const status = Number(err?.status) || 0;
      const credentialRefused = err instanceof AuthError || status === 401 || status === 403;
      return {
        status: 'fail',
        detail: `Todoist refused "${shown}": ${collapse(err?.message) || 'the request failed'}`.slice(0, ERROR_CHARS),
        action: credentialRefused
          ? 'Check the API token in Settings → Sources — you mint one at Todoist → Settings → Integrations → Developer.'
          : `Check the Todoist filter in Settings → Sources: "${shown}" is what Todoist was asked for, and its filter grammar is what has to accept it. If the filter is right, check the API token — you mint one at Todoist → Settings → Integrations → Developer.`,
      };
    }
  },
};
