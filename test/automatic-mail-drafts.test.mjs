import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZELOS_LOG_LEVEL = 'silent';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-automatic-drafts-'));
process.env.ZELOS_HOME = path.join(root, 'home');
const { open, close, migrate, upsertMessage, getItemByKey, listDrafts, updateDraft } = await import('../core/db.mjs');
const { buildSweepPrompt, mergeSweep } = await import('../core/triage.mjs');
const { validateSweep } = await import('../core/safety.mjs');
const handles = [];
function fresh() {
  const db = open(path.join(root, `test-${handles.length}.db`));
  handles.push(db);
  migrate(db);
  return db;
}
test.after(() => { for (const db of handles) close(db); fs.rmSync(root, { recursive: true, force: true }); });

const NOW = '2026-09-11T10:00:00-04:00';
const IDENTITY = { name: 'Alex', email: 'alex@example.com', timezone: 'America/New_York' };
function replyItem(bucket, overrides = {}) {
  return {
    key: `reply-${bucket}`, bucket, headline: 'Reply to Sam about the workshop room',
    why: 'Sam asked which room to use.', person: 'Sam', personEmail: 'sam@example.com',
    dueAt: null, severity: 1, sourceRefs: [], link: null,
    draft: { to: 'sam@example.com', subject: 'Re: Workshop room', body: 'Hi Sam,\n\nWhich room would work best for the workshop?\n\nAlex' },
    ...overrides,
  };
}

test('now and today email drafts survive validation, persist as pending and preserve human edits on the next sweep', () => {
  const db = fresh();
  const source = upsertMessage(db, {
    sourceId: 'work', messageId: '<automatic-draft@example.com>', threadKey: 'room', direction: 'in',
    from: { name: 'Sam', email: 'sam@example.com' }, to: [{ email: 'alex@example.com' }],
    subject: 'Workshop room', text: 'Which room should we use?', date: NOW,
  });
  const payload = { first: null, notes: [], items: ['now', 'today'].map((bucket) => replyItem(bucket, { sourceRefs: [`msg:${source.id}`] })) };
  const validation = validateSweep(payload);
  assert.equal(validation.value.items.filter((item) => item.draft).length, 2);
  assert.ok(!validation.errors.some((error) => /draft attached/.test(error.message)));
  const first = mergeSweep(db, payload, { runId: 'automatic-1', now: NOW });
  assert.equal(first.stats.drafts, 2);
  const drafts = listDrafts(db);
  assert.equal(drafts.length, 2);
  for (const bucket of ['now', 'today']) {
    const item = getItemByKey(db, `reply-${bucket}`);
    const draft = drafts.find((entry) => entry.item_id === item.id);
    assert.equal(item.bucket, bucket);
    assert.deepEqual(item.sourceRefs, [`msg:${source.id}`]);
    assert.equal(draft.state, 'pending');
    assert.equal(draft.to_email, 'sam@example.com');
    assert.equal(draft.body, replyItem(bucket).draft.body);
    updateDraft(db, draft.id, { body: `My reviewed ${bucket} reply.`, state: 'edited' });
  }
  const second = mergeSweep(db, { ...payload, items: payload.items.map((item) => ({ ...item, draft: { ...item.draft, body: 'Model wrote a replacement.' } })) }, { runId: 'automatic-2', now: NOW });
  assert.equal(second.stats.draftsSkipped, 2);
  for (const bucket of ['now', 'today']) {
    const item = getItemByKey(db, `reply-${bucket}`);
    assert.equal(listDrafts(db).find((entry) => entry.item_id === item.id).body, `My reviewed ${bucket} reply.`);
  }
});

test('now and today still reject missing or injected recipients and unfinished drafts without losing the task', () => {
  const db = fresh();
  const bad = [
    { to: '' },
    { to: 'sam@example.com\r\nBcc: someone@evil.example' },
    { to: 'sam@example.com, someone@evil.example' },
    { to: 'not-an-address' },
    { body: 'Hi [name], I can meet on [date].' },
    { body: 'Hi Sam, the workshop room is TBD.' },
  ];
  const items = ['now', 'today'].flatMap((bucket) => bad.map((invalid, i) => {
    const item = replyItem(bucket, { key: `reply-${bucket}-${i}` });
    return { ...item, draft: { ...item.draft, ...invalid } };
  }));
  const result = mergeSweep(db, { first: null, notes: [], items }, { runId: 'invalid-drafts', now: NOW });
  assert.equal(result.stats.drafts, 0);
  assert.equal(listDrafts(db).length, 0);
  for (const item of items) assert.ok(getItemByKey(db, item.key), 'a rejected draft must not remove the task');
});

test('board review forbids automatic drafts and requires a separate user request', () => {
  const { system } = buildSweepPrompt({ identity: IDENTITY, now: NOW });
  assert.match(system, /Omit the draft property entirely/);
  assert.match(system, /The user opens the original email to request a draft\s+separately/);
  assert.match(system, /never generates reply bodies or recipients/);
  assert.match(system, /NOBODY IS WAITING ON A REPLY/);
  assert.match(system, /Do not invent work/);
});
