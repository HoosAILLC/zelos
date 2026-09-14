import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mail-workspace-test-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
let networkAttempts = 0;
const forbidden = () => { networkAttempts++; throw new Error('Mail workspace tests must never connect or send real mail.'); };
mock.method(net, 'connect', forbidden);
mock.method(net, 'createConnection', forbidden);
mock.method(tls, 'connect', forbidden);
const db_ = await import('../core/db.mjs');
const {
  createMailWorkspace, saveReply, getMailDraft, getMailMessage, listMail,
  draftDefaults, draftRevision, assertDraftEditable, mailAccounts,
} = await import('../core/mail-workspace.mjs');
const handles = new Set();
let sequence = 0;
after(() => {
  for (const db of handles) db_.close(db);
  mock.restoreAll();
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(networkAttempts, 0, 'No test may attempt a real SMTP or other network connection');
});

const ACCOUNT_A = { id: 'm_studio', enabled: true, label: 'Studio', user: 'alex@studio.example', host: 'imap.gmail.com', auth: 'password', keyRef: 'mail.synthetic_a' };
const ACCOUNT_B = { id: 'm_personal', enabled: true, label: 'Personal', user: 'alex@personal.example', host: 'imap.gmail.com', auth: 'password', keyRef: 'mail.synthetic_b' };
const incoming = {
  sourceId: ACCOUNT_A.id, uid: 1, messageId: '<incoming-1@client.example>', direction: 'in', folder: 'INBOX',
  from: { name: 'Morgan Vale', email: 'morgan@client.example' },
  to: [{ name: 'Alex', email: ACCOUNT_A.user }], cc: [],
  replyTo: [{ name: 'Project desk', email: 'desk@client.example' }],
  references: ['<thread-root@client.example>'], inReplyTo: '<thread-root@client.example>',
  subject: 'Clinic drawings', text: 'Please review the clinic drawings. The 50%_complete plan is attached.',
  date: '2026-09-11T11:00:00Z', snippet: 'Please review the clinic drawings.', flags: [],
};
function fixture({ sender, configHook } = {}) {
  const file = path.join(home, `fixture-${sequence++}.sqlite`);
  const db = db_.open(file); handles.add(db); db_.migrate(db);
  const config = { mail: [structuredClone(ACCOUNT_B), structuredClone(ACCOUNT_A)] };
  const parent = db_.upsertMessage(db, incoming).id;
  const other = db_.upsertMessage(db, { ...incoming, sourceId: ACCOUNT_B.id, uid: 2, messageId: '<incoming-2@client.example>', subject: 'Weekend plans', text: 'Let’s meet for lunch on Saturday.', from: { name: 'Quinn', email: 'quinn@client.example' }, replyTo: [], date: '2026-09-10T11:00:00Z' }).id;
  const outgoing = db_.upsertMessage(db, { ...incoming, uid: 3, messageId: '<sent-3@studio.example>', direction: 'out' }).id;
  const disconnected = db_.upsertMessage(db, { ...incoming, sourceId: 'm_removed', uid: 4, messageId: '<removed-4@client.example>' }).id;
  const calls = [];
  let clock = Date.parse('2026-09-11T12:00:00Z');
  const configFn = () => { configHook?.(); return config; };
  const send = async (account, message) => {
    calls.push({ account: structuredClone(account), message: structuredClone(message) });
    return sender ? sender(account, message) : { status: 'accepted', accepted: [message.to], rejected: [], messageId: message.messageId };
  };
  const workspace = createMailWorkspace({ db, config: configFn, sender: send, clock: () => clock });
  const data = overrides => ({ messageId: parent, accountId: ACCOUNT_A.id, to: 'desk@client.example', subject: 'Re: Clinic drawings', body: 'Morgan — I approved the revised drawings.\n\nPlease keep the timber detail as shown.\nAlex', ...overrides });
  return { db, file, config, configFn, workspace, parent, other, outgoing, disconnected, calls, data, send,
    advance: ms => { clock += ms; }, clock: () => clock };
}
const row = (f, id) => f.db.prepare('SELECT * FROM mail_outbox WHERE id=?').get(id);
const statusError = status => error => error?.name === 'MailWorkspaceError' && error.status === status;
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}
function generatedDraft(f, id, { parent = f.parent, to = 'desk@client.example', additionalRefs = [] } = {}) {
  const item = db_.upsertItem(f.db, { key: `item-${id}`, kind: 'reply', bucket: 'today', headline: 'Reply to the clinic', why: 'A synthetic reply is due.', sourceRefs: [...additionalRefs, `msg:${parent}`] }).id;
  db_.upsertDraft(f.db, { id, itemId: item, to, subject: 'Re: Clinic drawings', body: 'Synthetic generated draft.', state: 'pending' });
  return id;
}

test('source defaults use the actual account, Reply-To and sanitized subject; outgoing and removed sources are excluded', () => {
  const f = fixture();
  assert.deepEqual(draftDefaults(f.db, f.config, f.parent), { messageId: f.parent, accountId: ACCOUNT_A.id, to: 'desk@client.example', subject: 'Re: Clinic drawings' });
  assert.equal(draftDefaults(f.db, f.config, f.other).to, 'quinn@client.example');
  for (const id of [f.outgoing, f.disconnected]) assert.throws(() => getMailMessage(f.db, f.config, id), statusError(id === f.outgoing ? 400 : 404));
  const list = listMail(f.db, f.config);
  assert.deepEqual(new Set(list.messages.map(message => message.id)), new Set([f.parent, f.other]));
  assert.equal(listMail(f.db, f.config, { accountId: ACCOUNT_A.id }).messages.length, 1);
  assert.equal(listMail(f.db, f.config, { q: '50%_complete' }).messages.length, 1);
  assert.equal(listMail(f.db, f.config, { q: '50%_' }).messages.length, 1);
  assert.equal(listMail(f.db, f.config, { q: '%_nonmatch' }).messages.length, 0);
  assert.throws(() => listMail(f.db, f.config, { accountId: 'm_removed' }), statusError(404));
  assert.throws(() => listMail(f.db, f.config, { cursor: '0; DROP TABLE messages' }), statusError(400));
  assert.equal(listMail(f.db, f.config, { limit: 1 }).nextCursor, '1');
  assert.equal(listMail(f.db, f.config, { limit: 1, cursor: '1' }).nextCursor, null);
  db_.upsertMessage(f.db, { ...incoming, subject: 'Hello\r\nBcc: ignored@example.org' });
  assert.equal(draftDefaults(f.db, f.config, f.parent).subject, 'Re: Hello  Bcc: ignored@example.org');
});

test('saving repeatedly keeps one draft and source metadata without sending, and supports an unfinished body', () => {
  const f = fixture();
  const first = saveReply(f.db, f.config, f.data({ body: '' }));
  const second = saveReply(f.db, f.config, f.data({ body: 'Reviewed text' }));
  assert.equal(first.id, second.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM drafts').get().n, 1);
  assert.equal(second.account_id, ACCOUNT_A.id);
  assert.equal(second.message_id, f.parent);
  const loaded = getMailDraft(f.db, f.config, second.id);
  assert.equal(loaded.accountId, ACCOUNT_A.id);
  assert.equal(loaded.message.id, f.parent);
  assert.equal(loaded.message.replyTo[0].email, 'desk@client.example');
  assert.equal(getMailMessage(f.db, f.config, f.parent).draft.id, second.id);
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mail_outbox').get().n, 0);
  assert.throws(() => saveReply(f.db, f.config, f.data({ draftId: second.id, messageId: f.other })), statusError(409));
});

test('generated drafts infer the matching source account and reject recipients unsupported by that source', () => {
  const f = fixture();
  const id = generatedDraft(f, 'generated-a', { additionalRefs: [`msg:${f.other}`, `msg:${f.outgoing}`] });
  const loaded = getMailDraft(f.db, f.config, id);
  assert.equal(loaded.accountId, ACCOUNT_A.id);
  assert.equal(loaded.message.id, f.parent);
  const unmatched = generatedDraft(f, 'generated-unmatched', { to: 'nobody@unrelated.example' });
  assert.throws(() => getMailDraft(f.db, f.config, unmatched), statusError(409));
  assert.throws(() => assertDraftEditable(f.db, unmatched), statusError(409));
  assert.throws(() => saveReply(f.db, f.config, f.data({ draftId: unmatched })), statusError(409));
  assert.equal(f.calls.length, 0, 'an unsupported recipient cannot enter delivery');
  const before = draftRevision(f.db, f.parent);
  saveReply(f.db, f.config, f.data({ draftId: id }));
  assert.notEqual(draftRevision(f.db, f.parent), before);
});

test('prepare freezes all reviewed values and thread metadata without invoking the sender', () => {
  const f = fixture();
  const data = f.data();
  const { review } = f.workspace.prepare(data);
  const saved = row(f, review.id);
  const payload = JSON.parse(saved.payload_json);
  assert.equal(saved.status, 'review');
  assert.equal(saved.parent_id, f.parent);
  assert.equal(saved.expires_at, '2026-09-11T12:10:00.000Z');
  assert.equal(review.from, ACCOUNT_A.user);
  assert.equal(review.accountId, ACCOUNT_A.id);
  assert.equal(review.to, data.to);
  assert.equal(review.body, data.body);
  assert.equal(review.subject, data.subject);
  assert.equal(payload.inReplyTo, incoming.messageId);
  assert.deepEqual(payload.references, ['<thread-root@client.example>', incoming.messageId]);
  assert.match(payload.messageId, /^<zelos\.[0-9a-f-]+@studio\.example>$/);
  data.body = 'Mutated caller data'; review.body = 'Mutated response data';
  assert.equal(f.workspace.delivery(review.id).review.body, payload.body);
  assert.equal(f.calls.length, 0);
});

test('sending uses the exact immutable review and is idempotent after acceptance', async () => {
  const f = fixture();
  const { review } = f.workspace.prepare(f.data());
  const payload = JSON.parse(row(f, review.id).payload_json);
  const first = await f.workspace.send(review.id);
  const second = await f.workspace.send(review.id);
  assert.deepEqual(second, first);
  assert.equal(first.status, 'sent');
  assert.equal(first.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].account.id, ACCOUNT_A.id);
  assert.deepEqual(f.calls[0].message, { envelope: { from: payload.from, to: [payload.to] }, from: payload.from, to: payload.to,
    subject: payload.subject, text: payload.body, messageId: payload.messageId, inReplyTo: payload.inReplyTo, references: payload.references });
  assert.equal(db_.getDraft(f.db, row(f, review.id).draft_id).state, 'used');
  const captures = db_.listCaptures(f.db);
  assert.equal(captures.length, 1);
  assert.ok(captures[0].text.endsWith(payload.body));
  assert.equal(listMail(f.db, f.config).messages.find(message => message.id === f.parent).deliveryStatus, 'sent');
  assert.equal(f.workspace.sendingCount, 0);
  assert.throws(() => assertDraftEditable(f.db, row(f, review.id).draft_id), statusError(409));
});

test('concurrent requests for the same review make exactly one outbound call', async () => {
  const gate = deferred();
  const f = fixture({ sender: () => gate.promise });
  const { review } = f.workspace.prepare(f.data());
  const first = f.workspace.send(review.id);
  assert.equal(f.workspace.sendingCount, 1);
  assert.equal(row(f, review.id).status, 'sending');
  const duplicate = await f.workspace.send(review.id);
  assert.equal(duplicate.status, 'sending');
  assert.equal(f.calls.length, 1);
  gate.resolve({ status: 'accepted' });
  assert.equal((await first).status, 'sent');
  assert.equal(f.workspace.sendingCount, 0);
});

test('two separately reviewed drafts for one parent cannot send concurrently or after success', async () => {
  const gate = deferred();
  const f = fixture({ sender: () => gate.promise });
  const a = generatedDraft(f, 'same-parent-a');
  const b = generatedDraft(f, 'same-parent-b');
  const firstReview = f.workspace.prepare(f.data({ draftId: a })).review;
  const otherReview = f.workspace.prepare(f.data({ draftId: b, body: 'Different wording for the same email.' })).review;
  const sending = f.workspace.send(firstReview.id);
  await assert.rejects(f.workspace.send(otherReview.id), statusError(409));
  assert.equal(f.calls.length, 1);
  gate.resolve({ status: 'accepted' });
  await sending;
  await assert.rejects(f.workspace.send(otherReview.id), statusError(409));
  assert.throws(() => saveReply(f.db, f.config, f.data({ draftId: b })), statusError(409));
  assert.equal(f.calls.length, 1);
});

test('editing any reviewed field cancels the old review and requires a new review', async () => {
  for (const change of [{ body: 'Revised wording' }, { subject: 'Re: Revised subject' }, { to: 'different@client.example' }, { accountId: ACCOUNT_B.id }]) {
    const f = fixture();
    const { review } = f.workspace.prepare(f.data());
    const draftId = row(f, review.id).draft_id;
    saveReply(f.db, f.config, f.data({ draftId, ...change }));
    assert.equal(row(f, review.id).status, 'cancelled');
    await assert.rejects(f.workspace.send(review.id), statusError(409));
    assert.equal(f.calls.length, 0);
    const next = f.workspace.prepare(f.data({ draftId, ...change })).review;
    assert.notEqual(next.id, review.id);
    assert.equal((await f.workspace.send(next.id)).status, 'sent');
    assert.equal(f.calls.length, 1);
  }
});

test('re-preparing unchanged text invalidates the earlier token; only the latest review can send', async () => {
  const f = fixture();
  const a = f.workspace.prepare(f.data()).review;
  const b = f.workspace.prepare(f.data()).review;
  assert.equal(row(f, a.id).status, 'cancelled');
  assert.notEqual(JSON.parse(row(f, a.id).payload_json).messageId, JSON.parse(row(f, b.id).payload_json).messageId);
  await assert.rejects(f.workspace.send(a.id), statusError(409));
  await f.workspace.send(b.id);
  assert.equal(f.calls.length, 1);
});

test('direct draft or source metadata edits are caught by the review fingerprint', async () => {
  for (const mutate of [
    (f, id) => db_.updateDraft(f.db, id, { body: 'Changed through an older editing route' }),
    (f, id) => db_.updateDraft(f.db, id, { to: 'another@client.example' }),
    (f, id) => f.db.prepare('UPDATE mail_drafts SET account_id=? WHERE draft_id=?').run(ACCOUNT_B.id, id),
    f => db_.upsertMessage(f.db, { ...incoming, references: ['<changed-root@client.example>'] }),
    f => { f.config.mail.find(account => account.id === ACCOUNT_A.id).user = 'changed@studio.example'; },
  ]) {
    const f = fixture();
    const { review } = f.workspace.prepare(f.data());
    mutate(f, row(f, review.id).draft_id);
    await assert.rejects(f.workspace.send(review.id), statusError(409));
    assert.equal(f.calls.length, 0);
  }
});

test('review expires at its deadline and unknown review ids cannot send', async () => {
  const f = fixture();
  const { review } = f.workspace.prepare(f.data());
  f.advance(10 * 60_000);
  await assert.rejects(f.workspace.send(review.id), statusError(409));
  await assert.rejects(f.workspace.send('unknown-review'), statusError(404));
  assert.equal(f.calls.length, 0);
});

test('disabling, removing or changing the account protocol after review blocks sending', async () => {
  for (const mutate of [
    f => { f.config.mail.find(account => account.id === ACCOUNT_A.id).enabled = false; },
    f => { f.config.mail = f.config.mail.filter(account => account.id !== ACCOUNT_A.id); },
    f => { f.config.mail.find(account => account.id === ACCOUNT_A.id).host = 'imap.other.example'; },
    f => { f.config.mail.find(account => account.id === ACCOUNT_A.id).auth = 'oauth2'; },
  ]) {
    const f = fixture();
    const { review } = f.workspace.prepare(f.data()); mutate(f);
    await assert.rejects(f.workspace.send(review.id), error => [404, 409].includes(error.status));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.config.mail[0].host = 'imap.unsupported.example';
  const supported = mailAccounts(f.config);
  assert.equal(supported.find(account => account.id === ACCOUNT_A.id).canSend, true);
  assert.equal(supported.find(account => account.id === ACCOUNT_B.id).canSend, false);
});

test('the chosen account is bound to the immutable review while source metadata stays attached to the parent', async () => {
  const f = fixture();
  const { review } = f.workspace.prepare(f.data({ accountId: ACCOUNT_B.id }));
  assert.equal(review.accountId, ACCOUNT_B.id);
  assert.equal(review.from, ACCOUNT_B.user);
  assert.equal(getMailDraft(f.db, f.config, row(f, review.id).draft_id).message.source_id, ACCOUNT_A.id);
  await f.workspace.send(review.id);
  assert.equal(f.calls[0].account.id, ACCOUNT_B.id);
  assert.equal(f.calls[0].message.from, ACCOUNT_B.user);
  assert.equal(f.calls[0].message.inReplyTo, incoming.messageId);
});

test('a known failure never auto-retries; a new explicit review permits a corrected second attempt', async () => {
  let attempt = 0;
  const f = fixture({ sender: () => ++attempt === 1 ? { status: 'failed', error: { message: 'Synthetic Gmail rejection.' } } : { status: 'accepted' } });
  const { review } = f.workspace.prepare(f.data());
  const failed = await f.workspace.send(review.id);
  assert.equal(failed.status, 'failed');
  assert.equal((await f.workspace.send(review.id)).status, 'failed');
  assert.equal(f.calls.length, 1);
  assert.equal(db_.listCaptures(f.db).length, 0);
  const draftId = row(f, review.id).draft_id;
  assert.equal(assertDraftEditable(f.db, draftId).state, 'edited');
  const next = f.workspace.prepare(f.data({ draftId, body: 'Corrected and newly reviewed message' })).review;
  assert.equal((await f.workspace.send(next.id)).status, 'sent');
  assert.equal(f.calls.length, 2);
  assert.equal(db_.listCaptures(f.db).length, 1);
});

test('uncertain and thrown transport outcomes keep the immutable review and lock every same-parent draft', async () => {
  for (const sender of [() => ({ status: 'uncertain', error: { message: 'Synthetic lost acknowledgement.' } }), () => { throw new Error('Synthetic socket loss'); }, () => ({ status: 'unrecognized' })]) {
    const f = fixture({ sender });
    const secondId = generatedDraft(f, 'uncertain-second');
    const { review } = f.workspace.prepare(f.data());
    assert.equal((await f.workspace.send(review.id)).status, 'uncertain');
    assert.equal((await f.workspace.send(review.id)).status, 'uncertain');
    assert.equal(f.calls.length, 1);
    assert.equal(f.workspace.delivery(review.id).review.body, f.data().body);
    assert.throws(() => saveReply(f.db, f.config, f.data({ draftId: row(f, review.id).draft_id })), statusError(409));
    assert.throws(() => saveReply(f.db, f.config, f.data({ draftId: secondId })), statusError(409));
    assert.equal(db_.listCaptures(f.db).length, 0);
    assert.equal(f.workspace.sendingCount, 0);
  }
});

test('a persisted in-progress send becomes uncertain after process restart and cannot be retried', async () => {
  const f = fixture();
  const { review } = f.workspace.prepare(f.data());
  f.db.prepare("UPDATE mail_outbox SET status='sending' WHERE id=?").run(review.id);
  db_.close(f.db); handles.delete(f.db);
  const reopened = db_.open(f.file); handles.add(reopened); db_.migrate(reopened);
  let calls = 0;
  const restarted = createMailWorkspace({ db: reopened, config: () => f.config, clock: f.clock, sender: async () => { calls++; return { status: 'accepted' }; } });
  const recovered = restarted.delivery(review.id);
  assert.equal(recovered.status, 'uncertain');
  assert.match(recovered.error, /restarted/);
  assert.equal(recovered.review.body, f.data().body);
  assert.equal((await restarted.send(review.id)).status, 'uncertain');
  assert.equal(calls, 0);
  assert.equal(restarted.sendingCount, 0);
  assert.throws(() => saveReply(reopened, f.config, f.data()), statusError(409));
});

test('failure to commit confirmation after SMTP acceptance becomes a durable uncertainty lock', async () => {
  const f = fixture();
  const { review } = f.workspace.prepare(f.data());
  f.db.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON captures BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
  assert.equal((await f.workspace.send(review.id)).status, 'uncertain');
  assert.equal(row(f, review.id).status, 'uncertain');
  assert.equal(db_.getDraft(f.db, row(f, review.id).draft_id).state, 'edited');
  assert.equal(db_.listCaptures(f.db).length, 0);
  assert.equal((await f.workspace.send(review.id)).status, 'uncertain');
  assert.equal(f.calls.length, 1);
  assert.equal(f.workspace.sendingCount, 0);
});

test('a review cancelled by another writer before its conditional claim must not send', async () => {
  let interleave;
  const f = fixture({ configHook: () => { if (interleave) { const run = interleave; interleave = null; run(); } } });
  const { review } = f.workspace.prepare(f.data());
  // This runs after send reads the review but before its conditional UPDATE,
  // representing another database writer cancelling the reviewed content.
  interleave = () => f.db.prepare("UPDATE mail_outbox SET status='cancelled' WHERE id=?").run(review.id);
  await assert.rejects(f.workspace.send(review.id), statusError(409));
  assert.equal(f.calls.length, 0);
  assert.equal(row(f, review.id).status, 'cancelled');
  assert.equal(f.workspace.sendingCount, 0);
});

test('malformed or overlong indexed thread identifiers are omitted before a send review', async () => {
  for (const invalidId of ['<first@second@third.example>', `<${'a'.repeat(900)}@${'b'.repeat(100)}.example>`, '<newline@example.org>\r\nBcc: hidden@example.org']) {
    const f = fixture();
    // Update in place so this test targets header sanitization, not row identity.
    f.db.prepare('UPDATE messages SET message_id=?, references_json=? WHERE id=?')
      .run(invalidId, JSON.stringify(['<valid-root@example.org>', invalidId, '<valid-root@example.org>']), f.parent);
    const { review } = f.workspace.prepare(f.data());
    const payload = JSON.parse(row(f, review.id).payload_json);
    assert.equal(payload.inReplyTo, undefined);
    assert.deepEqual(payload.references, ['<valid-root@example.org>']);
    await f.workspace.send(review.id);
    assert.equal(f.calls[0].message.inReplyTo, undefined);
    assert.deepEqual(f.calls[0].message.references, ['<valid-root@example.org>']);
  }
});

test('lightweight re-fetching cannot erase full Reply-To and References metadata', () => {
  const f = fixture();
  const { replyTo, references, inReplyTo, ...lightweight } = incoming;
  db_.upsertMessage(f.db, { ...lightweight, text: '', snippet: '' });
  const source = getMailMessage(f.db, f.config, f.parent);
  assert.equal(source.replyTo, 'desk@client.example');
  assert.deepEqual(source.message.references, incoming.references);
  assert.equal(source.message.body, incoming.text);
  const { review } = f.workspace.prepare(f.data());
  assert.deepEqual(JSON.parse(row(f, review.id).payload_json).references, ['<thread-root@client.example>', incoming.messageId]);
});

test('generation revision guard detects a new draft and every content edit even within one timestamp', () => {
  const f = fixture();
  assert.equal(draftRevision(f.db, f.parent), null);
  const draft = saveReply(f.db, f.config, f.data());
  let revision = draftRevision(f.db, f.parent);
  assert.ok(revision);
  const timestamp = db_.getDraft(f.db, draft.id).updated_at;
  for (const patch of [{ body: 'The user typed while generation was pending.' }, { to: 'new-recipient@client.example' }, { subject: 'A revised subject' }, { state: 'discarded' }]) {
    db_.updateDraft(f.db, draft.id, patch, { now: timestamp });
    const next = draftRevision(f.db, f.parent);
    assert.notEqual(next, revision);
    revision = next;
  }
});

test('generation revision guard detects an account-only edit made in the same millisecond', () => {
  const f = fixture();
  const draft = saveReply(f.db, f.config, f.data());
  const timestamp = db_.getDraft(f.db, draft.id).updated_at;
  const before = draftRevision(f.db, f.parent);
  saveReply(f.db, f.config, f.data({ draftId: draft.id, accountId: ACCOUNT_B.id }));
  // Make the otherwise legitimate same-millisecond save deterministic.
  f.db.prepare('UPDATE drafts SET updated_at=? WHERE id=?').run(timestamp, draft.id);
  assert.notEqual(draftRevision(f.db, f.parent), before,
    'A late generation response must not restore the earlier selected account');
});

test('incomplete address autosaves are preserved but cannot be prepared for sending', () => {
  const f = fixture();
  const draft = saveReply(f.db, f.config, f.data({ to: 'desk@', body: 'Work in progress' }));
  assert.equal(draft.to_email, 'desk@');
  assert.throws(() => f.workspace.prepare(f.data({ draftId: draft.id, to: 'desk@' })), statusError(400));
  assert.throws(() => saveReply(f.db, f.config, f.data({ draftId: draft.id, to: 'desk@client.example\r\nBcc: hidden@example.org' })), statusError(400));
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mail_outbox').get().n, 0);
});

test('subject controls are sanitized from source mail and rejected from user-edited reviews', () => {
  const f = fixture();
  db_.upsertMessage(f.db, { ...incoming, subject: 'Clinic\tdrawings\x7f' });
  assert.equal(draftDefaults(f.db, f.config, f.parent).subject, 'Re: Clinic drawings ');
  for (const subject of ['Re: Clinic\tdrawings', 'Re: Clinic\x7f', 'Re: Clinic\x01']) {
    assert.throws(() => f.workspace.prepare(f.data({ subject })), statusError(400));
  }
  assert.equal(f.calls.length, 0);
});
