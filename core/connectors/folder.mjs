/**
 * core/connectors/folder.mjs — a folder on this machine that anything can drop
 * a file into.
 *
 * THIS IS THE ANSWER TO "GENERIC WEBHOOK", AND IT IS NOT A COMPROMISE.
 *
 * Zelos binds 127.0.0.1 and opens no inbound port, so a webhook is not a feature
 * that was skipped — it is structurally impossible, and every way of restoring
 * it (a tunnel, a relay, a hosted forwarder) puts back the server the product
 * deliberately does not have, along with a public URL that anybody who guesses
 * it can post to. A watched directory buys the same thing with none of it: a
 * cron job, a shell script, a Shortcut, an `at`, a Syncthing or iCloud folder,
 * or a human dragging a file all become inputs, and the authorisation check is
 * the one the operating system already performs on the directory. There is no
 * token to leak because there is no listener to authenticate to.
 *
 * `credential: null` and `origins: []` are therefore both literal truths rather
 * than defaults: there is nothing to authenticate (a path on the user's own
 * disk) and nothing to contact. `ctx.http` is never touched by this file.
 *
 * ------------------------------------------------------------------------
 * WHAT HAPPENS TO A FILE ONCE IT HAS BEEN READ. Nothing. Ever.
 * ------------------------------------------------------------------------
 *
 * The three options were: delete it, move it into `archive/`, or remember it.
 *
 * DELETE is out on principle — a read-only product that removes the user's file
 * is not read-only, and "Zelos ate the only copy of the thing my script wrote"
 * is an unrecoverable bug report. MOVE is the same act wearing a hat: it is
 * still a write into a directory the user owns, it still breaks whatever else
 * was watching that folder, it fails halfway across a filesystem boundary, and
 * — the part that settles it — an opt-in toggle for it would have to live
 * somewhere. There is no slot for it. `ALLOWED_KEYS` in ../index.mjs refuses at
 * IMPORT TIME any manifest key that is a verb changing something at a source,
 * and a `moveAfterRead` field would be that verb smuggled in through `fields[]`.
 * The interface said no before this file was written.
 *
 * So: REMEMBER. And remembering is cheap here because identity does the heavy
 * lifting. `messageId` is a hash of the file's NAME AND ITS BYTES (see
 * `rowFor`), so re-reading the same file upserts the same row — core/db.mjs:385
 * keys on `messageRowId(sourceId, uid, messageId)` and the upsert preserves what
 * is already there. Duplicates are impossible even with no cursor at all. The
 * cursor is a work-saving device, not a correctness device, and that asymmetry
 * is the whole design: it can be wrong in exactly one direction, and the wrong
 * direction costs a re-read of a small file on local disk.
 *
 * What the user is told to do instead, in the field hint and in `check()`, is
 * `mv` the files out themselves. That works with no product surface at all
 * because this connector does not recurse: a subdirectory named `archive/`
 * inside the watched folder is invisible to it.
 *
 * ------------------------------------------------------------------------
 * THE CURSOR, AND THE CEILING THAT SHAPES IT
 * ------------------------------------------------------------------------
 *
 * core/sweep.mjs:111 caps a serialised cursor at 4,096 characters and DROPS
 * anything larger with a log warning. A cursor is meant to be "a page token, an
 * ETag, a high-water timestamp", and the obvious shape here — `{name: mtime:size}`
 * for every file — costs roughly 45 characters per file, so a folder of 200
 * files serialises to about 9 KB, sails past the ceiling, and is silently
 * discarded. The failure that produces is invisible and permanent: every file is
 * re-read on every sweep, forever, and nothing anywhere says why.
 *
 * So the cursor stores a 10-hex-character digest of `name\0mtimeMs\0size` per
 * file and nothing else. Serialised, one digest costs 13 characters (`"…",`),
 * so the 300 this carries come to 3,915 with the envelope — measured — against
 * a ceiling of 4,096. `test/connector-folder.test.mjs` reads that 4,096 out of
 * core/sweep.mjs as text and asserts a full cursor fits under it, so the two
 * cannot drift apart: 181 characters of slack is thin enough that one more
 * field in the envelope would silently cost every cursor this source writes.
 *
 * A high-water mtime would have been smaller still, and was rejected: `cp -p`,
 * rsync, Syncthing and iCloud all preserve mtimes, so a file restored into the
 * folder with last month's timestamp would land below the mark and never be read
 * — a silent miss, which is the one failure mode this design refuses. The digest
 * set fails the other way instead: a folder holding more files than the cursor
 * remembers re-reads some of them, and upserts rows it already had.
 *
 * The list is rebuilt from the directory each sweep rather than appended to, so
 * a file the user deletes drops out of the cursor on its own.
 *
 * WHAT THE CEILING COSTS, STATED HONESTLY. An earlier draft of this comment
 * described that last case as a one-off — "forgets the oldest, re-reads them
 * next sweep". It is not one-off, it is permanent: `kept` retains the NEWEST
 * digests while `ready` reads the OLDEST files, so the two ends fight and the
 * same files fall out every sweep (measured at 300 files against the old 240:
 * 200, 100, 60, 60, … rows, and it stays at 60 forever). Raising the number to
 * 300 moves where that starts, and nothing moves it further — any deterministic
 * choice of 300 digests out of 400 files forgets 100 of them, so within a
 * 4,096-character cursor this is a ceiling and not a bug to fix. What it costs
 * is a re-read of a small local file and an idempotent upsert; what it never
 * costs is a duplicate row (`messageId` hashes the bytes) or an extra model run
 * (`pendingNew` is bumped by `inserted`, which is zero for a row that existed).
 *
 * ------------------------------------------------------------------------
 * WHAT THE USER IS TOLD, AND HOW OFTEN
 * ------------------------------------------------------------------------
 *
 * A part's `note` becomes `sources[].error` and core/sweep.mjs:719 sets
 * `ok: !note`, so every sentence returned from here paints the source red on
 * the board. That makes "how often" a design question rather than a wording
 * one, and there are exactly two answers:
 *
 *  - A REFUSAL is a fact about one version of one file that will not change on
 *    its own. It is recorded in the cursor and said ONCE. The trap this file
 *    walked into for its whole first life is that both refusals decided during
 *    the walk — a directory named `x.json`, an over-size file — were decided
 *    ABOVE the `seen` gate, so their digests were written into the cursor and
 *    nothing ever read them back: measured over six consecutive sweeps, the
 *    identical sentence came out red every time for a file nobody was ever
 *    going to fix. The gate is now the first thing after the lstat, above every
 *    refusal, which is the only ordering that makes the promise true.
 *  - A DEFERRAL is a fact about this sweep, and each cause now gets its own
 *    sentence. They used to share the cap's — "Zelos reads 200 a sweep, and
 *    will take it next time" — which is false for every cause but the cap and
 *    named no file: a mode-000 file reported itself that way on every sweep
 *    forever (measured: rows 1, 0, 0 and the same sentence three times), and so
 *    did a sweep the user had cancelled.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { paths } from '../config.mjs';
import { parseDate } from '../sources/mime.mjs';

/** The only two extensions read, lowercased. Everything else is not ours. */
const EXTENSIONS = new Set(['.json', '.txt']);

/**
 * One file's ceiling.
 *
 * A note, a JSON payload from a script, a form dump: none of them are a
 * megabyte. What this number really refuses is the 2 GB case — a log, a
 * database dump, a video someone parked in the folder and renamed — and it is
 * checked against `stat` BEFORE anything is opened, so the bytes are never
 * allocated. The read is capped a second time at the same number, because a
 * file can grow between the stat and the read.
 */
export const MAX_FILE_BYTES = 1_000_000;

/** How many files one sweep will ingest. The rest wait for the next one. */
export const MAX_FILES_PER_SWEEP = 200;

/**
 * How far into a directory listing this will walk at all.
 *
 * `opendir` is iterated rather than `readdir`-ed for exactly this: readdir
 * materialises every entry before returning one, so a folder somebody pointed
 * at their Downloads directory costs the array before any cap can apply.
 */
export const MAX_DIR_ENTRIES = 5_000;

/** How many file digests the cursor carries. See the header for the arithmetic. */
export const MAX_REMEMBERED = 300;

/** How many refused files are named in one report before it becomes a count. */
const MAX_REPORTED = 5;

/** Matches core/connectors/rss.mjs: the same board renders both. */
const SNIPPET_CHARS = 400;
export const BODY_CHARS = 20_000;

/**
 * The subject, and the `link` glued onto the body.
 *
 * BODY_CHARS was doing this job for one field out of three, so the other two
 * left by the side door: `{"title": "A".repeat(900000)}` reached
 * `messages.subject`, the FTS title, every `GET /api/state` and the Settings
 * export at its full 900,000 characters from a source whose bodies stop at
 * 20,000 — measured — and `link` was concatenated AFTER the body was sliced,
 * which put `text` at 50,003 characters for a 3-character body. A cap two of
 * the four fields honour is not a cap. 300 is longer than any subject a person
 * writes and shorter than anything that is really a document; 2,000 is past
 * every URL length limit worth naming, so a longer one was never a link.
 */
const TITLE_CHARS = 300;
const LINK_CHARS = 2_000;

/**
 * How far ahead of this machine's clock an mtime may be and still mean "a
 * writer is busy with this right now".
 *
 * The mid-write guard in `scan` defers any file whose mtime is later than the
 * instant the sweep began. Unbounded, that is not a deferral but a permanent
 * silent miss: an SMB or NAS share whose clock runs fast, a Syncthing or iCloud
 * peer a few seconds ahead, an archive unpacked with a bogus timestamp,
 * `touch -t 203001010000`. Measured with a 30-day-ahead mtime, three
 * consecutive sweeps read nothing and reported the file as "waiting" — and it
 * would have waited until this machine's calendar caught up with it. The header
 * calls a silent miss the one failure mode this design refuses, so the guard
 * gets a window: inside it, wait; outside it, the CLOCK is wrong rather than
 * the writer being busy, and the file is read. Content stability does not rest
 * on this guard alone — `readStable` brackets the read with two stats on the
 * same handle and compares both against the listing's — so the cost of being
 * wrong here is a re-read, not a truncated note.
 *
 * The same number bounds a file's own stated `date` (see `fileDate`): a
 * document claiming the year 9999 is choosing where it sits on a board ordered
 * by `sent_at`, forever.
 */
const FUTURE_SKEW_MS = 2 * 60_000;

/** 40 bits. A collision means one file is never read; at 300 entries that is ~2e-6. */
const SIG_HEX = 10;

/** The separator inside every digest below: the one byte a filename cannot hold. */
const SEP = String.fromCharCode(0);

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const str = (v) => (typeof v === 'string' ? v : (v == null || typeof v === 'object' ? '' : String(v)));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The folder this source watches.
 *
 * `~/.zelos` IS NOT A DIRECTORY NAME HERE, IT IS THE ZELOS HOME, and `ZELOS_HOME`
 * moves it. That looks like over-cleverness until you follow what
 * ui/views/settings.js:224 does with `f.default`: it pre-fills the control with
 * it, and `read()` hands back whatever is in the box — so the very first save
 * writes the literal string `~/.zelos/inbox` into config.json without the user
 * having typed a character. If that string then expanded through `os.homedir()`,
 * a blank field and a saved-untouched field would name two different folders on
 * every install whose home has been relocated: the desktop build, a test, and
 * anybody running two profiles. One of the two would be watched and the other
 * would be written to, with nothing to see.
 *
 * `paths()` is called lazily and only on the branches that need it, never at
 * module load — it creates directories, and core/connectors/index.mjs's header
 * is explicit about how close the config/registry import edge sits to a TDZ
 * crash at launch. core/sources/caldav.mjs:34 imports it the same way.
 *
 * A RELATIVE PATH RESOLVES AGAINST THE ZELOS HOME, NOT `process.cwd()`. The
 * field hint says "Folder" and offers `~/.zelos/inbox`, so a bare `inbox` is a
 * plausible thing to type — and `path.resolve('inbox')` measured as
 * `…/Desktop/the claw/zelos/inbox`, which is simply wherever the process was
 * started. The Electron shell has a different cwd launched from Finder, from a
 * login item and from a terminal, so one saved config would name three folders
 * on one machine: one of them written to, the others empty, and none of them
 * reported as wrong (an empty folder that exists is a quiet success). The home
 * is the only anchor this process has that does not move, and it is the one the
 * default already points at.
 */
export function resolveFolder(settings) {
  const raw = String(settings?.path ?? '').trim();
  if (!raw) return path.join(paths().home, 'inbox');
  if (raw === '~') return os.homedir();

  const tilde = /^~[\\/](.*)$/s.exec(raw);
  if (!tilde) return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(paths().home, raw);

  const rest = tilde[1];
  const zelos = /^\.zelos(?:[\\/](.*))?$/s.exec(rest);
  if (zelos) return zelos[1] ? path.join(paths().home, zelos[1]) : paths().home;
  return path.join(os.homedir(), rest);
}

/** `name\0mtimeMs\0size` -> the cursor's memory of one file. */
const signature = (name, stat) => crypto.createHash('sha256')
  .update(`${name}\u0000${stat.mtimeMs}\u0000${stat.size}`)
  .digest('hex').slice(0, SIG_HEX);

/**
 * A filename, made safe to put in a sentence that leaves this process.
 *
 * A refusal names the file, the sentence becomes `sources[].error`, and that
 * lands in `runs.stats_json`, in every `GET /api/state`, and in the Settings
 * export. A filename is a string from OUTSIDE — trivially so once the folder is
 * a shared sync directory, which is one of the headline uses — so
 * `<img src=x onerror=…>.json` is a name somebody can create.
 *
 * `screenContent` is not used, deliberately. It THROWS rather than sanitises,
 * which is right for model output and wrong here: refusing to report a bad file
 * because its name is also bad is the worst of the available outcomes. The two
 * characters that can begin a tag are removed, control and zero-width
 * characters go with them, and the length is capped — which leaves an
 * international filename readable, unlike a charset allow-list.
 */
function displayName(name) {
  return String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/[<>]/g, ' ')
    .trim()
    .slice(0, 60) || '(unnamed)';
}

/**
 * Bytes -> text, for the two ways a shell actually writes a file.
 *
 * PowerShell 5's `>` writes UTF-16LE with a BOM — `echo hi > note.txt` on a
 * stock Windows box produces a file that decodes as UTF-8 into `h\0i\0`, which
 * would otherwise be refused below as binary. That is the single most likely
 * first file a Windows user drops in this folder, so it is decoded rather than
 * rejected. A UTF-8 BOM (Notepad, and Excel's CSV export) is stripped: it is a
 * quoting device, and left in place it becomes the first character of the title.
 *
 * UTF-16BE is deliberately not handled. Nothing writes it by accident, and a
 * file that really is UTF-16BE falls through to the NUL check and is refused by
 * name rather than ingested as mojibake.
 */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  return buf.toString('utf8');
}

/**
 * Read at most `cap` bytes from an already-open handle.
 *
 * `handle.readFile()` reads to EOF, which is the wrong verb for a file that may
 * be growing: the stat said 900 KB and the writer is still going. This stops at
 * the ceiling regardless of what the file has become since.
 *
 * The buffer is sized to the file rather than to the ceiling. It used to be
 * `Buffer.alloc(cap + 1)` every time, which zero-filled a megabyte to carry two
 * bytes: measured at 200 MB allocated across a sweep of 200 two-byte notes, on
 * the hot path of a connector whose entire subject matter is small notes. The
 * `+ 1` is the part that must survive — it is how a file that GREW between the
 * stat and the read is detected, since `readStable` rejects any read whose
 * length does not equal the size stat'ed on the same handle.
 */
export async function readCapped(handle, cap, expected) {
  const want = Number.isFinite(expected) ? Math.min(cap, Math.max(0, expected)) : cap;
  const buf = Buffer.alloc(want + 1);
  let total = 0;
  while (total < buf.length) {
    const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

/**
 * `Ada Lovelace <ada@example.com>` / `ada@example.com` / `Ada Lovelace`.
 *
 * core/db.mjs never validates `from_email` as an address, so the only thing at
 * stake is whether the board shows a name or an address — and a script writing
 * `"from": "nightly backup"` must not have that land in the email column, where
 * every downstream reader treats it as something you could reply to.
 */
function addressOf(raw, fallbackName) {
  const value = collapse(raw);
  if (!value) return { name: fallbackName, email: '' };
  const angled = /^(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (angled) return { name: collapse(angled[1]) || fallbackName, email: collapse(angled[2]) };
  if (value.includes('@') && !/\s/.test(value)) return { name: fallbackName, email: value };
  return { name: value, email: '' };
}

/**
 * The documented JSON shape, and what happens to everything that is not it.
 *
 * -> {ok: true, fields} | {ok: false, why}
 *
 *   {"title": "…", "body": "…", "from": "…", "date": "…", "link": "…"}
 *
 * Five keys, all optional, all ignored if they are not scalars, and any other
 * key is ignored silently — a script that also writes `"run_id"` should not be
 * refused for being generous. What IS refused is a document that cannot be a
 * message: an array (one file is one message, which is what keeps the content
 * hash an identity), a bare string or number, and an object with neither a
 * title nor a body, which would arrive on the board as an empty row nobody can
 * account for.
 *
 * A `.txt` file is a note whose title is the filename, per the same rule read
 * from the other end: the thing a human would call it is what they named it.
 */
function fieldsFrom(name, ext, text) {
  const stem = name.slice(0, name.length - ext.length) || name;

  if (ext !== '.json') return { ok: true, fields: { title: stem, body: text, from: '', date: '', link: '' } };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, why: `is not valid JSON (${collapse(err?.message).slice(0, 90)})` };
  }
  if (Array.isArray(doc)) {
    return { ok: false, why: 'is a JSON array, and Zelos reads one message per file' };
  }
  if (!isPlainObject(doc)) {
    return { ok: false, why: 'is JSON, but not an object with title/body/from/date/link' };
  }

  const fields = {
    title: collapse(str(doc.title)).slice(0, TITLE_CHARS),
    body: str(doc.body),
    from: str(doc.from),
    date: str(doc.date),
    link: collapse(str(doc.link)).slice(0, LINK_CHARS),
  };
  if (!fields.title && !fields.body.trim()) {
    return { ok: false, why: 'is JSON with neither a title nor a body' };
  }
  if (!fields.title) fields.title = stem.slice(0, TITLE_CHARS);
  return { ok: true, fields };
}

/**
 * When did the thing in this file happen? -> an ISO instant, always in UTC.
 *
 * The mtime is the honest fallback: for anything a script wrote, the moment it
 * wrote it IS the event, and a row with no date sorts nowhere in particular on
 * a board ordered by time. What is new here is that a STATED date is bounded by
 * it, and normalised.
 *
 * BOUNDED, because `sent_at` is the sort key. `parseDate` accepts any year up
 * to 9999 (core/sources/mime.mjs:743), so `{"date":"9999-01-01T00:00:00Z"}`
 * measured as the top row of `listMessages` — above genuine mail, on every read
 * for the rest of the install. The headline use for this connector is a shared
 * sync folder, which is to say the writer is explicitly not guaranteed to be
 * the user; subjects and bodies from a stranger are normal and fine (so is
 * mail), but a stranger choosing what the board shows first is not. The mtime
 * is the one timestamp here the operating system wrote, so it is the ceiling. A
 * date in the PAST is left alone: backdating is a legitimate thing for a script
 * to state and it cannot buy priority.
 *
 * NORMALISED, because core/db.mjs orders and filters `sent_at` as TEXT. A
 * stored `2026-08-01T10:00:00-05:00` sorts as though it were 10:00 UTC — five
 * hours before it happened — against every Z-form row, and this file emitted
 * both forms: `parseDate` yields `+00:00` where the mtime fallback yields `Z`,
 * and `+` (0x2B) sorts before `Z` (0x5A), so two rows at the same instant
 * ordered by their suffix. One format, one meaning.
 *
 * THE MTIME IS BOUNDED TOO, and that is a debt from the fix above it. Now that
 * a file stamped a month in the future is read rather than deferred forever,
 * its mtime — the fallback and the ceiling — would sit a month in the future in
 * `sent_at`, which is the same top-of-the-board pin arriving through the clock
 * instead of through the payload. A machine cannot know what time it is
 * anywhere else, so the honest reading of a timestamp ahead of this clock is
 * "as good as now".
 */
function fileDate(raw, mtimeMs, nowMs) {
  const ceiling = Math.min(mtimeMs, nowMs + FUTURE_SKEW_MS);
  const parsed = parseDate(raw);
  const ms = parsed ? Date.parse(parsed) : NaN;
  if (Number.isFinite(ms) && ms <= ceiling + FUTURE_SKEW_MS) return new Date(ms).toISOString();
  return new Date(ceiling).toISOString();
}

/**
 * One file -> one `messages` row (SPEC §4 / core/db.mjs:380).
 *
 * THE `uid` KEY IS ABSENT AND MUST STAY ABSENT. core/db.mjs:384 reads
 * `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes 0
 * while an omitted uid stays null, and the two hash to different row ids. A
 * release that flipped between them would re-insert every file this folder has
 * ever held, on every sweep. A file has no integer identity; there is nothing
 * here to put in that field even if it existed.
 *
 * `messageId` hashes THE NAME AND THE BYTES, and both halves earn their place:
 *
 *  - bytes, so that re-reading an untouched file is a no-op upsert. This is what
 *    makes "never delete, never move" affordable.
 *  - the name, so that two different scripts writing an identical line ("ok")
 *    into `backup.txt` and `sync.txt` are two notes and not one. Without it the
 *    second file would vanish into the first with no trace.
 *
 * The consequence to be honest about: EDITING a file in place produces a second
 * row rather than updating the first. That is the safer of the two errors. The
 * alternative — identity from the filename alone — means a user who drops a
 * fresh `note.txt` a month after dismissing the old one gets a row that is
 * already dismissed, because `items` carry state across an upsert on purpose
 * (core/db.mjs:22). Resurrecting a dismissed row silently is worse than an
 * extra note the user can see and dismiss.
 *
 * `threadKey` IS NOT `messageId`, AND THE GAP BETWEEN THEM IS THE POINT. It
 * was, and that made every row a conversation of one: measured,
 * `messagesInThread` returned exactly 1 row for every row this connector has
 * ever written, and `threadIndex` (core/triage.mjs:520) saw a folder of N notes
 * as N unrelated threads. A script that rewrites `status.txt` every morning is
 * writing ONE conversation, and a human reads Monday's and Tuesday's status
 * that way. So the thread is keyed on the two things that survive a rewrite —
 * the folder and the filename — while `messageId` goes on hashing the bytes.
 * Nothing in the argument above is weakened by that: `items` carry their state
 * across an upsert keyed on `messageRowId`, never on `thread_key`, so a
 * dismissed row still cannot be resurrected by a new file with the same name.
 * The FULL PATH is hashed rather than the basename, because the basename is a
 * display name: two sources both watching a folder called `inbox` would
 * otherwise thread each other's files together.
 */
function rowFor({ name, ext, bytes, text, stat, dir, folderName, nowMs }) {
  const parsed = fieldsFrom(name, ext, text);
  if (!parsed.ok) return parsed;

  const { title, body, from, date, link } = parsed.fields;
  const digest = crypto.createHash('sha256').update(name).update('\u0000').update(bytes).digest('hex');
  const messageId = `folder:sha256:${digest.slice(0, 32)}`;
  const thread = crypto.createHash('sha256').update(`${dir}`).update(SEP).update(name).digest('hex');

  /* The link is inside the body's budget rather than exempt from it: it is
     measured first and the body takes what is left, so `text` cannot pass
     BODY_CHARS however long either half is. Slicing the pair afterwards would
     have been shorter to write and would silently drop the link for any body at
     the ceiling — the half more likely to be worth keeping. */
  const tail = link ? `\n\n${link}` : '';
  const trimmed = body.slice(0, Math.max(0, BODY_CHARS - tail.length));

  return {
    ok: true,
    row: {
      messageId,
      threadKey: `folder:name:${thread.slice(0, 32)}`,
      folder: folderName,
      direction: 'in',
      from: addressOf(from, folderName),
      to: [],
      cc: [],
      subject: title || '(untitled)',
      date: fileDate(date, stat.mtimeMs, nowMs),
      snippet: collapse(trimmed).slice(0, SNIPPET_CHARS),
      text: `${trimmed}${tail}`.trim(),
      hasAttachments: false,
      flags: [],
    },
  };
}

/**
 * Why files were not read this sweep, kept apart by cause.
 *
 * One integer used to carry all five of these, and every one of them borrowed
 * the cap's sentence — "N more files are waiting, Zelos reads 200 a sweep and
 * will take them next time". For four of the five that sentence is simply
 * untrue and it never names a file, so a mode-000 file reported itself that way
 * on every sweep forever (measured: rows 1, 0, 0 over three sweeps, the same
 * words each time, the filename never mentioned) and so did a sweep the user
 * had cancelled before anything was read. Two of these causes deserve silence,
 * two deserve a sentence of their own, and one is the cap.
 */
const noDeferrals = () => ({
  /* Over MAX_FILES_PER_SWEEP. The only cause the cap's sentence is true of. */
  capped: 0,
  /* Mid-write, or changed under the read. Silent on purpose: it resolves itself
     next sweep without the user doing anything, and a red banner for a file
     that is thirty minutes from arriving is noise. */
  busy: 0,
  /* The walk stopped at MAX_DIR_ENTRIES. Its own sentence, because "waiting"
     implies a queue that will drain and this one will not. */
  walkCapped: false,
  /* {name, why}. Named, with the errno in words: this is the one the user can
     actually fix, and "permission denied" is a chmod away from solved. */
  unreadable: [],
});

/**
 * An errno, in words a person can act on at seven in the morning.
 *
 * The fallback carries the system's own message, which contains the path — the
 * user's own path, already named elsewhere in these notes — and is sanitised
 * the same way a filename is, because this string lands in `runs.stats_json`,
 * in `GET /api/state` and in the Settings export.
 */
const ERRNO_TEXT = new Map([
  ['EACCES', 'permission denied'],
  ['EPERM', 'permission denied'],
  ['EIO', 'the disk returned an I/O error'],
  ['EBUSY', 'the file is in use'],
  ['ELOOP', 'it is a symlink now, and Zelos does not follow one'],
  ['EISDIR', 'it became a folder while Zelos was looking'],
  ['ENAMETOOLONG', 'the name is too long for this filesystem'],
  ['EMFILE', 'this process has no file descriptors left'],
  ['ENFILE', 'this machine has no file descriptors left'],
  ['ENOTDIR', 'part of the path stopped being a folder'],
  ['ESTALE', 'the network mount went stale'],
  ['ETIMEDOUT', 'the network mount timed out'],
]);

function readErrorText(err) {
  const code = err?.code;
  if (code && ERRNO_TEXT.has(code)) return ERRNO_TEXT.get(code);
  return collapse(err?.message || String(err)).replace(/[<>]/g, ' ').slice(0, 90) || 'the read failed';
}

/**
 * Walk the folder once and decide about every entry.
 *
 * -> {ready, refused, deferred, present, missing}
 *
 * Three verdicts, and the difference between the last two is the whole of how
 * this connector behaves over time:
 *
 *  - READY: read it now.
 *  - REFUSED: a decision that will not change on its own — too large, not a
 *    file, not the shape. Recorded in the cursor, so the user is told once per
 *    version of the file rather than every thirty minutes forever. A source
 *    that is red at every sweep for a file nobody will ever fix teaches people
 *    to ignore red, which costs more than the file did.
 *  - DEFERRED: still being written, over this sweep's cap, or a read error that
 *    may well be transient. NOT recorded, so the next sweep tries again.
 */
async function scan(dir, seen, startedMs, log) {
  const ready = [];
  const refused = [];
  const present = [];
  const deferred = noDeferrals();
  let entries = 0;

  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true, ready, refused, deferred, present };
    throw err;
  }

  for await (const dirent of handle) {
    /* THE WALK'S OWN CEILING, AND WHY IT IS NOT COUNTED. `deferred += 1` used
       to stand here, which reported the loss of everything past entry 5,000 as
       "1 more file" whatever the true number was — measured at 5,201 files:
       three sweeps, "1 more file is waiting", permanently red, and the .json
       that happened to sort past the cap never read and never mentioned.
       Counting what was skipped would mean walking the entries in order to
       count them, which is the cost this cap exists to refuse, so the sentence
       says what is true instead: the walk stopped, and there is more behind it. */
    if (entries >= MAX_DIR_ENTRIES) { deferred.walkCapped = true; break; }
    entries += 1;

    const name = dirent.name;
    // Dotfiles are not input. This is also what keeps macOS's .DS_Store, and
    // every editor's .swp, out of the board without naming any of them.
    if (name.startsWith('.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!EXTENSIONS.has(ext)) continue;

    /* A SYMLINK IS REFUSED OUTRIGHT, not resolved and range-checked.
       `readdir({withFileTypes: true})` reports link type from lstat, so this
       sees the link rather than its target. The attack it closes is small and
       total: a link named `notes.txt` pointing at ~/.ssh/id_rsa, or at
       ~/Library/Keychains, turns a folder the user thinks holds their own notes
       into a pump — and the contents do not merely land in SQLite, they land in
       the prompt that leaves the machine. A range check ("resolve it, require
       it to be under the watched folder") is defeated by a link to a directory
       that is itself a link, and by swapping the target between the check and
       the open. There is no legitimate reason to symlink INTO an inbox: copy
       the file, or point the source at the other folder. */
    if (dirent.isSymbolicLink()) {
      log?.debug?.(`ignoring symlink ${name}`);
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(path.join(dir, name));
    } catch (err) {
      // A name that vanished between the listing and the lstat is gone, not
      // broken — that is `mv` finishing, and there is nothing to tell anyone.
      if (err?.code !== 'ENOENT') deferred.unreadable.push({ name, why: readErrorText(err) });
      continue;
    }

    /* THE CURSOR IS CONSULTED HERE, ABOVE EVERY REFUSAL, AND THE ORDER IS THE
       WHOLE OF THE "TOLD ONCE" PROMISE. Both refusals below record their
       signature in `present`, which is what the next sweep's cursor is built
       from — but for the file's whole first life that record was written and
       never read, because the gate sat UNDER them. Measured over six
       consecutive sweeps of a folder holding one 1.2 MB log and one unpacked
       `export.json/`: sweep 1 reported them, and so did sweeps 2 through 6,
       word for word, every thirty minutes, for two files nobody was ever going
       to fix. The refusals decided later in `collect` (bad JSON, NUL bytes)
       were quiet after the first sweep the entire time, because they happen
       after this line. `signature` is computed once and reused by both
       branches, so this is a move rather than extra work. */
    const sig = signature(name, stat);
    if (seen.has(sig)) {
      present.push({ name, sig, mtimeMs: stat.mtimeMs });
      continue;
    }

    /* A DIRECTORY WHERE A FILE IS EXPECTED. `mydata.json/` is a real thing —
       an unpacked archive, a Finder bundle, an interrupted `cp -r`. It matches
       the extension filter, so unlike a plain subfolder it is something the
       user meant for us, and it is named rather than skipped in silence.
       Sockets and FIFOs land here too, which matters more than it reads: a
       read of a FIFO blocks until somebody writes, and a sweep that never
       returns is the one failure with no error message at all. */
    if (!stat.isFile()) {
      present.push({ name, sig, mtimeMs: stat.mtimeMs });
      refused.push({ name, why: stat.isDirectory() ? 'is a folder, not a file' : 'is not a regular file' });
      continue;
    }

    if (stat.size > MAX_FILE_BYTES) {
      present.push({ name, sig, mtimeMs: stat.mtimeMs });
      refused.push({
        name,
        why: `is ${stat.size.toLocaleString('en-US')} bytes and Zelos reads at most ${MAX_FILE_BYTES.toLocaleString('en-US')}`,
      });
      continue;
    }

    /* A FILE BEING WRITTEN WHILE WE READ IT — guard one of two.
       `curl … > inbox/x.json` and `python … > inbox/x.json` are the documented
       ways to use this connector and neither is atomic, so a scan that lands
       mid-write reads a truncated file. Truncated JSON is refused loudly, but
       truncated TEXT is worse: it ingests cleanly as a shorter note, and
       because identity is content-addressed the complete file arrives later as
       a SECOND row. A file whose mtime is later than the instant this scan
       began was still being written during the scan; it is left for the next
       one, which is thirty minutes away and long finished.
       Strictly later, not later-or-equal: mtime has millisecond resolution and
       a file written in the same millisecond the sweep started is complete.
       BOUNDED BY FUTURE_SKEW_MS, because "later than now" with no ceiling is
       not a deferral, it is a file that is never read: measured with an mtime
       30 days ahead, three consecutive sweeps returned zero rows and called it
       "waiting". Past the window the clock is wrong rather than the writer
       being busy — a NAS, a sync peer, an unpacked archive, `touch -t` — and
       the file is read. `readStable` still brackets the read with two stats, so
       a writer that really is busy is caught there instead. */
    if (stat.mtimeMs > startedMs) {
      const ahead = stat.mtimeMs - startedMs;
      if (ahead <= FUTURE_SKEW_MS) {
        log?.debug?.(`${name} changed after this sweep started; leaving it for the next one`);
        deferred.busy += 1;
        continue;
      }
      log?.debug?.(`${name} is stamped ${Math.round(ahead / 1000)}s in the future; reading it rather than waiting for this machine's clock`);
    }

    ready.push({ name, ext, sig, stat });
  }

  // Oldest first, name as the tie-break: an inbox is a queue, and a cap that
  // takes an arbitrary 200 of 500 would starve whichever files the filesystem
  // happens to list last.
  ready.sort((a, b) => (a.stat.mtimeMs - b.stat.mtimeMs) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (ready.length > MAX_FILES_PER_SWEEP) {
    deferred.capped += ready.length - MAX_FILES_PER_SWEEP;
    ready.length = MAX_FILES_PER_SWEEP;
  }

  return { missing: false, ready, refused, deferred, present };
}

/**
 * Open, stat, read, stat again.
 *
 * -> {bytes, stat} | {changed: true} | {gone: true}
 *
 * GUARD TWO for a file being written while we read it, and the one that catches
 * a writer which started before the scan did. The two stats bracket the read on
 * the SAME open handle, so nothing that has happened to the name in between can
 * disguise a change; a file that grew, shrank or was rewritten during the read
 * is left for the next sweep rather than ingested as whatever half of it we
 * happened to get. The listing's stat is compared too, which closes the window
 * between the walk and the open.
 *
 * `O_NOFOLLOW` is the TOCTOU half of the symlink refusal above: the walk saw a
 * regular file, and this makes sure the thing that is opened is still one, even
 * if the name became a link a millisecond later. It does not exist on Windows,
 * where `fs.constants.O_NOFOLLOW` is undefined and the `|| 0` leaves the flags
 * as plain O_RDONLY — there the dirent check is the whole guard, which is why
 * that one is not merely an optimisation.
 */
async function readStable(dir, entry, log) {
  let handle;
  try {
    handle = await fs.open(path.join(dir, entry.name), FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
  } catch (err) {
    if (err?.code === 'ENOENT') return { gone: true };
    throw err;
  }

  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) return { changed: true };
    if (before.size !== entry.stat.size || before.mtimeMs !== entry.stat.mtimeMs) return { changed: true };

    log?.debug?.(`reading ${entry.name} (${before.size} bytes)`);
    const bytes = await readCapped(handle, MAX_FILE_BYTES, before.size);

    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { changed: true };
    if (bytes.length !== after.size) return { changed: true };

    return { bytes, stat: after };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** `“a.json” is a folder, not a file; “b.txt” is 1,200,000 bytes, and 2 more` */
function nameList(entries, format) {
  const named = entries.slice(0, MAX_REPORTED).map(format);
  const rest = entries.length - named.length;
  return `${named.join('; ')}${rest > 0 ? `, and ${rest} more` : ''}`;
}

/** The refusals, as one sentence a person can act on. Said once per version. */
function refusalNote(folderName, refused) {
  const list = nameList(refused, (r) => `“${displayName(r.name)}” ${r.why}`);
  return `Zelos left ${refused.length} file${refused.length === 1 ? '' : 's'} in ${folderName} unread: `
    + `${list}. Nothing was moved or deleted — they are still there.`;
}

/**
 * The files that could not be read, as their own sentence.
 *
 * This one repeats while the condition does, and that is correct: a file the
 * user cannot read today is a file they can chmod, and the next sweep will try
 * it again. What it must never do is what it used to do — borrow the cap's
 * "will take it next time", which promised a queue that was never going to
 * drain, and name no file at all.
 */
function unreadableNote(folderName, unreadable) {
  const list = nameList(unreadable, (r) => `“${displayName(r.name)}” (${r.why})`);
  return `Zelos could not read ${unreadable.length} file${unreadable.length === 1 ? '' : 's'} in ${folderName}: `
    + `${list}. Nothing was moved or deleted, and Zelos will try again on the next sweep.`;
}

/**
 * Everything the user is told about one sweep, in one string or in none.
 *
 * Order is by what a person can do about it: refusals name files that need a
 * decision, unreadable files need a permission, the walk cap needs a smaller
 * folder, and the per-sweep cap needs nothing at all but explains a count.
 * `busy` says nothing (it fixes itself in thirty minutes) and neither does an
 * aborted sweep, which is handled before this is called.
 */
function sweepNote(folderName, refused, deferred) {
  const notes = [];
  if (refused.length) notes.push(refusalNote(folderName, refused));
  if (deferred.unreadable.length) notes.push(unreadableNote(folderName, deferred.unreadable));
  if (deferred.walkCapped) {
    notes.push(`${folderName} holds more than ${MAX_DIR_ENTRIES.toLocaleString('en-US')} entries, `
      + `so Zelos looked at the first ${MAX_DIR_ENTRIES.toLocaleString('en-US')} and stopped — anything past that `
      + 'is not being read at all. Point this source at a folder that holds only what it should read.');
  }
  if (deferred.capped > 0) {
    const n = deferred.capped;
    notes.push(`${n} more file${n === 1 ? '' : 's'} in ${folderName} ${n === 1 ? 'is' : 'are'} waiting — `
      + `Zelos reads ${MAX_FILES_PER_SWEEP} a sweep, and will take ${n === 1 ? 'it' : 'them'} next time.`);
  }
  return notes.length ? notes.join(' ') : null;
}

export default {
  type: 'folder',
  family: 'folder',
  label: 'Folder',
  option: 'A folder on this machine that scripts drop files into',
  configKey: 'sources',
  sink: 'messages',

  /* Not `{required: false}` — null. There is no password to be missing, so the
     host must never write "No password stored for …" about it and doctor must
     never offer a box to paste one into (ui/views/settings.js:296 is where that
     difference is visible, core/doctor.mjs:920 is the other place). The thing
     that authorises this read is the directory's own mode. */
  credential: null,

  /* Empty and it can never be otherwise: this file does not touch `ctx.http`.
     A `link` inside a dropped JSON document is stored as text and is never
     fetched — which is the same property the feed connector has, arrived at
     from the other direction. */
  origins: [],

  fields: [
    {
      name: 'path',
      type: 'path',
      label: 'Folder',
      default: '~/.zelos/inbox',
      /* NOT `required`. Blank means the default, and a required field that has
         a default is a form that lies: `zelos doctor` would fail a source whose
         empty box is exactly what the user meant (core/doctor.mjs:899 fails on
         a blank required field before any check runs). */
      hint: 'Zelos reads *.json and *.txt here, and never writes, moves or deletes anything. '
        + 'Have your script write to a temporary name and rename it into place — a rename is atomic, a redirect is not.',
    },
  ],

  /* Local disk: nothing to be gentle with, nothing to rate limit, no budget to
     spend. `maxRows` restates this file's own per-sweep cap rather than
     inventing a second one — one file is one row, so the host's truncation
     never fires and `MAX_FILES_PER_SWEEP` stays the single number. Both being
     zero also means `keepsState()` in core/sweep.mjs:369 is false, so this
     source writes no `kv` state row at all; the cursor is the only thing it
     remembers. */
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: MAX_FILES_PER_SWEEP },

  async collect(ctx) {
    const log = ctx?.log;
    const dir = resolveFolder(ctx?.source?.settings);
    const folderName = path.basename(dir) || dir;
    const startedMs = Date.now();

    const previous = Array.isArray(ctx?.cursor?.seen) ? ctx.cursor.seen.filter((s) => typeof s === 'string') : [];
    const seen = new Set(previous);

    let walked;
    try {
      walked = await scan(dir, seen, startedMs, log);
    } catch (err) {
      // ENOTDIR, EACCES, ELOOP: a real misconfiguration, and the sentence names
      // the path because "EACCES" on its own is not something a person can act
      // on at seven in the morning.
      throw new Error(`${dir} could not be read: ${err?.message || String(err)}`);
    }

    if (walked.missing) {
      /* A FOLDER THAT DOES NOT EXIST IS NOT AN ERROR — with one exception.
         On a fresh install nobody has run `mkdir` yet, and an error banner
         every thirty minutes for an empty inbox is the "red forty-seven times a
         day" failure core/sweep.mjs:379 argues against at length; `zelos doctor`
         says it plainly instead, with the command to fix it.
         But a folder that USED to be there and has gone is a different fact —
         a renamed directory, an unmounted volume, a sync client that removed
         it — and the cursor is the evidence. It is reported once, and cleared,
         so the next sweep is quiet again. */
      if (previous.length) {
        ctx.emit(`${ctx.label}: folder missing`, 0, 0);
        return {
          parts: [{
            label: '',
            rows: [],
            error: null,
            note: `${dir} is not there any more. Zelos was reading ${previous.length} file`
              + `${previous.length === 1 ? '' : 's'} from it. Nothing was deleted by Zelos — it only ever reads.`,
          }],
          cursor: null,
        };
      }
      /* NEVER SEEN, AND THE PARENT IS MISSING TOO. `~/Dowloads/zelos` is a
         typo; `/Volumes/archive/inbox` on an unplugged disk is a volume that is
         not there. Both used to report "nothing waiting" — green, silent,
         forever, while the script wrote into the folder next door. The parent
         is what tells them apart from the case above: `mkdir ~/.zelos/inbox` is
         one directory away from done and stays quiet, but a path whose PARENT
         does not exist was never a folder on this machine at all. (The review
         that found this proposed the opposite test — report when the parent
         exists — which would have painted every fresh install red for the
         default path and stayed silent for the typo it was about.) */
      const parent = path.dirname(dir);
      let parentThere = false;
      if (parent && parent !== dir) {
        parentThere = await fs.stat(parent).then((s) => s.isDirectory(), () => false);
      }
      if (!parentThere) {
        ctx.emit(`${ctx.label}: folder missing`, 0, 0);
        return {
          parts: [{
            label: '',
            rows: [],
            error: null,
            note: `${dir} does not exist, and neither does the folder it would sit in. `
              + 'Nothing is being read. Check the path in Settings → Sources — a mistyped folder and a '
              + 'volume that is not mounted both look like this.',
          }],
          cursor: null,
        };
      }

      ctx.emit(`${ctx.label}: nothing waiting`, 0, 0);
      return { parts: [{ label: '', rows: [], error: null, note: null }], cursor: null };
    }

    const rows = [];
    const refused = [...walked.refused];
    const deferred = walked.deferred;
    let aborted = false;

    for (const entry of walked.ready) {
      /* A CANCELLED SWEEP REPORTS NOTHING AND REMEMBERS NOTHING. It used to
         count the rest as deferred, which produced "5 more files are waiting —
         Zelos reads 200 a sweep" for a sweep that read zero files because the
         user pressed stop (measured with an already-aborted signal), and
         core/sweep.mjs stores that sentence in `runs.stats_json`. The cursor
         goes back as `undefined` below for the same reason: an aborted walk
         that saw nothing would otherwise hand back an empty `seen` and erase
         every digest this source has — latent today, since sweep.mjs returns
         before `writeCursor`, and live the moment cursors are written per
         source as they resolve. */
      if (ctx?.signal?.aborted) { aborted = true; break; }

      let read;
      try {
        read = await readStable(dir, entry, log);
      } catch (err) {
        // EACCES on one file must not lose the other 199. Deferred rather than
        // refused: a permission a user fixes with chmod changes neither mtime
        // nor size, so recording it in the cursor would mean never looking
        // again — but it is named in the report, which is the half that was
        // missing.
        log?.warn?.(`could not read ${entry.name}: ${err?.message || String(err)}`);
        deferred.unreadable.push({ name: entry.name, why: readErrorText(err) });
        continue;
      }
      if (read.gone) continue;
      if (read.changed) { deferred.busy += 1; continue; }

      const text = decodeText(read.bytes);
      /* A .txt that is really a binary. The extension is a claim, not a fact —
         a renamed .zip, a Word document, a UTF-16BE file. A NUL byte is the
         cheapest reliable evidence, and shipping one into SQLite and then into
         a model prompt is how a prompt gets several kilobytes of nothing. */
      if (text.includes('\u0000')) {
        walked.present.push({ name: entry.name, sig: entry.sig, mtimeMs: entry.stat.mtimeMs });
        refused.push({ name: entry.name, why: 'is not text (it contains NUL bytes)' });
        continue;
      }

      const built = rowFor({
        name: entry.name,
        ext: entry.ext,
        bytes: read.bytes,
        text,
        stat: read.stat,
        dir,
        folderName,
        nowMs: startedMs,
      });
      walked.present.push({ name: entry.name, sig: entry.sig, mtimeMs: entry.stat.mtimeMs });
      if (!built.ok) {
        refused.push({ name: entry.name, why: built.why });
        continue;
      }
      rows.push(built.row);
    }

    ctx.emit(`${ctx.label}: ${rows.length} file${rows.length === 1 ? '' : 's'}`, rows.length, rows.length);

    if (aborted) {
      // The rows already read are real and their ids are deterministic, so they
      // are worth handing back; the cursor is not, because this walk never
      // finished looking. `undefined` is how the host is told to keep what it
      // already had (core/sweep.mjs:788).
      return { parts: [{ label: '', rows, error: null, note: null }], cursor: undefined };
    }

    /* Rebuilt from what is on disk right now, newest first, capped. Newest
       first because the oldest files are the ones most likely already handled,
       so if the folder is larger than the cursor it is the long-settled files
       that get re-read. Read the header before changing the ordering: with a
       folder larger than MAX_REMEMBERED this end and the oldest-first read end
       disagree permanently, and reversing either one only moves which files
       churn — nothing inside a 4,096-character cursor makes it converge. */
    const kept = walked.present
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_REMEMBERED)
      .map((p) => p.sig);

    const parts = [{ label: '', rows, error: null, note: sweepNote(folderName, refused, deferred) }];
    return { parts, cursor: { v: 1, seen: kept } };
  },

  /**
   * What `zelos doctor` asks: is the folder there, can it be read, and how much
   * is waiting in it.
   *
   * `ctx` is unused and that is the point worth stating — nothing is contacted,
   * so there is no transport to honour and no `ctx.maxBytes` to respect
   * (doctor's is the 8 MB .ics ceiling, which is a different number about a
   * different thing). This is the only check in the registry that answers
   * entirely from the local filesystem.
   *
   * A missing folder is a `warn`, not a `fail`: `report.ok` is false only when
   * something failed, and "you have not created your inbox yet" is a fact about
   * a new install rather than a fault — the same reading core/doctor.mjs
   * already applies to mail nobody has connected. The action carries the exact
   * command, because the answer to "why will Zelos not make the folder for me"
   * is the first sentence of this file.
   */
  async check(source) {
    const dir = resolveFolder(source?.settings);
    const quoted = `"${dir}"`;

    let stat;
    try {
      stat = await fs.stat(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return {
          status: 'warn',
          detail: `${dir} does not exist yet, so nothing is waiting.`,
          action: `Create it — mkdir -p ${quoted} — then have anything you like write .json or .txt files into it. `
            + 'Zelos will not create it for you: it reads this folder and never writes to it.',
        };
      }
      return {
        status: 'fail',
        detail: `${dir}: ${err?.message || String(err)}`,
        action: 'Check the path in Settings → Sources. It must be a folder on this machine that your user can read.',
      };
    }

    if (!stat.isDirectory()) {
      return {
        status: 'fail',
        detail: `${dir} is not a folder.`,
        action: 'This source watches a folder, not a file. Point it at the directory the files are written into, '
          + 'and use “A calendar file on this machine” if what you meant was a single .ics.',
      };
    }

    let ready = 0;
    let large = 0;
    let ignored = 0;
    let entries = 0;
    let capped = false;
    try {
      const handle = await fs.opendir(dir);
      for await (const dirent of handle) {
        if (entries >= MAX_DIR_ENTRIES) { capped = true; break; }
        entries += 1;
        if (dirent.name.startsWith('.')) continue;
        if (dirent.isSymbolicLink()) { ignored += 1; continue; }
        if (!EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) { ignored += 1; continue; }

        /* THE SAME QUESTIONS THE SWEEP ASKS, ASKED THE SAME WAY. This counted
           `dirent.isFile()` and stopped there, and both halves of that were
           wrong. The dirent carries the readdir type, which is UV_DIRENT_UNKNOWN
           on an NFS or FUSE mount — every entry then answers false and doctor
           reports an empty folder that `collect` (which lstats) reads without
           trouble. And a file the sweep will always refuse was counted as
           readable: measured, doctor said "pass · 2 readable .json/.txt files"
           about a folder whose 1.2 MB `dump.txt` the board was complaining
           about by name. Two surfaces disagreeing about one folder is worse
           than either being wrong. */
        let st;
        try {
          st = await fs.lstat(path.join(dir, dirent.name));
        } catch {
          ignored += 1;
          continue;
        }
        if (!st.isFile()) { ignored += 1; continue; }
        if (st.size > MAX_FILE_BYTES) { large += 1; continue; }
        ready += 1;
      }
    } catch (err) {
      return {
        status: 'fail',
        detail: `${dir} cannot be listed: ${err?.message || String(err)}`,
        action: `The folder is there but your user cannot read it. chmod u+rx ${quoted} usually settles it.`,
      };
    }

    /* The count is of everything eligible, not of everything unread: `check`
       is handed the source, not the cursor, so it cannot know what has already
       been read — and inventing a second, disagreeing answer to that question
       would be worse than saying plainly what this number counts.
       An over-size file is named as its own number rather than raised to a
       `warn`: the sweep says which file it is, once, and a doctor that is
       permanently yellow about a log somebody parked in the folder is the same
       fatigue this file spends its cursor avoiding. */
    return {
      status: 'pass',
      detail: `${dir} · ${ready} readable .json/.txt file${ready === 1 ? '' : 's'}`
        + `${large ? ` · ${large} too large for Zelos to read` : ''}`
        + `${ignored ? ` · ${ignored} ignored` : ''}`
        + (capped
          ? ` · more than ${MAX_DIR_ENTRIES.toLocaleString('en-US')} entries, so only the first `
            + `${MAX_DIR_ENTRIES.toLocaleString('en-US')} were counted`
          : '')
        + ' · already-read files are skipped on the next sweep',
    };
  },
};
