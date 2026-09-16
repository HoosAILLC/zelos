/** Subscription routes stay behind the owner boundary and use the account adapter only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-subscription-api-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
const { createServer, listen } = await import('../core/server.mjs');
const database = await import('../core/db.mjs');
const { DEFAULTS } = await import('../core/config.mjs');
const { listRefs, setSecret, deleteSecret } = await import('../core/secrets.mjs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function fakeSubscription() {
  const calls = [];
  let connected = true;
  let closeImpl = async () => {};
  const account = { type: 'chatgpt', email: 'owner@example.invalid', planType: 'plus' };
  const status = () => ({ installed: true, connected, account: connected ? account : null, login: null, rateLimits: null, error: null });
  return {
    calls,
    setConnected(value) { connected = value; },
    setCloseImpl(value) { closeImpl = value; },
    adapter: {
      async status() { calls.push({ action: 'status' }); return status(); },
      async models() {
        calls.push({ action: 'models' });
        return { models: [{ id: 'account-model', displayName: 'Account model' }, { id: 'other-model' }], defaultModel: 'account-model' };
      },
      async startLogin(args) {
        calls.push({ action: 'login', args });
        return args.type === 'chatgptDeviceCode'
          ? { type: args.type, loginId: 'device-flow', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'SAMPLE-CODE' }
          : { type: args.type, loginId: 'browser-flow', authUrl: 'https://auth.openai.com/oauth/authorize?state=sample' };
      },
      async cancelLogin(args) { calls.push({ action: 'cancel', args }); return { canceled: true }; },
      async logout() { calls.push({ action: 'logout' }); connected = false; return { connected: false }; },
      async complete(args) {
        calls.push({ action: 'complete', args });
        return { text: 'ready', model: 'account-model', tokensIn: 2, tokensOut: 1 };
      },
      async close() { calls.push({ action: 'close' }); return closeImpl(); },
    },
  };
}

async function fixture(t, { model = {}, fake = fakeSubscription() } = {}) {
  const db = database.open(':memory:');
  database.migrate(db);
  const config = structuredClone(DEFAULTS);
  config.sweep.auto = false;
  config.identity.timezone = 'America/Chicago';
  config.model = { protocol: 'chatgpt', label: 'ChatGPT subscription', baseUrl: 'https://chatgpt.com', model: 'auto', keyRef: null, maxTokens: 8192, ...model };
  const server = createServer({ db, config, subscription: fake.adapter });
  const { port } = await listen(server, { port: 0 });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    fake.setCloseImpl(async () => {});
    await server.zelos.stopBackgroundWork();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    database.close(db);
  });
  async function call(route, { body, method = body === undefined ? 'GET' : 'POST', token = server.sessionToken, origin = base } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(origin ? { Origin: origin } : {}),
        ...(token ? { 'X-Zelos-Token': token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { /* A non-JSON denial remains visible to the assertion. */ }
    return { status: response.status, json, text };
  }
  return { db, server, fake, call };
}

const route = action => `/api/model/subscription${action ? `/${action}` : ''}`;

test('subscription status and model listing only read the account adapter', async t => {
  const x = await fixture(t);
  const state = await x.call(route());
  assert.equal(state.status, 200);
  assert.deepEqual(state.json.account, { type: 'chatgpt', email: 'owner@example.invalid', planType: 'plus' });
  assert.equal(state.json.connected, true);
  const models = await x.call('/api/model/list?protocol=chatgpt');
  assert.equal(models.status, 200);
  assert.deepEqual(models.json, [{ id: 'account-model', label: 'Account model' }, { id: 'other-model', label: 'other-model' }]);
  assert.deepEqual(x.fake.calls.map(call => call.action), ['status', 'models']);
  assert.deepEqual(await listRefs(), []);
});

test('an authenticated owner can start browser or device sign-in, cancel, and sign out', async t => {
  const x = await fixture(t);
  const browser = await x.call(route('login'), { body: { type: 'chatgpt' } });
  assert.equal(browser.status, 200);
  assert.deepEqual(browser.json, { type: 'chatgpt', loginId: 'browser-flow', authUrl: 'https://auth.openai.com/oauth/authorize?state=sample' });
  const device = await x.call(route('login'), { body: { type: 'chatgptDeviceCode' } });
  assert.equal(device.status, 200);
  assert.equal(device.json.loginId, 'device-flow');
  assert.equal(device.json.userCode, 'SAMPLE-CODE');
  const canceled = await x.call(route('cancel'), { body: { loginId: browser.json.loginId } });
  assert.equal(canceled.status, 200);
  assert.deepEqual(canceled.json, { canceled: true });
  const logout = await x.call(route('logout'), { body: {} });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.json, { connected: false });
  assert.deepEqual(x.fake.calls, [
    { action: 'login', args: { type: 'chatgpt' } },
    { action: 'login', args: { type: 'chatgptDeviceCode' } },
    { action: 'cancel', args: { loginId: 'browser-flow' } },
    { action: 'logout' },
  ]);
  assert.deepEqual(await listRefs(), []);
});

test('subscription mutations reject credentials, arbitrary settings, and invalid types before the adapter', async t => {
  const x = await fixture(t);
  for (const action of ['login', 'cancel', 'logout']) {
    const valid = action === 'login' ? { type: 'chatgpt' } : action === 'cancel' ? { loginId: 'browser-flow' } : {};
    for (const key of ['password', 'token', 'apiKey', 'credentials', 'baseUrl', 'home', 'command', 'env']) {
      const result = await x.call(route(action), { body: { ...valid, [key]: 'PRIVATE_SENTINEL_NOT_FOR_ADAPTER' } });
      assert.equal(result.status, 400, `${action}: ${key}`);
      assert.doesNotMatch(result.text, /PRIVATE_SENTINEL_NOT_FOR_ADAPTER/);
    }
  }
  for (const type of ['apiKey', 'claude', 'chatgptAuthTokens', 'CHATGPT', '', null, false, 1, {}, []]) {
    assert.equal((await x.call(route('login'), { body: { type } })).status, 400, `login type ${JSON.stringify(type)}`);
  }
  for (const loginId of [null, '', 7, {}, [], 'x'.repeat(129)]) {
    assert.equal((await x.call(route('cancel'), { body: { loginId } })).status, 400, `cancel id ${JSON.stringify(loginId)}`);
  }
  for (const body of [null, [], 'password']) {
    assert.equal((await x.call(route('login'), { body })).status, 400, `non-object ${JSON.stringify(body)}`);
  }
  assert.deepEqual(x.fake.calls, []);
});

test('missing tokens and foreign origins cannot read or change a subscription', async t => {
  const x = await fixture(t);
  for (const [endpoint, body] of [
    [route(), undefined], ['/api/model/list?protocol=chatgpt', undefined],
    [route('login'), { type: 'chatgpt' }], [route('cancel'), { loginId: 'browser-flow' }], [route('logout'), {}],
    ['/api/model/test', { protocol: 'chatgpt' }],
  ]) {
    assert.equal((await x.call(endpoint, { body, token: null })).status, 401, `missing token: ${endpoint}`);
    assert.equal((await x.call(endpoint, { body, origin: 'https://foreign.example' })).status, 403, `foreign origin: ${endpoint}`);
  }
  assert.deepEqual(x.fake.calls, []);
});

test('the explicit model test uses the subscription adapter without an API key', async t => {
  const x = await fixture(t);
  const ignoredRef = 'subscription-test.unused';
  await setSecret(ignoredRef, 'PRIVATE_OLD_API_KEY_SENTINEL');
  t.after(() => deleteSecret(ignoredRef));
  const reply = await x.call('/api/model/test', { body: { protocol: 'chatgpt', baseUrl: 'https://chatgpt.com', model: 'auto', keyRef: ignoredRef } });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.ok, true);
  assert.equal(reply.json.sample, 'ready');
  assert.equal(reply.json.model, 'account-model');
  assert.equal(x.fake.calls.length, 1);
  const { action, args } = x.fake.calls[0];
  assert.equal(action, 'complete');
  assert.equal(args.protocol, 'chatgpt');
  assert.equal(args.model, 'auto');
  assert.equal(args.apiKey, null);
  assert.equal(args.maxTokens, 32);
  assert.deepEqual(args.messages, [{ role: 'user', content: 'Say ready.' }]);
  assert.doesNotMatch(reply.text, /PRIVATE_OLD_API_KEY_SENTINEL/);
  assert.deepEqual(await listRefs(), [ignoredRef], 'subscription testing neither consumes nor replaces a saved API key');
});

test('health reports connected subscriptions as configured with no key and disconnected accounts as unavailable', async t => {
  const x = await fixture(t);
  const connected = await x.call('/api/health');
  assert.equal(connected.status, 200);
  assert.equal(connected.json.model.configured, true);
  assert.equal(connected.json.model.protocol, 'chatgpt');
  assert.equal(connected.json.model.local, false);
  assert.equal(x.server.zelos.config.model.keyRef, null);
  x.fake.setConnected(false);
  const disconnected = await x.call('/api/health');
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.json.model.configured, false);
  assert.deepEqual(x.fake.calls.map(call => call.action), ['status', 'status']);
});

for (const method of ['stopBackgroundWork', 'cancelSignInsAndWait']) {
  test(`${method} waits for the subscription adapter to close`, async t => {
    const x = await fixture(t);
    let entered;
    const closing = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    x.fake.setCloseImpl(() => { entered(); return gate; });
    let finished = false;
    const shutdown = x.server.zelos[method]().then(() => { finished = true; });
    try {
      await closing;
      await new Promise(setImmediate);
      assert.equal(finished, false, 'shutdown completed before the account process closed');
      release();
      await shutdown;
      assert.equal(finished, true);
      assert.equal(x.fake.calls.filter(call => call.action === 'close').length, 1);
    } finally { release(); x.fake.setCloseImpl(async () => {}); }
  });
}

test('private Ask rejects a subscription with a spoofed local address before account reads or inference', async t => {
  const x = await fixture(t, { model: { baseUrl: 'http://127.0.0.1:11434/v1' } });
  const result = await x.call('/api/ask', { body: { question: 'Review my medications and prescriptions.' } });
  assert.equal(result.status, 409);
  assert.match(result.json.error, /require your local model/i);
  assert.deepEqual(x.fake.calls, [], 'private content reached the account adapter');
  assert.equal(x.db.prepare('SELECT COUNT(*) AS total FROM assistant_messages').get().total, 0);
});
