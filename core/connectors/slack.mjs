/**
 * core/connectors/slack.mjs — a Slack workspace, read with a token the user
 * minted inside their own workspace.
 *
 * THE RATE LIMIT EVERY READER IS ABOUT TO DESIGN AROUND DOES NOT APPLY HERE.
 *
 * In 2025 Slack cut non-Marketplace apps to ONE request per minute on
 * `conversations.history`, and to fifteen objects per page. If that were the
 * number this connector had to live inside, twenty channels would take twenty
 * minutes and this file would have to be a queue with a persisted work list. It
 * is not, and the sentence that settles it is Slack's own:
 *
 *   "any internal customer-built apps will maintain their existing rate limits
 *    and will not be subject to the new posted limits"
 *   — docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/
 *
 * Zelos's model IS an internal customer-built app, exactly and only: the USER
 * creates an app in their OWN workspace, grants it their own scopes, installs it
 * for themselves, and pastes the token in. Zelos publishes no Slack app, holds
 * no client id, has no Marketplace listing and no OAuth redirect — see
 * non-negotiable #3 — so there is nothing here for the new limit to attach to.
 * The numbers in `limits` below are therefore Slack's ordinary published tiers
 * (Tier 2 for `conversations.list`, Tier 3 for `conversations.history`, Tier 4
 * for `users.info`), not the throttled ones.
 *
 * Do not "fix" this file down to 1 req/min. If a workspace ever IS throttled the
 * code already survives it — `conversations.history` would answer with fifteen
 * messages and a `next_cursor`, and the pagination loop below simply takes more
 * pages — so the harsher limit costs calls, not correctness.
 *
 * THE OTHER THING A READER MUST KNOW BEFORE CHANGING ANYTHING.
 *
 * The Slack Web API answers **HTTP 200 with `{"ok": false, "error": "..."}`**.
 * A revoked token, a missing scope, a channel the token cannot see — all 200.
 * `ctx.http` raises `AuthError` on a 401/403 and it will never see one from
 * slack.com, so every failure this connector reports it has to notice itself, in
 * `slackGet` below. A version of this file that trusted `res.status` would read
 * `body.messages` off `{ok:false}`, get `undefined`, emit zero rows and report
 * the source healthy — a dead token that looks like a quiet week.
 *
 * WHAT IT READS, AND WHY THE DEFAULT IS THE NARROW ONE.
 *
 * A user token with `channels:history` can read every public channel in the
 * workspace, which for most companies is tens of thousands of messages a day and
 * a great deal of other people's conversation. `breadth` defaults to
 * `participating` — direct messages, group DMs, and the channels the token's
 * owner is actually a member of — and widening it is a choice made in a labelled
 * field in Settings rather than something that happens because a scope was
 * granted. `onlyChannels` narrows it further by name.
 *
 * WHAT IT DELIBERATELY DOES NOT READ: thread replies. `conversations.history`
 * returns thread PARENTS only; the replies need one `conversations.replies` call
 * per thread, and a channel with twenty live threads would cost twenty calls on
 * top of its one history call — the whole per-sweep budget for a single channel.
 * So replies are not fetched, the parent's `reply_count` is appended to its body
 * so the board can see there is more, and `threadKey` is still set from
 * `thread_ts` so that the replies Slack DOES put in history (a broadcast reply,
 * `subtype: "thread_broadcast"`) land in the same thread as their parent.
 */

import { AuthError, RateLimitError } from './http.mjs';

/**
 * The one host. There is no `type: 'url'` field on this connector and that is
 * on purpose: `originsFor` widens the allow-list with any URL field the user
 * filled in, so a "Slack API base" setting would be a way to point a token at a
 * host that is not Slack. The Web API is always slack.com — Enterprise Grid and
 * custom workspace domains included.
 */
const API = 'https://slack.com/api';

/** Slack's own recommended page size for `conversations.list` (max is 1000). */
const LIST_PAGE = 200;
const HISTORY_PAGE = 200;

/**
 * Page ceilings, because `response_metadata.next_cursor` is a string a server
 * hands back and a server that hands back the same one forever is a loop that
 * spends the whole rate budget and then the whole sweep. Cursor pagination has
 * no other stopping condition: `has_more` comes from the same place the cursor
 * does. Eight history pages is 1,600 messages at the ordinary page size and 120
 * under the throttled one — past either, the channel is a firehose and
 * `maxPerChannel` was the wrong number, not this.
 */
const MAX_LIST_PAGES = 10;
const MAX_HISTORY_PAGES = 8;

const SNIPPET_CHARS = 400;
const BODY_CHARS = 20_000;
const SUBJECT_CHARS = 120;

/** How deep into a Block Kit payload the text scraper will walk. */
const MAX_BLOCK_DEPTH = 6;

/**
 * How many resolved names ride along in the cursor, and for how long.
 *
 * The cache is the difference between one `users.info` call per distinct person
 * ever and one per person per sweep forever; without it a twelve-person channel
 * costs twelve Tier-4 calls every thirty minutes to render names that have not
 * changed since March. Eighty is what fits in the cursor beside the high-water
 * marks (see CURSOR_CHAR_BUDGET), and seven days is how long a display name is
 * allowed to be stale — someone who changes theirs is right within a week.
 */
const USER_CACHE_MAX = 80;
const USER_CACHE_MAX_AGE_MS = 7 * 86_400_000;

/**
 * The size a cursor may serialise to, restated from core/sweep.mjs:111.
 *
 * `writeCursor` DROPS a cursor larger than 4,096 characters and logs a warning
 * nobody reads. Dropping it is not a data loss — every row upserts by a stable
 * id, so re-reading is free of duplicates — but it means the high-water marks
 * never persist, so every sweep re-reads the full lookback of every channel,
 * forever, on a rate-limited API. That is the expensive failure this connector
 * could have and the only sign of it is a log line. `packCursor` therefore
 * trims until it fits rather than hoping.
 */
export const CURSOR_CHAR_BUDGET = 4096;

/**
 * The three breadths, and what each asks Slack for.
 *
 * `membersOnly` is applied by this file rather than by the API: `conversations.
 * list` returns every public channel in the workspace whether or not the token's
 * owner has ever opened it, and `is_member` is the field that says which is
 * which. Direct messages have no `is_member` — the list only ever contains
 * yours — so they pass the filter by being what they are.
 */
const BREADTHS = Object.freeze({
  participating: { types: ['im', 'mpim', 'private_channel', 'public_channel'], membersOnly: true },
  channels: { types: ['private_channel', 'public_channel'], membersOnly: true },
  all: { types: ['im', 'mpim', 'private_channel', 'public_channel'], membersOnly: false },
});

/**
 * Errors that mean the token will not work again until a person does something.
 *
 * These become `AuthError`, which parks the source for six hours OR until the
 * stored secret changes (core/sweep.mjs's `authResting`), because every retry
 * with a revoked token is a wasted call and, on an Enterprise workspace, a line
 * in somebody's audit log.
 *
 * `missing_scope` is deliberately NOT in this set. It looks like an auth failure
 * and behaves like a configuration one: the fix is to add the scope and
 * reinstall, and a bot token frequently survives that reinstall unchanged — so
 * the secret hash would not change, and a six-hour park would keep Slack dark
 * for six hours after the user had already fixed it. It is a plain error that
 * names the scope Slack asked for and clears itself on the next sweep.
 */
const DEAD_TOKEN = new Set([
  'invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired',
  'no_permission', 'ekm_access_denied', 'org_login_required', 'two_factor_setup_required',
]);

/**
 * Message subtypes that are Slack talking about itself.
 *
 * "Nemo has joined the channel" is not correspondence, and a board that surfaces
 * it teaches people to ignore the board. Everything not listed here is kept,
 * including `bot_message` (a deploy that failed is exactly what `now` is for)
 * and `thread_broadcast` (a reply the author chose to send to the channel).
 */
const NOISE_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'group_join', 'group_leave',
  'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive',
  'channel_unarchive', 'group_topic', 'group_purpose', 'group_name',
  'group_archive', 'group_unarchive', 'channel_posting_permissions',
  'pinned_item', 'unpinned_item', 'bot_add', 'bot_remove',
  'reminder_add', 'tombstone', 'message_deleted', 'message_changed',
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clampInt = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

/**
 * A Slack `ts` is epoch seconds with six decimal places — "1754899320.001700" —
 * and it is a STRING, not a number: two messages a microsecond apart differ only
 * in the last digits, and `Number()` round-trips them to the same float on the
 * way back out. It is parsed for the date and never for the identity.
 */
export function tsToISO(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const at = new Date(Math.round(n * 1000));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The other direction, for `oldest`. Slack wants the same dotted seconds. */
export function isoToTs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? (ms / 1000).toFixed(6) : null;
}

/* --------------------------------------------------------------- transport */

/**
 * One Slack Web API read, and the only place `ok: false` is turned into a throw.
 *
 * Everything is a GET with query parameters. The token is NOT one of them: it
 * travels as `Authorization: Bearer` because `credential.send` says so and
 * because core/connectors/index.mjs refuses `as: 'query'` outright — a token in
 * a query string is logged intact by every proxy between here and Slack. Slack
 * has accepted the header form on every Web API method for years; the
 * `?token=…` form in its older documentation is the one this cannot do and does
 * not need.
 *
 * Errors carry `slackError` (and `slackNeeded` for a scope) so a caller can tell
 * "this token is finished" from "this one channel is not readable" without
 * matching on message text.
 */
async function slackGet(ctx, method, params = {}) {
  const url = new URL(`${API}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const res = await ctx.http.get(url.href, { accept: 'application/json' });

  let body = null;
  try {
    body = JSON.parse(res.text);
  } catch {
    body = null;
  }
  if (!isObj(body)) {
    // Slack answers JSON or it is not Slack — a captive portal, a proxy error
    // page, a corporate TLS interceptor. Say which, rather than throwing a
    // SyntaxError with a column number in it.
    throw new Error(`slack.com answered ${method} with ${res.text ? 'a body that is not JSON' : 'an empty body'}`);
  }
  if (body.ok === true) return body;
  throw slackFailure(method, body);
}

/** `{ok:false, error:"..."}` -> the error type the sweep knows how to react to. */
export function slackFailure(method, body) {
  const code = String(body?.error || 'unknown_error');
  const needed = collapse(body?.needed);
  let err;

  if (DEAD_TOKEN.has(code)) {
    err = new AuthError(
      `Slack refused the token (${code}). Zelos will not keep trying with this one — `
      + 'reinstall the app in your workspace and paste the new token in Settings → Sources.',
      { status: 401 },
    );
  } else if (code === 'ratelimited') {
    /* Slack normally rate-limits with a real HTTP 429 and a `Retry-After`,
       which `ctx.http` already turns into a RateLimitError carrying the
       server's own number. This is the other form — 200 with `ok:false` — which
       states no interval at all, so a minute is assumed. It is a floor on the
       next attempt and never a sleep: the next sweep is half an hour away and
       is a better retry than any wait this process could do. */
    err = new RateLimitError(`slack.com is rate limiting ${method}`, { retryAfterMs: 60_000 });
  } else if (code === 'missing_scope') {
    err = new Error(
      `Slack refused ${method}: this token does not have the ${needed || 'required'} scope. `
      + 'Add it to your app at api.slack.com/apps, reinstall it, and paste the new token in Settings.',
    );
  } else {
    err = new Error(`Slack refused ${method}: ${code}`);
  }

  err.slackError = code;
  err.slackNeeded = needed;
  return err;
}

/**
 * Follow `response_metadata.next_cursor` until it stops or the page cap does.
 *
 * The cap is the whole reason this is a function. An empty-string cursor is the
 * documented end; a cursor identical to the one just sent is a server bug or a
 * proxy replaying a cached page, and either way it is an infinite loop against a
 * rate-limited API. Both endings are treated the same way — stop — because the
 * caller cannot do anything useful with the difference.
 *
 * The ONE ending the caller can do something about is the page cap itself, and
 * it used to be silent. `MAX_LIST_PAGES` x `LIST_PAGE` is 2,000 conversations;
 * an Enterprise Grid workspace with more than that had the `maxChannels` cut
 * applied to an arbitrary prefix of an order Slack documents nothing about, so
 * the set of channels read could differ between sweeps for a reason
 * `onlyChannels` cannot explain — while line 795's note already answers exactly
 * that question for the OTHER cut. So the array comes back wearing
 * `.truncated`, the same "array with a non-index property" core/sweep.mjs's
 * `markTruncated` uses, and the caller turns it into a sentence.
 */
async function paginate(ctx, method, params, pick, { maxPages, stop = () => false }) {
  const out = [];
  out.truncated = false;
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const body = await slackGet(ctx, method, cursor ? { ...params, cursor } : params);
    const chunk = pick(body);
    if (Array.isArray(chunk)) out.push(...chunk);
    const next = String(body?.response_metadata?.next_cursor ?? '');
    if (stop(out)) {
      // Stopped by the caller's cap with a page still on offer: the same fact
      // as the ceiling below, and the caller reads it the same way. Without
      // this a channel holding exactly the cap plus one more page looks
      // complete, because the cursor that says otherwise was never read.
      if (next && next !== cursor) out.truncated = true;
      break;
    }
    if (!next || next === cursor) break;
    cursor = next;
    // Slack still had more to give and this was the last page allowed.
    if (page === maxPages - 1) out.truncated = true;
  }
  return out;
}

/* ------------------------------------------------------------------ people */

/**
 * The name behind a `U…`, with a cache that survives the process.
 *
 * Without this the board shows `U04ABCDEF` where a person's name belongs, in the
 * author column and inside every `<@U04ABCDEF>` mention in every body. With it
 * and without persistence, the same forty lookups happen every thirty minutes
 * against a Tier-4 endpoint to learn nothing new — so the map rides in the
 * cursor (see `packCursor`).
 *
 * `users:read` is a separate scope from `channels:history`, and a token can very
 * reasonably have one and not the other. That case degrades rather than fails:
 * the id becomes the name, the failure is latched so the next thirty people do
 * not each cost a refused call, and the source carries a note saying why the
 * board is full of ids.
 */
async function resolveUser(ctx, id, names, state) {
  const key = String(id ?? '').trim();
  if (!key) return '';
  if (names.has(key)) return names.get(key);
  if (state.namesUnavailable) {
    names.set(key, key);
    return key;
  }
  try {
    const body = await slackGet(ctx, 'users.info', { user: key });
    const user = isObj(body.user) ? body.user : {};
    const profile = isObj(user.profile) ? user.profile : {};
    const name = collapse(profile.display_name) || collapse(profile.real_name)
      || collapse(user.real_name) || collapse(user.name) || key;
    names.set(key, name);
    return name;
  } catch (err) {
    if (err instanceof AuthError || err instanceof RateLimitError) throw err;
    if (err.slackError === 'missing_scope' || err.slackError === 'not_allowed_token_type') {
      state.namesUnavailable = true;
      state.namesNeeded = err.slackNeeded || 'users:read';
    }
    /* Cached as its own id either way, so one deactivated account
       (`user_not_found`) costs one refused call for the whole run rather than
       one per message they ever wrote. */
    names.set(key, key);
    return key;
  }
}

/* ------------------------------------------------------------------- text */

/**
 * Slack escapes exactly three characters — `&`, `<`, `>` — and nothing else.
 *
 * ORDER IS LOAD-BEARING and this is the trap in the file most likely to be
 * "tidied" into a bug. The entities are decoded LAST, after the `<…>` control
 * sequences have been consumed, because somebody who literally types `<@U123>`
 * in a message has it delivered as `&lt;@U123&gt;` — decoding first would turn
 * their literal text into a mention of a person who was never mentioned, and
 * then resolve that person's name into the body of a message about something
 * else. Decoding last leaves it as the text they typed.
 */
const decodeEntities = (s) => String(s ?? '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

/**
 * Slack mrkdwn -> something a person (and a model) can read.
 *
 * `resolve(id)` hands back a display name or null; it is a plain function
 * because every id in the message has already been looked up by the time this
 * runs — a renderer that awaited inside a regex replace would be an unbounded
 * number of API calls hidden inside string formatting.
 *
 * `*bold*`, `_italic_` and backticks are left exactly as typed. They are
 * readable as-is, and stripping them loses the emphasis that is often the whole
 * point of the message.
 */
export function renderSlackText(raw, resolve = () => null) {
  const text = String(raw ?? '');
  if (!text) return '';

  const out = text.replace(/<([^<>]*)>/g, (whole, inner) => {
    const bar = inner.indexOf('|');
    const head = bar === -1 ? inner : inner.slice(0, bar);
    const label = bar === -1 ? '' : inner.slice(bar + 1);

    if (head.startsWith('@')) {
      const id = head.slice(1);
      return `@${label || resolve(id) || id}`;
    }
    if (head.startsWith('#')) {
      // `<#C012|general>` carries the name; `<#C012>` does not, and a channel id
      // is at least honest about being one.
      return `#${label || head.slice(1)}`;
    }
    if (head.startsWith('!')) {
      const bang = head.slice(1);
      if (bang === 'here' || bang === 'channel' || bang === 'everyone') return `@${bang}`;
      if (bang.startsWith('subteam^')) return label || `@${bang.slice('subteam^'.length)}`;
      // `<!date^1754899320^{date_short}|Aug 11, 2026>` — the fallback after the
      // bar is the rendered date, which is the only part that means anything
      // outside a Slack client.
      if (label) return label;
      return `@${bang}`;
    }
    if (head.startsWith('mailto:')) return label || head.slice('mailto:'.length);
    if (/^https?:\/\//i.test(head)) {
      // The URL is kept even when there is a label, because a link is often the
      // entire content of a message and a board that shows "the PR" with no
      // address is a board you have to go back to Slack to use.
      return label && label !== head ? `${label} (${head})` : head;
    }
    return whole;
  });

  return decodeEntities(out);
}

/** Any `{"type":"text"|"plain_text"|"mrkdwn","text":"…"}` inside a Block Kit tree. */
function blockText(node, depth = 0, out = []) {
  if (depth > MAX_BLOCK_DEPTH || out.length > 200) return out;
  if (Array.isArray(node)) {
    for (const child of node) blockText(child, depth + 1, out);
    return out;
  }
  if (!isObj(node)) return out;
  if (typeof node.text === 'string' && node.text) out.push(node.text);
  for (const value of Object.values(node)) {
    if (Array.isArray(value) || isObj(value)) blockText(value, depth + 1, out);
  }
  return out;
}

/**
 * Everything a message says, wherever Slack put it.
 *
 * `text` is optional. A message sent with `blocks`, and most messages from
 * integrations, carry an empty `text` and everything real in `attachments[]` or
 * `blocks[]` — and those are precisely the messages a board exists to catch: a
 * failed deploy, a paged alert, an approval request. A reader that took only
 * `text` would show them as blank rows with a timestamp.
 *
 * `fallback` is used only when an attachment has neither title nor text,
 * because Slack fills it with a flattened copy of both and using it alongside
 * them prints everything twice.
 */
export function messageBody(msg, resolve = () => null) {
  const parts = [];
  const push = (s) => {
    const line = collapse(renderSlackText(s, resolve));
    if (line) parts.push(line);
  };

  push(msg?.text);

  for (const att of Array.isArray(msg?.attachments) ? msg.attachments : []) {
    if (!isObj(att)) continue;
    const has = collapse(att.title) || collapse(att.text) || collapse(att.pretext);
    if (has) {
      push(att.pretext);
      push(att.title);
      push(att.text);
    } else {
      push(att.fallback);
    }
  }

  if (!parts.length) for (const line of blockText(msg?.blocks)) push(line);

  for (const file of Array.isArray(msg?.files) ? msg.files : []) {
    if (!isObj(file)) continue;
    const name = collapse(file.title) || collapse(file.name);
    if (name) parts.push(`[file] ${name}`);
  }

  const replies = Number(msg?.reply_count);
  if (Number.isFinite(replies) && replies > 0) {
    // Said out loud because this connector does not fetch the replies; see the
    // header. A board that shows the parent of a nineteen-message argument as a
    // one-line question is lying by omission.
    parts.push(`(${replies} ${replies === 1 ? 'reply' : 'replies'} in thread — open it in Slack)`);
  }

  return parts.join('\n').slice(0, BODY_CHARS);
}

/* ---------------------------------------------------------- conversations */

/** `mpdm-dana--ali--nemo-1` is a name only a database could love. */
export function prettyName(conv) {
  const name = collapse(conv?.name);
  if (conv?.is_mpim && name.startsWith('mpdm-')) {
    const people = name.slice('mpdm-'.length).replace(/-\d+$/, '').split('--').filter(Boolean);
    if (people.length) return people.join(', ');
  }
  return name;
}

/** What the board files a row under: `#site-ops`, `@dana`, `dana, ali`. */
function folderFor(conv, resolve) {
  if (conv?.is_im) {
    const who = resolve(conv.user) || collapse(conv.user) || 'unknown';
    return `@${who}`;
  }
  if (conv?.is_mpim) return prettyName(conv) || 'group message';
  const name = prettyName(conv);
  return name ? `#${name}` : String(conv?.id ?? 'unknown');
}

/**
 * The `onlyChannels` test.
 *
 * One rule, stated once so it can be explained in a hint: the entry matches if
 * it equals the conversation's Slack name OR the folder the board shows, in
 * either case with a leading `#` or `@` removed and case ignored. So `site-ops`
 * finds `#site-ops` and `dana` finds the DM with `@dana`.
 */
const matchKey = (s) => collapse(s).replace(/^[#@]/, '').toLowerCase();

function wanted(only, conv, folder) {
  if (!only.length) return true;
  const keys = new Set([matchKey(conv?.name), matchKey(folder)].filter(Boolean));
  return only.some((entry) => keys.has(entry));
}

/**
 * Which conversations to read, in the order the cap cuts from the end of.
 *
 * `conversations.list` returns channels in an order Slack documents nothing
 * about, so a cap applied to it would silently include a different set of
 * channels on different days. Sorted here instead: direct messages first
 * (someone typed your name), then group DMs, then channels — with `sortKey`
 * below breaking the tie inside a rank. The cut is still arbitrary at the
 * boundary but it is STABLE, which is the property that makes "why is #zoning
 * missing" answerable — and the answer is `onlyChannels`, not a larger cap.
 */
function rank(conv) {
  if (conv?.is_im) return 0;
  if (conv?.is_mpim) return 1;
  return 2;
}

/**
 * The tiebreaker inside a rank, and it is deliberately NOT the display name.
 *
 * The cut used to be applied to a list sorted by `folder`, and a DM's folder is
 * `@dana` — which means the cut could not be decided until every IM in the
 * workspace had been named, one `users.info` each, BEFORE `onlyChannels` and
 * before `maxChannels`. Measured: 200 IMs, `onlyChannels: 'site-ops'`,
 * `maxChannels: 1` — 120 calls made, 118 of them `users.info`, zero
 * `conversations.history`, then a RateLimitError out of `collect`, so the 118
 * names it had just paid for were never even cached. A user token in a company
 * where you have DMed a hundred people could not read a message, ever.
 *
 * A partner's user id sorts just as arbitrarily as their display name and is
 * MORE stable — it is free, and it does not change when somebody edits their
 * profile, which the old key did. `readList` is re-sorted by folder once the
 * survivors have names, so the order the board and `ctx.emit` see is unchanged;
 * the only difference is WHICH conversations survive a cut that has more DMs
 * than `maxChannels`, and that was arbitrary before and is arbitrary now.
 */
function sortKey(conv) {
  if (conv?.is_im) return collapse(conv.user) || collapse(conv.id);
  return prettyName(conv) || collapse(conv.id);
}

/* ----------------------------------------------------------------- cursor */

/**
 * The shape written below, and the only shape `readCursor` will read back.
 *
 * It was written and never read, which made it decoration. It is branched on
 * now: `seen` and `users` are two hand-rolled encodings, and a future version
 * that changes either would be misread here as garbage that happens to
 * typecheck — see `validMark` for what a misread mark costs.
 */
export const CURSOR_VERSION = 1;

/**
 * A high-water mark that is really a Slack `ts`, and really in the past.
 *
 * `oldest` is sent to Slack verbatim and the reduce at the bottom of `collect`
 * only ever moves a mark UPWARD, so a mark that is too large is permanent: the
 * channel answers with nothing forever and the part reports `ok: true, count:
 * 0` — the exact shape of a quiet week, with no error on any surface. Three
 * ways to get one, all measured: a cursor written by a version that stored
 * milliseconds (`"1754899320001"` — Slack has no messages after the year
 * 57000), one that stored an ISO string (`Number(ts)` is NaN, so the mark never
 * advances and the full lookback is re-read every sweep forever), and a plain
 * bad value like `"99999999999.000000"`.
 *
 * So a mark is kept only if it looks like epoch seconds with Slack's optional
 * six decimals AND is not in the future. Anything else is dropped and the
 * channel re-reads from the lookback floor, which costs one call and inserts
 * nothing (every row upserts by a stable id). The five minutes of slack is for
 * clock skew between this machine and Slack's, not for a real future message.
 */
const TS_RE = /^\d{9,11}(\.\d{1,6})?$/;
const FUTURE_SLACK_MS = 5 * 60_000;

export function validMark(value, nowMs) {
  if (typeof value !== 'string' || !TS_RE.test(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n * 1000 <= nowMs + FUTURE_SLACK_MS;
}

/**
 * The cursor, trimmed until it will actually be stored.
 *
 * The order things are given up in is the order they are cheap to rebuild:
 * NAMES first (one `users.info` call each, and only for people who are still
 * talking), then the OLDEST high-water marks (re-reading a channel costs a call
 * and inserts nothing, because every row upserts by a stable id). The newest
 * marks — the channels being read right now — are the last thing to go.
 */
export function packCursor({ seen = {}, users = {}, usersAt = 0 } = {}, budget = CURSOR_CHAR_BUDGET) {
  const out = { v: CURSOR_VERSION, seen: { ...seen }, users: { ...users }, usersAt: Number(usersAt) || 0 };
  const size = () => JSON.stringify(out).length;

  const userIds = Object.keys(out.users);
  while (size() > budget && userIds.length) delete out.users[userIds.pop()];

  const oldestFirst = Object.keys(out.seen).sort((a, b) => Number(out.seen[a]) - Number(out.seen[b]));
  while (size() > budget && oldestFirst.length) delete out.seen[oldestFirst.shift()];

  return out;
}

/**
 * What came back from `kv` last time, with every field defended.
 *
 * `v` is BRANCHED ON rather than merely written. A cursor from a version this
 * one does not know is not partially trusted — `seen` and `users` are two
 * hand-rolled encodings and a future version that changes either would be read
 * here as garbage that happens to typecheck. Dropping it costs one sweep of
 * re-reading the lookback and inserts nothing; misreading it can black a
 * channel out permanently (see `validMark`).
 *
 * An entry in `users` whose value equals its own key is NOT a name. That is what
 * `resolveUser` caches when `users:read` is missing or a lookup fails, and
 * persisting it made the failure outlive its cause: measured, one sweep without
 * the scope wrote `{"U_DANA":"U_DANA"}`, the user added the scope and
 * reinstalled exactly as this file's own error text tells them to, and the next
 * sweep made ZERO `users.info` calls and still showed `@U_DANA` — for the seven
 * days until the whole cache aged out. Dropped on write AND on read, so a
 * cursor already carrying one recovers on the next sweep rather than in a week.
 */
function readCursor(raw, nowMs) {
  const cursor = isObj(raw) ? raw : {};
  const known = Number(cursor.v) === CURSOR_VERSION;
  const seen = known && isObj(cursor.seen) ? cursor.seen : {};
  const usersAt = known ? Number(cursor.usersAt) || 0 : 0;
  const fresh = usersAt && nowMs - usersAt < USER_CACHE_MAX_AGE_MS;
  const users = fresh && isObj(cursor.users) ? cursor.users : {};
  return {
    seen: Object.fromEntries(Object.entries(seen).filter(([, v]) => validMark(v, nowMs))),
    names: new Map(Object.entries(users).filter(([k, v]) => typeof v === 'string' && v && v !== k)),
    usersAt: fresh ? usersAt : 0,
  };
}

/* -------------------------------------------------------------- manifest */

export default {
  type: 'slack',
  family: 'slack',
  label: 'Slack',
  option: 'Slack workspace (a token you mint in your own workspace)',
  configKey: 'sources',
  sink: 'messages',

  credential: {
    label: 'Slack token',
    help: 'Create an app at api.slack.com/apps in YOUR workspace, give it the read scopes you want '
      + '(channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, '
      + 'im:read, mpim:read, users:read), install it for yourself, and paste the token — a user token '
      + 'starts xoxp-, a bot token xoxb-. Zelos has no Slack app of its own and never sees this token '
      + 'leave your machine.',
    url: 'https://api.slack.com/apps',
    required: true,
    /* Bearer, never a query parameter — core/connectors/index.mjs refuses
       `as: 'query'` and says why. Slack accepts the header on every Web API
       method, including the GET-with-parameters calls below. */
    send: { as: 'header', name: 'authorization', prefix: 'Bearer ' },
  },

  origins: [API.replace(/\/api$/, '')],

  fields: [
    {
      name: 'breadth',
      type: 'choice',
      label: 'How much of Slack to read',
      default: 'participating',
      choices: [
        { value: 'participating', label: 'Direct messages and the channels I am in' },
        { value: 'channels', label: 'The channels I am in — no direct messages' },
        { value: 'all', label: 'Every conversation the token can see' },
      ],
      hint: 'A token with channels:history can read every public channel in the workspace. '
        + 'The first option keeps Zelos to the conversations you are actually part of.',
    },
    {
      name: 'onlyChannels',
      type: 'text',
      label: 'Only these conversations',
      placeholder: 'site-ops, alerts, dana',
      hint: 'Comma-separated. A channel name without the #, or the name of the person for a DM. '
        + 'Leave blank to read everything the setting above allows.',
    },
    {
      name: 'lookbackDays',
      type: 'int',
      label: 'Days of history',
      default: 7,
      min: 1,
      max: 90,
      hint: 'How far back to go the first time, and the furthest back Zelos will ever reach after a gap.',
    },
    {
      name: 'maxChannels',
      type: 'int',
      label: 'Conversations to read',
      default: 20,
      min: 1,
      max: 100,
      hint: 'Each one costs at least one request. Direct messages come first, then group DMs, then channels by name.',
    },
    {
      name: 'maxPerChannel',
      type: 'int',
      label: 'Messages per conversation',
      default: 200,
      min: 1,
      max: 1000,
    },
  ],

  /**
   * Slack's ordinary published tiers, for the reason at the top of this file.
   *
   * `minGapMs` 1,200 is Tier 3's sustained rate (50 requests a minute) and is
   * the tightest thing a sweep does repeatedly — `conversations.history`, once
   * per channel. `conversations.list` is Tier 2 and stricter, but it is called
   * once or twice per sweep, not once per channel, so pacing everything to Tier
   * 2 would triple the wall-clock cost of a sweep to protect two calls.
   *
   * The budget is the real ceiling and it is deliberately about one sweep's
   * worth: an `auth.test`, a page or two of `conversations.list`, twenty
   * histories and up to forty first-time `users.info` calls is ~65, so 120 per
   * half hour covers a scheduled sweep plus a manual one and refuses a third.
   * It is persisted (core/connectors/http.mjs's `createMeter`), so a laptop that
   * sleeps and wakes ten times a day cannot spend it ten times over.
   */
  limits: {
    minIntervalMs: 5 * 60_000,
    minGapMs: 1_200,
    budget: { calls: 120, perMs: 30 * 60_000 },
    maxRows: 1_000,
  },

  /**
   * `zelos doctor`: whose token is this, and which workspace does it open?
   *
   * `auth.test` is the cheapest call Slack has and the only one that answers the
   * question a person actually has when a source is quiet — is this the token I
   * think it is, for the workspace I think it is. It needs no scope at all, so
   * it separates "the token is dead" from "the token is fine and is missing
   * channels:history", which are different sentences with different fixes.
   *
   * Failures are CAUGHT and returned rather than thrown: core/doctor.mjs turns a
   * throw into "That is a failure inside Zelos rather than in your settings",
   * which is the wrong thing to tell someone whose token expired.
   */
  async check(source, ctx) {
    try {
      const body = await slackGet(ctx, 'auth.test', {});
      const kind = body.bot_id ? 'bot token' : 'user token';
      const team = collapse(body.team) || collapse(body.team_id) || 'an unnamed workspace';
      const who = collapse(body.user) || collapse(body.user_id) || 'unknown';
      return {
        status: 'pass',
        detail: `${team} · ${who} (${collapse(body.user_id) || '?'}) · ${kind}`,
      };
    } catch (err) {
      return {
        status: 'fail',
        detail: `Slack: ${err?.message || String(err ?? 'the request failed')}`,
        action: err?.slackError === 'missing_scope'
          ? 'Add the scope at api.slack.com/apps → your app → OAuth & Permissions, reinstall it to your workspace, and paste the new token in Settings → Sources.'
          : 'Check the token in Settings → Sources. It must be a token from an app installed in your own workspace — a user token (xoxp-) or a bot token (xoxb-).',
      };
    }
  },

  /**
   * One part per conversation, for the same reason core/connectors/imap.mjs
   * emits one per mailbox: a private channel the token can list but not read
   * answers `not_in_channel`, and that must cost the user that channel rather
   * than the whole workspace.
   */
  async collect(ctx) {
    const settings = isObj(ctx.source?.settings) ? ctx.source.settings : {};
    const breadthKey = Object.hasOwn(BREADTHS, String(settings.breadth ?? '')) ? String(settings.breadth) : 'participating';
    const breadth = BREADTHS[breadthKey];
    const lookbackDays = clampInt(settings.lookbackDays, 1, 90, 7);
    const maxChannels = clampInt(settings.maxChannels, 1, 100, 20);
    const maxPerChannel = clampInt(settings.maxPerChannel, 1, 1000, 200);
    const only = String(settings.onlyChannels ?? '').split(',').map(matchKey).filter(Boolean);

    const nowMs = Date.parse(ctx.now) || Date.now();
    const prior = readCursor(ctx.cursor, nowMs);
    const names = prior.names;
    const state = { namesUnavailable: false, namesNeeded: '' };
    const resolve = (id) => names.get(String(id ?? '')) || null;
    const notes = [];

    /* `auth.test` first, and not only for the workspace name. `direction` is
       what the `promised` bucket is mined from — core/connectors/imap.mjs says
       the same thing about the Sent folder — and without knowing which `U…` is
       the token's own owner, every message Zelos reads looks incoming and half
       the board cannot exist. One call, no scope, and it turns a dead token into
       one clean AuthError instead of twenty channel failures. */
    const auth = await slackGet(ctx, 'auth.test', {});
    const selfUser = collapse(auth.user_id);
    const selfBot = collapse(auth.bot_id);

    /* `types` is asked for as one list, because that is one call. A token
       missing `im:read` fails the WHOLE call with `missing_scope` — not just the
       DM half — so the fallback asks for each type on its own and keeps
       whichever answer. Up to four calls, only ever on the failure path, and the
       user is told in a note which halves of their Slack are dark and why. */
    let conversations = [];
    /* Whether the list is the WHOLE list, which is what decides below whether a
       high-water mark for a channel that is not in it may be forgotten. Two ways
       to lose it: a refused scope, and the paging ceiling. */
    let listComplete = true;
    let listTruncated = false;
    try {
      conversations = await paginate(
        ctx,
        'conversations.list',
        { types: breadth.types.join(','), exclude_archived: 'true', limit: LIST_PAGE },
        (b) => b.channels,
        { maxPages: MAX_LIST_PAGES },
      );
      listTruncated = conversations.truncated === true;
      listComplete = !listTruncated;
    } catch (err) {
      if (err.slackError !== 'missing_scope') throw err;
      const refused = [];
      for (const type of breadth.types) {
        try {
          const page = await paginate(
            ctx,
            'conversations.list',
            { types: type, exclude_archived: 'true', limit: LIST_PAGE },
            (b) => b.channels,
            { maxPages: MAX_LIST_PAGES },
          );
          if (page.truncated === true) listTruncated = true;
          conversations.push(...page);
        } catch (inner) {
          if (inner instanceof AuthError || inner instanceof RateLimitError) throw inner;
          if (inner.slackError !== 'missing_scope') throw inner;
          refused.push(type);
        }
      }
      if (refused.length === breadth.types.length) throw err;
      listComplete = false;
      notes.push(`Slack would not list ${refused.join(', ')} — this token is missing ${collapse(err.slackNeeded) || 'a read scope'}.`);
    }

    if (listTruncated) {
      /* Said out loud, because line 795's note already answers the same
         question for the other cut. Without it, an Enterprise Grid workspace
         over the ceiling gets `maxChannels` applied to an arbitrary 2,000-entry
         prefix of an order Slack documents nothing about — so which channels
         are read can change between sweeps for a reason `onlyChannels` cannot
         explain, and nothing on any surface says so. */
      notes.push(`Slack has more conversations than Zelos will page through (${MAX_LIST_PAGES * LIST_PAGE}), so this is a prefix of the workspace — name the ones you want in “Only these conversations”.`);
    }

    /* WHICH CONVERSATIONS, AND WHOSE NAMES GET PAID FOR.
       Filter and cap FIRST, resolve names SECOND — see `sortKey` for the 118
       wasted `users.info` calls that ordering used to cost. The only reason a
       DM needs a name before the cut is `onlyChannels`, and that is bounded
       here: selection may never cost more calls than reading costs. */
    const eligible = conversations
      .filter((conv) => isObj(conv) && collapse(conv.id))
      .filter((conv) => !conv.is_archived)
      .filter((conv) => !breadth.membersOnly || conv.is_im || conv.is_mpim || conv.is_member === true)
      .sort((a, b) => rank(a) - rank(b) || sortKey(a).localeCompare(sortKey(b)));

    let lookups = 0;
    const chosen = [];
    for (const conv of eligible) {
      /* A name is bought only when it is the ONLY thing that can decide this
         conversation: the user narrowed by name, this is a DM, the partner is
         not already in the cursor's cache, and no cheaper key (the channel
         name, or the partner's raw id — `folderFor` renders an unresolved DM as
         `@U04ABCDEF`, which `matchKey` reduces to the id) has matched already. */
      const needsName = only.length && conv.is_im && conv.user
        && !names.has(collapse(conv.user))
        && !wanted(only, conv, folderFor(conv, resolve));
      if (needsName && lookups < maxChannels) {
        lookups += 1;
        await resolveUser(ctx, conv.user, names, state);
      }
      const folder = folderFor(conv, resolve);
      if (wanted(only, conv, folder)) chosen.push({ conv, folder });
    }

    if (chosen.length > maxChannels) {
      notes.push(`${chosen.length} conversations matched and Zelos read the first ${maxChannels}.`);
    }
    const readList = chosen.slice(0, maxChannels);

    /* The names the BOARD needs — a DM has no folder without one — bought now
       that the cut has happened, so this costs at most `maxChannels` calls and
       usually far fewer (the survivors of the loop above are already cached).
       Then re-sorted by folder, which is the order the user reads and the order
       `ctx.emit` reports; the cut above was decided on ids for cost, not for
       presentation. */
    for (const entry of readList) {
      const partner = entry.conv.is_im ? collapse(entry.conv.user) : '';
      if (partner && !names.has(partner)) {
        await resolveUser(ctx, partner, names, state);
        entry.folder = folderFor(entry.conv, resolve);
      }
    }
    readList.sort((a, b) => rank(a.conv) - rank(b.conv) || a.folder.localeCompare(b.folder));

    const floorTs = isoToTs(new Date(nowMs - lookbackDays * 86_400_000).toISOString());
    const parts = [];
    /* SEEDED FROM WHAT WAS ALREADY KNOWN, not empty.
       This object is the whole cursor, so anything missing from it at the end is
       forgotten — and the loop below reaches only the conversations it gets
       through. Starting it empty meant a rate limit, an abort, or one channel's
       error threw away the marks of every conversation the loop did not reach,
       which made the sweep AFTER a throttle strictly more expensive than the one
       that was throttled: measured with four primed marks and Slack refusing the
       second channel, the stored cursor came back holding one, and the next
       sweep asked the other three for the full `lookbackDays` window again. On a
       genuinely throttled workspace that never converges. `packCursor` already
       trims oldest-first if this grows past what will store. */
    const seen = { ...prior.seen };
    let rateLimited = null;

    for (let i = 0; i < readList.length; i += 1) {
      if (ctx.signal?.aborted === true) break;
      const { conv, folder } = readList[i];
      const channelId = collapse(conv.id);
      ctx.emit?.(`${ctx.label}: ${folder}`, i + 1, readList.length);

      /* `oldest` is the LATER of the high-water mark and the lookback floor. A
         source that has been switched off for a month would otherwise ask for a
         month of every channel on the first sweep back, on a rate-limited API,
         to satisfy a user who asked for seven days of history. Slack treats
         `oldest` as exclusive without `inclusive=true`, and the boundary message
         is harmless either way: the same `ts` produces the same row id, so a
         duplicate updates rather than inserts. */
      const mark = prior.seen[channelId];
      const oldest = mark && floorTs && Number(mark) > Number(floorTs) ? mark : floorTs;

      try {
        const items = await paginate(
          ctx,
          'conversations.history',
          { channel: channelId, oldest, limit: HISTORY_PAGE },
          (b) => b.messages,
          { maxPages: MAX_HISTORY_PAGES, stop: (all) => all.length >= maxPerChannel },
        );

        const usable = items
          .filter((msg) => isObj(msg) && collapse(msg.ts))
          .filter((msg) => !NOISE_SUBTYPES.has(String(msg.subtype ?? '')));
        const kept = usable.slice(0, maxPerChannel);

        /* THE CUT IS SAID, NOT REPAIRED. `conversations.history` is newest-first
           and the mark below is the newest ts seen, so whatever the cap drops
           here is the oldest tail of the window and is never asked for again.
           Measured: three messages, `maxPerChannel: 2`, the first sweep kept
           the two newest and reported a clean read; the second asked with
           `oldest` = the newest ts and got nothing. The first sweep of a busy
           channel with a seven-day lookback is the ordinary case. The tail is
           the least relevant slice for a board that triages what is current,
           and backfilling it would spend the 120-calls-per-half-hour budget
           re-reading old traffic — so the only change is that the part says
           so, and names the setting that moves the line. It rides on this part
           because this part has rows; on a rows-less one it would read as a
           failed source (see the cap note below), so a cut that kept nothing
           stays unsaid rather than red. */
        const capped = kept.length > 0 && (usable.length > maxPerChannel || items.truncated === true);
        const capNote = capped
          ? `${folder} had more than ${maxPerChannel.toLocaleString('en-US')} messages since the last read; Zelos kept the newest ${kept.length.toLocaleString('en-US')} and skipped the rest — raise “Messages per conversation” if that matters.`
          : null;

        // Every author and every mention, resolved once, before anything is
        // rendered — see `renderSlackText` on why the renderer cannot await.
        for (const msg of kept) {
          if (msg.user) await resolveUser(ctx, msg.user, names, state);
          for (const m of String(msg.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)) {
            await resolveUser(ctx, m[1], names, state);
          }
        }

        const direct = conv.is_im === true || conv.is_mpim === true;
        const rows = kept.map((msg) => messageRow(msg, { channelId, folder, resolve, selfUser, selfBot, direct }));

        /* The high-water mark is the newest `ts` SEEN, not the newest kept: a
           channel whose last fortnight is entirely join notices would otherwise
           never advance and would be re-read in full on every sweep forever. */
        const newest = items.reduce((max, msg) => {
          const ts = collapse(msg?.ts);
          return ts && (!max || Number(ts) > Number(max)) ? ts : max;
        }, mark || '');
        if (newest) seen[channelId] = newest;

        parts.push({ label: folder, rows, error: null, note: capNote });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err instanceof RateLimitError) {
          /* Stop, and keep everything already read — rethrowing would throw away
             twelve channels that arrived in order to report the thirteenth.
             What this does NOT do is claim the backoff has been handled: an HTTP
             429 closes out the persisted budget window inside `ctx.http`, but
             the 200-with-`{ok:false,error:"ratelimited"}` form is synthesised by
             `slackFailure` above and never touches the meter, so a run that
             swallows one leaves core/sweep.mjs recording `notBefore: 0` with the
             rest of the budget open. Measured: `"spent":5` of 120 after a
             throttle. So the swallow is worth it only when something was
             actually read; when nothing was, it is pure loss, and the error is
             propagated below so the host can rest the source. */
          rateLimited = err;
          break;
        }
        parts.push({ label: folder, rows: [], error: err, note: null });
      }
    }

    /* A throttle that cost the whole sweep is a failure, not a quiet result:
       nothing was read, so there is nothing to protect by swallowing it, and
       the sweep's `notBefore` is worth more than a part that says zero. */
    if (rateLimited && !parts.length) throw rateLimited;

    if (rateLimited) {
      notes.push(`Slack rate limited this token part-way through — ${parts.length} of ${readList.length} conversations were read. The rest arrive on the next sweep.`);
    }
    if (state.namesUnavailable) {
      notes.push(`Names are shown as Slack ids: this token is missing ${state.namesNeeded || 'users:read'}.`);
    }
    if (notes.length) {
      /* A note on a ROWS-LESS part reads as a failure. core/sweep.mjs:724 sets
         `ok: !note` and `count: kept.length`, so "25 conversations matched and
         Zelos read the first 20" — nothing wrong, the cap doing exactly its job
         — measured as `sourcesOk: 20, sourcesFailed: 1` with a zero count: a red
         Slack on the Now banner, forever, on an ordinary configuration. Carried
         by the last part that has rows it is instead the shape core/sweep.mjs
         :713 documents for a truncated calendar and core/connectors/folder.mjs
         :694 already emits — a non-zero count with `ok: false`, "neither a
         success nor a failure". A part of its own only when there is no such
         part, which is the case where zero really is the whole story. */
      const text = notes.join(' ');
      const carrier = [...parts].reverse().find((p) => !p.error && p.rows.length);
      if (carrier) carrier.note = carrier.note ? `${carrier.note} ${text}` : text;
      else parts.push({ label: '', rows: [], error: null, note: text });
    }

    /* A READ OF ZERO IS A RESULT AND HAS TO BE REPORTED AS ONE.
       core/sweep.mjs:703 iterates `result?.parts || []`, so an empty array
       pushes nothing into `sources[]` at all. Measured end to end with a healthy
       token and `conversations.list` answering `{ok:true, channels: []}`:
       `stats.sources` came back `[]`, `sourcesOk` 0, `sourcesFailed` 0 — the
       source absent from the run record, from /api/state, from the Now banner
       and from the settings export, not ok, not failed, no count. That is the
       single most common first-run state there is (a bot token not yet invited
       to a channel), plus a typo in `onlyChannels` and `breadth: channels` on a
       token whose only conversations are DMs. core/connectors/github.mjs:658 and
       core/connectors/rss.mjs:186 both emit an empty part for this reason. */
    if (!parts.length) parts.push({ label: '', rows: [], error: null, note: null });

    /* A mark is dropped only when its conversation is genuinely GONE — absent
       from a listing that could have contained it. Dropping the ones merely not
       read this sweep is what cost the marks above; dropping the ones a missing
       scope or a paging ceiling hid would cost them the same way by a different
       route, so `listComplete` gates it — and so does the breadth, because a
       mark carries no type: `breadth: 'channels'` asks for no `im` at all, so
       every DM would look gone and switching the setting back would re-read a
       week of each. `packCursor` is what bounds the growth. */
    const askedForEverything = breadth.types.length === BREADTHS.all.types.length;
    if (listComplete && askedForEverything) {
      const live = new Set(conversations.map((conv) => collapse(conv?.id)).filter(Boolean));
      for (const id of Object.keys(seen)) if (!live.has(id)) delete seen[id];
    }

    /* An id cached as its own name is a FAILURE, not a name, and persisting one
       outlives its cause: see `readCursor`. Dropped here so the sweep after the
       user adds `users:read` looks the person up again. */
    const users = Object.fromEntries(
      [...names.entries()].filter(([id, name]) => name !== id).slice(-USER_CACHE_MAX),
    );
    return {
      parts,
      cursor: packCursor({ seen, users, usersAt: prior.usersAt || nowMs }),
    };
  },
};

/**
 * One Slack message -> one `messages` row (core/db.mjs:12, `upsertMessage` :380).
 *
 * NO `uid` KEY, EVER. `upsertMessage` reads
 * `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` stores 0
 * and an omitted uid stores null — two different `messageRowId`s for one
 * message. A release that flipped between them would re-insert every Slack
 * message it has ever seen on every sweep: `stats.newMessages` never settles,
 * `shouldRunFull` forces a full run each time, and the user is billed for a
 * model call every thirty minutes. A Slack `ts` is not an integer and this row
 * has no integer identity, so the key is absent rather than nulled.
 *
 * `messageId` is `slack:<channel>:<ts>`, which is Slack's own primary key for a
 * message and never changes. It is not qualified by team: two workspaces are two
 * `sources[]` entries with different ids, and `messageRowId` already mixes the
 * source id in.
 */
function messageRow(msg, { channelId, folder, resolve, selfUser, selfBot, direct = false }) {
  const ts = collapse(msg.ts);
  const threadTs = collapse(msg.thread_ts);
  const body = messageBody(msg, resolve);
  const authorId = collapse(msg.user);
  const mine = (selfUser && authorId === selfUser) || (selfBot && collapse(msg.bot_id) === selfBot);

  const author = authorId
    ? (resolve(authorId) || authorId)
    : (collapse(msg.username) || collapse(msg.bot_profile?.name) || (msg.bot_id ? 'a Slack app' : folder));

  const firstLine = collapse(body.split('\n')[0]);
  const subject = firstLine
    ? (firstLine.length > SUBJECT_CHARS ? `${firstLine.slice(0, SUBJECT_CHARS - 1)}…` : firstLine)
    : `Message in ${folder}`;

  return {
    messageId: `slack:${channelId}:${ts}`,
    /* A Slack thread IS `thread_ts`, and it is namespaced with the channel
       because `messagesInThread` (core/db.mjs:448) matches `thread_key` across
       every source in the database — an unqualified `1754899320.001700` is a
       string a feed guid could collide with.

       WHAT A MESSAGE OUTSIDE A THREAD BELONGS TO, which is most of Slack.
       Slack sets `thread_ts` only inside an explicit thread, so this used to
       fall back to the message's own `ts` — one thread per message. A DM IS the
       conversation, and that fallback made the connector's own reason for
       existing false. Measured on a four-message DM ("When can I expect the
       shop drawings?" / "I will have them to you Thursday." / "Thursday
       works."): four distinct thread keys, so core/triage.mjs:537's
       `threadIndex` gave every one of them `count: 1`, which makes
       `thread.latest === msg` unconditionally true — `+14 "nobody answered"`
       (:628) on EVERY message the user has ever sent in Slack, forever,
       regardless of the reply that came a second later, and a permanently false
       `hasOutbound` so a real back-and-forth never earns the `+4 "a
       conversation, not a cold arrival"`. The `promised` bucket this file's
       header says `direction` exists to feed was mined from an index that
       thought every answered promise was unanswered.

       So a DM or group DM threads on the CHANNEL. A public or private channel
       keeps the per-message fallback: #general is not one conversation, and
       collapsing a busy channel into a single thread would make its newest
       message the "latest" of everything anyone said in it. */
    threadKey: threadTs
      ? `slack:${channelId}:${threadTs}`
      : (direct ? `slack:${channelId}` : `slack:${channelId}:${ts}`),
    folder,
    direction: mine ? 'out' : 'in',
    from: { name: author, email: '' },
    to: [],
    cc: [],
    subject,
    date: tsToISO(ts),
    snippet: collapse(body).slice(0, SNIPPET_CHARS),
    text: body,
    hasAttachments: Array.isArray(msg.files) ? msg.files.length > 0 : false,
    /* The same convention core/sample-data.mjs:178 uses, because it is the
       vocabulary core/triage.mjs:433 scores against: what you wrote yourself is
       read, and what arrived is not. Flagging our own messages unread would give
       every one of them the +8 "unread" bump and fill `now` with the user's own
       remarks. `conversations.history` does not report per-message read state,
       so there is no third answer to give here. */
    flags: mine ? ['\\Seen'] : [],
    /* Deliberately no `uid`. See the note above this function. */
  };
}
