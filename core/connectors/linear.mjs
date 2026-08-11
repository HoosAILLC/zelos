/**
 * core/connectors/linear.mjs — the Linear issues assigned to you that are due.
 *
 * A task system is not a mailbox and it is not a calendar, and the choice this
 * file makes first is that it is closer to a mailbox: an assigned issue with a
 * due date is an OBLIGATION, something that arrived at you and is waiting, which
 * is what `sink: 'messages'` means on this board. An event is a thing that
 * happens whether you attend or not. core/connectors/rss.mjs:22 already made the
 * same call for an article — "the record types are named for how the board reads
 * a thing, not for the vendor's noun" — and a due issue reads as mail, not as a
 * meeting.
 *
 * FOUR THINGS IN HERE ARE NOT OBVIOUS AND EVERY ONE OF THEM HAS A TEST.
 *
 *  1. `Authorization: <key>` WITH NO `Bearer `. That is not a style choice and
 *     it is not optional: the prefixed form is what an OAuth access token uses,
 *     and Linear rejects a personal API key sent that way. `credential.send`
 *     therefore carries `prefix: ''`, and core/connectors/http.mjs:231 reads
 *     `send.prefix ?? 'Bearer '` — so DELETING the empty string is not a tidy-up,
 *     it silently re-adds the prefix and every read starts failing with a 401
 *     that looks like a bad key. The empty string is load-bearing.
 *
 *  2. A 200 CARRYING AN `errors` ARRAY IS A FAILURE. GraphQL answers "OK" and
 *     then explains, inside the body, that it did nothing — so
 *     core/connectors/http.mjs's status checks never see it. Worse, Linear
 *     reports a refused key that way at least some of the time, and a refused
 *     key that arrives as a plain `Error` never reaches the `AuthError` arm in
 *     core/sweep.mjs:740, so the sweep retries a dead credential every half hour
 *     forever. `graphqlError` below is what turns the body's own words back into
 *     the two failures the run loop reacts to.
 *
 *  3. `date` IS THE MOMENT OF THE READ, NOT THE DUE DATE. This looks wrong and
 *     is the most carefully chosen line in the file. `gatherPromptInput`
 *     (core/sweep.mjs:1104) hands the model `listMessages(db, {sinceISO})` with
 *     sinceISO 21 days back, and core/db.mjs:441 filters on `sent_at >= ?`. Put
 *     the due date in `date` and an issue six weeks overdue — the single most
 *     urgent row this connector can produce — is the one row the model never
 *     sees. `updatedAt` has the same cliff and is worse, because the tasks
 *     nobody has touched are exactly the dropped ones. An obligation has no
 *     "sent" instant anyway: the true statement is "as of this sweep, this is
 *     still outstanding", and that is what goes in the field. Omitting `date`
 *     entirely is not an option either — `sent_at` would be NULL and `NULL >= ?`
 *     is NULL, so the row is dropped from the prompt just as silently.
 *     The due date appears exactly once per row, in words, in the snippet.
 *
 *  4. IDENTITY COMES FROM THE UUID, GROUPING FROM THE HUMAN IDENTIFIER. `ENG-412`
 *     is what a person says out loud and it is not stable: move an issue to
 *     another team and Linear renumbers it to `OPS-88`. `messageRowId` is the
 *     primary key (core/db.mjs:385), so identity built on `identifier` would
 *     re-insert an issue as brand new the day somebody drags it between teams.
 *     `id` is a UUID and never moves, so `messageId` is built from it and the
 *     readable identifier is used for `threadKey` and for the subject, where a
 *     re-grouping costs nothing.
 *
 * And the rule that outranks all four: THERE IS NO `uid` KEY BELOW AND THERE
 * MUST NEVER BE ONE. core/db.mjs:384 turns `uid: null` into 0 and an OMITTED uid
 * into null, which hash to different row ids — so a release that starts writing
 * `uid: null` re-inserts every issue this connector has ever seen, on every
 * sweep, forever. An issue has no integer identity. See rss.mjs:15-21.
 */

import { AuthError, RateLimitError } from './http.mjs';
import { addDaysToKey, dayKey, daysBetweenKeys, todayKey } from '../time.mjs';

/** Linear has one address and it is not configurable. There is no self-hosted Linear. */
const ORIGIN = 'https://api.linear.app';
const ENDPOINT = `${ORIGIN}/graphql`;

/** The window the declared budget is spent over, and the floor on a stated 429. */
const BUDGET_MS = 60 * 60 * 1000;

/** Issues per request. Linear allows more; 100 is one page of a real backlog. */
const PAGE = 100;

/**
 * The paging loop's stop, and the reason the declared budget is not it.
 *
 * 5,000 requests an hour is the vendor's ceiling and it is the honest number to
 * declare, but a budget that large would let a loop with a stuck cursor make
 * five thousand calls before anything noticed. Four pages is 400 issues that are
 * already narrowed to "assigned to me, not done, due inside the horizon", which
 * is more than a person has; past that the answer is not a board, it is a
 * backlog export.
 */
const MAX_PAGES = 4;

/** The hard ceiling, whatever the user asked to keep. */
const MAX_ROWS = 200;

const DEFAULT_KEEP = 50;
const DEFAULT_HORIZON_DAYS = 7;

const SNIPPET_CHARS = 240;
const BODY_CHARS = 4_000;

/** A stranger's error text goes into `runs.error` and into /api/state. Bound it. */
const ERROR_CHARS = 300;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const collapse = (s) => str(s).replace(/\s+/g, ' ').trim();

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.round(n), max));
}

/**
 * The query. Exported because the test asserts against this exact text rather
 * than against a copy of it — a filter that drifts out of the query and stays in
 * the test is a connector that reads the wrong issues and passes.
 *
 * `assignedIssues` on `viewer` rather than a top-level `issues(filter: {assignee:
 * {isMe: …}})`: same rows, one fewer filter clause to get backwards, and the
 * name says what the connector is for.
 *
 * `dueDate: { lte: $dueBy }` does two jobs. It scopes the read to what is
 * actually due — an issue with no due date at all does not satisfy `lte` and
 * drops out, which is what "with due dates" means — and it stands in for a sort
 * Linear does not offer. `orderBy` accepts `createdAt` and `updatedAt` and
 * nothing else, so there is no way to ask the server for "most overdue first";
 * the ranking below is done locally, and this filter is what guarantees the
 * pages held in memory are the pages that matter.
 *
 * The state filter names the two workflow types that mean finished. Linear's
 * others are `triage`, `backlog`, `unstarted` and `started`, and every one of
 * them is work you still owe.
 */
export const ISSUES_QUERY = `query ZelosAssignedIssues($after: String, $dueBy: TimelessDate!) {
  viewer {
    name
    email
    assignedIssues(
      first: ${PAGE}
      after: $after
      filter: {
        state: { type: { nin: ["completed", "canceled"] } }
        dueDate: { lte: $dueBy }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        description
        url
        dueDate
        priorityLabel
        state { name type }
        team { name }
        creator { name email }
      }
    }
  }
}`;

/**
 * Turn a GraphQL `errors` array into the failure the run loop can act on.
 *
 * Exported for the test, which drives each arm against a loopback server that
 * answers 200 with a body — the only way to prove this at all, because a 401 on
 * the wire never reaches here: core/connectors/http.mjs:316 raises its own
 * AuthError before the body is read.
 *
 * The code is preferred over the prose and the prose is the fallback, because
 * `extensions.code` is a contract and a message is a sentence somebody may
 * reword. Both are matched loosely on purpose: getting this wrong in the safe
 * direction costs one extra sweep, and getting it wrong in the other direction
 * is a dead key retried twice an hour until the user notices by hand.
 */
export function graphqlError(errors) {
  const list = Array.isArray(errors) ? errors : [];
  const text = list
    .map((e) => collapse(e?.message))
    .filter(Boolean)
    .join('; ')
    .slice(0, ERROR_CHARS) || 'Linear refused the query and said nothing about why';
  const code = list.map((e) => str(e?.extensions?.code).toUpperCase()).join(' ');

  if (/AUTHENTICATION|UNAUTHENTICATED|FORBIDDEN|AUTHORIZATION/.test(code) || /authenticat|invalid api key/i.test(text)) {
    return new AuthError(
      `Linear rejected the API key: ${text}. Check it in Settings — Zelos will not keep trying with the one it has.`,
    );
  }
  if (/RATELIMIT|RATE_LIMIT|TOO_MANY/.test(code) || /rate limit/i.test(text)) {
    /* No `Retry-After` exists to read: this arrived inside a 200 body, so
       core/connectors/http.mjs's header path never ran. The declared window is
       the only number available and it is the right one — the next sweep is half
       an hour away and is a better retry than a guess measured in seconds. */
    return new RateLimitError(`Linear is rate limiting this source: ${text}`, { retryAfterMs: BUDGET_MS });
  }
  return new Error(`Linear returned an error: ${text}`);
}

/** One GraphQL round trip, with the 200-that-failed handled. */
async function query(http, variables) {
  const res = await http.postJson(ENDPOINT, { query: ISSUES_QUERY, variables });
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    /* Deliberately does not quote what came back. This message reaches
       `sources[].error`, /api/state and the settings export, and the body of a
       non-JSON answer is a captive portal's login page or a proxy's error page —
       neither of which is the user's to read here. */
    throw new Error(`${new URL(res.url || ENDPOINT).host} answered with something that is not JSON — a proxy or a sign-in page is probably answering for it`);
  }
  if (Array.isArray(body?.errors) && body.errors.length) throw graphqlError(body.errors);
  return body?.data ?? null;
}

/**
 * How this issue sits against today: positive is days overdue, 0 is due today,
 * negative is days still to run.
 *
 * `dueDate` is Linear's `TimelessDate` scalar — a bare `YYYY-MM-DD` with no time
 * and no zone — so it is compared as a day key and never converted through a
 * Date. Feeding a bare date to `new Date()` reads it as UTC midnight, and
 * re-expressing that in any zone west of Greenwich lands it on the day BEFORE,
 * which would report every issue due today as one day overdue for every user in
 * the Americas. core/time.mjs:4-9 is the whole rule; this is one more place it
 * applies.
 */
export function dueness(dueDate, today) {
  const key = dayKey(str(dueDate));
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
 * Most overdue first, then due today, then whatever is still ahead.
 *
 * This ordering is not cosmetic and it is not for the reader: core/sweep.mjs:717
 * truncates with `kept.slice(0, maxRows)`, and this connector trims to the
 * user's own `maxItems` the same way. Whatever order the rows are emitted in is
 * the order in which they survive, so emitting Linear's order — which is
 * whatever `assignedIssues` felt like — would mean a cap of 50 drops the fifty
 * most urgent as readily as the fifty least.
 */
function byUrgency(a, b) {
  const ax = a.overdueDays === null ? -Infinity : a.overdueDays;
  const bx = b.overdueDays === null ? -Infinity : b.overdueDays;
  if (ax !== bx) return bx - ax;
  // A tie is two issues due the same day; the readable identifier keeps the
  // order stable between sweeps so the board does not reshuffle for no reason.
  return str(a.issue?.identifier).localeCompare(str(b.issue?.identifier));
}

function rowFor(entry, viewer, now) {
  const issue = entry.issue;
  const identifier = collapse(issue?.identifier);
  const title = collapse(issue?.title) || identifier || '(untitled issue)';
  const state = collapse(issue?.state?.name) || collapse(issue?.state?.type);
  const team = collapse(issue?.team?.name);
  const priority = collapse(issue?.priorityLabel);
  const url = collapse(issue?.url);

  /* The one line that has to carry the weight. `renderMessage`
     (core/triage.mjs:540) prints the snippet under every message it shows the
     model, so this is what separates "was due nine days ago" from "due today"
     even on a run trimmed down to headers and snippets. The day key is in it
     verbatim because SWEEP_JSON_SHAPE asks the model for `dueAt` as ISO — it has
     to be able to copy something. */
  const line = [duePhrase(entry), state, identifier].filter(Boolean).join(' · ');

  const description = collapse(issue?.description).slice(0, BODY_CHARS);
  const body = [
    line,
    description ? `\n\n${description}` : '',
    `\n\nAssigned to you in Linear${team ? ` · ${team}` : ''}`,
    priority && priority !== 'No priority' ? ` · priority ${priority}` : '',
    url ? `\n${url}` : '',
  ].join('');

  return {
    /* Identity from the UUID; see note 4 at the top. Namespaced so it can never
       collide with a Message-ID from a real mailbox. */
    messageId: `linear:issue:${str(issue?.id)}`,
    /* Grouping from the readable identifier, which is what the model is told to
       build an item `key` from — `thread=linear-eng-412` reads as the thing;
       `thread=linear:issue:8f2c…` reads as nothing. A team move re-groups the
       row and costs nothing, where it would have re-inserted it. */
    threadKey: identifier ? `linear:${identifier.toLowerCase()}` : `linear:issue:${str(issue?.id)}`,
    folder: team || 'Linear',
    direction: 'in',
    /* Whoever filed it. A real address here is worth having: the model is asked
       for `person` and `personEmail`, and "Answer Priya on ENG-412" needs one. */
    from: {
      name: collapse(issue?.creator?.name) || team || 'Linear',
      email: collapse(issue?.creator?.email),
    },
    /* The assignee is the user, which is the whole premise of the query, and
       saying so earns the row `scoreInbound`'s "addressed to you" credit
       (core/triage.mjs:437) instead of leaving it looking like a broadcast.
       Linear's own address for the account is used rather than
       `identity.email` — if the two differ that is a fact about the user's
       setup, not something to paper over. */
    to: viewer.email || viewer.name ? [{ name: viewer.name, email: viewer.email }] : [],
    cc: [],
    subject: identifier ? `${identifier} ${title}` : title,
    date: now,
    snippet: line.slice(0, SNIPPET_CHARS),
    text: body.trim(),
    hasAttachments: false,
    /* The third and bluntest way an overdue issue outweighs a due-today one.
       `\Flagged` is worth +10 in `scoreInbound` (core/triage.mjs:434) and prints
       as `[flagged]` in the header the model reads, so on a run whose context
       budget has to drop rows, the overdue ones are the last to go. Borrowing
       IMAP's vocabulary for a source that has never seen IMAP is the same move
       rss.mjs:22 makes: the flag describes how the board should read the row.
       Nothing sets `\Seen`, so an open issue reads as unhandled — which it is. */
    flags: entry.overdueDays !== null && entry.overdueDays > 0 ? ['\\Flagged'] : [],
  };
}

export default {
  type: 'linear',
  family: 'linear',
  label: 'Linear',
  option: 'Linear issues assigned to me',
  configKey: 'sources',
  /* Not `events`. An issue with a due date is something you owe, and the board
     puts what you owe in `now`/`today`/`soon` — never in the day's schedule. */
  sink: 'messages',

  /* Reading Linear is a POST, because Linear has no read API that is not one.
     `ctx.http.postJson` refuses to work without this line
     (core/connectors/http.mjs:361), which is what keeps "Zelos only ever GETs"
     from quietly becoming untrue in a file nobody re-reads. */
  graphql: true,

  credential: {
    label: 'API key',
    help: 'A personal API key, which you mint in your own Linear account. Zelos ships no Linear app and no client secret, so there is nothing to authorise and no callback.',
    url: 'https://linear.app/settings/api',
    required: true,
    /* THE `prefix: ''` IS THE POINT. See note 1 at the top of this file: with it
       gone, core/connectors/http.mjs sends `Authorization: Bearer lin_api_…`,
       which is the OAuth shape, and Linear refuses a personal key sent that way. */
    send: { as: 'header', name: 'authorization', prefix: '' },
  },

  /* One origin, declared rather than derived from a user field: unlike a feed,
     there is no address for the user to type, so nothing at run time can widen
     this. `originsFor` still adds any `type: 'url'` field a future edit declares
     — there are none, and there should not be. */
  origins: [ORIGIN],

  fields: [
    {
      name: 'horizonDays',
      type: 'int',
      label: 'Days ahead to look',
      default: DEFAULT_HORIZON_DAYS,
      min: 0,
      max: 365,
      hint: 'Overdue issues always come through. This is how far into the future a due date still counts — 7 is this week.',
    },
    {
      name: 'maxItems',
      type: 'int',
      label: 'Issues to keep',
      default: DEFAULT_KEEP,
      min: 1,
      max: MAX_ROWS,
      hint: 'The most overdue are kept first, so lowering this drops what is least urgent.',
    },
  ],

  limits: {
    /* Two sweeps a minute apart is a mistake, not a workflow, and the rows are
       already in the database either way — `gatherPromptInput` reads from there,
       not from the fetch. */
    minIntervalMs: 60_000,
    minGapMs: 250,
    /* The vendor's own published ceiling. It is declared because it is true, not
       because it bounds anything: MAX_PAGES is what stops a runaway paging loop,
       four calls to five thousand. */
    budget: { calls: 5_000, perMs: BUDGET_MS },
    maxRows: MAX_ROWS,
  },

  async collect(ctx) {
    const settings = ctx.source?.settings && typeof ctx.source.settings === 'object' ? ctx.source.settings : {};
    const horizon = clampInt(settings.horizonDays, DEFAULT_HORIZON_DAYS, 0, 365);
    const keep = clampInt(settings.maxItems, DEFAULT_KEEP, 1, MAX_ROWS);
    /* The user's day, from the user's zone. `ctx.now` is already zoned
       (core/sweep.mjs:533 calls `nowISO(tz)`), so its own day key is the right
       one and there is nothing further to convert. */
    const today = dayKey(str(ctx.now)) || todayKey(ctx.timezone);
    const dueBy = addDaysToKey(today, horizon);

    const issues = [];
    let viewer = { name: '', email: '' };
    let after = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (ctx.signal?.aborted === true) break;
      const data = await query(ctx.http, { after, dueBy });
      const me = data?.viewer;
      if (!me) {
        throw new Error('Linear answered without a viewer, so it does not know whose issues these are. That is what an API key with no read access looks like.');
      }
      viewer = { name: collapse(me.name), email: collapse(me.email) };
      const connection = me.assignedIssues ?? {};
      const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
      issues.push(...nodes);
      const info = connection.pageInfo ?? {};
      if (info.hasNextPage !== true || !collapse(info.endCursor)) break;
      after = collapse(info.endCursor);
    }

    const ranked = issues
      .filter((issue) => issue && typeof issue === 'object')
      .map((issue) => ({ issue, ...dueness(issue.dueDate, today) }))
      .sort(byUrgency);

    const kept = ranked.slice(0, keep);
    const rows = kept.map((entry) => rowFor(entry, viewer, str(ctx.now)));

    const overdue = kept.filter((e) => e.overdueDays !== null && e.overdueDays > 0).length;
    const dueToday = kept.filter((e) => e.overdueDays === 0).length;
    ctx.emit(`${ctx.label}: ${overdue} overdue, ${dueToday} due today`, rows.length, rows.length);

    /* A drop is reported, and it is reported as a `note` rather than swallowed.
       The sweep renders a note as `ok: false` with the sentence in `error`
       (core/sweep.mjs:712-726) — "neither a success nor a failure", which is
       exactly what "I read 90 obligations and kept the 50 most urgent" is. An
       RSS archive silently trimmed to 50 costs nothing; 40 silently dropped
       obligations is the failure this product exists to prevent. */
    const dropped = ranked.length - kept.length;
    const note = dropped > 0
      ? `Linear had ${ranked.length} issues assigned to you and due, and this source keeps ${keep} — the ${dropped} least urgent were dropped. Raise "Issues to keep" in Settings if that is too few.`
      : null;

    /* NO `cursor` KEY, and not an oversight. Linear can filter by `updatedAt`,
       so an incremental sync is available and would be wrong: what changes about
       these rows between sweeps is mostly that the CLOCK MOVED. An issue nobody
       has touched since March goes from "due in 3 days" to "overdue by 9" with
       no update event anywhere, and a modified-since cursor would freeze it at
       the weight it had when it was last edited. Returning `undefined` here
       leaves core/sweep.mjs:798 alone; returning `null` would clear a cursor
       that was never written. */
    return { parts: [{ label: '', rows, error: null, note }] };
  },

  /**
   * What `zelos doctor` asks Linear.
   *
   * It runs THE SAME QUERY the sweep runs, one page of it, rather than a cheap
   * `viewer { name }`. A `viewer` probe proves the key works and proves nothing
   * about the query, so a filter Linear has stopped accepting would pass doctor
   * and fail at 07:00 — and this is the command a stuck user runs. One request
   * against a 5,000-an-hour allowance is not worth optimising.
   *
   * Failures are caught and returned rather than thrown: core/doctor.mjs:945
   * would catch a throw and describe it as a fault inside Zelos, which sends the
   * reader to the wrong place when the real answer is "your key was refused".
   */
  async check(source, ctx) {
    const settings = source?.settings && typeof source.settings === 'object' ? source.settings : {};
    const horizon = clampInt(settings.horizonDays, DEFAULT_HORIZON_DAYS, 0, 365);
    const today = todayKey();
    try {
      const data = await query(ctx.http, { after: null, dueBy: addDaysToKey(today, horizon) });
      const me = data?.viewer;
      if (!me) {
        return {
          status: 'fail',
          detail: 'Linear answered without a viewer, so the key does not identify an account.',
          action: 'Mint a personal API key at https://linear.app/settings/api and paste it in Settings → Sources.',
        };
      }
      const nodes = Array.isArray(me.assignedIssues?.nodes) ? me.assignedIssues.nodes : [];
      const overdue = nodes.filter((n) => {
        const d = dueness(n?.dueDate, today);
        return d.overdueDays !== null && d.overdueDays > 0;
      }).length;
      const who = collapse(me.name) || collapse(me.email) || 'this account';
      return {
        status: 'pass',
        detail: `Signed in as ${who} · ${nodes.length} issue${nodes.length === 1 ? '' : 's'} assigned and due within ${horizon} day${horizon === 1 ? '' : 's'}${overdue ? `, ${overdue} of them overdue` : ''}`,
      };
    } catch (err) {
      return {
        status: 'fail',
        detail: `Linear: ${collapse(err?.message) || 'the request failed'}`.slice(0, ERROR_CHARS),
        action: 'Check the API key in Settings → Sources. It must be a personal key from https://linear.app/settings/api — an OAuth token will not work here.',
      };
    }
  },
};
