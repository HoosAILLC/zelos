/**
 * Explicit public-web retrieval. No model, private index, cookies or browser history.
 * Callers must obtain a user-entered URL/query and fence all returned source text.
 * Sources remain untrusted evidence; dates are claims by the page/search provider.
 *
 * Brave reference: https://api-dashboard.search.brave.com/api-reference/web/search/get
 * Address policy: IANA special-purpose registries, conservatively excluding tunnels.
 */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

export const WEB_RESEARCH_LIMITS = Object.freeze({ timeoutMs: 15000, maxBytes: 1000000, maxRedirects: 3,
  maxUrlChars: 4096, maxExcerptChars: 12000, maxSearchExcerptChars: 1500, maxResults: 8,
  maxTagChars: 16384, maxPageTokens: 50000, maxParserWorkers: 2 });
export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const WEB_SEARCH_SECRET_REF = 'web.brave.apiKey';
export class WebResearchError extends Error {
  constructor(message, { status = 400, code = 'INVALID_INPUT' } = {}) {
    super(message); this.name = 'WebResearchError'; this.status = status; this.code = code;
  }
}
const fail = (message, code = 'INVALID_INPUT', status = 400) => { throw new WebResearchError(message, { code, status }); };
const forbidden = () => fail('Only public web addresses are allowed. Local, private and special network addresses are blocked.', 'BLOCKED_ADDRESS');
const cancelled = signal => new WebResearchError(signal?.reason?.name === 'TimeoutError' ? 'Web lookup timed out.' : 'Web lookup was stopped.',
  { status: signal?.reason?.name === 'TimeoutError' ? 504 : 499, code: signal?.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED' });
const assertActive = signal => { if (signal?.aborted) throw cancelled(signal); };
const NOISE = /[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\\]/;
const SECRET_PARAM = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|api[_-]?key|key|token|secret|password|passwd|credential|signature|sig|session(?:id)?|code|x-amz-.+|x-goog-.+)$/i;

function ipv6Number(address) {
  // isIP has already validated the input. Mapped/translated addresses are denied below.
  if (address.includes('.')) return null;
  const halves = address.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return words.reduce((value, word) => value * 65536n + BigInt(`0x${word}`), 0n);
}
function inV6(value, prefix, bits) { return value >> BigInt(128 - bits) === ipv6Number(prefix) >> BigInt(128 - bits); }
/** Conservative public unicast policy, including CGNAT/Tailscale and metadata exclusions. */
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113 || address === '168.63.129.16');
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  return value !== null && inV6(value, '2000::', 3)
    && !inV6(value, '2001::', 23) && !inV6(value, '2001:db8::', 32)
    && !inV6(value, '2002::', 16) && !inV6(value, '3fff::', 20);
}
/** Syntax policy only; each actual request additionally resolves and pins public DNS. */
export function validatePublicUrl(value) {
  if (typeof value !== 'string' || !value || value.length > WEB_RESEARCH_LIMITS.maxUrlChars || NOISE.test(value)) {
    fail('Enter a valid public http:// or https:// URL.', 'INVALID_URL');
  }
  let url; try { url = new URL(value); } catch { fail('Enter a valid public http:// or https:// URL.', 'INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('Only http:// and https:// pages can be read.', 'INVALID_URL');
  if (url.username || url.password || [...url.searchParams.keys()].some(key => SECRET_PARAM.test(key))) {
    fail('Use a public URL without passwords, access tokens or signed credentials.', 'CREDENTIAL_URL');
  }
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) forbidden();
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(host)) { if (!isPublicAddress(host)) forbidden(); }
  else if (!host.includes('.') || host.length > 253 || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|test|invalid|example|onion|arpa)$/.test(host)
    || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) forbidden();
  if (!isIP(host)) url.hostname = host;
  url.hash = ''; // Fragments can carry login material and are never sent to the server.
  return url;
}

async function abortable(promise, signal) {
  assertActive(signal);
  let stop;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      stop = () => reject(cancelled(signal)); signal.addEventListener('abort', stop, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', stop); }
}
async function resolvePublic(url, deps, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  let answers;
  try { answers = await abortable(Promise.resolve().then(() => (deps.lookup || dnsLookup)(hostname, { all: true, verbatim: true })), signal); }
  catch (error) { if (error instanceof WebResearchError) throw error; fail('The public website could not be resolved.', 'DNS_FAILED', 502); }
  if (!Array.isArray(answers) || !answers.length || answers.length > 64) fail('The public website could not be resolved.', 'DNS_FAILED', 502);
  if (answers.some(record => !isPublicAddress(record.address) || isIP(record.address) !== record.family)) forbidden();
  return answers.find(record => record.family === 4) || answers[0];
}
const mediaType = headers => String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
function pinnedRequest(url, pin, { signal, headers, types }, deps) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:', transport = secure ? https : http;
    // Explicit agent ignores ambient proxy settings; a proxy could re-resolve the host.
    const agent = new transport.Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
    let req, res, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', stop);
      if (error) { res?.destroy(); req?.destroy(); }
      agent.destroy(); error ? reject(error) : resolve(value);
    };
    const stop = () => finish(cancelled(signal));
    if (signal.aborted) { finish(cancelled(signal)); return; }
    signal.addEventListener('abort', stop, { once: true });
    try {
      req = (deps.request || transport.request)({ protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: secure ? 443 : 80, path: url.pathname + url.search, method: 'GET', agent,
        family: pin.family, autoSelectFamily: false, maxHeaderSize: 16384,
        lookup: (_hostname, options, callback) => options?.all ? callback(null, [pin]) : callback(null, pin.address, pin.family),
        ...(secure ? { rejectUnauthorized: true, servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? '' : url.hostname } : {}),
        headers: { Accept: 'text/html, text/plain;q=0.9, application/json;q=0.8', 'Accept-Encoding': 'identity',
          'User-Agent': 'Zelos-PublicReader/1.0', ...headers },
      }, incoming => {
        res = incoming;
        res.on('error', () => finish(new WebResearchError('The website response was interrupted.', { code: 'FETCH_FAILED', status: 502 })));
        if (settled) { res.destroy(); return; }
        const status = res.statusCode || 0, responseHeaders = res.headers;
        if (status < 200 || status >= 300) {
          finish(null, { status, headers: responseHeaders, body: Buffer.alloc(0) }); res.destroy(); return;
        }
        if (!types.has(mediaType(responseHeaders))) {
          finish(new WebResearchError('This response is not a supported readable web page.', { code: 'UNSUPPORTED_CONTENT', status: 415 })); return;
        }
        if (Number(responseHeaders['content-length']) > WEB_RESEARCH_LIMITS.maxBytes) {
          finish(new WebResearchError('The web page is too large to read.', { code: 'RESPONSE_TOO_LARGE', status: 413 })); return;
        }
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > WEB_RESEARCH_LIMITS.maxBytes) finish(new WebResearchError('The web page is too large to read.', { code: 'RESPONSE_TOO_LARGE', status: 413 }));
          else chunks.push(chunk);
        });
        res.on('end', () => finish(null, { status, headers: responseHeaders, body: Buffer.concat(chunks) }));
      });
      req.on('error', () => finish(new WebResearchError('The public website could not be read securely.', { code: 'FETCH_FAILED', status: 502 })));
      req.on('upgrade', (_response, socket) => { socket.destroy(); finish(new WebResearchError('Web protocol upgrades are not supported.', { code: 'UNSUPPORTED_CONTENT', status: 415 })); });
      req.end();
    } catch { finish(new WebResearchError('The public website could not be read securely.', { code: 'FETCH_FAILED', status: 502 })); }
  });
}
async function decodeResponse(response, signal) {
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase().trim();
  let bytes = response.body;
  if (encoding !== 'identity') {
    const decoder = { gzip: gunzip, deflate: inflate, br: brotliDecompress }[encoding];
    if (!decoder) fail('This page uses an unsupported content encoding.', 'UNSUPPORTED_CONTENT', 415);
    try { bytes = await abortable(promisify(decoder)(bytes, { maxOutputLength: WEB_RESEARCH_LIMITS.maxBytes }), signal); }
    catch (error) {
      if (error instanceof WebResearchError) throw error;
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') fail('The decoded web page is too large to read.', 'RESPONSE_TOO_LARGE', 413);
      fail('The web page could not be decoded.', 'UNREADABLE_RESPONSE', 502);
    }
  }
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers['content-type'] || '')?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); }
  catch { fail('The page uses an unsupported text encoding.', 'UNSUPPORTED_CONTENT', 415); }
}
async function withDeadline(signal, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Deadline', 'TimeoutError')), WEB_RESEARCH_LIMITS.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try { assertActive(combined); return await run(combined); }
  finally { clearTimeout(timer); }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', copy: '©', reg: '®', trade: '™' };
function entities(value) {
  return value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,12});/gi, (all, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? all;
    const code = parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  });
}
/** Redaction is defense in depth, never a substitute for keeping secrets out of inputs. */
export function redactWebCredentials(value, knownSecrets = []) {
  let result = String(value ?? '');
  for (const secret of knownSecrets) if (secret) for (const variant of [secret, encodeURIComponent(secret)]) result = result.split(variant).join('[redacted]');
  return result.replace(/https?:\/\/[^\s/]+/gi, authority => {
    const at = authority.lastIndexOf('@');
    return at < 0 ? authority : `${authority.slice(0, authority.indexOf('//') + 2)}[redacted]@${authority.slice(at + 1)}`;
  })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z\d+/_=.:-]{8,}/gi, '$1 [redacted]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|signature)\s*[=:]\s*["']?)[^\s&"'<>]{4,}/gi, '$1[redacted]');
}
function clean(value, secrets = []) {
  return redactWebCredentials(entities(String(value ?? '')), secrets)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg', 'canvas', 'form', 'nav', 'footer']);
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'br', 'hr', 'blockquote', 'pre']);
const RAW_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const space = char => char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
function attributes(token) {
  const result = Object.create(null);
  // Every character is consumed at most once, including malformed quotes and
  // long whitespace runs. A regex with optional quoted values can backtrack.
  for (let offset = 0; offset < token.length;) {
    if (space(token[offset]) || '=<>/'.includes(token[offset])) { offset++; continue; }
    const start = offset;
    while (offset < token.length && !space(token[offset]) && !'=<>/'.includes(token[offset])) offset++;
    const name = token.slice(start, offset).toLowerCase();
    while (space(token[offset])) offset++;
    let value = '';
    if (token[offset] === '=') {
      offset++; while (space(token[offset])) offset++;
      const quote = token[offset] === '"' || token[offset] === "'" ? token[offset++] : null;
      const valueStart = offset;
      while (offset < token.length && (quote ? token[offset] !== quote : !space(token[offset]) && token[offset] !== '>')) offset++;
      value = token.slice(valueStart, offset);
      if (quote && token[offset] === quote) offset++;
    }
    if (!Object.hasOwn(result, name)) result[name] = entities(value);
  }
  return result;
}
/** Forward-only HTML tokenizer. Unterminated tags have a fixed work budget. */
function* pageTokens(input) {
  const lower = input.toLowerCase();
  let offset = 0, count = 0;
  while (offset < input.length) {
    if (++count > WEB_RESEARCH_LIMITS.maxPageTokens) fail('The web page is too complex to read.', 'UNREADABLE_RESPONSE', 502);
    if (input[offset] !== '<') {
      const next = input.indexOf('<', offset), end = next < 0 ? input.length : next;
      yield { text: input.slice(offset, end) }; offset = end; continue;
    }
    if (input.startsWith('<!--', offset)) {
      const end = input.indexOf('-->', offset + 4);
      offset = end < 0 ? input.length : end + 3; yield { text: ' ' }; continue;
    }
    if (input[offset + 1] === '!' || input[offset + 1] === '?') {
      // Declarations and processing instructions are markup, never body text.
      let end = offset + 2, quote = null;
      for (; end < input.length; end++) {
        if (end - offset > WEB_RESEARCH_LIMITS.maxTagChars) fail('A web page tag is too large to read.', 'UNREADABLE_RESPONSE', 502);
        const char = input[end];
        if (quote) { if (char === quote) quote = null; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '<' || char === '>') break;
      }
      offset = end + (input[end] === '>' ? 1 : 0); continue;
    }
    let cursor = offset + 1;
    const closing = input[cursor] === '/'; if (closing) cursor++;
    if (!/[a-z]/i.test(input[cursor] || '')) { offset++; continue; }
    const start = cursor;
    while (cursor < input.length && /[\w:-]/.test(input[cursor])) cursor++;
    if (cursor - offset > WEB_RESEARCH_LIMITS.maxTagChars) fail('A web page tag is too large to read.', 'UNREADABLE_RESPONSE', 502);
    const name = lower.slice(start, cursor), attrStart = cursor;
    let quote = null;
    for (; cursor < input.length; cursor++) {
      if (cursor - offset > WEB_RESEARCH_LIMITS.maxTagChars) fail('A web page tag is too large to read.', 'UNREADABLE_RESPONSE', 502);
      const char = input[cursor];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '<' || char === '>') break;
    }
    if (input[cursor] !== '>') { offset = cursor; continue; }
    const attrs = input.slice(attrStart, cursor), selfClosing = /\/\s*$/.test(attrs);
    offset = cursor + 1;
    if (!closing && RAW_TAGS.has(name)) {
      // Raw text is discarded without interpreting any tag-looking content.
      // Advance beyond each candidate; repeated incomplete closers are linear.
      let searchAt = offset;
      while (searchAt < input.length) {
        const candidate = lower.indexOf(`</${name}`, searchAt);
        if (candidate < 0) { searchAt = input.length; break; }
        let end = candidate + name.length + 2;
        while (space(input[end])) end++;
        if (input[end] === '>') { searchAt = end + 1; break; }
        searchAt = end;
      }
      offset = searchAt; yield { text: ' ' }; continue;
    }
    yield { name, closing, attrs, selfClosing };
  }
}
function sourceDate(value) {
  if (typeof value !== 'string' || value.length > 100 || !/\d{4}/.test(value)) return null;
  const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
/** Non-executing bounded text extraction; no DOM, external resources or CSS evaluation. */
export function extractReadablePage(input, { contentType = 'text/html', lastModified = null } = {}) {
  if (typeof input !== 'string' || input.length > WEB_RESEARCH_LIMITS.maxBytes) fail('The web page is too large to read.', 'RESPONSE_TOO_LARGE', 413);
  if (!['text/html', 'application/xhtml+xml'].includes(contentType)) {
    const excerpt = clean(input), date = sourceDate(lastModified);
    return { title: '', excerpt: excerpt.slice(0, WEB_RESEARCH_LIMITS.maxExcerptChars), date, dateKind: date ? 'modified' : null,
      truncated: excerpt.length > WEB_RESEARCH_LIMITS.maxExcerptChars };
  }
  const all = [], main = [], title = [], stack = []; let published = null, modified = null, ogTitle = '';
  const append = text => { const top = stack.at(-1); if (top?.skip) return;
    if (top?.title) title.push(text); else if (!top?.head) { all.push(text); if (top?.main) main.push(text); } };
  for (const token of pageTokens(input)) {
    if (Object.hasOwn(token, 'text')) { append(token.text); continue; }
    const { closing, name } = token;
    if (closing) {
      const index = stack.findLastIndex(entry => entry.name === name);
      if (BLOCK_TAGS.has(name)) append('\n');
      if (index >= 0) stack.length = index;
      continue;
    }
    const attrs = attributes(token.attrs), parent = stack.at(-1);
    if (name === 'meta' && !parent?.skip) {
      const property = (attrs.property || attrs.name || '').toLowerCase();
      if (property === 'article:published_time' || property === 'datepublished') published ||= sourceDate(attrs.content);
      if (property === 'article:modified_time' || property === 'last-modified') modified ||= sourceDate(attrs.content);
      if (property === 'og:title') ogTitle ||= attrs.content || '';
    }
    if (BLOCK_TAGS.has(name)) append('\n');
    const entry = { name, skip: parent?.skip || SKIP_TAGS.has(name) || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden'] === 'true'
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || ''), head: parent?.head || name === 'head',
      main: parent?.main || name === 'main' || name === 'article', title: parent?.title || name === 'title' };
    if (!VOID_TAGS.has(name) && !token.selfClosing) {
      if (stack.length >= 256) fail('The web page is too deeply nested to read.', 'UNREADABLE_RESPONSE', 502);
      stack.push(entry);
    }
  }
  const excerpt = clean(main.join('')).trim() || clean(all.join('')), date = published || modified || sourceDate(lastModified);
  return { title: clean(title.join('') || ogTitle).slice(0, 300), excerpt: excerpt.slice(0, WEB_RESEARCH_LIMITS.maxExcerptChars),
    date, dateKind: published ? 'published' : date ? 'modified' : null, truncated: excerpt.length > WEB_RESEARCH_LIMITS.maxExcerptChars };
}

let parserWorkers = 0;
/** Isolate public-page CPU work so the request deadline and Stop remain live. */
export async function extractReadablePageAsync(input, { signal, ...options } = {}) {
  assertActive(signal);
  if (typeof input !== 'string' || input.length > WEB_RESEARCH_LIMITS.maxBytes) fail('The web page is too large to read.', 'RESPONSE_TOO_LARGE', 413);
  if (parserWorkers >= WEB_RESEARCH_LIMITS.maxParserWorkers) fail('Zelos is already reading two web pages. Try again shortly.', 'READER_BUSY', 429);
  parserWorkers++;
  let worker;
  try {
    return await withDeadline(signal, deadline => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, page) => {
        if (settled) return; settled = true;
        deadline.removeEventListener('abort', stop);
        error ? reject(error) : resolve(page);
      };
      const stop = () => finish(cancelled(deadline));
      worker = new Worker(new URL('./web-page-worker.mjs', import.meta.url), {
        workerData: { input, options }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      });
      deadline.addEventListener('abort', stop, { once: true });
      worker.once('message', message => message.error
        ? finish(new WebResearchError(message.error.message, message.error)) : finish(null, message.page));
      worker.once('error', () => finish(new WebResearchError('The web page could not be read.', { code: 'UNREADABLE_RESPONSE', status: 502 })));
      worker.once('exit', () => { if (!settled) finish(new WebResearchError('The web page reader stopped.', { code: 'UNREADABLE_RESPONSE', status: 502 })); });
      if (deadline.aborted) stop();
    }));
  } finally {
    try { if (worker) await worker.terminate(); }
    finally { parserWorkers--; }
  }
}

/** Reads only this explicitly supplied URL and up to three validated HTTP redirects. */
export async function readPublicUrl({ url: input, signal } = {}, deps = {}) {
  let url = validatePublicUrl(input);
  return withDeadline(signal, async deadline => {
    const visited = new Set();
    for (let redirects = 0; ; redirects++) {
      assertActive(deadline);
      if (visited.has(url.href)) fail('The website returned a redirect loop.', 'REDIRECT_LIMIT', 502);
      visited.add(url.href);
      const pin = await resolvePublic(url, deps, deadline);
      const response = await pinnedRequest(url, pin, { signal: deadline, types: PAGE_TYPES }, deps);
      if (REDIRECTS.has(response.status)) {
        if (redirects >= WEB_RESEARCH_LIMITS.maxRedirects) fail('The website redirected too many times.', 'REDIRECT_LIMIT', 502);
        let next; try { next = new URL(response.headers.location, url); } catch { fail('The website returned an invalid redirect.', 'INVALID_REDIRECT', 502); }
        if (!response.headers.location) fail('The website returned an invalid redirect.', 'INVALID_REDIRECT', 502);
        if (url.protocol === 'https:' && next.protocol === 'http:') fail('The website redirected to an insecure connection.', 'BLOCKED_REDIRECT', 400);
        url = validatePublicUrl(next.href); continue;
      }
      if (response.status < 200 || response.status >= 300) fail(`The website returned HTTP ${response.status}.`, 'HTTP_ERROR', 502);
      const text = await decodeResponse(response, deadline);
      const page = await extractReadablePageAsync(text, { contentType: mediaType(response.headers), lastModified: response.headers['last-modified'], signal: deadline });
      if (!page.excerpt) fail('This page has no readable text. It may require sign-in or JavaScript.', 'NO_READABLE_TEXT', 422);
      assertActive(deadline);
      return { kind: 'page', ...page, title: page.title || url.hostname, url: url.href, fetchedAt: new Date().toISOString() };
    }
  });
}

/** Optional non-AI Brave search. No generated queries, history, location or result crawling. */
export async function searchWeb({ query, apiKey, signal, count = 5 } = {}, deps = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75 || /[\x00-\x1f\x7f-\x9f]/.test(query)) {
    fail('Enter a search query of up to 600 characters and 75 words.');
  }
  if (!Number.isInteger(count) || count < 1 || count > WEB_RESEARCH_LIMITS.maxResults) fail('Choose between 1 and 8 web results.');
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('Add a Brave Search API key to enable web search.', 'SEARCH_NOT_CONFIGURED', 409);
  if (!/^[\x21-\x7e]{8,4096}$/.test(apiKey)) fail('The saved Brave Search API key is invalid.', 'INVALID_API_KEY', 409);
  query = query.trim();
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.search = new URLSearchParams({ q: query, count: String(count), result_filter: 'web', text_decorations: 'false', spellcheck: 'false' }).toString();
  return withDeadline(signal, async deadline => {
    const pin = await resolvePublic(url, deps, deadline);
    const response = await pinnedRequest(url, pin, { signal: deadline, types: new Set(['application/json']),
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } }, deps);
    if (response.status !== 200) fail(response.status === 401 || response.status === 403
      ? 'Brave Search did not accept the API key or its permissions.' : response.status === 429
        ? 'Brave Search reached its request limit. Try again later.' : 'Brave Search could not complete this lookup.',
    response.status === 429 ? 'SEARCH_RATE_LIMITED' : 'SEARCH_FAILED', 502);
    let data;
    try { data = JSON.parse(await decodeResponse(response, deadline)); }
    catch (error) { if (error instanceof WebResearchError) throw error; fail('Brave Search returned an unreadable result.', 'UNREADABLE_RESPONSE', 502); }
    if (!data || typeof data !== 'object' || data.web != null && !Array.isArray(data.web.results)) fail('Brave Search returned an unreadable result.', 'UNREADABLE_RESPONSE', 502);
    const sources = [], seen = new Set(), fetchedAt = new Date().toISOString();
    for (const result of (data.web?.results || []).slice(0, 30)) {
      let sourceUrl; try { sourceUrl = validatePublicUrl(result?.url); } catch { continue; }
      if (seen.has(sourceUrl.href) || sourceUrl.href.includes(apiKey) || sourceUrl.href.includes(encodeURIComponent(apiKey))) continue;
      seen.add(sourceUrl.href);
      const excerpt = clean(extractReadablePage(String(result.description || '').slice(0, 10000)).excerpt, [apiKey]);
      const title = clean(extractReadablePage(String(result.title || '').slice(0, 1000)).excerpt, [apiKey]).slice(0, 300) || sourceUrl.hostname;
      const date = sourceDate(result.page_age);
      sources.push({ kind: 'search_result', title, url: sourceUrl.href, excerpt: excerpt.slice(0, WEB_RESEARCH_LIMITS.maxSearchExcerptChars),
        date, dateKind: date ? 'published_or_modified' : null, fetchedAt, truncated: excerpt.length > WEB_RESEARCH_LIMITS.maxSearchExcerptChars });
      if (sources.length >= count) break;
    }
    assertActive(deadline);
    return { kind: 'search', provider: 'brave', query: redactWebCredentials(query, [apiKey]), sources, fetchedAt };
  });
}
