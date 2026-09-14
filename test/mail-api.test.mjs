/** Full HTTP wiring with synthetic mail, fake generation and fake delivery only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mail-api-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const raw = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = raw && typeof raw === 'object' ? raw : { host: args[1] };
  if (options.path || !['127.0.0.1', '::1', 'localhost'].includes(options.host || 'localhost')) {
    throw new Error('External sockets are forbidden in mail API tests.');
  }
  return nativeConnect.apply(this, args);
};
const { createServer, listen } = await import('../core/server.mjs');
const { loadConfig } = await import('../core/config.mjs');
const database = await import('../core/db.mjs');
test.after(() => {
  net.Socket.prototype.connect = nativeConnect;
  fs.rmSync(home, { recursive: true, force: true });
});

const generated = { body: 'Hi Sam,\n\nWhich room would work best for the workshop?\n\nAlex', model: 'nemotron-3-nano:30b', usage: { input: 100, output: 30 } };
const source = {
  sourceId: 'work', messageId: '<incoming-room@example.com>', threadKey: 'room', direction: 'in',
  from: { name: 'Sam', email: 'sam@example.com' }, to: [{ email: 'alex@example.com' }],
  replyTo: [{ name: 'Sam at work', email: 'sam.work@example.com' }], references: ['<previous-room@example.com>'],
  subject: 'Workshop room', text: 'Which room should we use?', date: '2026-09-11T10:00:00Z',
};
async function fixture(t, { generator, sender } = {}) {
  const db = database.open(':memory:');
  database.migrate(db);
  const messageId = database.upsertMessage(db, source).id;
  const calls = { generated: [], sent: [] };
  const defaults = loadConfig();
  const config = {
    ...defaults, identity: { name: 'Alex', email: 'alex@example.com', timezone: 'America/Indiana/Indianapolis' },
    model: { ...defaults.model, protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'nemotron-3-nano:30b', keyRef: null },
    mail: [{ id: 'work', enabled: true, label: 'Work', host: 'imap.gmail.com', user: 'alex@example.com', keyRef: 'mail.synthetic', auth: 'password' }],
    sweep: { ...defaults.sweep, auto: false },
  };
  const server = createServer({
    db, config, scheduler: null,
    mailGenerator: async (options) => { calls.generated.push(options); return generator ? generator(options) : generated; },
    mailSender: async (account, mail) => { calls.sent.push({ account, mail }); return sender ? sender(account, mail) : { status: 'accepted', accepted: [mail.to] }; },
  });
  const { port } = await listen(server, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    database.close(db);
  });
  return { db, server, calls, messageId, base: `http://127.0.0.1:${port}`, token: server.sessionToken };
}
async function call(ctx, method, route, { body, token = ctx.token, origin = ctx.base, signal } = {}) {
  const headers = {};
  if (token !== null) headers['X-Zelos-Token'] = token;
  if (origin !== null) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${ctx.base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  return { status: res.status, body: parsed };
}
const post = (ctx, route, body) => call(ctx, 'POST', `/api/mail/${route}`, { body });
const editable = (ctx, draft, changes = {}) => ({ messageId: ctx.messageId, draftId: draft.id, accountId: draft.account_id, to: draft.to_email, subject: draft.subject, body: draft.body, ...changes });
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test operation did not finish')), 3000); })]); }
  finally { clearTimeout(timer); }
}

test('every mail mutation requires the session token and a same-origin browser request', async (t) => {
  const ctx = await fixture(t);
  for (const route of ['draft', 'save', 'prepare', 'send']) {
    const path = `/api/mail/${route}`;
    assert.equal((await call(ctx, 'POST', path, { token: null, body: { messageId: ctx.messageId } })).status, 401, route);
    assert.equal((await call(ctx, 'POST', path, { origin: 'https://attacker.example', body: { messageId: ctx.messageId } })).status, 403, route);
  }
  assert.equal((await call(ctx, 'GET', '/api/mail/messages', { token: null })).status, 401);
  assert.equal(ctx.calls.generated.length, 0);
  assert.equal(ctx.calls.sent.length, 0);
  assert.equal(database.listDrafts(ctx.db).length, 0);
});

test('list, generate, edit, review and explicit send are wired to the exact reviewed reply once', async (t) => {
  const ctx = await fixture(t);
  const inbox = await call(ctx, 'GET', '/api/mail/messages');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.accounts[0].canSend, true);
  assert.equal(inbox.body.messages[0].id, ctx.messageId);
  const opened = await call(ctx, 'GET', `/api/mail/messages/${ctx.messageId}`);
  assert.equal(opened.body.replyTo, 'sam.work@example.com');
  const made = await post(ctx, 'draft', { messageId: ctx.messageId, instructions: 'Ask which room works best.' });
  assert.equal(made.status, 200);
  assert.equal(made.body.draft.body, generated.body);
  assert.equal(made.body.draft.to_email, 'sam.work@example.com');
  assert.equal(ctx.calls.generated[0].instructions, 'Ask which room works best.');
  assert.equal(ctx.calls.sent.length, 0);

  const exactBody = 'Hi Sam, could you confirm which room is available?\n\nThanks,\nAlex';
  const saved = await post(ctx, 'save', editable(ctx, made.body.draft, { body: exactBody, subject: 'Re: Workshop room options' }));
  assert.equal(saved.status, 200);
  const review = await post(ctx, 'prepare', editable(ctx, saved.body.draft));
  assert.equal(review.status, 200);
  assert.equal(review.body.review.body, exactBody);
  assert.equal(review.body.review.to, 'sam.work@example.com');
  assert.equal(ctx.calls.sent.length, 0, 'preparing a review is not a send');
  const delivered = await post(ctx, 'send', { reviewId: review.body.review.id });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.status, 'sent');
  assert.equal(ctx.calls.sent.length, 1);
  const transmitted = ctx.calls.sent[0];
  assert.equal(transmitted.account.id, 'work');
  assert.equal(transmitted.mail.from, 'alex@example.com');
  assert.equal(transmitted.mail.to, review.body.review.to);
  assert.equal(transmitted.mail.subject, review.body.review.subject);
  assert.equal(transmitted.mail.text, review.body.review.body);
  assert.deepEqual(transmitted.mail.envelope, { from: 'alex@example.com', to: ['sam.work@example.com'] });
  assert.equal(transmitted.mail.inReplyTo, source.messageId);
  assert.deepEqual(transmitted.mail.references, [...source.references, source.messageId]);
  assert.equal((await post(ctx, 'send', { reviewId: review.body.review.id })).body.status, 'sent');
  assert.equal(ctx.calls.sent.length, 1, 'a retried confirmation never sends twice');
  const receipt = await call(ctx, 'GET', `/api/mail/delivery/${review.body.review.id}`);
  assert.equal(receipt.body.status, 'sent');
  const reopened = await call(ctx, 'GET', `/api/mail/drafts/${made.body.draft.id}`);
  assert.equal(reopened.body.draft.delivery.status, 'sent');
  assert.equal((await post(ctx, 'save', editable(ctx, made.body.draft, { body: 'Do not resend this.' }))).status, 409);
});

test('sending requires an unchanged prepared review; saving an edit invalidates the older review', async (t) => {
  const ctx = await fixture(t);
  assert.equal((await post(ctx, 'send', { to: 'sam@example.com', body: 'Skip review' })).status, 400);
  const made = (await post(ctx, 'draft', { messageId: ctx.messageId })).body.draft;
  const review = (await post(ctx, 'prepare', editable(ctx, made))).body.review;
  assert.equal((await post(ctx, 'save', editable(ctx, made, { body: 'A newer reviewed reply.' }))).status, 200);
  assert.equal((await post(ctx, 'send', { reviewId: review.id })).status, 409);
  assert.equal(ctx.calls.sent.length, 0);
});

test('regenerating body text preserves the user’s edited recipient and subject', async (t) => {
  const ctx = await fixture(t);
  const first = (await post(ctx, 'draft', { messageId: ctx.messageId })).body.draft;
  await post(ctx, 'save', editable(ctx, first, { to: 'sam.alternate@example.com', subject: 'My chosen subject', body: 'Earlier text.' }));
  const second = await post(ctx, 'draft', { messageId: ctx.messageId });
  assert.equal(second.status, 200);
  assert.equal(second.body.draft.to_email, 'sam.alternate@example.com');
  assert.equal(second.body.draft.subject, 'My chosen subject');
  assert.equal(second.body.draft.body, generated.body);
  assert.equal(ctx.calls.sent.length, 0);
});

test('a late generated reply cannot overwrite an edit made while generation was running', async (t) => {
  const started = deferred(), completion = deferred();
  let slow = false;
  const ctx = await fixture(t, { generator: () => { if (!slow) return generated; started.resolve(); return completion.promise; } });
  const first = (await post(ctx, 'draft', { messageId: ctx.messageId })).body.draft;
  slow = true;
  const pending = post(ctx, 'draft', { messageId: ctx.messageId });
  await bounded(started.promise);
  const saved = await post(ctx, 'save', editable(ctx, first, { to: 'reviewed@example.com', subject: 'User’s current subject', body: 'User’s current text.' }));
  assert.equal(saved.status, 200);
  completion.resolve({ ...generated, body: 'Late model replacement.' });
  assert.equal((await bounded(pending)).status, 409);
  const current = (await call(ctx, 'GET', `/api/mail/messages/${ctx.messageId}`)).body.draft;
  assert.equal(current.body, 'User’s current text.');
  assert.equal(current.to_email, 'reviewed@example.com');
  assert.equal(current.subject, 'User’s current subject');
  assert.equal(ctx.calls.sent.length, 0);
});

test('closing a generation request aborts the model and leaves the existing draft unchanged', async (t) => {
  const started = deferred(), aborted = deferred();
  let slow = false;
  const ctx = await fixture(t, { generator: ({ signal }) => {
    if (!slow) return generated;
    started.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true }));
  } });
  const first = (await post(ctx, 'draft', { messageId: ctx.messageId })).body.draft;
  slow = true;
  const controller = new AbortController();
  const pending = call(ctx, 'POST', '/api/mail/draft', { body: { messageId: ctx.messageId }, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await bounded(started.promise);
  controller.abort();
  await rejected;
  await bounded(aborted.promise);
  assert.equal(database.getDraft(ctx.db, first.id).body, first.body);
  assert.equal(ctx.calls.sent.length, 0);
});
