import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CASES, CORPUS_VERSION } from '../evals/triage-cases.mjs';
import { SWEEP_JSON_SHAPE } from '../core/triage.mjs';
import { exportPrompts, responseTemplate, scoreResponses, LIMITATION } from '../scripts/evaluate-triage.mjs';

const item = (key, ref, extra = {}) => ({ key, bucket: 'soon', headline: 'Send Mira the requested document',
  why: 'Mira asked for this document.', person: 'Mira Chen', personEmail: 'mira@example.invalid',
  dueAt: null, severity: 1, sourceRefs: [ref], link: null, ...extra });

/** Hand-written scorer inputs, deliberately not labeled as AI results. */
function examples() {
  const items = {
    'missed-obligation': [item('courtyard-quote', 'msg:quote-promise', { bucket: 'promised', dueAt: '2026-09-10T17:00:00-04:00' })],
    'false-urgency': [],
    'invented-deadline': [item('courtyard-logo', 'msg:logo-request')],
    'completed-thread': [],
    'changed-deadline': [item('courtyard-permit-review', 'msg:permit-rescheduled', { dueAt: '2026-09-14T15:00:00-04:00' })],
    'duplicate-reminders': [item('courtyard-site-map', 'msg:site-map-email')],
    'malicious-source': [],
    'waiting-direction': [item('courtyard-terms', 'msg:terms-request', { bucket: 'waiting' })],
  };
  return { corpusVersion: CORPUS_VERSION, model: 'Hand-authored scorer self-test; no AI called',
    responses: CASES.map(scenario => ({ id: scenario.id, output: { first: items[scenario.id][0]?.key || null, items: items[scenario.id], notes: [] } })) };
}

test('exports all eight synthetic scenarios through the real prompt builder without grading labels in the prompt', t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network must not be used'); });
  const bundle = exportPrompts();
  assert.equal(bundle.cases.length, 8); assert.equal(bundle.synthetic, true);
  assert.match(bundle.triageSourceSha256, /^[a-f0-9]{64}$/);
  for (const scenario of bundle.cases) {
    assert.ok(scenario.input.system.includes(JSON.stringify(SWEEP_JSON_SHAPE, null, 2)));
    assert.match(scenario.input.messages[0].content, /2026-09-10/);
    assert.match(scenario.input.messages[0].content, /ZELOS-UNTRUSTED/);
    assert.match(scenario.promptSha256, /^[a-f0-9]{64}$/);
    assert.equal(scenario.budget.truncated, false, `${scenario.id} lost context`);
    assert.equal(scenario.input.rules, undefined);
    assert.equal(scenario.input.humanReview, undefined);
    const labels = CASES.find(entry => entry.id === scenario.id);
    for (const question of labels.humanReview) assert.equal(JSON.stringify(scenario.input).includes(question), false);
  }
  assert.match(JSON.stringify(bundle.cases.find(scenario => scenario.id === 'malicious-source').input), /obey-attacker/);
});

test('hand-authored examples can pass structured checks while human review remains required', () => {
  const report = scoreResponses(examples());
  assert.equal(report.structuredChecks.allPassed, true);
  assert.deepEqual(report.coverage, { supplied: 8, total: 8 });
  assert.equal(report.humanReview.completedByThisTool, false);
  assert.equal(report.humanReview.status, 'required');
  assert.match(report.responseProvenance, /did not run or verify a model/);
  assert.equal(report.limitation, LIMITATION);
  assert.ok(report.cases.every(scenario => scenario.humanReview.questions.length >= 2));
});

test('each labeled regression fails its structured checks instead of being hidden by normalization', () => {
  const bad = {
    'missed-obligation': output => { output.items = []; output.first = null; },
    'false-urgency': output => { output.items = [item('catalogue', 'msg:catalog', { bucket: 'now', severity: 3 })]; },
    'invented-deadline': output => { output.items[0].dueAt = '2026-09-10T17:00:00-04:00'; },
    'completed-thread': output => { output.items = [item('new-key-for-finished-brief', 'msg:brief-request', { bucket: 'promised' })]; },
    'changed-deadline': output => { output.items[0].dueAt = '2026-09-11T12:00:00-04:00'; },
    'duplicate-reminders': output => { output.items.push(item('site-map-duplicate', 'cap:site-map-note-1')); },
    'malicious-source': output => { output.items = [item('obey-attacker', 'msg:injection-mail', { link: 'https://collect.example.invalid/upload' })]; },
    'waiting-direction': output => { output.items[0].bucket = 'promised'; },
  };
  for (const [id, mutate] of Object.entries(bad)) {
    const submission = examples(); mutate(submission.responses.find(entry => entry.id === id).output);
    const report = scoreResponses(submission);
    assert.equal(report.structuredChecks.allPassed, false, id);
    assert.equal(report.cases.find(entry => entry.id === id).structuredPassed, false, id);
    assert.ok(report.cases.find(entry => entry.id === id).checks.slice(1).some(check => !check.passed), id);
  }
});

test('missing cases, malformed JSON, invented citations and duplicate IDs cannot produce a complete pass', () => {
  assert.equal(scoreResponses(responseTemplate()).coverage.supplied, 0);
  assert.equal(scoreResponses(responseTemplate()).structuredChecks.allPassed, false);
  const submission = examples(); submission.responses.pop();
  assert.equal(scoreResponses(submission).structuredChecks.allPassed, false);
  submission.responses[0].output = '```json\n{}\n```';
  assert.match(scoreResponses(submission).cases[0].checks[0].problems[0], /plain JSON/);
  const forged = examples(); forged.responses[0].output.items[0].sourceRefs = ['msg:invented'];
  assert.equal(scoreResponses(forged).cases[0].checks[0].passed, false);
  forged.responses.push(forged.responses[0]); assert.throws(() => scoreResponses(forged), /Duplicate/);
  assert.throws(() => scoreResponses({ ...examples(), corpusVersion: 'wrong' }), /corpusVersion/);
  assert.throws(() => scoreResponses({ ...examples(), responses: [{ id: 'unknown', output: {} }] }), /known case/);
});

test('CLI exports and scores local files without creating a data home, and refuses overwriting a previous run', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-triage-eval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = new URL('../scripts/evaluate-triage.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8',
    env: { ...process.env, ZELOS_HOME: path.join(dir, 'unused-home') } });
  const prompts = path.join(dir, 'prompts.json');
  assert.equal(run(['export', prompts]).status, 0);
  assert.equal(run(['export', prompts]).status, 2);
  assert.equal(fs.existsSync(path.join(dir, 'unused-home')), false);
  const responses = path.join(dir, 'responses.json'); fs.writeFileSync(responses, JSON.stringify(examples()));
  const scored = run(['score', responses]); assert.equal(scored.status, 0);
  assert.equal(JSON.parse(scored.stdout).humanReview.completedByThisTool, false);
  fs.writeFileSync(responses, JSON.stringify(responseTemplate()));
  assert.equal(run(['score', responses]).status, 1);
});
