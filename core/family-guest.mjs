import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import * as family from './family.mjs';

const DEFAULT_ASSETS = fileURLToPath(new URL('../assets/family-portal/', import.meta.url));
const DEFAULT_UI = fileURLToPath(new URL('../ui/', import.meta.url));
const MAX_BODY = 64 * 1024, MAX_UPLOAD_BODY = 12 * 1024 * 1024, MAX_AUTH_BODY = 8192;
const ID = '[A-Za-z0-9_-]{1,128}';
const AUTH_ROUTES = new Map([
  ['/family/v1/login', { operation: 'loginFamily', fields: ['email', 'password'] }],
  ['/family/v1/accept', { operation: 'acceptFamilyInvite', fields: ['token', 'password', 'currentPassword'] }],
  ['/family/v1/verify', { operation: 'completeFamilyMfa', fields: ['challenge', 'code'] }],
]);
const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

class GatewayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new GatewayError(message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('This request has unsupported fields.');
}
function canonicalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('Configure an exact family portal origin.', 500); }
  if (typeof value !== 'string' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || value.replace(/\/$/, '') !== url.origin || !['http:', 'https:'].includes(url.protocol)
    || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    fail('The family portal needs an exact HTTPS origin, or loopback HTTP for local use.', 500);
  }
  return url;
}
function headerCount(req, name) {
  return req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
}
function clientAddress(req, expected, trustedProxy) {
  const remote = req.socket.remoteAddress || 'unknown';
  if (trustedProxy === 'none') return remote;
  // Tailscale Serve v1.102.4 replaces these headers from the connection context.
  // Opt in only when this loopback listener is reached directly through tailscaled.
  const forwarded = req.headers['x-forwarded-for'];
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
    || headerCount(req, 'x-forwarded-for') !== 1 || typeof forwarded !== 'string' || !isIP(forwarded) || forwarded.includes('%')
    || headerCount(req, 'x-forwarded-host') !== 1 || req.headers['x-forwarded-host'] !== expected.host
    || headerCount(req, 'x-forwarded-proto') !== 1 || req.headers['x-forwarded-proto'] !== 'https'
    || headerCount(req, 'tailscale-funnel-request') > 1
    || (headerCount(req, 'tailscale-funnel-request') && req.headers['tailscale-funnel-request'] !== '?1')) {
    fail('This family portal proxy is not allowed.', 403);
  }
  return isIP(forwarded) === 6 ? new URL(`http://[${forwarded}]`).hostname : forwarded;
}
function checkOrigin(req, expected) {
  if (headerCount(req, 'host') !== 1 || req.headers.host !== expected.host || headerCount(req, 'origin') > 1) fail('This family portal host is not allowed.', 403);
  if (headerCount(req, 'origin') && req.headers.origin !== expected.origin) fail('This family portal origin is not allowed.', 403);
  const publicNavigation = req.method === 'GET' && req.url === '/' && headerCount(req, 'origin') === 0
    && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
    && ['same-site', 'cross-site'].includes(req.headers['sec-fetch-site']);
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']) && !publicNavigation) fail('Open the family portal directly.', 403);
}
function bearer(req) {
  const value = req.headers.authorization;
  if (headerCount(req, 'authorization') !== 1 || typeof value !== 'string'
    || !/^Bearer [A-Za-z0-9._~+\/-]{16,512}={0,2}$/i.test(value)) fail('Sign in to continue.', 401);
  return value.slice(7);
}
function json(res, status, value, retryAfter) {
  if (res.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Zelos family"' } : {}),
    ...(status === 429 ? { 'Retry-After': String(retryAfter) } : {}) });
  res.end(bytes);
}
function limiter(db, options = {}) {
  const defaults = { windowMs: 60000, global: 600, peer: 300, writes: 90, writesPeer: 30, authGlobal: 30, authPeer: 12 };
  const limits = { ...defaults, ...options };
  if (Object.keys(options).some(key => !(key in defaults)) || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) fail('Invalid family portal rate limits.', 500);
  let window = 0, total = 0, writes = 0;
  const peers = new Map();
  const persisted = (key, maximum, now = Date.now()) => {
    let allowed = false;
    db.exec('SAVEPOINT family_http_auth_limit');
    try {
      db.prepare('DELETE FROM family_http_auth_limits WHERE window_start<=?').run(now - limits.windowMs);
      const previous = db.prepare('SELECT requests FROM family_http_auth_limits WHERE key=?').get(key);
      if (!previous || previous.requests < maximum) {
        db.prepare(`INSERT INTO family_http_auth_limits(key,window_start,requests) VALUES(?,?,1)
          ON CONFLICT(key) DO UPDATE SET requests=requests+1`).run(key, now);
        allowed = true;
      }
      db.exec('RELEASE family_http_auth_limit');
    } catch (error) {
      db.exec('ROLLBACK TO family_http_auth_limit; RELEASE family_http_auth_limit');
      throw error;
    }
    if (!allowed) fail('Too many requests. Please try again shortly.', 429);
  };
  return { retryAfter: Math.ceil(limits.windowMs / 1000), passwordWork() { persisted('global', limits.authGlobal); }, check(key, write, authenticating) {
    const now = Date.now();
    if (now - window >= limits.windowMs) { window = now; total = writes = 0; peers.clear(); }
    const peer = peers.get(key) || { total: 0, writes: 0 };
    // Rejected peers must not spend another caller's shared capacity.
    if (peer.total >= limits.peer || (write && peer.writes >= limits.writesPeer)
      || total >= limits.global || (write && writes >= limits.writes)) fail('Too many requests. Please try again shortly.', 429);
    if (authenticating) persisted(`peer:${createHash('sha256').update(key).digest('hex')}`, limits.authPeer, now);
    total++; peer.total++;
    if (write) { writes++; peer.writes++; }
    peers.set(key, peer);
  } };
}
function readBody(req, limit) {
  if (headerCount(req, 'content-type') !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail('Send a UTF-8 JSON request.', 415);
  if (req.headers['content-encoding']) fail('Compressed requests are not accepted.', 415);
  if (Number(req.headers['content-length']) > limit) fail('This request is too large.', 413);
  return new Promise((resolve, reject) => {
    let size = 0, parts = [], settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); parts = [];
      if (error) reject(error); else resolve({ value, size });
    };
    const timer = setTimeout(() => finish(new GatewayError('This request took too long.', 408)), 15000);
    timer.unref();
    req.on('data', part => {
      if (settled) return;
      size += part.length;
      if (size > limit) finish(new GatewayError('This request is too large.', 413)); else parts.push(part);
    });
    req.on('aborted', () => finish(new GatewayError('This request stopped before completion.')));
    req.on('error', () => finish(new GatewayError('This request could not be read.')));
    req.on('end', () => {
      if (settled) return;
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
      catch { finish(new GatewayError('Send a valid JSON object.')); return; }
      if (!object(value)) { finish(new GatewayError('Send a valid JSON object.')); return; }
      finish(null, value);
    });
  });
}
function recordQuery(search) {
  const params = new URLSearchParams(search);
  const allowed = ['limit', 'offset', 'kind', 'subjectId', 'status', 'visibility'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail('This records query has unsupported fields.');
  const number = (key, fallback, max) => {
    if (!params.has(key)) return fallback;
    const value = params.get(key);
    if (!/^(0|[1-9]\d{0,8})$/.test(value) || Number(value) > max || (key === 'limit' && Number(value) < 1)) fail('Choose a valid records page.');
    return Number(value);
  };
  const limit = number('limit', 50, 100), offset = number('offset', 0, 5000);
  if (params.has('kind') && !['task', 'plan', 'event', 'tracking', 'note', 'document'].includes(params.get('kind'))) fail('Choose a valid record kind.');
  if (params.has('status') && !['open', 'done'].includes(params.get('status'))) fail('Choose a valid record status.');
  if (params.has('visibility') && !['private', 'family'].includes(params.get('visibility'))) fail('Choose a valid record visibility.');
  if (params.has('subjectId') && params.get('subjectId') !== '' && !new RegExp(`^${ID}$`).test(params.get('subjectId'))) fail('Choose a valid record subject.');
  return { limit, offset, ...Object.fromEntries(['kind', 'subjectId', 'status', 'visibility'].filter(key => params.has(key)).map(key => [key, params.get(key)])) };
}
function attachment(res, file) {
  if (!file || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength > 8 * 1024 * 1024) fail('This document could not be read.', 503);
  const filename = String(file.filename || 'document').replace(/\\/g, '/').split('/').pop()
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 180).trim() || 'document';
  const fallback = filename.replace(/[^A-Za-z0-9 ._()-]/g, '_').replace(/^\.+/, '') || 'document';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  const mime = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/plain; charset=utf-8'].includes(file.mime) ? file.mime : 'application/octet-stream';
  res.writeHead(200, { ...HEADERS, 'Content-Type': mime, 'Content-Length': file.bytes.byteLength,
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}` });
  res.end(file.bytes);
}

/** A separate loopback service; proxy trust is explicit and limited to direct local Tailscale Serve. */
export function createFamilyGuestServer({ db, origin, assetsDir = DEFAULT_ASSETS, uiDir = DEFAULT_UI, rateLimits, trustedProxy = 'none', operations = family } = {}) {
  if (!db) fail('A family database is required.', 500);
  const expected = canonicalOrigin(origin), rate = limiter(db, rateLimits);
  if (!['none', 'tailscale'].includes(trustedProxy) || (trustedProxy === 'tailscale' && expected.protocol !== 'https:')) fail('Choose a valid family portal proxy.', 500);
  const assets = new Map([
    ['/', path.join(assetsDir, 'index.html'), 'text/html; charset=utf-8'],
    ['/app.js', path.join(assetsDir, 'app.js'), 'text/javascript; charset=utf-8'],
    ['/family-client.js', path.join(uiDir, 'lib/family-client.js'), 'text/javascript; charset=utf-8'],
    ['/family.css', path.join(uiDir, 'family.css'), 'text/css; charset=utf-8'],
  ].map(([url, filename, type]) => [url, { bytes: fs.readFileSync(filename), type }]));
  let reading = 0, authenticating = 0;
  const pending = new Set();
  const handle = async (req, res) => {
    if (expected.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      checkOrigin(req, expected);
      const raw = req.url || '';
      if (raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//') || /[\\#]/.test(raw)) fail('Not found.', 404);
      const index = raw.indexOf('?'), pathname = index < 0 ? raw : raw.slice(0, index), search = index < 0 ? '' : raw.slice(index + 1);
      const authRoute = AUTH_ROUTES.has(pathname);
      rate.check(clientAddress(req, expected, trustedProxy), req.method === 'POST', authRoute && req.method === 'POST');
      if (index >= 0 && pathname !== '/collaboration/v1/records') fail('Not found.', 404);
      if (req.method === 'GET' && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) fail('GET requests cannot contain a body.');
      if (req.method === 'GET' && assets.has(pathname)) {
        const asset = assets.get(pathname);
        res.writeHead(200, { ...HEADERS, 'Content-Type': asset.type, 'Content-Length': asset.bytes.length }); res.end(asset.bytes); return;
      }
      const documentMatch = pathname.match(new RegExp(`^/family/v1/documents/(${ID})$`))
        || pathname.match(new RegExp(`^/collaboration/v1/documents/(${ID})/download$`));
      const recordMatch = pathname.match(new RegExp(`^/collaboration/v1/records/(${ID})$`));
      const submissionMatch = pathname.match(new RegExp(`^/collaboration/v1/submissions/(${ID})$`));
      const readRoute = ['/family/v1/state', '/collaboration/v1/me', '/collaboration/v1/records'].includes(pathname) || documentMatch || recordMatch || submissionMatch;
      const writeRoute = ['/family/v1/action', '/family/v1/logout', '/collaboration/v1/tasks', '/collaboration/v1/documents'].includes(pathname);
      if (!((req.method === 'GET' && readRoute) || (req.method === 'POST' && (authRoute || writeRoute)))) fail('Not found.', 404);
      if (index >= 0 && req.method !== 'GET') fail('Not found.', 404);
      let token, actor;
      const authenticate = () => operations.authenticateFamily(db, token);
      if (!authRoute) { token = bearer(req); actor = authenticate(); }
      if (req.method === 'GET') {
        if (documentMatch) {
          const file = await operations.familyDownload(db, actor, documentMatch[1]); authenticate();
          if (!res.destroyed) attachment(res, file); return;
        }
        if (pathname === '/collaboration/v1/records') {
          const result = await operations.familyRecords(db, actor, recordQuery(search)); authenticate();
          json(res, 200, result); return;
        }
        if (recordMatch) {
          const record = await operations.familyRecord(db, actor, recordMatch[1]); authenticate();
          json(res, 200, { record }); return;
        }
        if (submissionMatch) {
          const submission = await operations.familySubmission(db, actor, submissionMatch[1]); authenticate();
          json(res, 200, { submission }); return;
        }
        const state = await operations.familyState(db, actor); authenticate();
        if (pathname === '/family/v1/state') json(res, 200, state);
        else json(res, 200, { family: state.family, me: state.me, permissions: state.permissions });
        return;
      }
      if (reading >= 8 || (authRoute && authenticating >= 4)) fail('Too many requests. Please try again shortly.', 429);
      let body;
      reading++; if (authRoute) authenticating++;
      try {
        const emptyLogout = pathname === '/family/v1/logout' && !req.headers['transfer-encoding'] && !Number(req.headers['content-length']);
        const limit = authRoute ? MAX_AUTH_BODY : ['/family/v1/action', '/collaboration/v1/documents'].includes(pathname) ? MAX_UPLOAD_BODY : MAX_BODY;
        body = emptyLogout ? { value: {}, size: 0 } : await readBody(req, limit);
      } finally { reading--; if (authRoute) authenticating--; }
      if (req.aborted || res.destroyed) return;
      const input = body.value;
      if (authRoute) {
        const authentication = AUTH_ROUTES.get(pathname);
        only(input, authentication.fields);
        if (authenticating >= 4) fail('Too many requests. Please try again shortly.', 429);
        // MFA verification is cheap and already limited by peer, account and challenge.
        // Invalid JSON and unsupported fields never consume the global password-work fuse.
        if (pathname !== '/family/v1/verify') rate.passwordWork();
        authenticating++;
        try {
          const result = await operations[authentication.operation](db, input);
          if (result?.token) operations.authenticateFamily(db, result.token);
          else if (result?.mfaRequired !== true || typeof result.challenge !== 'string' || !/^zfc_[A-Za-z0-9_-]{43}$/.test(result.challenge)) fail('Authentication could not be completed.', 503);
          json(res, 200, result);
        } finally { authenticating--; }
        return;
      }
      // Body streaming may have overlapped account removal, session expiry, or grant revocation.
      actor = authenticate();
      if (pathname === '/family/v1/logout') {
        only(input, []); await operations.logoutFamily(db, token); json(res, 200, { ok: true }); return;
      }
      let action, payload;
      if (pathname === '/family/v1/action') {
        only(input, ['action', 'input']);
        if (typeof input.action !== 'string' || input.action.length > 64 || (input.input !== undefined && !object(input.input))) fail('Choose a valid family action.');
        action = input.action; payload = input.input || {};
        if (action !== 'document.upload' && body.size > MAX_BODY) fail('This request is too large.', 413);
      } else { action = pathname.endsWith('/tasks') ? 'task.submit' : 'document.upload'; payload = input; }
      const result = await operations.familyAction(db, actor, action, payload);
      authenticate();
      json(res, 200, result);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof GatewayError || error instanceof family.FamilyError;
      const status = known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      if (!req.complete || [408, 413].includes(status)) res.setHeader('Connection', 'close');
      json(res, status, { error: known ? error.message : 'The family portal is temporarily unavailable. Please try again later.' }, rate.retryAfter);
      req.resume();
    }
  };
  const server = http.createServer((req, res) => {
    const work = handle(req, res);
    pending.add(work);
    work.then(() => pending.delete(work), () => { pending.delete(work); res.destroy(); });
  });
  server.drainFamilyWork = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32; server.maxConnections = 64; server.maxRequestsPerSocket = 100;
  server.setTimeout(25000, socket => socket.destroy());
  return server;
}

export function listenFamilyGuest(server, { port = 7781, host = '127.0.0.1' } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) fail('The family listener may bind only to loopback.', 500);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('Choose a valid local family port.', 500);
  return new Promise((resolve, reject) => {
    const error = value => { server.removeListener('listening', ready); reject(value); };
    const ready = () => { server.removeListener('error', error); resolve(server.address()); };
    server.once('error', error); server.once('listening', ready); server.listen(port, host);
  });
}
