/**
 * core/db.mjs — everything Zelos remembers.
 *
 * node:sqlite only. `open()` sets the pragmas, `migrate()` is idempotent and
 * versioned through PRAGMA user_version, and the rest of the file is the set of
 * prepared-statement helpers the engine, the server and the UI need. Statements
 * are prepared once per database handle and cached.
 *
 * Shape conventions, so callers never have to guess:
 *
 *  - Helpers take the database handle first: `upsertItem(db, item, opts)`.
 *  - INPUT is camelCase and matches what the sources emit — `upsertMessage` eats
 *    a `fetchRecent()` row (SPEC §4) plus `sourceId`; `upsertEvent` eats an
 *    `Event` (SPEC §5) plus `calendarId`.
 *  - OUTPUT keeps the column names from the schema (snake_case), except that
 *    every `*_json` column is returned decoded under its bare name
 *    (`source_refs_json` -> `sourceRefs`) and the 0/1 columns `has_attach` and
 *    `all_day` come back as booleans. What you read is what is stored.
 *
 * Re-fetching is the normal case, not the exception: the same message arrives on
 * every sweep and the same item is re-derived on every run. So every upsert is
 * written to preserve what the user (or an earlier, richer fetch) put there —
 * item state and `first_seen` survive, `seen_runs` counts runs rather than
 * calls, and a header-only re-fetch never blanks a body it did not carry.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { paths } from './config.mjs';
import { nowISO } from './time.mjs';
import { log } from './log.mjs';

export const SCHEMA_VERSION = 2;

/** Closed set, in board order: the rail reads top to bottom. */
export const BUCKETS = Object.freeze(['now', 'today', 'soon', 'waiting', 'promised', 'note', 'money']);
export const ITEM_STATES = Object.freeze(['open', 'done', 'dismissed', 'snoozed']);
export const DRAFT_STATES = Object.freeze(['pending', 'edited', 'used', 'discarded']);
export const DIRECTIONS = Object.freeze(['in', 'out']);

/* --------------------------------------------------------------- open/migrate */

/**
 * SQLite creates its files 0666 masked by the umask, which on the usual 022
 * leaves them 0644 — the whole mail cache readable by anyone on the machine.
 * The Zelos home is 0700, so nothing can reach them *there*; but a mode
 * travels with a file, and this one goes into backups, into `cp -p`, into a
 * synced folder, and into whatever a home directory's permissions become later.
 * Everything else Zelos writes is 0600, and the file holding every message
 * body should not be the exception. The WAL and shared-memory sidecars carry
 * the same rows, so they are tightened with it.
 */
function tightenDbFiles(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
    } catch {
      // A sidecar only exists once WAL has written one, and on Windows the mode
      // is not meaningful. Neither is a reason to fail to open the database.
    }
  }
}

/**
 * Whether this runtime's bundled SQLite has FTS5 compiled in.
 *
 * It is not a given, and the pattern is not a simple "new enough" line. The
 * extension arrived in the 22 line at **22.16.0**, is absent from the whole 23
 * line, and is present again from 24. A runtime without it fails deep inside
 * the first migration with `no such module: fts5`, which reads like a corrupt
 * install rather than what it is — so this is checked once, early, and
 * answered in a sentence a person can act on.
 */
export function hasFts5(db) {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS zelos_fts5_probe USING fts5(probe)');
    db.exec('DROP TABLE IF EXISTS zelos_fts5_probe');
    return true;
  } catch {
    return false;
  }
}

export class UnsupportedRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedRuntimeError';
    this.code = 'ZELOS_NO_FTS5';
  }
}

export function open(dbPath = paths().db) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // After the WAL pragma: that is what creates the sidecars.
  if (dbPath !== ':memory:') tightenDbFiles(dbPath);

  if (!hasFts5(db)) {
    try { db.close(); } catch { /* it is going away regardless */ }
    throw new UnsupportedRuntimeError(
      `This copy of Node (${process.version}) was built without SQLite's FTS5 extension, `
      + 'which Zelos uses for its search index — so it cannot open the database at all.\n\n'
      + 'Node 22.16 or newer, or Node 24 or newer, has it. The whole Node 23 line does not, '
      + 'whatever its version number suggests.\n\n'
      + 'Install a newer Node and run Zelos again; nothing in your Zelos home has been changed.',
    );
  }
  return db;
}

export function close(db) {
  try {
    statementCache.delete(db);
    db.close();
  } catch (err) {
    log.warn('db: close failed', { error: err.message });
  }
}

const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          source_id TEXT, uid INTEGER, message_id TEXT, thread_key TEXT,
          folder TEXT, direction TEXT,
          from_name TEXT, from_email TEXT, to_json TEXT, cc_json TEXT,
          subject TEXT, sent_at TEXT,
          snippet TEXT, body TEXT, has_attach INTEGER,
          flags_json TEXT, fetched_at TEXT
        );
        CREATE INDEX IF NOT EXISTS messages_sent_at ON messages(sent_at DESC);
        CREATE INDEX IF NOT EXISTS messages_source ON messages(source_id, sent_at DESC);
        CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_key);
        CREATE INDEX IF NOT EXISTS messages_fetched_at ON messages(fetched_at);

        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          calendar_id TEXT, uid TEXT, recurrence_id TEXT,
          title TEXT, description TEXT, location TEXT,
          starts_at TEXT, ends_at TEXT, all_day INTEGER,
          organizer TEXT, attendees_json TEXT, rsvp TEXT, status TEXT, url TEXT,
          fetched_at TEXT
        );
        CREATE INDEX IF NOT EXISTS events_starts_at ON events(starts_at);
        CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar_id, starts_at);
        CREATE INDEX IF NOT EXISTS events_fetched_at ON events(fetched_at);

        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY, kind TEXT, bucket TEXT, headline TEXT, why TEXT,
          person TEXT, person_email TEXT, due_at TEXT, severity INTEGER, link TEXT,
          source_refs_json TEXT, payload_json TEXT,
          first_seen TEXT, seen_runs INTEGER, last_seen_run TEXT,
          state TEXT, state_at TEXT, updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS items_state_bucket ON items(state, bucket);
        CREATE INDEX IF NOT EXISTS items_due ON items(due_at);

        CREATE TABLE IF NOT EXISTS drafts (
          id TEXT PRIMARY KEY, item_id TEXT, to_email TEXT, subject TEXT, body TEXT,
          state TEXT, created_at TEXT, updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS drafts_item ON drafts(item_id);
        CREATE INDEX IF NOT EXISTS drafts_state ON drafts(state);

        CREATE TABLE IF NOT EXISTS captures (
          id TEXT PRIMARY KEY, text TEXT, created_at TEXT, processed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS captures_processed ON captures(processed_at);

        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, kind TEXT, started_at TEXT, ended_at TEXT, ok INTEGER,
          model TEXT, tokens_in INTEGER, tokens_out INTEGER, error TEXT, stats_json TEXT
        );
        CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at DESC);

        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

        CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
          title, body, ref UNINDEXED, kind UNINDEXED, tokenize='porter unicode61'
        );
      `);
    },
  },
  {
    /**
     * Snooze-until. NULL means what every snoozed row meant before this column
     * existed — snoozed until the user wakes it by hand — so a database written
     * by version 1 upgrades without any row changing its behaviour. A zoned ISO
     * timestamp means "wake it for me": `listBoard()` clears it and reopens the
     * item once the moment has passed.
     */
    version: 2,
    up(db) {
      db.exec('ALTER TABLE items ADD COLUMN snoozed_until TEXT');
    },
  },
];

/** Idempotent. Running it twice is a no-op; running it on an old file upgrades. */
export function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      // PRAGMA cannot be parameterised; the value is a literal from this file.
      db.exec(`PRAGMA user_version = ${Number(m.version)}`);
      db.exec('COMMIT');
      applied += 1;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  const version = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  return { version, applied };
}

/* ------------------------------------------------------------- statements */

const statementCache = new WeakMap();

function prep(db, sql) {
  let bySql = statementCache.get(db);
  if (!bySql) {
    bySql = new Map();
    statementCache.set(db, bySql);
  }
  let stmt = bySql.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    bySql.set(sql, stmt);
  }
  return stmt;
}

/** Runs `fn` in a transaction; rolls back and rethrows on any error. */
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the failure below is the real one */ }
    throw err;
  }
}

/* ------------------------------------------------------------------- ids */

function hashId(...parts) {
  return crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
}

export const messageRowId = (sourceId, uid, messageId) => hashId(sourceId, uid, messageId);
export const eventRowId = (calendarId, uid, recurrenceId) => hashId(calendarId, uid, recurrenceId);

/**
 * Item identity is the model's `key`, hashed. The schema has no `key` column
 * (SPEC §2), so the hash IS the carrier: same key next run, same row, and
 * therefore the same first_seen and the same user state.
 */
export const itemRowId = (key) => hashId('item', key);

/* -------------------------------------------------------------- coercion */

const str = (v) => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const json = (v) => JSON.stringify(v ?? null);
const bit = (v) => (v ? 1 : 0);

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    const v = JSON.parse(text);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function addr(a) {
  if (!a) return { name: '', email: '' };
  if (typeof a === 'string') return { name: '', email: a };
  return { name: str(a.name), email: str(a.email) };
}

/** Severity is a scalar, so an out-of-range value has an obvious nearest legal
 *  value; bucket is an enum, so it does not — see `assertBucket`. */
function clampSeverity(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(3, Math.max(0, n));
}

function assertBucket(bucket) {
  if (!BUCKETS.includes(bucket)) {
    throw new TypeError(`db: bucket must be one of ${BUCKETS.join('|')}, got ${JSON.stringify(bucket)}`);
  }
  return bucket;
}

/* ------------------------------------------------------------- hydration */

function hydrateMessage(row) {
  if (!row) return null;
  const { to_json, cc_json, flags_json, has_attach, ...rest } = row;
  return {
    ...rest,
    to: parseJson(to_json, []),
    cc: parseJson(cc_json, []),
    flags: parseJson(flags_json, []),
    has_attach: !!has_attach,
  };
}

function hydrateEvent(row) {
  if (!row) return null;
  const { attendees_json, all_day, ...rest } = row;
  return { ...rest, attendees: parseJson(attendees_json, []), all_day: !!all_day };
}

function hydrateItem(row) {
  if (!row) return null;
  const { source_refs_json, payload_json, ...rest } = row;
  return { ...rest, sourceRefs: parseJson(source_refs_json, []), payload: parseJson(payload_json, {}) };
}

function hydrateRun(row) {
  if (!row) return null;
  const { stats_json, ok, ...rest } = row;
  return { ...rest, ok: ok === null ? null : !!ok, stats: parseJson(stats_json, {}) };
}

/* -------------------------------------------------------------- messages */

const MESSAGE_UPSERT = `
INSERT INTO messages (id, source_id, uid, message_id, thread_key, folder, direction,
  from_name, from_email, to_json, cc_json, subject, sent_at, snippet, body, has_attach,
  flags_json, fetched_at)
VALUES (:id, :source_id, :uid, :message_id, :thread_key, :folder, :direction,
  :from_name, :from_email, :to_json, :cc_json, :subject, :sent_at, :snippet, :body, :has_attach,
  :flags_json, :fetched_at)
ON CONFLICT(id) DO UPDATE SET
  thread_key = excluded.thread_key,
  folder     = excluded.folder,
  direction  = excluded.direction,
  from_name  = excluded.from_name,
  from_email = excluded.from_email,
  to_json    = excluded.to_json,
  cc_json    = excluded.cc_json,
  subject    = excluded.subject,
  sent_at    = excluded.sent_at,
  snippet    = COALESCE(NULLIF(excluded.snippet, ''), messages.snippet),
  body       = COALESCE(NULLIF(excluded.body, ''), messages.body),
  has_attach = excluded.has_attach,
  flags_json = excluded.flags_json,
  fetched_at = excluded.fetched_at`;

/**
 * Accepts a `fetchRecent()` row plus `sourceId`. A cheap header-only re-fetch
 * keeps the body and snippet a fuller fetch already stored — losing a body
 * because the second pass was cheaper would be a silent regression.
 */
export function upsertMessage(db, msg, { now = nowISO() } = {}) {
  if (!msg || typeof msg !== 'object') throw new TypeError('db: upsertMessage needs a message object');
  const sourceId = str(msg.sourceId ?? msg.source_id);
  const messageId = str(msg.messageId ?? msg.message_id);
  const uid = Number.isFinite(Number(msg.uid)) ? Number(msg.uid) : null;
  const id = str(msg.id) || messageRowId(sourceId, uid, messageId);
  const from = addr(msg.from);
  const direction = DIRECTIONS.includes(msg.direction) ? msg.direction : 'in';
  const existed = !!prep(db, 'SELECT 1 FROM messages WHERE id = ?').get(id);

  prep(db, MESSAGE_UPSERT).run({
    id,
    source_id: sourceId,
    uid,
    message_id: messageId,
    thread_key: str(msg.threadKey ?? msg.thread_key),
    folder: str(msg.folder),
    direction,
    from_name: from.name,
    from_email: from.email,
    to_json: json((msg.to || []).map(addr)),
    cc_json: json((msg.cc || []).map(addr)),
    subject: str(msg.subject),
    sent_at: strOrNull(msg.date ?? msg.sentAt ?? msg.sent_at),
    snippet: str(msg.snippet),
    body: str(msg.text ?? msg.body),
    has_attach: bit(msg.hasAttachments ?? msg.has_attach),
    flags_json: json(msg.flags || []),
    fetched_at: str(msg.fetchedAt ?? msg.fetched_at ?? now),
  });

  indexDoc(db, {
    ref: `msg:${id}`,
    kind: 'message',
    title: `${str(msg.subject)} ${from.name} ${from.email}`.trim(),
    body: `${str(msg.snippet)}\n${str(msg.text ?? msg.body)}`.trim(),
  });

  return { id, inserted: !existed };
}

export function upsertMessages(db, list, opts = {}) {
  const ids = [];
  let inserted = 0;
  withTransaction(db, () => {
    for (const msg of list || []) {
      const r = upsertMessage(db, msg, opts);
      ids.push(r.id);
      if (r.inserted) inserted += 1;
    }
  });
  return { ids, inserted, updated: ids.length - inserted };
}

export function getMessage(db, id) {
  return hydrateMessage(prep(db, 'SELECT * FROM messages WHERE id = ?').get(id));
}

export function listMessages(db, { sinceISO = null, sourceId = null, direction = null, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (sinceISO) { where.push('sent_at >= ?'); args.push(sinceISO); }
  if (sourceId) { where.push('source_id = ?'); args.push(sourceId); }
  if (direction) { where.push('direction = ?'); args.push(direction); }
  const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sent_at DESC LIMIT ?`;
  return prep(db, sql).all(...args, Math.max(1, Number(limit) || 500)).map(hydrateMessage);
}

export function messagesInThread(db, threadKey, { limit = 50 } = {}) {
  return prep(db, 'SELECT * FROM messages WHERE thread_key = ? ORDER BY sent_at ASC LIMIT ?')
    .all(str(threadKey), Math.max(1, Number(limit) || 50)).map(hydrateMessage);
}

/** How much arrived since a moment — what `shouldRunFull` needs. */
export function countMessagesFetchedSince(db, iso) {
  return Number(prep(db, 'SELECT COUNT(*) AS n FROM messages WHERE fetched_at > ?').get(str(iso)).n) || 0;
}

/* ---------------------------------------------------------------- events */

const EVENT_UPSERT = `
INSERT INTO events (id, calendar_id, uid, recurrence_id, title, description, location,
  starts_at, ends_at, all_day, organizer, attendees_json, rsvp, status, url, fetched_at)
VALUES (:id, :calendar_id, :uid, :recurrence_id, :title, :description, :location,
  :starts_at, :ends_at, :all_day, :organizer, :attendees_json, :rsvp, :status, :url, :fetched_at)
ON CONFLICT(id) DO UPDATE SET
  title          = excluded.title,
  description    = excluded.description,
  location       = excluded.location,
  starts_at      = excluded.starts_at,
  ends_at        = excluded.ends_at,
  all_day        = excluded.all_day,
  organizer      = excluded.organizer,
  attendees_json = excluded.attendees_json,
  rsvp           = excluded.rsvp,
  status         = excluded.status,
  url            = excluded.url,
  fetched_at     = excluded.fetched_at`;

/** Accepts an `Event` (SPEC §5) plus `calendarId`. */
export function upsertEvent(db, ev, { now = nowISO() } = {}) {
  if (!ev || typeof ev !== 'object') throw new TypeError('db: upsertEvent needs an event object');
  const calendarId = str(ev.calendarId ?? ev.calendar_id);
  const uid = str(ev.uid);
  const recurrenceId = str(ev.recurrenceId ?? ev.recurrence_id);
  const id = str(ev.id) || eventRowId(calendarId, uid, recurrenceId);
  const existed = !!prep(db, 'SELECT 1 FROM events WHERE id = ?').get(id);
  const organizer = ev.organizer && typeof ev.organizer === 'object'
    ? str(ev.organizer.email || ev.organizer.name)
    : str(ev.organizer);

  prep(db, EVENT_UPSERT).run({
    id,
    calendar_id: calendarId,
    uid,
    recurrence_id: recurrenceId,
    title: str(ev.title),
    description: str(ev.description),
    location: str(ev.location),
    starts_at: strOrNull(ev.startsAt ?? ev.starts_at),
    ends_at: strOrNull(ev.endsAt ?? ev.ends_at),
    all_day: bit(ev.allDay ?? ev.all_day),
    organizer,
    attendees_json: json(ev.attendees || []),
    rsvp: str(ev.rsvp),
    status: str(ev.status),
    url: strOrNull(ev.url),
    fetched_at: str(ev.fetchedAt ?? ev.fetched_at ?? now),
  });

  indexDoc(db, {
    ref: `evt:${id}`,
    kind: 'event',
    title: str(ev.title),
    body: `${str(ev.description)}\n${str(ev.location)}\n${organizer}`.trim(),
  });

  return { id, inserted: !existed };
}

export function upsertEvents(db, list, opts = {}) {
  const ids = [];
  let inserted = 0;
  withTransaction(db, () => {
    for (const ev of list || []) {
      const r = upsertEvent(db, ev, opts);
      ids.push(r.id);
      if (r.inserted) inserted += 1;
    }
  });
  return { ids, inserted, updated: ids.length - inserted };
}

export function getEvent(db, id) {
  return hydrateEvent(prep(db, 'SELECT * FROM events WHERE id = ?').get(id));
}

/**
 * Range filter on the ISO strings themselves. They carry an offset, so a
 * lexical comparison is only approximate at the boundaries — call it with a
 * range a little wider than you need and filter precisely upstream.
 */
export function listEvents(db, { from = null, to = null, calendarId = null, limit = 1000 } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('(ends_at IS NULL OR ends_at >= ?)'); args.push(from); }
  if (to) { where.push('starts_at <= ?'); args.push(to); }
  if (calendarId) { where.push('calendar_id = ?'); args.push(calendarId); }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY starts_at ASC LIMIT ?`;
  return prep(db, sql).all(...args, Math.max(1, Number(limit) || 1000)).map(hydrateEvent);
}

export function countEventsFetchedSince(db, iso) {
  return Number(prep(db, 'SELECT COUNT(*) AS n FROM events WHERE fetched_at > ?').get(str(iso)).n) || 0;
}

/* ----------------------------------------------------------------- items */

const ITEM_UPSERT = `
INSERT INTO items (id, kind, bucket, headline, why, person, person_email, due_at, severity, link,
  source_refs_json, payload_json, first_seen, seen_runs, last_seen_run, state, state_at, updated_at)
VALUES (:id, :kind, :bucket, :headline, :why, :person, :person_email, :due_at, :severity, :link,
  :source_refs_json, :payload_json, :now, 1, :run_id, :state, :now, :now)
ON CONFLICT(id) DO UPDATE SET
  kind             = excluded.kind,
  bucket           = excluded.bucket,
  headline         = excluded.headline,
  why              = excluded.why,
  person           = excluded.person,
  person_email     = excluded.person_email,
  due_at           = excluded.due_at,
  severity         = excluded.severity,
  link             = excluded.link,
  source_refs_json = excluded.source_refs_json,
  payload_json     = excluded.payload_json,
  seen_runs        = items.seen_runs + (CASE WHEN items.last_seen_run IS :run_id THEN 0 ELSE 1 END),
  last_seen_run    = :run_id,
  updated_at       = :now`;

/**
 * Upsert one derived item, keyed by the model's stable `key`.
 *
 * What survives a re-run, deliberately: `first_seen` (so the UI can say how long
 * a thing has been carried), `state`/`state_at` (the user's decision outranks
 * the model's opinion), and `seen_runs`, which counts *runs* — calling this
 * twice inside one run does not inflate it. Pass the `runId` for that reason:
 * without one, repeat upserts all look like the same (null) run and the counter
 * stops at 1.
 */
export function upsertItem(db, item, { runId = null, now = nowISO() } = {}) {
  if (!item || typeof item !== 'object') throw new TypeError('db: upsertItem needs an item object');
  const key = str(item.key);
  if (!key) throw new TypeError('db: upsertItem needs a non-empty key — it is what carries item identity across runs');
  const id = itemRowId(key);
  const before = prep(db, 'SELECT first_seen, seen_runs, state FROM items WHERE id = ?').get(id);

  prep(db, ITEM_UPSERT).run({
    id,
    kind: str(item.kind),
    bucket: assertBucket(item.bucket),
    headline: str(item.headline),
    why: str(item.why),
    person: str(item.person),
    person_email: str(item.personEmail ?? item.person_email),
    due_at: strOrNull(item.dueAt ?? item.due_at),
    severity: clampSeverity(item.severity),
    link: strOrNull(item.link),
    source_refs_json: json(item.sourceRefs ?? item.source_refs ?? []),
    payload_json: json(item.payload ?? {}),
    state: ITEM_STATES.includes(item.state) ? item.state : 'open',
    run_id: strOrNull(runId),
    now,
  });

  return { id, inserted: !before, firstSeen: before ? before.first_seen : now };
}

export function getItem(db, id) {
  return hydrateItem(prep(db, 'SELECT * FROM items WHERE id = ?').get(str(id)));
}

export function getItemByKey(db, key) {
  return getItem(db, itemRowId(str(key)));
}

/**
 * The user's decision. Returns the updated row, or null if there is no such item.
 *
 * `snoozedUntil` only means anything when the state being set is `snoozed`: a
 * zoned ISO timestamp arms the auto-wake in `listBoard()`, and null (the
 * default) is the old manual snooze that only a human wakes. Every *other*
 * state clears the column unconditionally — a wake-up call for an item that is
 * already done, dismissed or reopened would reopen it behind the user's back.
 */
export function setItemState(db, id, state, { now = nowISO(), snoozedUntil = null } = {}) {
  if (!ITEM_STATES.includes(state)) {
    throw new TypeError(`db: state must be one of ${ITEM_STATES.join('|')}, got ${JSON.stringify(state)}`);
  }
  const until = state === 'snoozed' ? strOrNull(snoozedUntil) : null;
  const res = prep(db, 'UPDATE items SET state = ?, state_at = ?, updated_at = ?, snoozed_until = ? WHERE id = ?')
    .run(state, now, now, until, str(id));
  if (!res.changes) return null;
  return getItem(db, id);
}

const BUCKET_RANK_SQL = `CASE bucket ${BUCKETS.map((b, i) => `WHEN '${b}' THEN ${i}`).join(' ')} ELSE ${BUCKETS.length} END`;

const WAKE_DUE_SNOOZES = `
UPDATE items SET state = 'open', snoozed_until = NULL, state_at = :now, updated_at = :now
WHERE state = 'snoozed' AND snoozed_until IS NOT NULL
  AND datetime(snoozed_until) <= datetime(:now)`;

/**
 * The board, in reading order: bucket, then severity, then what is due soonest,
 * then oldest-carried first. Nothing is dropped — `limit` is a safety rail, and
 * the UI folds the tail rather than hiding it.
 *
 * Reading the board is also what wakes snoozes that have come due. Putting the
 * wake here rather than on a timer means every reader — the server's
 * /api/state, the sweep's prior-items pass, the MCP tools — sees woken items
 * without any of them having to know snoozing exists. The UPDATE is cheap: the
 * `state = 'snoozed'` guard rides the items_state_bucket index, so on the usual
 * board it touches a handful of rows or none. A NULL snoozed_until is exempt on
 * purpose — that is the legacy manual snooze, and only the user wakes it. Both
 * sides of the `<=` go through datetime(), which normalises a zoned ISO string
 * to UTC — the server writes snoozed_until in the configured zone while the
 * sweep and MCP pass a machine-zone `now`, and comparing those lexically would
 * be off by the offset difference. A string datetime() cannot read becomes
 * NULL, and NULL never satisfies the comparison: garbage sleeps, safely.
 */
export function listBoard(db, { states = ['open'], buckets = null, limit = 500, now = nowISO() } = {}) {
  prep(db, WAKE_DUE_SNOOZES).run({ now });
  const args = [];
  const where = [];
  const stateList = (states || []).filter((s) => ITEM_STATES.includes(s));
  if (stateList.length) {
    where.push(`state IN (${stateList.map(() => '?').join(',')})`);
    args.push(...stateList);
  }
  const bucketList = (buckets || []).filter((b) => BUCKETS.includes(b));
  if (bucketList.length) {
    where.push(`bucket IN (${bucketList.map(() => '?').join(',')})`);
    args.push(...bucketList);
  }
  const sql = `
    SELECT * FROM items
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${BUCKET_RANK_SQL} ASC, severity DESC, (due_at IS NULL) ASC, due_at ASC, first_seen ASC
    LIMIT ?`;
  return prep(db, sql).all(...args, Math.max(1, Number(limit) || 500)).map(hydrateItem);
}

/** `{now: 2, today: 5, …}` — every bucket present, zeros included. */
export function bucketCounts(db, { states = ['open'] } = {}) {
  const stateList = (states || []).filter((s) => ITEM_STATES.includes(s));
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const sql = `SELECT bucket, COUNT(*) AS n FROM items ${stateList.length ? `WHERE state IN (${stateList.map(() => '?').join(',')})` : ''} GROUP BY bucket`;
  for (const row of prep(db, sql).all(...stateList)) {
    if (Object.hasOwn(counts, row.bucket)) counts[row.bucket] = Number(row.n);
  }
  return counts;
}

/* ---------------------------------------------------------------- drafts */

/** A draft is never sent by Zelos; this only records what was prepared. */
export function upsertDraft(db, draft, { now = nowISO() } = {}) {
  if (!draft || typeof draft !== 'object') throw new TypeError('db: upsertDraft needs a draft object');
  const itemId = str(draft.itemId ?? draft.item_id);
  // One draft per item: re-deriving it on the next run must not pile up copies.
  const id = str(draft.id) || hashId('draft', itemId);
  const state = DRAFT_STATES.includes(draft.state) ? draft.state : 'pending';
  const existing = prep(db, 'SELECT id, state, created_at FROM drafts WHERE id = ?').get(id);

  if (existing) {
    // A draft the user has touched is theirs; a fresh derivation must not
    // silently overwrite their edit or resurrect one they discarded.
    if (existing.state === 'edited' || existing.state === 'used' || existing.state === 'discarded') {
      return { id, inserted: false, skipped: true };
    }
    prep(db, 'UPDATE drafts SET item_id = ?, to_email = ?, subject = ?, body = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(itemId, str(draft.to ?? draft.to_email), str(draft.subject), str(draft.body), state, now, id);
    return { id, inserted: false, skipped: false };
  }

  prep(db, 'INSERT INTO drafts (id, item_id, to_email, subject, body, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, itemId, str(draft.to ?? draft.to_email), str(draft.subject), str(draft.body), state, now, now);
  return { id, inserted: true, skipped: false };
}

export function getDraft(db, id) {
  return prep(db, 'SELECT * FROM drafts WHERE id = ?').get(str(id)) ?? null;
}

export function listDrafts(db, { states = null, itemId = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  const stateList = (states || []).filter((s) => DRAFT_STATES.includes(s));
  if (stateList.length) {
    where.push(`state IN (${stateList.map(() => '?').join(',')})`);
    args.push(...stateList);
  }
  if (itemId) { where.push('item_id = ?'); args.push(str(itemId)); }
  const sql = `SELECT * FROM drafts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
  return prep(db, sql).all(...args, Math.max(1, Number(limit) || 200));
}

/** PUT /api/drafts/:id — returns the updated draft, or null if it is gone. */
export function updateDraft(db, id, { body, subject, to, state } = {}, { now = nowISO() } = {}) {
  const sets = [];
  const args = [];
  if (body !== undefined) { sets.push('body = ?'); args.push(str(body)); }
  if (subject !== undefined) { sets.push('subject = ?'); args.push(str(subject)); }
  if (to !== undefined) { sets.push('to_email = ?'); args.push(str(to)); }
  if (state !== undefined) {
    if (!DRAFT_STATES.includes(state)) throw new TypeError(`db: draft state must be one of ${DRAFT_STATES.join('|')}`);
    sets.push('state = ?');
    args.push(state);
  }
  if (!sets.length) return getDraft(db, id);
  sets.push('updated_at = ?');
  args.push(now, str(id));
  const res = prep(db, `UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return res.changes ? getDraft(db, id) : null;
}

/* -------------------------------------------------------------- captures */

export function insertCapture(db, text, { now = nowISO() } = {}) {
  const body = str(text).trim();
  if (!body) throw new TypeError('db: insertCapture needs some text');
  const id = `cap_${crypto.randomBytes(5).toString('hex')}`;
  prep(db, 'INSERT INTO captures (id, text, created_at, processed_at) VALUES (?,?,?,NULL)').run(id, body, now);
  indexDoc(db, { ref: `cap:${id}`, kind: 'capture', title: body.slice(0, 80), body });
  return { id, text: body, created_at: now, processed_at: null };
}

export function listCaptures(db, { includeProcessed = false, limit = 200 } = {}) {
  const sql = `SELECT * FROM captures ${includeProcessed ? '' : 'WHERE processed_at IS NULL'} ORDER BY created_at DESC LIMIT ?`;
  return prep(db, sql).all(Math.max(1, Number(limit) || 200));
}

export function markCaptureProcessed(db, id, { now = nowISO() } = {}) {
  const res = prep(db, 'UPDATE captures SET processed_at = ? WHERE id = ?').run(now, str(id));
  return res.changes > 0;
}

/* ------------------------------------------------------------------ runs */

export function startRun(db, { kind = 'full', model = '', now = nowISO() } = {}) {
  const id = `run_${crypto.randomBytes(6).toString('hex')}`;
  prep(db, `INSERT INTO runs (id, kind, started_at, ended_at, ok, model, tokens_in, tokens_out, error, stats_json)
            VALUES (?,?,?,NULL,NULL,?,0,0,NULL,'{}')`).run(id, str(kind), now, str(model));
  return id;
}

export function finishRun(db, id, { ok = true, error = null, tokensIn = 0, tokensOut = 0, stats = {}, model = null, now = nowISO() } = {}) {
  prep(db, `UPDATE runs SET ended_at = ?, ok = ?, tokens_in = ?, tokens_out = ?, error = ?, stats_json = ?,
            model = COALESCE(?, model) WHERE id = ?`)
    .run(now, bit(ok), Number(tokensIn) || 0, Number(tokensOut) || 0, strOrNull(error), json(stats), strOrNull(model), str(id));
  return getRun(db, id);
}

export function getRun(db, id) {
  return hydrateRun(prep(db, 'SELECT * FROM runs WHERE id = ?').get(str(id)));
}

/** The most recent run, optionally of a kind and optionally only successful ones. */
export function lastRun(db, { kind = null, okOnly = false } = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(str(kind)); }
  if (okOnly) where.push('ok = 1');
  const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT 1`;
  return hydrateRun(prep(db, sql).get(...args));
}

export function listRuns(db, { limit = 20 } = {}) {
  return prep(db, 'SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(Math.max(1, Number(limit) || 20)).map(hydrateRun);
}

/* -------------------------------------------------------------------- kv */

export function getKV(db, k) {
  const row = prep(db, 'SELECT v FROM kv WHERE k = ?').get(str(k));
  return row ? row.v : null;
}

export function setKV(db, k, v) {
  prep(db, 'INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(str(k), str(v));
  return v;
}

export function deleteKV(db, k) {
  return prep(db, 'DELETE FROM kv WHERE k = ?').run(str(k)).changes > 0;
}

/* ---------------------------------------------------------------- search */

/**
 * FTS5 has no unique constraint, so "upsert" is delete-then-insert on `ref`.
 * Refs are namespaced: msg:<id>, evt:<id>, item:<id>, cap:<id>.
 */
export function indexDoc(db, { ref, kind = '', title = '', body = '' }) {
  const r = str(ref);
  if (!r) throw new TypeError('db: indexDoc needs a ref');
  prep(db, 'DELETE FROM search WHERE ref = ?').run(r);
  prep(db, 'INSERT INTO search (title, body, ref, kind) VALUES (?,?,?,?)').run(str(title), str(body), r, str(kind));
  return r;
}

export function removeDoc(db, ref) {
  return prep(db, 'DELETE FROM search WHERE ref = ?').run(str(ref)).changes > 0;
}

/**
 * Build a MATCH expression that cannot be a syntax error. The query is mail —
 * i.e. attacker-controlled — so bare FTS5 operators from user or message text
 * must never reach the parser. Every term is quoted; the last one gets a `*` so
 * search behaves like typing ahead.
 */
export function ftsQuery(raw) {
  const terms = (String(raw ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 24);
  if (!terms.length) return null;
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  if (terms[terms.length - 1].length >= 2) quoted[quoted.length - 1] += '*';
  return quoted.join(' ');
}

/**
 * Ranked hits. `score` is higher-is-better (bm25 negated), so callers can sort
 * or threshold without remembering which way sqlite's rank runs.
 */
/**
 * `columns` restricts which FTS columns the MATCH may touch — pass `['title']`
 * to make body text genuinely unsearchable rather than merely unreturnable.
 *
 * That distinction matters for AI access. Dropping the body from the *response*
 * still leaves an existence oracle: ask for a word, and a hit tells you the word
 * is in someone's mail. One question at a time, an assistant could confirm
 * anything it could guess. With the column filter, a body-only term simply does
 * not match, so "you may see who wrote and about what, but not what it said"
 * is true of querying as well as of reading.
 */
export function search(db, query, { limit = 20, kinds = null, columns = null } = {}) {
  let match = ftsQuery(query);
  if (!match) return [];
  if (Array.isArray(columns) && columns.length) {
    const allowed = columns.filter((c) => c === 'title' || c === 'body');
    if (!allowed.length) return [];
    // FTS5 column filter: {title body} : (…). Braces let it take a set.
    match = `{${allowed.join(' ')}} : (${match})`;
  }
  const kindList = (kinds || []).filter((k) => typeof k === 'string' && k);
  const sql = `
    SELECT ref, kind, title,
           snippet(search, 1, '', '', '…', 12) AS excerpt,
           -bm25(search) AS score
    FROM search
    WHERE search MATCH ?
      ${kindList.length ? `AND kind IN (${kindList.map(() => '?').join(',')})` : ''}
    ORDER BY bm25(search) ASC
    LIMIT ?`;
  try {
    return prep(db, sql).all(match, ...kindList, Math.max(1, Number(limit) || 20));
  } catch (err) {
    // A malformed MATCH should return nothing, not take down the request.
    log.warn('db: search failed', { error: err.message });
    return [];
  }
}

/** Rebuild the whole index from the tables it mirrors. Returns the doc count. */
export function reindex(db) {
  return withTransaction(db, () => {
    db.exec('DELETE FROM search');
    const insert = prep(db, 'INSERT INTO search (title, body, ref, kind) VALUES (?,?,?,?)');
    let n = 0;
    for (const m of prep(db, 'SELECT id, subject, from_name, from_email, snippet, body FROM messages').all()) {
      insert.run(`${str(m.subject)} ${str(m.from_name)} ${str(m.from_email)}`.trim(), `${str(m.snippet)}\n${str(m.body)}`.trim(), `msg:${m.id}`, 'message');
      n += 1;
    }
    for (const e of prep(db, 'SELECT id, title, description, location, organizer FROM events').all()) {
      insert.run(str(e.title), `${str(e.description)}\n${str(e.location)}\n${str(e.organizer)}`.trim(), `evt:${e.id}`, 'event');
      n += 1;
    }
    for (const i of prep(db, 'SELECT id, headline, why, person, person_email FROM items').all()) {
      insert.run(str(i.headline), `${str(i.why)}\n${str(i.person)}\n${str(i.person_email)}`.trim(), `item:${i.id}`, 'item');
      n += 1;
    }
    for (const c of prep(db, 'SELECT id, text FROM captures').all()) {
      insert.run(str(c.text).slice(0, 80), str(c.text), `cap:${c.id}`, 'capture');
      n += 1;
    }
    return n;
  });
}

/** Resolve "msg:<id>" / "evt:<id>" / "item:<id>" / "cap:<id>" to its row. */
export function resolveRef(db, ref) {
  const m = /^(msg|evt|item|cap):(.+)$/.exec(str(ref));
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === 'msg') return getMessage(db, id);
  if (kind === 'evt') return getEvent(db, id);
  if (kind === 'item') return getItem(db, id);
  return prep(db, 'SELECT * FROM captures WHERE id = ?').get(id) ?? null;
}
