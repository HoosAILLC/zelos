// Exercise the native packaged runtime and bundled core before releasing installers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dist = path.resolve('desktop/dist');
const arm = process.arch === 'arm64';
const app = process.platform === 'darwin'
  ? path.join(dist, arm ? 'mac-arm64' : 'mac', 'Zelos.app/Contents')
  : path.join(dist, arm ? 'win-arm64-unpacked' : 'win-unpacked');
const executable = path.join(app, process.platform === 'darwin' ? 'MacOS/Zelos' : 'Zelos.exe');
const resources = path.join(app, process.platform === 'darwin' ? 'Resources' : 'resources');
if (!fs.existsSync(executable)) throw new Error(`Missing native app: ${executable}`);
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-packaged-smoke-'));
const moduleURL = (name) => pathToFileURL(path.join(resources, 'core', name)).href;
const program = `
  import assert from 'node:assert/strict';
  import { DatabaseSync } from 'node:sqlite';
  import { createServer, listen } from ${JSON.stringify(moduleURL('server.mjs'))};
  import { migrate, close } from ${JSON.stringify(moduleURL('db.mjs'))};
  import { loadConfig } from ${JSON.stringify(moduleURL('config.mjs'))};
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE runtime_probe USING fts5(text)');
  migrate(db);
  const server = createServer({ db, config: loadConfig() });
  try {
    const { port } = await listen(server, { port: 0 });
    const headers = { 'X-Zelos-Token': server.sessionToken };
    const base = 'http://127.0.0.1:' + port;
    const health = await fetch(base + '/api/health', { headers });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).version, ${JSON.stringify(version)});
    const state = await fetch(base + '/api/state', { headers });
    assert.equal(state.status, 200);
    assert.ok(Array.isArray((await state.json()).items));
    const page = await fetch(base + '/', { headers });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('<title>Zelos</title>'));
    console.log(JSON.stringify({ version: ${JSON.stringify(version)}, node: process.versions.node, electron: process.versions.electron, platform: process.platform, arch: process.arch, packagedCore: 'passed' }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    close(db);
  }
`;
try {
  const result = spawnSync(executable, ['--input-type=module', '-e', program], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZELOS_HOME: scratch, ZELOS_SECRETS_BACKEND: 'encrypted-file', ZELOS_LOG_LEVEL: 'silent' },
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaged app check exited ${result.status}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
