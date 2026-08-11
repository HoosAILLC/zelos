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
 */
async function paginate(ctx, method, params, pick, { maxPages, stop = () => false }) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const body = await slackGet(ctx, method, cursor ? { ...params, cursor } : params);
    const chunk = pick(body);
    if (Array.isArray(chunk)) out.push(...chunk);
    if (stop(out)) break;
    const next = String(body?.response_metadata?.next_cursor ?? '');
    if (!next || next === cursor) break;
    cursor = next;
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
 * (someone typed your name), then group DMs, then channels alphabetically. The
 * cut is still arbitrary at the boundary but it is STABLE, which is the property
 * that makes "why is #zoning missing" answerable — and the answer is
 * `onlyChannels`, not a larger cap.
 */
function rank(conv) {
  if (conv?.is_im) return 0;
  if (conv?.is_mpim) return 1;
  return 2;
}

/* ----------------------------------------------------------------- cursor */

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
  const out = { v: 1, seen: { ...seen }, users: { ...users }, usersAt: Number(usersAt) || 0 };
  const size = () => JSON.stringify(out).length;

  const userIds = Object.keys(out.users);
  while (size() > budget && userIds.length) delete out.users[userIds.pop()];

  const oldestFirst = Object.keys(out.seen).sort((a, b) => Number(out.seen[a]) - Number(out.seen[b]));
  while (size() > budget && oldestFirst.length) delete out.seen[oldestFirst.shift()];

  return out;
}

/** What came back from `kv` last time, with every field defended. */
function readCursor(raw, nowMs) {
  const cursor = isObj(raw) ? raw : {};
  const seen = isObj(cursor.seen) ? cursor.seen : {};
  const usersAt = Number(cursor.usersAt) || 0;
  const fresh = usersAt && nowMs - usersAt < USER_CACHE_MAX_AGE_MS;
  const users = fresh && isObj(cursor.users) ? cursor.users : {};
  return {
    seen: Object.fromEntries(Object.entries(seen).filter(([, v]) => typeof v === 'string' && v)),
    names: new Map(Object.entries(users).filter(([, v]) => typeof v === 'string' && v)),
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
    try {
      conversations = await paginate(
        ctx,
        'conversations.list',
        { types: breadth.types.join(','), exclude_archived: 'true', limit: LIST_PAGE },
        (b) => b.channels,
        { maxPages: MAX_LIST_PAGES },
      );
    } catch (err) {
      if (err.slackError !== 'missing_scope') throw err;
      const refused = [];
      for (const type of breadth.types) {
        try {
          conversations.push(...await paginate(
            ctx,
            'conversations.list',
            { types: type, exclude_archived: 'true', limit: LIST_PAGE },
            (b) => b.channels,
            { maxPages: MAX_LIST_PAGES },
          ));
        } catch (inner) {
          if (inner instanceof AuthError || inner instanceof RateLimitError) throw inner;
          if (inner.slackError !== 'missing_scope') throw inner;
          refused.push(type);
        }
      }
      if (refused.length === breadth.types.length) throw err;
      notes.push(`Slack would not list ${refused.join(', ')} — this token is missing ${collapse(err.slackNeeded) || 'a read scope'}.`);
    }

    // DM partners have to be named before `onlyChannels` can be matched against
    // them, and before the board has a folder to file the rows under.
    for (const conv of conversations) {
      if (conv?.is_im && conv.user) await resolveUser(ctx, conv.user, names, state);
    }

    const chosen = conversations
      .filter((conv) => isObj(conv) && collapse(conv.id))
      .filter((conv) => !conv.is_archived)
      .filter((conv) => !breadth.membersOnly || conv.is_im || conv.is_mpim || conv.is_member === true)
      .map((conv) => ({ conv, folder: folderFor(conv, resolve) }))
      .filter(({ conv, folder }) => wanted(only, conv, folder))
      .sort((a, b) => rank(a.conv) - rank(b.conv) || a.folder.localeCompare(b.folder));

    if (chosen.length > maxChannels) {
      notes.push(`${chosen.length} conversations matched and Zelos read the first ${maxChannels}.`);
    }
    const readList = chosen.slice(0, maxChannels);

    const floorTs = isoToTs(new Date(nowMs - lookbackDays * 86_400_000).toISOString());
    const parts = [];
    const seen = {};
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

        const kept = items
          .filter((msg) => isObj(msg) && collapse(msg.ts))
          .filter((msg) => !NOISE_SUBTYPES.has(String(msg.subtype ?? '')))
          .slice(0, maxPerChannel);

        // Every author and every mention, resolved once, before anything is
        // rendered — see `renderSlackText` on why the renderer cannot await.
        for (const msg of kept) {
          if (msg.user) await resolveUser(ctx, msg.user, names, state);
          for (const m of String(msg.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)) {
            await resolveUser(ctx, m[1], names, state);
          }
        }

        const rows = kept.map((msg) => messageRow(msg, { channelId, folder, resolve, selfUser, selfBot }));

        /* The high-water mark is the newest `ts` SEEN, not the newest kept: a
           channel whose last fortnight is entirely join notices would otherwise
           never advance and would be re-read in full on every sweep forever. */
        const newest = items.reduce((max, msg) => {
          const ts = collapse(msg?.ts);
          return ts && (!max || Number(ts) > Number(max)) ? ts : max;
        }, mark || '');
        if (newest) seen[channelId] = newest;

        parts.push({ label: folder, rows, error: null, note: null });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err instanceof RateLimitError) {
          /* Stop, keep everything already read, and keep the marks for it. The
             alternative — rethrowing — throws away twelve channels that arrived
             to report the thirteenth, and buys a `notBefore` this connector does
             not need: `ctx.http` has already closed out the persisted budget
             window, which is the same backoff by a slower road. */
          rateLimited = err;
          break;
        }
        parts.push({ label: folder, rows: [], error: err, note: null });
      }
    }

    if (rateLimited) {
      notes.push(`Slack rate limited this token part-way through — ${parts.length} of ${readList.length} conversations were read. The rest arrive on the next sweep.`);
    }
    if (state.namesUnavailable) {
      notes.push(`Names are shown as Slack ids: this token is missing ${state.namesNeeded || 'users:read'}.`);
    }
    if (notes.length) parts.push({ label: '', rows: [], error: null, note: notes.join(' ') });

    /* Only the conversations read this time survive into the cursor. A channel
       the user removed from `onlyChannels` keeps a mark forever otherwise, and
       the cursor grows monotonically towards the ceiling that silently drops it. */
    const users = Object.fromEntries([...names.entries()].slice(-USER_CACHE_MAX));
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
function messageRow(msg, { channelId, folder, resolve, selfUser, selfBot }) {
  const ts = collapse(msg.ts);
  const threadTs = collapse(msg.thread_ts) || ts;
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
       string a feed guid could collide with. A message outside a thread threads
       with itself, which is what `ts` already is. */
    threadKey: `slack:${channelId}:${threadTs}`,
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
