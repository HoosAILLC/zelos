/** Private Serve access: real loopback requests, synthetic data, no cloud calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-serve-test-'));
process.env.ZELOS_HOME = TEST_HOME;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
delete process.env.ZELOS_TAILSCALE_ORIGIN;
delete process.env.ZELOS_TAILSCALE_LOGIN;

const { createServer, listen, normalizeTrustedServe } = await import('../core/server.mjs');
const { trustedServeFromEnv } = await import('../zelos.mjs');
const database = await import('../core/db.mjs');
const { loadConfig } = await import('../core/config.mjs');
const ORIGIN = 'https://spark.owner-tailnet.ts.net';
const LOGIN = 'owner@example.test';
const TRUST = { origin: ORIGIN, login: LOGIN };
const REMOTE_HEADERS = { Host: new URL(ORIGIN).host, 'Tailscale-User-Login': LOGIN };
const ROOT = fileURLToPath(new URL('../', import.meta.url));

test.after(() => fs.rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

async function fixture(t, { trustedServe = TRUST, peer, config, logger } = {}) {
  const handle = database.open(':memory:');
  database.migrate(handle);
  const server = createServer({ db: handle, config: config ?? loadConfig(), trustedServe, ...(logger ? { logger } : {}) });
  // Exercise the actual request gate with a non-loopback peer without opening
  // a listening socket on the LAN. Only this test controls the socket metadata.
  if (peer) server.prependListener('request', (req) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true });
  });
  const { port } = await listen(server, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.close(handle);
  });
  return { server, port, db: handle, token: server.sessionToken };
}

function request(ctx, method, route, { remote = true, token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { ...(remote ? REMOTE_HEADERS : { Host: `127.0.0.1:${ctx.port}` }), ...headers };
    for (const key of Object.keys(sent)) if (sent[key] === undefined) delete sent[key];
    if (token !== undefined) sent['X-Zelos-Token'] = token;
    const contents = body === undefined ? null : JSON.stringify(body);
    if (contents !== null) {
      sent['Content-Type'] = 'application/json';
      sent['Content-Length'] = Buffer.byteLength(contents);
    }
    const req = http.request({ host: '127.0.0.1', port: ctx.port, path: route, method, headers: sent }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { text += part; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { /* Static pages and redirects are not JSON. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error('test request timed out')));
    req.on('error', reject);
    req.end(contents);
  });
}

test('private access is opt-in and deployment settings fail closed', () => {
  assert.equal(normalizeTrustedServe(null), null);
  assert.equal(trustedServeFromEnv({}), null);
  assert.deepEqual(trustedServeFromEnv({ ZELOS_TAILSCALE_ORIGIN: ORIGIN, ZELOS_TAILSCALE_LOGIN: LOGIN }), TRUST);
  assert.deepEqual(normalizeTrustedServe(TRUST), { ...TRUST, host: new URL(ORIGIN).host });
  for (const env of [
    { ZELOS_TAILSCALE_ORIGIN: ORIGIN },
    { ZELOS_TAILSCALE_LOGIN: LOGIN },
    { ZELOS_TAILSCALE_ORIGIN: '', ZELOS_TAILSCALE_LOGIN: LOGIN },
    { ZELOS_TAILSCALE_ORIGIN: ORIGIN, ZELOS_TAILSCALE_LOGIN: '' },
  ]) assert.throws(() => trustedServeFromEnv(env), /Set both/);
  for (const origin of [
    'http://spark.owner-tailnet.ts.net', 'https://example.test', 'https://ts.net',
    'https://spark.owner-tailnet.ts.net.evil.test', 'https://*.owner-tailnet.ts.net',
    `${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}?t=secret`, `${ORIGIN}#fragment`,
    'https://someone@spark.owner-tailnet.ts.net', ` ${ORIGIN}`, 'not a URL',
  ]) assert.throws(() => normalizeTrustedServe({ origin, login: LOGIN }), /canonical HTTPS/);
  for (const login of ['', `${LOGIN},other@example.test`, ' owner@example.test', 'owner\n@example.test', null]) {
    assert.throws(() => normalizeTrustedServe({ origin: ORIGIN, login }), /exact login/);
  }
  assert.throws(() => normalizeTrustedServe({ origin: ORIGIN }), /exact login/);
  assert.throws(() => normalizeTrustedServe({ login: LOGIN }), /exact login/);
  assert.throws(() => normalizeTrustedServe({ ...TRUST, allowAll: true }), /exact login/);
});

test('remote identity and exact host gate every route even with a valid session token', async (t) => {
  const ctx = await fixture(t);
  const routes = ['/open', '/', '/ui-never-needed', '/api/health', '/api/mcp', '/h/fake'];
  for (const headers of [
    { 'Tailscale-User-Login': undefined },
    { 'Tailscale-User-Login': 'someone-else@example.test' },
    { 'Tailscale-User-Login': `${LOGIN},other@example.test` },
    { Host: 'other.owner-tailnet.ts.net' },
    { Host: 'spark.owner-tailnet.ts.net.evil.test' },
    { Host: 'attacker.test', 'X-Forwarded-Host': new URL(ORIGIN).host },
    { Host: `attacker.test@${new URL(ORIGIN).host}` },
  ]) {
    for (const route of routes) {
      assert.equal((await request(ctx, 'GET', route, { token: ctx.token, headers })).status, 403, route);
    }
  }
});

test('spoofed identity on a non-loopback peer never reaches a private route', async (t) => {
  const ctx = await fixture(t, { peer: '192.168.1.77' });
  for (const route of ['/open', '/', '/api/health']) {
    assert.equal((await request(ctx, 'GET', route, { token: ctx.token })).status, 403);
    assert.equal((await request(ctx, 'GET', route, { token: ctx.token, remote: false })).status, 403);
  }
});

test('proxy identity or forwarding headers cannot bypass the owner gate with a forged loopback Host', async (t) => {
  const ctx = await fixture(t);
  for (const headers of [
    { 'Tailscale-User-Login': LOGIN },
    { 'Tailscale-User-Login': 'other@example.test' },
    { 'X-Forwarded-For': '100.64.0.7' },
    { 'X-Forwarded-Host': new URL(ORIGIN).host },
    { 'X-Forwarded-Proto': 'https' },
    { 'Tailscale-App-Capabilities': '{}' },
  ]) {
    for (const route of ['/open', '/', '/api/health']) {
      assert.equal((await request(ctx, 'GET', route, { remote: false, token: ctx.token, headers })).status, 403);
    }
  }
});

test('foreign, null, empty and alternate local Origins are denied before bootstrap and API', async (t) => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args), info() {}, debug() {}, error() {} };
  const ctx = await fixture(t, { logger });
  const secretMarker = 'request-token-must-not-be-logged';
  for (const origin of [
    'https://other.owner-tailnet.ts.net', 'https://evil.test', 'null', '',
    `http://127.0.0.1:${ctx.port}`, `${ORIGIN}/`, `${ORIGIN}:444`,
    `https://evil.test/?t=${secretMarker}`,
  ]) {
    for (const route of ['/open', '/', '/api/health']) {
      assert.equal((await request(ctx, 'GET', route, { token: ctx.token, headers: { Origin: origin } })).status, 403);
    }
  }
  assert.ok(warnings.length);
  assert.ok(!JSON.stringify(warnings).includes(secretMarker));
});

test('authenticated bootstrap uses single-use handoff; read and write APIs still require the session token', async (t) => {
  const ctx = await fixture(t);
  const entry = await request(ctx, 'GET', '/open');
  assert.equal(entry.status, 302);
  assert.match(entry.headers.location, /^\/h\/[a-f0-9]{64}$/);
  assert.equal(entry.headers['cache-control'], 'no-store');
  assert.equal(entry.headers['referrer-policy'], 'no-referrer');
  assert.ok(!entry.headers.location.includes(ctx.token));
  const handoff = await request(ctx, 'GET', entry.headers.location);
  assert.equal(handoff.status, 302);
  const token = new URL(handoff.headers.location, ORIGIN).searchParams.get('t');
  assert.equal(token, ctx.token);
  assert.equal((await request(ctx, 'GET', entry.headers.location)).status, 404);
  assert.equal((await request(ctx, 'POST', '/open', { headers: { Origin: ORIGIN } })).status, 405);
  for (const route of ['/api/health', `/api/health?t=${token}`]) {
    assert.equal((await request(ctx, 'GET', route)).status, 401);
  }
  assert.equal((await request(ctx, 'GET', '/api/health', { token })).status, 200);
  const write = { body: { text: 'Synthetic private Serve capture' }, headers: { Origin: ORIGIN } };
  assert.equal((await request(ctx, 'POST', '/api/capture', write)).status, 401);
  assert.equal((await request(ctx, 'POST', '/api/capture', { ...write, token: 'f'.repeat(64) })).status, 401);
  const saved = await request(ctx, 'POST', '/api/capture', { ...write, token });
  assert.equal(saved.status, 201);
  assert.equal(database.listCaptures(ctx.db).length, 1);
  assert.equal(saved.headers['access-control-allow-origin'], undefined);
  // Removing the proxy identity remains forbidden even after a valid handoff.
  assert.equal((await request(ctx, 'GET', '/api/health', {
    token, headers: { 'Tailscale-User-Login': undefined },
  })).status, 403);
});

test('fresh private root bootstraps home-screen launches and still requires an API token', async (t) => {
  const ctx = await fixture(t);
  const handoffs = new Set();
  for (const route of ['/', '/?t=', '/?view=board']) {
    const entry = await request(ctx, 'GET', route);
    assert.equal(entry.status, 302);
    assert.match(entry.headers.location, /^\/h\/[a-f0-9]{64}$/);
    assert.equal(entry.headers['cache-control'], 'no-store');
    assert.equal(entry.headers['referrer-policy'], 'no-referrer');
    assert.ok(!handoffs.has(entry.headers.location));
    handoffs.add(entry.headers.location);
    const handoff = await request(ctx, 'GET', entry.headers.location);
    assert.equal(handoff.status, 302);
    assert.equal(new URL(handoff.headers.location, ORIGIN).searchParams.get('t'), ctx.token);
    const page = await request(ctx, 'GET', handoff.headers.location);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /<!doctype html>/i);
    assert.equal((await request(ctx, 'GET', entry.headers.location)).status, 404);
  }
  // The root query is only handed to the browser; it never authenticates APIs.
  assert.equal((await request(ctx, 'GET', `/api/health?t=${ctx.token}`)).status, 401);
  assert.equal((await request(ctx, 'GET', '/api/health', { token: ctx.token })).status, 200);
  const write = { body: { text: 'Synthetic home-screen capture' }, headers: { Origin: ORIGIN } };
  assert.equal((await request(ctx, 'POST', '/api/capture', write)).status, 401);
  assert.equal((await request(ctx, 'POST', '/api/capture', { ...write, token: ctx.token })).status, 201);
  assert.equal((await request(ctx, 'GET', '/', {
    headers: { 'Tailscale-User-Login': 'someone-else@example.test' },
  })).status, 403);
});

test('session rotation and the separate MCP switch and bearer token remain enforced', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  assert.notEqual(first.token, second.token);
  assert.equal((await request(second, 'GET', '/api/health', { token: first.token })).status, 401);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await request(first, 'POST', '/api/mcp', { token: first.token, body })).status, 403);
  const cfg = loadConfig();
  const enabled = await fixture(t, { config: { ...cfg, ai: { enabled: true, tokens: [] } } });
  assert.equal((await request(enabled, 'POST', '/api/mcp', { token: enabled.token, body })).status, 401);
  assert.equal((await request(enabled, 'POST', '/api/mcp', {
    body, headers: { Authorization: `Bearer ${enabled.token}` },
  })).status, 401);
});

test('localhost behavior is unchanged and cannot use the private bootstrap', async (t) => {
  for (const trustedServe of [null, TRUST]) {
    const ctx = await fixture(t, { trustedServe });
    assert.equal((await request(ctx, 'GET', '/', { remote: false })).status, 200);
    assert.equal((await request(ctx, 'GET', '/api/health', { remote: false })).status, 401);
    assert.equal((await request(ctx, 'GET', '/api/health', {
      remote: false, token: ctx.token, headers: { Origin: `http://127.0.0.1:${ctx.port}` },
    })).status, 200);
    assert.equal((await request(ctx, 'GET', '/api/health', {
      remote: false, token: ctx.token, headers: { Origin: ORIGIN, 'Tailscale-User-Login': LOGIN },
    })).status, 403);
    assert.equal((await request(ctx, 'GET', '/open', {
      remote: false, headers: { 'Tailscale-User-Login': LOGIN, 'X-Forwarded-Host': new URL(ORIGIN).host },
    })).status, 403);
    const localHandoff = ctx.server.zelos.mintHandoff();
    assert.equal((await request(ctx, 'GET', localHandoff, { remote: false })).status, 302);
    if (!trustedServe) assert.equal((await request(ctx, 'GET', '/open')).status, 403);
  }
});

function cli(t, extraEnv) {
  const cliHome = fs.mkdtempSync(path.join(TEST_HOME, 'cli-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'zelos.mjs'), '--no-open', '--port', '0', '--home', cliHome], {
    cwd: ROOT,
    env: { ...process.env, ZELOS_HOME: cliHome, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (part) => { stdout += part; });
  child.stderr.on('data', (part) => { stderr += part; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; });
  return { child, closed, cliHome, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('CLI rejects partial or malformed private deployment settings instead of starting', async (t) => {
  for (const env of [
    { ZELOS_TAILSCALE_ORIGIN: ORIGIN },
    { ZELOS_TAILSCALE_LOGIN: LOGIN },
    { ZELOS_TAILSCALE_ORIGIN: 'https://evil.test', ZELOS_TAILSCALE_LOGIN: LOGIN },
  ]) {
    const run = cli(t, env);
    assert.equal(await run.closed, 1);
    assert.ok(!run.stdout.includes('Open'));
    assert.match(run.stderr, /Tailscale|TAILSCALE/);
  }
});

test('CLI wires the private settings and prints a stable entry URL without a session token', async (t) => {
  const run = cli(t, { ZELOS_TAILSCALE_ORIGIN: ORIGIN, ZELOS_TAILSCALE_LOGIN: LOGIN });
  const started = Date.now();
  while (!run.stdout.includes(`${ORIGIN}/open`)) {
    if (run.child.exitCode !== null) assert.fail(run.stderr || 'CLI exited before startup');
    if (Date.now() - started > 10_000) assert.fail('CLI did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { port } = JSON.parse(fs.readFileSync(path.join(run.cliHome, 'zelos.lock'), 'utf8'));
  const entry = await request({ port }, 'GET', '/open');
  assert.equal(entry.status, 302);
  assert.ok(!run.stdout.includes('?t='));
  assert.ok(!/[a-f0-9]{64}/.test(run.stdout));
  run.child.kill('SIGTERM');
  const code = await run.closed;
  // Windows terminates the process instead of delivering the POSIX signal to
  // Zelos's shutdown handler. Startup and private access above run on every OS;
  // verify the actual termination outcome without expecting that handler there.
  if (process.platform === 'win32') {
    assert.equal(code, null);
    assert.equal(run.child.signalCode, 'SIGTERM');
  } else {
    assert.equal(code, 0);
    assert.equal(run.child.signalCode, null);
  }
});
