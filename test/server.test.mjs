/**
 * test/server.test.mjs — the local HTTP server.
 *
 * The security properties are the point of this file, so they are tested the
 * way an attacker would probe them: raw sockets where a client library would
 * "helpfully" normalise a path, a real symlink pointing out of the web root, a
 * real secret written to a real (temporary) secret store and then hunted for in
 * every response the API can produce.
 *
 * Nothing here touches the real ~/.zelos, and nothing here opens a socket to
 * anything but 127.0.0.1: the model, the calendar host and the mail host are
 * all local mock servers stood up by the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

/* The environment has to be set before the modules that read it are evaluated,
   which static imports would not allow — hence the dynamic imports below. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-server-home-'));
process.env.ZELOS_HOME = HOME;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; // never the real keychain
process.env.ZELOS_LOG_LEVEL = 'silent';

const { createServer, listen } = await import('../core/server.mjs');
const db = await import('../core/db.mjs');
const { loadConfig } = await import('../core/config.mjs');
const { setSecret, deleteSecret } = await import('../core/secrets.mjs');

const SECRET_VALUE = 'zelos-test-secret-4d1f9c7b2e6a';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * A web root we control, including a symlink that escapes it
 * ------------------------------------------------------------------ */

const STATIC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-static-'));
const UI_DIR = path.join(STATIC_ROOT, 'ui');
const ASSETS_DIR = path.join(STATIC_ROOT, 'assets');
const OUTSIDE_DIR = path.join(STATIC_ROOT, 'outside');
const OUTSIDE_MARKER = 'OUTSIDE-THE-WEB-ROOT-b31c9a';

fs.mkdirSync(path.join(UI_DIR, 'sub'), { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
fs.writeFileSync(path.join(UI_DIR, 'index.html'), '<!doctype html><title>board</title>');
fs.writeFileSync(path.join(UI_DIR, 'app.css'), ':root{--ink:#171310}');
fs.writeFileSync(path.join(UI_DIR, 'sub', 'deep.txt'), 'deep');
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.txt'), 'icon');
fs.writeFileSync(path.join(OUTSIDE_DIR, 'outside.txt'), OUTSIDE_MARKER);
fs.symlinkSync(path.join(OUTSIDE_DIR, 'outside.txt'), path.join(UI_DIR, 'escape.txt'));

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function baseConfig(patch = {}) {
  const cfg = loadConfig();
  return { ...cfg, ...patch, model: { ...cfg.model, ...(patch.model || {}) } };
}

async function startServer(t, options = {}) {
  const handle = db.open(':memory:');
  db.migrate(handle);
  const server = createServer({
    db: handle,
    config: options.config ?? baseConfig(),
    uiDir: UI_DIR,
    assetsDir: ASSETS_DIR,
    ...options,
  });
  const { port } = await listen(server, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close(handle);
  });
  return {
    db: handle,
    server,
    port,
    token: server.sessionToken,
    base: `http://127.0.0.1:${port}`,
  };
}

async function call(ctx, method, route, { token = ctx.token, body, headers = {}, signal } = {}) {
  const sent = { ...headers };
  if (token !== null) sent['X-Zelos-Token'] = token;
  if (body !== undefined) sent['Content-Type'] = 'application/json';
  const res = await fetch(`${ctx.base}${route}`, {
    method,
    headers: sent,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* not every response is JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * A request written straight onto the socket. Used wherever a client library
 * would normalise the request target before it ever left the process — which
 * is exactly the thing a traversal test must not allow.
 */
function rawRequest(port, requestLine, extraHeaders = []) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    });
    socket.on('connect', () => {
      const hasHost = extraHeaders.some((h) => /^host:/i.test(h));
      socket.write([
        requestLine,
        ...(hasHost ? [] : [`Host: 127.0.0.1:${port}`]),
        ...extraHeaders,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (d) => { buf += d.toString('utf8'); });
    socket.on('end', () => resolve(buf));
    socket.on('close', () => resolve(buf));
    socket.on('error', reject);
  });
}

const statusOf = (raw) => Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);

/** Read an SSE body, handing each complete frame to `onFrame`. */
async function readStream(response, onFrame, { until } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        frames.push(frame);
        onFrame?.(frame);
        if (until && until(frame)) return frames;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function parseFrame(frame) {
  const lines = frame.split('\n');
  if (lines.every((l) => l.startsWith(':'))) return { comment: lines.join('\n') };
  const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? null;
  const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
  return { event, data: data ? JSON.parse(data) : null };
}

/* ------------------------------------------------------------------ *
 * Mock upstreams — all on 127.0.0.1
 * ------------------------------------------------------------------ */

const ICS_BODY = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Mock Calendar',
  'BEGIN:VEVENT', 'UID:evt-1@test', 'DTSTAMP:20260801T120000Z',
  'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z', 'SUMMARY:Budget review',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

/** Speaks just enough of the openai wire protocol, and serves an .ics too. */
async function startMockUpstream(t) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    received.push({ method: req.method, url: req.url, headers: req.headers, body, raw });

    if (req.url.startsWith('/calendar.ics')) {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(ICS_BODY);
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-mini' }] }));
      return;
    }
    if (req.url.startsWith('/chat/completions')) {
      if (body?.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: 'Budget review ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'is on Tuesday.' } }], usage: { prompt_tokens: 41, completion_tokens: 6 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content: 'ready' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { port, baseUrl: `http://127.0.0.1:${port}`, received };
}

/** A port nothing will ever answer on — for the "connection refused" paths. */
async function closedPort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/* ================================================================== *
 * The session token
 * ================================================================== */

test('every /api route requires the session token', async (t) => {
  const ctx = await startServer(t);

  const missing = await call(ctx, 'GET', '/api/health', { token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error, 'unauthorized');

  const wrong = await call(ctx, 'GET', '/api/health', { token: 'f'.repeat(64) });
  assert.equal(wrong.status, 401);

  const short = await call(ctx, 'GET', '/api/health', { token: 'nope' });
  assert.equal(short.status, 401);

  const right = await call(ctx, 'GET', '/api/health');
  assert.equal(right.status, 200);
  assert.equal(right.json.ok, true);
});

test('the token is not accepted in the query string, only in the header', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', `/api/state?t=${ctx.token}`, { token: null });
  assert.equal(res.status, 401);
});

test('an unauthenticated caller cannot even tell which routes exist', async (t) => {
  const ctx = await startServer(t);
  const real = await call(ctx, 'GET', '/api/state', { token: null });
  const fake = await call(ctx, 'GET', '/api/there-is-no-such-route', { token: null });
  assert.equal(real.status, 401);
  assert.equal(fake.status, 401);
  assert.equal(real.text, fake.text);
});

test('the session token is 32 bytes of hex and differs between servers', async (t) => {
  const a = await startServer(t);
  const b = await startServer(t);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  // A token minted for one server is worthless at the other.
  assert.equal((await call(b, 'GET', '/api/health', { token: a.token })).status, 401);
});

/* ================================================================== *
 * Origin, Host, CORS
 * ================================================================== */

test('a foreign Origin is refused even with a valid token', async (t) => {
  const ctx = await startServer(t);
  for (const origin of [
    'http://evil.example',
    'https://evil.example',
    'http://127.0.0.1.evil.example',
    'http://localhost:1234',
    'null',
  ]) {
    const res = await call(ctx, 'GET', '/api/health', { headers: { Origin: origin } });
    assert.equal(res.status, 403, `Origin ${origin} should have been refused`);
  }
});

test("the server's own Origin is accepted, and an absent one is too", async (t) => {
  const ctx = await startServer(t);
  for (const origin of [`http://127.0.0.1:${ctx.port}`, `http://localhost:${ctx.port}`]) {
    const res = await call(ctx, 'GET', '/api/health', { headers: { Origin: origin } });
    assert.equal(res.status, 200, `Origin ${origin} should have been accepted`);
  }
  assert.equal((await call(ctx, 'GET', '/api/health')).status, 200);
});

test('a foreign Origin is refused on static files as well as the API', async (t) => {
  const ctx = await startServer(t);
  const res = await fetch(`${ctx.base}/index.html`, { headers: { Origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
});

test('a rebound hostname in Host is refused', async (t) => {
  const ctx = await startServer(t);
  const raw = await rawRequest(ctx.port, 'GET /api/health HTTP/1.1', [
    'Host: attacker.example',
    `X-Zelos-Token: ${ctx.token}`,
  ]);
  assert.equal(statusOf(raw), 403);
  const ok = await rawRequest(ctx.port, 'GET /api/health HTTP/1.1', [
    `Host: 127.0.0.1:${ctx.port}`,
    `X-Zelos-Token: ${ctx.token}`,
  ]);
  assert.equal(statusOf(ok), 200);
});

test('no response carries a CORS header, ever', async (t) => {
  const ctx = await startServer(t);
  const responses = [
    await call(ctx, 'GET', '/api/health'),
    await call(ctx, 'GET', '/api/health', { token: null }),
    await call(ctx, 'GET', '/api/health', { headers: { Origin: 'http://evil.example' } }),
    await call(ctx, 'GET', '/index.html'),
    await call(ctx, 'GET', '/does-not-exist'),
    await call(ctx, 'OPTIONS', '/api/health'),
  ];
  for (const res of responses) {
    for (const name of res.headers.keys()) {
      assert.ok(!name.toLowerCase().startsWith('access-control-'), `leaked ${name}`);
    }
  }
});

test('the spec security headers are on every response', async (t) => {
  const ctx = await startServer(t);
  for (const route of ['/api/health', '/index.html', '/nope']) {
    const res = await call(ctx, 'GET', route);
    assert.equal(
      res.headers.get('content-security-policy'),
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
});

/* ================================================================== *
 * Static serving and path traversal
 * ================================================================== */

test('static files inside the web root are served', async (t) => {
  const ctx = await startServer(t);

  const index = await call(ctx, 'GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.text, /<title>board<\/title>/);

  const css = await call(ctx, 'GET', '/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const deep = await call(ctx, 'GET', '/sub/deep.txt');
  assert.equal(deep.status, 200);
  assert.equal(deep.text.trim(), 'deep');

  const asset = await call(ctx, 'GET', '/assets/icon.txt');
  assert.equal(asset.status, 200);
  assert.equal(asset.text.trim(), 'icon');
});

test('a matching ETag gets a 304', async (t) => {
  const ctx = await startServer(t);
  const first = await call(ctx, 'GET', '/index.html');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await call(ctx, 'GET', '/index.html', { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal(second.text, '');
});

test('path traversal fails in every encoding', async (t) => {
  const ctx = await startServer(t);

  const targets = [
    '/../outside/outside.txt',
    '/sub/../../outside/outside.txt',
    '/%2e%2e/outside/outside.txt',
    '/%2E%2E/outside/outside.txt',
    '/..%2foutside%2foutside.txt',
    '/%2e%2e%2foutside%2foutside.txt',
    '/%252e%252e/outside/outside.txt',
    '/..%5coutside%5coutside.txt',
    '/..\\outside\\outside.txt',
    '/....//outside/outside.txt',
    '/%c0%ae%c0%ae/outside/outside.txt',
    '/%uff0e%uff0e/outside/outside.txt',
    '/．．/outside/outside.txt',
    '/assets/../../outside/outside.txt',
    '/assets/%2e%2e/%2e%2e/outside/outside.txt',
    '/%00../outside/outside.txt',
    // The symlink is inside the root but its target is not.
    '/escape.txt',
  ];

  for (const target of targets) {
    // Raw sockets: a client library would normalise several of these away.
    const raw = await rawRequest(ctx.port, `GET ${target} HTTP/1.1`);
    const status = statusOf(raw);
    assert.ok(status === 404 || status === 400, `${target} answered ${status}`);
    assert.ok(!raw.includes(OUTSIDE_MARKER), `${target} leaked a file outside the web root`);
  }
});

test('a directory is not listed', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', '/sub');
  assert.equal(res.status, 404);
  assert.ok(!res.text.includes('deep.txt'));
});

test('static serving only answers GET and HEAD', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'POST', '/index.html', { body: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');

  const head = await call(ctx, 'HEAD', '/index.html');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

/* ================================================================== *
 * Secrets are write-only
 * ================================================================== */

test('no route returns a stored secret', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });

  const write = await call(ctx, 'POST', '/api/secrets', {
    body: { ref: 'model.default', value: SECRET_VALUE },
  });
  assert.equal(write.status, 200);
  assert.equal(write.json.ok, true);
  assert.ok(!write.text.includes(SECRET_VALUE));

  await call(ctx, 'POST', '/api/secrets', { body: { ref: 'mail.m_test', value: SECRET_VALUE } });
  t.after(async () => {
    await deleteSecret('model.default').catch(() => {});
    await deleteSecret('mail.m_test').catch(() => {});
  });

  const dead = await closedPort();
  // The two model probes name the mock upstream explicitly, and that is not
  // decoration. `PUT /api/config` merges over what is on DISK — not over the
  // config this server was handed — and then adopts the result, so the identity
  // patch above silently moves the model back to the packaged default,
  // `https://api.anthropic.com`. Left alone, the next two lines dialled
  // Anthropic for real and posted SECRET_VALUE to them on every run of the
  // suite. Both routes take an explicit target, so pin them to loopback.
  const target = `protocol=openai&baseUrl=${encodeURIComponent(upstream.baseUrl)}&keyRef=model.default`;
  const probes = [
    await call(ctx, 'GET', '/api/health'),
    await call(ctx, 'GET', '/api/state'),
    await call(ctx, 'GET', '/api/config'),
    await call(ctx, 'PUT', '/api/config', { body: { identity: { name: 'Nemo' } } }),
    await call(ctx, 'GET', '/api/model/presets'),
    await call(ctx, 'GET', `/api/model/list?${target}`),
    await call(ctx, 'POST', '/api/model/test', {
      body: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
    await call(ctx, 'GET', '/api/search?q=secret'),
    await call(ctx, 'POST', '/api/mail/test', {
      body: { host: '127.0.0.1', port: dead, secure: false, user: 'someone', keyRef: 'mail.m_test' },
    }),
  ];
  for (const probe of probes) {
    assert.ok(!probe.text.includes(SECRET_VALUE), `a route leaked the secret: ${probe.text.slice(0, 200)}`);
  }

  // There is no read route, by design: the only verbs those paths answer to
  // are the ones that write and the one that deletes.
  const collection = await call(ctx, 'GET', '/api/secrets');
  assert.equal(collection.status, 405);
  assert.deepEqual(collection.json.allowed, ['POST']);
  const one = await call(ctx, 'GET', '/api/secrets/model.default');
  assert.equal(one.status, 405);
  assert.deepEqual(one.json.allowed, ['DELETE']);

  // The config knows WHICH refs exist — never what is behind them.
  const cfg = await call(ctx, 'GET', '/api/config');
  assert.ok(cfg.json.secretRefs.includes('model.default'));
  assert.ok(!cfg.text.includes(SECRET_VALUE));
});

test('a credential-shaped field never reaches config.json or a response', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'PUT', '/api/config', {
    body: { identity: { name: 'Nemo' }, model: { apiKey: 'LEAKED-KEY-VALUE', password: 'LEAKED-PASS' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.config.identity.name, 'Nemo');
  assert.equal(res.json.config.model.apiKey, undefined);
  assert.ok(!res.text.includes('LEAKED-KEY-VALUE'));
  assert.ok(!fs.readFileSync(path.join(HOME, 'config.json'), 'utf8').includes('LEAKED-KEY-VALUE'));
});

test('DELETE /api/secrets/:ref removes it, and a bad ref is refused', async (t) => {
  const ctx = await startServer(t);
  await setSecret('model.doomed', SECRET_VALUE);
  const gone = await call(ctx, 'DELETE', '/api/secrets/model.doomed');
  assert.equal(gone.status, 200);
  assert.equal(gone.json.deleted, true);
  const listed = await call(ctx, 'GET', '/api/config');
  assert.ok(!listed.json.secretRefs.includes('model.doomed'));

  const bad = await call(ctx, 'DELETE', '/api/secrets/..');
  assert.ok(bad.status === 400 || bad.status === 404);
});

/* ================================================================== *
 * Request body cap
 * ================================================================== */

test('an oversized body is refused on Content-Length', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'POST', '/api/capture', { body: { text: 'x'.repeat(2 * 1024 * 1024) } });
  assert.equal(res.status, 413);
});

test('an oversized chunked body is refused while it streams', async (t) => {
  const ctx = await startServer(t);
  const answer = await new Promise((resolve, reject) => {
    const socket = net.connect(ctx.port, '127.0.0.1');
    let buf = '';
    socket.setTimeout(8_000, () => { socket.destroy(); reject(new Error('timed out')); });
    socket.on('connect', () => {
      socket.write([
        'POST /api/capture HTTP/1.1',
        `Host: 127.0.0.1:${ctx.port}`,
        `X-Zelos-Token: ${ctx.token}`,
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        '', '',
      ].join('\r\n'));
      const chunk = 'y'.repeat(65_536);
      // Deliberately never terminated: the server must not wait for the end.
      for (let i = 0; i < 48 && socket.writable; i++) {
        socket.write(`${(65_536).toString(16)}\r\n${chunk}\r\n`);
      }
    });
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      // The answer arrives while the upload is still going; there is no reason
      // to wait for a client that was never going to finish.
      if (buf.includes('\r\n\r\n')) { socket.destroy(); resolve(buf); }
    });
    socket.on('error', () => resolve(buf));
    socket.on('close', () => resolve(buf));
  });
  assert.equal(statusOf(answer), 413);
});

/* ================================================================== *
 * SSE
 * ================================================================== */

test('/api/sweep/stream frames are well formed from hello to done', async (t) => {
  const progress = [
    { phase: 'mail', message: 'fetching mail', done: 1, total: 3 },
    { phase: 'calendar', message: 'fetching events\nand invitations', done: 2, total: 3 },
    { phase: 'model', message: 'thinking', done: 3, total: 3 },
  ];
  const ctx = await startServer(t, {
    async runSweep({ onProgress, mode }) {
      for (const step of progress) {
        onProgress(step);
        await delay(2);
      }
      return { runId: 'run_test0001', ok: true, stats: { messages: 4, events: 1, items: 2, now: 1, mode } };
    },
  });

  const response = await fetch(`${ctx.base}/api/sweep/stream`, {
    headers: { 'X-Zelos-Token': ctx.token },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');

  const collected = [];
  const reading = readStream(response, (frame) => collected.push(frame), {
    until: (frame) => frame.startsWith('event: done'),
  });

  // Give the stream a moment to be subscribed before the sweep starts.
  await delay(30);
  const started = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'full' } });
  assert.equal(started.status, 202);
  assert.equal(started.json.started, true);

  await reading;

  // Framing: every frame is either a comment or `event:` + one or more `data:`.
  for (const frame of collected) {
    const lines = frame.split('\n');
    assert.ok(lines.length > 0);
    if (lines[0].startsWith(':')) {
      assert.ok(lines.every((l) => l.startsWith(':')), `mixed comment frame: ${frame}`);
      continue;
    }
    assert.match(lines[0], /^event: [a-z]+$/);
    assert.ok(lines.slice(1).every((l) => l.startsWith('data: ')), `bad data lines: ${frame}`);
  }

  const parsed = collected.map(parseFrame).filter((f) => f.event);
  assert.equal(parsed[0].event, 'hello');
  assert.equal(parsed[0].data.running, false);
  assert.equal(parsed[1].event, 'started');
  assert.equal(parsed[1].data.mode, 'full');

  const progressFrames = parsed.filter((f) => f.event === 'progress');
  assert.equal(progressFrames.length, 3);
  assert.deepEqual(progressFrames.map((f) => f.data.phase), ['mail', 'calendar', 'model']);
  // A payload containing a newline must survive the framing intact.
  assert.equal(progressFrames[1].data.message, 'fetching events\nand invitations');

  const done = parsed.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.ok, true);
  assert.equal(done.data.runId, 'run_test0001');
  assert.equal(done.data.stats.items, 2);
});

test('the stream sends heartbeats and survives the client walking away', async (t) => {
  let sweeps = 0;
  const ctx = await startServer(t, {
    heartbeatMs: 25,
    async runSweep({ onProgress }) {
      sweeps += 1;
      onProgress({ phase: 'mail', message: 'fetching', done: 1, total: 1 });
      await delay(40);
      return { runId: `run_${sweeps}`, ok: true, stats: {} };
    },
  });

  const controller = new AbortController();
  const response = await fetch(`${ctx.base}/api/sweep/stream`, {
    headers: { 'X-Zelos-Token': ctx.token },
    signal: controller.signal,
  });
  const frames = await readStream(response, null, { until: (f) => f === ': ping' });
  assert.ok(frames.includes(': ping'), 'expected a heartbeat comment frame');

  // Walk away mid-sweep: the server must clean up and carry on.
  await call(ctx, 'POST', '/api/sweep', { body: { mode: 'light' } });
  controller.abort();
  await delay(80);

  assert.equal((await call(ctx, 'GET', '/api/health')).status, 200);
  const second = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'light' } });
  assert.equal(second.status, 202);
  await delay(80);
  assert.equal(sweeps, 2);
});

test('two sweeps cannot run at once', async (t) => {
  const ctx = await startServer(t, {
    async runSweep() {
      await delay(120);
      return { runId: 'run_slow', ok: true, stats: {} };
    },
  });
  const first = await call(ctx, 'POST', '/api/sweep', { body: {} });
  assert.equal(first.status, 202);
  const second = await call(ctx, 'POST', '/api/sweep', { body: {} });
  assert.equal(second.status, 409);
  assert.equal(second.json.detail.running, true);
});

test('the real sweep engine is wired up and reports its run id', async (t) => {
  // No mail, no calendar, no model — a light run touches nothing off this
  // machine, which is exactly what makes it safe to run here.
  const ctx = await startServer(t);
  const response = await fetch(`${ctx.base}/api/sweep/stream`, {
    headers: { 'X-Zelos-Token': ctx.token },
  });
  const reading = readStream(response, null, { until: (f) => f.startsWith('event: done') || f.startsWith('event: failed') });
  await delay(30);

  const started = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'light' } });
  assert.equal(started.status, 202);
  assert.match(started.json.runId, /^run_[0-9a-f]+$/, 'the run id must come back with the 202');

  const frames = (await reading).map(parseFrame).filter((f) => f.event);
  const done = frames.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.runId, started.json.runId);

  const state = await call(ctx, 'GET', '/api/state');
  assert.equal(state.json.runs.last.id, started.json.runId);
  assert.equal(state.json.runs.last.kind, 'light');
});

test('a sweep is run through the scheduler when there is one', async (t) => {
  let busy = false;
  const asked = [];
  const scheduler = {
    status: () => ({ running: true, busy, runs: asked.length }),
    async runNow(mode) {
      asked.push(mode);
      return { runId: 'run_via_scheduler', ok: true, stats: { items: 0 } };
    },
  };
  const ctx = await startServer(t, {
    scheduler,
    runSweep: async () => assert.fail('the scheduler should have owned this sweep'),
  });

  const res = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'full' } });
  assert.equal(res.status, 202);
  await delay(20);
  assert.deepEqual(asked, ['full']);

  const health = await call(ctx, 'GET', '/api/health');
  assert.equal(health.json.scheduler.running, true);

  // A scheduled sweep already in flight is a reason to say no, not to start a second.
  busy = true;
  const clash = await call(ctx, 'POST', '/api/sweep', { body: {} });
  assert.equal(clash.status, 409);
  assert.deepEqual(asked, ['full']);
});

test('an unknown sweep mode is refused', async (t) => {
  const ctx = await startServer(t, { runSweep: async () => ({ runId: 'x', ok: true, stats: {} }) });
  const res = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'everything' } });
  assert.equal(res.status, 400);
});

/* ================================================================== *
 * /api/ask
 * ================================================================== */

test('/api/ask streams a grounded answer and names its sources', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });

  db.upsertMessage(ctx.db, {
    sourceId: 'm_1',
    uid: 7,
    messageId: '<budget@test>',
    from: { name: 'Ada', email: 'ada@example.com' },
    subject: 'Budget review on Tuesday',
    date: '2026-08-10T09:00:00-04:00',
    snippet: 'Can we do the budget review on Tuesday at 2?',
    text: 'Can we do the budget review on Tuesday at 2? — Ada',
    folder: 'INBOX',
  });

  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST',
    headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'When is the budget review?' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);

  const frames = (await readStream(response, null, { until: (f) => f.startsWith('event: done') }))
    .map(parseFrame)
    .filter((f) => f.event);

  const sources = frames.find((f) => f.event === 'sources');
  assert.ok(sources, 'expected a sources frame');
  assert.ok(sources.data.length >= 1);
  assert.equal(sources.data[0].kind, 'message');
  assert.match(sources.data[0].ref, /^msg:[0-9a-f]{16}$/);
  assert.match(sources.data[0].title, /Budget review/);

  const answer = frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join('');
  assert.equal(answer, 'Budget review is on Tuesday.');

  const done = frames.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.grounded, true);
  assert.equal(done.data.usage.input, 41);

  // What actually hit the socket: a streamed chat completion whose prompt
  // carries the mail quoted inside the untrusted-data fence.
  const sent = upstream.received.find((r) => r.url.startsWith('/chat/completions'));
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.model, 'mock-model');
  const prompt = sent.body.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /ZELOS-UNTRUSTED/);
  assert.match(prompt, /budget review on Tuesday/i);
  assert.match(prompt, /Question: When is the budget review\?/);
});

test('/api/ask says so plainly when nothing is indexed', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });
  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST',
    headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'anything at all' }),
  });
  const frames = (await readStream(response, null, { until: (f) => f.startsWith('event: done') }))
    .map(parseFrame)
    .filter((f) => f.event);
  assert.deepEqual(frames.find((f) => f.event === 'sources').data, []);
  assert.equal(frames.at(-1).data.grounded, false);
  // Nothing was asked of the model, because there was nothing to ground on.
  assert.equal(upstream.received.length, 0);
});

test('/api/ask refuses before streaming when no model is configured', async (t) => {
  const ctx = await startServer(t, {
    config: baseConfig({ model: { protocol: 'openai', baseUrl: 'https://api.example.com', model: '' } }),
  });
  const res = await call(ctx, 'POST', '/api/ask', { body: { question: 'hello?' } });
  assert.equal(res.status, 409);
  assert.match(res.headers.get('content-type'), /application\/json/);
});

/* ================================================================== *
 * Port selection
 * ================================================================== */

test('a busy port makes the server take the next free one', async (t) => {
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const busy = squatter.address().port;
  t.after(() => new Promise((r) => squatter.close(r)));

  const handle = db.open(':memory:');
  db.migrate(handle);
  const server = createServer({ db: handle, uiDir: UI_DIR, assetsDir: ASSETS_DIR });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close(handle);
  });

  const bound = await listen(server, { port: busy });
  assert.notEqual(bound.port, busy);
  assert.equal(bound.port, busy + 1);
  assert.equal(bound.url, `http://127.0.0.1:${bound.port}/`);
  assert.equal(bound.tokenUrl, `http://127.0.0.1:${bound.port}/?t=${server.sessionToken}`);
});

test('the server binds 127.0.0.1, not every interface', async (t) => {
  const ctx = await startServer(t);
  assert.equal(ctx.server.address().address, '127.0.0.1');
});

/* ================================================================== *
 * The board routes
 * ================================================================== */

test('/api/state returns the board', async (t) => {
  const ctx = await startServer(t);
  const runId = db.startRun(ctx.db, { kind: 'full' });
  const item = db.upsertItem(ctx.db, {
    key: 'reply-to-ada',
    bucket: 'now',
    headline: 'Reply to Ada about the budget review',
    why: 'She asked two days ago and has not heard back.',
    person: 'Ada',
    personEmail: 'ada@example.com',
    severity: 3,
  }, { runId });
  db.upsertEvent(ctx.db, {
    calendarId: 'c_1',
    uid: 'evt-1',
    title: 'Budget review',
    startsAt: '2026-08-11T14:00:00-04:00',
    endsAt: '2026-08-11T15:00:00-04:00',
  });
  // The keys core/triage.mjs writes: notes as JSON, first as an item row id.
  db.setKV(ctx.db, 'sweep.notes', JSON.stringify(['Two invoices are past due.']));
  db.setKV(ctx.db, 'sweep.first', item.id);
  db.finishRun(ctx.db, runId, { ok: true, stats: { items: 1 } });

  const res = await call(ctx, 'GET', '/api/state');
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 1);
  assert.equal(res.json.items[0].headline, 'Reply to Ada about the budget review');
  assert.equal(res.json.counts.now, 1);
  assert.equal(res.json.counts.today, 0);
  assert.deepEqual(res.json.notes, ['Two invoices are past due.']);
  assert.equal(res.json.first, res.json.items[0].id);

  // A `first` whose item is gone is cleared, not handed over as a dangling id.
  db.setKV(ctx.db, 'sweep.first', 'deadbeefdeadbeef');
  const stale = await call(ctx, 'GET', '/api/state');
  assert.equal(stale.json.first, null);
  assert.equal(res.json.runs.last.id, runId);
  assert.ok(Array.isArray(res.json.events));
});

test('an item state change is recorded, and an illegal one is refused', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertItem(ctx.db, { key: 'pay-the-invoice', bucket: 'money', headline: 'Pay the invoice' });

  const done = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'done' } });
  assert.equal(done.status, 200);
  assert.equal(done.json.state, 'done');

  const illegal = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'obliterated' } });
  assert.equal(illegal.status, 400);

  const missing = await call(ctx, 'POST', '/api/items/nosuchitem/state', { body: { state: 'done' } });
  assert.equal(missing.status, 404);
});

test('a capture is stored and immediately searchable', async (t) => {
  const ctx = await startServer(t);
  const made = await call(ctx, 'POST', '/api/capture', { body: { text: 'Ring the accountant about depreciation' } });
  assert.equal(made.status, 201);
  assert.match(made.json.id, /^cap_/);

  const found = await call(ctx, 'GET', '/api/search?q=accountant');
  assert.equal(found.status, 200);
  assert.equal(found.json.results.length, 1);
  assert.equal(found.json.results[0].ref, `cap:${made.json.id}`);

  const empty = await call(ctx, 'POST', '/api/capture', { body: { text: '   ' } });
  assert.equal(empty.status, 400);
});

test('a draft can be edited, and markup in one is refused', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertDraft(ctx.db, {
    itemId: 'i_1', to: 'ada@example.com', subject: 'Budget review', body: 'Tuesday works.',
  });

  const edited = await call(ctx, 'PUT', `/api/drafts/${id}`, {
    body: { body: 'Tuesday at 2 works for me.', state: 'edited' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.body, 'Tuesday at 2 works for me.');
  assert.equal(edited.json.state, 'edited');

  const hostile = await call(ctx, 'PUT', `/api/drafts/${id}`, {
    body: { body: 'Hi <script>fetch("http://evil.example")</script>' },
  });
  assert.equal(hostile.status, 400);

  const missing = await call(ctx, 'PUT', '/api/drafts/nope', { body: { body: 'hello' } });
  assert.equal(missing.status, 404);
});

test('config round-trips through GET and PUT', async (t) => {
  const ctx = await startServer(t);
  const before = await call(ctx, 'GET', '/api/config');
  assert.equal(before.status, 200);
  assert.ok(Array.isArray(before.json.errors));

  const after = await call(ctx, 'PUT', '/api/config', {
    body: { identity: { name: 'Nemo', email: 'nemo@example.com' }, ui: { theme: 'blackfigure' } },
  });
  assert.equal(after.json.config.identity.name, 'Nemo');
  assert.equal(after.json.config.ui.theme, 'blackfigure');

  // Saved even though it is incomplete, with the reasons attached — setup is
  // progressive, and a form you cannot save is a form you cannot come back to.
  const invalid = await call(ctx, 'PUT', '/api/config', { body: { sweep: { intervalMinutes: 1 } } });
  assert.equal(invalid.status, 200);
  assert.ok(invalid.json.errors.some((e) => e.path === 'sweep.intervalMinutes'));

  const bad = await call(ctx, 'PUT', '/api/config', { body: [] });
  assert.equal(bad.status, 400);
});

test('malformed JSON is a 400, not a 500', async (t) => {
  const ctx = await startServer(t);
  const res = await fetch(`${ctx.base}/api/capture`, {
    method: 'POST',
    headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: '{"text": ',
  });
  assert.equal(res.status, 400);
});

test('an unexpected failure is a 500 that says nothing about itself', async (t) => {
  const ctx = await startServer(t);
  db.close(ctx.db); // the database is gone; the next query cannot succeed
  const res = await call(ctx, 'GET', '/api/state');
  assert.equal(res.status, 500);
  assert.equal(res.json.error, 'internal error');
  assert.match(res.json.detail, /zelos\.log$/);
  // The server is still standing.
  assert.equal((await call(ctx, 'GET', '/api/model/presets')).status, 200);
});

test('the wrong method on a real route is a 405 with an Allow list', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'DELETE', '/api/state');
  assert.equal(res.status, 405);
  assert.deepEqual(res.json.allowed, ['GET']);
});

/* ================================================================== *
 * Setup routes
 * ================================================================== */

test('/api/health reports what is and is not set up', async (t) => {
  const upstream = await startMockUpstream(t);
  const bare = await startServer(t);
  const bareHealth = await call(bare, 'GET', '/api/health');
  assert.equal(bareHealth.json.model.configured, false);
  assert.equal(bareHealth.json.home, HOME);
  assert.equal(bareHealth.json.backend.name, 'encrypted-file');
  assert.ok(bareHealth.json.backend.note.length > 40);

  const wired = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });
  const wiredHealth = await call(wired, 'GET', '/api/health');
  // A local endpoint needs no key, so it counts as configured on its own.
  assert.equal(wiredHealth.json.model.configured, true);
  assert.equal(wiredHealth.json.model.local, true);
});

test('/api/model/test and /api/model/list talk to the configured endpoint', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });

  const tested = await call(ctx, 'POST', '/api/model/test', { body: {} });
  assert.equal(tested.status, 200);
  assert.equal(tested.json.ok, true);
  assert.equal(tested.json.sample, 'ready');
  assert.ok(tested.json.ms >= 0);

  const listed = await call(ctx, 'GET', '/api/model/list');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.map((m) => m.id), ['mock-model', 'mock-model-mini']);

  const chat = upstream.received.find((r) => r.url.startsWith('/chat/completions'));
  assert.equal(chat.headers.authorization, undefined, 'a keyless local endpoint gets no Authorization header');
});

test('a model that is not answering produces a readable failure, not a 500', async (t) => {
  const dead = await closedPort();
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: `http://127.0.0.1:${dead}`, model: 'mock-model', keyRef: 'model.default' },
    }),
  });
  const res = await call(ctx, 'POST', '/api/model/test', { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, new RegExp(String(dead)), 'the error must name the address that failed');
});

test('/api/model/presets covers the providers a user might pick', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', '/api/model/presets');
  assert.equal(res.status, 200);
  const ids = res.json.map((p) => p.id);
  for (const wanted of ['anthropic', 'openai', 'ollama', 'lmstudio']) {
    assert.ok(ids.includes(wanted), `missing preset ${wanted}`);
  }
  assert.ok(res.json.every((p) => p.protocol === 'openai' || p.protocol === 'anthropic'));
});

test('/api/mail/test needs the password to have been stored first', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'POST', '/api/mail/test', {
    body: { host: 'imap.example.com', port: 993, secure: true, user: 'nemo', keyRef: 'mail.m_absent' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /POST \/api\/secrets/);
});

test('/api/calendar/test reads an ics feed and refuses a dangerous url', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t);

  const ok = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'ics', url: `${upstream.baseUrl}/calendar.ics` },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.calendars[0].name, 'Mock Calendar');
  assert.equal(ok.json.events, 1);

  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>']) {
    const refused = await call(ctx, 'POST', '/api/calendar/test', { body: { kind: 'ics', url } });
    assert.equal(refused.status, 400, `${url} should have been refused`);
  }

  const missing = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'file', url: path.join(STATIC_ROOT, 'no-such-calendar.ics') },
  });
  assert.equal(missing.status, 200);
  assert.equal(missing.json.ok, false);
});

/* ================================================================== *
 * Cleanup
 * ================================================================== */

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(STATIC_ROOT, { recursive: true, force: true });
});
