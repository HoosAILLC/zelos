/**
 * core/connectors/calendar.mjs — what the three calendar readers share.
 *
 * `ics`, `caldav` and `file` differ in exactly one function: how a document is
 * obtained. Everything after that — expand it against the sweep's window, cap
 * it, notice the cap, say so in the one sentence the user reads — was already
 * shared by `defaultFetchEvents`'s three branches in core/sweep.mjs, and it
 * stays shared here rather than being copied into three manifests.
 *
 * The family string is 'calendar' and it is FROZEN. It is the `kind` in
 * `sources[]`, the prefix on doctor's check ids, and the `emit` phase, and it is
 * sitting in `runs.stats_json` in every database that already exists. Three
 * readers of one fact, which is why it is one field: a keyRef prefix that
 * drifts from `sources[].kind` is a password saved under one name and read
 * under another, and the symptom is "No password stored" on an account that has
 * one.
 */

import { parseICS_toEvents } from '../sources/ics.mjs';

/**
 * How many expanded instances one iCalendar document may contribute.
 *
 * The number is set HERE rather than left to `parseICS_toEvents`'s own default
 * for one reason: this layer is the only place that can tell the user a calendar
 * was truncated, and it can only tell them if it knows what the ceiling was.
 * `expand()` drops the overflow from the far end of the window and logs
 * `ics.warn("more than max=… instances in the window; dropped …")` — a line that
 * reaches a terminal nobody is reading and no screen at all. Passing the cap in
 * and comparing the count out is what turns that into something a person sees.
 */
export const ICS_MAX_INSTANCES = 1_500;

/**
 * True when a parse came back exactly at the ceiling.
 *
 * At the ceiling, not over it: the overflow is already gone by the time the
 * array is returned, so "was anything dropped" is not answerable from here — and
 * the wording chosen below is true either way. A document holding exactly 1,500
 * instances and nothing more raises the same note, which costs a rare reader one
 * sentence about a limit they are in fact standing on.
 */
export const filledIcsBudget = (events) => (events?.length ?? 0) >= ICS_MAX_INSTANCES;

/**
 * The sentence a truncated calendar reports, character for character.
 *
 * It is a `note` rather than an `error` because a truncated calendar is neither
 * success nor failure: "I read 1,500 and dropped the rest" arrives with a
 * non-zero count. The host maps a note to `{ok: false, count: rows.length,
 * error: note}`, which is the exact shape core/sweep.mjs pushed before this file
 * existed — `ui/views/now.js` is the only screen that renders `sources[]` and it
 * filters on `s.ok === false`, so a note attached to an `ok: true` entry would
 * be a string with no reader.
 */
export const TRUNCATED_NOTE = `This calendar filled Zelos's ceiling of ${ICS_MAX_INSTANCES.toLocaleString('en-US')} entries for the window, so anything past the ${ICS_MAX_INSTANCES.toLocaleString('en-US')}th was dropped from the far end of it. Narrow the subscription, or split it in two.`;

/** Every calendar reader takes and returns the same thing. */
export function eventsFrom(text, window) {
  const events = parseICS_toEvents(text, window);
  return { events, truncated: filledIcsBudget(events) };
}

/**
 * One calendar connector, given the one function that differs.
 *
 * `collect` goes through `ctx.deps.fetchEvents` rather than calling `read`
 * directly, and that is not indirection for its own sake: `deps.fetchEvents` is
 * the desktop shell's seam and the suite's, it is injected at exactly one place
 * (test/sweep.test.mjs:1358) standing in for all three kinds, and it is
 * family-level. Keeping it family-level is what lets the `calendar.kind` branch
 * die inside `defaultFetchEvents` without any caller noticing.
 */
export function calendarConnector({ type, label, option, credential = null, read }) {
  return {
    type,
    family: 'calendar',
    label,
    option,
    configKey: 'calendars',
    sink: 'events',
    credential,
    origins: [],
    fields: [],
    limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: null },

    /**
     * NOT part of the connector contract. `read` exists so `deps.fetchEvents`
     * survives as a seam for the four connectors that predate this interface;
     * connector number nine implements `collect` and nothing else, and gets its
     * seam from `ctx.http`. The migration cost is paid by the old four.
     */
    read,

    async collect(ctx) {
      const { source: calendar, secret: pass, deps, window, timezone, identityEmail, signal, emit, label: at } = ctx;
      const events = await deps.fetchEvents({
        calendar,
        pass,
        from: window.from,
        to: window.to,
        timezone,
        email: identityEmail || null,
        signal,
      });
      // Read BEFORE anything maps the array, which drops it along with every
      // other non-index property. See `markTruncated` in core/sweep.mjs.
      const truncated = events?.truncated === true;
      const rows = events || [];
      emit(`${at}: ${rows.length} entries`, rows.length, rows.length);
      return { parts: [{ label: '', rows, error: null, note: truncated ? TRUNCATED_NOTE : null }] };
    },
  };
}
