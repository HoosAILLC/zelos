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
 * are three things, each of which has already been a bug somewhere.
 *
 *  1. A DATE-ONLY DUE DATE MUST NOT BE CONVERTED THROUGH A TIMEZONE. Todoist
 *     returns `due.date` as a bare `YYYY-MM-DD` for a task with no time on it,
 *     and `due.datetime` as a real instant for one with a time. They need
 *     opposite treatment. Feeding the bare date to `new Date()` reads it as UTC
 *     midnight; re-expressing that in any zone west of Greenwich lands it on the
 *     day BEFORE — so every task due today would read as one day overdue, for
 *     every user in the Americas, all the time. The instant needs exactly the
 *     conversion the bare date must not get: `2026-08-12T02:00:00Z` is nine in
 *     the evening on the 11th in New York, and reading its day key straight off
 *     the string calls a task due tonight "due tomorrow" and drops it out of
 *     today. `dueDayKey` below is five lines and both halves are load-bearing.
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
 * The filter is the user's, with a default Zelos chooses. Todoist's filter
 * grammar is a real query language and it is theirs, not ours: shipping
 * `overdue | today` as the default and leaving the box editable means a person
 * with shared projects can write `(overdue | today) & assigned to: me` without
 * waiting for a release, and means this file never has to grow a second opinion
 * about what "mine" means in somebody else's workspace.
 */

import { dayKey, daysBetweenKeys, toZonedISO, todayKey, wallClock } from '../time.mjs';

const ORIGIN = 'https://api.todoist.com';
const ENDPOINT = `${ORIGIN}/api/v1/tasks`;

/** Todoist's page ceiling for this endpoint. */
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
 * has no instant to convert; a timestamp is an INSTANT and has no day until a
 * zone is named. Getting either backwards moves the answer by one day, which is
 * the entire difference between "due today" and "overdue" — the one distinction
 * this connector exists to make.
 */
export function dueDayKey(raw, timezone) {
  const text = collapse(raw);
  const w = wallClock(text);
  if (!w) return null;
  if (w.dateOnly) return dayKey(text);
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

    const tasks = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (ctx.signal?.aborted === true) break;
      /* The filter is the only thing in the query string and the credential is
         in a header, which is the rule core/connectors/index.mjs:138 states and
         core/connectors/http.mjs enforces by having no `as: 'query'` at all: a
         token in a URL lands in the vendor's access log, in every proxy's, and
         in ours. A filter in one is a filter the user wrote and can see. */
      const url = new URL(ENDPOINT);
      url.searchParams.set('filter', filter);
      url.searchParams.set('limit', String(PAGE));
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await ctx.http.get(url.href, { accept: 'application/json' });
      const page1 = readPage(res.text, new URL(res.url || ENDPOINT).host);
      tasks.push(...page1.tasks);
      if (!page1.nextCursor) break;
      cursor = page1.nextCursor;
    }

    const ranked = tasks
      .filter((task) => task && typeof task === 'object')
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
       prevent. */
    const dropped = ranked.length - kept.length;
    const note = dropped > 0
      ? `Todoist returned ${ranked.length} tasks for "${filter}" and this source keeps ${keep} — the ${dropped} least urgent were dropped. Raise "Tasks to keep" in Settings if that is too few.`
      : null;

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
    const today = todayKey();
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set('filter', filter);
      url.searchParams.set('limit', String(PAGE));
      const res = await ctx.http.get(url.href, { accept: 'application/json' });
      const { tasks } = readPage(res.text, new URL(res.url || ENDPOINT).host);
      const overdue = tasks.filter((t) => {
        const d = dueness(t, today, '');
        return d.overdueDays !== null && d.overdueDays > 0;
      }).length;
      return {
        status: 'pass',
        detail: `"${filter}" matches ${tasks.length} task${tasks.length === 1 ? '' : 's'}${overdue ? `, ${overdue} of them overdue` : ''}`,
      };
    } catch (err) {
      return {
        status: 'fail',
        detail: `Todoist: ${collapse(err?.message) || 'the request failed'}`.slice(0, ERROR_CHARS),
        action: 'Check the API token in Settings → Sources — you mint one at Todoist → Settings → Integrations → Developer. If the token is right, the filter is what Todoist refused.',
      };
    }
  },
};
