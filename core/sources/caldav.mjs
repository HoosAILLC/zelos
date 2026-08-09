/**
 * core/sources/caldav.mjs — a minimal CalDAV client, built on global fetch.
 *
 * The shape of the protocol, in three hops:
 *   PROPFIND Depth:0  →  current-user-principal   ("who am I on this server")
 *   PROPFIND Depth:0  →  calendar-home-set        ("where are my collections")
 *   PROPFIND Depth:1  →  the collections themselves, filtered to resourcetype
 *                        `calendar` and, when advertised, VEVENT support
 *   REPORT   Depth:1  →  calendar-query with a time-range, returning raw .ics
 *
 * Servers disagree about almost everything else — namespace prefixes, whether
 * hrefs are absolute or path-only, whether the URL a user pastes is the server
 * root, the principal, the home set or one calendar. So: every URL a server
 * hands back is resolved against the URL it came from, all XML matching is on
 * *local* names with the prefix ignored, and discovery falls back through
 * `/.well-known/caldav` and the origin root before giving up.
 *
 * The XML parser here is deliberately tiny and deliberately incurious: it skips
 * `<!DOCTYPE …>` wholesale, so no entity declaration is ever read, let alone
 * expanded. Server responses are untrusted input like everything else — the
 * calendar text this module returns is data for the ICS parser, never anything
 * that gets executed or fetched.
 */

import { Buffer } from 'node:buffer';
import { log } from '../log.mjs';

const dav = log.child('[caldav]');

const DEFAULT_TIMEOUT_MS = 20_000;
/** Refuse to buffer a response larger than this; a calendar is text. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_XML_DEPTH = 512;

/* ------------------------------------------------------------------ *
 * Tiny XML reader
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Index just past a tag, honouring quoted attribute values containing '>'. */
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/** Index just past a `<!…>` declaration, including any internal subset. */
function skipDeclaration(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return source.length;
}

function parseAttrs(raw) {
  const attrs = Object.create(null);
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : m[1];
    attrs[name.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

function makeNode(name) {
  const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  return { name, local: local.toLowerCase(), attrs: Object.create(null), children: [], text: '' };
}

/**
 * Parse an XML document into a node tree. Iterative, so a deeply nested
 * document costs memory rather than the call stack; malformed markup degrades
 * to a partial tree instead of throwing.
 */
function parseXml(source) {
  const root = makeNode('#document');
  const stack = [root];
  const text = String(source ?? '');
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += text.slice(lt + 9, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      i = skipDeclaration(text, lt);
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt === -1) break;
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const closing = makeNode(inner.slice(1).trim());
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].local === closing.local) {
          stack.length = d;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const node = makeNode((nameEnd === -1 ? body : body.slice(0, nameEnd)).trim());
    if (nameEnd !== -1) Object.assign(node.attrs, parseAttrs(body.slice(nameEnd)));
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) {
        dav.warn('XML nesting cap reached; remainder of the document ignored');
        break;
      }
      stack.push(node);
    }
  }

  return root;
}

/** Every descendant with this local name, document order. */
function findAll(node, local, out = []) {
  for (const child of node.children) {
    if (child.local === local) out.push(child);
    findAll(child, local, out);
  }
  return out;
}

/** First descendant with this local name, or null. */
function findOne(node, local) {
  for (const child of node.children) {
    if (child.local === local) return child;
    const deeper = findOne(child, local);
    if (deeper) return deeper;
  }
  return null;
}

/** Concatenated character data of a node and everything under it. */
function textOf(node) {
  if (!node) return '';
  let out = node.text;
  for (const child of node.children) out += textOf(child);
  return out;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

class CalDavError extends Error {
  constructor(message, { status = 0, host = '' } = {}) {
    super(message);
    this.name = 'CalDavError';
    this.status = status;
    this.host = host;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

function basicAuth(user, pass) {
  if (!user) return null;
  return `Basic ${Buffer.from(`${user}:${pass ?? ''}`, 'utf8').toString('base64')}`;
}

/**
 * The origin the user typed. Credentials go there and nowhere else.
 *
 * Everything after the first request is chosen by the server: a `Location`
 * header, or an `href` inside a multistatus document naming the principal, the
 * calendar-home-set, or a collection. A server that is hostile — or merely
 * compromised, or answering a URL the user mistyped — can point any of those at
 * a host it controls, and Basic auth would carry the calendar password there in
 * a header trivially decoded back to plaintext. So authorisation is pinned to
 * one origin: the hop is still followed, just anonymously, and if it needs a
 * password the caller gets told to point the calendar URL at it directly.
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * One WebDAV request. Follows at most one redirect, re-issuing the same method
 * and body — a 301 from `/` to `/dav/` is how several servers point you at the
 * real collection, and dropping the body there turns a REPORT into a no-op.
 */
async function request(method, url, { user, pass, body = null, depth = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal, redirectsLeft = 1, authOrigin } = {}) {
  const headers = { Accept: 'application/xml, text/xml' };
  // Defaults to this call's own origin, so a direct request is always authorised
  // and only a server-chosen hop can fall outside it.
  const scope = authOrigin ?? originOf(url);
  const auth = originOf(url) === scope ? basicAuth(user, pass) : null;
  if (auth) headers.Authorization = auth;
  if (depth !== null) headers.Depth = String(depth);
  if (body !== null) headers['Content-Type'] = 'application/xml; charset=utf-8';

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw new CalDavError('request aborted', { host: hostOf(url) });
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);

  // The deadline and the caller's abort wiring must outlive the header
  // exchange: fetch() resolves the moment the status line and headers are in,
  // and the body — which a stalling or trickling server controls — is read
  // after that. Tearing the timer down when fetch() resolves would leave the
  // body read unbounded and un-abortable, so everything through the last body
  // byte runs inside this try and the teardown happens once, in the finally.
  let response;
  let text;
  try {
    try {
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      const reason = timedOut
        ? `no response within ${timeoutMs}ms`
        : signal?.aborted
          ? 'cancelled'
          : err?.message || String(err);
      throw new CalDavError(`CalDAV ${method} could not reach ${hostOf(url)}: ${reason}`, { host: hostOf(url) });
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (redirectsLeft > 0 && location) {
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} redirected to an unusable location`, {
            status: response.status,
            host: hostOf(url),
          });
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} redirected to a non-HTTP location`, {
            status: response.status,
            host: hostOf(url),
          });
        }
        dav.debug(`${method} ${response.status} -> ${next.origin}${next.pathname}`);
        return await request(method, next.toString(), { user, pass, body, depth, timeoutMs, signal, redirectsLeft: redirectsLeft - 1, authOrigin: scope });
      }
      throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} redirected more than once`, {
        status: response.status,
        host: hostOf(url),
      });
    }

    if (response.status === 401 || response.status === 403) {
      // Told apart on purpose: "your password is wrong" and "we declined to send
      // your password to a host you did not choose" are different problems, and a
      // user given the first message for the second one will keep retyping a
      // password that was never the issue.
      if (!auth && basicAuth(user, pass)) {
        throw new CalDavError(
          `${hostOf(url)} asked for a password, but it is not the calendar host you configured — ` +
            'Zelos will not send your calendar password to a host a server redirected it to. ' +
            `If ${hostOf(url)} really is your calendar, put its address in the calendar URL directly.`,
          { status: response.status, host: hostOf(url) },
        );
      }
      throw new CalDavError(
        `CalDAV rejected the credentials for ${hostOf(url)} (HTTP ${response.status}). ` +
          'iCloud and Fastmail need an app-specific password, not the account password.',
        { status: response.status, host: hostOf(url) },
      );
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE_BYTES) {
      // Cancel explicitly: a refused body left unconsumed keeps its pooled
      // connection busy and the next request to the same host queues behind it.
      response.body?.cancel()?.catch?.(() => {});
      throw new CalDavError(`CalDAV response from ${hostOf(url)} is too large (${declared} bytes)`, {
        status: response.status,
        host: hostOf(url),
      });
    }

    try {
      text = await readBodyCapped(response, url);
    } catch (err) {
      if (err instanceof CalDavError) throw err;
      const reason = timedOut
        ? `no response within ${timeoutMs}ms`
        : signal?.aborted
          ? 'cancelled'
          : err?.message || String(err);
      throw new CalDavError(`CalDAV ${method} response from ${hostOf(url)} could not be read: ${reason}`, {
        status: response.status,
        host: hostOf(url),
      });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (response.status >= 400) {
    throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} failed: HTTP ${response.status}`, {
      status: response.status,
      host: hostOf(url),
    });
  }

  return { status: response.status, text, url };
}

/**
 * Read a response body while counting bytes, not after buffering them.
 * A content-length check upstream catches the honest oversized response; this
 * catches the chunked one that never declares a length — the read stops and
 * the connection is cancelled the moment the cap is crossed, so a server
 * trickling gigabytes costs at most MAX_RESPONSE_BYTES of memory.
 */
async function readBodyCapped(response, url) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CalDavError(`CalDAV response from ${hostOf(url)} is too large`, {
        status: response.status,
        host: hostOf(url),
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/* ------------------------------------------------------------------ *
 * Request bodies
 * ------------------------------------------------------------------ */

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

const BODY_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop><d:current-user-principal/><d:principal-URL/><d:resourcetype/></d:prop></d:propfind>`;

const BODY_HOME_SET = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const BODY_COLLECTIONS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop>
  <d:resourcetype/><d:displayname/>
  <c:supported-calendar-component-set/><c:calendar-description/>
  <cs:getctag/><ic:calendar-color/>
</d:prop></d:propfind>`;

/** CalDAV wants basic-format UTC: 20260811T140000Z. */
function davTime(value, fallbackMs) {
  const at = value === undefined || value === null || value === ''
    ? new Date(fallbackMs)
    : value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : new Date(String(value));
  const ms = at.getTime();
  const safe = Number.isNaN(ms) ? new Date(fallbackMs) : at;
  return `${safe.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function calendarQueryBody(start, end) {
  // Both values come from davTime, which emits a fixed 16-character basic-format
  // timestamp — nothing user-controlled reaches the document.
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${start}" end="${end}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/* ------------------------------------------------------------------ *
 * Response shapes
 * ------------------------------------------------------------------ */

/** Absolute URL for an href a server handed back, resolved against its source. */
function resolveHref(base, href) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  try {
    const resolved = new URL(raw, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** A propstat block counts only if its status line says 200. */
function okProps(responseNode) {
  const out = [];
  const propstats = findAll(responseNode, 'propstat');
  if (!propstats.length) {
    const prop = findOne(responseNode, 'prop');
    if (prop) out.push(prop);
    return out;
  }
  for (const ps of propstats) {
    const status = textOf(findOne(ps, 'status'));
    if (status && !/\b200\b/.test(status)) continue;
    const prop = findOne(ps, 'prop');
    if (prop) out.push(prop);
  }
  return out;
}

/** First href found under a named property, across all 200 propstats. */
function hrefUnder(doc, base, propLocal) {
  for (const response of findAll(doc, 'response')) {
    for (const prop of okProps(response)) {
      for (const child of prop.children) {
        if (child.local !== propLocal) continue;
        const href = findOne(child, 'href');
        const resolved = resolveHref(base, textOf(href || child));
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function calendarsFrom(doc, base) {
  const out = [];
  for (const response of findAll(doc, 'response')) {
    const href = resolveHref(base, textOf(findOne(response, 'href')));
    if (!href) continue;

    let isCalendar = false;
    let name = '';
    let color = null;
    let ctag = null;
    let components = null;

    for (const prop of okProps(response)) {
      for (const child of prop.children) {
        switch (child.local) {
          case 'resourcetype':
            if (child.children.some((t) => t.local === 'calendar')) isCalendar = true;
            // Scheduling inboxes/outboxes are not something a person reads.
            if (child.children.some((t) => t.local === 'schedule-inbox' || t.local === 'schedule-outbox')) {
              isCalendar = false;
            }
            break;
          case 'displayname':
            name = textOf(child).trim();
            break;
          case 'calendar-color':
            color = textOf(child).trim() || null;
            break;
          case 'getctag':
            ctag = textOf(child).trim() || null;
            break;
          case 'supported-calendar-component-set':
            components = child.children
              .filter((c) => c.local === 'comp' && c.attrs.name)
              .map((c) => String(c.attrs.name).toUpperCase());
            break;
          default:
            break;
        }
      }
    }

    if (!isCalendar) continue;
    if (components && components.length && !components.includes('VEVENT')) continue;
    out.push({
      href,
      name: name || decodeURIComponent(new URL(href).pathname.replace(/\/$/, '').split('/').pop() || 'Calendar'),
      color,
      ctag,
      components: components || [],
    });
  }
  return out;
}

/** Candidate roots to probe, in order, for a URL a person typed or pasted. */
function candidateRoots(url) {
  const roots = [url];
  try {
    const parsed = new URL(url);
    const wellKnown = new URL('/.well-known/caldav', parsed).toString();
    const origin = new URL('/', parsed).toString();
    for (const candidate of [wellKnown, origin]) {
      if (!roots.includes(candidate)) roots.push(candidate);
    }
  } catch {
    /* a malformed URL fails on the first attempt, with a real message */
  }
  return roots;
}

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new CalDavError('No calendar URL was given');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CalDavError(`"${raw}" is not a usable calendar URL`);
  }
  if (parsed.protocol === 'webcal:') parsed.protocol = 'https:';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CalDavError(`Calendar URLs must be http or https, got ${parsed.protocol}`);
  }
  return parsed.toString();
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Walk current-user-principal -> calendar-home-set -> calendar collections.
 * -> {principal, homeSet, calendars:[{href, name, color, ctag, components}]}
 * Throws CalDavError (with .status and .host) when the server cannot be
 * reached or rejects the credentials.
 */
export async function discover({ url, user, pass, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const base = normalizeUrl(url);
  // Every URL followed from here on is one the server chose. Pinning the
  // credential scope to the address the user typed is what keeps a hostile
  // `href` from turning discovery into password delivery.
  const opts = { user, pass, timeoutMs, signal, authOrigin: originOf(base) };

  let principal = null;
  let reached = null;
  // The failure worth reporting is the one on the URL the user actually typed,
  // not whatever /.well-known said afterwards — so this is only ever set once.
  let probeError = null;

  for (const root of candidateRoots(base)) {
    try {
      const res = await request('PROPFIND', root, { ...opts, body: BODY_PRINCIPAL, depth: 0 });
      reached = res.url;
      const doc = parseXml(res.text);
      principal = hrefUnder(doc, res.url, 'current-user-principal') || hrefUnder(doc, res.url, 'principal-url');
      if (principal) break;
    } catch (err) {
      if (!probeError) probeError = err;
      if (err instanceof CalDavError && (err.status === 401 || err.status === 403)) throw err;
    }
  }

  if (!reached && probeError) throw probeError;

  let homeSet = null;
  if (principal) {
    try {
      const res = await request('PROPFIND', principal, { ...opts, body: BODY_HOME_SET, depth: 0 });
      homeSet = hrefUnder(parseXml(res.text), res.url, 'calendar-home-set');
    } catch (err) {
      dav.debug(`calendar-home-set lookup failed: ${err.message}`);
    }
  }

  // Depth:1 on a collection includes the collection itself, so a URL that
  // already points at one calendar is discovered by exactly the same call.
  const searchRoots = [];
  for (const candidate of [homeSet, base, reached]) {
    if (candidate && !searchRoots.includes(candidate)) searchRoots.push(candidate);
  }

  let listed = false;
  let listError = null;
  for (const root of searchRoots) {
    try {
      const res = await request('PROPFIND', root, { ...opts, body: BODY_COLLECTIONS, depth: 1 });
      listed = true;
      const calendars = calendarsFrom(parseXml(res.text), res.url);
      if (calendars.length) return { principal, homeSet, calendars };
    } catch (err) {
      listError = err;
      if (err instanceof CalDavError && (err.status === 401 || err.status === 403)) throw err;
      dav.debug(`collection listing failed at ${hostOf(root)}: ${err.message}`);
    }
  }

  // A listing that succeeded and simply held no calendars is an answer, not an
  // error — only report a failure when nothing could be listed at all.
  if (!listed) {
    throw listError || probeError || new CalDavError(`No DAV collections at ${hostOf(base)}`, { host: hostOf(base) });
  }
  return { principal, homeSet, calendars: [] };
}

/**
 * REPORT calendar-query over [from, to) against every discovered calendar.
 * -> [icsText] — raw VCALENDAR documents, to be handed to the ICS parser.
 *
 * `from`/`to` accept an ISO string, a Date or epoch milliseconds. Omitted, they
 * default to the last 30 and the next 180 days.
 */
export async function fetchRange({ url, user, pass, from, to, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const opts = { user, pass, timeoutMs, signal, authOrigin: originOf(normalizeUrl(url)) };
  const now = Date.now();
  const start = davTime(from, now - 30 * 86_400_000);
  const end = davTime(to, now + 180 * 86_400_000);
  const body = calendarQueryBody(start, end);

  const { calendars: targets } = await discover({ url, ...opts });
  if (!targets.length) {
    dav.warn(`no calendar collections found at ${hostOf(normalizeUrl(url))}`);
    return [];
  }

  const out = [];
  for (const calendar of targets) {
    let res;
    try {
      res = await request('REPORT', calendar.href, { ...opts, body, depth: 1 });
    } catch (err) {
      // One unreadable calendar must not cost the user the others.
      dav.warn(`calendar-query failed for ${calendar.name}: ${err.message}`);
      continue;
    }
    const doc = parseXml(res.text);
    for (const response of findAll(doc, 'response')) {
      for (const prop of okProps(response)) {
        for (const child of prop.children) {
          if (child.local !== 'calendar-data') continue;
          const text = textOf(child).trim();
          if (text.includes('BEGIN:VCALENDAR')) out.push(text);
        }
      }
    }
  }
  return out;
}

/**
 * Probe a calendar account without changing anything.
 * -> {ok, calendars:[{href, name}], error}
 */
export async function testConnection({ url, user, pass, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  try {
    const { calendars } = await discover({ url, user, pass, timeoutMs, signal });
    if (!calendars.length) {
      return { ok: false, calendars: [], error: `Connected to ${hostOf(normalizeUrl(url))} but found no calendars.` };
    }
    return { ok: true, calendars: calendars.map((c) => ({ href: c.href, name: c.name })), error: null };
  } catch (err) {
    return { ok: false, calendars: [], error: err?.message || String(err) };
  }
}
