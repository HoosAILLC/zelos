/**
 * ChatGPT subscriptions through the installed, unmodified Codex app-server.
 * Protocol: https://learn.chatgpt.com/docs/app-server
 * Configuration: https://learn.chatgpt.com/docs/config-file/config-reference
 *
 * The CLI owns browser sign-in and refresh. Its private CODEX_HOME belongs to
 * Zelos; we never read tokens or use the user's existing Codex login/config.
 * Every completion gets an ephemeral text-only thread in an empty directory.
 * Modern environment isolation is mandatory, never a best-effort fallback.
 */
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { paths } from './config.mjs';

const INSTALL_URL = 'https://learn.chatgpt.com/docs/cli';
const REQUEST_TIMEOUT = 20_000;
const LOGIN_TIMEOUT = 15 * 60_000;
const MAX_INPUT = 2 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_WIRE = 32 * 1024 * 1024;
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'browser_use',
  'computer_use', 'image_generation', 'multi_agent', 'hooks', 'memories',
  'skill_search', 'tool_suggest', 'workspace_dependencies', 'code_mode',
  'code_mode_host', 'view_image', 'skill_mcp_dependency_install',
];
const FIXED_CONFIG = {
  ...Object.fromEntries(DISABLED_FEATURES.map((key) => [`features.${key}`, false])),
  'features.skip_host_skill_discovery': true,
  'agents.enabled': false,
  project_doc_max_bytes: 0,
  project_doc_fallback_filenames: [],
  web_search: 'disabled',
  forced_login_method: 'chatgpt',
  cli_auth_credentials_store: 'file',
  model_provider: 'openai',
  chatgpt_base_url: 'https://chatgpt.com/backend-api/',
  mcp_servers: {},
  plugins: {},
  notify: [],
  'history.persistence': 'none',
  'analytics.enabled': false,
  'shell_environment_policy.inherit': 'none',
  allow_login_shell: false,
  sandbox_mode: 'read-only',
  approval_policy: 'never',
};

export class CodexSubscriptionError extends Error {
  constructor(message, { code = 'SUBSCRIPTION_ERROR', status = 503, retriable = false } = {}) {
    super(message);
    this.name = 'CodexSubscriptionError';
    this.code = code;
    this.status = status;
    this.retriable = retriable;
    this.address = 'https://chatgpt.com';
  }
}
const failure = (message, code, status = 503) => new CodexSubscriptionError(message, { code, status });
const unavailable = () => failure('Install or update the official Codex CLI, then try ChatGPT sign-in again.', 'CODEX_NOT_INSTALLED');
const incompatible = () => failure('Update the official Codex CLI. This version cannot provide the isolated ChatGPT connection Zelos requires.', 'CODEX_UPDATE_REQUIRED');
const aborted = () => failure('The ChatGPT request was canceled.', 'ABORTED', 499);
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const clipped = (value, max = 256) => typeof value === 'string' ? value.slice(0, max) : null;
const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
function remoteError(error) {
  // Classify provider errors without exposing arbitrary server text, tokens,
  // filesystem paths, or the user's prompt to an HTTP response or log.
  const message = String(error?.message || error?.error?.message || '');
  if (/rate.?limit|usage.?limit|quota|credits/i.test(message)) return failure('Your ChatGPT usage limit has been reached. Wait for it to reset or choose another model connection.', 'SUBSCRIPTION_LIMIT', 429);
  if (/auth|login|sign.?in|unauthorized|token.*expir/i.test(message)) return failure('Sign in to ChatGPT again in Zelos Settings.', 'SUBSCRIPTION_SIGN_IN', 401);
  if (/unknown (field|variant|method)|unsupported|invalid (params|configuration)|not initialized|experimental/i.test(message) || error?.code === -32601) return incompatible();
  return failure('ChatGPT could not finish this request. Check the connection and try again.', 'SUBSCRIPTION_REQUEST_FAILED');
}

function toml(value) {
  if (plain(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function configArgs(extra = {}) {
  return Object.entries({ ...FIXED_CONFIG, ...extra }).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
}

/** No shell is launched, including for Windows npm's codex.cmd shim. */
export async function discoverCodexCommand({ platform = process.platform, arch = process.arch, env = process.env, userHome = os.homedir(), access = fs.access, readFile = fs.readFile, realpath = fs.realpath } = {}) {
  // Use the requested platform's path rules even when discovery is tested on
  // another OS. Node's default `path` follows the host, not this argument.
  const p = platform === 'win32' ? path.win32 : path.posix;
  const get = (key) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || '';
  const dirs = get('PATH').split(platform === 'win32' ? ';' : ':').filter((dir) => dir && p.isAbsolute(dir));
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', p.join(userHome, '.local/bin'), '/Applications/Codex.app/Contents/Resources', '/Applications/ChatGPT.app/Contents/Resources');
  if (platform === 'win32') {
    if (get('APPDATA')) dirs.push(p.join(get('APPDATA'), 'npm'));
    if (get('LOCALAPPDATA')) dirs.push(p.join(get('LOCALAPPDATA'), 'Programs', 'Codex'));
    dirs.push(p.join(userHome, '.local', 'bin'));
  }
  if (platform === 'linux') dirs.push('/usr/local/bin', p.join(userHome, '.local/bin'));
  for (const dir of new Set(dirs)) {
    for (const leaf of platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']) {
      const file = p.join(dir, leaf);
      try { await access(file, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK); } catch { continue; }
      const resolved = await realpath(file).catch(() => file);
      if (!file.toLowerCase().endsWith('.cmd') && !resolved.endsWith('/bin/codex.js')) return { command: file, args: [] };
      // Resolve the native binary from the official npm package. In particular
      // on Windows, killing a Node/npm launcher can orphan its native child.
      // Do not execute .cmd shell text or place another launcher in between.
      const packageDir = platform === 'win32' ? p.join(dir, 'node_modules', '@openai', 'codex') : p.dirname(p.dirname(resolved));
      try {
        const pkg = JSON.parse(await readFile(p.join(packageDir, 'package.json'), 'utf8'));
        if (pkg.name !== '@openai/codex' || pkg.bin?.codex !== 'bin/codex.js') continue;
        const target = ({ win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }, darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' }, linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' } })[platform]?.[arch];
        if (!target) continue;
        const platformPackage = `codex-${platform}-${arch}`;
        const packageRoots = [p.join(p.dirname(packageDir), platformPackage), p.join(packageDir, 'node_modules', '@openai', platformPackage), packageDir];
        for (const root of packageRoots) for (const binDir of ['bin', 'codex']) {
          const binary = p.join(root, 'vendor', target, binDir, platform === 'win32' ? 'codex.exe' : 'codex');
          try { await access(binary, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK); return { command: binary, args: [] }; } catch { /* Try the next supported package layout. */ }
        }
      } catch { /* A nonstandard shim is not safe to execute as shell text. */ }
    }
  }
  return null;
}

function childEnvironment(codexHome, command, environment) {
  const env = {};
  // Preserve OS/runtime essentials; do not inherit provider API keys, proxy
  // credentials, NODE_OPTIONS, or any of the host app's Codex control variables.
  const allowed = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  for (const [key, value] of Object.entries(environment)) if (allowed.test(key) && typeof value === 'string') env[key] = value;
  env.CODEX_HOME = codexHome;
  return env;
}

async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('The private ChatGPT connection folder is not a regular directory.', 'SUBSCRIPTION_STORAGE');
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
  return fs.realpath(dir);
}

class RpcClient {
  constructor(child, { timeoutMs = REQUEST_TIMEOUT } = {}) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.error = null;
    this.buffer = '';
    this.bytes = 0;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (data) => {
      this.bytes += Buffer.byteLength(data);
      if (this.bytes > MAX_WIRE) return this.stop(failure('The ChatGPT connection exceeded its response limit.', 'SUBSCRIPTION_OUTPUT_LIMIT'));
      this.buffer += decoder.write(data);
      if (Buffer.byteLength(this.buffer) > MAX_LINE && !this.buffer.includes('\n')) return this.stop(failure('The ChatGPT connection returned an oversized response.', 'SUBSCRIPTION_OUTPUT_LIMIT'));
      let index;
      while (!this.error && (index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_LINE) { this.stop(failure('The ChatGPT connection returned an oversized response.', 'SUBSCRIPTION_OUTPUT_LIMIT')); break; }
        let message;
        try { message = JSON.parse(line); } catch { this.stop(failure('The ChatGPT connection returned an invalid response.', 'SUBSCRIPTION_PROTOCOL')); break; }
        this.receive(message);
      }
    });
    child.stderr.on('data', () => {}); // Drain, but never log raw auth/protocol data.
    child.stdin.on('error', () => this.stop(failure('The ChatGPT connection closed unexpectedly.', 'SUBSCRIPTION_CLOSED')));
    child.on('error', () => { this.stop(unavailable()); this.resolveClosed(); });
    child.on('exit', () => {
      clearTimeout(this.killTimer);
      this.stop(failure('The ChatGPT connection closed unexpectedly.', 'SUBSCRIPTION_CLOSED'), false);
      this.resolveClosed();
    });
  }
  receive(message) {
    if (!plain(message)) return this.stop(failure('The ChatGPT connection returned an invalid response.', 'SUBSCRIPTION_PROTOCOL'));
    if (message.method && message.id !== undefined) {
      // No approval, tool call, filesystem request, or external-token refresh
      // may be serviced by this text adapter. Refuse and close immediately.
      this.send({ id: message.id, error: { code: -32601, message: 'Zelos supports text responses only.' } });
      return this.stop(failure('ChatGPT requested a tool that is disabled in this connection. No tool was approved.', 'SUBSCRIPTION_TOOL_BLOCKED'));
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(remoteError(message.error));
      else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else entry.reject(failure('The ChatGPT connection returned an invalid response.', 'SUBSCRIPTION_PROTOCOL'));
      return;
    }
    if (typeof message.method === 'string') for (const fn of this.listeners) fn(message.method, message.params || {});
  }
  send(message) {
    if (this.error) throw this.error;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { this.stop(failure('The ChatGPT connection closed unexpectedly.', 'SUBSCRIPTION_CLOSED')); throw this.error; }
  }
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.error) return Promise.reject(this.error);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(failure('The ChatGPT connection timed out. Try again.', 'SUBSCRIPTION_TIMEOUT')), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  stop(error = aborted(), kill = true) {
    if (this.error) return;
    this.error = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    for (const fn of this.listeners) fn('$closed', { error });
    this.listeners.clear();
    if (kill) {
      try { this.child.stdin.end(); this.child.kill('SIGTERM'); } catch { /* already closed */ }
      this.killTimer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* already closed */ } }, 500);
      this.killTimer.unref?.();
    }
  }
}

function verifyConfig(config) {
  if (!plain(config)) throw incompatible();
  for (const feature of DISABLED_FEATURES) if (config.features?.[feature] !== false) throw incompatible();
  if (config.features?.skip_host_skill_discovery !== true || config.agents?.enabled !== false || config.project_doc_max_bytes !== 0
      || config.web_search !== 'disabled' || config.forced_login_method !== 'chatgpt' || config.cli_auth_credentials_store !== 'file'
      || config.model_provider !== 'openai' || config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/'
      || config.sandbox_mode !== 'read-only' || config.approval_policy !== 'never'
      || Object.keys(config.mcp_servers || {}).length || Object.keys(config.plugins || {}).length
      || (config.notify && config.notify.length)) throw incompatible();
}

function safeAccount(result) {
  const account = result?.account;
  return account?.type === 'chatgpt' ? { type: 'chatgpt', email: clipped(account.email), planType: clipped(account.planType, 80) } : null;
}
function safeLimits(result) {
  const data = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  const window = (value) => plain(value) ? { usedPercent: number(value.usedPercent), windowDurationMins: number(value.windowDurationMins), resetsAt: number(value.resetsAt) } : null;
  return plain(data) ? { primary: window(data.primary), secondary: window(data.secondary) } : null;
}
function loginUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || (url.port && url.port !== '443')) throw new Error();
    return url.href;
  } catch { throw failure('ChatGPT returned an unrecognized sign-in address. Update Codex and try again.', 'SUBSCRIPTION_LOGIN_URL'); }
}

/** Factory dependencies support protocol tests without sign-in or inference. */
export function createCodexSubscription({ home, spawnImpl = spawn, resolveCommand = discoverCodexCommand, environment = process.env, requestTimeoutMs = REQUEST_TIMEOUT, loginTimeoutMs = LOGIN_TIMEOUT } = {}) {
  let installation, authClient, authStarting, login = null, loginTimer, idleTimer, shuttingDown = false;
  let generation = 0, signingOut = false;
  let logoutOperation = null, closeOperation = null;
  let generationController = new AbortController();
  const shutdownController = new AbortController();
  let loginOperation = Promise.resolve();
  const loginCompletions = new Map();
  const probes = new Set();
  const clients = new Set();
  const directories = new Set();
  const setups = new Set();
  const checkRunning = () => { if (shuttingDown) throw aborted(); };
  const checkGeneration = (expected) => { checkRunning(); if (generation !== expected) throw aborted(); };
  function interruptible(operation, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(aborted());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(operation).then((value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(aborted()); else resolve(value);
      }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
  }
  let preparation;
  async function prepare() {
    checkRunning();
    if (!preparation) preparation = (async () => {
      const base = path.resolve(home || paths().home);
      const connectionHome = await privateDirectory(path.join(base, 'chatgpt-subscription'));
      checkRunning();
      const codexHome = await privateDirectory(path.join(connectionHome, 'codex'));
      checkRunning();
      const scratchRoot = await privateDirectory(path.join(connectionHome, 'scratch'));
      checkRunning();
      return { codexHome, scratchRoot };
    })();
    return preparation;
  }
  async function scratch() {
    const { scratchRoot } = await prepare();
    checkRunning();
    const dir = await fs.mkdtemp(path.join(scratchRoot, 'request-'));
    directories.add(dir);
    if (shuttingDown) { await removeScratch(dir); throw aborted(); }
    return dir;
  }
  async function removeScratch(dir) { directories.delete(dir); await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  async function getInstallation() {
    checkRunning();
    if (!installation) installation = (async () => {
      const command = await interruptible(resolveCommand(), shutdownController.signal);
      checkRunning();
      if (!command?.command || !path.isAbsolute(command.command)) throw unavailable();
      const dir = await scratch();
      // Unknown JSON fields are ignored by older servers. Inspect this exact
      // installed binary's generated schema before relying on environments:[].
      try {
        checkRunning();
        const { codexHome } = await prepare();
        checkRunning();
        await new Promise((resolve, reject) => {
          let child;
          try { child = spawnImpl(command.command, [...(command.args || []), 'app-server', 'generate-json-schema', '--experimental', '--out', dir], { cwd: dir, env: childEnvironment(codexHome, command, environment), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true }); } catch { reject(unavailable()); return; }
          let bytes = 0;
          probes.add(child);
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(incompatible()); }, requestTimeoutMs);
          const output = (data) => { bytes += data.length; if (bytes > MAX_LINE) { child.kill('SIGKILL'); reject(incompatible()); } };
          child.stdout.on('data', output); child.stderr.on('data', output);
          child.on('error', () => { probes.delete(child); clearTimeout(timer); reject(unavailable()); });
          child.on('exit', (code) => { probes.delete(child); clearTimeout(timer); code === 0 ? resolve() : reject(incompatible()); });
        });
        checkRunning();
        const [thread, turn] = await Promise.all(['ThreadStartParams', 'TurnStartParams'].map(async (name) => JSON.parse(await fs.readFile(path.join(dir, 'v2', `${name}.json`), 'utf8'))));
        checkRunning();
        if (!thread.properties?.environments || !thread.properties?.baseInstructions || !thread.properties?.ephemeral || !turn.properties?.environments) throw incompatible();
      } catch (error) { throw error instanceof CodexSubscriptionError ? error : incompatible(); }
      finally { await removeScratch(dir); }
      return command;
    })().catch((error) => { installation = null; throw error; });
    return installation;
  }
  function openClient() {
    const operation = openClientForGeneration(generation, generationController.signal);
    setups.add(operation);
    // Both handlers consume failures; the caller still receives the original
    // rejected promise. Shutdown can drain every setup without leaked promises.
    operation.then(() => setups.delete(operation), () => setups.delete(operation));
    return operation;
  }
  async function openClientForGeneration(expected, signal) {
    checkGeneration(expected);
    const command = await interruptible(getInstallation(), signal);
    checkGeneration(expected);
    const { codexHome } = await prepare();
    checkGeneration(expected);
    const dir = await scratch();
    let client;
    try {
      checkGeneration(expected);
      const child = spawnImpl(command.command, [...(command.args || []), 'app-server', '--listen', 'stdio://', '--strict-config', ...configArgs({ [`projects.${JSON.stringify(dir)}.trust_level`]: 'untrusted' })], {
        cwd: dir, env: childEnvironment(codexHome, command, environment), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
      client = new RpcClient(child, { timeoutMs: requestTimeoutMs });
      client.cwd = dir;
      client.generation = expected;
      clients.add(client);
      child.once('exit', () => { clients.delete(client); void removeScratch(dir); });
      const init = await client.request('initialize', { clientInfo: { name: 'zelos', title: 'Zelos', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      checkGeneration(expected);
      // This prevents accidentally connecting to a daemon or sharing host auth.
      if (path.resolve(init?.codexHome || '.') !== path.resolve(codexHome)) throw incompatible();
      client.send({ method: 'initialized', params: {} });
      verifyConfig((await client.request('config/read', { includeLayers: false })).config);
      checkGeneration(expected);
      return client;
    } catch (error) { client?.stop(error); if (client) await client.closed; else await removeScratch(dir); throw error; }
  }
  function idle() {
    clearTimeout(idleTimer);
    if (shuttingDown || signingOut || login?.status === 'pending') return;
    idleTimer = setTimeout(() => { authClient?.stop(); authClient = null; }, 60_000);
    idleTimer.unref?.();
  }
  async function auth() {
    checkRunning();
    if (signingOut) throw aborted();
    if (authClient && !authClient.error) { idle(); return authClient; }
    if (!authStarting) authStarting = openClient().then((client) => {
      checkGeneration(client.generation);
      if (signingOut) { client.stop(); throw aborted(); }
      authClient = client;
      client.listeners.add((method, params) => {
        if (shuttingDown || signingOut || client.generation !== generation) return;
        if (method === 'account/login/completed' && typeof params.loginId === 'string') {
          loginCompletions.set(params.loginId, params.success === true);
          if (loginCompletions.size > 16) loginCompletions.delete(loginCompletions.keys().next().value);
        }
        if (method === 'account/login/completed' && login?.status === 'pending' && params.loginId === login.loginId) {
          login = { ...login, status: params.success ? 'complete' : 'failed', error: params.success ? null : 'ChatGPT sign-in did not finish. Try again.' };
          clearTimeout(loginTimer); idle();
        }
        if (method === '$closed' && login?.status === 'pending') { login = { ...login, status: 'failed', error: 'The ChatGPT connection closed. Try signing in again.' }; clearTimeout(loginTimer); }
      });
      idle();
      return client;
    }).finally(() => { authStarting = null; });
    return authStarting;
  }
  async function status() {
    try {
      const client = await auth();
      const account = safeAccount(await client.request('account/read', { refreshToken: false }));
      let rateLimits = null;
      if (account) rateLimits = safeLimits(await client.request('account/rateLimits/read').catch(() => null));
      checkGeneration(client.generation);
      if (signingOut) throw aborted();
      return { installed: true, connected: !!account, account, login: login ? { ...login } : null, rateLimits, error: null };
    } catch (error) {
      return { installed: error.code !== 'CODEX_NOT_INSTALLED', connected: false, account: null, login: login ? { ...login } : null, rateLimits: null, error: error instanceof CodexSubscriptionError ? error.message : 'The ChatGPT connection is unavailable.' };
    }
  }
  function startLogin(opts = {}) {
    // A double click must not open two OAuth callbacks or orphan the first.
    if (shuttingDown || signingOut) return Promise.reject(aborted());
    const expected = generation;
    const operation = loginOperation.then(() => beginLogin(opts, expected));
    loginOperation = operation.catch(() => {});
    return operation;
  }
  async function beginLogin({ type = 'chatgpt' } = {}, expected) {
    checkGeneration(expected);
    if (signingOut) throw aborted();
    if (!['chatgpt', 'chatgptDeviceCode'].includes(type)) throw failure('Choose browser sign-in or device-code sign-in.', 'SUBSCRIPTION_LOGIN_TYPE', 400);
    const client = await auth();
    checkGeneration(expected);
    if (login?.status === 'pending') await cancelLogin({ loginId: login.loginId });
    checkGeneration(expected);
    if (signingOut) throw aborted();
    const result = await client.request('account/login/start', type === 'chatgpt' ? { type, useHostedLoginSuccessPage: true, appBrand: 'chatgpt' } : { type });
    if (shuttingDown || signingOut || expected !== generation) {
      // The RPC may resolve just before disconnect invalidates this operation.
      // Cancel a known obsolete callback when possible, then close its owner.
      if (!client.error && typeof result?.loginId === 'string') {
        try { client.send({ id: client.nextId++, method: 'account/login/cancel', params: { loginId: result.loginId } }); } catch { /* Stop below. */ }
      }
      client.stop(); await client.closed; throw aborted();
    }
    if (result?.type !== type || typeof result.loginId !== 'string' || !result.loginId || result.loginId.length > 200) throw incompatible();
    let normalized;
    try {
      normalized = type === 'chatgpt'
        ? { type, loginId: result.loginId, authUrl: loginUrl(result.authUrl) }
        : { type, loginId: result.loginId, verificationUrl: loginUrl(result.verificationUrl), userCode: clipped(result.userCode, 100) };
      if (type === 'chatgptDeviceCode' && !normalized.userCode) throw incompatible();
    } catch (error) { client.stop(error); throw error; }
    login = { loginId: result.loginId, type, status: 'pending', error: null };
    clearTimeout(idleTimer); clearTimeout(loginTimer);
    if (loginCompletions.has(login.loginId)) {
      const success = loginCompletions.get(login.loginId);
      login = { ...login, status: success ? 'complete' : 'failed', error: success ? null : 'ChatGPT sign-in did not finish. Try again.' };
      loginCompletions.delete(login.loginId); idle();
      return normalized;
    }
    loginTimer = setTimeout(() => { void cancelLogin({ loginId: result.loginId }).catch(() => { client.stop(); }); }, loginTimeoutMs);
    loginTimer.unref?.();
    return normalized;
  }
  async function cancelLogin({ loginId } = {}) {
    if (!login || login.status !== 'pending') return { canceled: true };
    if (loginId && loginId !== login.loginId) throw failure('That sign-in attempt is no longer active.', 'SUBSCRIPTION_LOGIN_STALE', 409);
    const id = login.loginId;
    // Mark it first: the canceled notification may arrive before the reply.
    login = { ...login, status: 'canceled', error: null }; clearTimeout(loginTimer);
    if (authClient && !authClient.error) await authClient.request('account/login/cancel', { loginId: id });
    idle();
    return { canceled: true };
  }
  function logout() {
    if (logoutOperation) return logoutOperation;
    if (shuttingDown) return Promise.reject(aborted());
    signingOut = true; generation++;
    generationController.abort(); generationController = new AbortController();
    clearTimeout(loginTimer); clearTimeout(idleTimer);
    login = null; loginCompletions.clear();
    // Stop even the auth client: a start-login request can be in flight before
    // a loginId exists. Closing its process removes its browser callback too.
    const stopped = [...clients];
    for (const client of stopped) client.stop(aborted());
    logoutOperation = (async () => {
      await Promise.allSettled([...setups]);
      await Promise.all(stopped.map((client) => client.closed));
      await loginOperation;
      await authStarting?.catch(() => {});
      checkRunning();
      authClient = null;
      // No previous process may still refresh/write auth when this clears it.
      const client = await openClient();
      try {
        checkRunning();
        await client.request('account/logout');
      } finally { client.stop(); await client.closed; }
      return { connected: false };
    })().finally(() => { signingOut = false; logoutOperation = null; });
    return logoutOperation;
  }
  async function models() {
    const client = await auth();
    const account = safeAccount(await client.request('account/read', { refreshToken: false }));
    if (!account) throw failure('Sign in to ChatGPT in Zelos Settings first.', 'SUBSCRIPTION_SIGN_IN', 401);
    const list = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const response = await client.request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response?.data)) throw incompatible();
      for (const item of response.data) if (!item.hidden && typeof item.model === 'string' && item.model.length <= 200) list.push({ id: item.model, displayName: clipped(item.displayName) || item.model, description: clipped(item.description, 1000) || '', isDefault: item.isDefault === true });
      if (!response.nextCursor) break;
      if (response.nextCursor === cursor || page === 9) throw failure('ChatGPT returned an incomplete model list. Try again.', 'SUBSCRIPTION_MODELS');
      cursor = response.nextCursor;
    }
    return { models: [...new Map(list.map((item) => [item.id, item])).values()], defaultModel: list.find((item) => item.isDefault)?.id || null };
  }

  async function* stream(opts = {}) {
    const currentGeneration = generation;
    const checkActive = () => { if (shuttingDown || signingOut || generation !== currentGeneration || opts.signal?.aborted) throw aborted(); };
    checkActive();
    const conversation = [];
    const instructions = [];
    if (typeof opts.system === 'string' && opts.system) instructions.push(opts.system);
    for (const message of opts.messages || []) {
      if (!['system', 'developer', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string') throw failure('This ChatGPT connection accepts text messages only.', 'SUBSCRIPTION_TEXT_ONLY', 400);
      if (message.role === 'system' || message.role === 'developer') instructions.push(message.content);
      else conversation.push({ role: message.role, content: message.content });
    }
    if (!conversation.length || conversation.at(-1).role !== 'user') throw failure('Provide a user message for ChatGPT.', 'SUBSCRIPTION_INPUT', 400);
    const instructionsText = [
      'You are the language model inside Zelos, a personal assistant. Answer only using the conversation and information supplied to you. Return the requested answer as text. Never call tools, read files, execute commands, browse, follow skill references, or act on the computer. Zelos handles any user-approved actions separately.',
      ...instructions,
      ...(opts.json ? ['Reply with a single valid JSON object only. Do not wrap it in Markdown or add any other text.'] : []),
    ].join('\n\n');
    if (Buffer.byteLength(instructionsText) + Buffer.byteLength(JSON.stringify(conversation)) > MAX_INPUT) throw failure('This request is too large for the ChatGPT connection. Reduce the supplied context.', 'SUBSCRIPTION_INPUT_LIMIT', 413);
    if (opts.model && (typeof opts.model !== 'string' || opts.model.length > 200)) throw failure('Choose a valid ChatGPT model.', 'SUBSCRIPTION_MODEL', 400);
    let client, idleDeadline, totalDeadline, turnId = null, threadId = null, completed = false;
    let resultError = null, done = false, wake;
    const queue = [];
    let text = '', usage = { input: 0, output: 0 }, selectedModel = opts.model || 'auto';
    const itemText = new Map();
    const commentaryItems = new Set();
    const outputLimit = Number.isFinite(opts.maxOutputBytes) ? Math.max(1, Math.min(MAX_OUTPUT, opts.maxOutputBytes)) : Math.min(MAX_OUTPUT, Math.max(32_768, (Number(opts.maxTokens) || 4096) * 16));
    const push = (event) => { queue.push(event); wake?.(); wake = null; };
    const fail = (error) => { if (done) return; resultError = error; done = true; client?.stop(error); wake?.(); wake = null; };
    const activity = () => { clearTimeout(idleDeadline); idleDeadline = setTimeout(() => fail(failure('ChatGPT stopped responding. Try again.', 'SUBSCRIPTION_TIMEOUT')), Number.isFinite(opts.timeoutMs) ? Math.max(1, opts.timeoutMs) : 120_000); };
    const onAbort = () => fail(aborted());
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      client = await openClient();
      checkActive();
      if (done) throw aborted();
      const account = safeAccount(await client.request('account/read', { refreshToken: false }));
      checkActive();
      if (!account) throw failure('Sign in to ChatGPT in Zelos Settings first.', 'SUBSCRIPTION_SIGN_IN', 401);
      const thread = await client.request('thread/start', {
        ...(opts.model && opts.model !== 'auto' ? { model: opts.model } : {}),
        modelProvider: 'openai', cwd: client.cwd, runtimeWorkspaceRoots: [],
        approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        environments: [], dynamicTools: [], selectedCapabilityRoots: [],
        baseInstructions: instructionsText, developerInstructions: 'Return the answer directly. No tools or workspace access are available.',
        serviceName: 'zelos',
      });
      threadId = thread?.thread?.id;
      if (typeof threadId !== 'string' || !threadId || thread.thread.ephemeral !== true || thread.modelProvider !== 'openai'
          || !Array.isArray(thread.instructionSources) || thread.instructionSources.length || thread.approvalPolicy !== 'never'
          || thread.sandbox?.type !== 'readOnly' || thread.sandbox?.networkAccess === true) throw incompatible();
      selectedModel = clipped(thread.model, 200) || selectedModel;
      checkActive();
      if (conversation.length > 1) await client.request('thread/inject_items', { threadId, items: conversation.slice(0, -1).map((message) => ({ type: 'message', role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }] })) });
      checkActive();
      const consume = (method, params) => {
        if (done) return;
        if (method === '$closed') return fail(params.error);
        if (params.threadId !== threadId || (turnId && params.turnId && params.turnId !== turnId)) return;
        activity();
        if (method === 'turn/started') { if (!turnId) turnId = params.turn?.id || null; }
        if ((method === 'item/started' || method === 'item/completed') && !['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(params.item?.type)) return fail(failure('ChatGPT requested an action outside this text-only connection. No tool was approved.', 'SUBSCRIPTION_TOOL_BLOCKED'));
        if ((method === 'item/started' || method === 'item/completed') && params.item?.type === 'agentMessage' && params.item.phase === 'commentary') commentaryItems.add(params.item.id);
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          if (commentaryItems.has(params.itemId)) return;
          const id = params.itemId || 'answer';
          itemText.set(id, (itemText.get(id) || '') + params.delta);
          text += params.delta;
          if (Buffer.byteLength(text) > outputLimit) return fail(failure('The ChatGPT answer exceeded the response limit. Ask for a shorter answer.', 'SUBSCRIPTION_OUTPUT_LIMIT'));
          if (params.delta) push({ type: 'delta', text: params.delta });
        }
        if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
          if (commentaryItems.has(params.item.id)) return;
          const previous = itemText.get(params.item.id) || '';
          const final = params.item.text;
          if (!final.startsWith(previous)) return fail(failure('ChatGPT returned an inconsistent response. Try again.', 'SUBSCRIPTION_PROTOCOL'));
          const suffix = final.slice(previous.length);
          itemText.set(params.item.id, final);
          text += suffix;
          if (Buffer.byteLength(text) > outputLimit) return fail(failure('The ChatGPT answer exceeded the response limit. Ask for a shorter answer.', 'SUBSCRIPTION_OUTPUT_LIMIT'));
          if (suffix) push({ type: 'delta', text: suffix });
        }
        if (method === 'thread/tokenUsage/updated') {
          const tokens = params.tokenUsage?.last || params.tokenUsage?.total;
          usage = { input: number(tokens?.inputTokens) || 0, output: number(tokens?.outputTokens) || 0 };
        }
        if (method === 'turn/completed') {
          if (params.turn?.status !== 'completed') return fail(params.turn?.status === 'interrupted' ? aborted() : remoteError(params.turn?.error));
          completed = true; done = true; push({ type: 'done', text, usage, model: selectedModel, stopReason: 'stop' });
        }
      };
      client.listeners.add(consume);
      activity();
      totalDeadline = setTimeout(() => fail(failure('The ChatGPT request took too long. Try a smaller request.', 'SUBSCRIPTION_TIMEOUT')), 10 * 60_000);
      const turn = await client.request('turn/start', {
        threadId, input: [{ type: 'text', text: conversation.at(-1).content }],
        environments: [], runtimeWorkspaceRoots: [], approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
      });
      if (!turnId) turnId = turn?.turn?.id || null;
      if (!turnId) throw incompatible();
      // A server can complete a fast turn before its turn/start reply arrives.
      while (queue.length || !done) {
        if (queue.length) yield queue.shift();
        else await new Promise((resolve) => { wake = resolve; });
        if (resultError) throw resultError;
      }
      if (resultError) throw resultError;
      if (!completed) throw failure('ChatGPT did not return a completed answer.', 'SUBSCRIPTION_PROTOCOL');
    } finally {
      clearTimeout(idleDeadline); clearTimeout(totalDeadline);
      opts.signal?.removeEventListener('abort', onAbort);
      if (client) {
        if (!completed && !client.error && turnId && threadId) { try { client.send({ id: client.nextId++, method: 'turn/interrupt', params: { threadId, turnId } }); } catch { /* close below */ } }
        client.stop();
        await client.closed;
      }
    }
  }
  async function complete(opts = {}) {
    for await (const event of stream(opts)) if (event.type === 'done') { const { type, ...result } = event; return { ...result, raw: null }; }
    throw failure('ChatGPT did not return a completed answer.', 'SUBSCRIPTION_PROTOCOL');
  }
  function close() {
    if (closeOperation) return closeOperation;
    shuttingDown = true; generation++;
    clearTimeout(loginTimer); clearTimeout(idleTimer);
    shutdownController.abort(); generationController.abort();
    const stopped = [...clients];
    for (const child of probes) child.kill('SIGKILL');
    for (const client of stopped) client.stop();
    closeOperation = (async () => {
      await Promise.allSettled([...setups, installation, preparation, authStarting, loginOperation, logoutOperation]);
      await Promise.all(stopped.map((client) => client.closed));
      // Directory cleanup also runs on child exit; never delete credential data.
      await Promise.all([...directories].map(removeScratch));
      authClient = null; login = null; loginCompletions.clear();
    })();
    return closeOperation;
  }
  return { status, startLogin, cancelLogin, logout, models, complete, stream, close };
}

let singleton;
const connection = () => singleton ||= createCodexSubscription();
export const getSubscriptionStatus = () => connection().status();
export const startSubscriptionLogin = (opts) => connection().startLogin(opts);
export const cancelSubscriptionLogin = (opts) => connection().cancelLogin(opts);
export const logoutSubscription = () => connection().logout();
export const listSubscriptionModels = () => connection().models();
export const completeSubscription = (opts) => connection().complete(opts);
export const streamSubscription = (opts) => connection().stream(opts);
export async function closeSubscription() { const old = singleton; singleton = null; await old?.close(); }
export { INSTALL_URL as CODEX_INSTALL_URL };
