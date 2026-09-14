import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as logging from '../core/log.mjs';

const run = promisify(execFile);
const loggerModule = new URL('../core/log.mjs', import.meta.url).href;
const fictionalPassword = 'abcd efgh ijkl mnop';
const fictionalKey = '01234567-89ab-4cde-8012-3456789abcde';
const fictionalFeed = 'https://calendar.example/calendar/ical/person%40example.test/private-fictional-feed-secret/basic.ics?credential=fictional-query#fictional-fragment';

test('both logger sinks withhold nested OAuth credentials and serialized credential fields', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-log-redaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fields = ['refreshToken', 'refresh_token', 'accessToken', 'access_token', 'clientSecret',
    'client_secret', 'deviceCode', 'device_code', 'credentials', 'passwd', 'appPassword', 'api-key'];
  const meta = { provider: 'fictional', nested: fields.map((key) => ({ [key]: fictionalPassword })) };
  const error = `provider refused ${JSON.stringify({ apiKey: fictionalKey, clientSecret: fictionalPassword })}`;
  const { stderr } = await run(process.execPath, ['--input-type=module', '-e', `
    import { createLogger } from ${JSON.stringify(loggerModule)};
    const logger = createLogger({ dir: ${JSON.stringify(dir)} });
    logger.warn(${JSON.stringify(error)}, ${JSON.stringify(meta)});
    logger.close();
  `], { timeout: 10_000 });
  for (const text of [stderr, fs.readFileSync(path.join(dir, 'zelos.log'), 'utf8')]) {
    assert.equal(text.includes(fictionalPassword), false, 'an app-password value reached a log sink');
    assert.equal(text.includes(fictionalKey), false, 'a UUID API-key value reached a log sink');
    assert.match(text, /provider refused/);
    assert.match(text, /fictional/);
    assert.match(text, /redacted/);
  }
});

test('private subscription links and recognized token formats are redacted inside prose', () => {
  const clientSecret = `GOCSPX-${'fictional'.repeat(5)}`;
  const accessToken = `ya29.${'fictional'.repeat(5)}`;
  const output = logging.redact(`calendar failed: ${fictionalFeed}; response ${clientSecret} ${accessToken}`);
  for (const value of [fictionalFeed, 'fictional-feed-secret', 'fictional-query', 'fictional-fragment', clientSecret, accessToken]) {
    assert.equal(output.includes(value), false, 'a credential reached diagnostic prose');
  }
  assert.match(output, /calendar\.example/);
  assert.equal(logging.redact('See https://example.test/reference/page?id=42'), 'See https://example.test/reference/page?id=42',
    'ordinary source evidence used by item history should remain readable');
});

test('diagnostic addresses omit every credential-bearing URL component', () => {
  assert.equal(typeof logging.diagnosticAddress, 'function');
  assert.equal(typeof logging.diagnosticText, 'function');
  assert.equal(logging.diagnosticAddress('https://user:fictional-pass@example.test:8443/private?key=fictional#secret'), 'https://example.test:8443');
  assert.equal(logging.diagnosticAddress('webcal://example.test/private-feed'), 'https://example.test');
  assert.equal(logging.diagnosticAddress('not a URL: fictional-secret'), 'configured address');
  assert.equal(logging.diagnosticAddress('file:///private/fictional-secret'), 'configured address');
  assert.equal(logging.diagnosticText('Could not read https://user:fictional-pass@example.test:8443/arbitrary-secret?opaque=value#fragment'),
    'Could not read https://example.test:8443');
});

test('diagnostic URLs preserve surrounding punctuation without exposing a private path', () => {
  const cases = [
    ['redirected (via http://127.0.0.1:1234)', 'redirected (via http://127.0.0.1:1234)'],
    ['redirected (via http://127.0.0.1:1234/private-secret?key=fictional).', 'redirected (via http://127.0.0.1:1234).'],
    ['failed [https://[::1]:8443/private-secret?opaque=fictional].', 'failed [https://[::1]:8443].'],
    ['failed (https://example.test/path(private-secret)).', 'failed (https://example.test).'],
  ];
  for (const [input, expected] of cases) assert.equal(logging.diagnosticText(input), expected);
  assert.equal(logging.redact('failed (https://example.test/private-secret/basic.ics).'),
    'failed (https://example.test/[redacted]).');
});
