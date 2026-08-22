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
 * FOUR THINGS IN HERE ARE NOT OBVIOUS AND EVERY ONE OF THEM HAS A TEST IN
 * test/connector-linear.test.mjs. That sentence was a lie for one release: the
 * file said it three times and no test in the repo named `linear` at all, which
 * an adversarial review proved by copying the tree to scratch and applying
 * twelve breaking mutations one at a time — deleting the `prefix: ''` below,
 * adding `uid: null`, deleting the `errors[]` check, flipping `direction` to
 * `'out'`, inverting the workflow-state filter so the board showed only finished
 * work — and watching the whole 1,207-test suite stay green after every one. A
 * comment claiming coverage that does not exist is worse than no comment: it is
 * the reason a reviewer stops looking.
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
 *     the two failures the run loop reacts to — and it is NARROW, because the
 *     mistake in the other direction is worse and is silent: an AuthError rests
 *     the source for six hours and a rested source reports nothing at all, so a
 *     `FORBIDDEN` on one field used to buy an empty, calm-looking board. See the
 *     comment on `graphqlError`.
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
 *     What `date: now` buys is INCLUSION in the window and not RANK within it:
 *     `listMessages` also does `ORDER BY sent_at DESC` on a TEXT column, and
 *     `ctx.now` is offset-form (`…T14:05:20-04:00`) where slack.mjs:937 and
 *     github.mjs:421 write Z-form, so a New York user's Linear row sorts below a
 *     Slack row of the same instant on the string compare alone. That is a
 *     house-wide disagreement about the stored shape of `sent_at`, not something
 *     this file can fix alone — noted so the next reader does not assume the
 *     ordering follows from the inclusion.
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
 * The paging loop's stop.
 *
 * Four pages is 400 issues that are already narrowed to "assigned to me, not
 * done, due inside the horizon", which is more than a person has; past that the
 * answer is not a board, it is a backlog export. Hitting this stop is REPORTED
 * rather than silent — see the note built at the end of `collect`. A cut-short
 * read is not a lie about the account, but a note claiming an exact total after
 * one is, and Linear's `orderBy` accepts only `createdAt`/`updatedAt`, so the
 * pages arrive in creation order and the single most overdue issue can sit on
 * page 6 forever with `ok: true` beside it.
 */
const MAX_PAGES = 4;

/**
 * The most issues one sweep will hold, and it is enforced node by node.
 *
 * `first: ${PAGE}` is a request, not a guarantee: nothing stops a server from
 * answering with more, and a measured 200,000-node page (6.6 MB — inside the
 * transport's 8 MiB cap, so nothing upstream refuses it) is what turns
 * `issues.push(...nodes)` into `RangeError: Maximum call stack size exceeded`.
 */
const MAX_ISSUES = MAX_PAGES * PAGE;

/** The hard ceiling, whatever the user asked to keep. */
const MAX_ROWS = 200;

const DEFAULT_KEEP = 50;
const DEFAULT_HORIZON_DAYS = 7;

const SNIPPET_CHARS = 240;

/**
 * EVERY string that leaves this file is bounded, not just the description.
 *
 * `BODY_CHARS` used to cap the one INPUT that looked long and nothing else, so
 * a single issue whose fields were each 200,000 characters — a 1.4 MB response,
 * comfortably legal — produced a 400,001-char `subject`, a 1,004,101-char
 * `text`, a 200,007-char `threadKey` and 200,000-char addresses. All of it goes
 * into `messages`, is concatenated into the FTS body (core/db.mjs:409-415), and
 * `subject`/`text` are what `renderMessage` hands the model. slack.mjs:482 caps
 * the FINISHED body; this file now caps both ends.
 *
 * `TEXT_CHARS` is a BACKSTOP and it does not bind today — with every part above
 * capped, the worst body this connector can assemble measures 4,962 characters.
 * It is here so that adding one more uncapped part to `body` cannot put the
 * megabyte back, and it is deliberately above `BODY_CHARS` because the URL is
 * the last line and is the one part a reader acts on: a full-length description
 * must not be able to push it off the end.
 */
const BODY_CHARS = 4_000;
const TEXT_CHARS = 6_000;
const SUBJECT_CHARS = 200;
const NAME_CHARS = 120;
const URL_CHARS = 500;

/** `ENG-412` is seven. 40 is room for a long team prefix and nothing else — and
    this one feeds `threadKey`, which is a database index. */
const ID_CHARS = 40;

/** A UUID is 36. This bounds a hostile one without making two real ids collide. */
const UUID_CHARS = 200;

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
 * The codes that mean THE KEY IS DEAD, matched per entry and matched exactly.
 *
 * `FORBIDDEN` and `AUTHORIZATION…` are deliberately absent, and their absence is
 * the whole point of this list. A forbidden resource is not a refused
 * credential: a SAML-restricted workspace, a team the key cannot see, a scope
 * missing for `viewer.email` — every one of those is a working key told "not
 * that one", and every one of them used to escalate the entire read to AuthError
 * because the old matcher joined all the codes into one string and ran
 * `/FORBIDDEN|AUTHORIZATION/` over it.
 */
const AUTH_CODES = new Set(['AUTHENTICATION_ERROR', 'UNAUTHENTICATED', 'AUTHENTICATION_REQUIRED']);

/** Same rule for the other arm Zelos reacts to. */
const RATE_CODES = new Set(['RATELIMITED', 'RATE_LIMITED', 'TOO_MANY_REQUESTS']);

/**
 * The prose fallback, for an entry that carries no code at all.
 *
 * NARROW on purpose. It used to be the substring `authenticat`, which promoted
 * `{code: 'BAD_USER_INPUT', message: 'user not authenticated for team'}` — a
 * per-field permission complaint — to a dead credential. Measured.
 */
const AUTH_PROSE = /invalid api key|authentication required/i;

const codeOf = (e) => str(e?.extensions?.code).trim().toUpperCase();

const isAuthEntry = (e) => {
  const code = codeOf(e);
  // A code is a contract and a message is a sentence somebody may reword, so
  // when there IS a code it decides alone — a codeful entry never falls through
  // to the prose, or the narrowing above buys nothing.
  if (code) return AUTH_CODES.has(code);
  return AUTH_PROSE.test(collapse(e?.message));
};

const isRateEntry = (e) => {
  const code = codeOf(e);
  if (code) return RATE_CODES.has(code);
  return /rate limit/i.test(collapse(e?.message));
};

/**
 * Turn a GraphQL `errors` array into the failure the run loop can act on.
 *
 * Exported for the test, which drives each arm against a loopback server that
 * answers 200 with a body — the only way to prove this at all, because a 401 on
 * the wire never reaches here: core/connectors/http.mjs:316 raises its own
 * AuthError before the body is read.
 *
 * AN AuthError IS THE MOST EXPENSIVE THING THIS FUNCTION CAN RETURN, and the
 * comment that used to sit here had the cost backwards. It said erring loosely
 * "costs one extra sweep". It does not: core/sweep.mjs:735 sets
 * `authBlockedUntil = now + AUTH_BLOCK_MS`, six hours (http.mjs:76), and
 * core/sweep.mjs:653-656 returns `nothing` for a credential-rested source
 * WITHOUT pushing anything into `sources[]` — no error, no count, no banner, by
 * design. So a false AuthError buys six hours in which Linear contributes
 * nothing and the board says nothing is wrong, repeating every sweep because the
 * credential never changes and only a hand edit lifts the block. That is the
 * "nothing happened today" lie this product exists to prevent, told by the one
 * arm that was meant to prevent it.
 *
 * Hence: AuthError only when EVERY entry is an auth failure — one refused field
 * beside a healthy response is not a dead key — or when an auth entry arrives
 * with no `data` at all, which is what a genuinely refused query looks like.
 * `hasData` is passed by `query` below rather than sniffed here, because this
 * function is handed the errors and not the body.
 */
export function graphqlError(errors, { hasData = false } = {}) {
  const list = Array.isArray(errors) ? errors : [];
  const text = list
    .map((e) => collapse(e?.message))
    .filter(Boolean)
    .join('; ')
    .slice(0, ERROR_CHARS) || 'Linear refused the query and said nothing about why';

  const authEntries = list.filter(isAuthEntry).length;
  if (list.length > 0 && (authEntries === list.length || (authEntries > 0 && !hasData))) {
    return new AuthError(
      `Linear rejected the API key: ${text}. Check it in Settings — Zelos will not keep trying with the one it has.`,
    );
  }
  /* "Any" rather than "every", and the asymmetry is deliberate: a RateLimitError
     costs one delayed sweep (core/sweep.mjs:737 sets `notBefore`), which is
     recoverable and visible, where a false AuthError costs six silent hours. */
  if (list.some(isRateEntry)) {
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
  if (Array.isArray(body?.errors) && body.errors.length) {
    /* `data` is what separates "your key is dead" from "one field of an
       otherwise-healthy answer was refused". A GraphQL partial carries both, and
       reading only the errors is how a permission complaint became a six-hour
       credential block. */
    throw graphqlError(body.errors, { hasData: body?.data != null });
  }
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
  if (!key) return 'No due date';
  /* The two unknowns are not the same unknown, and the guard used to test the
     wrong one: `dueness` returns `{key, overdueDays: null}` when `today` cannot
     be parsed, so an issue that HAS a due date printed "No due date" and threw
     the date away. Unreachable today — `today` falls back to `todayKey` — but
     the field being read is not the field being asked about, and a future caller
     with a bad `today` gets silence rather than a fault. */
  if (overdueDays === null) return `Due ${key}`;
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

/**
 * `identityEmail` is `ctx.identityEmail`, the address the user declared as
 * theirs; see the `to` line below for why the viewer's own is not enough.
 */
function rowFor(entry, viewer, now, identityEmail) {
  const issue = entry.issue;
  const id = str(issue?.id).slice(0, UUID_CHARS);
  const identifier = collapse(issue?.identifier).slice(0, ID_CHARS);
  const title = collapse(issue?.title).slice(0, SUBJECT_CHARS) || identifier || '(untitled issue)';
  const state = (collapse(issue?.state?.name) || collapse(issue?.state?.type)).slice(0, NAME_CHARS);
  const team = collapse(issue?.team?.name).slice(0, NAME_CHARS);
  const priority = collapse(issue?.priorityLabel).slice(0, NAME_CHARS);
  const url = collapse(issue?.url).slice(0, URL_CHARS);

  /* The one line that has to carry the weight. `renderMessage`
     (core/triage.mjs:540) prints the snippet under every message it shows the
     model, so this is what separates "was due nine days ago" from "due today"
     even on a run trimmed down to headers and snippets. The day key is in it
     verbatim because SWEEP_JSON_SHAPE asks the model for `dueAt` as ISO — it has
     to be able to copy something. */
  const line = [duePhrase(entry), state, identifier].filter(Boolean).join(' · ');

  /* The identity's address first, the Linear account's only as a fallback for a
     user who never filled Settings in. See the `to` line below. */
  const toEmail = collapse(identityEmail).slice(0, NAME_CHARS) || viewer.email;

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
       collide with a Message-ID from a real mailbox. `collect` drops a node with
       no `id` before it gets here — `linear:issue:` is one row id, so every
       id-less issue in a sweep would otherwise overwrite the last one. */
    messageId: `linear:issue:${id}`,
    /* Grouping from the readable identifier, which is what the model is told to
       build an item `key` from — `thread=linear-eng-412` reads as the thing;
       `thread=linear:issue:8f2c…` reads as nothing. A team move re-groups the
       row and costs nothing, where it would have re-inserted it. */
    threadKey: identifier ? `linear:${identifier.toLowerCase()}` : `linear:issue:${id}`,
    folder: (team || 'Linear').slice(0, NAME_CHARS),
    direction: 'in',
    /* Whoever filed it. A real address here is worth having: the model is asked
       for `person` and `personEmail`, and "Answer Priya on ENG-412" needs one. */
    from: {
      name: (collapse(issue?.creator?.name) || team || 'Linear').slice(0, NAME_CHARS),
      email: collapse(issue?.creator?.email).slice(0, NAME_CHARS),
    },
    /* The assignee is the user, which is the whole premise of the query, and
       saying so is what earns the row `scoreInbound`'s "addressed to you" credit
       instead of leaving it looking like a broadcast.
       THE ADDRESS HAS TO BE THE IDENTITY'S, not Linear's. The test is
       core/triage.mjs:590, `msg.to.some((a) => sameEmail(a?.email,
       ctx.userEmail))`, where `ctx.userEmail` is `identity.email` and
       `sameEmail` is exact case-insensitive equality with no alias or domain
       handling. A user whose Linear account is nemo@work.com and whose Settings
       identity is nemo@northgate.example — anyone with a work tool and a personal
       identity line — scored 0 instead of 6 with the viewer's address here, so
       every Linear obligation ranked lower than this file claimed and was cut
       from the prompt earlier. The viewer's own address is still worth having as
       a fact, so it stays in `from`'s fallback and in the account line of the
       body; it does not belong in the field the scorer reads. todoist.mjs:248
       makes the same call for the same reason. */
    to: (toEmail || viewer.name) ? [{ name: viewer.name, email: toEmail }] : [],
    cc: [],
    subject: (identifier ? `${identifier} ${title}` : title).slice(0, SUBJECT_CHARS),
    date: now,
    snippet: line.slice(0, SNIPPET_CHARS),
    /* The finished body, not just its longest input — see TEXT_CHARS. */
    text: body.trim().slice(0, TEXT_CHARS),
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
    /* ZELOS'S OWN RESTRAINT, NOT THE VENDOR'S CEILING — and the difference is
       not philosophical. This line used to read 5,000, quoted as "the vendor's
       own published ceiling", and it was the wrong row of Linear's table: 5,000
       an hour is the OAuth App figure, and a PERSONAL API KEY — the only
       credential this connector accepts, see `credential.help` above — gets
       2,500. So the declared budget was exactly twice the real allowance, which
       is how a connector discovers somebody else's limit by being throttled.

       The honest number is what a sweep actually costs: at most MAX_PAGES calls,
       plus whatever `zelos doctor` spends on a transport built without the
       persisted meter. Twenty covers both several times over and still bounds a
       paging loop that has gone wrong, which is the only job a budget has here.
       Every sibling declares a fraction of the vendor's allowance the same way —
       todoist.mjs declares 60 an hour and fireflies.mjs 40 a day — and
       todoist.mjs says the rule this line broke in as many words: "Guessing high
       at somebody else's limit is how a connector discovers it by being
       throttled." */
    budget: { calls: 20, perMs: BUDGET_MS },
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
    /* Whether this sweep read the whole answer, and WHY NOT — the three ways it
       can fail to are not interchangeable and the note has to tell them apart.
       `capped` is Zelos's own limit and is the only one the user can do anything
       about, so it is the only one that earns the "narrow the horizon" sentence;
       `partial` is the server stopping mid-read; an abort is the sweep being shut
       down and deserves neither. All three make an exact total a lie. */
    let capped = false;
    let stopped = false;
    let partial = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (ctx.signal?.aborted === true) {
        stopped = issues.length > 0;
        break;
      }
      let data;
      try {
        data = await query(ctx.http, { after, dueBy });
      } catch (err) {
        /* PAGE 1'S ROWS ARE NOT THROWN AWAY BECAUSE PAGE 3 FAILED. A throw out
           of `collect` discards every row already read and the user sees no
           Linear rows at all — 300 obligations lost to one 500 on the last page.
           The two failures the run loop REACTS to are the exceptions and they
           still propagate untouched: an AuthError has to reach core/sweep.mjs:740
           or a dead key is retried twice an hour forever, and a RateLimitError
           has to set `notBefore` or the next sweep spends an allowance the
           server has already refused. Anything else becomes a partial read with
           the reason in the note, which the sweep renders as `ok: false` with
           the sentence in `error` — the shape that says "some of it". */
        if (!issues.length || err instanceof AuthError || err instanceof RateLimitError) throw err;
        partial = collapse(err?.message).slice(0, ERROR_CHARS);
        break;
      }
      const me = data?.viewer;
      if (!me) {
        throw new Error('Linear answered without a viewer, so it does not know whose issues these are. That is what an API key with no read access looks like.');
      }
      viewer = { name: collapse(me.name).slice(0, NAME_CHARS), email: collapse(me.email).slice(0, NAME_CHARS) };
      const connection = me.assignedIssues ?? {};
      const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
      // Not `issues.push(...nodes)`; see MAX_ISSUES. A spread is one call
      // argument per node, and a page big enough blows the stack instead of
      // being read or refused.
      for (const node of nodes) {
        if (issues.length >= MAX_ISSUES) {
          capped = true;
          break;
        }
        issues.push(node);
      }
      const info = connection.pageInfo ?? {};
      if (info.hasNextPage !== true || !collapse(info.endCursor)) break;
      if (page === MAX_PAGES - 1) {
        /* Linear says there is another page and this sweep has no call left for
           it. Reading `hasNextPage` and dropping it on the floor is what made
           the note below state a total it knew was false. */
        capped = true;
        break;
      }
      after = collapse(info.endCursor);
    }

    /* A node with no `id` is dropped rather than kept, because `messageId`
       collapses to the bare `linear:issue:` prefix without one and every such
       issue in a sweep then overwrites the last inside one `upsertMessages`
       transaction. Measured with two distinct issues: one row survived. A row
       that cannot be identified cannot be tracked between sweeps, so the drop is
       counted into the note rather than being silent. */
    const usable = issues.filter((issue) => issue && typeof issue === 'object' && str(issue.id));
    const unidentified = issues.length - usable.length;

    const ranked = usable
      .map((issue) => ({ issue, ...dueness(issue.dueDate, today) }))
      .sort(byUrgency);

    const kept = ranked.slice(0, keep);
    const rows = kept.map((entry) => rowFor(entry, viewer, str(ctx.now), ctx.identityEmail));

    const overdue = kept.filter((e) => e.overdueDays !== null && e.overdueDays > 0).length;
    const dueToday = kept.filter((e) => e.overdueDays === 0).length;
    ctx.emit(`${ctx.label}: ${overdue} overdue, ${dueToday} due today`, rows.length, rows.length);

    /* A drop is reported, and it is reported as a `note` rather than swallowed.
       The sweep renders a note as `ok: false` with the sentence in `error`
       (core/sweep.mjs:712-726) — "neither a success nor a failure", which is
       exactly what "I read 90 obligations and kept the 50 most urgent" is. An
       RSS archive silently trimmed to 50 costs nothing; 40 silently dropped
       obligations is the failure this product exists to prevent.

       AND A CUT-SHORT READ IS THE SAME FAILURE ONE LEVEL UP, which is why
       `capped` is a sentence here rather than a variable nobody reads. The
       note used to say "Linear had 400 issues" after a read that stopped at four
       pages with `hasNextPage: true` still on the wire — a falsehood the
       connector generated about an account it had not finished reading. When the
       read was cut short the total is stated as a floor, never as a fact. */
    const dropped = ranked.length - kept.length;
    const short = capped || stopped || partial !== null;
    const notes = [];
    if (short) {
      notes.push(`Linear had MORE than ${ranked.length} issues assigned to you and due; Zelos read the first ${issues.length} and kept ${kept.length}.`);
      /* Only the cap is the user's to move. Telling somebody to narrow their
         horizon because the server returned a 500 sends them to fix the one
         thing that was working. */
      if (capped) notes.push('Narrow "Days ahead to look" so the whole read fits — until then the most overdue issue in the account can sit on a page Zelos never asks for.');
    } else if (dropped > 0) {
      notes.push(`Linear had ${ranked.length} issues assigned to you and due, and this source keeps ${keep} — the ${dropped} least urgent were dropped. Raise "Issues to keep" in Settings if that is too few.`);
    }
    if (unidentified > 0) {
      notes.push(`${unidentified} issue${unidentified === 1 ? '' : 's'} arrived with no id and ${unidentified === 1 ? 'was' : 'were'} dropped — Zelos cannot tell one apart from the next between sweeps.`);
    }
    if (partial) notes.push(`Linear stopped answering part-way through: ${partial}`);
    const note = notes.length ? notes.join(' ') : null;

    /* NO `cursor` KEY, and not an oversight. Linear can filter by `updatedAt`,
       so an incremental sync is available and would be wrong: what changes about
       these rows between sweeps is mostly that the CLOCK MOVED. An issue nobody
       has touched since March goes from "due in 3 days" to "overdue by 9" with
       no update event anywhere, and a modified-since cursor would freeze it at
       the weight it had when it was last edited. Returning `undefined` here
       makes core/sweep.mjs:794 `continue`, so nothing is written and nothing is
       cleared. On a fresh install there is nothing to clear; on an upgrade from
       a release that DID write one the old row is orphaned in `kv` rather than
       absent, which is dead data and not a bug — `collect` never reads
       `ctx.cursor`, and a stale one fed in leaves the outgoing variables
       identical. Clearing it would cost a `kv` write on every sweep forever to
       tidy a row nobody reads. */
    return { parts: [{ label: '', rows, error: null, note }] };
  },

  /**
   * What `zelos doctor` asks Linear.
   *
   * It runs THE SAME QUERY the sweep runs, one page of it, rather than a cheap
   * `viewer { name }`. A `viewer` probe proves the key works and proves nothing
   * about the query, so a filter Linear has stopped accepting would pass doctor
   * and fail at 07:00 — and this is the command a stuck user runs. One request
   * against a personal key's 2,500 an hour is not worth optimising.
   *
   * Failures are caught and returned rather than thrown: core/doctor.mjs:945
   * would catch a throw and describe it as a fault inside Zelos, which sends the
   * reader to the wrong place when the real answer is "your key was refused".
   */
  async check(source, ctx) {
    const settings = source?.settings && typeof source.settings === 'object' ? source.settings : {};
    const horizon = clampInt(settings.horizonDays, DEFAULT_HORIZON_DAYS, 0, 365);
    /* The user's day, from the clock doctor hands over — the same rule
       `collect` reads above. This was a bare `todayKey()`: the machine's clock
       in the machine's zone, so the overdue count in the one line a stuck
       person reads was measured wherever the laptop happens to be, and the
       test that pinned it aged into a failure eight days after it was
       written. `ctx.now` is already zoned (core/doctor.mjs builds it with
       `nowISO(tz)`), so its own day key is the right one; the zone alone is
       the fallback for a caller that hands over nothing else. */
    const today = dayKey(str(ctx?.now)) || todayKey(str(ctx?.timezone) || undefined);
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
