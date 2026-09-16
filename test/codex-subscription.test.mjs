import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCodexSubscription, discoverCodexCommand } from '../core/codex-subscription.mjs';

function fakeRuntime({ handler, configPatch, oldSchema = false, killDelayMs = 0, account = { type: 'chatgpt', email: 'person@example.test', planType: 'plus' } } = {}) {
  const calls = [], children = [], messages = [];
  const state = { account };
  function spawn(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      if (child.killed) return true;
      child.killed = true; child.signal = signal;
      const exit = () => child.emit('exit', null, signal);
      if (killDelayMs) setTimeout(exit, killDelayMs); else queueMicrotask(exit);
      return true;
    };
    calls.push({ command, args, options, child }); children.push(child);
    child.notify = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
    child.reply = (id, result) => child.stdout.write(`${JSON.stringify({ id, result })}\n`);
    child.rpcError = (id, message, code = -32000) => child.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
    if (args.includes('generate-json-schema')) {
      child.stdin = new PassThrough();
      queueMicrotask(async () => {
        const dir = args[args.indexOf('--out') + 1];
        await fs.mkdir(path.join(dir, 'v2'), { recursive: true });
        for (const name of ['ThreadStartParams', 'TurnStartParams']) await fs.writeFile(path.join(dir, 'v2', `${name}.json`), JSON.stringify({ properties: { ...(!oldSchema ? { environments: {} } : {}), baseInstructions: {}, ephemeral: {} } }));
        child.emit('exit', 0);
      });
      return child;
    }
    const config = {};
    for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
      const assignment = args[++i], index = assignment.indexOf('=');
      const key = assignment.slice(0, index), value = JSON.parse(assignment.slice(index + 1));
      if (key.startsWith('projects.')) continue;
      const names = key.split('.'); let target = config;
      for (const name of names.slice(0, -1)) target = target[name] ||= {};
      target[names.at(-1)] = value;
    }
    configPatch?.(config);
    let buffer = '';
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      buffer += chunk.toString(); let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        messages.push(message);
        queueMicrotask(() => {
          if (child.killed) return;
          if (handler?.(message, child, { state, config, options }) === true) return;
          const { id, method } = message;
          if (method === 'initialize') child.reply(id, { codexHome: options.env.CODEX_HOME, userAgent: 'test' });
          else if (method === 'config/read') child.reply(id, { config });
          else if (method === 'account/read') child.reply(id, { account: state.account });
          else if (method === 'account/rateLimits/read') child.reply(id, { rateLimits: { primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 123 }, secondary: null } });
          else if (method === 'thread/start') child.reply(id, { thread: { id: 'thread-1', ephemeral: true }, model: 'codex-test', modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: [] });
          else if (method === 'thread/inject_items' || method === 'turn/interrupt' || method === 'account/login/cancel') child.reply(id, {});
          else if (method === 'account/logout') { state.account = null; child.reply(id, {}); }
          else if (method === 'model/list') child.reply(id, { data: [{ id: 'catalog-1', model: 'codex-test', displayName: 'Test model', description: 'A model', isDefault: true }], nextCursor: null });
        });
      }
      callback();
    } });
    return child;
  }
  return { spawn, calls, children, messages, state };
}

async function setup(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zelos-chatgpt-test-'));
  const runtime = fakeRuntime(options);
  // Schema fixtures use real filesystem operations, which can take longer on
  // busy CI hosts. Timing-specific tests set their own short deadlines.
  const adapter = createCodexSubscription({ home, spawnImpl: runtime.spawn, resolveCommand: async () => ({ command: '/installed/codex', args: [] }), requestTimeoutMs: 5_000, ...options.adapter });
  t.after(async () => { await adapter.close(); await new Promise((resolve) => setImmediate(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  return { ...runtime, home, adapter };
}
const request = (text = 'Hello') => ({ model: 'auto', messages: [{ role: 'user', content: text }] });
function finish(child, { text = 'Hello back', early = false, turn = 'turn-1' } = {}) {
  const params = { threadId: 'thread-1', turnId: turn };
  child.notify('turn/started', { ...params, turn: { id: turn } });
  child.notify('item/started', { ...params, item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer' } });
  child.notify('item/agentMessage/delta', { ...params, itemId: 'answer-1', delta: text });
  child.notify('item/completed', { ...params, item: { id: 'answer-1', type: 'agentMessage', text } });
  child.notify('thread/tokenUsage/updated', { ...params, tokenUsage: { last: { inputTokens: 20, outputTokens: 3 } } });
  child.notify('turn/completed', { ...params, turn: { id: turn, status: 'completed' } });
}

test('missing executable gives an actionable status without running a process', async (t) => {
  const { adapter, calls } = await setup(t, { adapter: { resolveCommand: async () => null } });
  const status = await adapter.status();
  assert.equal(status.installed, false); assert.equal(status.connected, false);
  assert.match(status.error, /official Codex CLI/); assert.equal(calls.length, 0);
});

test('Windows npm shim resolves directly to its native executable, never a launcher or shell', async () => {
  const dir = 'C:\\Users\\A & B\\AppData\\Roaming\\npm';
  const binary = `${dir}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
  const command = await discoverCodexCommand({ platform: 'win32', arch: 'x64', env: { Path: dir }, userHome: 'C:\\Users\\A & B', access: async (file) => {
    if (![`${dir}\\codex.cmd`, binary].includes(file)) throw new Error('missing');
  }, readFile: async () => JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }) });
  assert.deepEqual(command, { command: binary, args: [] });
});

test('macOS GUI startup discovers standard install folders without a login shell', async () => {
  const visited = [];
  const command = await discoverCodexCommand({ platform: 'darwin', env: { PATH: '/usr/bin:relative' }, userHome: '/Users/nemo', realpath: async (file) => file, access: async (file) => { visited.push(file); if (file !== '/opt/homebrew/bin/codex') throw new Error(); } });
  assert.deepEqual(command, { command: '/opt/homebrew/bin/codex', args: [] });
  assert.deepEqual(visited, ['/usr/bin/codex', '/opt/homebrew/bin/codex']);
});

test('Linux user install discovery uses POSIX paths on every test host', async () => {
  const command = await discoverCodexCommand({ platform: 'linux', env: { PATH: 'relative:/missing' }, userHome: '/home/nemo', realpath: async (file) => file, access: async (file) => { if (file !== '/home/nemo/.local/bin/codex') throw new Error(); } });
  assert.deepEqual(command, { command: '/home/nemo/.local/bin/codex', args: [] });
});

test('older protocol without environment isolation is refused before app-server starts', async (t) => {
  const { adapter, calls } = await setup(t, { oldSchema: true });
  assert.match((await adapter.status()).error, /Update the official Codex CLI/);
  assert.equal(calls.length, 1);
});

test('effective tool configuration must be disabled even if managed config changes it', async (t) => {
  const { adapter, calls } = await setup(t, { configPatch: (config) => { config.features.shell_tool = true; } });
  assert.match((await adapter.status()).error, /Update the official Codex CLI/);
  assert.equal(calls.at(-1).child.killed, true);
});

test('isolates auth, strips inherited API keys and host controls, sanitizes account and rate limits', async (t) => {
  const { adapter, home, calls } = await setup(t, { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus', accessToken: 'never-return' }, adapter: { environment: { PATH: '/safe/bin', HOME: '/Users/nemo', CODEX_HOME: '/existing/codex', OPENAI_API_KEY: 'never-use', ANTHROPIC_API_KEY: 'never-use', CODEX_THREAD_ID: 'other-thread', NODE_OPTIONS: '--require bad.js' } } });
  const status = await adapter.status();
  const resolvedHome = await fs.realpath(home);
  assert.equal(status.connected, true);
  assert.deepEqual(status.account, { type: 'chatgpt', email: 'person@example.test', planType: 'plus' });
  assert.deepEqual(status.rateLimits.primary, { usedPercent: 21, windowDurationMins: 300, resetsAt: 123 });
  for (const { options } of calls) {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(options.env.CODEX_HOME.startsWith(resolvedHome));
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.CODEX_THREAD_ID, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
  }
  assert.equal(JSON.stringify(status).includes('never-return'), false);
});

test('an API-key account can never silently power the subscription route', async (t) => {
  const { adapter, messages } = await setup(t, { account: { type: 'apiKey' } });
  assert.equal((await adapter.status()).connected, false);
  await assert.rejects(adapter.complete(request()), { code: 'SUBSCRIPTION_SIGN_IN' });
  assert.equal(messages.some((message) => message.method === 'turn/start'), false);
});

test('preserves system and multi-turn roles, streams once, accepts completion before start reply', async (t) => {
  const { adapter, messages, calls } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { finish(child); child.reply(message.id, { turn: { id: 'turn-1' } }); return true; }
  } });
  const events = [];
  for await (const event of adapter.stream({ system: 'Speak briefly.', json: true, model: 'auto', messages: [{ role: 'user', content: 'My name is Ari.' }, { role: 'assistant', content: 'Hello Ari.' }, { role: 'user', content: 'What is my name?' }] })) events.push(event);
  assert.deepEqual(events, [{ type: 'delta', text: 'Hello back' }, { type: 'done', text: 'Hello back', usage: { input: 20, output: 3 }, model: 'codex-test', stopReason: 'stop' }]);
  const thread = messages.find((message) => message.method === 'thread/start').params;
  assert.equal(thread.model, undefined); assert.equal(thread.ephemeral, true); assert.deepEqual(thread.environments, []); assert.deepEqual(thread.runtimeWorkspaceRoots, []);
  assert.match(thread.baseInstructions, /Speak briefly/); assert.match(thread.baseInstructions, /single valid JSON/);
  assert.deepEqual(messages.find((message) => message.method === 'thread/inject_items').params.items.map((item) => item.role), ['user', 'assistant']);
  const turn = messages.find((message) => message.method === 'turn/start').params;
  assert.deepEqual(turn.environments, []); assert.deepEqual(turn.input, [{ type: 'text', text: 'What is my name?' }]);
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(calls.at(-1).child.killed, true);
});

test('a different thread cannot contaminate text or complete the active request', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') {
      child.notify('item/agentMessage/delta', { threadId: 'other-thread', turnId: 'turn-1', itemId: 'x', delta: 'wrong' });
      child.notify('turn/completed', { threadId: 'other-thread', turn: { id: 'turn-1', status: 'completed' } });
      child.reply(message.id, { turn: { id: 'turn-1' } }); finish(child); return true;
    }
  } });
  assert.equal((await adapter.complete(request())).text, 'Hello back');
});

test('server tool and approval requests fail closed without any grant', async (t) => {
  const { adapter, messages, calls } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.reply(message.id, { turn: { id: 'turn-1' } }); child.stdout.write(JSON.stringify({ id: 'approval-9', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } }) + '\n'); return true; }
  } });
  await assert.rejects(adapter.complete(request()), { code: 'SUBSCRIPTION_TOOL_BLOCKED' });
  assert.deepEqual(messages.find((message) => message.id === 'approval-9')?.error, { code: -32601, message: 'Zelos supports text responses only.' });
  assert.equal(calls.at(-1).child.killed, true);
});

test('tool execution item is rejected even without an approval request', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.reply(message.id, { turn: { id: 'turn-1' } }); child.notify('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution' } }); return true; }
  } });
  await assert.rejects(adapter.complete(request()), { code: 'SUBSCRIPTION_TOOL_BLOCKED' });
});

test('loaded AGENTS or a widened sandbox refuse the turn before any inference', async (t) => {
  const { adapter, messages } = await setup(t, { handler(message, child) {
    if (message.method === 'thread/start') { child.reply(message.id, { thread: { id: 'thread-1', ephemeral: true }, modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: 'readOnly' }, instructionSources: ['/outside/AGENTS.md'] }); return true; }
  } });
  await assert.rejects(adapter.complete(request()), { code: 'CODEX_UPDATE_REQUIRED' });
  assert.equal(messages.some((message) => message.method === 'turn/start'), false);
});

test('output cap fails instead of returning a truncated answer', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.reply(message.id, { turn: { id: 'turn-1' } }); finish(child, { text: 'too much text' }); return true; }
  } });
  await assert.rejects(adapter.complete({ ...request(), maxOutputBytes: 3 }), { code: 'SUBSCRIPTION_OUTPUT_LIMIT' });
});

test('abort stops a hanging turn and closes its process', async (t) => {
  const control = new AbortController();
  const { adapter, calls } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.reply(message.id, { turn: { id: 'turn-1' } }); setImmediate(() => control.abort()); return true; }
  } });
  await assert.rejects(adapter.complete({ ...request(), signal: control.signal }), { code: 'ABORTED' });
  assert.equal(calls.at(-1).child.killed, true);
});

test('idle timeout terminates silent inference and process', async (t) => {
  const { adapter, calls } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.reply(message.id, { turn: { id: 'turn-1' } }); return true; }
  } });
  await assert.rejects(adapter.complete({ ...request(), timeoutMs: 15 }), { code: 'SUBSCRIPTION_TIMEOUT' });
  assert.equal(calls.at(-1).child.killed, true);
});

test('leaving a stream early interrupts the turn and terminates the process', async (t) => {
  const { adapter, calls, messages } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.reply(message.id, { turn: { id: 'turn-1' } }); child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a', delta: 'partial' }); return true; }
  } });
  for await (const event of adapter.stream(request())) { assert.equal(event.text, 'partial'); break; }
  assert.equal(messages.some((message) => message.method === 'turn/interrupt'), true);
  assert.equal(calls.at(-1).child.killed, true);
});

test('malformed wire output and process crashes reject instead of hanging', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.stdout.write('not json\n'); return true; }
  } });
  await assert.rejects(adapter.complete(request()), { code: 'SUBSCRIPTION_PROTOCOL' });
});

test('provider usage errors are actionable and arbitrary credential text is never echoed', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.rpcError(message.id, 'Rate limit reached. access_token=secret-internal-value'); return true; }
  } });
  await assert.rejects(adapter.complete(request()), (error) => error.code === 'SUBSCRIPTION_LIMIT' && error.status === 429 && !error.message.includes('secret-internal'));
});

test('browser login returns only safe public fields and exposes terminal completion through status', async (t) => {
  const { adapter, state, children } = await setup(t, { account: null, handler(message, child) {
    if (message.method === 'account/login/start') { child.reply(message.id, { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize?state=opaque', accessToken: 'secret' }); return true; }
  } });
  assert.deepEqual(await adapter.startLogin(), { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize?state=opaque' });
  assert.equal((await adapter.status()).login.status, 'pending');
  state.account = { type: 'chatgpt', email: null, planType: 'plus' };
  children.at(-1).notify('account/login/completed', { loginId: 'login-1', success: true });
  const status = await adapter.status(); assert.equal(status.connected, true); assert.equal(status.login.status, 'complete');
  assert.equal(JSON.stringify(status).includes('authUrl'), false);
  await adapter.logout(); assert.equal((await adapter.status()).connected, false);
});

test('device login requires an official HTTPS URL and only returns the user verification code', async (t) => {
  const { adapter } = await setup(t, { account: null, handler(message, child) {
    if (message.method === 'account/login/start') { child.reply(message.id, { type: 'chatgptDeviceCode', loginId: 'login-2', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', deviceCode: 'private-device-secret' }); return true; }
  } });
  assert.deepEqual(await adapter.startLogin({ type: 'chatgptDeviceCode' }), { type: 'chatgptDeviceCode', loginId: 'login-2', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
  await assert.rejects(adapter.cancelLogin({ loginId: 'stale' }), { code: 'SUBSCRIPTION_LOGIN_STALE' });
  await adapter.cancelLogin({ loginId: 'login-2' }); assert.equal((await adapter.status()).login.status, 'canceled');
});

test('an untrusted auth URL is rejected', async (t) => {
  const { adapter } = await setup(t, { account: null, handler(message, child) {
    if (message.method === 'account/login/start') { child.reply(message.id, { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com.evil.test/signin' }); return true; }
  } });
  await assert.rejects(adapter.startLogin(), { code: 'SUBSCRIPTION_LOGIN_URL' });
});

test('models use provider slugs and pagination, omit hidden entries and unknown metadata', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'model/list') {
      child.reply(message.id, message.params.cursor ? { data: [{ model: 'second', displayName: 'Second', description: '', isDefault: false }], nextCursor: null } : { data: [{ id: 'not-the-model', model: 'first', displayName: 'First', isDefault: true, token: 'secret' }, { model: 'hidden', hidden: true }], nextCursor: 'page-2' }); return true;
    }
  } });
  assert.deepEqual(await adapter.models(), { models: [{ id: 'first', displayName: 'First', description: '', isDefault: true }, { id: 'second', displayName: 'Second', description: '', isDefault: false }], defaultModel: 'first' });
});

test('login completion arriving before its start reply is retained, including failures', async (t) => {
  const { adapter } = await setup(t, { account: null, handler(message, child) {
    if (message.method === 'account/login/start') {
      child.notify('account/login/completed', { loginId: 'early-login', success: false, error: 'refresh_token=never-return' });
      child.reply(message.id, { type: 'chatgpt', loginId: 'early-login', authUrl: 'https://auth.openai.com/authorize' }); return true;
    }
  } });
  await adapter.startLogin();
  const status = await adapter.status();
  assert.equal(status.login.status, 'failed'); assert.equal(status.login.error.includes('never-return'), false);
});

test('cancellation notification cannot overwrite the canceled state', async (t) => {
  const { adapter } = await setup(t, { account: null, handler(message, child) {
    if (message.method === 'account/login/start') { child.reply(message.id, { type: 'chatgpt', loginId: 'cancel-me', authUrl: 'https://auth.openai.com/authorize' }); return true; }
    if (message.method === 'account/login/cancel') { child.notify('account/login/completed', { loginId: 'cancel-me', success: false }); child.reply(message.id, {}); return true; }
  } });
  await adapter.startLogin(); await adapter.cancelLogin();
  assert.equal((await adapter.status()).login.status, 'canceled');
});

test('concurrent sign-in starts cancel the previous callback before opening another', async (t) => {
  let started = 0;
  const { adapter, messages } = await setup(t, { account: null, handler(message, child) {
    if (message.method === 'account/login/start') { child.reply(message.id, { type: 'chatgpt', loginId: `login-${++started}`, authUrl: 'https://auth.openai.com/authorize' }); return true; }
  } });
  await Promise.all([adapter.startLogin(), adapter.startLogin()]);
  assert.deepEqual(messages.filter((message) => message.method.startsWith('account/login/')).map((message) => message.method), ['account/login/start', 'account/login/cancel', 'account/login/start']);
  assert.equal((await adapter.status()).login.loginId, 'login-2');
});

test('commentary is excluded from structured final output', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') {
      const params = { threadId: 'thread-1', turnId: 'turn-1' };
      child.reply(message.id, { turn: { id: 'turn-1' } });
      child.notify('item/started', { ...params, item: { type: 'agentMessage', id: 'commentary-1', phase: 'commentary' } });
      child.notify('item/agentMessage/delta', { ...params, itemId: 'commentary-1', delta: 'Let me think.' });
      child.notify('item/completed', { ...params, item: { type: 'agentMessage', id: 'commentary-1', text: 'Let me think.', phase: 'commentary' } });
      finish(child, { text: '{"answer":42}' }); return true;
    }
  } });
  assert.equal((await adapter.complete({ ...request(), json: true })).text, '{"answer":42}');
});

test('partial deltas append only the missing final suffix', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') {
      const params = { threadId: 'thread-1', turnId: 'turn-1' };
      child.reply(message.id, { turn: { id: 'turn-1' } });
      child.notify('item/agentMessage/delta', { ...params, itemId: 'a', delta: 'Part' });
      child.notify('item/completed', { ...params, item: { type: 'agentMessage', id: 'a', text: 'Part two' } });
      child.notify('turn/completed', { ...params, turn: { id: 'turn-1', status: 'completed' } }); return true;
    }
  } });
  assert.equal((await adapter.complete(request())).text, 'Part two');
});

test('process exit while running is an error, never a successful partial completion', async (t) => {
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') {
      child.reply(message.id, { turn: { id: 'turn-1' } });
      child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a', delta: 'partial' });
      child.emit('exit', 1); return true;
    }
  } });
  await assert.rejects(adapter.complete(request()), { code: 'SUBSCRIPTION_CLOSED' });
});

test('disconnect terminates an active completion before clearing Zelos-owned sign-in', async (t) => {
  let ready;
  const began = new Promise((resolve) => { ready = resolve; });
  const { adapter } = await setup(t, { handler(message, child) {
    if (message.method === 'turn/start') { child.reply(message.id, { turn: { id: 'turn-1' } }); ready(); return true; }
  } });
  const completion = adapter.complete(request());
  const rejected = assert.rejects(completion, { code: 'ABORTED' });
  await began; await adapter.logout(); await rejected;
  assert.equal((await adapter.status()).connected, false);
});

test('logout invalidates an in-flight login and queued logins before any late reply can reconnect', async (t) => {
  let started, release;
  const began = new Promise((resolve) => { started = resolve; });
  const { adapter, messages } = await setup(t, { account: null, handler(message, child) {
    if (message.method === 'account/login/start') {
      release = () => {
        child.reply(message.id, { type: 'chatgpt', loginId: 'obsolete-login', authUrl: 'https://auth.openai.com/authorize' });
        child.notify('account/login/completed', { loginId: 'obsolete-login', success: true });
      };
      started(child); return true;
    }
  } });
  const first = assert.rejects(adapter.startLogin(), { code: 'ABORTED' });
  const child = await began;
  const queued = assert.rejects(adapter.startLogin(), { code: 'ABORTED' });
  await adapter.logout();
  assert.equal(child.killed, true);
  release();
  await Promise.all([first, queued]);
  const status = await adapter.status();
  assert.equal(status.connected, false); assert.equal(status.login, null);
  assert.equal(messages.filter((message) => message.method === 'account/login/start').length, 1);
});

test('close returns while executable discovery is held and no process spawns when discovery resolves later', async (t) => {
  let entered, resolveDiscovery;
  const reached = new Promise((resolve) => { entered = resolve; });
  const discovery = new Promise((resolve) => { resolveDiscovery = resolve; });
  const { adapter, calls } = await setup(t, { adapter: { resolveCommand: () => { entered(); return discovery; } } });
  const completion = assert.rejects(adapter.complete(request()), { code: 'ABORTED' });
  await reached;
  await adapter.close();
  resolveDiscovery({ command: '/installed/codex', args: [] });
  await completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('logout waits for completion process exit before clearing credentials', async (t) => {
  let began, exited = false, logoutSawExited = false;
  const ready = new Promise((resolve) => { began = resolve; });
  const { adapter } = await setup(t, { killDelayMs: 30, handler(message, child) {
    if (message.method === 'turn/start') {
      child.once('exit', () => { exited = true; });
      child.reply(message.id, { turn: { id: 'turn-1' } }); began(); return true;
    }
    if (message.method === 'account/logout') logoutSawExited = exited;
  } });
  const completion = assert.rejects(adapter.complete(request()), { code: 'ABORTED' });
  await ready; await adapter.logout(); await completion;
  assert.equal(logoutSawExited, true);
});

test('concurrent disconnects share one credential-clear operation and sign-in cannot queue during it', async (t) => {
  let entered, release;
  const enteredLogout = new Promise((resolve) => { entered = resolve; });
  const { adapter, messages } = await setup(t, { handler(message, child, { state }) {
    if (message.method === 'account/logout') {
      release = () => { state.account = null; child.reply(message.id, {}); };
      entered(); return true;
    }
  } });
  const first = adapter.logout();
  const second = adapter.logout();
  await enteredLogout;
  await assert.rejects(adapter.startLogin(), { code: 'ABORTED' });
  release(); await Promise.all([first, second]);
  assert.equal(messages.filter((message) => message.method === 'account/logout').length, 1);
  assert.equal(messages.some((message) => message.method === 'account/login/start'), false);
});
