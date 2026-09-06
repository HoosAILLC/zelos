import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const loggerModule = new URL('../core/log.mjs', import.meta.url).href;

async function withLogHome(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-log-test-'));
  try { await body(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A separate process is intentional: an unhandled WriteStream error kills
// the desktop app, and an error listener in this test would hide that failure.
test('an unavailable log file does not crash the app or silence terminal diagnostics', async () => {
  await withLogHome(async (dir) => {
    fs.mkdirSync(path.join(dir, 'desktop.log'));
    const { stderr, stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      import { createLogger } from ${JSON.stringify(loggerModule)};
      const logger = createLogger({ dir: ${JSON.stringify(dir)}, name: 'desktop' });
      logger.info('starting the board');
      setTimeout(() => {
        logger.warn('the board can still report problems');
        logger.close();
        process.stdout.write('alive');
      }, 50);
    `], { timeout: 10_000 });
    assert.equal(stdout, 'alive');
    assert.match(stderr, /starting the board/);
    assert.match(stderr, /the board can still report problems/);
  });
});

test('late shutdown diagnostics do not write to a closed log stream', async () => {
  await withLogHome(async (dir) => {
    const { stderr } = await run(process.execPath, ['--input-type=module', '-e', `
      import { createLogger } from ${JSON.stringify(loggerModule)};
      const logger = createLogger({ dir: ${JSON.stringify(dir)}, name: 'desktop' });
      logger.info('before shutdown');
      logger.close();
      logger.close();
      logger.warn('a pending operation settled after shutdown');
    `], { timeout: 10_000 });
    assert.match(stderr, /a pending operation settled after shutdown/);
    assert.match(fs.readFileSync(path.join(dir, 'desktop.log'), 'utf8'), /before shutdown/);
  });
});
