/** Synthetic-only regression coverage for saved-record provider boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-model-privacy-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
const db_ = await import('../core/db.mjs');
const { createAssistantRunner, enqueueJob, getJob } = await import('../core/assistant.mjs');
const { isPrivateRecordsModel, requiresPrivateRecordsModel } = await import('../core/model-privacy.mjs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
test.beforeEach(t => {
  const forbidden = () => { throw new Error('No real model or network is allowed in privacy tests.'); };
  t.mock.method(net, 'connect', forbidden); t.mock.method(net, 'createConnection', forbidden); t.mock.method(tls, 'connect', forbidden);
  t.mock.method(globalThis, 'fetch', forbidden);
});
const local = 'http://127.0.0.1:1/v1', hosted = 'https://model.example.invalid/v1';
const response = value => ({ text: JSON.stringify(value), stopReason: 'stop' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, { baseUrl = hosted, complete, tools = {} } = {}) {
  const db = db_.open(':memory:'); db_.migrate(db);
  const cfg = { identity: { timezone: 'UTC' }, privacy: { sendBodies: false }, model: { protocol: 'openai', baseUrl, model: 'synthetic', keyRef: null } };
  const calls = [];
  const runner = createAssistantRunner({ db, config: () => cfg, tools, complete: async request => {
    calls.push({ ...request, messages: structuredClone(request.messages) });
    return complete ? complete(request, calls.length, cfg) : response({ finish: 'Done.', status: 'completed' });
  } });
  t.after(async () => { await runner.stop(); db_.close(db); });
  return { db, cfg, calls, runner, async run(prompt) {
    const queued = enqueueJob(db, { prompt }); await runner.runNext(); return getJob(db, queued.id);
  } };
}

test('local record model policy rejects credentials, redirects in URLs and hosted addresses', () => {
  for (const baseUrl of [hosted, '', 'file:///tmp/model', 'http://name:password@127.0.0.1/v1',
    'http://127.0.0.1/v1?next=https://model.example.invalid', 'http://127.0.0.1/v1#secret']) {
    assert.equal(isPrivateRecordsModel({ baseUrl }), false, baseUrl);
  }
  for (const baseUrl of [local, 'http://192.168.1.5:8000/v1', 'http://[::1]:8000/v1']) assert.equal(isPrivateRecordsModel({ baseUrl }), true);
});

test('explicit sensitive assigned prompts are refused before any hosted model request', async t => {
  const f = fixture(t);
  for (const prompt of ['Summarize my saved health profile.', 'My blood pressure is 120/80; compare my measurements.',
    'Review my prescription medication list.', 'Use read_health to help with this task.',
    'Summarize my money and transactions.', 'Review my saved document imports.', 'Show my weekly progress report.']) {
    const job = await f.run(prompt);
    assert.equal(job.status, 'failed'); assert.match(job.error, /local model/); assert.equal(job.steps.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('model-selected sensitive actions cannot read private data through an ordinary hosted prompt', async t => {
  for (const tool of ['read_health', 'read_money', 'read_progress', 'weekly_report']) {
    let reads = 0;
    const f = fixture(t, { complete: async () => response({ tool, args: {} }), tools: { [tool]: async () => { reads++; return { private: 'SYNTHETIC_PRIVATE_FACT' }; } } });
    const job = await f.run('Help me with an ordinary task.');
    assert.equal(f.calls.length, 1); assert.equal(reads, 0); assert.equal(job.status, 'failed'); assert.match(job.error, /local model/);
    assert.equal(job.steps.length, 0); assert.ok(!JSON.stringify(f.calls).includes('SYNTHETIC_PRIVATE_FACT'));
  }
});

test('local tasks can read sensitive records and continue only with their pinned local model', async t => {
  let reads = 0;
  const f = fixture(t, { baseUrl: local, tools: { read_health: async () => { reads++; return { private: 'SYNTHETIC_LOCAL_HEALTH' }; } },
    complete: async (_request, count) => response(count === 1 ? { tool: 'read_health', args: {} } : { finish: 'Reviewed saved facts.', status: 'completed' }) });
  const job = await f.run('Summarize my saved health profile.');
  assert.equal(job.status, 'completed'); assert.equal(reads, 1); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].baseUrl, local); assert.match(JSON.stringify(f.calls[1].messages), /SYNTHETIC_LOCAL_HEALTH/);
});

test('ordinary mail search remains available with a hosted model', async t => {
  const f = fixture(t, { complete: async (_request, count) => response(count === 1 ? { tool: 'search_records', args: { query: 'FictionalOrchid' } } : { finish: 'Found the email.', status: 'completed' }) });
  db_.upsertMessage(f.db, { sourceId: 'synthetic', messageId: 'one', direction: 'in', subject: 'FictionalOrchid meeting',
    from: { email: 'fictional@example.test' }, date: '2026-09-12T10:00:00Z', snippet: 'Ordinary message.', text: 'FictionalOrchid message.' });
  assert.equal((await f.run('Find the FictionalOrchid meeting email.')).status, 'completed');
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.baseUrl === hosted));
});

test('changing provider during model planning prevents the proposed private read', async t => {
  let reads = 0;
  const f = fixture(t, { baseUrl: local, tools: { read_health: async () => { reads++; return {}; } }, complete: async (_request, _count, cfg) => {
    cfg.model.baseUrl = hosted; return response({ tool: 'read_health', args: {} });
  } });
  const job = await f.run('Summarize my saved health profile.');
  assert.equal(job.status, 'failed'); assert.match(job.error, /model settings changed/); assert.equal(reads, 0); assert.equal(f.calls.length, 1);
});

test('changing provider during a private tool preserves its result without a follow-up model call', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { baseUrl: local, complete: async () => response({ tool: 'read_health', args: {} }), tools: {
    read_health: async () => { entered.resolve(); await release.promise; return { private: 'SYNTHETIC_RETAINED_LOCALLY' }; },
  } });
  const running = f.run('Summarize my saved health profile.'); await entered.promise;
  f.cfg.model.baseUrl = hosted; release.resolve(); const job = await running;
  assert.equal(job.status, 'failed'); assert.match(job.error, /model settings changed/); assert.equal(f.calls.length, 1);
  assert.equal(job.steps[0].result.private, 'SYNTHETIC_RETAINED_LOCALLY');
  assert.ok(!JSON.stringify(f.calls).includes('SYNTHETIC_RETAINED_LOCALLY'));
});

test('provider change protection includes private conversation sources and user history', t => {
  const f = fixture(t);
  assert.equal(requiresPrivateRecordsModel(f.db, 'Explain binary search.', []), false);
  for (const kind of ['health', 'money', 'progress', 'document', 'library']) {
    for (const source of [{ kind }, { ref: `${kind}:synthetic` }]) {
      assert.equal(requiresPrivateRecordsModel(f.db, 'Explain binary search.', [{ role: 'assistant', content: 'Saved fact', sources: [source] }]), true);
    }
  }
  for (const content of ['My blood pressure is 120/80.', 'My bank balance is 123.45.', 'Review my saved documents.']) {
    assert.equal(requiresPrivateRecordsModel(f.db, 'Explain binary search.', [{ role: 'user', content, sources: [] }]), true);
  }
});
