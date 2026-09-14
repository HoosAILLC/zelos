import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-progress-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_LOG_LEVEL = 'silent';
const dbm = await import('../core/db.mjs');
const { getProgress, weeklyReportData, buildWeeklyReport } = await import('../core/progress.mjs');
const handles = [];
test.after(() => { for (const db of handles) dbm.close(db); fs.rmSync(home, { recursive: true, force: true }); });
function fresh() { const db = dbm.open(':memory:'); dbm.migrate(db); handles.push(db); return db; }
function item(db, key, changes = {}) { return dbm.upsertItem(db, { key, headline: `Complete ${key}`, why: `Context for ${key}`, bucket: 'today', ...changes }, { now: '2026-09-01T12:00:00Z' }).id; }
const range = { week: '2026-09-09', tz: 'America/Indiana/Indianapolis', now: '2026-09-20T12:00:00Z' };

test('an empty or imported Done board does not invent recorded completions', () => {
  const db = fresh();
  assert.equal(getProgress(db, range).totals.completed, 0);
  item(db, 'imported', { state: 'done' });
  assert.equal(getProgress(db, range).totals.completed, 0);
  assert.deepEqual(getProgress(db, range).totals.daily.map(day => day.count), [0, 0, 0, 0, 0, 0, 0]);
});

test('Done actions dedupe per task, reopened work is separate, and a later week cannot erase a prior completion', () => {
  const db = fresh();
  const redone = item(db, 'redone'), reopened = item(db, 'reopened'), later = item(db, 'reopened-next-week');
  dbm.setItemState(db, redone, 'done', { now: '2026-09-07T14:00:00Z' });
  dbm.setItemState(db, redone, 'done', { now: '2026-09-07T15:00:00Z' });
  dbm.setItemState(db, redone, 'open', { now: '2026-09-08T14:00:00Z' });
  dbm.setItemState(db, redone, 'done', { now: '2026-09-11T14:00:00Z' });
  dbm.setItemState(db, reopened, 'done', { now: '2026-09-08T14:00:00Z' });
  dbm.setItemState(db, reopened, 'open', { now: '2026-09-09T14:00:00Z' });
  dbm.setItemState(db, later, 'done', { now: '2026-09-12T14:00:00Z' });
  dbm.setItemState(db, later, 'open', { now: '2026-09-14T14:00:00Z' });
  const progress = getProgress(db, range);
  assert.equal(progress.week, '2026-09-07');
  assert.equal(progress.totals.completed, 2);
  assert.equal(progress.reopened, 1);
  assert.equal(progress.completionEvents, 4);
  assert.equal(progress.entries.find(entry => entry.id === redone).completionEvents, 2);
  assert.equal(progress.entries.find(entry => entry.id === later).status, 'completed');
  assert.deepEqual(progress.totals.daily.map(day => day.count), [0, 0, 0, 0, 1, 1, 0]);
});

test('week boundaries use the configured zone and tolerate DST changes', () => {
  const db = fresh();
  const inside = item(db, 'Sunday-before-local-midnight'), outside = item(db, 'Monday-after-local-midnight');
  dbm.setItemState(db, inside, 'done', { now: '2026-11-02T04:59:59Z' });
  dbm.setItemState(db, outside, 'done', { now: '2026-11-02T05:00:00Z' });
  const progress = getProgress(db, { week: '2026-10-28', tz: 'America/New_York', now: '2026-11-10T12:00:00Z' });
  assert.equal(progress.totals.completed, 1);
  assert.equal(progress.entries[0].id, inside);
  assert.equal(progress.entries[0].day, '2026-11-01');
  assert.equal(progress.totals.daily[6].count, 1);
});

test('reports reconstruct the task title and bucket at completion without exposing later edits', () => {
  const db = fresh();
  const id = item(db, 'renamed', { headline: 'The original deliverable', bucket: 'today', payload: { company: 'Studio' } });
  dbm.setItemState(db, id, 'done', { now: '2026-09-08T14:00:00Z' });
  dbm.upsertItem(db, { key: 'renamed', headline: 'Later private wording', bucket: 'soon', why: 'Later private detail', payload: { company: 'Studio' } }, { now: '2026-09-15T14:00:00Z' });
  const entry = getProgress(db, range).entries[0];
  assert.equal(entry.title, 'The original deliverable');
  assert.equal(entry.bucket, 'today');
  assert.equal(entry.description, 'Context for renamed');
  assert.equal(entry.company, 'Studio');
});

test('report selection filters totals and removes private descriptions and labels before PDF creation', () => {
  const db = fresh();
  const publicId = item(db, 'public', { why: 'SENSITIVE DESCRIPTION', payload: { company: 'PRIVATE COMPANY' } });
  const privateId = item(db, 'excluded', { headline: 'PRIVATE EXCLUDED TASK' });
  for (const id of [publicId, privateId]) dbm.setItemState(db, id, 'done', { now: '2026-09-08T14:00:00Z' });
  const report = weeklyReportData(db, { ...range, selectedIds: [publicId], title: 'Client report' });
  assert.equal(report.totals.completed, 1);
  assert.equal(report.totals.daily[1].count, 1);
  assert.equal(report.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SENSITIVE/);
  const anonymous = weeklyReportData(db, { ...range, selectedIds: [publicId], includeTitles: false, includeDetails: true });
  assert.equal(anonymous.entries[0].title, null);
  assert.equal(anonymous.entries[0].description, null);
  assert.equal(weeklyReportData(db, { ...range, selectedIds: [] }).totals.completed, 0);
  assert.throws(() => weeklyReportData(db, { ...range, selectedIds: ['not-completed'] }), /no longer completed/);
});

test('malformed weeks, zones and export choices fail instead of silently selecting unrelated work', () => {
  const db = fresh();
  for (const week of ['2026-02-30', 'next week', '2026-9-7']) assert.throws(() => getProgress(db, { ...range, week }), /Choose a week/);
  assert.throws(() => getProgress(db, { ...range, tz: 'Invalid/Timezone' }), /time zone/);
  assert.throws(() => weeklyReportData(db, { ...range, includeDetails: 'yes' }), /on or off/);
  assert.throws(() => weeklyReportData(db, { ...range, title: 'x'.repeat(121) }), /title/);
});

test('completed assistant jobs are separate from human completions and excluded from exports', () => {
  const db = fresh();
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_jobs (id TEXT PRIMARY KEY, prompt TEXT, status TEXT,
    created_at TEXT, updated_at TEXT, finished_at TEXT, result_json TEXT, steps_json TEXT, error TEXT)`);
  const insert = db.prepare("INSERT INTO assistant_jobs (id, prompt, status, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z')");
  insert.run('ready', 'PRIVATE AUTOMATED SUMMARY', 'completed', '2026-09-08T14:00:00Z');
  insert.run('failed', 'Failed job', 'failed', '2026-09-09T14:00:00Z');
  insert.run('outside', 'Previous week', 'completed', '2026-09-06T14:00:00Z');
  const progress = getProgress(db, range);
  assert.equal(progress.automatedJobs.count, 1);
  assert.equal(progress.automatedJobs.entries[0].id, 'ready');
  assert.equal(progress.totals.completed, 0);
  const report = weeklyReportData(db, range);
  assert.equal(report.totals.completed, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE AUTOMATED SUMMARY/);
});

test('a weekly download is a complete PDF with embedded local fonts and no external file actions', async () => {
  const db = fresh();
  const id = item(db, 'Unicode', { headline: 'Review café plans with José' });
  dbm.setItemState(db, id, 'done', { now: '2026-09-08T14:00:00Z' });
  const pdf = await buildWeeklyReport(db, { ...range, selectedIds: [id] });
  assert.ok(Buffer.isBuffer(pdf));
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\./);
  assert.match(pdf.subarray(-100).toString(), /%%EOF/);
  assert.ok(pdf.includes(Buffer.from('/FontFile2')), 'the font is embedded');
  assert.ok(!pdf.includes(Buffer.from('/JavaScript')));
  assert.ok(!pdf.includes(Buffer.from('/Launch')));
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1, 'footers stay on the content page');
});
