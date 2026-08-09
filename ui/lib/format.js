/**
 * ui/lib/format.js — words and ordering. No DOM here.
 *
 * The vocabulary matters: `waiting` and `promised` are the model's words, and
 * neither reads as anything to a person at 8am. The board says "they owe you"
 * and "you owe them", which is the same fact in a sentence you do not decode.
 */

import { dayKey, daysBetweenKeys, formatTime, formatDay, humanDelta, instant, minutesIntoDay } from './time.js';

export const BUCKETS = ['now', 'today', 'soon', 'waiting', 'promised', 'note', 'money'];

export const BUCKET_LABEL = {
  now: 'Now',
  today: 'Today',
  soon: 'Soon',
  waiting: 'They owe you',
  promised: 'You owe them',
  note: 'Worth knowing',
  money: 'Money',
};

/** Short form for a chip beside a headline, where the long form would crowd. */
export const BUCKET_TAG = {
  now: 'now',
  today: 'today',
  soon: 'soon',
  waiting: 'owed to you',
  promised: 'you owe',
  note: 'note',
  money: 'money',
};

export const SEVERITY_LABEL = ['background', 'ordinary', 'pressing', 'urgent'];

export function severityOf(item) {
  const n = Number(item?.severity);
  return Number.isFinite(n) ? Math.min(3, Math.max(0, Math.round(n))) : 0;
}

/**
 * How long this has been on the board. Deliberately silent under four days:
 * a badge on everything is a badge on nothing, and the point of this one is
 * that a thing you have carried for a fortnight should feel uncomfortable.
 */
export function carriedFor(item, todayKeyStr) {
  const seen = dayKey(item?.first_seen);
  if (!seen || !todayKeyStr) return null;
  const days = daysBetweenKeys(seen, todayKeyStr);
  if (days === null || days < 4) return null;
  if (days >= 60) return `carried ${Math.round(days / 30)} months`;
  if (days >= 14) return `carried ${Math.floor(days / 7)} weeks`;
  return `carried ${days} days`;
}

/** "due in 2h" / "due Tue, Aug 11" / "" — one line, never both forms at once. */
export function dueLabel(item, now = Date.now()) {
  if (!item?.due_at) return '';
  const at = instant(item.due_at);
  if (at === null) return '';
  const withinADay = Math.abs(at - now) < 36 * 3_600_000;
  if (withinADay) return `due ${humanDelta(item.due_at, now)}`;
  const time = formatTime(item.due_at);
  return `due ${formatDay(item.due_at)}${time ? ` · ${time}` : ''}`;
}

export function isOverdue(item, now = Date.now()) {
  if (!item?.due_at) return false;
  const at = instant(item.due_at);
  return at !== null && at < now;
}

/** Severity first, then soonest due, then longest carried. */
export function byUrgency(a, b) {
  const sev = severityOf(b) - severityOf(a);
  if (sev) return sev;
  const da = instant(a.due_at);
  const db = instant(b.due_at);
  if (da !== null && db !== null && da !== db) return da - db;
  if (da !== null && db === null) return -1;
  if (da === null && db !== null) return 1;
  const fa = instant(a.first_seen) ?? 0;
  const fb = instant(b.first_seen) ?? 0;
  return fa - fb;
}

export function personLabel(item) {
  const name = (item?.person || '').trim();
  const email = (item?.person_email || '').trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} · ${email}`;
  return name || email || '';
}

/* ------------------------------------------------------------------ events */

/** Minutes [start, end) of an event within one day-key, clamped to that day. */
export function eventSpanOnDay(event, key) {
  const startKey = dayKey(event.starts_at);
  const endKey = dayKey(event.ends_at) || startKey;
  if (!startKey) return null;
  if (key < startKey || key > endKey) return null;
  if (event.all_day) {
    // `ends_at` on an all-day event is RFC 5545's exclusive DTEND — the day
    // AFTER the last one covered (core/sources/ics.mjs keeps it that way). So
    // the end key itself is not part of the span, and a one-day holiday would
    // otherwise paint across two columns.
    if (key === endKey && key !== startKey) return null;
    return { start: 0, end: 1440, allDay: true };
  }

  let start = key === startKey ? (minutesIntoDay(event.starts_at) ?? 0) : 0;
  let end = key === endKey ? (minutesIntoDay(event.ends_at) ?? start + 60) : 1440;
  // An end at exactly midnight belongs to the previous day, not a zero-height
  // sliver at the top of the next one.
  if (key === endKey && key !== startKey && end === 0) return null;
  if (end <= start) end = Math.min(1440, start + 30);
  start = Math.max(0, Math.min(1439, start));
  end = Math.max(start + 15, Math.min(1440, end));
  return { start, end, allDay: false };
}

export function eventTimeLabel(event) {
  if (event.all_day) return 'All day';
  const from = formatTime(event.starts_at);
  const to = formatTime(event.ends_at);
  if (from && to) return `${from} – ${to}`;
  return from || to || '';
}

/**
 * Cluster-then-greedy-column packing.
 *
 * Two passes, because they answer different questions. The cluster pass finds
 * every group of chips that transitively overlap — that is what decides how many
 * columns the group is divided into, so two independent pairs of overlapping
 * events do not each get squeezed to a quarter width. The greedy pass then drops
 * each chip into the first column whose last occupant has already ended.
 *
 * Input entries: {start, end, ...}. Returns the same objects with {col, cols}.
 */
export function packColumns(entries) {
  const sorted = [...entries].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const columns = []; // columns[i] = end minute of the last chip placed there
    for (const entry of cluster) {
      let col = columns.findIndex((end) => end <= entry.start);
      if (col === -1) {
        col = columns.length;
        columns.push(entry.end);
      } else {
        columns[col] = entry.end;
      }
      entry.col = col;
    }
    for (const entry of cluster) entry.cols = columns.length;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const entry of sorted) {
    if (cluster.length && entry.start >= clusterEnd) flush();
    cluster.push(entry);
    clusterEnd = Math.max(clusterEnd, entry.end);
  }
  flush();
  return out;
}

/**
 * Order a day's events so a conflict cannot hide behind "+4". Anything that
 * overlaps another entry sorts first — the whole reason a month cell truncates
 * is that most days are dull, and the day that is not must say so in the three
 * rows it gets.
 */
export function conflictsFirst(entries) {
  const flagged = entries.map((e) => ({ ...e, conflict: false }));
  for (let i = 0; i < flagged.length; i += 1) {
    for (let j = i + 1; j < flagged.length; j += 1) {
      if (flagged[i].start < flagged[j].end && flagged[j].start < flagged[i].end) {
        flagged[i].conflict = true;
        flagged[j].conflict = true;
      }
    }
  }
  return flagged.sort((a, b) => (b.conflict - a.conflict) || (a.start - b.start));
}

/** "3 messages · 2 events" — the sweep's own numbers, in a readable line. */
export function sweepSummary(run) {
  if (!run) return '';
  const s = run.stats || {};
  const bits = [];
  if (s.messages) bits.push(`${s.messages} message${s.messages === 1 ? '' : 's'}`);
  if (s.events) bits.push(`${s.events} event${s.events === 1 ? '' : 's'}`);
  if (s.items) bits.push(`${s.items} item${s.items === 1 ? '' : 's'}`);
  if (s.ms) bits.push(`${(s.ms / 1000).toFixed(1)}s`);
  return bits.join(' · ');
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
