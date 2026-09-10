/**
 * Text already synced to Messages on this Mac. No network, Contacts lookup,
 * attachment reads or source mutations. SQLite opens read-only and holds one
 * read transaction so message and participant joins share a coherent snapshot.
 * WAL readers can update SQLite's -shm read-coordination bytes; they never
 * change chat.db, its WAL, messages, delivery state or read receipts.
 *
 * Apple's schema is private and changes between releases. Require the core
 * tables, probe optional columns, and refuse unknown body encodings rather
 * than interpreting object archives or shelling out to an AppleScript helper.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const DAY_MS = 86_400_000;
const MAX_MESSAGES = 2000;
const MAX_CANDIDATES = 20_000;
const BODY_CHARS = 20_000;
const TOTAL_BODY_CHARS = 4_000_000;
const ATTRIBUTED_BYTES = 128_000;
const MAX_PARTICIPANTS = 100;
const PERMISSION_ACTION = 'In System Settings → Privacy & Security → Full Disk Access, enable Zelos, then quit and reopen Zelos. Only grant access to the installed Zelos app.';
const SYNC_ACTION = 'Open Messages on this Mac and sign in to the same Apple Account as your iPhone. Enable Messages in iCloud or Text Message Forwarding on your iPhone, then try again.';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const compact = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

class MessagesError extends Error {
  constructor(message, code, action) {
    super(message);
    this.code = code;
    this.action = action;
  }
}

function abort(signal) {
  if (signal?.aborted) throw new MessagesError('Reading iPhone texts was cancelled.', 'ABORT_ERR');
}

function numberSetting(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MessagesError(`${label} must be a whole number between ${min} and ${max}.`, 'IMESSAGE_SETTINGS', 'Check this source in Settings → Sources.');
  }
  return value;
}

export function resolveDatabasePath(settings = {}) {
  const value = typeof settings.databasePath === 'string' ? settings.databasePath.trim() : '';
  const file = value || '~/Library/Messages/chat.db';
  return file === '~' ? os.homedir() : path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
}

/** Modern rows use nanoseconds; older rows use seconds, both since 2001 UTC. */
export function messageDate(value) {
  try {
    const raw = BigInt(value);
    if (raw <= 0n) return null;
    const ms = raw >= 1_000_000_000_000n ? Number(raw / 1_000_000n) : Number(raw) * 1000;
    const date = new Date(APPLE_EPOCH_MS + ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch { return null; }
}

function cleanText(value) {
  // Object-replacement characters denote attachments/app payloads, not words.
  return String(value ?? '').replace(/[\uFFFC\uFFFD]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, BODY_CHARS);
}

/**
 * Strict plain NSString fallback for a streamtyped NSAttributedString.
 * Accept the explicit UTF-8 byte length and terminator, never scan printable
 * object metadata into prose. Unknown/binary-plist formats remain unread.
 * Format reference: imessage-exporter util/streamtyped.rs and Apple's legacy
 * typedstream NSString representation; this is not an object deserializer.
 */
export function attributedText(value) {
  if (!(value instanceof Uint8Array) || !value.length || value.length > ATTRIBUTED_BYTES) return null;
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < 16 || bytes[0] !== 4 || bytes[1] !== 11 || bytes.subarray(2, 13).toString('ascii') !== 'streamtyped') return null;
  const cls = bytes.indexOf(Buffer.from('NSString'));
  if (cls < 13 || cls > 512) return null;
  const marker = bytes.indexOf(Buffer.from([1, 43]), cls + 8);
  if (marker < 0 || marker > cls + 32) return null;
  let start = marker + 2;
  let length = bytes[start++];
  if (length === 0x81) {
    if (start + 2 > bytes.length) return null;
    length = bytes.readUInt16LE(start); start += 2;
  } else if (length === 0x82) {
    if (start + 4 > bytes.length) return null;
    length = bytes.readUInt32LE(start); start += 4;
  } else if (length >= 0x80 && length <= 0x91) return null;
  if (!length || length > ATTRIBUTED_BYTES || start + length + 2 > bytes.length) return null;
  if (bytes[start + length] !== 0x86 || bytes[start + length + 1] !== 0x84) return null;
  try { return cleanText(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length))); }
  catch { return null; }
}

function safeError(err) {
  if (err instanceof MessagesError) return err;
  if (err?.code === 'EACCES' || err?.code === 'EPERM') {
    return new MessagesError(`Zelos does not have permission to read Messages. ${PERMISSION_ACTION}`, 'IMESSAGE_PERMISSION', PERMISSION_ACTION);
  }
  if (err?.code === 'ENOENT') return new MessagesError(`No Messages database was found at the selected location. ${SYNC_ACTION}`, 'IMESSAGE_MISSING', SYNC_ACTION);
  if (err?.errcode === 5 || err?.errcode === 6 || /database is locked|database is busy/i.test(err?.message ?? '')) {
    return new MessagesError('Messages is busy updating its local database. Try again in a moment.', 'IMESSAGE_BUSY', 'Wait for Messages to finish syncing, then check this source again.');
  }
  return new MessagesError('The local Messages database could not be read safely. Check its location and Full Disk Access for Zelos, then reopen Zelos and try again.', 'IMESSAGE_DATABASE', PERMISSION_ACTION);
}

function columns(db, table, required) {
  const entry = db.prepare('SELECT type, sql FROM sqlite_schema WHERE name = ?').get(table);
  if (entry?.type !== 'table' || /^CREATE\s+VIRTUAL\s/i.test(entry.sql ?? '')) throw new MessagesError('This file does not have a supported Messages database layout.', 'IMESSAGE_SCHEMA', 'Choose the chat.db used by Messages on this Mac.');
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (required.some((name) => !names.has(name))) throw new MessagesError('This Messages database layout is not supported by this version of Zelos.', 'IMESSAGE_SCHEMA', 'Check for a Zelos update.');
  return names;
}

function openMessages(file) {
  // Refuse special files and symlink sidecars before SQLite opens anything.
  for (const suffix of ['', '-wal', '-shm']) {
    let stat;
    try { stat = fs.lstatSync(file + suffix); }
    catch (err) { if (suffix && err.code === 'ENOENT') continue; throw err; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MessagesError('The Messages database and its companion files must be regular files, not links or folders.', 'IMESSAGE_PATH', 'Choose the chat.db used by Messages on this Mac.');
  }
  // The filesystem error identifies TCC/permission refusals more accurately
  // than SQLite's generic CANTOPEN. Nothing is ever opened writable here.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  fs.closeSync(fd);
  const db = new DatabaseSync(file, { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN;');
    return db;
  } catch (err) { db.close(); throw err; }
}

function address(handle, name = '') {
  const value = compact(handle);
  // A phone number is a displayable handle, never an invented email address.
  return { name: compact(name) || value, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '' };
}

async function readMessages(ctx) {
  abort(ctx.signal);
  if (os.platform() !== 'darwin') throw new MessagesError('iPhone texts can only be read from Messages on a Mac.', 'IMESSAGE_PLATFORM', 'Set up this source in Zelos on the Mac where your iPhone texts appear in Messages.');
  const settings = ctx.source?.settings ?? {};
  const days = numberSetting(settings.lookbackDays, 14, 1, 365, 'Days to read');
  const max = numberSetting(settings.maxMessages, 400, 1, MAX_MESSAGES, 'Messages to read');
  const nowMs = ctx.now === undefined ? Date.now() : Date.parse(ctx.now);
  if (!Number.isFinite(nowMs)) throw new MessagesError('The current date for this import is invalid.', 'IMESSAGE_DATE');
  const sourceId = String(ctx.source?.id || ctx.accountId || 'imessage');
  let db;
  try {
    db = openMessages(resolveDatabasePath(settings));
    const message = columns(db, 'message', ['guid', 'date', 'is_from_me', 'handle_id']);
    if (!message.has('text') && !message.has('attributedBody')) throw new MessagesError('This Messages database has no supported text column.', 'IMESSAGE_SCHEMA', 'Check for a Zelos update.');
    columns(db, 'handle', ['id']);
    const chat = columns(db, 'chat', ['guid']);
    columns(db, 'chat_message_join', ['chat_id', 'message_id']);
    columns(db, 'chat_handle_join', ['chat_id', 'handle_id']);
    const optional = (name, fallback = 'NULL') => message.has(name) ? `m.${name}` : fallback;
    const filters = ['m.guid IS NOT NULL', "m.guid != ''", 'm.is_from_me IN (0, 1)'];
    for (const name of ['item_type', 'group_action_type', 'is_system_message', 'is_deleted', 'date_retracted']) {
      if (message.has(name)) filters.push(`COALESCE(m.${name}, 0) = 0`);
    }
    if (message.has('associated_message_type')) filters.push('COALESCE(m.associated_message_type, 0) IN (0, 2, 3)');
    if (message.has('service')) filters.push("(m.service IS NULL OR m.service IN ('iMessage', 'SMS', 'MMS', 'RCS'))");
    // Query only a date window and bounded candidate IDs, not the entire
    // history or its bodies. The two numeric ranges preserve date-index use
    // and support both legacy seconds and modern nanoseconds without casts.
    const startMs = nowMs - days * DAY_MS;
    const firstSecond = Math.ceil((startMs - APPLE_EPOCH_MS) / 1000);
    const lastSecond = Math.floor((nowMs - APPLE_EPOCH_MS) / 1000);
    const firstNano = BigInt(startMs - APPLE_EPOCH_MS) * 1_000_000n;
    const lastNano = BigInt(nowMs - APPLE_EPOCH_MS) * 1_000_000n;
    const candidates = db.prepare(`SELECT m.ROWID AS rowid, CAST(m.date AS TEXT) AS date FROM message m
      WHERE ${filters.join(' AND ')} AND ((m.date BETWEEN ? AND ?) OR (m.date BETWEEN ? AND ?))
      ORDER BY m.date DESC, m.ROWID DESC LIMIT ?`).all(firstSecond, lastSecond, firstNano, lastNano, MAX_CANDIDATES + 1);
    // Normalize the mixed-era ordering only after the bounded metadata read.
    candidates.sort((a, b) => (Date.parse(messageDate(b.date)) - Date.parse(messageDate(a.date))) || b.rowid - a.rowid);
    const details = db.prepare(`SELECT m.guid, m.is_from_me, ${optional('is_read')} AS is_read,
      ${message.has('text') ? `substr(m.text, 1, ${BODY_CHARS + 1})` : 'NULL'} AS text,
      ${message.has('attributedBody') ? `CASE WHEN length(m.attributedBody) <= ${ATTRIBUTED_BYTES} THEN m.attributedBody END` : 'NULL'} AS attributed,
      ${message.has('attributedBody') ? 'length(m.attributedBody)' : '0'} AS attributed_size,
      ${optional('destination_caller_id')} AS local_handle, ${optional('cache_has_attachments', '0')} AS attached,
      substr(h.id, 1, 300) AS sender FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.ROWID = ?`);
    const chats = db.prepare(`SELECT c.ROWID AS rowid, substr(c.guid, 1, 1000) AS guid,
      ${chat.has('display_name') ? 'substr(c.display_name, 1, 300)' : 'NULL'} AS name
      FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id WHERE j.message_id = ? ORDER BY c.ROWID LIMIT 2`);
    const handles = db.prepare(`SELECT DISTINCT substr(h.id, 1, 300) AS id FROM chat_handle_join j
      JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = ? ORDER BY h.id LIMIT ?`);
    const rows = [];
    const seen = new Set();
    let unsupported = 0;
    let bytesLimited = false;
    let rowsLimited = false;
    let participantsLimited = false;
    let totalChars = 0;
    let examined = 0;
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      if (examined++ % 32 === 0) { await yieldTurn(); abort(ctx.signal); }
      const iso = messageDate(candidate.date);
      if (!iso) continue;
      const row = details.get(candidate.rowid);
      if (!row || row.guid.length > 1000 || seen.has(row.guid)) continue;
      const plain = cleanText(row.text);
      const decoded = plain ? null : attributedText(row.attributed);
      const text = plain || decoded;
      if (!text) { if (row.attributed_size && decoded === null) unsupported += 1; continue; }
      if (rows.length >= max || totalChars + text.length > TOTAL_BODY_CHARS) {
        rowsLimited = rows.length >= max;
        bytesLimited = totalChars + text.length > TOTAL_BODY_CHARS;
        break;
      }
      // Removed/recoverable messages have no current chat join; do not import
      // them as a fresh obligation. A later deletion does not erase Zelos's
      // already-imported archive: this connector only returns source rows.
      const conversation = chats.get(candidate.rowid);
      if (!conversation?.guid) continue;
      const participants = handles.all(conversation.rowid, MAX_PARTICIPANTS + 1);
      if (participants.length > MAX_PARTICIPANTS) participantsLimited = true;
      const incoming = Number(row.is_from_me) === 0;
      const recipients = participants.slice(0, MAX_PARTICIPANTS).filter((p) => !incoming || p.id !== row.sender).map((p) => address(p.id));
      if (incoming && row.local_handle) recipients.unshift(address(row.local_handle, 'Me'));
      else if (incoming) recipients.unshift({ name: 'Me', email: '' });
      const flat = compact(text, 400);
      rows.push({
        messageId: `imessage:${row.guid}`,
        threadKey: `imessage:${hash(`${sourceId}\0${conversation.guid}`)}`,
        folder: `iPhone texts${conversation.name ? ` · ${compact(conversation.name, 120)}` : ''}`,
        direction: incoming ? 'in' : 'out',
        from: incoming ? address(row.sender, row.sender ? '' : 'Unknown sender') : address(row.local_handle, 'Me'),
        to: recipients, cc: [], subject: flat.slice(0, 120), date: iso,
        snippet: flat, text, hasAttachments: Boolean(row.attached),
        flags: Number(row.is_read) === 1 ? ['\\Seen'] : [],
      });
      seen.add(row.guid);
      totalChars += text.length;
    }
    abort(ctx.signal);
    const notes = [];
    if (rowsLimited || examined < candidates.length || candidates.length > MAX_CANDIDATES) notes.push(`Only the newest ${rows.length} readable messages in this window were imported; raise Messages to read or narrow Days to read in Settings → Sources.`);
    if (bytesLimited) notes.push('The text size limit was reached; some messages were deferred.');
    if (unsupported) notes.push(`${unsupported} message bodies used an unsupported or empty format and were skipped.`);
    if (participantsLimited) notes.push('A large group had more participants than this import can list.');
    return { rows, note: notes.length ? notes.join(' ').slice(0, 480) : null };
  } catch (err) { throw safeError(err); }
  finally { db?.close(); }
}

export default {
  type: 'imessage', family: 'imessage', label: 'iPhone texts',
  option: 'iPhone texts (Messages on this Mac)',
  configKey: 'sources', sink: 'messages', credential: null, origins: [],
  fields: [
    { name: 'databasePath', type: 'path', label: 'Messages database', default: '~/Library/Messages/chat.db',
      hint: 'Usually leave this unchanged. Zelos reads text already synced to Messages on this Mac. It never sends, marks read, or deletes messages.' },
    { name: 'lookbackDays', type: 'int', label: 'Days to read', default: 14, min: 1, max: 365 },
    { name: 'maxMessages', type: 'int', label: 'Messages to read', default: 400, min: 1, max: MAX_MESSAGES },
  ],
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: MAX_MESSAGES },
  async collect(ctx) {
    const result = await readMessages(ctx);
    ctx.emit?.(`${ctx.label || 'iPhone texts'}: ${result.rows.length} messages read`, result.rows.length, result.rows.length);
    return { parts: [{ label: '', rows: result.rows, error: null, note: result.note }], cursor: undefined };
  },
  async check(source, ctx = {}) {
    try {
      const result = await readMessages({ ...ctx, source: { ...source, settings: { ...source?.settings, maxMessages: 1 } } });
      return { status: 'pass', detail: result.rows.length ? 'Messages on this Mac can be read. No messages were changed.' : 'Messages on this Mac can be read; no supported text was found in the selected window.', action: result.rows.length ? undefined : SYNC_ACTION };
    } catch (err) {
      const safe = safeError(err);
      return { status: 'fail', detail: safe.message, action: safe.action };
    }
  },
};
