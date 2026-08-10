/**
 * core/sources/imap.mjs — IMAP4rev1, from the socket up.
 *
 * The whole reason this file exists instead of an npm install: Zelos claims
 * that nothing about your mail leaves your machine, and that claim is only
 * worth something if every byte of the mail path is auditable in this repo.
 *
 * Three decisions carry the correctness of the module:
 *
 *  1. The wire is parsed as BYTES with an explicit literal-length state, never
 *     by splitting on CRLF. `{123}\r\n` means "the next 123 bytes are opaque",
 *     and those bytes routinely contain CRLF, ")" and quotes. A line splitter
 *     appears to work until someone sends you a subject with a paren in it.
 *  2. Reads never mutate the mailbox. `EXAMINE` instead of `SELECT`, and
 *     `BODY.PEEK[...]` instead of `BODY[...]` — a `BODY[` fetch sets \Seen, and
 *     silently marking somebody's mail as read is not a bug you get to ship.
 *     `fetch()` refuses to send one.
 *  3. UIDs only. Sequence numbers are renumbered by any expunge, including one
 *     that happens between two of our own commands.
 */

import net from 'node:net';
import tls from 'node:tls';

import { imapDate, instant } from '../time.mjs';
import { log as defaultLog } from '../log.mjs';
import {
  decodeCharset,
  decodeTransfer,
  decodeWords,
  htmlToText,
  parseAddressList,
  parseDate,
  parseHeaders,
  threadKeyFor,
} from './mime.mjs';

const CRLF = '\r\n';
const CRLF_BYTES = Buffer.from(CRLF, 'latin1');

/** Some servers choke on very large UID sets; 100 is universally safe. */
const UID_CHUNK = 100;

/** The cheap first pass: everything needed to decide, nothing that costs a body. */
const HEADER_FIELDS = 'FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID';

/** Guard rails against a hostile or broken server exhausting memory. */
const MAX_LITERAL_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;

const SPECIAL_USE_FLAGS = new Set(['\\sent', '\\drafts', '\\trash', '\\junk', '\\archive', '\\all', '\\flagged', '\\important']);

/* ================================================================== *
 * 1. Byte-stream assembly
 * ================================================================== */

/**
 * Turns a TCP byte stream into complete IMAP responses.
 *
 * A response is emitted as `{ text, literals }` where `text` is the whole
 * response decoded as latin1 — one byte per character, so offsets are exact and
 * reversible — and `literals` marks the character ranges that came from a
 * literal. The tokenizer uses those ranges to jump over literal payloads
 * wholesale, which is what makes CRLF and ")" inside a literal harmless.
 */
class ResponseAssembler {
  #buf = Buffer.alloc(0);
  #segments = [];
  #literals = [];
  #length = 0;
  #pendingLiteral = 0;
  #scan = 0;

  /** @returns {{text:string, literals:{start:number,end:number}[]}[]} */
  push(chunk) {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out = [];

    for (;;) {
      if (this.#pendingLiteral > 0) {
        if (this.#buf.length < this.#pendingLiteral) break;
        const payload = this.#buf.subarray(0, this.#pendingLiteral);
        this.#literals.push({ start: this.#length, end: this.#length + payload.length });
        this.#segments.push(payload.toString('latin1'));
        this.#length += payload.length;
        this.#buf = this.#buf.subarray(this.#pendingLiteral);
        this.#pendingLiteral = 0;
        this.#scan = 0;
        continue;
      }

      const idx = this.#buf.indexOf(CRLF_BYTES, this.#scan);
      if (idx < 0) {
        // Resume the search at the last byte: a CR may be the tail of this
        // chunk with its LF arriving in the next one.
        this.#scan = Math.max(0, this.#buf.length - 1);
        break;
      }

      const line = this.#buf.subarray(0, idx).toString('latin1');
      const marker = /\{(\d+)\+?\}$/.exec(line);
      if (marker) {
        const size = Number(marker[1]);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LITERAL_BYTES) {
          throw new Error(`server announced an implausible literal of ${marker[1]} bytes`);
        }
        // Drop the "{n}" marker and its CRLF: the literal's bytes then sit
        // exactly where the value belongs, so the tokenizer needs no special case.
        const head = line.slice(0, marker.index);
        this.#segments.push(head);
        this.#length += head.length;
        if (size === 0) {
          // "{0}" is a real value — the empty string — not a formality. The
          // payload branch above never runs for it (there are no bytes to
          // wait for), so the empty range is recorded here; dropping it
          // instead would delete a value from a FETCH response and shift
          // every item after it onto the wrong key.
          this.#literals.push({ start: this.#length, end: this.#length });
        } else {
          this.#pendingLiteral = size;
        }
        this.#buf = this.#buf.subarray(idx + 2);
        this.#scan = 0;
        continue;
      }

      this.#segments.push(line);
      this.#length += line.length;
      out.push({ text: this.#segments.join(''), literals: this.#literals });
      this.#segments = [];
      this.#literals = [];
      this.#length = 0;
      this.#buf = this.#buf.subarray(idx + 2);
      this.#scan = 0;
    }

    if (this.#length + this.#buf.length > MAX_RESPONSE_BYTES) {
      throw new Error('server response exceeded the maximum size Zelos will buffer');
    }
    return out;
  }
}

/* ================================================================== *
 * 2. Tokenizer
 * ================================================================== */

/**
 * Parse one assembled response into IMAP values.
 * Value shapes: {type:'atom',value:string} | {type:'string',value:Buffer}
 *             | {type:'list',value:Value[]} | {type:'nil',value:null}
 */
function parseResponse({ text, literals }) {
  const literalAt = new Map();
  for (const range of literals) literalAt.set(range.start, range);

  const end = text.length;
  let pos = 0;

  const atLiteral = () => literalAt.has(pos);

  function skipSpace() {
    // A literal's payload may start with a space, so never skip into one.
    while (pos < end && !atLiteral() && text[pos] === ' ') pos++;
  }

  function skipBracket(from) {
    let p = from + 1;
    let depth = 1;
    while (p < end && depth > 0) {
      const c = text[p];
      if (c === '"') {
        p++;
        while (p < end && text[p] !== '"') {
          if (text[p] === '\\') p++;
          p++;
        }
        p++;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') depth--;
      p++;
    }
    return p;
  }

  function readQuoted() {
    pos++; // opening quote
    let out = '';
    while (pos < end) {
      const c = text[pos];
      if (c === '\\' && pos + 1 < end) { out += text[pos + 1]; pos += 2; continue; }
      if (c === '"') { pos++; break; }
      out += c;
      pos++;
    }
    return { type: 'string', value: Buffer.from(out, 'latin1') };
  }

  function readAtom() {
    const start = pos;
    while (pos < end) {
      if (atLiteral()) break;
      const c = text[pos];
      if (c === ' ' || c === ')' || c === '(') break;
      // "BODY[HEADER.FIELDS (FROM TO)]<0>" is one atom: the section spec holds
      // spaces and parens, so consume the bracketed part whole.
      if (c === '[') { pos = skipBracket(pos); continue; }
      pos++;
    }
    const raw = text.slice(start, pos);
    if (raw.toUpperCase() === 'NIL') return { type: 'nil', value: null };
    return { type: 'atom', value: raw };
  }

  function readValue() {
    skipSpace();
    if (pos >= end) return null;
    const range = literalAt.get(pos);
    if (range) {
      // Consumed ranges are forgotten so a zero-length literal — whose end is
      // its start, leaving `pos` where it stood — reads as one empty value
      // instead of an endless stream of them.
      literalAt.delete(range.start);
      const buf = Buffer.from(text.slice(range.start, range.end), 'latin1');
      pos = range.end;
      return { type: 'string', value: buf };
    }
    const c = text[pos];
    if (c === '(') {
      pos++;
      const items = [];
      for (;;) {
        skipSpace();
        if (pos >= end) break;
        if (!atLiteral() && text[pos] === ')') { pos++; break; }
        const value = readValue();
        if (value === null) break;
        items.push(value);
      }
      return { type: 'list', value: items };
    }
    if (c === '"') return readQuoted();
    if (c === ')') return null;
    return readAtom();
  }

  const values = [];
  for (;;) {
    skipSpace();
    if (pos >= end) break;
    const before = pos;
    const value = readValue();
    if (value === null) {
      pos = Math.max(pos + 1, before + 1); // never stall on stray punctuation
      continue;
    }
    values.push(value);
  }
  return values;
}

/** Protocol-level text of a value (mailbox names, dates, numbers). */
function tokenText(value) {
  if (!value) return null;
  if (value.type === 'atom') return value.value;
  if (value.type === 'string') return value.value.toString('latin1');
  return null;
}

function tokenBytes(value) {
  if (!value) return Buffer.alloc(0);
  if (value.type === 'string') return value.value;
  if (value.type === 'atom') return Buffer.from(value.value, 'latin1');
  return Buffer.alloc(0);
}

function listItems(value) {
  return value && value.type === 'list' ? value.value : [];
}

/* ================================================================== *
 * 3. Mailbox names (modified UTF-7, RFC 3501 §5.1.3)
 * ================================================================== */

function decodeModifiedUTF7(name) {
  return String(name).replace(/&([^-]*)-/g, (match, encoded) => {
    if (encoded === '') return '&';
    try {
      const buf = Buffer.from(encoded.replace(/,/g, '/'), 'base64');
      let out = '';
      for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
      return out || match;
    } catch {
      return match;
    }
  });
}

function encodeModifiedUTF7(name) {
  const s = String(name);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x26) { out += '&-'; i++; continue; }
    if (code >= 0x20 && code <= 0x7e) { out += s[i]; i++; continue; }
    const units = [];
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c >= 0x20 && c <= 0x7e) break;
      units.push(c);
      i++;
    }
    const buf = Buffer.alloc(units.length * 2);
    units.forEach((u, k) => buf.writeUInt16BE(u, k * 2));
    out += `&${buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  }
  return out;
}

/* ================================================================== *
 * 4. BODYSTRUCTURE
 * ================================================================== */

/**
 * Flatten a BODYSTRUCTURE into addressable parts.
 *
 * Part numbering follows RFC 3501 §6.4.5: children of a multipart are 1, 2, …
 * prefixed by their parent's number, and the body of a message/rfc822 part is
 * numbered inside that part. A non-multipart message's body is part "1".
 */
function structureParts(node) {
  const out = [];
  walkStructure(node, '', false, out);
  return out;
}

function walkStructure(node, prefix, insideMessage, out) {
  if (!node || node.type !== 'list' || node.value.length === 0) return;
  const items = node.value;

  if (items[0] && items[0].type === 'list') {
    let index = 0;
    for (const child of items) {
      if (child.type !== 'list') break; // the multipart subtype follows the children
      index++;
      walkStructure(child, prefix ? `${prefix}.${index}` : String(index), false, out);
    }
    return;
  }

  const type = (tokenText(items[0]) || '').toLowerCase();
  const subtype = (tokenText(items[1]) || '').toLowerCase();
  const params = paramMap(items[2]);
  const encoding = (tokenText(items[5]) || '7bit').toLowerCase();
  const size = Number(tokenText(items[6])) || 0;
  const part = insideMessage ? `${prefix}.1` : prefix || '1';

  // Field layout differs by type: text parts carry a line count before the
  // extension fields, message/rfc822 carries an envelope plus a nested body.
  const isMessage = type === 'message' && subtype === 'rfc822';
  const dispositionIndex = type === 'text' ? 9 : isMessage ? 11 : 8;
  const disposition = dispositionFrom(items[dispositionIndex]);

  out.push({
    part,
    type,
    subtype,
    charset: params.get('charset') || null,
    encoding,
    size,
    disposition: disposition.kind,
    filename: disposition.filename || params.get('name') || null,
  });

  if (isMessage) walkStructure(items[8], part, true, out);
}

function paramMap(node) {
  const map = new Map();
  const items = listItems(node);
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = (tokenText(items[i]) || '').toLowerCase();
    const value = tokenText(items[i + 1]);
    if (key && value !== null) map.set(key, value);
  }
  return map;
}

function dispositionFrom(node) {
  const items = listItems(node);
  if (!items.length) return { kind: null, filename: null };
  const kind = (tokenText(items[0]) || '').toLowerCase() || null;
  const params = paramMap(items[1]);
  return { kind, filename: params.get('filename') || params.get('name') || null };
}

/** The part a human would read: plain text if there is any, otherwise HTML. */
function chooseTextPart(parts) {
  const inline = parts.filter((p) => p.disposition !== 'attachment');
  const pick = (list, subtype) => list.find((p) => p.type === 'text' && p.subtype === subtype);
  return (
    pick(inline, 'plain') ||
    pick(inline, 'html') ||
    pick(parts, 'plain') ||
    pick(parts, 'html') ||
    null
  );
}

function hasAttachmentParts(parts) {
  return parts.some((p) => p.disposition === 'attachment' || Boolean(p.filename) || p.type === 'application');
}

/* ================================================================== *
 * 5. The client
 * ================================================================== */

/**
 * Loopback, in every spelling a person or a provider actually writes.
 *
 * This matters because loopback is the one address where a cleartext IMAP
 * session is defensible: Proton Bridge and the other local proxies that
 * decrypt on your behalf listen on 127.0.0.1 with no TLS on purpose, and that
 * traffic never leaves the machine. `guessImapHost` returns exactly that for a
 * proton.me address. Any other host is a network, and a network has people on
 * it.
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  const v4 = mapped ? mapped[1] : h;
  if (!/^127(?:\.\d{1,3}){3}$/.test(v4)) return false;
  return v4.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * Whether an account must prove the connection is encrypted before it hands
 * over a password, when the config has not said either way. On by default
 * everywhere except loopback — see `isLoopbackHost`.
 */
export function tlsRequiredByDefault(host) {
  return !isLoopbackHost(host);
}

export class ImapClient {
  #socket = null;
  #assembler = new ResponseAssembler();
  #queue = [];
  #current = null;
  #tagSeq = 0;
  #caps = null;
  #greeting = null;
  #authenticated = false;
  #dead = false;
  #loggedOut = false;
  #byeText = null;
  #onSocketData = null;
  #onSocketError = null;
  #onSocketClose = null;

  /**
   * `requireTls` is the answer to a silent failure mode. With `secure: false`
   * the client offers to upgrade, but only if the server says it can — and a
   * machine in the middle can simply delete STARTTLS from the capability list,
   * at which point the client shrugs and sends the password in the clear. The
   * user is told nothing, because from the client's side nothing went wrong.
   *
   * So the requirement is stated, not inferred from what the server offered:
   * `true` refuses to authenticate over anything but a real TLS socket, `false`
   * permits cleartext, and `null` (or nothing at all, which is what every
   * existing config says) means "required unless the host is loopback".
   */
  constructor({ host, port, secure = true, user, pass, requireTls = null, timeoutMs = 30000, logger } = {}) {
    if (!host || typeof host !== 'string') throw new Error('ImapClient: host is required');
    this.host = host;
    this.secure = secure !== false;
    this.port = Number(port) || (this.secure ? 993 : 143);
    this.requireTls = requireTls === null || requireTls === undefined
      ? tlsRequiredByDefault(this.host)
      : requireTls !== false;
    this.user = user == null ? '' : String(user);
    this.pass = pass == null ? '' : String(pass);
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
    this.mailbox = null;
    const base = logger || defaultLog;
    this.log = typeof base.child === 'function' ? base.child('[imap]') : base;
  }

  /* ---------------- lifecycle ---------------- */

  async connect() {
    if (this.#socket) return;
    if (this.#dead) throw this.#error('client already closed');

    const greeting = new Promise((resolve, reject) => {
      this.#greeting = { resolve, reject };
    });

    let socket;
    try {
      socket = await this.#openSocket(this.secure);
    } catch (err) {
      this.#greeting = null;
      throw err;
    }
    this.#attach(socket);

    const timer = setTimeout(() => {
      this.#fail(this.#error(`no greeting within ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    try {
      await greeting;
    } finally {
      clearTimeout(timer);
    }

    if (!this.secure) {
      const caps = await this.capabilities();
      if (caps.has('STARTTLS')) await this.#startTls();
    }
    // Checked here as well as in login() so the caller learns immediately, on
    // the call that opened the socket, rather than one step later.
    this.#assertEncrypted();
  }

  /**
   * The gate. Not "did we try to upgrade" but "is this socket actually TLS" —
   * `encrypted` is set by node:tls itself and is the only thing here a hostile
   * server has no say over. A CAPABILITY reply is the server's word; a
   * TLSSocket is a handshake that happened.
   *
   * Failing closes the connection, because a session that is not allowed to
   * authenticate has nothing left to do on it.
   */
  #assertEncrypted() {
    if (!this.requireTls) return;
    if (this.#socket && this.#socket.encrypted === true) return;
    const err = this.#error(
      'this connection is still in the clear and the server never offered STARTTLS, '
      + 'so your password was not sent. Connect with TLS (port 993 usually), or, if a '
      + 'plaintext connection to this host is deliberate, set requireTls to false on the account.',
    );
    this.#fail(err);
    throw err;
  }

  #openSocket(useTls) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      // `onError` stays registered after the promise settles: without a listener
      // an 'error' between connect and #attach would be thrown, not handled.
      const onError = (err) => finish(reject, this.#error(`connection failed — ${err.message}`, err));

      const socket = useTls
        ? tls.connect({ host: this.host, port: this.port, ...sniFor(this.host) }, () => finish(resolve, socket))
        : net.connect({ host: this.host, port: this.port }, () => finish(resolve, socket));

      const timer = setTimeout(() => {
        socket.destroy();
        finish(reject, this.#error(`timed out connecting after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      socket.once('error', onError);
    });
  }

  #attach(socket) {
    this.#socket = socket;
    socket.setNoDelay(true);
    this.#onSocketData = (chunk) => this.#onData(chunk);
    this.#onSocketError = (err) => this.#fail(this.#error(`socket error — ${err.message}`, err));
    this.#onSocketClose = () => {
      if (this.#loggedOut || this.#dead) return;
      const detail = this.#byeText ? ` — server said: ${this.#byeText}` : '';
      this.#fail(this.#error(`connection closed by server${detail}`));
    };
    socket.on('data', this.#onSocketData);
    socket.on('error', this.#onSocketError);
    socket.on('close', this.#onSocketClose);
  }

  #detach() {
    const socket = this.#socket;
    if (!socket) return null;
    socket.removeListener('data', this.#onSocketData);
    socket.removeListener('error', this.#onSocketError);
    socket.removeListener('close', this.#onSocketClose);
    return socket;
  }

  async #startTls() {
    await this.#exec('STARTTLS');
    const plain = this.#detach();
    // From here the TLS socket owns error reporting for the underlying one; a
    // bare socket with no 'error' listener would take the process down with it.
    plain?.on('error', () => {});
    this.#assembler = new ResponseAssembler();
    this.#caps = null; // capabilities are required to be re-advertised after TLS
    const secured = await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };
      const socket = tls.connect({ socket: plain, ...sniFor(this.host) }, () => settle(resolve, socket));
      socket.once('error', (err) => settle(reject, this.#error(`STARTTLS handshake failed — ${err.message}`, err)));
      socket.once('close', () => settle(reject, this.#error('STARTTLS handshake failed — the server closed the connection')));
    });
    this.#attach(secured);
  }

  async login() {
    if (this.#authenticated) return;
    // The real gate: every path to a password on the wire runs through here,
    // including one on a client somebody built by hand rather than via connect().
    this.#assertEncrypted();
    const caps = await this.capabilities();
    const asciiCredentials = isAsciiSafe(this.user) && isAsciiSafe(this.pass);

    // Non-ASCII credentials go through SASL too: base64 carries arbitrary bytes,
    // where a quoted LOGIN argument would need an 8-bit literal the server may
    // not accept.
    if (caps.has('LOGINDISABLED') || !asciiCredentials) {
      if (caps.has('LOGINDISABLED') && !caps.has('AUTH=PLAIN')) {
        throw this.#error('server refuses LOGIN and does not offer AUTH=PLAIN');
      }
      await this.#authenticatePlain();
    } else {
      await this.#exec(`LOGIN ${quoted(this.user)} ${quoted(this.pass)}`);
    }

    this.#authenticated = true;
    this.#caps = null; // the post-auth capability set is the one that matters
  }

  async #authenticatePlain() {
    const payload = Buffer.concat([
      Buffer.from([0]),
      Buffer.from(this.user, 'utf8'),
      Buffer.from([0]),
      Buffer.from(this.pass, 'utf8'),
    ]).toString('base64');
    let sent = false;
    await this.#exec('AUTHENTICATE PLAIN', {
      onContinuation: () => {
        if (sent) return '*'; // a second prompt means it went wrong: abort cleanly
        sent = true;
        return payload;
      },
    });
  }

  async capabilities() {
    if (this.#caps) return new Set(this.#caps);
    const result = await this.#exec('CAPABILITY');
    const caps = new Set();
    for (const response of result.untagged) {
      if (untaggedName(response) !== 'CAPABILITY') continue;
      for (const value of response.values.slice(2)) {
        const text = tokenText(value);
        if (text) caps.add(text.toUpperCase());
      }
    }
    for (const cap of capsFromCode(result.code)) caps.add(cap);
    this.#caps = caps;
    return new Set(caps);
  }

  async listMailboxes() {
    const result = await this.#exec('LIST "" "*"');
    const out = [];
    for (const response of result.untagged) {
      if (untaggedName(response) !== 'LIST') continue;
      const flags = listItems(response.values[2]).map((v) => tokenText(v)).filter(Boolean);
      const delimiter = tokenText(response.values[3]);
      const rawName = tokenText(response.values[4]);
      if (rawName === null) continue;
      const name = decodeModifiedUTF7(rawName);
      out.push({ name, delimiter, flags, specialUse: specialUseOf(name, flags) });
    }
    return out;
  }

  /**
   * Open a mailbox. Read-only by default: EXAMINE cannot set \Seen or expunge,
   * which makes "Zelos never changes your mail" true at the protocol level
   * rather than by our own good behaviour.
   */
  async select(mailbox, { readOnly = true } = {}) {
    const name = String(mailbox ?? 'INBOX');
    const result = await this.#exec(`${readOnly ? 'EXAMINE' : 'SELECT'} ${quoted(encodeModifiedUTF7(name))}`);

    let exists = 0;
    let uidValidity = null;
    let uidNext = null;
    let flags = [];
    for (const response of result.untagged) {
      const existsMatch = /^\*\s+(\d+)\s+EXISTS\b/i.exec(response.text);
      if (existsMatch) { exists = Number(existsMatch[1]); continue; }
      const validity = /\[UIDVALIDITY\s+(\d+)\]/i.exec(response.text);
      if (validity) uidValidity = Number(validity[1]);
      const next = /\[UIDNEXT\s+(\d+)\]/i.exec(response.text);
      if (next) uidNext = Number(next[1]);
      if (untaggedName(response) === 'FLAGS') {
        flags = listItems(response.values[2]).map((v) => tokenText(v)).filter(Boolean);
      }
    }

    this.mailbox = name;
    return { mailbox: name, exists, uidValidity, uidNext, flags, readOnly };
  }

  /** `search(['SINCE','01-Aug-2026'])` -> [uid]. Always UID SEARCH. */
  async search(criteria = ['ALL']) {
    const parts = (Array.isArray(criteria) ? criteria : [criteria]).map((c) => searchArg(c));
    const result = await this.#exec(`UID SEARCH ${parts.join(' ')}`);
    const uids = [];
    for (const response of result.untagged) {
      if (untaggedName(response) !== 'SEARCH') continue;
      for (const value of response.values.slice(2)) {
        const n = Number(tokenText(value));
        if (Number.isInteger(n) && n > 0) uids.push(n);
      }
    }
    return uids;
  }

  /**
   * `fetch([101,102], 'UID FLAGS BODY.PEEK[1]')` -> [{uid, flags, sections, …}]
   * Chunked into ≤100 UIDs per command.
   */
  async fetch(uids, items) {
    const spec = Array.isArray(items) ? items.join(' ') : String(items ?? 'UID');
    assertPeekOnly(spec);

    const wanted = [...new Set((Array.isArray(uids) ? uids : [uids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const out = [];
    for (let i = 0; i < wanted.length; i += UID_CHUNK) {
      const chunk = wanted.slice(i, i + UID_CHUNK);
      const result = await this.#exec(`UID FETCH ${chunk.join(',')} (${spec})`);
      for (const response of result.untagged) {
        if (untaggedName(response) === 'FETCH') out.push(parseFetchResponse(response));
      }
    }
    return out;
  }

  async logout() {
    if (!this.#socket || this.#dead) return;
    try {
      await this.#exec('LOGOUT');
    } finally {
      this.#loggedOut = true;
    }
  }

  async close() {
    this.#dead = true;
    const socket = this.#detach();
    this.#socket = null;
    if (socket) {
      socket.destroy();
      // Give the event loop one turn so the destroyed socket's handlers settle
      // before a caller tears down a test server underneath it.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const pending = [...this.#queue];
    this.#queue = [];
    const current = this.#current;
    this.#current = null;
    if (current) {
      clearTimeout(current.timer);
      current.reject(this.#error('connection closed'));
    }
    for (const job of pending) job.reject(this.#error('connection closed'));
  }

  /* ---------------- command plumbing ---------------- */

  /**
   * One command in flight at a time. Untagged responses that arrive while a
   * command runs belong to it; the tagged completion resolves or rejects it.
   */
  #exec(command, { onContinuation = null } = {}) {
    return new Promise((resolve, reject) => {
      if (this.#dead || !this.#socket) {
        reject(this.#error('not connected'));
        return;
      }
      this.#queue.push({ command, onContinuation, resolve, reject, untagged: [], tag: null, timer: null });
      this.#pump();
    });
  }

  #pump() {
    if (this.#current || this.#queue.length === 0 || this.#dead || !this.#socket) return;
    const job = this.#queue.shift();
    job.tag = `A${String(++this.#tagSeq).padStart(4, '0')}`;
    this.#current = job;
    this.#arm(job);
    this.log.debug(`C: ${job.tag} ${sanitizeCommand(job.command)}`);
    this.#socket.write(`${job.tag} ${job.command}${CRLF}`);
  }

  /**
   * The deadline is for *silence*, not for the whole command: fetching a
   * hundred messages over a slow link is healthy, a server that has said
   * nothing for 30 seconds is not.
   */
  #arm(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      this.#fail(this.#error(`no response to ${verbOf(job.command)} for ${this.timeoutMs}ms`));
    }, this.timeoutMs);
  }

  #onData(chunk) {
    if (this.#current) this.#arm(this.#current);
    let responses;
    try {
      responses = this.#assembler.push(chunk);
    } catch (err) {
      this.#fail(this.#error(err.message));
      return;
    }
    for (const raw of responses) {
      try {
        this.#onResponse(raw);
      } catch (err) {
        this.#fail(this.#error(`could not parse server response — ${err.message}`, err));
        return;
      }
    }
  }

  #onResponse(raw) {
    const values = parseResponse(raw);
    const lead = tokenText(values[0]);

    if (lead === '+') {
      const job = this.#current;
      if (!job || !job.onContinuation) {
        // Nothing wants this prompt; cancel it rather than deadlock.
        this.#socket?.write(`*${CRLF}`);
        return;
      }
      const reply = job.onContinuation(raw.text.slice(1).trim());
      this.log.debug('C: <continuation payload withheld>');
      this.#socket.write(`${reply == null ? '' : reply}${CRLF}`);
      return;
    }

    if (lead === '*') {
      const response = { text: raw.text, values };
      const name = untaggedName(response);
      if (name === 'CAPABILITY') this.#caps = null;
      if (name === 'BYE') this.#byeText = raw.text.replace(/^\*\s*BYE\s*/i, '').trim();
      if (this.#greeting) {
        const greeting = this.#greeting;
        this.#greeting = null;
        if (name === 'BYE') {
          greeting.reject(this.#error(`server refused the connection — ${this.#byeText}`));
          return;
        }
        if (name === 'PREAUTH') this.#authenticated = true;
        for (const cap of capsFromCode(codeOf(raw.text))) {
          this.#caps = this.#caps || new Set();
          this.#caps.add(cap);
        }
        greeting.resolve();
        return;
      }
      if (this.#current) this.#current.untagged.push(response);
      return;
    }

    const job = this.#current;
    if (!job || lead !== job.tag) {
      this.log.debug(`S: unsolicited tagged response ignored: ${raw.text.slice(0, 120)}`);
      return;
    }

    clearTimeout(job.timer);
    this.#current = null;

    const match = /^\S+\s+(OK|NO|BAD)\b\s*(.*)$/is.exec(raw.text);
    const status = match ? match[1].toUpperCase() : 'BAD';
    const detail = match ? match[2].trim() : raw.text;
    const code = codeOf(detail);

    if (status === 'OK') {
      job.resolve({ ok: true, status, code, text: detail, untagged: job.untagged });
    } else {
      const err = this.#error(`${verbOf(job.command)} failed — ${status}${detail ? ` ${detail}` : ''}`);
      err.status = status;
      err.code = code;
      job.reject(err);
    }
    this.#pump();
  }

  /** A fatal condition: every waiting caller learns which host went wrong. */
  #fail(err) {
    if (this.#dead) return;
    this.#dead = true;
    const socket = this.#detach();
    this.#socket = null;
    socket?.destroy();

    const job = this.#current;
    this.#current = null;
    if (job) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    const pending = [...this.#queue];
    this.#queue = [];
    for (const queued of pending) queued.reject(err);
    if (this.#greeting) {
      const greeting = this.#greeting;
      this.#greeting = null;
      greeting.reject(err);
    }
  }

  /**
   * Every error this client raises is built here, which makes it the one place
   * that can guarantee the server's own words never carry our credentials back
   * out. A server is entitled to quote the command it rejected, and real ones do
   * — `NO [AUTHENTICATIONFAILED] rejected: A0002 LOGIN "me@x" "hunter2"`. That
   * text does not stop at the screen: it becomes `sources[].error`, which the
   * sweep writes into `runs.stats_json` in the database and serves from
   * /api/state. So the password is struck out of the message before it exists.
   */
  #error(message, cause) {
    const err = new Error(`IMAP ${this.host}:${this.port}: ${withoutCredentials(message, this.user, this.pass)}`);
    err.host = this.host;
    err.port = this.port;
    if (cause) err.cause = cause;
    return err;
  }
}

/* ---------------- response helpers ---------------- */

function untaggedName(response) {
  const second = tokenText(response.values[1]);
  if (second && !/^\d+$/.test(second)) return second.toUpperCase();
  const third = tokenText(response.values[2]);
  return third ? third.toUpperCase() : '';
}

/** The `[BRACKETED CODE]` that follows a status word, if there is one. */
function codeOf(text) {
  const m = /^\s*(?:\*\s+)?(?:OK|NO|BAD|BYE|PREAUTH)?\s*\[([^\]]*)\]/i.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
}

function capsFromCode(code) {
  if (!code || !/^CAPABILITY\b/i.test(code)) return [];
  return code.split(/\s+/).slice(1).map((c) => c.toUpperCase()).filter(Boolean);
}

function parseFetchResponse(response) {
  const seq = Number(tokenText(response.values[1]));
  const items = listItems(response.values[3]);
  const out = { seq: Number.isInteger(seq) ? seq : null, uid: null, flags: [], internalDate: null, size: null, structure: null, sections: new Map() };

  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = (tokenText(items[i]) || '').toUpperCase();
    const value = items[i + 1];
    if (key === 'UID') { out.uid = Number(tokenText(value)); continue; }
    if (key === 'FLAGS') { out.flags = listItems(value).map((v) => tokenText(v)).filter(Boolean); continue; }
    if (key === 'INTERNALDATE') { out.internalDate = tokenText(value); continue; }
    if (key === 'RFC822.SIZE') { out.size = Number(tokenText(value)); continue; }
    if (key === 'BODYSTRUCTURE' || (key === 'BODY' && value && value.type === 'list')) { out.structure = value; continue; }
    const section = /^BODY(?:\.PEEK)?\[(.*)\](?:<\d+>)?$/i.exec(key);
    if (section) out.sections.set(normalizeSection(section[1]), tokenBytes(value));
  }
  return out;
}

/** "header.fields (from  to)" and "HEADER.FIELDS (FROM TO)" are one section. */
function normalizeSection(spec) {
  return String(spec).replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * The one thing this client must never do. `BODY[...]` sets \Seen on the
 * server; refuse to put one on the wire even if a caller asks for it.
 */
function assertPeekOnly(spec) {
  if (/\bBODY\s*\[/i.test(spec)) {
    throw new Error('refusing to send BODY[...] — it would mark the message as read; use BODY.PEEK[...]');
  }
}

/** The command name alone — arguments never reach an error message or a log. */
function verbOf(command) {
  const parts = String(command).trim().split(/\s+/);
  const head = (parts[0] || '').toUpperCase();
  return head === 'UID' && parts[1] ? `${head} ${parts[1].toUpperCase()}` : head;
}

function sanitizeCommand(command) {
  if (/^LOGIN\b/i.test(command)) return 'LOGIN <user> <password withheld>';
  if (/^AUTHENTICATE\b/i.test(command)) return String(command).split(/\s+/).slice(0, 2).join(' ');
  return command;
}

const WITHHELD = '<password withheld>';

/**
 * Strike our own password out of text that came back from the server.
 *
 * Three spellings, because that is how many ways this password left the process:
 * the literal bytes (a quoted LOGIN argument), its standalone base64, and the
 * SASL PLAIN payload `base64(NUL user NUL pass)`. A server that echoes any of
 * them is handing the credential back, and everything downstream — an API
 * response, `runs.stats_json` on disk, a log line — would keep it.
 */
function withoutCredentials(message, user, pass) {
  let text = String(message);
  if (!pass) return text;
  const plain = Buffer.concat([
    Buffer.from([0]), Buffer.from(String(user ?? ''), 'utf8'),
    Buffer.from([0]), Buffer.from(pass, 'utf8'),
  ]).toString('base64');
  for (const form of [pass, Buffer.from(pass, 'utf8').toString('base64'), plain]) {
    if (form) text = text.split(form).join(WITHHELD);
  }
  return text;
}

/**
 * SNI carries a hostname, and Node rejects an IP address there outright — which
 * matters because Proton Bridge and self-hosted servers are reached by IP.
 */
function sniFor(host) {
  return net.isIP(host) ? {} : { servername: host };
}

function quoted(value) {
  const s = String(value ?? '');
  if (/[\r\n]/.test(s)) throw new Error('IMAP argument contains a line break');
  return `"${s.replace(/([\\"])/g, '\\$1')}"`;
}

function isAsciiSafe(value) {
  return /^[\x20-\x7e]*$/.test(String(value ?? ''));
}

function searchArg(value) {
  const s = String(value ?? '');
  if (/[\r\n]/.test(s)) throw new Error('IMAP search argument contains a line break');
  if (/^[A-Za-z0-9._:*,+-]+$/.test(s)) return s;
  return quoted(s);
}

function specialUseOf(name, flags) {
  for (const flag of flags) {
    if (SPECIAL_USE_FLAGS.has(String(flag).toLowerCase())) return String(flag).slice(1).toLowerCase();
  }
  return name.toUpperCase() === 'INBOX' ? 'inbox' : null;
}

/* ================================================================== *
 * 6. The function the engine calls
 * ================================================================== */

/**
 * Newest-first messages from one mailbox, headers and readable body only.
 *
 * Two passes on purpose: the first is cheap enough to run over hundreds of
 * messages (headers + structure), the second pulls exactly one body part per
 * message, chosen from the structure. Fetching whole messages to throw away the
 * attachments is how a mail sync turns into a download.
 */
export async function fetchRecent({
  host,
  port,
  secure,
  user,
  pass,
  requireTls = null,
  mailbox = 'INBOX',
  sinceDays = 14,
  limit = 400,
  onProgress,
  timeoutMs,
  logger,
} = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const client = new ImapClient({ host, port, secure, user, pass, requireTls, timeoutMs, logger });

  try {
    progress({ phase: 'connect', message: `Connecting to ${host}`, done: 0, total: 0 });
    await client.connect();
    await client.login();

    progress({ phase: 'select', message: `Opening ${mailbox}`, done: 0, total: 0 });
    await client.select(mailbox);

    const since = imapDate(new Date(Date.now() - Math.max(0, sinceDays) * 86_400_000));
    progress({ phase: 'search', message: `Looking for mail since ${since}`, done: 0, total: 0 });
    let uids;
    try {
      uids = await client.search(['SINCE', since]);
    } catch {
      // A server that rejects SINCE is rare but real. Falling back to the whole
      // mailbox and keeping the highest `limit` UIDs still yields the newest
      // messages — it just costs more to get there.
      uids = await client.search(['ALL']);
    }
    uids.sort((a, b) => b - a);
    if (uids.length > limit) uids = uids.slice(0, limit);
    if (uids.length === 0) {
      progress({ phase: 'done', message: 'No recent mail', done: 0, total: 0 });
      return [];
    }

    progress({ phase: 'headers', message: `Reading ${uids.length} headers`, done: 0, total: uids.length });
    const cheap = await client.fetch(
      uids,
      `UID FLAGS INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]`,
    );

    const records = new Map();
    const byPart = new Map();
    for (const row of cheap) {
      if (!Number.isInteger(row.uid)) continue;
      const record = buildRecord(row, mailbox);
      records.set(row.uid, record);
      const key = record.bodyPart || 'TEXT';
      if (!byPart.has(key)) byPart.set(key, []);
      byPart.get(key).push(row.uid);
    }
    progress({ phase: 'headers', message: `Read ${records.size} headers`, done: records.size, total: uids.length });

    let done = 0;
    const total = records.size;
    for (const [part, partUids] of byPart) {
      const rows = await client.fetch(partUids, `UID BODY.PEEK[${part}]`);
      for (const row of rows) {
        const record = records.get(row.uid);
        if (!record) continue;
        const buf = row.sections.get(normalizeSection(part));
        if (buf) applyBody(record, buf);
      }
      done += partUids.length;
      progress({ phase: 'bodies', message: `Read ${done} of ${total} messages`, done, total });
    }

    const messages = [...records.values()].map(finishRecord);
    messages.sort((a, b) => (instant(b.date) ?? 0) - (instant(a.date) ?? 0) || b.uid - a.uid);
    progress({ phase: 'done', message: `${messages.length} messages`, done: messages.length, total: messages.length });
    return messages;
  } finally {
    try {
      await client.logout();
    } catch {
      // A failed logout tells us nothing we can act on; the close below is what matters.
    }
    await client.close();
  }
}

function buildRecord(row, mailbox) {
  const headerBytes = pickHeaderSection(row.sections);
  const headers = parseHeaders(headerBytes);
  const first = (name) => (headers.get(name) || [''])[0] || '';

  const parts = row.structure ? structureParts(row.structure) : [];
  const chosen = chooseTextPart(parts);
  const messageId = stripAngles(first('message-id'));
  const inReplyTo = stripAngles(first('in-reply-to'));
  const references = (headers.get('references') || [])
    .join(' ')
    .match(/<[^<>]*>/g)
    ?.map(stripAngles) ?? [];
  const subject = decodeWords(first('subject')).replace(/\s+/g, ' ').trim();

  return {
    uid: row.uid,
    messageId,
    inReplyTo,
    references,
    threadKey: threadKeyFor({ messageId, inReplyTo, references, subject }),
    from: parseAddressList(first('from'))[0] || { name: '', email: '' },
    to: parseAddressList(first('to')),
    cc: parseAddressList(first('cc')),
    subject,
    date: parseDate(first('date')) || parseDate(row.internalDate),
    snippet: '',
    text: '',
    hasAttachments: hasAttachmentParts(parts),
    flags: row.flags,
    folder: mailbox,
    bodyPart: chosen ? chosen.part : 'TEXT',
    bodyEncoding: chosen ? chosen.encoding : '7bit',
    bodyCharset: chosen ? chosen.charset : null,
    bodyIsHtml: chosen ? chosen.subtype === 'html' : false,
  };
}

function pickHeaderSection(sections) {
  for (const [key, value] of sections) {
    if (key.startsWith('HEADER')) return value;
  }
  return Buffer.alloc(0);
}

function applyBody(record, buf) {
  const decoded = decodeCharset(decodeTransfer(buf, record.bodyEncoding), record.bodyCharset);
  record.text = record.bodyIsHtml ? htmlToText(decoded) : normalizeText(decoded);
}

function finishRecord(record) {
  const { bodyPart, bodyEncoding, bodyCharset, bodyIsHtml, ...message } = record;
  message.snippet = record.text.replace(/\s+/g, ' ').trim().slice(0, 240);
  return message;
}

function normalizeText(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function stripAngles(value) {
  return String(value ?? '').trim().replace(/^</, '').replace(/>$/, '').trim();
}

/* ================================================================== *
 * 7. Setup helpers
 * ================================================================== */

/** Connect, authenticate, list. Never throws — the UI wants the reason, not a stack. */
export async function testConnection({ host, port, secure, user, pass, requireTls = null, timeoutMs, logger } = {}) {
  let client;
  try {
    client = new ImapClient({ host, port, secure, user, pass, requireTls, timeoutMs, logger });
  } catch (err) {
    return { ok: false, capabilities: [], mailboxes: [], error: err.message };
  }
  try {
    await client.connect();
    await client.login();
    const capabilities = [...(await client.capabilities())].sort();
    const mailboxes = await client.listMailboxes();
    // A logout that fails after everything else worked is not a failed test.
    await client.logout().catch(() => {});
    return { ok: true, capabilities, mailboxes, error: null };
  } catch (err) {
    return { ok: false, capabilities: [], mailboxes: [], error: err.message };
  } finally {
    await client.close();
  }
}

const APP_PASSWORD_NOTE =
  'This provider does not accept your normal password over IMAP. Create an app-specific password in your account security settings and paste that instead.';

const PROVIDERS = [
  {
    domains: ['gmail.com', 'googlemail.com'],
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    note: `Gmail requires 2-Step Verification plus a 16-character App Password (myaccount.google.com → Security → App passwords). ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['icloud.com', 'me.com', 'mac.com'],
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    note: `iCloud Mail requires an app-specific password (appleid.apple.com → Sign-In and Security). ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com'],
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    note: `Yahoo requires an app password (Account Security → Generate app password). ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com'],
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    note: 'Microsoft is retiring password-based IMAP for personal accounts. If sign-in fails, check whether IMAP is still enabled for your account, and use an app password if you have two-step verification on.',
  },
  {
    domains: ['fastmail.com', 'fastmail.fm', 'messagingengine.com'],
    host: 'imap.fastmail.com',
    port: 993,
    secure: true,
    note: 'Fastmail requires an app password with the "Mail (IMAP)" scope (Settings → Privacy & Security → App passwords).',
  },
  {
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    host: '127.0.0.1',
    port: 1143,
    secure: false,
    note: 'Proton encrypts mail on their servers, so IMAP only works through Proton Bridge running on this machine. Use the host, port and password shown in Bridge — not your Proton account password.',
  },
  {
    domains: ['aol.com'],
    host: 'imap.aol.com',
    port: 993,
    secure: true,
    note: `AOL requires an app password. ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['zoho.com', 'zohomail.com'],
    host: 'imap.zoho.com',
    port: 993,
    secure: true,
    note: 'Zoho requires IMAP to be enabled in Mail Settings, and an app-specific password if two-factor authentication is on.',
  },
];

/**
 * Best guess at a mail host from an address.
 *
 * The `note` is load-bearing, not decoration: Gmail, iCloud and Yahoo all
 * reject the password a person actually knows, and without being told why,
 * every one of those users concludes the app is broken.
 */
export function guessImapHost(email) {
  const address = String(email ?? '').trim().toLowerCase();
  const domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '';
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return {
      host: '',
      port: 993,
      secure: true,
      note: 'Enter your full email address and Zelos will suggest a server, or type your provider\'s IMAP host directly.',
    };
  }

  for (const provider of PROVIDERS) {
    if (provider.domains.includes(domain)) {
      return { host: provider.host, port: provider.port, secure: provider.secure, note: provider.note };
    }
  }

  return {
    host: `imap.${domain}`,
    port: 993,
    secure: true,
    note: `Guessed from your address. If imap.${domain} is wrong, your provider's help pages list the correct IMAP server. Many providers also require an app-specific password rather than your normal one.`,
  };
}
