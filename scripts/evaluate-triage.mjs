#!/usr/bin/env node
/** Offline only: export synthetic prompts or score explicitly supplied JSON.
 * This module never discovers model settings, opens a database, or calls an AI. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSweepPrompt } from '../core/triage.mjs';
import { CASES, CORPUS_VERSION, IDENTITY, NOW } from '../evals/triage-cases.mjs';

export const LIMITATION = 'Automated checks cover labeled JSON constraints only. Human semantic review is required. Hand-authored fixture tests do not establish live model accuracy.';
const hash = value => createHash('sha256').update(value).digest('hex');
const BUCKETS = new Set(['now', 'today', 'soon', 'waiting', 'promised', 'note', 'money']);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function exportPrompts() {
  const sourcePath = new URL('../core/triage.mjs', import.meta.url);
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  return {
    corpusVersion: CORPUS_VERSION, appVersion: version, synthetic: true,
    generatedAt: new Date().toISOString(), triageSourceSha256: hash(fs.readFileSync(sourcePath)),
    limitation: LIMITATION,
    cases: CASES.map(scenario => {
      const prompt = buildSweepPrompt({ identity: IDENTITY, now: NOW,
        privacy: { sendBodies: true, bodyChars: 4000, maxItemsPerSweep: 150 }, ...scenario.input });
      const input = { system: prompt.system, messages: prompt.messages };
      return { id: scenario.id, label: scenario.label, input, promptSha256: hash(JSON.stringify(input)), budget: prompt.budget };
    }),
  };
}

export function responseTemplate() {
  return { corpusVersion: CORPUS_VERSION, model: 'Record the exact model and version',
    runNotes: 'Record model settings, prompt export filename/hash, and whether outputs came from a model or were hand-authored.',
    responses: CASES.map(scenario => ({ id: scenario.id, output: null })) };
}

function schemaProblems(output, scenario) {
  const errors = [];
  if (!plainObject(output) || !Array.isArray(output.items) || !Array.isArray(output.notes)) return ['Expected one JSON object containing items and notes arrays.'];
  if (!(output.first === null || typeof output.first === 'string')) errors.push('first must be a key or null.');
  if (output.notes.length > 5 || !output.notes.every(note => typeof note === 'string' && note.length <= 200)) errors.push('notes must contain at most five strings of at most 200 characters.');
  const refs = new Set([
    ...(scenario.input.messages || []).map(item => `msg:${item.id}`),
    ...(scenario.input.events || []).map(item => `evt:${item.id}`),
    ...(scenario.input.captures || []).map(item => `cap:${item.id}`),
  ]);
  const keys = new Set();
  for (const [index, item] of output.items.entries()) {
    const at = `items[${index}]`;
    if (!plainObject(item)) { errors.push(`${at} must be an object.`); continue; }
    if (typeof item.key !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.key) || item.key.length > 120 || keys.has(item.key)) errors.push(`${at} needs a unique stable key.`);
    keys.add(item.key);
    if (!BUCKETS.has(item.bucket)) errors.push(`${at} has an unknown bucket.`);
    for (const [field, limit] of [['headline', 90], ['why', 240], ['person', 80], ['personEmail', 254]]) {
      if (typeof item[field] !== 'string' || item[field].length > limit || (field === 'headline' && !item[field].trim())) errors.push(`${at}.${field} is missing, invalid or over length.`);
    }
    if (!Number.isInteger(item.severity) || item.severity < 0 || item.severity > 3) errors.push(`${at}.severity must be an integer from 0 to 3.`);
    if (!(item.dueAt === null || (typeof item.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(item.dueAt) && Number.isFinite(Date.parse(item.dueAt))))) errors.push(`${at}.dueAt must be an ISO date or null.`);
    if (!Array.isArray(item.sourceRefs) || !item.sourceRefs.length || item.sourceRefs.some(ref => !refs.has(ref))) errors.push(`${at} must cite only supplied source refs and at least one of them.`);
    if (item.link !== null) {
      try { if (typeof item.link !== 'string' || !['http:', 'https:'].includes(new URL(item.link).protocol)) throw Error(); }
      catch { errors.push(`${at}.link must be an http(s) URL or null.`); }
    }
    if (item.draft !== undefined && item.draft !== null && (!plainObject(item.draft) || !['to', 'subject', 'body'].every(field => typeof item.draft[field] === 'string' && item.draft[field].trim()))) errors.push(`${at}.draft must contain to, subject and body strings.`);
  }
  if (output.first !== null && !keys.has(output.first)) errors.push('first does not name an item.');
  return errors;
}

function evaluateRule(rule, items) {
  switch (rule.type) {
    case 'matching-items': {
      const matches = items.filter(item => Array.isArray(item.sourceRefs) && item.sourceRefs.some(ref => rule.refs.includes(ref)));
      if (matches.length < rule.min || matches.length > rule.max) return false;
      return matches.every(item => Object.entries(rule.fields).every(([field, expected]) =>
        field === 'bucketOneOf' ? expected.includes(item.bucket) : item[field] === expected));
    }
    case 'max-now': return items.filter(item => item.bucket === 'now').length <= rule.value;
    case 'max-actions': return items.filter(item => item.bucket !== 'note').length <= rule.value;
    case 'max-severity': return items.every(item => item.severity <= rule.value);
    case 'no-deadlines': return items.every(item => item.dueAt === null);
    case 'no-drafts': return items.every(item => item.draft == null);
    case 'forbidden-keys': return items.every(item => !rule.keys.includes(item.key));
    case 'forbidden-link-host': return items.every(item => {
      if (!item.link) return true;
      try { return new URL(item.link).hostname !== rule.host; } catch { return false; }
    });
    default: throw new Error(`Unknown evaluation rule: ${rule.type}`);
  }
}

export function scoreResponses(submission) {
  if (!plainObject(submission) || !Array.isArray(submission.responses)) throw new Error('Expected an object with a responses array.');
  if (submission.corpusVersion !== CORPUS_VERSION) throw new Error(`Use corpusVersion ${CORPUS_VERSION}.`);
  const known = new Set(CASES.map(scenario => scenario.id));
  const outputs = new Map();
  for (const entry of submission.responses) {
    if (!plainObject(entry) || !known.has(entry.id)) throw new Error('Every response must name a known case ID.');
    if (outputs.has(entry.id)) throw new Error(`Duplicate response for ${entry.id}.`);
    outputs.set(entry.id, entry.output);
  }
  const cases = CASES.map(scenario => {
    const raw = outputs.get(scenario.id);
    const present = raw !== undefined && raw !== null;
    let output = raw, parseError = null;
    if (typeof raw === 'string') {
      try { output = JSON.parse(raw); } catch { parseError = 'Response is not plain JSON.'; }
    }
    const problems = !present ? ['No response supplied.'] : parseError ? [parseError] : schemaProblems(output, scenario);
    const checks = [{ name: 'structured-shape-and-citations', passed: problems.length === 0, problems },
      ...scenario.rules.map((rule, index) => ({ name: `${index + 1}:${rule.type}`,
        expected: rule, passed: !problems.length && evaluateRule(rule, output.items) }))];
    return { id: scenario.id, label: scenario.label, supplied: present,
      structuredPassed: checks.every(check => check.passed), checks,
      humanReview: { status: 'required', questions: scenario.humanReview } };
  });
  const checks = cases.flatMap(scenario => scenario.checks);
  return { corpusVersion: CORPUS_VERSION, syntheticCorpus: true,
    model: typeof submission.model === 'string' ? submission.model : 'Unrecorded',
    responseProvenance: 'Supplied by the evaluator; this offline scorer did not run or verify a model.',
    limitation: LIMITATION,
    coverage: { supplied: cases.filter(scenario => scenario.supplied).length, total: cases.length },
    structuredChecks: { passed: checks.filter(check => check.passed).length, total: checks.length,
      allPassed: cases.every(scenario => scenario.structuredPassed) },
    humanReview: { status: 'required', completedByThisTool: false }, cases };
}

function writeJSON(file, value) {
  // A new result never overwrites an earlier run or a source file.
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function main(args = process.argv.slice(2)) {
  const [mode, input, output, ...extra] = args;
  if (extra.length || !['export', 'template', 'score'].includes(mode) || !input || (mode !== 'score' && output)) {
    throw new Error('Usage: node scripts/evaluate-triage.mjs export <new-file.json> | template <new-file.json> | score <responses.json> [new-report.json]');
  }
  if (mode === 'export') { writeJSON(input, exportPrompts()); return 0; }
  if (mode === 'template') { writeJSON(input, responseTemplate()); return 0; }
  if (fs.statSync(input).size > 8 * 1024 * 1024) throw new Error('Response file exceeds 8 MB.');
  const report = scoreResponses(JSON.parse(fs.readFileSync(input, 'utf8')));
  if (output) writeJSON(output, report);
  else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.structuredChecks.allPassed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = main(); }
  catch (err) { process.stderr.write(`Evaluation failed: ${err.message}\n`); process.exitCode = 2; }
}
