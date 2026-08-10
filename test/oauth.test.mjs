/**
 * test/oauth.test.mjs — the PKCE loopback flow, driven end to end.
 *
 * Nothing here touches a third party. The "authorization server" is a
 * `node:http` server this file starts on 127.0.0.1:0, and `globalThis.fetch` is
 * wrapped for the whole run so that a call to any non-loopback host throws
 * rather than leaving the machine — if a future edit forgets to pass an explicit
 * endpoint and falls back to Google's, this suite says so instead of dialling it.
 *
 * The mock does the two things a real authorization server does that matter
 * here: it hands back a code bound to the `state` it was given, and it *verifies
 * the PKCE challenge* on the token call. So the challenge derivation is proved
 * against an independent SHA-256 of the verifier, not against itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-oauth-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');
/* Never the operator's real keychain. */
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';

/* ------------------------------------------------------- outbound guard */

const realFetch = globalThis.fetch;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  const url = new URL(raw);
  if (!LOOPBACK.test(url.hostname)) {
    throw new Error(`this suite must not contact ${url.host} — every endpoint has to be a local mock`);
  }
  return realFetch(input, init);
};

const oauth = await import('../core/sources/oauth.mjs');
const {
  OAuthError, PROVIDERS, PROVIDER_IDS, NOT_WIRED, providerFor, describeProvider,
  OAUTH_DEFAULTS, oauthSettings, isConfigured, inertNote, tokenRef,
  CODE_CHALLENGE_METHOD, createVerifier, challengeFor, createState, statesMatch,
  assertScopes, buildAuthUrl, assertOpenable,
  startLoopbackReceiver, exchangeCode, refreshTokens,
  saveTokens, loadTokens, forgetTokens, tokensExpired,
  beginAuthorization, finishAuthorization, authorize, accessTokenFor,
} = oauth;

const { getSecret } = await import('../core/secrets.mjs');

test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------ the mock server */

/**
 * A minimal authorization server.
 *
 *   GET  /authorize  records the request, then 302s back to `redirect_uri`
 *                    with a fresh code bound to the state it was handed.
 *   POST /token      verifies PKCE (or the refresh token) and answers.
 *
 * `seen` is every request it received, so a test can assert on what actually
 * hit the socket rather than on what the client says it sent.
 */
function startAuthServer({
  refreshEcho = false,
  expiresIn = 3600,
  failWith = null,
  malformed = false,
} = {}) {
  const seen = [];
  const byCode = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams.entries());
      seen.push({ kind: 'authorize', query: q });
      const code = `code_${crypto.randomBytes(6).toString('hex')}`;
      byCode.set(code, {
        challenge: q.code_challenge,
        method: q.code_challenge_method,
        redirectUri: q.redirect_uri,
        scope: q.scope,
      });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.state);
      res.writeHead(302, { Location: back.toString(), 'Content-Length': 0 });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(body).entries());
        seen.push({ kind: 'token', form, headers: { ...req.headers } });

        const send = (status, payload) => {
          const text = JSON.stringify(payload);
          res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
          res.end(text);
        };

        if (failWith) { send(failWith.status, failWith.body); return; }
        if (malformed) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('not json at all');
          return;
        }

        if (form.grant_type === 'authorization_code') {
          const record = byCode.get(form.code);
          if (!record) { send(400, { error: 'invalid_grant', error_description: 'unknown code' }); return; }
          // The independent check: SHA-256 of the verifier must equal the
          // challenge that arrived on the /authorize leg.
          const derived = crypto.createHash('sha256').update(String(form.code_verifier), 'ascii').digest('base64url');
          if (record.method !== 'S256' || derived !== record.challenge) {
            send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            return;
          }
          if (record.redirectUri !== form.redirect_uri) {
            send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
            return;
          }
          send(200, {
            access_token: 'at_first',
            refresh_token: 'rt_first',
            token_type: 'Bearer',
            expires_in: expiresIn,
            scope: record.scope,
          });
          return;
        }

        if (form.grant_type === 'refresh_token') {
          if (form.refresh_token !== 'rt_first') {
            send(400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
            return;
          }
          const payload = {
            access_token: 'at_second',
            token_type: 'Bearer',
            expires_in: expiresIn,
          };
          // Google omits the refresh token on a refresh; Microsoft rotates it.
          if (refreshEcho) payload.refresh_token = 'rt_second';
          send(200, payload);
          return;
        }

        send(400, { error: 'unsupported_grant_type' });
      });
      return;
    }

    res.writeHead(404, { 'Content-Length': 0 });
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        seen,
        port,
        authorizeUrl: `http://127.0.0.1:${port}/authorize`,
        tokenUrl: `http://127.0.0.1:${port}/token`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/* ================================================================== *
 * PKCE
 * ================================================================== */

test('challengeFor matches the RFC 7636 Appendix B test vector', () => {
  // The published vector. If this drifts, every real provider rejects the code.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(challengeFor(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(CODE_CHALLENGE_METHOD, 'S256');
});

test('challengeFor is base64url SHA-256 with no padding, for any legal verifier', () => {
  for (let i = 0; i < 20; i += 1) {
    const v = createVerifier();
    const expected = crypto.createHash('sha256').update(v, 'ascii').digest('base64url');
    assert.equal(challengeFor(v), expected);
    assert.ok(!challengeFor(v).includes('='), 'a padded challenge is rejected by providers');
    assert.match(challengeFor(v), /^[A-Za-z0-9_-]{43}$/);
  }
});

test('createVerifier is 43+ unreserved characters and never repeats', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const v = createVerifier();
    assert.match(v, /^[A-Za-z0-9\-._~]{43,128}$/);
    assert.ok(!seen.has(v), 'verifiers must not repeat');
    seen.add(v);
  }
  assert.equal(createVerifier(64).length, 86);
  assert.throws(() => createVerifier(8), /32–96 bytes/);
});

test('a verifier outside the legal charset or length is refused, not hashed anyway', () => {
  for (const bad of ['', 'short', 'a'.repeat(129), `${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`, null, undefined, 42]) {
    assert.throws(() => challengeFor(bad), TypeError, String(bad));
  }
});

test('state is 256 bits of randomness and compares in constant time', () => {
  const a = createState();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(statesMatch(a, a));
  assert.ok(!statesMatch(a, createState()));
  assert.ok(!statesMatch(a, `${a}x`), 'a longer string must not match');
  assert.ok(!statesMatch(a, a.slice(0, -1)));
  assert.ok(!statesMatch('', ''), 'an empty state is never a match');
  assert.ok(!statesMatch(a, null));
  assert.ok(!statesMatch(undefined, undefined));
});

/* ================================================================== *
 * Providers and scopes
 * ================================================================== */

test('exactly two providers are wired, both calendar, both https', () => {
  assert.deepEqual(PROVIDER_IDS, ['google', 'microsoft']);
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    assert.equal(new URL(p.authorizeUrl).protocol, 'https:');
    assert.equal(new URL(p.tokenUrl).protocol, 'https:');
    assert.equal(p.loopbackHost, '127.0.0.1', 'RFC 8252 loopback, never 0.0.0.0');
    assert.ok(p.defaultScopes.length > 0);
    for (const s of p.defaultScopes) assert.ok(p.allowedScopes.includes(s));
  }
});

test('Gmail is not wired and cannot be asked for', () => {
  assert.equal(providerFor('gmail'), null);
  assert.ok(NOT_WIRED.gmail.includes('restricted'));
  assert.ok(NOT_WIRED.gmail.includes('IMAP'));

  // Not merely absent from the defaults — absent from the allowlist, so the
  // scope check throws rather than quietly widening the consent screen.
  for (const scope of [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://mail.google.com/',
  ]) {
    assert.throws(() => assertScopes('google', [scope]), (err) => err.code === 'bad_scope', scope);
  }
  for (const scope of ['Mail.Read', 'Mail.Send', 'mail.readwrite']) {
    assert.throws(() => assertScopes('microsoft', [scope]), (err) => err.code === 'bad_scope', scope);
  }

  // No mail scope is spelled anywhere in the module — not in an allowlist, not
  // in a default, not commented out ready to be uncommented.
  // "email" is an identity claim and stays; anything that reads as a mailbox
  // scope — gmail.*, //mail.*, Mail.Read — must not appear on any allowlist.
  const mailish = /gmail|(^|[./])mail\b/i;
  for (const id of PROVIDER_IDS) {
    for (const scope of PROVIDERS[id].allowedScopes) {
      assert.ok(!mailish.test(scope), `${id} allows a mail scope: ${scope}`);
    }
  }
  const src = fs.readFileSync(new URL('../core/sources/oauth.mjs', import.meta.url), 'utf8');
  const mailScope = /googleapis\.com\/auth\/gmail|mail\.google\.com|['"]Mail\.(Read|Send|ReadWrite)/i;
  for (const line of src.split('\n')) {
    assert.ok(!mailScope.test(line), `a mail scope leaked into the code: ${line.trim()}`);
  }
});

test('a calendar WRITE scope is refused too — this surface is read-only', () => {
  for (const scope of [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ]) {
    assert.throws(() => assertScopes('google', [scope]), (err) => err.code === 'bad_scope', scope);
  }
  assert.throws(() => assertScopes('microsoft', ['Calendars.ReadWrite']), (err) => err.code === 'bad_scope');
});

test('assertScopes normalises spelling, splits space-joined strings and de-duplicates', () => {
  assert.deepEqual(assertScopes('microsoft', ['offline_access Calendars.Read']), ['offline_access', 'Calendars.Read']);
  assert.deepEqual(assertScopes('microsoft', ['calendars.read', 'Calendars.Read']), ['Calendars.Read']);
  assert.throws(() => assertScopes('google', []), (err) => err.code === 'bad_scope');
});

test('an unknown provider is an error, not a silent default', () => {
  assert.throws(() => describeProvider('apple'), (err) => err instanceof OAuthError && err.code === 'unknown_provider');
  assert.throws(() => oauthSettings({}, ''), (err) => err.code === 'unknown_provider');
});

/* ================================================================== *
 * Inert by default
 * ================================================================== */

test('with no oauth block at all, both providers read as blank and disabled', () => {
  for (const cfg of [{}, { oauth: {} }, { oauth: { google: {} } }, null]) {
    for (const id of PROVIDER_IDS) {
      const s = oauthSettings(cfg, id);
      assert.equal(s.clientId, '');
      assert.equal(s.enabled, false);
      assert.equal(s.configured, false);
      assert.equal(isConfigured(cfg, id), false);
      assert.match(inertNote(cfg, id), /built but inert/);
    }
  }
  assert.equal(OAUTH_DEFAULTS.google.clientId, '');
  assert.equal(OAUTH_DEFAULTS.microsoft.clientId, '');
  assert.equal(OAUTH_DEFAULTS.google.enabled, false);
  assert.equal(OAUTH_DEFAULTS.microsoft.enabled, false);
});

test('a client id without the switch is still honest about being off', () => {
  const cfg = { oauth: { google: { clientId: 'cid.apps.example', enabled: false } } };
  assert.equal(isConfigured(cfg, 'google'), true);
  assert.match(inertNote(cfg, 'google'), /switched off/);
  assert.equal(inertNote({ oauth: { google: { clientId: 'cid.apps.example', enabled: true } } }, 'google'), null);
});

test('nothing dials out while inert — not authorize, not accessTokenFor', async () => {
  const never = () => { throw new Error('a network call was made while inert'); };
  await assert.rejects(
    () => authorize({ config: {}, providerId: 'google', fetchImpl: never, openUrl: never }),
    (err) => err instanceof OAuthError && err.code === 'not_configured',
  );
  await assert.rejects(
    () => accessTokenFor({ config: {}, providerId: 'microsoft', fetchImpl: never }),
    (err) => err.code === 'not_configured',
  );
  assert.throws(
    () => buildAuthUrl({ provider: 'google', clientId: '  ', redirectUri: 'http://127.0.0.1:1/x', state: 's', challenge: 'c' }),
    (err) => err.code === 'not_configured',
  );
});

/* ================================================================== *
 * The authorization URL
 * ================================================================== */

test('buildAuthUrl carries the full PKCE request and no client secret', () => {
  const verifier = createVerifier();
  const state = createState();
  const url = new URL(buildAuthUrl({
    provider: 'google',
    clientId: 'cid.apps.example',
    redirectUri: 'http://127.0.0.1:53311/oauth/google',
    state,
    challenge: challengeFor(verifier),
    // A caller trying to sneak a secret in: dropped, not forwarded.
    extra: { client_secret: 'nope', include_granted_scopes: 'true' },
  }));

  assert.equal(url.origin + url.pathname, PROVIDERS.google.authorizeUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid.apps.example');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:53311/oauth/google');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.readonly');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('code_challenge'), challengeFor(verifier));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline', 'without this Google never issues a refresh token');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.ok(!url.toString().includes('nope'));

  // The verifier itself must never ride on the front-channel URL.
  assert.ok(!url.toString().includes(verifier));
});

test('buildAuthUrl for Microsoft asks for offline_access, which is how a refresh token appears', () => {
  const url = new URL(buildAuthUrl({
    provider: 'microsoft',
    clientId: 'entra-client-id',
    redirectUri: 'http://127.0.0.1:41111/oauth/microsoft',
    state: createState(),
    challenge: challengeFor(createVerifier()),
  }));
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['offline_access', 'Calendars.Read']);
  assert.equal(url.searchParams.get('response_mode'), 'query');
});

test('this module opens nothing itself, and vets what it hands to whoever does', () => {
  // Spawning is confined to core/secrets.mjs and zelos.mjs; test/security.test.mjs
  // holds that line, and this is the local half of the same claim.
  const src = fs.readFileSync(new URL('../core/sources/oauth.mjs', import.meta.url), 'utf8');
  assert.ok(!/child_process/.test(src), 'oauth.mjs must not be able to run a program');

  const good = buildAuthUrl({
    provider: 'google',
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:1/oauth/google',
    state: createState(),
    challenge: challengeFor(createVerifier()),
  });
  assert.equal(assertOpenable(good), good);

  for (const bad of [
    'http://accounts.google.com/o/oauth2/v2/auth',   // downgraded to http
    'https://accounts.google.com.evil.example/x',    // a lookalike host
    'https://127.0.0.1/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.throws(() => assertOpenable(bad), (err) => err.code === 'bad_endpoint', bad);
  }
  // …unless the caller named the origin itself, which is how a mock is driven.
  assert.ok(assertOpenable('http://127.0.0.1:9/authorize?x=1', { extraOrigins: ['http://127.0.0.1:9/authorize'] }));
});

test('authorize refuses to run without an opener rather than picking one', async () => {
  await assert.rejects(
    () => authorize({ providerId: 'google', clientId: 'cid' }),
    (err) => err instanceof TypeError && /openUrl/.test(err.message),
  );
});

/* ================================================================== *
 * The loopback receiver
 * ================================================================== */

/** Fetch a loopback URL without following redirects. */
const get = (url) => fetch(url, { redirect: 'manual' });

test('the receiver binds an ephemeral port on 127.0.0.1 and hands back the code', async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ providerId: 'google', state });

  assert.equal(receiver.host, '127.0.0.1');
  assert.ok(receiver.port > 0);
  assert.equal(receiver.redirectUri, `http://127.0.0.1:${receiver.port}/oauth/google`);

  const res = await get(`${receiver.redirectUri}?code=abc123&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /You can close this tab/);

  assert.deepEqual(await receiver.waitForCode(), { code: 'abc123', state });

  // The port goes away with the flow.
  await assert.rejects(() => get(`${receiver.redirectUri}?code=x&state=y`));
});

test('a callback whose state does not match is refused and no code is taken from it', async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ providerId: 'google', state });

  const res = await get(`${receiver.redirectUri}?code=attackers-code&state=${encodeURIComponent(createState())}`);
  assert.equal(res.status, 400);
  const page = await res.text();
  assert.match(page, /refused that callback/);
  assert.ok(!page.includes('attackers-code'), 'the refused page must not echo the query back');

  await assert.rejects(
    () => receiver.waitForCode(),
    (err) => {
      assert.ok(err instanceof OAuthError);
      assert.equal(err.code, 'state_mismatch');
      assert.ok(!String(err.message).includes('attackers-code'));
      return true;
    },
  );
});

test('a missing state is a mismatch too — an omitted check is not a passed check', async () => {
  const receiver = await startLoopbackReceiver({ providerId: 'microsoft', state: createState() });
  const res = await get(`${receiver.redirectUri}?code=abc`);
  assert.equal(res.status, 400);
  await assert.rejects(() => receiver.waitForCode(), (err) => err.code === 'state_mismatch');
});

test('the receiver ignores other paths, other methods and anything with an Origin', async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ providerId: 'google', state });

  assert.equal((await get(`http://127.0.0.1:${receiver.port}/`)).status, 404);
  assert.equal((await get(`http://127.0.0.1:${receiver.port}/oauth/microsoft?code=a&state=${state}`)).status, 404);
  assert.equal((await fetch(receiver.redirectUri, { method: 'POST' })).status, 405);
  // A web page scripting the loopback port: refused before the state is read.
  const scripted = await fetch(`${receiver.redirectUri}?code=a&state=${encodeURIComponent(state)}`, {
    headers: { Origin: 'https://elsewhere.example' },
  });
  assert.equal(scripted.status, 403);

  // Through all of that, the flow is still waiting for a real callback.
  const res = await get(`${receiver.redirectUri}?code=real&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 200);
  assert.equal((await receiver.waitForCode()).code, 'real');
});

test('a user who declines produces the provider’s own error code', async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ providerId: 'google', state });
  const res = await get(`${receiver.redirectUri}?error=access_denied&error_description=user+said+no&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 400);
  await assert.rejects(() => receiver.waitForCode(), (err) => {
    assert.equal(err.code, 'access_denied');
    assert.match(err.description, /user said no/);
    return true;
  });
});

test('a callback with neither a code nor an error is not silently accepted', async () => {
  const state = createState();
  const receiver = await startLoopbackReceiver({ providerId: 'google', state });
  assert.equal((await get(`${receiver.redirectUri}?state=${encodeURIComponent(state)}`)).status, 400);
  await assert.rejects(() => receiver.waitForCode(), (err) => err.code === 'no_code');
});

test('the receiver gives up rather than holding a port forever', async () => {
  const receiver = await startLoopbackReceiver({ providerId: 'google', state: createState(), timeoutMs: 60 });
  const { port } = receiver;
  await assert.rejects(() => receiver.waitForCode(), (err) => err.code === 'timeout');
  await assert.rejects(() => get(`http://127.0.0.1:${port}/oauth/google`), 'the port must be released');
});

test('close() cancels the flow and frees the port', async () => {
  const receiver = await startLoopbackReceiver({ providerId: 'microsoft', state: createState() });
  const pending = receiver.waitForCode();
  await receiver.close();
  await assert.rejects(() => pending, (err) => err.code === 'closed');
  await assert.rejects(() => get(receiver.redirectUri));
});

/* ================================================================== *
 * The token endpoint
 * ================================================================== */

test('the whole flow: begin, callback, exchange — PKCE verified by the server', async () => {
  const mock = await startAuthServer();
  try {
    const pending = await beginAuthorization({
      config: { oauth: { google: { clientId: 'cid.apps.example', enabled: true } } },
      providerId: 'google',
      authorizeUrl: mock.authorizeUrl,
    });

    assert.equal(challengeFor(pending.verifier), pending.challenge);
    assert.match(pending.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/google$/);

    // Play the browser: hit the authorization endpoint, follow its redirect.
    const hop = await get(pending.url);
    assert.equal(hop.status, 302);
    const back = hop.headers.get('location');
    assert.ok(back.startsWith(pending.redirectUri));
    assert.equal((await get(back)).status, 200);

    const tokens = await finishAuthorization(pending, { tokenUrl: mock.tokenUrl, now: 1_000_000 });
    assert.equal(tokens.accessToken, 'at_first');
    assert.equal(tokens.refreshToken, 'rt_first');
    assert.equal(tokens.tokenType, 'Bearer');
    assert.equal(tokens.scope, 'https://www.googleapis.com/auth/calendar.readonly');
    assert.equal(tokens.expiresAt, new Date(1_000_000 + 3600 * 1000).toISOString());

    const call = mock.seen.find((s) => s.kind === 'token');
    assert.equal(call.form.grant_type, 'authorization_code');
    assert.equal(call.form.client_id, 'cid.apps.example');
    assert.equal(call.form.code_verifier, pending.verifier);
    assert.equal(call.form.redirect_uri, pending.redirectUri);
    assert.equal(call.form.client_secret, undefined, 'a public client sends no secret');
    assert.match(call.headers['content-type'], /application\/x-www-form-urlencoded/);
  } finally {
    await mock.close();
  }
});

test('a tampered verifier fails PKCE at the server, which is the point of it', async () => {
  const mock = await startAuthServer();
  try {
    const pending = await beginAuthorization({
      providerId: 'google',
      clientId: 'cid.apps.example',
      authorizeUrl: mock.authorizeUrl,
    });
    const hop = await get(pending.url);
    await get(hop.headers.get('location'));
    const { code } = await pending.receiver.waitForCode();

    await assert.rejects(
      () => exchangeCode({
        provider: 'google',
        clientId: 'cid.apps.example',
        code,
        verifier: createVerifier(),          // someone else's verifier
        redirectUri: pending.redirectUri,
        tokenUrl: mock.tokenUrl,
      }),
      (err) => {
        assert.ok(err instanceof OAuthError);
        assert.equal(err.code, 'invalid_grant');
        assert.equal(err.status, 400);
        assert.match(err.description, /PKCE/);
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

test('refresh spends the refresh token and keeps it when the answer omits one', async () => {
  const mock = await startAuthServer();
  try {
    const next = await refreshTokens({
      provider: 'google',
      clientId: 'cid.apps.example',
      refreshToken: 'rt_first',
      tokenUrl: mock.tokenUrl,
      now: 2_000_000,
      previous: { refreshToken: 'rt_first', scope: 'https://www.googleapis.com/auth/calendar.readonly' },
    });
    assert.equal(next.accessToken, 'at_second');
    // Google issues a refresh token once. Dropping it here would silently
    // disconnect the account an hour later.
    assert.equal(next.refreshToken, 'rt_first');
    assert.equal(next.scope, 'https://www.googleapis.com/auth/calendar.readonly');
    assert.equal(next.expiresAt, new Date(2_000_000 + 3600 * 1000).toISOString());

    const call = mock.seen.at(-1);
    assert.equal(call.form.grant_type, 'refresh_token');
    assert.equal(call.form.refresh_token, 'rt_first');
    assert.equal(call.form.client_id, 'cid.apps.example');
    assert.equal(call.form.client_secret, undefined);
  } finally {
    await mock.close();
  }
});

test('a rotated refresh token replaces the old one', async () => {
  const mock = await startAuthServer({ refreshEcho: true });
  try {
    const next = await refreshTokens({
      provider: 'microsoft',
      clientId: 'entra-client-id',
      refreshToken: 'rt_first',
      tokenUrl: mock.tokenUrl,
      previous: { refreshToken: 'rt_first' },
    });
    assert.equal(next.refreshToken, 'rt_second');
  } finally {
    await mock.close();
  }
});

test('refreshing without a stored refresh token says so instead of calling out', async () => {
  await assert.rejects(
    () => refreshTokens({
      provider: 'google',
      clientId: 'cid',
      refreshToken: null,
      fetchImpl: () => { throw new Error('should not be called'); },
    }),
    (err) => err.code === 'no_refresh_token',
  );
});

test('token endpoint failures surface the server’s own error code', async () => {
  const mock = await startAuthServer({ failWith: { status: 401, body: { error: 'invalid_client', error_description: 'unknown client' } } });
  try {
    await assert.rejects(
      () => refreshTokens({ provider: 'google', clientId: 'cid', refreshToken: 'rt_first', tokenUrl: mock.tokenUrl }),
      (err) => err.code === 'invalid_client' && err.status === 401 && /unknown client/.test(err.description),
    );
  } finally {
    await mock.close();
  }
});

test('a non-JSON answer is an error, not a token', async () => {
  const mock = await startAuthServer({ malformed: true });
  try {
    await assert.rejects(
      () => refreshTokens({ provider: 'google', clientId: 'cid', refreshToken: 'rt_first', tokenUrl: mock.tokenUrl }),
      (err) => err.code === 'bad_response',
    );
  } finally {
    await mock.close();
  }
});

test('an unreachable token endpoint names the address that failed', async () => {
  await assert.rejects(
    () => refreshTokens({
      provider: 'google',
      clientId: 'cid',
      refreshToken: 'rt_first',
      tokenUrl: 'http://127.0.0.1:1/token',
    }),
    (err) => err instanceof OAuthError && /127\.0\.0\.1:1/.test(err.message),
  );
});

/* ================================================================== *
 * Storage
 * ================================================================== */

test('refresh tokens go to the secret store as one line, and never to config.json', async () => {
  const ref = tokenRef('google', 'default');
  assert.equal(ref, 'oauth.google.default');
  assert.equal(tokenRef('microsoft', 'work account/2'), 'oauth.microsoft.workaccount2');

  await saveTokens(ref, {
    accessToken: 'at_x',
    refreshToken: 'rt_x',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  const raw = await getSecret(ref);
  assert.ok(!raw.includes('\n'), 'the macOS keychain backend refuses a value with a line break');
  const back = await loadTokens(ref);
  assert.equal(back.refreshToken, 'rt_x');
  assert.equal(back.accessToken, 'at_x');

  // The whole home, swept: the token exists only inside the encrypted store.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (path.basename(full) === 'secrets.enc') continue;
      if (fs.readFileSync(full).includes('rt_x')) offenders.push(full);
    }
  };
  walk(process.env.ZELOS_HOME);
  assert.deepEqual(offenders, [], 'a refresh token landed outside the secret store');

  await forgetTokens(ref);
  assert.equal(await loadTokens(ref), null);
});

test('tokensExpired treats a nearly-spent token as spent', () => {
  const now = 1_000_000_000_000;
  assert.equal(tokensExpired(null, { now }), true);
  assert.equal(tokensExpired({ accessToken: '' }, { now }), true);
  assert.equal(tokensExpired({ accessToken: 'a', expiresAt: null }, { now }), false);
  assert.equal(tokensExpired({ accessToken: 'a', expiresAt: new Date(now + 3600_000).toISOString() }, { now }), false);
  assert.equal(tokensExpired({ accessToken: 'a', expiresAt: new Date(now + 30_000).toISOString() }, { now }), true);
  assert.equal(tokensExpired({ accessToken: 'a', expiresAt: new Date(now - 1).toISOString() }, { now }), true);
});

test('accessTokenFor refreshes a spent token, stores the result, and reuses a live one', async () => {
  const mock = await startAuthServer();
  const config = { oauth: { google: { clientId: 'cid.apps.example', enabled: true, accountId: 'primary' } } };
  const ref = tokenRef('google', 'primary');
  try {
    const now = 5_000_000;
    await saveTokens(ref, {
      accessToken: 'at_first',
      refreshToken: 'rt_first',
      expiresAt: new Date(now - 1).toISOString(),
    });

    const refreshed = await accessTokenFor({ config, providerId: 'google', tokenUrl: mock.tokenUrl, now });
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.accessToken, 'at_second');
    assert.equal(refreshed.ref, ref);

    const stored = await loadTokens(ref);
    assert.equal(stored.accessToken, 'at_second');
    assert.equal(stored.refreshToken, 'rt_first', 'the refresh token survives a refresh that omits it');

    const again = await accessTokenFor({ config, providerId: 'google', tokenUrl: mock.tokenUrl, now });
    assert.equal(again.refreshed, false);
    assert.equal(again.accessToken, 'at_second');
    assert.equal(mock.seen.filter((s) => s.kind === 'token').length, 1, 'a live token must not be spent again');
  } finally {
    await forgetTokens(ref);
    await mock.close();
  }
});

test('accessTokenFor on an account that was never connected says exactly that', async () => {
  await assert.rejects(
    () => accessTokenFor({
      config: { oauth: { microsoft: { clientId: 'entra', enabled: true } } },
      providerId: 'microsoft',
      fetchImpl: () => { throw new Error('should not be called'); },
    }),
    (err) => err.code === 'not_connected',
  );
});

/* ================================================================== *
 * authorize(), start to finish
 * ================================================================== */

test('authorize stores the tokens and returns a ref, never the tokens', async () => {
  const mock = await startAuthServer();
  const config = { oauth: { microsoft: { clientId: 'entra-client-id', enabled: true, accountId: 'work' } } };
  try {
    const result = await authorize({
      config,
      providerId: 'microsoft',
      authorizeUrl: mock.authorizeUrl,
      tokenUrl: mock.tokenUrl,
      // Stand in for the browser: follow the redirect the moment we are handed a URL.
      openUrl: (url) => { get(url).then((hop) => get(hop.headers.get('location'))).catch(() => {}); },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ref, 'oauth.microsoft.work');
    assert.equal(result.hasRefreshToken, true);
    assert.equal(JSON.stringify(result).includes('rt_first'), false, 'authorize must not hand tokens back to its caller');
    assert.equal(JSON.stringify(result).includes('at_first'), false);

    const stored = await loadTokens('oauth.microsoft.work');
    assert.equal(stored.refreshToken, 'rt_first');
    await forgetTokens('oauth.microsoft.work');
  } finally {
    await mock.close();
  }
});

test('if the browser cannot be opened the port is released rather than left bound', async () => {
  const mock = await startAuthServer();
  try {
    let boundPort = 0;
    await assert.rejects(
      () => authorize({
        providerId: 'google',
        clientId: 'cid.apps.example',
        authorizeUrl: mock.authorizeUrl,
        tokenUrl: mock.tokenUrl,
        openUrl: (url) => { boundPort = Number(new URL(new URL(url).searchParams.get('redirect_uri')).port); throw new Error('no browser here'); },
      }),
      /no browser here/,
    );
    assert.ok(boundPort > 0);
    await assert.rejects(() => get(`http://127.0.0.1:${boundPort}/oauth/google`));
  } finally {
    await mock.close();
  }
});
