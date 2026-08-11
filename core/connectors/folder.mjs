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
 * file and nothing else: 240 of them serialise to ~3,140 characters, measured,
 * with room left for the envelope. `test/connector-folder.test.mjs` reads the
 * 4,096 out of core/sweep.mjs as text and asserts a full cursor fits under it,
 * so the two cannot drift apart.
 *
 * A high-water mtime would have been smaller still, and was rejected: `cp -p`,
 * rsync, Syncthing and iCloud all preserve mtimes, so a file restored into the
 * folder with last month's timestamp would land below the mark and never be read
 * — a silent miss, which is the one failure mode this design refuses. The digest
 * set fails the other way instead: a folder holding more than 240 files forgets
 * the oldest, re-reads them next sweep, and upserts the rows it already had.
 *
 * The list is rebuilt from the directory each sweep rather than appended to, so
 * a file the user deletes drops out of the cursor on its own.
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
const MAX_FILE_BYTES = 1_000_000;

/** How many files one sweep will ingest. The rest wait for the next one. */
const MAX_FILES_PER_SWEEP = 200;

/**
 * How far into a directory listing this will walk at all.
 *
 * `opendir` is iterated rather than `readdir`-ed for exactly this: readdir
 * materialises every entry before returning one, so a folder somebody pointed
 * at their Downloads directory costs the array before any cap can apply.
 */
const MAX_DIR_ENTRIES = 5_000;

/** How many file digests the cursor carries. See the header for the arithmetic. */
const MAX_REMEMBERED = 240;

/** How many refused files are named in one report before it becomes a count. */
const MAX_REPORTED = 5;

/** Matches core/connectors/rss.mjs: the same board renders both. */
const SNIPPET_CHARS = 400;
const BODY_CHARS = 20_000;

/** 40 bits. A collision means one file is never read; at 240 entries that is ~1e-6. */
const SIG_HEX = 10;

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
 */
export function resolveFolder(settings) {
  const raw = String(settings?.path ?? '').trim();
  if (!raw) return path.join(paths().home, 'inbox');
  if (raw === '~') return os.homedir();

  const tilde = /^~[\\/](.*)$/s.exec(raw);
  if (!tilde) return path.resolve(raw);

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
 */
async function readCapped(handle, cap) {
  const buf = Buffer.alloc(cap + 1);
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
    title: collapse(str(doc.title)),
    body: str(doc.body),
    from: str(doc.from),
    date: str(doc.date),
    link: collapse(str(doc.link)),
  };
  if (!fields.title && !fields.body.trim()) {
    return { ok: false, why: 'is JSON with neither a title nor a body' };
  }
  if (!fields.title) fields.title = stem;
  return { ok: true, fields };
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
 */
function rowFor({ name, ext, bytes, text, stat, folderName }) {
  const parsed = fieldsFrom(name, ext, text);
  if (!parsed.ok) return parsed;

  const { title, body, from, date, link } = parsed.fields;
  const digest = crypto.createHash('sha256').update(name).update('\u0000').update(bytes).digest('hex');
  const messageId = `folder:sha256:${digest.slice(0, 32)}`;
  const trimmed = body.slice(0, BODY_CHARS);

  return {
    ok: true,
    row: {
      messageId,
      threadKey: messageId,
      folder: folderName,
      direction: 'in',
      from: addressOf(from, folderName),
      to: [],
      cc: [],
      subject: title || '(untitled)',
      /* The file's mtime is the honest fallback for "when did this happen":
         for anything a script wrote, the moment it wrote it IS the event. An
         unparseable `date` falls back to it rather than to null, because a row
         with no date sorts nowhere in particular on a board ordered by time. */
      date: parseDate(date) || new Date(stat.mtimeMs).toISOString(),
      snippet: collapse(trimmed).slice(0, SNIPPET_CHARS),
      text: link ? `${trimmed}\n\n${link}`.trim() : trimmed,
      hasAttachments: false,
      flags: [],
    },
  };
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
  let deferred = 0;
  let entries = 0;

  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true, ready, refused, deferred, present };
    throw err;
  }

  for await (const dirent of handle) {
    if (entries >= MAX_DIR_ENTRIES) { deferred += 1; break; }
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
    } catch {
      deferred += 1;
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
      present.push({ name, sig: signature(name, stat), mtimeMs: stat.mtimeMs });
      refused.push({ name, why: stat.isDirectory() ? 'is a folder, not a file' : 'is not a regular file' });
      continue;
    }

    if (stat.size > MAX_FILE_BYTES) {
      present.push({ name, sig: signature(name, stat), mtimeMs: stat.mtimeMs });
      refused.push({
        name,
        why: `is ${stat.size.toLocaleString('en-US')} bytes and Zelos reads at most ${MAX_FILE_BYTES.toLocaleString('en-US')}`,
      });
      continue;
    }

    const sig = signature(name, stat);
    if (seen.has(sig)) {
      present.push({ name, sig, mtimeMs: stat.mtimeMs });
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
       a file written in the same millisecond the sweep started is complete. */
    if (stat.mtimeMs > startedMs) {
      log?.debug?.(`${name} changed after this sweep started; leaving it for the next one`);
      deferred += 1;
      continue;
    }

    ready.push({ name, ext, sig, stat });
  }

  // Oldest first, name as the tie-break: an inbox is a queue, and a cap that
  // takes an arbitrary 200 of 500 would starve whichever files the filesystem
  // happens to list last.
  ready.sort((a, b) => (a.stat.mtimeMs - b.stat.mtimeMs) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (ready.length > MAX_FILES_PER_SWEEP) {
    deferred += ready.length - MAX_FILES_PER_SWEEP;
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
    const bytes = await readCapped(handle, MAX_FILE_BYTES);

    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { changed: true };
    if (bytes.length !== after.size) return { changed: true };

    return { bytes, stat: after };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The refusals, as one sentence a person can act on. */
function refusalNote(folderName, refused) {
  const named = refused.slice(0, MAX_REPORTED).map((r) => `“${displayName(r.name)}” ${r.why}`);
  const rest = refused.length - named.length;
  const tail = rest > 0 ? `, and ${rest} more` : '';
  return `Zelos left ${refused.length} file${refused.length === 1 ? '' : 's'} in ${folderName} unread: `
    + `${named.join('; ')}${tail}. Nothing was moved or deleted — they are still there.`;
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
      ctx.emit(`${ctx.label}: nothing waiting`, 0, 0);
      return { parts: [{ label: '', rows: [], error: null, note: null }], cursor: null };
    }

    const rows = [];
    const refused = [...walked.refused];
    let deferred = walked.deferred;

    for (const entry of walked.ready) {
      if (ctx?.signal?.aborted) { deferred += 1; continue; }

      let read;
      try {
        read = await readStable(dir, entry, log);
      } catch (err) {
        // EACCES on one file must not lose the other 199. Deferred rather than
        // refused: a permission a user fixes with chmod changes neither mtime
        // nor size, so recording it would mean never looking again.
        log?.warn?.(`could not read ${entry.name}: ${err?.message || String(err)}`);
        deferred += 1;
        continue;
      }
      if (read.gone) continue;
      if (read.changed) { deferred += 1; continue; }

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
        folderName,
      });
      walked.present.push({ name: entry.name, sig: entry.sig, mtimeMs: entry.stat.mtimeMs });
      if (!built.ok) {
        refused.push({ name: entry.name, why: built.why });
        continue;
      }
      rows.push(built.row);
    }

    /* Rebuilt from what is on disk right now, newest first, capped. Newest
       first because the oldest files are the ones most likely already handled,
       so if the folder is larger than the cursor it is the long-settled files
       that get re-read — steady work rather than a set that thrashes between
       two halves of the folder every sweep. */
    const kept = walked.present
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_REMEMBERED)
      .map((p) => p.sig);

    const parts = [];
    if (refused.length) parts.push({ label: '', rows, error: null, note: refusalNote(folderName, refused) });
    else if (deferred > 0) {
      parts.push({
        label: '',
        rows,
        error: null,
        note: `${deferred} more file${deferred === 1 ? '' : 's'} in ${folderName} ${deferred === 1 ? 'is' : 'are'} `
          + `waiting — Zelos reads ${MAX_FILES_PER_SWEEP} a sweep, and will take ${deferred === 1 ? 'it' : 'them'} next time.`,
      });
    } else parts.push({ label: '', rows, error: null, note: null });

    ctx.emit(`${ctx.label}: ${rows.length} file${rows.length === 1 ? '' : 's'}`, rows.length, rows.length);
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
    let ignored = 0;
    let entries = 0;
    try {
      const handle = await fs.opendir(dir);
      for await (const dirent of handle) {
        if (entries >= MAX_DIR_ENTRIES) break;
        entries += 1;
        if (dirent.name.startsWith('.')) continue;
        if (dirent.isSymbolicLink()) { ignored += 1; continue; }
        if (!EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) { ignored += 1; continue; }
        if (!dirent.isFile()) { ignored += 1; continue; }
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
       would be worse than saying plainly what this number counts. */
    return {
      status: 'pass',
      detail: `${dir} · ${ready} readable .json/.txt file${ready === 1 ? '' : 's'}`
        + `${ignored ? ` · ${ignored} ignored` : ''}`
        + ' · already-read files are skipped on the next sweep',
    };
  },
};
