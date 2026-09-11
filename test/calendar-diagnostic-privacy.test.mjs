import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-calendar-privacy-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
const db = await import('../core/db.mjs');
const { DEFAULTS } = await import('../core/config.mjs');
const { createServer, listen } = await import('../core/server.mjs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

for (const scenario of ['refused', 'empty', 'network error']) {
  test(`calendar test keeps private subscription URLs out of ${scenario} diagnostics`, async t => {
    const calendarUrl = 'https://calendar.example.test/PRIVATE_FICTIONAL_FEED?grant=FICTIONAL_GRANT';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url) !== calendarUrl) return originalFetch(url, options);
      if (scenario === 'network error') throw new Error(`Unable to read ${calendarUrl}`);
      return scenario === 'refused'
        ? new Response('', { status: 403, statusText: `Refused ${calendarUrl}` })
        : new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
    };
    const archive = db.open(':memory:'); db.migrate(archive);
    const config = structuredClone(DEFAULTS);
    config.mail = []; config.calendars = []; config.sources = []; config.sweep.auto = false;
    const server = createServer({ db: archive, config });
    const { port } = await listen(server, { port: 0 });
    t.after(async () => {
      globalThis.fetch = originalFetch;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      db.close(archive);
    });
    const response = await originalFetch(`http://127.0.0.1:${port}/api/calendar/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zelos-Token': server.sessionToken },
      body: JSON.stringify({ kind: 'ics', url: calendarUrl }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.match(result.error, /https:\/\/calendar\.example\.test/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FICTIONAL_FEED|FICTIONAL_GRANT|grant=/);
  });
}
