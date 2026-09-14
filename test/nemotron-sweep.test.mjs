import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-nemotron-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_LOG_LEVEL = 'silent';
const { localRuntimeOptions, complete } = await import('../core/llm.mjs');
const dbm = await import('../core/db.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const { buildSweepPrompt } = await import('../core/triage.mjs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const model = { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'nemotron-3-nano:30b', maxTokens: 16384, temperature: 0 };

test('runtime options are limited to local loopback Ollama Nemotron, including IPv6', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.deepEqual(localRuntimeOptions({ ...model, baseUrl: `http://${host}:11434/v1/` }, { structured: true }),
      { localRuntime: 'ollama', reasoningEffort: 'none', json: true });
  }
  for (const changed of [null, { ...model, protocol: 'anthropic' }, { ...model, baseUrl: 'https://cloud.example.invalid/v1' },
    { ...model, baseUrl: 'http://192.168.1.2:11434/v1' }, { ...model, baseUrl: 'http://127.0.0.1:8000/v1' },
    { ...model, baseUrl: 'http://localhost:11434/proxy/v1' }, { ...model, baseUrl: 'http://localhost:11434/v1?remote=true' },
    { ...model, model: 'nemotron-3-nano:30b-cloud' }, { ...model, model: 'nemotron-3-nano:cloud' },
    { ...model, model: 'other-model' }]) assert.deepEqual(localRuntimeOptions(changed), {});
  assert.equal(Object.hasOwn(localRuntimeOptions(model), 'json'), false, 'plain replies stay plain');
});

function intercept(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    requests.push({ url, body: JSON.parse(request.body) });
    const chunks = [
      { choices: [{ delta: { reasoning: 'Private reasoning is never the answer.' } }] },
      { choices: [{ delta: { content: '{"first":null,"items":[],"notes":[]}' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 200, completion_tokens: 19 } },
    ].map(row => `data: ${JSON.stringify(row)}\n\n`).join('');
    return new Response(`${chunks}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}

test('known local Nemotron sends supported reasoning, JSON and usage controls and keeps reasoning out of the answer', async t => {
  const requests = intercept(t);
  const answer = await complete({ ...model, ...localRuntimeOptions(model, { structured: true }),
    messages: [{ role: 'user', content: 'Return an empty synthetic board.' }], stream: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(requests[0].body.reasoning_effort, 'none');
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(requests[0].body.max_tokens, 16384);
  assert.deepEqual(answer.usage, { input: 200, output: 19 });
  assert.doesNotMatch(answer.text, /Private reasoning/);
  assert.deepEqual(JSON.parse(answer.text).items, []);
});

test('Ollama controls cannot leak to other local runtimes or cloud providers, even through a supplied hint', async t => {
  const requests = intercept(t);
  for (const baseUrl of ['http://127.0.0.1:8000/v1', 'https://cloud.example.invalid/v1']) {
    await complete({ ...model, baseUrl, apiKey: 'synthetic', localRuntime: 'ollama', reasoningEffort: 'none', json: true,
      messages: [{ role: 'user', content: 'Return synthetic JSON.' }], stream: true });
  }
  assert.equal(Object.hasOwn(requests[0].body, 'reasoning_effort'), false);
  assert.equal(Object.hasOwn(requests[0].body, 'response_format'), false);
  assert.equal(Object.hasOwn(requests[0].body, 'stream_options'), false);
  assert.equal(Object.hasOwn(requests[1].body, 'reasoning_effort'), false);
  assert.deepEqual(requests[1].body.response_format, { type: 'json_object' }, 'existing hosted JSON behavior is preserved');
});

test('a structured sweep opts into local Nemotron controls while a cutoff leaves pending work unconsumed', async () => {
  const db = dbm.open(':memory:'); dbm.migrate(db);
  try {
    dbm.insertCapture(db, 'Synthetic task: review the document.');
    const config = { identity: { name: 'Nemo Example', timezone: 'UTC' }, model, mail: [], calendars: [], sources: [],
      privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 }, sweep: { auto: true, intervalMinutes: 10 } };
    const calls = [];
    const result = await runSweep({ db, config, mode: 'full', deps: { getSecret: async () => null, complete: async options => {
      calls.push(options);
      return { text: '{"items":[]}', usage: { input: 200, output: 16384 }, stopReason: 'length' };
    } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].localRuntime, 'ollama');
    assert.equal(calls[0].reasoningEffort, 'none');
    assert.equal(calls[0].stream, true);
    assert.equal(calls[0].json, true);
    assert.equal(result.ok, false);
    assert.equal(dbm.listCaptures(db, { includeProcessed: false }).length, 1);
    assert.equal(dbm.listBoard(db).length, 0);
  } finally { dbm.close(db); }
});

test('large synthetic sync volume is reduced before model inference and truthfully reports omitted bodies', () => {
  const messages = Array.from({ length: 600 }, (_, i) => ({ id: `fixture-${i}`, direction: 'in',
    from_email: `person${i}@example.com`, to: ['nemo@example.com'], subject: `Synthetic note ${i}`,
    thread_key: `fixture-thread-${i}`, sent_at: '2026-09-10T12:00:00Z', body: 'Synthetic context. '.repeat(200) }));
  const prompt = buildSweepPrompt({ messages, now: '2026-09-11T12:00:00Z' });
  assert.equal(prompt.budget.available.inbound, 600);
  assert.ok(prompt.budget.shown.inbound < 100);
  assert.ok(prompt.budget.approxChars < 50000);
  assert.equal(prompt.budget.truncated, true);
  assert.match(prompt.messages[0].content, /shown, highest-ranked first|headers only/);
});

test('a bounded application schema is sent only to verified local Ollama',async t=>{
 const requests=intercept(t),jsonSchema={oneOf:[{type:'object',required:['unit'],properties:{unit:{enum:['g','item']}},additionalProperties:false},{type:'object',required:['clarification'],properties:{clarification:{type:'string'}},additionalProperties:false}]};
 const options={...model,...localRuntimeOptions(model,{structured:true}),jsonSchema,messages:[{role:'user',content:'Return synthetic JSON.'}],stream:true};
 await complete(options);assert.deepEqual(requests[0].body.response_format,{type:'json_schema',json_schema:{name:'zelos_response',strict:true,schema:jsonSchema}});
 await complete({...options,baseUrl:'http://127.0.0.1:8000/v1'});assert.equal(requests[1].body.response_format,undefined);
 await complete({...options,baseUrl:'https://cloud.example.invalid/v1',apiKey:'synthetic'});assert.deepEqual(requests[2].body.response_format,{type:'json_object'});
});
test('invalid or oversized native schemas fail before making a request',async t=>{
 const requests=intercept(t);const cyclic={};cyclic.cyclic=cyclic;
 for(const jsonSchema of [null,[], 'bad', {description:'x'.repeat(64001)},cyclic])await assert.rejects(complete({...model,...localRuntimeOptions(model,{structured:true}),jsonSchema,messages:[{role:'user',content:'Return JSON.'}],stream:true,retries:0}),/format is invalid|too large/);
 assert.equal(requests.length,0);
});
