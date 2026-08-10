/**
 * core/sweep.mjs — the run loop.
 *
 * A sweep is: fetch every enabled source in parallel, persist what came back,
 * decide whether this run has to think, think if so, merge the result, and
 * record what happened. The two properties that matter more than speed:
 *
 *   ISOLATION. One dead IMAP host, one expired calendar URL, one account with
 *   no stored password — none of those may cost the user the rest of the run.
 *   Every source is fetched inside its own try/catch and reports its own
 *   outcome, and the run's `ok` reflects whether the run *worked*, not whether
 *   every source was reachable. A partial board beats an error page.
 *
 *   HONESTY ABOUT COST. A full run calls the model; a light run does not. The
 *   light/full decision is made from what is actually new, not from a timer, so
 *   a quiet afternoon costs nothing and a busy morning is re-thought.
 *
 * Nothing here ever acts on message or model content: text is fetched, stored,
 * rendered into a prompt and rendered into rows. No eval, no exec, no fetch of
 * anything a message asked for.
 */

import fs from 'node:fs/promises';

import { loadConfig } from './config.mjs';
import { complete as llmComplete, extractJSON, LLMError } from './llm.mjs';
import { getSecret as realGetSecret } from './secrets.mjs';
import { fetchRecent } from './sources/imap.mjs';
import { parseICS_toEvents } from './sources/ics.mjs';
import { fetchRange as caldavFetchRange } from './sources/caldav.mjs';
import {
  upsertMessages,
  upsertEvents,
  listMessages,
  listEvents,
  listCaptures,
  markCaptureProcessed,
  listBoard,
  bucketCounts,
  startRun,
  finishRun,
  lastRun,
  getKV,
  setKV,
  getItem,
  withTransaction,
} from './db.mjs';
import { buildSweepPrompt, mergeSweep, SWEEP_KV } from './triage.mjs';
import { SAMPLE_SOURCE_ID, SAMPLE_CALENDAR_ID, SAMPLE_MARK } from './sample-data.mjs';
import {
  nowISO,
  instant,
  toZonedISO,
  wallClock,
  dayKey,
  addDaysToKey,
  localTimezone,
} from './time.mjs';
import { log } from './log.mjs';

const slog = log.child('[sweep]');

/** A full run is forced after this long regardless of how quiet things were. */
export const FULL_RUN_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/** Calendar window fetched and stored, relative to now. */
const CALENDAR_BACK_DAYS = 7;
const CALENDAR_FORWARD_DAYS = 60;

/** How much history the prompt draws on, independent of what a fetch returned. */
const PROMPT_LOOKBACK_DAYS = 21;
const PROMPT_MESSAGE_LIMIT = 600;

/**
 * How many items may sit in `now` on the persisted board.
 *
 * The same four core/safety.mjs allows in a single reply, and it is the same
 * number for a reason: the promise the product makes is about the board the user
 * opens, not about one exchange with a model.
 */
const NOW_BOARD_LIMIT = 4;

/**
 * How many finished items are named back to the model as already handled.
 *
 * The window they are drawn from is PROMPT_LOOKBACK_DAYS, the prompt's own mail
 * lookback, and that is the whole justification for the number: the only way a
 * closed item comes back is for the model to read the mail that produced it and
 * write it up again, and no mail older than that window is in front of it. A
 * resolution older than the oldest message in the prompt cannot be re-raised from
 * that message, so paying context for it would buy nothing. Forty is a ceiling on
 * a busy fortnight, not a target; the prompt's budget trims further if it has to.
 */
const RESOLVED_LIMIT = 40;

const ICS_TIMEOUT_MS = 20_000;
const ICS_MAX_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const isEnabled = (x) => !!x && x.enabled !== false;

function activeHoursOf(config) {
  const raw = config?.sweep?.activeHours;
  if (Array.isArray(raw) && raw.length === 2) {
    const start = Number(raw[0]);
    const end = Number(raw[1]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 && start < end) {
      return [start, end];
    }
  }
  return [6, 23];
}

function intervalMinutesOf(config) {
  const n = Number(config?.sweep?.intervalMinutes);
  if (!Number.isFinite(n)) return 30;
  return Math.min(1440, Math.max(5, Math.round(n)));
}

function timezoneOf(config) {
  const tz = config?.identity?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz : localTimezone();
}

/**
 * The instant at which `hour:00` falls on the day `ms` lands on in `tz`,
 * optionally shifted by whole days.
 *
 * Built by rewriting the time portion of a zoned ISO string rather than by
 * arithmetic on a Date, because the offset is only correct for the day it was
 * read from. Across a DST boundary the first guess can land an hour out, so the
 * result is re-read in the zone and corrected once — twice is never needed for a
 * one-hour transition, and a zone with a stranger rule still lands within an hour.
 */
function atHourInZone(ms, hour, tz, dayShift = 0) {
  const w = wallClock(toZonedISO(new Date(ms), tz));
  if (!w) return ms;
  const pad = (n) => String(n).padStart(2, '0');
  let key = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  if (dayShift) key = addDaysToKey(key, dayShift) || key;
  const guess = Date.parse(`${key}T${pad(hour)}:00:00${w.offset || 'Z'}`);
  if (Number.isNaN(guess)) return ms;
  const check = wallClock(toZonedISO(new Date(guess), tz));
  if (check && check.hour !== hour) return guess + (hour - check.hour) * 3_600_000;
  return guess;
}

/**
 * When the next automatic sweep is due: one interval from `now`, pushed forward
 * to the next moment inside the active hours if that lands outside them.
 * -> ISO8601 string carrying the user's offset.
 */
export function nextRunAt(config, now = nowISO()) {
  const tz = timezoneOf(config);
  const [startHour, endHour] = activeHoursOf(config);
  const base = instant(now) ?? Date.now();
  let t = base + intervalMinutesOf(config) * 60_000;

  const hourAt = (ms) => wallClock(toZonedISO(new Date(ms), tz))?.hour ?? 0;
  const h = hourAt(t);
  if (h < startHour) t = atHourInZone(t, startHour, tz);
  else if (h >= endHour) t = atHourInZone(t, startHour, tz, 1);

  return toZonedISO(new Date(t), tz);
}

/** True when `now` sits inside the configured active hours. */
export function isActiveHour(config, now = nowISO()) {
  const [startHour, endHour] = activeHoursOf(config);
  const w = wallClock(now);
  if (!w) return true;
  return w.hour >= startHour && w.hour < endHour;
}

/**
 * Light or full?
 *
 * Full when the model has something new to think about — mail or events that
 * were *inserted* since the last successful full run, or a note the user typed
 * that has not been triaged — or when the last full run is old enough that the
 * world has moved on regardless.
 *
 * "New" deliberately means newly inserted rows, counted as they are stored, not
 * `fetched_at > lastRun`: every sweep re-touches `fetched_at` on every message
 * it re-reads, so a timestamp comparison would make every run a full run and the
 * light/full distinction would quietly stop existing.
 */
export function shouldRunFull(db, config, now = nowISO()) {
  const last = lastRun(db, { kind: 'full', okOnly: true });
  if (!last || !last.started_at) return true;

  if (Number(getKV(db, SWEEP_KV.pendingNew)) > 0) return true;
  if (listCaptures(db, { includeProcessed: false, limit: 1 }).length > 0) return true;

  const lastMs = instant(last.started_at);
  const nowMs = instant(now) ?? Date.now();
  if (lastMs === null) return true;
  return nowMs - lastMs >= FULL_RUN_MAX_AGE_MS;
}

function bumpPendingNew(db, n) {
  if (!n) return;
  const current = Number(getKV(db, SWEEP_KV.pendingNew)) || 0;
  setKV(db, SWEEP_KV.pendingNew, String(current + n));
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

/**
 * Read an .ics document over HTTP.
 *
 * At most one redirect is followed, and credentials are never carried across an
 * origin change — a calendar URL that redirects elsewhere must not hand that
 * host the user's password.
 */
async function fetchIcsText(rawUrl, { user, pass, signal, timeoutMs = ICS_TIMEOUT_MS } = {}) {
  const url = new URL(String(rawUrl).replace(/^webcal:/i, 'https:'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`calendar URL must be http, https or webcal (got ${url.protocol})`);
  }

  const headers = { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' };
  if (user) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}`;
  }

  const request = async (target, withAuth) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const sendHeaders = withAuth ? headers : { accept: headers.accept };
    return fetch(target, {
      headers: sendHeaders,
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
  };

  let res = await request(url, true);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) throw new Error(`calendar at ${url.host} redirected without a destination`);
    const next = new URL(location, url);
    const sameOrigin = next.origin === url.origin;
    res = await request(next, sameOrigin);
  }
  if (!res.ok) throw new Error(`calendar at ${url.host} returned ${res.status}`);

  const text = await res.text();
  if (text.length > ICS_MAX_BYTES) {
    throw new Error(`calendar at ${url.host} returned ${text.length} bytes — refusing to parse it`);
  }
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error(`calendar at ${url.host} did not return an iCalendar document`);
  }
  return text;
}

/** The default calendar reader: ics over http, CalDAV, or a local file. */
async function defaultFetchEvents({ calendar, pass, from, to, timezone, email, signal }) {
  const window = { from, to, tzid: timezone, email };

  if (calendar.kind === 'file') {
    const text = await fs.readFile(calendar.url, 'utf8');
    return parseICS_toEvents(text, window);
  }
  if (calendar.kind === 'caldav') {
    const docs = await caldavFetchRange({
      url: calendar.url,
      user: calendar.user,
      pass,
      from,
      to,
      signal,
    });
    const events = [];
    for (const doc of docs) events.push(...parseICS_toEvents(doc, window));
    return events;
  }
  const text = await fetchIcsText(calendar.url, { user: calendar.user, pass, signal });
  return parseICS_toEvents(text, window);
}

/**
 * The default mail reader: one IMAP connection per mailbox.
 *
 * `fetchRecent` has no cancellation of its own, so `signal` is not forwarded;
 * the caller checks it between mailboxes instead, and an abandoned connection is
 * closed by `fetchRecent`'s own `finally`.
 *
 * `requireTls` is forwarded deliberately, and `?? null` rather than `|| null`,
 * because the setting is three-valued: `false` is a standing permission to talk
 * to this one host in the clear, and collapsing it into "not set" would put the
 * requirement back on a Proton Bridge the user has already excused. An account
 * saved before the field existed has no value at all, which is what `null`
 * means — the client then decides from the host, as it always has.
 */
function defaultFetchMail({ account, mailbox, pass, sinceDays, limit, onProgress }) {
  return fetchRecent({
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.user,
    pass,
    requireTls: account.requireTls ?? null,
    mailbox,
    sinceDays,
    limit,
    onProgress,
  });
}

const DEFAULT_DEPS = Object.freeze({
  fetchMail: defaultFetchMail,
  fetchEvents: defaultFetchEvents,
  complete: llmComplete,
  getSecret: realGetSecret,
});

/**
 * Mailboxes to read for one account: the configured list plus the sent folder,
 * which is not optional — `promised` is mined from what the user themselves
 * wrote, and without the sent folder half the board cannot exist.
 */
function mailboxesFor(account) {
  const list = Array.isArray(account.mailboxes) && account.mailboxes.length
    ? account.mailboxes.filter((m) => typeof m === 'string' && m.trim())
    : ['INBOX'];
  const out = [...new Set(list)];
  const sent = typeof account.sentMailbox === 'string' ? account.sentMailbox.trim() : '';
  if (sent && !out.includes(sent)) out.push(sent);
  return out;
}

function directionOf(message, mailbox, account, identityEmail) {
  // Compared against the trimmed name, because that is what mailboxesFor asked for.
  if (mailbox === String(account.sentMailbox ?? '').trim()) return 'out';
  const from = String(message?.from?.email ?? '').toLowerCase();
  if (from && (from === String(identityEmail).toLowerCase() || from === String(account.user).toLowerCase())) {
    return 'out';
  }
  return 'in';
}

function errorText(err) {
  if (!err) return 'unknown error';
  if (err instanceof LLMError && err.address) return err.message;
  return err.message || String(err);
}

/* ------------------------------------------------------------------ *
 * runSweep
 * ------------------------------------------------------------------ */

/**
 * Run one sweep.
 *
 * -> {runId, ok, stats:{messages, events, items, now, tokensIn, tokensOut, ms}, error?}
 *
 * `deps` is a seam for tests and for the desktop shell: it replaces the mail
 * reader, the calendar reader, the model call and the secret lookup with
 * anything of the same shape. It defaults to the real modules, so production
 * callers pass `{db, config}` and nothing else.
 */
export async function runSweep({
  db,
  config = loadConfig(),
  mode = 'auto',
  onProgress,
  signal,
  deps = {},
} = {}) {
  if (!db) throw new TypeError('runSweep: a database handle is required');
  const { fetchMail, fetchEvents, complete, getSecret } = { ...DEFAULT_DEPS, ...deps };

  const startedMs = Date.now();
  const tz = timezoneOf(config);
  const now = nowISO(tz);
  const identityEmail = String(config?.identity?.email ?? '');

  const emit = (phase, message, done = 0, total = 0, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, message, done, total, ...extra });
    } catch (err) {
      // A listener that throws is the listener's problem, not the sweep's.
      slog.debug('onProgress listener threw', { error: err.message });
    }
  };

  const wantFull = mode === 'full' ? true : mode === 'light' ? false : shouldRunFull(db, config, now);
  const runId = startRun(db, { kind: wantFull ? 'full' : 'light', model: config?.model?.model ?? '', now });
  emit('start', wantFull ? 'Starting a full sweep' : 'Starting a light sweep', 0, 0, { runId });

  const sources = [];
  const stats = {
    messages: 0,
    events: 0,
    items: 0,
    now: 0,
    tokensIn: 0,
    tokensOut: 0,
    ms: 0,
    kind: wantFull ? 'full' : 'light',
    newMessages: 0,
    newEvents: 0,
    sourcesOk: 0,
    sourcesFailed: 0,
  };

  const abort = () => signal?.aborted === true;
  const finish = (ok, error, extra = {}) => {
    stats.ms = Date.now() - startedMs;
    const endedAt = nowISO(tz);
    finishRun(db, runId, {
      ok,
      error,
      tokensIn: stats.tokensIn,
      tokensOut: stats.tokensOut,
      stats: { ...stats, sources },
      now: endedAt,
    });
    // Spend is recorded whether or not the run succeeded. A run that failed
    // after the model answered — a reply that was cut off, or JSON that was not
    // a board — was still billed for every token of it, and that is precisely
    // the spend a user would be most surprised to find missing from the counter.
    // What a failed run does not add to is the run counts: it spent money and it
    // produced no board, and those are two different things to be honest about.
    recordTokens(db, {
      tokensIn: stats.tokensIn,
      tokensOut: stats.tokensOut,
      thought: stats.kind === 'full',
      ok,
      now: endedAt,
    });
    const result = { runId, ok, stats: { ...stats, sources }, ...extra };
    if (error) result.error = error;
    emit(ok ? 'done' : 'error', error || 'Sweep complete', 1, 1, { runId });
    return result;
  };

  /* ---- 1. fetch every source, in parallel, isolated ---------------- */

  emit('fetch', 'Reading mail and calendars', 0, 0);

  const mailAccounts = (Array.isArray(config.mail) ? config.mail : []).filter(isEnabled);
  const calendars = (Array.isArray(config.calendars) ? config.calendars : []).filter(isEnabled);

  const mailTasks = mailAccounts.map(async (account) => {
    const label = account.label || account.host || account.id;
    let pass = null;
    try {
      pass = account.keyRef ? await getSecret(account.keyRef) : null;
    } catch (err) {
      sources.push({ kind: 'mail', id: account.id, label, ok: false, count: 0, error: errorText(err) });
      return [];
    }
    if (!pass) {
      sources.push({
        kind: 'mail',
        id: account.id,
        label,
        ok: false,
        count: 0,
        error: `No password stored for ${label}. Add it in Settings — Zelos never writes it to disk in the clear.`,
      });
      return [];
    }

    const collected = [];
    // Mailboxes are read one at a time per account: they share a host, and
    // opening four IMAP connections to the same server at once is how a sweep
    // gets rate-limited or refused.
    for (const mailbox of mailboxesFor(account)) {
      if (abort()) break;
      try {
        const rows = await fetchMail({
          account,
          mailbox,
          pass,
          sinceDays: account.lookbackDays ?? 14,
          limit: account.maxMessages ?? 400,
          onProgress: (p) => emit('mail', `${label}: ${p.message}`, p.done, p.total),
          signal,
        });
        for (const row of rows || []) {
          collected.push({
            ...row,
            sourceId: account.id,
            direction: directionOf(row, mailbox, account, identityEmail),
          });
        }
        sources.push({
          kind: 'mail',
          id: account.id,
          label: `${label} / ${mailbox}`,
          ok: true,
          count: rows?.length ?? 0,
          error: null,
        });
      } catch (err) {
        slog.warn(`mail source failed: ${label} / ${mailbox}`, { error: errorText(err) });
        sources.push({
          kind: 'mail',
          id: account.id,
          label: `${label} / ${mailbox}`,
          ok: false,
          count: 0,
          error: errorText(err),
        });
      }
    }
    return collected;
  });

  const from = new Date(Date.now() - CALENDAR_BACK_DAYS * 86_400_000).toISOString();
  const to = new Date(Date.now() + CALENDAR_FORWARD_DAYS * 86_400_000).toISOString();

  const calendarTasks = calendars.map(async (calendar) => {
    const label = calendar.label || calendar.url || calendar.id;
    try {
      const pass = calendar.keyRef ? await getSecret(calendar.keyRef) : null;
      const events = await fetchEvents({
        calendar,
        pass,
        from,
        to,
        timezone: tz,
        email: identityEmail || null,
        signal,
      });
      const rows = (events || []).map((e) => ({ ...e, calendarId: calendar.id }));
      sources.push({ kind: 'calendar', id: calendar.id, label, ok: true, count: rows.length, error: null });
      emit('calendar', `${label}: ${rows.length} entries`, rows.length, rows.length);
      return rows;
    } catch (err) {
      slog.warn(`calendar source failed: ${label}`, { error: errorText(err) });
      sources.push({ kind: 'calendar', id: calendar.id, label, ok: false, count: 0, error: errorText(err) });
      return [];
    }
  });

  const [mailResults, calendarResults] = await Promise.all([
    Promise.all(mailTasks),
    Promise.all(calendarTasks),
  ]);
  const fetchedMessages = mailResults.flat();
  const fetchedEvents = calendarResults.flat();

  stats.sourcesOk = sources.filter((s) => s.ok).length;
  stats.sourcesFailed = sources.length - stats.sourcesOk;

  if (abort()) return finish(false, 'Sweep cancelled');

  /* ---- 2. persist ------------------------------------------------- */

  emit('persist', `Storing ${fetchedMessages.length} messages and ${fetchedEvents.length} events`,
    0, fetchedMessages.length + fetchedEvents.length);
  try {
    const m = upsertMessages(db, fetchedMessages, { now });
    const e = upsertEvents(db, fetchedEvents, { now });
    stats.messages = m.ids.length;
    stats.events = e.ids.length;
    stats.newMessages = m.inserted;
    stats.newEvents = e.inserted;
    bumpPendingNew(db, m.inserted + e.inserted);
  } catch (err) {
    slog.error('could not store fetched sources', { error: errorText(err) });
    return finish(false, `Could not store what was fetched: ${errorText(err)}`);
  }

  /* ---- 3. light or full ------------------------------------------- */

  let full = wantFull;
  if (!full && mode === 'auto' && stats.newMessages + stats.newEvents > 0) {
    // This fetch itself brought in something the model has never seen. Waiting a
    // whole interval to think about it is exactly the delay the product exists
    // to remove.
    full = true;
    stats.kind = 'full';
    setRunKind(db, runId, 'full');
    slog.debug('upgraded a light run to full', { runId, new: stats.newMessages + stats.newEvents });
  }

  if (!full) {
    const derived = recomputeDerived(db, { now });
    stats.items = derived.open;
    stats.now = derived.counts.now;
    return finish(true, null, { counts: derived.counts, modelCalls: 0 });
  }

  /* ---- 4. think --------------------------------------------------- */

  const promptInput = gatherPromptInput(db, config, now);
  const prompt = buildSweepPrompt({
    identity: config.identity ?? {},
    now,
    messages: promptInput.messages,
    events: promptInput.events,
    captures: promptInput.captures,
    priorItems: promptInput.priorItems,
    resolvedItems: promptInput.resolvedItems,
    privacy: config.privacy ?? {},
  });

  emit('think', `Asking ${config?.model?.label || 'the model'} to read ${promptInput.messages.length} messages`,
    0, 1, { approxChars: prompt.budget.approxChars });

  let apiKey = null;
  try {
    apiKey = config?.model?.keyRef ? await getSecret(config.model.keyRef) : null;
  } catch (err) {
    slog.debug('no API key available', { error: errorText(err) });
  }

  let answer;
  try {
    answer = await complete({
      protocol: config?.model?.protocol,
      baseUrl: config?.model?.baseUrl,
      model: config?.model?.model,
      apiKey,
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: config?.model?.maxTokens,
      temperature: config?.model?.temperature,
      json: true,
      signal,
    });
  } catch (err) {
    slog.error('model call failed', { error: errorText(err) });
    return finish(false, errorText(err));
  }

  stats.tokensIn = Number(answer?.usage?.input) || 0;
  stats.tokensOut = Number(answer?.usage?.output) || 0;

  const parsed = extractJSON(answer?.text ?? '');
  // extractJSON is deliberately forgiving, and one thing it forgives is a reply
  // that was cut off mid-board: the first *balanced* object inside a truncated
  // answer is usually some inner fragment — a single item, a stray
  // {"answer": …} — not the board. An object carrying none of the sweep's own
  // top-level keys is that fragment, and letting it through to the merge would
  // record a successful run that produced nothing. It is a failed parse, and is
  // reported as one.
  const looksLikeBoard =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    ('items' in parsed || 'first' in parsed || 'notes' in parsed);
  if (!looksLikeBoard) {
    const sample = String(answer?.text ?? '').slice(0, 200).replace(/\s+/g, ' ');
    if (answer?.stopReason === 'length') {
      // The reply was cut off at the token ceiling, so no model swap will fix
      // it — the same model with more room will.
      return finish(
        false,
        `The model's reply was cut off at its token limit before the board was complete${sample ? ` — it began "${sample}"` : ''}. Raise model.maxTokens in Settings and sweep again.`,
      );
    }
    return finish(
      false,
      parsed
        ? 'The model replied with JSON, but not with a board — none of items, first or notes were in it. Try a larger model, or one that follows a format instruction.'
        : `The model replied but not with JSON${sample ? ` — it began "${sample}"` : ''}. Try a larger model, or one that follows a format instruction.`,
    );
  }

  /* ---- 5. merge --------------------------------------------------- */

  emit('merge', 'Building the board', 0, 1);
  let merged;
  try {
    merged = mergeSweep(db, parsed, { runId, now });
  } catch (err) {
    slog.error('could not merge the sweep', { error: errorText(err) });
    return finish(false, `Could not store the board: ${errorText(err)}`);
  }

  // ok:false from the merge means the reply was not usable as a sweep result at
  // all — repairs are normal and keep ok:true, this is the reply that had no
  // usable items in it. Recording that as success would be worse than the
  // failure itself: the captures below would be consumed untriaged and
  // pendingNew zeroed, so the mail that prompted this run would never be
  // re-thought. The run fails, nothing is consumed, and the next run tries again.
  if (!merged.ok) {
    slog.error('model reply was not a usable board', {
      runId,
      first: merged.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`),
    });
    const why = merged.errors.slice(0, 2)
      .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
      .join('; ') || 'the reply was not a usable board';
    if (answer?.stopReason === 'length') {
      return finish(
        false,
        `The model's reply was cut off at its token limit before the board was usable (${why}). Raise model.maxTokens in Settings and sweep again.`,
      );
    }
    return finish(
      false,
      `The model's reply was not a usable board (${why}). Try a larger model, or one that follows a format instruction.`,
    );
  }

  // Only the captures that actually reached the model are marked processed —
  // one the budget dropped has not been triaged and must come back next run.
  for (const capture of promptInput.captures.slice(0, prompt.budget.shown.captures)) {
    markCaptureProcessed(db, capture.id, { now });
  }
  setKV(db, SWEEP_KV.pendingNew, '0');

  const derived = recomputeDerived(db, { now });
  stats.items = merged.stats.items;
  // The board's count, not the reply's: this run's four `now` items may have
  // arrived on a board that was already holding four of somebody else's, and the
  // number reported has to be the one the user will see.
  stats.now = derived.counts.now;

  if (merged.errors.length) {
    slog.info(`board accepted with ${merged.errors.length} repair(s)`, {
      runId,
      first: merged.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`),
    });
  }

  return finish(true, null, {
    counts: derived.counts,
    first: merged.first,
    notes: merged.notes,
    repairs: merged.errors,
    modelCalls: 1,
  });
}

/**
 * `runs.kind` is written once by db.startRun, and the light/full decision can
 * legitimately change after the fetch. It reaches past a db.mjs helper because
 * the run's recorded kind must match what the run actually did — shouldRunFull
 * reads it back on the next sweep, and a light-labelled run that thought would
 * make the next decision on a false premise.
 */
function setRunKind(db, runId, kind) {
  db.prepare('UPDATE runs SET kind = ? WHERE id = ?').run(String(kind), String(runId));
}

/**
 * The keys of things the user has already finished, most recently closed first.
 *
 * `listBoard` cannot express this: it ranks by bucket and severity, which is the
 * reading order of live work and says nothing about when a decision was made, so
 * on a board that has been running for months its limit would return the oldest
 * closed items and hide exactly the recent ones that matter. `state_at` is when
 * the user decided, and both sides of the comparison go through datetime() for
 * the same reason listBoard's snooze wake does — the stored timestamps carry the
 * user's offset while `since` is UTC, and comparing those as strings would be
 * wrong by the difference.
 *
 * The ordering goes through datetime() for exactly the same reason, and this is
 * not decoration: the filter and the sort choose the rows together, so a WHERE
 * that reads instants feeding an ORDER BY that reads characters means the LIMIT
 * keeps whichever rows happen to sort well as text. Two items closed a minute
 * apart either side of a timezone change would come back in the wrong order, and
 * the one that fell off the end would be the most recent decision the user made.
 */
const RECENTLY_RESOLVED_SQL = `
SELECT id, bucket, headline, state, state_at, payload_json FROM items
WHERE state IN ('done', 'dismissed') AND state_at IS NOT NULL
  AND datetime(state_at) >= datetime(:since)
ORDER BY datetime(state_at) DESC
LIMIT :limit`;

function recentlyResolved(db, now) {
  const nowMs = instant(now) ?? Date.now();
  const since = new Date(nowMs - PROMPT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = db.prepare(RECENTLY_RESOLVED_SQL).all({ since, limit: RESOLVED_LIMIT });
  const out = [];
  for (const row of rows) {
    let key = '';
    try {
      key = String(JSON.parse(row.payload_json || '{}')?.key ?? '');
    } catch {
      // A row whose payload will not parse has no key to reuse, so it has
      // nothing to contribute here and is simply left out.
      key = '';
    }
    if (!key) continue;
    out.push({ key, headline: row.headline, state: row.state, resolvedAt: row.state_at });
  }
  return out;
}

/**
 * Today's model spend, written where the UI can read it without walking the runs
 * table. `runs` counts every successful sweep and `modelRuns` only the ones that
 * actually thought, because a light run costs nothing and folding it into the
 * same counter would quietly halve what a thinking run appears to cost.
 *
 * The token totals and the run counts answer different questions, so a failed
 * run moves one and not the other: `ok: false` still adds whatever the model
 * charged for the reply that could not be used, and adds nothing to the count of
 * sweeps that happened, because no sweep did.
 *
 * The day rolls over on the user's own day key rather than on UTC — "today" has
 * to mean the day they are having, or the number resets mid-evening.
 *
 * Nothing in here may fail a sweep. This is a display counter: both the read of
 * the old totals and the write of the new ones are caught, because a `kv` table
 * that will not take a write is a reason to lose a number, never a reason to
 * throw away a board the user waited for.
 */
function recordTokens(db, { tokensIn = 0, tokensOut = 0, thought = false, ok = true, now = nowISO() } = {}) {
  const today = dayKey(now) || '';
  let stored = null;
  try {
    const raw = getKV(db, SWEEP_KV.tokens);
    if (raw) stored = JSON.parse(raw);
  } catch {
    // Unreadable totals are a display detail, never a reason to fail a run that
    // otherwise worked. Counting starts again from this sweep.
    stored = null;
  }
  if (!stored || typeof stored !== 'object') stored = {};
  const lifetime = stored.lifetime && typeof stored.lifetime === 'object' ? stored.lifetime : {};
  const carried = stored.day === today ? stored : {};
  const num = (v) => Number(v) || 0;

  const ranAsSweep = ok ? 1 : 0;
  const ranAsModelSweep = ok && thought ? 1 : 0;

  const totals = {
    day: today,
    tokensIn: num(carried.tokensIn) + num(tokensIn),
    tokensOut: num(carried.tokensOut) + num(tokensOut),
    runs: num(carried.runs) + ranAsSweep,
    modelRuns: num(carried.modelRuns) + ranAsModelSweep,
    lifetime: {
      tokensIn: num(lifetime.tokensIn) + num(tokensIn),
      tokensOut: num(lifetime.tokensOut) + num(tokensOut),
      runs: num(lifetime.runs) + ranAsSweep,
      modelRuns: num(lifetime.modelRuns) + ranAsModelSweep,
    },
    at: now,
  };
  try {
    setKV(db, SWEEP_KV.tokens, JSON.stringify(totals));
  } catch (err) {
    slog.warn('could not record the token counter', { error: errorText(err) });
  }
  return totals;
}

/** What the prompt gets to look at. Read from the database, not from this fetch,
 *  so a run whose IMAP host was down still reasons over the mail it already has. */
function gatherPromptInput(db, config, now) {
  const nowMs = instant(now) ?? Date.now();
  const sinceISO = new Date(nowMs - PROMPT_LOOKBACK_DAYS * 86_400_000).toISOString();
  // Day-key bounds rather than full timestamps: the stored ISO strings carry
  // their own offsets and all-day events are bare dates, so a plain YYYY-MM-DD
  // compares sanely against both shapes where a `...Z` timestamp does not.
  const today = dayKey(now);
  // The demo week lives in the same tables as real mail — that is the point of
  // it — but it must never reach the model: a sweep that reasons over Quillon
  // Row spends real tokens on fiction and can mint board items about people who
  // do not exist. Sample rows are recognisable by the source ids the seed wrote
  // them under, so they are dropped here rather than at the query, which keeps
  // the demo visible in every view while making it invisible to the prompt.
  const messages = listMessages(db, { sinceISO, limit: PROMPT_MESSAGE_LIMIT })
    .filter((m) => m.source_id !== SAMPLE_SOURCE_ID);
  const events = listEvents(db, {
    from: addDaysToKey(today, -2),
    to: addDaysToKey(today, CALENDAR_FORWARD_DAYS + 1),
    limit: 400,
  }).filter((e) => e.calendar_id !== SAMPLE_CALENDAR_ID);
  return {
    messages,
    events,
    // Captures get the same treatment as mail and events: the seed writes one
    // demo capture, marked the way every sample row is marked, and a real
    // sweep must not spend the model's attention triaging it.
    captures: listCaptures(db, { includeProcessed: false, limit: 50 })
      .filter((c) => !String(c.text || '').startsWith(SAMPLE_MARK)),
    priorItems: listBoard(db, { states: ['open', 'snoozed'], limit: 120 }),
    // A finished item's key is otherwise never shown again, and a key the model
    // cannot see is a key it cannot reuse: it rewords the same obligation, mints
    // a fresh key, and work the user already did comes back as new. Naming them
    // is a prompt-side fix — nothing about how state merges changes.
    resolvedItems: recentlyResolved(db, now),
  };
}

const DEMOTE_ITEM_BUCKET = `
UPDATE items SET bucket = :bucket, updated_at = :now
WHERE id = :id AND state = 'open'`;

/**
 * Hold the four-item `now` bar on the board itself.
 *
 * core/safety.mjs clamps each model reply to four, which is only a guarantee
 * about one exchange. Two runs whose replies use different keys each contribute
 * their own four, nothing demotes what was already there, and the board the user
 * opens carries eight — so the loudest promise the product makes was true of the
 * model and false of the product. It is enforced here instead, on every run,
 * light or full, because the number that matters is the one on the screen.
 *
 * The four that keep their place are the four the board's own reading order puts
 * first: `listBoard` asked for one bucket, so severity, then what is due soonest,
 * then longest-carried, exactly as the rail and the page already rank them. There
 * is one ranking in this product and this is not a second opinion on it.
 *
 * Nothing is ever deleted and no state is touched. An item that loses its place
 * moves to `today`, where it is still the user's work, still carried with its
 * first_seen intact, and still theirs to finish. Only open rows are considered:
 * a snoozed or finished item is a decision the user made, and demoting it would
 * be this pass overruling them to make room for the model.
 *
 * Exported because a sweep is not the only thing that can add to `now`: reading
 * the board wakes a snooze that has come due, and a fifth `now` item can arrive
 * that way with no sweep anywhere near it. core/server.mjs holds the bar on that
 * path with this same function, so there is one demotion rule and not two.
 */
export function capNowBucket(db, { now = nowISO() } = {}) {
  const inNow = listBoard(db, { states: ['open'], buckets: ['now'], limit: 500, now });
  if (inNow.length <= NOW_BOARD_LIMIT) return 0;

  const overflow = inNow.slice(NOW_BOARD_LIMIT);
  const stmt = db.prepare(DEMOTE_ITEM_BUCKET);
  withTransaction(db, () => {
    for (const item of overflow) stmt.run({ bucket: 'today', now, id: item.id });
  });
  slog.info(`board held ${inNow.length} now items; demoted ${overflow.length} to today`, {
    demoted: overflow.map((i) => i.id),
  });
  return overflow.length;
}

/**
 * What a light run recomputes: the four-item bar on the persisted board, the
 * counts the rail shows, and whether the item the board opens with is still one
 * the user cares about. If they marked the hero done, the next-best open item
 * takes its place — no model call needed to know that.
 *
 * The demotion runs first, and has to: the counts must describe the board as it
 * will be read, and the `first` pointer must not be handed a `now` item that is
 * about to stop being one.
 */
function recomputeDerived(db, { now = nowISO() } = {}) {
  const demoted = capNowBucket(db, { now });
  const counts = bucketCounts(db, { states: ['open'] });
  const open = Object.values(counts).reduce((n, v) => n + v, 0);

  const firstId = getKV(db, SWEEP_KV.first);
  const current = firstId ? getItem(db, firstId) : null;
  if (!current || current.state !== 'open') {
    const board = listBoard(db, { states: ['open'], limit: 1 });
    setKV(db, SWEEP_KV.first, board.length ? board[0].id : '');
  }
  setKV(db, SWEEP_KV.counts, JSON.stringify({ counts, open, at: now }));
  return { counts, open, demoted };
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

/**
 * In-process sweep timer.
 *
 * Drift-free by construction: the next run time is an absolute instant computed
 * from the *previous target*, not from when the previous run happened to finish.
 * A sweep that takes four minutes does not push the whole day four minutes late,
 * and a laptop that slept through six slots runs once on wake rather than six
 * times in a row.
 */
export class Scheduler {
  #timer = null;
  #running = false;
  #busy = false;
  #targetMs = null;
  #controller = null;
  #runs = 0;
  #lastRunAt = null;
  #lastResult = null;

  constructor({
    db,
    config = loadConfig(),
    run,
    onProgress,
    onRun,
    deps,
    now = () => Date.now(),
  } = {}) {
    if (!db) throw new TypeError('Scheduler: a database handle is required');
    this.db = db;
    this.config = config;
    this.onProgress = onProgress;
    this.onRun = onRun;
    this.deps = deps;
    this.now = now;
    this.run = typeof run === 'function' ? run : runSweep;
  }

  /** Idempotent. Starting an already-started scheduler does nothing. */
  start() {
    if (this.#running) return this.status();
    this.#running = true;
    this.#targetMs = this.#firstTarget();
    this.#arm();
    slog.info('sweep scheduler started', {
      everyMinutes: intervalMinutesOf(this.config),
      activeHours: activeHoursOf(this.config),
      nextRunAt: this.status().nextRunAt,
    });
    return this.status();
  }

  /** Stops the timer and cancels a sweep that is in flight. */
  stop() {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#controller?.abort();
    this.#controller = null;
    return this.status();
  }

  status() {
    return {
      running: this.#running,
      busy: this.#busy,
      auto: this.config?.sweep?.auto !== false,
      intervalMinutes: intervalMinutesOf(this.config),
      activeHours: activeHoursOf(this.config),
      timezone: timezoneOf(this.config),
      nextRunAt:
        this.#running && this.#targetMs !== null
          ? toZonedISO(new Date(this.#targetMs), timezoneOf(this.config))
          : null,
      lastRunAt: this.#lastRunAt,
      lastResult: this.#lastResult,
      runs: this.#runs,
    };
  }

  /** Replace the configuration and re-aim the timer without losing the loop. */
  reconfigure(config) {
    this.config = config;
    if (this.#running) {
      this.#targetMs = this.#firstTarget();
      this.#arm();
    }
    return this.status();
  }

  #firstTarget() {
    const tz = timezoneOf(this.config);
    const target = instant(nextRunAt(this.config, toZonedISO(new Date(this.now()), tz)));
    return target ?? this.now() + intervalMinutesOf(this.config) * 60_000;
  }

  /** Sweep right now, outside the schedule. Used by the UI's "Sweep now". */
  async runNow(mode = 'auto') {
    return this.#execute(mode);
  }

  #arm() {
    if (this.#timer) clearTimeout(this.#timer);
    if (!this.#running || this.#targetMs === null) return;
    const delay = Math.max(0, this.#targetMs - this.now());
    this.#timer = setTimeout(() => this.#tick(), delay);
    // The scheduler must not be the reason a process refuses to exit; the server
    // owns the event loop.
    this.#timer.unref?.();
  }

  async #tick() {
    this.#timer = null;
    if (!this.#running) return;

    if (this.config?.sweep?.auto === false) {
      this.#advance();
      this.#arm();
      return;
    }
    await this.#execute('auto');
    this.#advance();
    this.#arm();
  }

  /**
   * Step the absolute target forward by whole intervals until it is in the
   * future, then push it inside the active hours. Whole-interval stepping is
   * what keeps the cadence anchored to the original phase; slots missed while a
   * run was long or a laptop was asleep are skipped, never queued up.
   */
  #advance() {
    const step = intervalMinutesOf(this.config) * 60_000;
    const now = this.now();
    let next = (this.#targetMs ?? now) + step;
    while (next <= now) next += step;

    const tz = timezoneOf(this.config);
    const [startHour, endHour] = activeHoursOf(this.config);
    const hour = wallClock(toZonedISO(new Date(next), tz))?.hour ?? startHour;
    if (hour < startHour) next = atHourInZone(next, startHour, tz);
    else if (hour >= endHour) next = atHourInZone(next, startHour, tz, 1);

    this.#targetMs = next;
  }

  async #execute(mode) {
    if (this.#busy) return { ok: false, busy: true, error: 'A sweep is already running' };
    this.#busy = true;
    this.#controller = new AbortController();
    try {
      const result = await this.run({
        db: this.db,
        config: this.config,
        mode,
        onProgress: this.onProgress,
        signal: this.#controller.signal,
        deps: this.deps,
      });
      this.#runs += 1;
      this.#lastRunAt = nowISO(timezoneOf(this.config));
      this.#lastResult = result;
      if (typeof this.onRun === 'function') {
        try {
          this.onRun(result);
        } catch (err) {
          slog.debug('onRun listener threw', { error: err.message });
        }
      }
      return result;
    } catch (err) {
      slog.error('scheduled sweep threw', { error: errorText(err) });
      this.#lastResult = { ok: false, error: errorText(err) };
      return this.#lastResult;
    } finally {
      this.#busy = false;
      this.#controller = null;
    }
  }
}
