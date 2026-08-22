/**
 * test/connector-folder.test.mjs — the watched-folder source.
 *
 * This connector had no test at all until the audit of 2026-08-11, and the file
 * it guards names it twice in its own header as the thing that pins the cursor
 * arithmetic. Coverage of the module before this file existed, aggregated over
 * the whole suite under NODE_V8_COVERAGE: 0 of 16 functions executed. Every
 * defect below shipped through that hole.
 *
 * THERE IS NO TRANSPORT TO MOCK, WHICH MOVES WHERE THE RISK IS. Nothing here
 * dials anything — `origins: []` and `credential: null` are literal — so the
 * loopback server the other connector suites stand up has no analogue. What
 * takes its place is a real directory per case under a temp ZELOS_HOME, driven
 * with real permissions, real symlinks, real mtimes and real 1.2 MB files, and
 * a `ctx.http` that throws on any property access so "this file never touches
 * the transport" is enforced rather than asserted about a comment.
 *
 * The two properties worth stating up front, because they are the ones a
 * regression here would cost a user their own files over:
 *
 *  1. READ-ONLY. `nothing was moved, deleted or rewritten` below snapshots
 *     every name, every byte and every mtime in the folder around a sweep that
 *     reads, refuses and defers, and demands they are identical afterwards.
 *  2. A SYMLINK OUT OF THE FOLDER STAYS REFUSED. `passwd.txt -> /etc/passwd` is
 *     the pump this connector exists to not be, and the test reads the row text
 *     back looking for the target's bytes rather than trusting the count.
 *
 * FIXTURE MTIMES ARE ALWAYS SET EXPLICITLY. A file written and swept in the
 * same millisecond can carry a sub-millisecond mtime that is numerically ahead
 * of `Date.now()`, which the mid-write guard reads as "somebody is still
 * writing this" — a real flake on APFS, not a hypothetical.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Set before the modules that read it are evaluated, which is why the imports
   below are dynamic: core/config.mjs resolves (and creates) the Zelos home the
   first time `paths()` is called, and `resolveFolder` calls it. */
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-folder-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';

const folderModule = await import('../core/connectors/folder.mjs');
const folder = folderModule.default;
const {
  resolveFolder, readCapped,
  MAX_FILE_BYTES, MAX_FILES_PER_SWEEP, MAX_DIR_ENTRIES, MAX_REMEMBERED, BODY_CHARS,
} = folderModule;
const fsp = await import('node:fs/promises');
const { assertShape } = await import('../core/connectors/index.mjs');
const { paths } = await import('../core/config.mjs');
const {
  open, close, migrate, upsertMessages, listMessages, messagesInThread,
} = await import('../core/db.mjs');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let seq = 0;
const openDbs = [];

/** A fresh watched folder, and a fresh parent for it, per case. */
function freshDir(leaf = 'inbox') {
  const dir = path.join(HOME_ROOT, `case${seq++}`, leaf);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A minute in the past by default. See the header on why that is not a detail. */
function write(dir, name, body, mtimeMs = Date.now() - 60_000) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function freshDb() {
  const db = open(path.join(HOME_ROOT, `db${seq++}.db`));
  migrate(db);
  openDbs.push(db);
  return db;
}

/** Property access throws: this connector must never reach for the transport. */
const noHttp = new Proxy({}, {
  get(_t, prop) { throw new Error(`folder.collect touched ctx.http.${String(prop)}`); },
});

const emitted = [];

function ctxFor(dir, { cursor = null, signal = undefined, label = 'Inbox' } = {}) {
  return {
    source: { id: 'src-folder', settings: { path: dir } },
    label,
    secret: null,
    cursor,
    now: new Date(),
    emit: (message, done, total) => emitted.push({ message, done, total }),
    signal,
    log: null,
    http: noHttp,
  };
}

/** -> the single part every sweep returns, with the cursor alongside it. */
async function sweep(dir, opts = {}) {
  const result = await folder.collect(ctxFor(dir, opts));
  assert.equal(result.parts.length, 1, 'this connector returns exactly one part');
  return { ...result.parts[0], cursor: result.cursor };
}

/** Name -> {bytes, mtimeMs, mode}, for proving a sweep changed nothing. */
function snapshot(dir) {
  const out = new Map();
  for (const name of fs.readdirSync(dir).sort()) {
    const st = fs.lstatSync(path.join(dir, name));
    out.set(name, {
      kind: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file',
      mtimeMs: st.mtimeMs,
      bytes: st.isFile() ? fs.readFileSync(path.join(dir, name)).toString('base64') : null,
    });
  }
  return out;
}

test.after(() => {
  for (const db of openDbs) close(db);
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ================================================================== *
 * The manifest
 * ================================================================== */

test('the manifest is the shape the registry enforces, and claims nothing it does not do', () => {
  assertShape(folder);
  assert.equal(folder.credential, null, 'a path on the user own disk has no password to be missing');
  assert.deepEqual(folder.origins, [], 'nothing is contacted, so nothing may be');
  assert.equal(folder.sink, 'messages');
  assert.equal(folder.limits.maxRows, MAX_FILES_PER_SWEEP,
    'maxRows restates the per-sweep cap so the host truncation can never fire on top of it');
  assert.equal(folder.limits.minIntervalMs, 0);
  assert.equal(folder.limits.budget, null);
});

test('collect never touches ctx.http', async () => {
  const dir = freshDir();
  write(dir, 'note.txt', 'hello');
  write(dir, 'payload.json', JSON.stringify({ title: 'T', body: 'B', link: 'https://example.com/x' }));
  const part = await sweep(dir);
  assert.equal(part.rows.length, 2, 'the ctx.http proxy throws on any access; two rows means it was never read');
});

/* ================================================================== *
 * Reading, and reading exactly once
 * ================================================================== */

test('reads .json and .txt, ignores dotfiles, other extensions and subdirectories', async () => {
  const dir = freshDir();
  write(dir, 'a.txt', 'first');
  write(dir, 'b.json', JSON.stringify({ title: 'second' }));
  write(dir, '.hidden.txt', 'invisible');
  write(dir, 'photo.png', 'binary-ish');
  fs.mkdirSync(path.join(dir, 'archive'));
  write(path.join(dir, 'archive'), 'old.txt', 'not ours');

  const part = await sweep(dir);
  assert.deepEqual(part.rows.map((r) => r.subject).sort(), ['a', 'second']);
  assert.equal(part.note, null);
  assert.equal(part.error, null);
});

test('a second sweep carrying the cursor reads nothing and says nothing', async () => {
  const dir = freshDir();
  write(dir, 'a.txt', 'first');
  write(dir, 'b.txt', 'second');
  write(dir, 'c.json', JSON.stringify({ title: 'third' }));

  const first = await sweep(dir);
  assert.equal(first.rows.length, 3);
  assert.equal(first.cursor.seen.length, 3);

  const second = await sweep(dir, { cursor: first.cursor });
  assert.equal(second.rows.length, 0, 'the cursor is a work-saving device and it saved the work');
  assert.equal(second.note, null);
  assert.deepEqual(second.cursor.seen.sort(), first.cursor.seen.sort(), 'the cursor is rebuilt, not lost');
});

test('a file the user deletes drops out of the cursor on its own', async () => {
  const dir = freshDir();
  write(dir, 'a.txt', 'first');
  write(dir, 'b.txt', 'second');
  const first = await sweep(dir);
  fs.rmSync(path.join(dir, 'b.txt'));

  const second = await sweep(dir, { cursor: first.cursor });
  assert.equal(second.cursor.seen.length, 1);
});

/* ================================================================== *
 * Told once — the refusals, and the ordering that makes that true
 * ================================================================== */

test('a refusal decided during the walk is reported once, not on every sweep forever', async () => {
  const dir = freshDir();
  write(dir, 'ok.txt', 'a real note');
  fs.mkdirSync(path.join(dir, 'export.json'));
  write(dir, 'dump.txt', 'x'.repeat(MAX_FILE_BYTES + 1));

  const first = await sweep(dir);
  assert.equal(first.rows.length, 1);
  assert.match(first.note, /export\.json.+is a folder, not a file/);
  assert.match(first.note, /dump\.txt.+1,000,001 bytes/);
  assert.match(first.note, /Nothing was moved or deleted/);

  /* The whole finding: both of these are decided in the walk, and the walk used
     to decide them ABOVE the `seen` gate — so the digest went into the cursor
     and nothing ever read it back. Six consecutive sweeps, six identical red
     banners, for two files nobody was ever going to fix. */
  const second = await sweep(dir, { cursor: first.cursor });
  assert.equal(second.note, null, 'the cursor remembered the refusal, so the user is told once');
  assert.equal(second.rows.length, 0);

  const third = await sweep(dir, { cursor: second.cursor });
  assert.equal(third.note, null, 'and it stays quiet — the digests survive being rebuilt');
});

test('a refusal is re-reported when the file changes, because that is a new version', async () => {
  const dir = freshDir();
  write(dir, 'dump.txt', 'x'.repeat(MAX_FILE_BYTES + 1));
  const first = await sweep(dir);
  assert.match(first.note, /dump\.txt/);

  write(dir, 'dump.txt', 'x'.repeat(MAX_FILE_BYTES + 2), Date.now() - 30_000);
  const second = await sweep(dir, { cursor: first.cursor });
  assert.match(second.note, /1,000,002 bytes/, 'a different version of the file is a different fact');
});

test('refusals decided after the read — bad JSON, NUL bytes — are also said once', async () => {
  const dir = freshDir();
  write(dir, 'truncated.json', '{"title": "half a doc"');
  write(dir, 'list.json', '[1,2,3]');
  write(dir, 'empty.json', '{"other": "keys only"}');
  write(dir, 'binary.txt', Buffer.from([0x68, 0x69, 0x00, 0x21]));

  const first = await sweep(dir);
  assert.equal(first.rows.length, 0);
  assert.match(first.note, /truncated\.json.+is not valid JSON/);
  assert.match(first.note, /list\.json.+is a JSON array/);
  assert.match(first.note, /empty\.json.+neither a title nor a body/);
  assert.match(first.note, /binary\.txt.+NUL bytes/);

  const second = await sweep(dir, { cursor: first.cursor });
  assert.equal(second.note, null);
});

/* Windows refuses `< > : " | ? *` in a filename outright — `mkdir` fails with
   EINVAL before the connector is ever reached — so the name this test is about
   cannot exist there, and neither can the threat. Skipped rather than softened
   to a Windows-legal name, because a name without angle brackets would not be
   testing the thing: it is specifically `<` and `>` reaching a sentence that
   /api/state serves. The same reasoning as the POSIX-modes skips in
   test/doctor.test.mjs and the SIGINT skip in test/repo.test.mjs. */
test('a filename that is markup is sanitised before it enters a sentence', {
  skip: process.platform === 'win32'
    ? 'Windows forbids < and > in a filename, so this name — and this threat — cannot exist there'
    : false,
}, async () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '<img src=x onerror=alert(1)>.json'));
  const part = await sweep(dir);
  assert.doesNotMatch(part.note, /[<>]/, 'the two characters that can open a tag never reach /api/state');
  assert.match(part.note, /img src=x onerror=alert\(1\)/, 'and the user can still tell which file it is');
});

/* ================================================================== *
 * The clock — a future mtime is not a queue
 * ================================================================== */

test('a file stamped days ahead of this clock is read, not deferred forever', async () => {
  const dir = freshDir();
  write(dir, 'invoice.json', JSON.stringify({ title: 'Invoice 41', body: 'due friday' }),
    Date.now() + 30 * 24 * 60 * 60 * 1000);

  const part = await sweep(dir);
  assert.equal(part.rows.length, 1,
    'a NAS or sync peer with a fast clock used to mean this file was never read, on any sweep, ever');
  assert.equal(part.rows[0].subject, 'Invoice 41');
  assert.equal(part.note, null);
});

test('a future mtime cannot pin the row to the top of the board either', async () => {
  const dir = freshDir();
  const ahead = Date.now() + 30 * 24 * 60 * 60 * 1000;
  write(dir, 'invoice.json', JSON.stringify({ title: 'Invoice 41', body: 'due friday' }), ahead);

  const part = await sweep(dir);
  const at = Date.parse(part.rows[0].date);
  assert.ok(at <= Date.now() + 5 * 60_000, `sent_at ${part.rows[0].date} is bounded to about now, not to a month out`);
  assert.ok(at >= Date.now() - 5 * 60_000, 'and it is not thrown away either');
});

test('a file written seconds ago is still deferred as mid-write, and silently', async () => {
  const dir = freshDir();
  write(dir, 'growing.txt', 'half a line', Date.now() + 5_000);

  const part = await sweep(dir);
  assert.equal(part.rows.length, 0, 'inside the skew window a future mtime still means "a writer is busy"');
  assert.equal(part.note, null, 'and it resolves itself in thirty minutes, so nobody is told anything');
});

/* ================================================================== *
 * Deferrals — one sentence per cause, or none
 * ================================================================== */

test('the per-sweep cap keeps its sentence, and reports the real backlog alongside a refusal', async () => {
  const dir = freshDir();
  const base = Date.now() - 3_600_000;
  for (let i = 0; i < MAX_FILES_PER_SWEEP + 5; i += 1) {
    write(dir, `note-${String(i).padStart(4, '0')}.txt`, `note ${i}`, base + i);
  }
  write(dir, 'dump.txt', 'x'.repeat(MAX_FILE_BYTES + 1), base);

  const part = await sweep(dir);
  assert.equal(part.rows.length, MAX_FILES_PER_SWEEP);
  assert.match(part.note, /dump\.txt/, 'the refusal is named');
  assert.match(part.note, /5 more files in inbox are waiting/,
    'and the backlog is still reported — it used to be dropped entirely whenever anything was refused');
  assert.match(part.note, /Zelos reads 200 a sweep/);
});

test('a file that cannot be read is named with its reason, and never called "waiting"', async (t) => {
  /* `chmod 000` is how this test makes a file unreadable, and Windows has no
     POSIX modes: `fs.chmodSync` there sets only the read-only ATTRIBUTE, which
     does not stop a read at all, so the file is read normally and there is no
     EACCES to observe. The behaviour under test — that a refusal names the file
     and its reason instead of borrowing the queue's sentence — is real on
     Windows too, but it cannot be PROVOKED this way. Named rather than silently
     passing, which is the house rule for a platform gap (see the POSIX-mode
     skips in test/doctor.test.mjs). */
  if (process.platform === 'win32') {
    t.skip('Windows has no POSIX modes: chmod 000 leaves the file readable, so EACCES cannot be provoked');
    return;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: mode 000 is readable, so there is nothing to observe');
    return;
  }
  const dir = freshDir();
  write(dir, 'ok.txt', 'this one is fine');
  const locked = write(dir, 'locked.txt', 'you may not read this');
  fs.chmodSync(locked, 0o000);

  try {
    const part = await sweep(dir);
    assert.equal(part.rows.length, 1, 'EACCES on one file must not lose the other');
    assert.match(part.note, /locked\.txt/, 'the file is named — the old sentence never named it');
    assert.match(part.note, /permission denied/, 'and the errno is in words a person can act on');
    assert.doesNotMatch(part.note, /a sweep/, 'it is not waiting in a queue and must not claim to be');

    /* It repeats while the condition does, which is correct: this one IS
       fixable, and the next sweep does try again. */
    const second = await sweep(dir, { cursor: part.cursor });
    assert.match(second.note, /locked\.txt/);
    assert.equal(second.rows.length, 0);
  } finally {
    fs.chmodSync(locked, 0o600);
  }
});

test('a cancelled sweep reports nothing and hands back no cursor at all', async () => {
  const dir = freshDir();
  for (let i = 0; i < 5; i += 1) write(dir, `n${i}.txt`, `note ${i}`);

  const controller = new AbortController();
  controller.abort();
  const result = await folder.collect(ctxFor(dir, { signal: controller.signal }));
  const part = result.parts[0];

  assert.equal(part.note, null,
    'it used to say "5 more files are waiting — Zelos reads 200 a sweep" about a sweep that read nothing because the user pressed stop');
  assert.equal(result.cursor, undefined,
    'and it used to hand back {v:1, seen: []}, which would erase every digest the source has the moment cursors are written per source');
});

test('the walk cap gets its own sentence instead of borrowing the per-sweep one', async () => {
  const dir = freshDir();
  /* MAX_DIR_ENTRIES ineligible files plus one real note. Which side of the cap
     the note lands on is up to readdir order, and that is the point of the
     finding: it is arbitrary, stable, and silent. */
  for (let i = 0; i < MAX_DIR_ENTRIES + 10; i += 1) {
    fs.writeFileSync(path.join(dir, `pad-${String(i).padStart(5, '0')}.dat`), 'x');
  }
  write(dir, 'real.json', JSON.stringify({ title: 'the one that matters' }));

  const part = await sweep(dir);
  assert.match(part.note, /more than 5,000 entries/, 'the true cause is stated');
  assert.doesNotMatch(part.note, /will take (it|them) next time/,
    'it used to report the loss of everything past entry 5,000 as "1 more file is waiting"');
});

/* ================================================================== *
 * The row contract — core/db.mjs:380, against the real database
 * ================================================================== */

test('rows carry no uid, and upserting them twice inserts nothing the second time', async () => {
  const dir = freshDir();
  write(dir, 'a.txt', 'first');
  write(dir, 'b.json', JSON.stringify({ title: 'second', body: 'text' }));
  const part = await sweep(dir);

  for (const row of part.rows) {
    assert.equal('uid' in row, false,
      'uid: null coerces to 0 while an omitted uid stays null, and the two hash to different row ids');
  }

  const db = freshDb();
  const stamped = part.rows.map((r) => ({ ...r, sourceId: 'src-folder' }));
  const first = upsertMessages(db, stamped);
  const second = upsertMessages(db, stamped);
  assert.equal(first.inserted, 2);
  assert.equal(second.inserted, 0, 'a re-read of an unchanged file must not re-insert the row');
  assert.deepEqual(second.ids, first.ids);
});

test('successive versions of one file are one thread and two messages', async () => {
  const dir = freshDir();
  write(dir, 'status.txt', 'monday: green', Date.now() - 120_000);
  const first = await sweep(dir);

  write(dir, 'status.txt', 'tuesday: amber, with detail', Date.now() - 60_000);
  const second = await sweep(dir, { cursor: first.cursor });

  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 1);
  assert.notEqual(first.rows[0].messageId, second.rows[0].messageId,
    'the bytes changed, so the row id changes — a dismissed row is never resurrected');
  assert.equal(first.rows[0].threadKey, second.rows[0].threadKey,
    'but a script rewriting one file is one conversation, and threadKey used to be the content hash');

  const db = freshDb();
  upsertMessages(db, [...first.rows, ...second.rows].map((r) => ({ ...r, sourceId: 'src-folder' })));
  assert.equal(messagesInThread(db, first.rows[0].threadKey).length, 2,
    'threadIndex saw a folder of N notes as N unrelated threads');
});

test('two different files in one folder are two threads', async () => {
  const dir = freshDir();
  write(dir, 'backup.txt', 'ok');
  write(dir, 'sync.txt', 'ok');
  const part = await sweep(dir);
  const keys = new Set(part.rows.map((r) => r.threadKey));
  assert.equal(keys.size, 2, 'identical bytes under two names stay two notes, and now two conversations');
  assert.equal(new Set(part.rows.map((r) => r.messageId)).size, 2);
});

test('a stated date cannot buy the top of the board, and one format is stored', async () => {
  const dir = freshDir();
  /* Whole seconds, because utimes takes seconds as a float and a millisecond
     does not always survive the trip through the kernel: the stat came back
     one millisecond early on GitHub's runners, on three operating systems,
     against an expected value built from the number that went in. */
  const pushyMtime = Math.floor(Date.now() / 1000) * 1000 - 7_200_000;
  write(dir, 'pushy.json', JSON.stringify({
    title: 'PAY ME NOW', body: 'wire $40k', date: '9999-01-01T00:00:00Z',
  }), pushyMtime);
  /* An offset the writer states is kept as an instant, not as text: db.mjs
     orders `sent_at` as a string, and `+` sorts before `Z`. */
  const stamp = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;
  const shifted = new Date(stamp - 5 * 3_600_000).toISOString().slice(0, 19);
  write(dir, 'offset.json', JSON.stringify({
    title: 'meeting', body: 'notes', date: `${shifted}-05:00`,
  }), Date.now() - 60_000);

  const part = await sweep(dir);
  const byName = new Map(part.rows.map((r) => [r.subject, r]));

  assert.equal(byName.get('PAY ME NOW').date, new Date(pushyMtime).toISOString(),
    'the year 9999 measured as the top row of listMessages, above genuine mail, forever');
  assert.equal(byName.get('meeting').date, new Date(stamp).toISOString());
  for (const row of part.rows) {
    assert.match(row.date, /Z$/, 'every row from this source is stored in one format');
  }

  /* The measurement that made this a finding: `listMessages` orders by
     sent_at DESC, so the year 9999 sat above genuine mail on every read for
     the rest of the install. A real message from ten minutes ago stands in for
     that mail here. */
  const db = freshDb();
  upsertMessages(db, [
    ...part.rows.map((r) => ({ ...r, sourceId: 'src-folder' })),
    {
      sourceId: 'imap-1',
      messageId: 'real-mail-1',
      threadKey: 'real-mail-1',
      folder: 'INBOX',
      direction: 'in',
      from: { name: 'A Human', email: 'human@example.com' },
      subject: 'lunch?',
      date: new Date(Date.now() - 600_000).toISOString(),
      snippet: 'lunch?',
      text: 'lunch?',
    },
  ]);
  const stored = listMessages(db, { limit: 10 });
  assert.equal(stored[0].subject, 'lunch?', 'the board is not led by whoever writes the biggest year');
});

test('a backdated file keeps its stated date — clamping is a ceiling, not a rewrite', async () => {
  const dir = freshDir();
  write(dir, 'old.json', JSON.stringify({ title: 'last year', body: 'x', date: '2025-03-04T05:06:07Z' }));
  const part = await sweep(dir);
  assert.equal(part.rows[0].date, '2025-03-04T05:06:07.000Z');
});

test('the subject and the link live inside the caps this file states', async () => {
  const dir = freshDir();
  /* Under MAX_FILE_BYTES on purpose: a file the connector accepts, carrying
     fields it used to pass through whole. */
  write(dir, 'huge.json', JSON.stringify({
    title: 'A'.repeat(500_000),
    body: 'B'.repeat(50_000),
    link: `https://example.com/${'C'.repeat(100_000)}`,
  }));

  const part = await sweep(dir);
  assert.equal(part.rows.length, 1, 'the file is inside the size ceiling; only its fields are outsized');
  const row = part.rows[0];
  assert.ok(row.subject.length <= 300,
    `subject is ${row.subject.length} characters; it reached messages.subject, the FTS title and /api/state at 900,000`);
  assert.ok(row.text.length <= BODY_CHARS,
    `text is ${row.text.length} against a cap of ${BODY_CHARS}; the link used to be appended after the slice`);
  assert.ok(row.snippet.length <= 400);
});

test('a link short enough to be a link survives the body cap', async () => {
  const dir = freshDir();
  write(dir, 'linked.json', JSON.stringify({
    title: 'run 41', body: 'D'.repeat(BODY_CHARS), link: 'https://example.com/runs/41',
  }));
  const part = await sweep(dir);
  assert.ok(part.rows[0].text.endsWith('https://example.com/runs/41'),
    'the body yields to the link rather than the pair being sliced, which would drop it exactly when the body is full');
  assert.ok(part.rows[0].text.length <= BODY_CHARS);
});

test('a "from" that is not an address does not land in the email column', async () => {
  const dir = freshDir();
  write(dir, 'a.json', JSON.stringify({ title: 'x', body: 'y', from: 'nightly backup' }));
  write(dir, 'b.json', JSON.stringify({ title: 'x', body: 'y', from: 'Ada <ada@example.com>' }));
  const part = await sweep(dir);
  const from = part.rows.map((r) => r.from);
  assert.ok(from.some((f) => f.name === 'nightly backup' && f.email === ''));
  assert.ok(from.some((f) => f.name === 'Ada' && f.email === 'ada@example.com'));
  for (const row of part.rows) assert.equal(row.direction, 'in');
});

/* ================================================================== *
 * Read-only, and the symlink
 * ================================================================== */

test('nothing was moved, deleted or rewritten', async () => {
  const dir = freshDir();
  write(dir, 'ok.txt', 'a real note');
  write(dir, 'dump.txt', 'x'.repeat(MAX_FILE_BYTES + 1));
  write(dir, 'bad.json', '{"broken"');
  fs.mkdirSync(path.join(dir, 'export.json'));
  fs.symlinkSync(path.join(HOME_ROOT, 'nowhere.txt'), path.join(dir, 'link.txt'));

  const before = snapshot(dir);
  await sweep(dir);
  const after = snapshot(dir);

  assert.deepEqual([...after.keys()], [...before.keys()], 'every name is still there');
  assert.deepEqual([...after.entries()], [...before.entries()],
    'and every byte and every mtime — this product renders, a human clicks');
});

test('a symlink pointing out of the folder is refused and its target never reaches a row', async () => {
  const dir = freshDir();
  const secret = path.join(HOME_ROOT, `outside${seq}.txt`);
  fs.writeFileSync(secret, 'SUPER-SECRET-KEY-MATERIAL');
  fs.symlinkSync(secret, path.join(dir, 'passwd.txt'));
  fs.symlinkSync(secret, path.join(dir, 'notes.txt.link.json'));
  write(dir, 'real.txt', 'an honest note');

  const part = await sweep(dir);
  assert.equal(part.rows.length, 1);
  const blob = JSON.stringify(part);
  assert.doesNotMatch(blob, /SUPER-SECRET/, 'a link into an inbox is a pump, and there is no legitimate one');
  assert.ok(fs.lstatSync(path.join(dir, 'passwd.txt')).isSymbolicLink(), 'and the link is still on disk');
});

test('a symlink pointing INSIDE the folder is refused too', async () => {
  const dir = freshDir();
  write(dir, 'real.txt', 'an honest note');
  fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'alias.txt'));

  const part = await sweep(dir);
  assert.equal(part.rows.length, 1,
    'the refusal is total: resolving and range-checking is defeated by a link to a link, and by a swap after the check');
});

/* ================================================================== *
 * The cursor, and the ceiling in core/sweep.mjs
 * ================================================================== */

test('a full cursor fits under the ceiling core/sweep.mjs enforces', async () => {
  /* The number is read out of sweep.mjs as TEXT rather than imported, because
     the thing being guarded is that the two files cannot drift apart: sweep
     DROPS an over-size cursor with nothing but a log line, and this source
     would then re-read every file in the folder on every sweep forever with
     nothing on screen saying why. */
  const src = fs.readFileSync(path.join(ROOT, 'core', 'sweep.mjs'), 'utf8');
  const found = /CURSOR_MAX_CHARS\s*=\s*([\d_]+)/.exec(src);
  assert.ok(found, 'core/sweep.mjs no longer declares CURSOR_MAX_CHARS — this guard is blind, fix it');
  const ceiling = Number(found[1].replace(/_/g, ''));

  const dir = freshDir();
  const base = Date.now() - 3_600_000;
  for (let i = 0; i < MAX_REMEMBERED + 40; i += 1) {
    write(dir, `n-${String(i).padStart(4, '0')}.txt`, `note ${i}`, base + i);
  }

  let cursor = null;
  for (let i = 0; i < 3; i += 1) cursor = (await sweep(dir, { cursor })).cursor;

  assert.equal(cursor.seen.length, MAX_REMEMBERED, 'the cursor is full, which is the case worth measuring');
  const chars = JSON.stringify(cursor).length;
  assert.ok(chars <= ceiling,
    `a full cursor serialises to ${chars} characters against a ceiling of ${ceiling}. `
    + 'Lower MAX_REMEMBERED, shorten SIG_HEX, or take the field back out of the envelope.');
});

test('a folder inside the cursor ceiling settles: the third sweep reads nothing', async () => {
  const dir = freshDir();
  const base = Date.now() - 3_600_000;
  for (let i = 0; i < MAX_REMEMBERED - 20; i += 1) {
    write(dir, `n-${String(i).padStart(4, '0')}.txt`, `note ${i}`, base + i);
  }

  const first = await sweep(dir);
  const second = await sweep(dir, { cursor: first.cursor });
  const third = await sweep(dir, { cursor: second.cursor });

  assert.equal(first.rows.length, MAX_FILES_PER_SWEEP);
  assert.equal(second.rows.length, MAX_REMEMBERED - 20 - MAX_FILES_PER_SWEEP);
  assert.equal(third.rows.length, 0, 'a folder this size converges; one larger than the cursor never does');
  assert.equal(third.note, null);
});

test('every legacy or garbage cursor shape degrades to "no cursor" without crashing', async () => {
  const dir = freshDir();
  write(dir, 'a.txt', 'first');

  const shapes = [
    undefined, null, 'a string', 42, [],
    { v: 0, files: { 'a.txt': 1 } },
    { v: 1, seen: {} },
    { v: 1, seen: 'not-an-array' },
    { v: 1, seen: [null, 7, {}, 'deadbeef00'] },
  ];
  for (const cursor of shapes) {
    const part = await sweep(dir, { cursor });
    assert.equal(part.rows.length, 1, `cursor ${JSON.stringify(cursor)} should degrade to a re-read, not a crash`);
    assert.equal(part.error, null);
  }
});

/* ================================================================== *
 * A folder that is not there
 * ================================================================== */

test('a folder nobody has created yet is quiet, because that is a fresh install', async () => {
  const parent = path.join(HOME_ROOT, `case${seq++}`);
  fs.mkdirSync(parent, { recursive: true });
  const part = await sweep(path.join(parent, 'inbox'));
  assert.equal(part.rows.length, 0);
  assert.equal(part.note, null, 'a red banner every thirty minutes for an empty inbox teaches people to ignore red');
  assert.equal(part.error, null);
});

test('a path whose parent does not exist either is reported — that is a typo, not a fresh install', async () => {
  const dir = path.join(HOME_ROOT, `case${seq++}`, 'Dowloads', 'zelos');
  const part = await sweep(dir);
  assert.equal(part.rows.length, 0);
  assert.match(part.note, /does not exist/,
    'it used to be green and silent forever while the script wrote into the folder next door');
  assert.match(part.note, /Settings/);
});

test('a folder that has gone is reported once, with what was being read from it', async () => {
  const dir = freshDir();
  write(dir, 'a.txt', 'first');
  write(dir, 'b.txt', 'second');
  const first = await sweep(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const second = await sweep(dir, { cursor: first.cursor });
  assert.match(second.note, /is not there any more/);
  assert.match(second.note, /2 files/);
  assert.equal(second.cursor, null, 'and the cursor is cleared, so the next sweep is quiet again');
});

/* ================================================================== *
 * resolveFolder
 * ================================================================== */

test('a relative path resolves against the Zelos home, never the process cwd', () => {
  const resolved = resolveFolder({ path: 'inbox' });
  assert.equal(resolved, path.join(paths().home, 'inbox'),
    'launched from Finder, from a login item and from a terminal, cwd is three different folders');
  assert.ok(!resolved.startsWith(process.cwd()) || paths().home.startsWith(process.cwd()));
});

test('the tilde forms mean what the field hint says they mean', () => {
  assert.equal(resolveFolder({}), path.join(paths().home, 'inbox'), 'blank means the default');
  assert.equal(resolveFolder({ path: '  ' }), path.join(paths().home, 'inbox'));
  assert.equal(resolveFolder({ path: '~/.zelos/inbox' }), path.join(paths().home, 'inbox'),
    '~/.zelos is the Zelos home, so a pre-filled default and a blank field cannot name two folders');
  assert.equal(resolveFolder({ path: '~/.zelos' }), paths().home);
  assert.equal(resolveFolder({ path: '~' }), os.homedir());
  assert.equal(resolveFolder({ path: '~/Documents/drop' }), path.join(os.homedir(), 'Documents', 'drop'));
  const abs = path.join(HOME_ROOT, 'absolute');
  assert.equal(resolveFolder({ path: abs }), abs);
});

/* ================================================================== *
 * check() — doctor and the sweep must not disagree about one folder
 * ================================================================== */

test('check counts what the sweep will actually read, and names what it will refuse', async () => {
  const dir = freshDir();
  write(dir, 'ok.json', JSON.stringify({ title: 'fine' }));
  write(dir, 'dump.txt', 'x'.repeat(MAX_FILE_BYTES + 1));
  write(dir, 'photo.png', 'ignored');

  const report = await folder.check({ settings: { path: dir } });
  assert.equal(report.status, 'pass');
  assert.match(report.detail, /1 readable \.json\/\.txt file/,
    'it used to count 2, and say "pass" about the exact file the board was red over');
  assert.match(report.detail, /1 too large for Zelos to read/);

  const part = await sweep(dir);
  assert.equal(part.rows.length, 1, 'and the sweep agrees with it');
  assert.match(part.note, /dump\.txt/);
});

test('check warns about a folder that is not there, and fails on a path that is a file', async () => {
  const parent = path.join(HOME_ROOT, `case${seq++}`);
  fs.mkdirSync(parent, { recursive: true });

  const missing = await folder.check({ settings: { path: path.join(parent, 'inbox') } });
  assert.equal(missing.status, 'warn', 'not having run mkdir yet is a fact about a new install, not a fault');
  assert.match(missing.action, /mkdir -p/);

  const file = path.join(parent, 'a-file.txt');
  fs.writeFileSync(file, 'x');
  const notADir = await folder.check({ settings: { path: file } });
  assert.equal(notADir.status, 'fail');
});

/* ================================================================== *
 * Shells, encodings and the shapes a real drop folder holds
 * ================================================================== */

test('the two encodings a shell actually writes are decoded, not refused', async () => {
  const dir = freshDir();
  write(dir, 'powershell.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi there', 'utf16le')]));
  write(dir, 'notepad.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('plain', 'utf8')]));

  const part = await sweep(dir);
  const bySubject = new Map(part.rows.map((r) => [r.subject, r]));
  assert.equal(bySubject.get('powershell').text, 'hi there',
    'PowerShell 5 redirection is the single most likely first file a Windows user drops here');
  assert.equal(bySubject.get('notepad').text, 'plain', 'and a UTF-8 BOM is a quoting device, not the first character of the note');
});

test('the read buffer is sized to the file, and still detects one that grew', async () => {
  const dir = freshDir();
  const file = write(dir, 'tiny.txt', 'hi');

  let handle = await fsp.open(file, 'r');
  try {
    const bytes = await readCapped(handle, MAX_FILE_BYTES, 2);
    assert.equal(bytes.toString(), 'hi');
    /* `subarray` shares the allocation, so this reads the real one. It used to
       be `Buffer.alloc(cap + 1)` regardless of the file: 200 MB zero-filled
       across a sweep of 200 two-byte notes, on the hot path of a connector
       whose whole subject is small notes. */
    assert.equal(bytes.buffer.byteLength, 3,
      `${bytes.buffer.byteLength} bytes allocated to carry 2 — the ceiling is not the size of the file`);
  } finally {
    await handle.close();
  }

  /* The `+ 1` is the half that must survive: a file that grew between the stat
     and the read comes back longer than the stat said, and `readStable` rejects
     any read whose length is not the size it stat'ed. */
  fs.writeFileSync(file, 'hi there, this is longer now');
  handle = await fsp.open(file, 'r');
  try {
    const bytes = await readCapped(handle, MAX_FILE_BYTES, 2);
    assert.equal(bytes.length, 3, 'three bytes read for a two-byte stat is how growth is detected');
  } finally {
    await handle.close();
  }
});

test('a zero-byte file and a .txt with no name of its own still make sense', async () => {
  const dir = freshDir();
  write(dir, 'empty.txt', '');
  const part = await sweep(dir);
  assert.equal(part.rows.length, 1);
  assert.equal(part.rows[0].subject, 'empty', 'a .txt is a note whose title is what the human named it');
  assert.equal(part.rows[0].text, '');
});
