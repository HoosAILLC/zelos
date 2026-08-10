/**
 * core/sources/mime.mjs — the decoding half of the mail reader.
 *
 * Everything here takes bytes that a stranger chose and turns them into a
 * JavaScript string. So every function is written to be total: it returns
 * something usable for any input, and never throws on malformed data. A mail
 * client that crashes on one bad message is a mail client that shows you
 * nothing.
 *
 * Two conventions worth knowing before reading:
 *  - Anything that carries message *content* is a Buffer until the charset is
 *    known. Decoding early (to a JS string) is how mojibake gets baked in.
 *  - `parseHeaders` returns Map<string, string[]> — arrays, because a message
 *    legitimately has several `Received:` and can have several `References:`,
 *    and a Map can only hold one value per key. Callers that want the single
 *    value they expect take `[0]`.
 */

/* ------------------------------------------------------------------ *
 * Transfer encodings
 * ------------------------------------------------------------------ */

/**
 * Decode a content-transfer-encoding into raw bytes.
 * Unknown / 7bit / 8bit / binary pass through untouched.
 */
export function decodeTransfer(input, encoding) {
  const buf = toBuffer(input);
  const enc = String(encoding ?? '')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');

  if (enc === 'base64') {
    // Real messages contain line breaks, and broken ones contain stray
    // punctuation; Buffer's base64 decoder is lenient but not that lenient.
    const clean = buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(clean, 'base64');
  }
  if (enc === 'quoted-printable' || enc === 'quotedprintable' || enc === 'qp') {
    return decodeQuotedPrintable(buf);
  }
  return buf;
}

function decodeQuotedPrintable(buf) {
  // RFC 2045: whitespace before a line break is not significant and encoders
  // are required to strip it. Some don't, and leaving it turns "=20" hard-won
  // trailing spaces into noise, so strip raw trailing whitespace first — this
  // happens on the *encoded* text, so a real "=20" survives.
  const text = buf.toString('latin1').replace(/[ \t]+(?=\r?\n)/g, '');
  const out = Buffer.allocUnsafe(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '=') {
      out[n++] = text.charCodeAt(i) & 0xff;
      continue;
    }
    // Soft line break: "=" immediately before CRLF/LF means "no break here".
    if (text[i + 1] === '\r' && text[i + 2] === '\n') { i += 2; continue; }
    if (text[i + 1] === '\n') { i += 1; continue; }
    const hex = text.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out[n++] = parseInt(hex, 16); i += 2; continue; }
    if (i === text.length - 1) continue; // trailing "=" — a soft break that lost its newline
    out[n++] = 0x3d; // a lone "=" that isn't an escape: keep it
  }
  return out.subarray(0, n);
}

/* ------------------------------------------------------------------ *
 * Charsets
 * ------------------------------------------------------------------ */

/**
 * Labels TextDecoder does not know, mapped to the closest one it does.
 * Anything not listed is handed to TextDecoder as-is first — it understands
 * the whole WHATWG label set, which covers every charset that matters.
 */
const CHARSET_ALIASES = new Map([
  ['', 'utf-8'],
  ['unknown', 'utf-8'],
  ['unknown-8bit', 'utf-8'],
  ['x-unknown', 'utf-8'],
  ['default', 'utf-8'],
  ['none', 'utf-8'],
  ['utf8', 'utf-8'],
  ['utf-7', 'utf-8'],          // no decoder exists; lossy is better than throwing
  ['latin1', 'iso-8859-1'],
  ['latin-1', 'iso-8859-1'],
  ['iso8859-1', 'iso-8859-1'],
  ['iso-8859-8-i', 'iso-8859-8'],
  ['ks_c_5601-1987', 'euc-kr'],
  ['ks_c_5601-1989', 'euc-kr'],
  ['cp949', 'euc-kr'],
  ['cp1252', 'windows-1252'],
  ['x-gbk', 'gbk'],
  ['iso-2022-jp-2', 'iso-2022-jp'],
]);

/** Bytes -> string. Unknown charsets fall back to lossy utf-8 rather than failing. */
/**
 * windows-1252, decoded here rather than by the runtime.
 *
 * It is the single most common non-UTF-8 charset in real mail, and whether
 * Node decodes it correctly turns out to depend on which Node you have: v22.16,
 * v22.19 and v24.0.0 all hand back the raw bytes for the 0x80–0x9F range, so a
 * curly quote arrives as U+0093 instead of U+201C and the subject line reads as
 * mojibake; v22.23 and v26 get it right. That is not a difference anyone
 * downloading this should have to know about, and the table is sixteen lines.
 *
 * Only 0x80–0x9F needs saying: below it cp1252 is ASCII, above it Latin-1,
 * and both of those map to the same code point as the byte itself. The five
 * holes are the positions cp1252 leaves undefined, which become U+FFFD.
 */
const CP1252_HIGH = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

function decodeCp1252(buf) {
  let out = '';
  for (const byte of buf) {
    out += byte >= 0x80 && byte <= 0x9f
      ? String.fromCharCode(CP1252_HIGH[byte - 0x80])
      : String.fromCharCode(byte);
  }
  return out;
}

export function decodeCharset(input, charset) {
  const buf = toBuffer(input);
  const raw = String(charset ?? '')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/\*.*$/, ''); // RFC 2231 language suffix: "utf-8*en"
  const label = CHARSET_ALIASES.get(raw) ?? (raw || 'utf-8');
  if (label === 'windows-1252') return decodeCp1252(buf);
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    // Non-fatal decoders never throw, so this only fires on an unknown label.
    return new TextDecoder('utf-8').decode(buf);
  }
}

/* ------------------------------------------------------------------ *
 * RFC 2047 encoded words
 * ------------------------------------------------------------------ */

const ENCODED_WORD = /=\?([^?\s]{1,100})\?([BbQq])\?([^?]*)\?=/g;

/**
 * "=?UTF-8?B?4oCcaGkm?= =?UTF-8?B?Iw==?=" -> "“hi&#"
 *
 * Two rules that a naive per-word decoder gets wrong, and that real subjects
 * hit constantly:
 *  - whitespace *between* two encoded words is not part of the text; it exists
 *    only because a header line had to fold. It is dropped.
 *  - a multi-byte character may be split across two adjacent words, so the
 *    decoded *bytes* of a same-charset run are concatenated before the charset
 *    decoder ever sees them.
 */
export function decodeWords(input) {
  if (input == null) return '';
  const str = String(input);
  if (!str.includes('=?')) return str;

  let out = '';
  let cursor = 0;
  let run = null; // { charset, chunks: Buffer[] } — an unbroken run of same-charset words

  const flush = () => {
    if (!run) return;
    out += decodeCharset(Buffer.concat(run.chunks), run.charset);
    run = null;
  };

  ENCODED_WORD.lastIndex = 0;
  let m;
  while ((m = ENCODED_WORD.exec(str)) !== null) {
    const gap = str.slice(cursor, m.index);
    const charset = m[1].split('*')[0];
    const encoding = m[2].toUpperCase();
    const payload = m[3];

    let bytes;
    if (encoding === 'B') {
      bytes = decodeTransfer(Buffer.from(payload, 'latin1'), 'base64');
    } else {
      // In Q encoding "_" always means a space, whatever the charset.
      bytes = decodeTransfer(Buffer.from(payload.replace(/_/g, ' '), 'latin1'), 'quoted-printable');
    }

    const adjacent = run !== null && /^[ \t\r\n]*$/.test(gap);
    if (adjacent) {
      if (run.charset.toLowerCase() === charset.toLowerCase()) {
        run.chunks.push(bytes);
      } else {
        flush();
        run = { charset, chunks: [bytes] };
      }
    } else {
      flush();
      out += gap;
      run = { charset, chunks: [bytes] };
    }
    cursor = m.index + m[0].length;
  }

  flush();
  out += str.slice(cursor);
  return out;
}

/* ------------------------------------------------------------------ *
 * Headers
 * ------------------------------------------------------------------ */

/**
 * Header block -> Map(lowercased name -> [raw unfolded values]).
 *
 * Values are returned *raw* (still RFC 2047 encoded); run them through
 * `decodeWords` at the point of use, because address headers must be split on
 * commas before their display names are decoded.
 */
export function parseHeaders(input) {
  const text = decodeHeaderBytes(toBuffer(input));
  const map = new Map();
  let name = null;
  let value = '';

  const commit = () => {
    if (name === null) return;
    const key = name.toLowerCase();
    const trimmed = value.trim();
    const existing = map.get(key);
    if (existing) existing.push(trimmed);
    else map.set(key, [trimmed]);
    name = null;
    value = '';
  };

  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === '') break; // blank line ends the header block
    if (/^[ \t]/.test(line)) {
      // Unfolding removes the line break and keeps the leading whitespace.
      if (name !== null) value += line;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue; // not a header line; ignore rather than guess
    commit();
    name = line.slice(0, idx).trim();
    value = line.slice(idx + 1);
  }
  commit();
  return map;
}

/**
 * Headers are supposed to be ASCII with RFC 2047 for anything else, but raw
 * 8-bit headers are common. Try UTF-8 strictly; if the bytes aren't valid
 * UTF-8 they are almost always Latin-1, and guessing that beats a field full
 * of replacement characters.
 */
function decodeHeaderBytes(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

/** "A <a@x>, \"Doe, J\" <j@y>, Team: c@z;" -> [{name, email}] */
export function parseAddressList(input) {
  const str = String(input ?? '');
  if (!str.trim()) return [];
  const out = [];
  for (const chunk of splitAddresses(str)) {
    const parsed = parseOneAddress(chunk);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Split on commas that are actually separators — not the ones inside a quoted
 * display name ("Doe, John"), a comment, or an angle-addr. Group syntax
 * ("Team: a@x, b@y;") contributes its members and drops its label.
 */
function splitAddresses(str) {
  const out = [];
  let cur = '';
  let inQuote = false;
  let commentDepth = 0;
  let angleDepth = 0;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inQuote) {
      cur += c;
      if (c === '\\' && i + 1 < str.length) { cur += str[++i]; continue; }
      if (c === '"') inQuote = false;
      continue;
    }
    if (commentDepth > 0) {
      if (c === '\\' && i + 1 < str.length) { cur += c + str[++i]; continue; }
      if (c === '(') commentDepth++;
      else if (c === ')') commentDepth--;
      cur += c;
      continue;
    }
    if (c === '"') { inQuote = true; cur += c; continue; }
    if (c === '(') { commentDepth = 1; cur += c; continue; }
    if (c === '<') { angleDepth++; cur += c; continue; }
    if (c === '>') { if (angleDepth > 0) angleDepth--; cur += c; continue; }
    if (angleDepth === 0 && c === ':') { cur = ''; continue; } // group label
    if (angleDepth === 0 && (c === ',' || c === ';')) {
      if (cur.trim()) out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseOneAddress(chunk) {
  let display = '';
  let angleBuf = '';
  let comments = '';
  let inQuote = false;
  let commentDepth = 0;
  let angleDepth = 0;
  let sawAngle = false;

  const put = (s) => {
    if (angleDepth > 0) angleBuf += s;
    else display += s;
  };

  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (inQuote) {
      if (c === '\\' && i + 1 < chunk.length) { put(chunk[++i]); continue; }
      if (c === '"') { inQuote = false; continue; }
      put(c);
      continue;
    }
    if (commentDepth > 0) {
      if (c === '\\' && i + 1 < chunk.length) { comments += chunk[++i]; continue; }
      if (c === '(') { commentDepth++; comments += c; continue; }
      if (c === ')') { commentDepth--; comments += commentDepth === 0 ? ' ' : c; continue; }
      comments += c;
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === '(') { commentDepth = 1; continue; }
    if (c === '<') { if (angleDepth === 0) { sawAngle = true; angleBuf = ''; } angleDepth++; continue; }
    if (c === '>') { if (angleDepth > 0) angleDepth--; continue; }
    put(c);
  }

  let email = '';
  let name = '';
  if (sawAngle) {
    email = cleanEmail(angleBuf);
    name = display;
  } else {
    const tokens = display.trim().split(/\s+/).filter(Boolean);
    const withAt = tokens.filter((t) => t.includes('@'));
    email = cleanEmail(withAt.length ? withAt[withAt.length - 1] : '');
    if (withAt.length && tokens.length > 1) {
      name = tokens.filter((t) => !t.includes('@')).join(' ');
    }
  }

  name = decodeWords(name).replace(/\s+/g, ' ').trim();
  if (!name) name = decodeWords(comments).replace(/\s+/g, ' ').trim();
  if (!email) return null;
  if (name.toLowerCase() === email) name = '';
  return { name, email };
}

/**
 * Addresses are lowercased. The domain is case-insensitive by definition and
 * no real mail system treats the local part as case-sensitive; matching a
 * person across messages matters more here than byte fidelity.
 */
function cleanEmail(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^<|>$/g, '').trim();
  s = s.replace(/^mailto:/i, '');
  // Obsolete source route: <@relay1,@relay2:real@host>
  if (s.startsWith('@') && s.includes(':')) s = s.slice(s.lastIndexOf(':') + 1);
  s = s.replace(/\s+/g, '');
  if (!/^[^\s@<>,;:"]+@[^\s@<>,;:"]+$/.test(s)) return '';
  return s.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * HTML -> text
 * ------------------------------------------------------------------ */

const BLOCK_TAG =
  /<\/?(?:p|div|br|tr|li|ul|ol|h[1-6]|table|thead|tbody|tfoot|blockquote|section|article|header|footer|hr|pre|address|form|figure|figcaption|dl|dt|dd|nav|main|aside|center)\b[^>]*>/gi;

const NAMED_ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  dagger: '†', permil: '‰', prime: '′',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  ne: '≠', le: '≤', ge: '≥',
  frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ',
  ensp: ' ', emsp: ' ', thinsp: ' ',
  shy: '', zwnj: '', zwj: '', lrm: '', rlm: '',
}));

/** Best-effort plain text from an HTML part. Never returns markup. */
export function htmlToText(input) {
  let s = String(input ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|head|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, ' '); // unterminated: drop the rest
  s = s.replace(/<\/(?:td|th)\s*>/gi, ' ');
  s = s.replace(BLOCK_TAG, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u200b\u2007\u202f]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeEntities(s) {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match; // lone surrogate
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const exact = NAMED_ENTITIES.get(body);
    if (exact !== undefined) return exact;
    const lower = NAMED_ENTITIES.get(body.toLowerCase());
    return lower === undefined ? match : lower;
  });
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Named zones still seen in the wild. Offsets in minutes. */
const NAMED_ZONES = new Map(Object.entries({
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -300, edt: -240, cst: -360, cdt: -300,
  mst: -420, mdt: -360, pst: -480, pdt: -420,
  cet: 60, cest: 120, bst: 60,
}));

const RFC5322_DATE =
  /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s+([+-]\d{4}|[+-]\d{2}:\d{2}|[A-Za-z]{1,5}))?/;

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * RFC 5322 (and IMAP INTERNALDATE) -> "2026-08-08T09:15:00-04:00".
 *
 * The stated offset is preserved verbatim: the point of the string is that a
 * reader downstream can pull wall-clock digits off it without a timezone
 * database. Converting to UTC here would destroy exactly that.
 */
export function parseDate(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const iso = ISO_DATE.exec(raw);
  if (iso) {
    return assemble(
      Number(iso[1]), Number(iso[2]), Number(iso[3]),
      Number(iso[4]), Number(iso[5]), Number(iso[6] ?? 0),
      offsetFromToken(iso[7] ?? 'Z') ?? '+00:00',
    );
  }

  // Comments ("(EST)", "(no timezone info)") are noise, but occasionally the
  // only place the zone is stated, so keep them aside rather than discard.
  const comments = [];
  const stripped = raw
    .replace(/\(([^()]*)\)/g, (m, inner) => { comments.push(inner.trim()); return ' '; })
    .replace(/\s+/g, ' ')
    .trim();

  const m = RFC5322_DATE.exec(stripped);
  if (!m) return null;

  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;

  const day = Number(m[1]);
  let year = Number(m[3]);
  if (m[3].length <= 2) year += year < 50 ? 2000 : 1900;

  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 60) return null;

  let offset = offsetFromToken(m[7]);
  if (offset === null) {
    for (const c of comments) {
      offset = offsetFromToken(c);
      if (offset !== null) break;
    }
  }
  return assemble(year, month, day, hour, minute, second === 60 ? 59 : second, offset ?? '+00:00');
}

function assemble(year, month, day, hour, minute, second, offset) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject dates that do not exist (31 Feb and friends).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:${p(second)}${offset}`;
}

function offsetFromToken(token) {
  if (!token) return null;
  const t = String(token).trim();
  const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(t);
  if (numeric) {
    const hh = Number(numeric[2]);
    const mm = Number(numeric[3]);
    if (hh > 23 || mm > 59) return null;
    // "-0000" means "UTC, local zone unknown" — it is not a negative offset.
    if (hh === 0 && mm === 0) return '+00:00';
    return `${numeric[1]}${numeric[2]}:${numeric[3]}`;
  }
  const minutes = NAMED_ZONES.get(t.toLowerCase());
  if (minutes === undefined) return null;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Threading
 * ------------------------------------------------------------------ */

const SUBJECT_PREFIX = /^\s*(?:re|fw|fwd|aw|antw|sv|vs|res|rif|encaminhado)\s*(?:\[\d+\])?\s*:\s*/i;

/**
 * A stable key for the conversation a message belongs to.
 *
 * The root of the References chain is the identity of the thread — every reply
 * carries it, so replies and the original land on the same key. Falling back to
 * a normalised subject catches mailers that drop References, at the cost of
 * merging two unrelated messages that happen to share a subject; that is the
 * right trade for a board that groups by conversation.
 */
export function threadKeyFor({ messageId, inReplyTo, references, subject } = {}) {
  const refs = normalizeIdList(references);
  if (refs.length) return refs[0];

  const parent = normalizeIdList(inReplyTo);
  if (parent.length) return parent[0];

  const self = normalizeIdList(messageId);
  if (self.length) return self[0];

  const normalized = normalizeSubject(subject);
  return normalized ? `subject:${normalized}` : null;
}

function normalizeIdList(value) {
  if (value == null) return [];
  const parts = Array.isArray(value) ? value : String(value).match(/<[^<>]*>|\S+/g) || [];
  const out = [];
  for (const part of parts) {
    const id = String(part).trim().replace(/^</, '').replace(/>$/, '').trim().toLowerCase();
    if (id) out.push(id);
  }
  return out;
}

function normalizeSubject(subject) {
  let s = decodeWords(String(subject ?? ''));
  let previous;
  do {
    previous = s;
    s = s.replace(SUBJECT_PREFIX, '');
  } while (s !== previous);
  return s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(String(input ?? ''), 'utf8');
}
