import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as family from '../core/family.mjs';
import { totpCode } from '../core/family-mfa.mjs';
import { createFamilyGuestServer, listenFamilyGuest } from '../core/family-guest.mjs';

const origin = 'http://127.0.0.1:7781';
const password = 'Correct horse battery 7!';
const owner = { accountId: 'owner' };
const future = () => new Date(Date.now() + 86400000).toISOString();
const permissions = extra => ({ view: true, submitTasks: false, uploadDocuments: false, directTasks: false, ...extra });

async function fixture(t, { rateLimits, operations = family, trustedProxy, guestOrigin = origin } = {}) {
  const db = new DatabaseSync(':memory:'); family.migrateFamily(db);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-family-gateway-'));
  fs.mkdirSync(path.join(directory, 'lib'));
  for (const [file, body] of [['index.html', '<!doctype html><title>Family</title>'], ['app.js', '// portal'], ['family.css', 'body {}'], ['lib/family-client.js', '// family']]) fs.writeFileSync(path.join(directory, file), body);
  const options = { db, origin: guestOrigin, assetsDir: directory, uiDir: directory, rateLimits, operations, trustedProxy };
  let server = createFamilyGuestServer(options), address = await listenFamilyGuest(server, { port: 0 });
  const request = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const raw = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: url, method, headers: {
      Host: new URL(guestOrigin).host,
      ...(raw !== null ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks), text = bytes.toString('utf8'); let data;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, text, data });
      });
    });
    req.on('error', reject); if (raw !== null) req.write(raw); req.end();
  });
  const call = (method, url, body, token, headers = {}) => request(method, url, body, { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await server.drainFamilyWork(); db.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const restart = async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.drainFamilyWork();
    server = createFamilyGuestServer(options); address = await listenFamilyGuest(server, { port: 0 });
  };
  return { db, get server() { return server; }, get address() { return address; }, directory, options, call, request, restart };
}
async function invite(db, name = 'Advisor', role = 'collaborator') {
  const invitation = await family.familyAction(db, owner, 'member.invite', { name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.test`, role });
  const setup = await family.acceptFamilyInvite(db, { token: invitation.inviteToken, password });
  assert.equal(setup.mfaRequired, true); assert.equal(setup.token, undefined);
  const accepted = await family.completeFamilyMfa(db, { challenge: setup.challenge, code: totpCode(setup.enrollment.secret) });
  return { ...accepted, mfaSecret: setup.enrollment.secret, actor: family.authenticateFamily(db, accepted.token) };
}
async function record(db, title, extra = {}, actor = owner) {
  const result = await family.familyAction(db, actor, 'record.save', { kind: 'task', title, ...extra });
  return result.record;
}
async function grant(db, accountId, recordIds, extra = {}) {
  const result = await family.familyAction(db, owner, 'grant.create', {
    accountId, label: 'Selected records', recordIds, subjectIds: ['self'], kinds: ['task', 'document'], includeFuture: false,
    permissions: permissions(), expiresAt: future(), ...extra,
  });
  const credential = await family.familyAction(db, owner, 'credential.create', { grantId: result.grant.id, label: 'Trainer API' });
  return { grant: result.grant, ...credential };
}

test('family listener requires an exact public origin and binds only loopback', async t => {
  const f = await fixture(t);
  assert.equal(f.address.address, '127.0.0.1');
  assert.throws(() => listenFamilyGuest(http.createServer(), { host: '0.0.0.0' }), /loopback/);
  assert.throws(() => listenFamilyGuest(http.createServer(), { port: -1 }), /port/);
  for (const bad of ['http://family.example', 'https://user:pass@example.test', 'https://family.example/path', 'https://family.example/?token=x', 'https://family.example/#x', 'https://FAMILY.example']) {
    assert.throws(() => createFamilyGuestServer({ ...f.options, origin: bad }), bad);
  }
  const valid = createFamilyGuestServer({ ...f.options, origin: 'https://family.example.test:8443' }); valid.close();
  for (const trustedProxy of [true, null, 'all', 'loopback', []]) assert.throws(() => createFamilyGuestServer({ ...f.options, trustedProxy }), /proxy/);
  assert.throws(() => createFamilyGuestServer({ ...f.options, trustedProxy: 'tailscale' }), /proxy/);
  assert.ok(f.server.requestTimeout <= 20000); assert.ok(f.server.headersTimeout <= 10000);
});

test('static allowlist never serves owner routes, paths, credentials, or CORS grants', async t => {
  const f = await fixture(t);
  for (const route of ['/', '/app.js', '/family-client.js', '/family.css']) {
    const result = await f.call('GET', route); assert.equal(result.status, 200, route);
    assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.equal(result.headers['x-content-type-options'], 'nosniff'); assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const route of ['/api/state', '/api/config', '/api/family', '/api/mail', '/api/health', '/api/imports/commit', '/core/db.mjs', '/lib/api.js', '/ui/app.js', '/../core/db.mjs', '/%2e%2e/core/db.mjs', '//app.js', '/?token=secret', '/app.js?x=1', '/family/v1/state?token=secret']) {
    assert.equal((await f.call('GET', route)).status, 404, route);
    assert.equal((await f.call('POST', route, {})).status, 404, route);
  }
  assert.equal((await f.call('OPTIONS', '/family/v1/action')).status, 404);
  assert.equal((await f.call('HEAD', '/')).status, 404);
});

test('forged hosts, browser origins and duplicate identity headers fail closed', async t => {
  const f = await fixture(t);
  for (const headers of [{ Host: 'evil.example' }, { Host: '127.0.0.1:7781.evil.test' }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: '' }, { Origin: `${origin}/` }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: [origin, origin] }]) {
    assert.equal((await f.request('GET', '/', undefined, headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal((await f.request('GET', '/', undefined, { Origin: origin })).status, 200);
  const forbidden = await f.request('GET', '/family/v1/state', undefined, { 'X-Forwarded-Host': new URL(origin).host, 'X-Zelos-Token': 'owner', 'Tailscale-User-Login': 'owner@example.test' });
  assert.equal(forbidden.status, 401);
  const member = await invite(f.db);
  assert.equal((await f.request('GET', '/family/v1/state', undefined, { Authorization: [`Bearer ${member.token}`, `Bearer ${member.token}`] })).status, 401);
  assert.equal((await f.call('GET', '/family/v1/state', undefined, member.token)).status, 200, 'API client may omit Origin');
});

test('invitation acceptance, independent login and logout require exact credentials', async t => {
  const f = await fixture(t);
  const invitation = await family.familyAction(f.db, owner, 'member.invite', { name: 'Second parent', email: 'parent@example.test', role: 'parent' });
  assert.equal((await f.call('POST', '/family/v1/accept', { token: invitation.inviteToken, password, email: 'attacker@example.test' })).status, 400);
  const setup = await f.call('POST', '/family/v1/accept', { token: invitation.inviteToken, password });
  assert.equal(setup.status, 200); assert.equal(setup.data.mfaRequired, true); assert.equal(setup.data.token, undefined);
  assert.equal((await f.call('GET', '/family/v1/state', undefined, setup.data.challenge)).status, 401);
  const accepted = await f.call('POST', '/family/v1/verify', { challenge: setup.data.challenge, code: totpCode(setup.data.enrollment.secret) });
  assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.data.account.email, 'parent@example.test');
  assert.ok((await f.call('POST', '/family/v1/accept', { token: invitation.inviteToken, password })).status >= 400);
  assert.equal((await f.call('POST', '/family/v1/login', { email: 'parent@example.test', password: 'Incorrect password 7!' })).status, 401);
  const login = await f.call('POST', '/family/v1/login', { email: 'parent@example.test', password });
  assert.equal(login.status, 200); assert.equal(login.data.mfaRequired, true); assert.equal(login.data.token, undefined);
  const signedIn = await f.call('POST', '/family/v1/verify', { challenge: login.data.challenge, code: totpCode(setup.data.enrollment.secret, { time: Date.now() + 30000 }) });
  assert.equal(signedIn.status, 200, signedIn.text); assert.notEqual(signedIn.data.token, accepted.data.token);
  const loggedOut = await f.call('POST', '/family/v1/logout', undefined, signedIn.data.token);
  assert.equal(loggedOut.status, 200); assert.equal((await f.call('GET', '/family/v1/state', undefined, signedIn.data.token)).status, 401);
  assert.equal((await f.call('GET', '/family/v1/state', undefined, accepted.data.token)).status, 200);
});

test('invitation links from webmail may navigate to the public root without allowing cross-site APIs or assets', async t => {
  const f = await fixture(t);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal((await f.request('GET', '/', undefined, navigation)).status, 200);
  assert.equal((await f.request('GET', '/', undefined, { ...navigation, 'Sec-Fetch-Site': 'same-site' })).status, 200);
  for (const route of ['/app.js', '/family-client.js', '/family.css', '/family/v1/state', '/collaboration/v1/records', '/?token=secret']) {
    assert.equal((await f.request('GET', route, undefined, navigation)).status, 403, route);
  }
  assert.equal((await f.request('POST', '/', {}, navigation)).status, 403);
  assert.equal((await f.request('POST', '/family/v1/accept', {}, navigation)).status, 403);
  for (const headers of [{ ...navigation, Origin: 'https://mail.example.test' }, { ...navigation, Origin: origin },
    { ...navigation, 'Sec-Fetch-Mode': 'cors' }, { ...navigation, 'Sec-Fetch-Dest': 'iframe' }]) {
    assert.equal((await f.request('GET', '/', undefined, headers)).status, 403);
  }
});

test('JSON, encoding and upload limits reject invalid bodies before dispatch', async t => {
  const f = await fixture(t), member = await invite(f.db, 'Parent', 'parent');
  for (const [body, headers, status] of [
    ['not JSON', {}, 400], ['[]', {}, 400], ['null', {}, 400], [Buffer.from([0x7b, 0x22, 0xc0, 0xaf, 0x22, 0x3a, 0x31, 0x7d]), {}, 400],
    ['{}', { 'Content-Type': 'text/plain' }, 415], ['{}', { 'Content-Type': 'application/json; charset=latin1' }, 415],
    ['{}', { 'Content-Encoding': 'gzip' }, 415], ['{}', { 'Content-Type': ['application/json', 'application/json'] }, 415],
    [{ action: 'record.save', input: {}, accountId: 'owner' }, {}, 400],
    [{ action: 'record.save', input: { title: 'x'.repeat(65536) } }, {}, 413],
  ]) assert.equal((await f.call('POST', '/family/v1/action', body, member.token, headers)).status, status);
  assert.equal((await f.call('POST', '/family/v1/login', 'x'.repeat(8193))).status, 413);
  assert.equal((await f.call('POST', '/collaboration/v1/documents', '{}', member.token, { 'Content-Length': String(12 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await f.call('GET', '/family/v1/state', {}, member.token)).status, 400);
  assert.equal(family.familyState(f.db, member.actor).records.length, 0);
});

test('global and peer auth limits cannot be bypassed with forwarded addresses', async t => {
  const f = await fixture(t, { rateLimits: { global: 20, peer: 20, writes: 20, authGlobal: 10, authPeer: 2 } });
  const bad = { email: 'unknown@example.test', password };
  assert.equal((await f.call('POST', '/family/v1/login', bad)).status, 401);
  assert.equal((await f.call('POST', '/family/v1/login', bad)).status, 401);
  const limited = await f.request('POST', '/family/v1/login', bad, { 'X-Forwarded-For': '8.8.8.8', 'X-Real-IP': '1.2.3.4' });
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '60');
  const g = await fixture(t, { rateLimits: { global: 2 } });
  assert.equal((await g.call('GET', '/')).status, 200); assert.equal((await g.call('GET', '/app.js')).status, 200);
  assert.equal((await g.call('GET', '/family.css')).status, 429);
});

const proxyOrigin = 'https://family.example.test:10000';
const proxyHeaders = address => ({ 'X-Forwarded-For': address, 'X-Forwarded-Host': new URL(proxyOrigin).host,
  'X-Forwarded-Proto': 'https', 'Tailscale-Funnel-Request': '?1' });
const proxyFixture = (t, options = {}) => fixture(t, { guestOrigin: proxyOrigin, trustedProxy: 'tailscale', ...options });

test('Tailscale proxy trust requires exact single headers and a direct trusted loopback peer', async t => {
  const f = await proxyFixture(t);
  assert.equal((await f.request('GET', '/', undefined, proxyHeaders('192.0.2.10'))).status, 200);
  assert.equal((await f.request('GET', '/', undefined, proxyHeaders('2001:db8::10'))).status, 200);
  const serve = proxyHeaders('100.64.0.10'); delete serve['Tailscale-Funnel-Request'];
  assert.equal((await f.request('GET', '/', undefined, serve)).status, 200, 'tailnet Serve uses the same overwritten forwarding headers');
  assert.equal((await f.request('GET', '/')).status, 403);
  for (const override of [
    { 'X-Forwarded-For': '' }, { 'X-Forwarded-For': '192.0.2.10, 198.51.100.20' },
    { 'X-Forwarded-For': ['192.0.2.10', '198.51.100.20'] }, { 'X-Forwarded-For': 'example.test' },
    { 'X-Forwarded-For': '192.0.2.10:80' }, { 'X-Forwarded-For': '[2001:db8::10]' }, { 'X-Forwarded-For': 'fe80::1%lo0' },
    { 'X-Forwarded-Host': 'evil.example' }, { 'X-Forwarded-Host': [new URL(proxyOrigin).host, new URL(proxyOrigin).host] },
    { 'X-Forwarded-Proto': 'http' }, { 'X-Forwarded-Proto': ['https', 'https'] },
    { 'Tailscale-Funnel-Request': '?0' }, { 'Tailscale-Funnel-Request': ['?1', '?1'] },
  ]) assert.equal((await f.request('GET', '/', undefined, { ...proxyHeaders('192.0.2.10'), ...override })).status, 403, JSON.stringify(override));
  // The listener itself binds loopback; inject a nonloopback socket identity to also exercise the trust guard.
  f.server.prependOnceListener('request', req => Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.10' }));
  assert.equal((await f.request('GET', '/', undefined, proxyHeaders('192.0.2.10'))).status, 403);
});

test('invalid verification traffic from one Funnel client cannot block another family sign-in', async t => {
  const f = await proxyFixture(t), member = await invite(f.db, 'Victim', 'parent');
  const attacker = proxyHeaders('192.0.2.10'), victim = proxyHeaders('198.51.100.20');
  for (let index = 0; index < 40; index++) {
    const response = await f.request('POST', '/family/v1/verify', { challenge: 'invalid', code: '000000' }, attacker);
    assert.equal(response.status, index < 12 ? 401 : 429);
  }
  assert.equal(f.db.prepare("SELECT requests FROM family_http_auth_limits WHERE key='global'").get(), undefined);
  const login = await f.request('POST', '/family/v1/login', { email: member.account.email, password }, victim);
  assert.equal(login.status, 200, login.text); assert.equal(login.data.mfaRequired, true); assert.equal(login.data.token, undefined);
  const verified = await f.request('POST', '/family/v1/verify', {
    challenge: login.data.challenge, code: totpCode(member.mfaSecret, { time: Date.now() + 30000 }),
  }, victim);
  assert.equal(verified.status, 200, verified.text);
  assert.equal((await f.request('GET', '/family/v1/state', undefined, { ...victim, Authorization: `Bearer ${verified.data.token}` })).status, 200);
  assert.equal(f.db.prepare("SELECT requests FROM family_http_auth_limits WHERE key='global'").get().requests, 1);
});

test('peer rejection preserves the global password-work fuse, and both persist across a restart', async t => {
  let calls = 0;
  const f = await proxyFixture(t, { rateLimits: { authGlobal: 3, authPeer: 2 }, operations: {
    ...family, loginFamily() { calls++; throw new family.FamilyError(401, 'The email or password is incorrect.'); },
  } });
  const input = { email: 'unknown@example.test', password }, attacker = proxyHeaders('192.0.2.10');
  for (let index = 0; index < 20; index++) assert.equal((await f.request('POST', '/family/v1/login', input, attacker)).status, index < 2 ? 401 : 429);
  assert.equal(calls, 2);
  await f.restart();
  assert.equal((await f.request('POST', '/family/v1/login', input, attacker)).status, 429);
  assert.equal((await f.request('POST', '/family/v1/login', input, proxyHeaders('198.51.100.20'))).status, 401);
  await f.restart();
  assert.equal((await f.request('POST', '/family/v1/login', input, proxyHeaders('203.0.113.30'))).status, 429);
  assert.equal(calls, 3);
  assert.equal(f.db.prepare("SELECT requests FROM family_http_auth_limits WHERE key='global'").get().requests, 3);
});

test('malformed bodies and unsupported auth fields do not spend global password capacity', async t => {
  const f = await proxyFixture(t, { rateLimits: { authGlobal: 1 } }), attacker = proxyHeaders('192.0.2.10');
  for (const input of ['not json', '[]', { email: 'unknown@example.test', password, accountId: 'owner' }]) {
    assert.equal((await f.request('POST', '/family/v1/login', input, attacker)).status, 400);
  }
  assert.equal(f.db.prepare("SELECT requests FROM family_http_auth_limits WHERE key='global'").get(), undefined);
  assert.equal((await f.request('POST', '/family/v1/login', { email: 'unknown@example.test', password }, proxyHeaders('198.51.100.20'))).status, 401);
});

test('equivalent IPv6 spellings share a peer limit, and rejected writes do not starve other peers', async t => {
  const f = await proxyFixture(t, { rateLimits: { authPeer: 1 } });
  assert.equal((await f.request('POST', '/family/v1/verify', {}, proxyHeaders('2001:db8::a'))).status, 401);
  assert.equal((await f.request('POST', '/family/v1/verify', {}, proxyHeaders('2001:0db8:0:0:0:0:0:A'))).status, 429);
  const g = await proxyFixture(t, { rateLimits: { global: 5, peer: 2, writes: 3, writesPeer: 1 } });
  const attacker = proxyHeaders('192.0.2.10');
  assert.equal((await g.request('POST', '/unknown', {}, attacker)).status, 404);
  for (let index = 0; index < 10; index++) assert.equal((await g.request('POST', '/unknown', {}, attacker)).status, 429);
  assert.equal((await g.request('POST', '/unknown', {}, proxyHeaders('198.51.100.20'))).status, 404);
  assert.equal((await g.request('POST', '/unknown', {}, proxyHeaders('203.0.113.30'))).status, 404);
  assert.equal((await g.request('POST', '/unknown', {}, proxyHeaders('203.0.113.40'))).status, 429, 'the global write fuse remains bounded');
});

test('API records, individual lookups and totals include only explicitly granted data', async t => {
  const f = await fixture(t), advisor = await invite(f.db), other = await invite(f.db, 'HiddenParent', 'parent');
  const selected = await record(f.db, 'Shared training plan');
  const hidden = await record(f.db, 'PRIVATE OWNER TASK');
  await record(f.db, 'OTHER PARENT PRIVATE', {}, other.actor);
  const access = await grant(f.db, advisor.account.id, [selected.id]);
  const state = await f.call('GET', '/family/v1/state', undefined, access.token);
  assert.equal(state.status, 200, state.text); assert.deepEqual(state.data.records.map(row => row.id), [selected.id]);
  assert.doesNotMatch(state.text, /PRIVATE OWNER|OTHER PARENT|HiddenParent|hiddenparent@example/);
  const page = await f.call('GET', '/collaboration/v1/records?limit=1&offset=0&kind=task', undefined, access.token);
  assert.equal(page.status, 200, page.text); assert.equal(page.data.total, 1); assert.equal(page.data.hasMore, false);
  assert.equal((await f.call('GET', '/collaboration/v1/records?offset=1', undefined, access.token)).data.records.length, 0);
  assert.equal((await f.call('GET', `/collaboration/v1/records/${selected.id}`, undefined, access.token)).data.record.title, selected.title);
  assert.equal((await f.call('GET', `/collaboration/v1/records/${hidden.id}`, undefined, access.token)).status, 404);
  assert.equal((await f.call('GET', '/collaboration/v1/records/nonexistent', undefined, access.token)).status, 404);
  for (const query of ['limit=101', 'limit=1&limit=2', 'offset=-1', 'token=secret', 'actor=owner', 'kind=secrets']) assert.equal((await f.call('GET', `/collaboration/v1/records?${query}`, undefined, access.token)).status, 400);
  const me = await f.call('GET', '/collaboration/v1/me', undefined, access.token);
  assert.equal(me.status, 200); assert.equal(me.data.me.id, advisor.account.id); assert.equal(me.data.records, undefined);
  const edit = await f.call('POST', '/family/v1/action', { action: 'record.save', input: { id: selected.id, title: 'Injected change', version: selected.version } }, access.token);
  assert.equal(edit.status, 403); assert.equal(family.familyState(f.db, owner).records.find(row => row.id === selected.id).title, selected.title);
});

test('task and document submissions stay attributable, scoped and idempotent', async t => {
  const f = await fixture(t), advisor = await invite(f.db);
  const access = await grant(f.db, advisor.account.id, [], { includeFuture: true, permissions: permissions({ submitTasks: true, uploadDocuments: true }) });
  const input = { title: 'Trainer assigned workout', details: 'Three sets', idempotencyKey: 'task-request-0001' };
  const first = await f.call('POST', '/collaboration/v1/tasks', input, access.token);
  assert.equal(first.status, 200, first.text); assert.equal(first.data.submission.status, 'pending');
  const replay = await f.call('POST', '/collaboration/v1/tasks', input, access.token);
  assert.equal(replay.data.submission.id, first.data.submission.id);
  const lookup = await f.call('GET', `/collaboration/v1/submissions/${first.data.submission.id}`, undefined, access.token);
  assert.equal(lookup.status, 200, lookup.text); assert.equal(lookup.data.submission.id, first.data.submission.id);
  assert.equal((await f.call('GET', '/collaboration/v1/submissions/nonexistent', undefined, access.token)).status, 404);
  const bytes = Buffer.from('A training document with synthetic information.\n');
  const uploaded = await f.call('POST', '/collaboration/v1/documents', { filename: 'training.txt', base64: bytes.toString('base64'), idempotencyKey: 'document-request-0001' }, access.token);
  assert.equal(uploaded.status, 200, uploaded.text); assert.equal(uploaded.data.submission.status, 'pending');
  assert.equal(family.familyState(f.db, owner).records.length, 0);
  const accepted = await family.familyAction(f.db, owner, 'submission.review', { id: uploaded.data.submission.id, decision: 'accept' });
  assert.ok(accepted.record.id);
  const download = await f.call('GET', `/collaboration/v1/documents/${accepted.record.id}/download`, undefined, access.token);
  assert.equal(download.status, 200, download.text); assert.deepEqual(download.bytes, bytes);
  assert.match(download.headers['content-disposition'], /^attachment;/); assert.match(download.headers['content-type'], /^text\/plain(?:; charset=utf-8)?$/);
  const state = await f.call('GET', '/family/v1/state', undefined, access.token);
  assert.ok(!state.text.includes(bytes.toString('base64'))); assert.ok(!state.text.includes('A training document with synthetic information.'));
});

test('API pagination and individual reads reach authorized records beyond the UI state cap', async t => {
  const f = await fixture(t), advisor = await invite(f.db);
  const first = await record(f.db, 'Oldest authorized record');
  for (let index = 0; index < 500; index++) await record(f.db, `Newer authorized record ${index}`);
  const access = await grant(f.db, advisor.account.id, [], { includeFuture: true });
  assert.equal((await f.call('GET', '/family/v1/state', undefined, access.token)).data.records.length, 500);
  const page = await f.call('GET', '/collaboration/v1/records?offset=500&limit=1', undefined, access.token);
  assert.equal(page.status, 200, page.text); assert.equal(page.data.total, 501);
  assert.equal(page.data.records[0].id, first.id); assert.equal(page.data.hasMore, false);
  const individual = await f.call('GET', `/collaboration/v1/records/${first.id}`, undefined, access.token);
  assert.equal(individual.status, 200, individual.text); assert.equal(individual.data.record.id, first.id);
});

test('grant and credential revocation immediately invalidate state, submission and downloads', async t => {
  const f = await fixture(t), advisor = await invite(f.db);
  const doc = await family.familyAction(f.db, owner, 'document.upload', { filename: 'shared.txt', base64: Buffer.from('Selected document').toString('base64'), idempotencyKey: 'owner-document-0001' });
  const access = await grant(f.db, advisor.account.id, [doc.record.id], { permissions: permissions({ submitTasks: true }) });
  assert.equal((await f.call('GET', `/family/v1/documents/${doc.record.id}`, undefined, access.token)).status, 200);
  await family.familyAction(f.db, owner, 'grant.revoke', { id: access.grant.id });
  for (const route of ['/family/v1/state', '/collaboration/v1/records', `/family/v1/documents/${doc.record.id}`]) assert.equal((await f.call('GET', route, undefined, access.token)).status, 401);
  assert.equal((await f.call('POST', '/collaboration/v1/tasks', { title: 'Revoked request', idempotencyKey: 'revoked-request-0001' }, access.token)).status, 401);
  const second = await grant(f.db, advisor.account.id, [doc.record.id]);
  await family.familyAction(f.db, owner, 'credential.revoke', { id: second.credential.id });
  assert.equal((await f.call('GET', '/family/v1/state', undefined, second.token)).status, 401);
  assert.equal((await f.call('GET', `/family/v1/documents/${doc.record.id}`, undefined, advisor.token)).status, 200);
});

test('a credential revoked while its body streams cannot dispatch a mutation', async t => {
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const operations = { ...family, authenticateFamily(db, token) { const actor = family.authenticateFamily(db, token); readStarted(); return actor; } };
  const f = await fixture(t, { operations }), advisor = await invite(f.db);
  const access = await grant(f.db, advisor.account.id, [], { includeFuture: true, permissions: permissions({ submitTasks: true }) });
  const body = JSON.stringify({ title: 'Never create this task', idempotencyKey: 'streaming-request-0001' });
  let send;
  const response = new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.address.port, path: '/collaboration/v1/tasks', method: 'POST', headers: {
      Host: new URL(origin).host, Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(body.slice(0, 5)); send = () => req.end(body.slice(5));
  });
  await started; await family.familyAction(f.db, owner, 'grant.revoke', { id: access.grant.id }); send();
  assert.equal(await response, 401); assert.equal(family.familyState(f.db, owner).submissions.length, 0);
});

test('download headers sanitize filenames and unexpected failures never expose diagnostics', async t => {
  const operations = { ...family, familyDownload: () => ({ bytes: Buffer.from('safe'), filename: '../folder/evil\r\nX-Injected: yes".txt', mime: 'text/html' }) };
  const f = await fixture(t, { operations }), member = await invite(f.db);
  const result = await f.call('GET', '/family/v1/documents/synthetic', undefined, member.token);
  assert.equal(result.status, 200); assert.equal(result.headers['content-type'], 'application/octet-stream');
  assert.equal(result.headers['x-injected'], undefined); assert.doesNotMatch(result.headers['content-disposition'], /\.\.\/|\r|\n|folder/);
  const g = await fixture(t, { operations: { ...family, familyState() { throw Error('PRIVATE DATABASE PATH AND CREDENTIAL'); } } });
  const another = await invite(g.db), unavailable = await g.call('GET', '/family/v1/state', undefined, another.token);
  assert.equal(unavailable.status, 503); assert.doesNotMatch(unavailable.text, /PRIVATE DATABASE|CREDENTIAL/);
});

test('shutdown drains asynchronous authentication after a client disconnects', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let completed = false;
  const f = await fixture(t, { operations: { ...family, async loginFamily(db, input) { entered(); await gate; completed = true; return family.loginFamily(db, input); } } });
  t.after(() => release());
  const member = await invite(f.db, 'Parent', 'parent');
  const response = f.call('POST', '/family/v1/login', { email: member.account.email, password }).catch(() => null);
  await started; f.server.closeAllConnections();
  let drained = false;
  const draining = f.server.drainFamilyWork().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false); assert.equal(completed, false);
  release(); await draining; await response; assert.equal(completed, true); assert.equal(drained, true);
});
