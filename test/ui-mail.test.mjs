import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';

let fixtureId = 0;
const account = { id: 'mail-one', label: 'Work', address: 'owner@example.test', canSend: true };
const messages = [
  { id: 'message-one', source_id: account.id, from_name: 'Project partner', from_email: 'partner@example.test',
    to: [{ email: account.address }], subject: 'Atlas decision', sent_at: '2026-09-11T09:00:00Z', snippet: 'Can we use the original schedule?',
    body: '<img src="https://tracker.example.test/pixel">\nCan we use the original schedule?' },
  { id: 'message-two', source_id: account.id, from_name: 'Another partner', from_email: 'other@example.test',
    to: [{ email: account.address }], subject: 'Second project', sent_at: '2026-09-10T09:00:00Z', snippet: 'An unrelated message.', body: 'An unrelated message.' },
];

async function fixture(t, { existingDraft = null } = {}) {
  const document = installDom(t);
  const windowListeners = new Map();
  window.addEventListener = (type, listener) => windowListeners.set(type, [...(windowListeners.get(type) || []), listener]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api } = await import('../ui/lib/api.js');
  const { state } = await import('../ui/lib/store.js');
  const before = { health: state.health, rev: state.rev };
  state.health = { model: { configured: true, local: true } };
  state.rev = 100;
  t.after(() => Object.assign(state, before));
  const drafts = new Map(existingDraft ? [[existingDraft.message_id, { ...existingDraft }]] : []);
  const calls = [];
  let reviewCount = 0;
  const handlers = {
    mailMessages: async () => ({ accounts: [account], messages: messages.map(({ body, ...message }) => message), nextCursor: null }),
    mailMessage: async id => ({ message: messages.find(message => message.id === id), accountId: account.id,
      replyTo: 'replies@example.test', draft: drafts.get(id) || null }),
    mailDraft: async id => {
      const draft = [...drafts.values()].find(draft => draft.id === id);
      return { draft, message: messages.find(message => message.id === draft?.message_id), accountId: account.id, replyTo: 'replies@example.test' };
    },
    saveMailReply: async value => {
      const draft = { id: value.draftId || `draft-${value.messageId}`, message_id: value.messageId, account_id: value.accountId,
        to_email: value.to, subject: value.subject, body: value.body, state: 'edited' };
      drafts.set(value.messageId, draft);
      return { draft };
    },
    draftMailReply: async value => {
      const draft = { id: `draft-${value.messageId}`, message_id: value.messageId, account_id: value.accountId,
        to_email: 'replies@example.test', subject: 'Re: Atlas decision', body: 'Yes, the original schedule works.', state: 'pending' };
      drafts.set(value.messageId, draft);
      return { draft, model: 'nemotron-3-nano:30b' };
    },
    prepareMailReply: async value => ({ review: { id: `review-${++reviewCount}`, from: 'Work <owner@example.test>',
      to: value.to, subject: value.subject, body: value.body, accountId: value.accountId, expiresAt: '2026-09-11T12:00:00Z' } }),
    sendMailReply: async () => ({ ok: true, status: 'sent', sentAt: '2026-09-11T10:00:00Z' }),
    mailDelivery: async () => ({ ok: true, status: 'sent', sentAt: '2026-09-11T10:00:00Z' }),
  };
  const descriptors = new Map();
  for (const name of Object.keys(handlers)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(api, name));
    api[name] = (...args) => { calls.push({ name, args }); return handlers[name](...args); };
  }
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(api, name, descriptor); else delete api[name];
    }
  });
  const mail = await import(`../ui/views/mail.js?fixture=${++fixtureId}`);
  const routes = [];
  const ctx = { navigate: route => routes.push(route) };
  const view = document.body.appendChild(mail.renderMail(ctx));
  await settle();
  return { document, state, mail, handlers, calls, drafts, routes, ctx, view,
    beforeUnload() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of windowListeners.get('beforeunload') || []) listener(event);
      return event;
    },
    async open(id = 'message-one') { mail.renderMail({ ...ctx, sub: id }); await settle(); },
    input(label, value) {
      const input = view.querySelector(`[aria-label="${label}"]`);
      assert.ok(input, label);
      input.value = value;
      input.fire(input.tag === 'select' ? 'change' : 'input');
      return input;
    },
  };
}

test('email reading uses plain text and account/search filters without invoking generation or send', async t => {
  const { view, calls, open, input } = await fixture(t);
  assert.equal(view.querySelectorAll('.mail-row').length, 2);
  input('Filter by account', account.id);
  await settle();
  assert.equal(calls.at(-1).args[0].accountId, account.id);
  const search = input('Search saved emails', 'Atlas');
  search.fire('keydown', { key: 'Enter' });
  await settle();
  assert.equal(calls.at(-1).args[0].q, 'Atlas');
  await open();
  assert.equal(view.dataset.pane, 'message');
  assert.equal(view.querySelector('.mail-message-body').textContent, messages[0].body);
  assert.equal(view.querySelectorAll('img').length, 0, 'message content must not create remote images or markup');
  assert.equal(view.querySelector('[aria-label="To"]').value, 'replies@example.test');
  assert.equal(calls.some(call => ['draftMailReply', 'prepareMailReply', 'sendMailReply'].includes(call.name)), false);
});

test('email list, reading and delivery dates use the configured timezone', async t => {
  const { view, state, mail, ctx, handlers, input } = await fixture(t);
  const message = { ...messages[0], sent_at: '2026-09-11T00:15:00Z' };
  handlers.mailMessages = async () => ({ accounts: [account], messages: [message], nextCursor: null });
  handlers.mailMessage = async () => ({ message, accountId: account.id, replyTo: message.from_email, draft: null });
  state.rev += 1;
  mail.renderMail({ ...ctx, sub: message.id, tz: 'America/Los_Angeles' });
  await settle();
  assert.equal(view.querySelector('.mail-date').textContent, 'Thu, Sep 10');
  assert.match(text(view.querySelector('.mail-message-heading')), /Thu, Sep 10 · 5:15 PM/);
  input('Reply body', 'A reviewed reply.');
  findButton(view, 'Review reply').click(); await settle();
  handlers.sendMailReply = async () => ({ ok: true, status: 'sent', sentAt: message.sent_at });
  findButton(view, 'Send reply').click(); await settle();
  assert.match(text(view.querySelector('.mail-reply-status')), /Reply sent · Thu, Sep 10 · 5:15 PM/);
});

test('a new reply visibly defaults to the sender when there is no Reply-To header', async t => {
  const { view, handlers, open } = await fixture(t);
  handlers.mailMessage = async () => ({ message: messages[1], accountId: account.id, replyTo: '', draft: null });
  await open('message-two');
  assert.equal(view.querySelector('[aria-label="To"]').value, messages[1].from_email);
  assert.equal(view.querySelector('[aria-label="Subject"]').value, 'Re: Second project');
});

test('a deliberately cleared recipient stays blank when reopening its saved draft', async t => {
  const draft = { id: 'draft-one', message_id: 'message-one', account_id: account.id,
    to_email: '', subject: 'Re: Atlas decision', body: 'My saved text', state: 'edited' };
  const { view, open } = await fixture(t, { existingDraft: draft });
  await open();
  assert.equal(view.querySelector('[aria-label="To"]').value, '');
  assert.equal(view.querySelector('[aria-label="Reply body"]').value, 'My saved text');
});

test('returning from Promises refreshes a clean cached draft and preserves unsaved edits', async t => {
  const draft = { id: 'draft-one', message_id: 'message-one', account_id: account.id,
    to_email: 'replies@example.test', subject: 'Re: Atlas decision', body: 'First saved text', state: 'edited' };
  const { view, mail, ctx, drafts, input, calls } = await fixture(t, { existingDraft: draft });
  mail.renderMail({ ...ctx, mailDraftId: draft.id, mailVisit: 1 });
  await settle();
  const body = view.querySelector('[aria-label="Reply body"]');
  drafts.set('message-one', { ...draft, body: 'Edited in Promises' });
  mail.renderMail({ ...ctx, mailDraftId: draft.id, mailVisit: 2 });
  await settle();
  assert.equal(view.querySelector('[aria-label="Reply body"]'), body, 'refresh reuses the editor');
  assert.equal(body.value, 'Edited in Promises');
  input('Reply body', 'My latest unsaved wording');
  mail.renderMail({ ...ctx, mailDraftId: draft.id, mailVisit: 3 });
  await settle();
  assert.equal(body.value, 'My latest unsaved wording');
  assert.equal(calls.filter(call => call.name === 'mailDraft').length, 3);
  await mail.flushMailDrafts();
});

test('browser unload protection exists only for unsaved or saving replies, and backgrounding saves', async t => {
  const { document, beforeUnload, view, mail, handlers, open, input } = await fixture(t);
  await open();
  assert.equal(beforeUnload().defaultPrevented, false, 'reading a message must not prompt');
  let finish;
  handlers.saveMailReply = value => new Promise(resolve => {
    finish = () => resolve({ draft: { id: 'saved', body: value.body } });
  });
  input('Reply body', 'Keep this on my phone');
  const dirty = beforeUnload();
  assert.equal(dirty.defaultPrevented, true);
  assert.equal(dirty.returnValue, '');
  await settle();
  assert.equal(beforeUnload().defaultPrevented, true, 'an in-flight write still needs protection');
  finish(); await mail.flushMailDrafts();
  assert.equal(beforeUnload().defaultPrevented, false, 'a confirmed save removes the warning');
  input('Reply body', 'Save when I switch apps');
  document.visibilityState = 'hidden';
  for (const listener of document.listeners.get('visibilitychange') || []) listener();
  await settle();
  assert.match(text(view.querySelector('.mail-reply-status')), /Saving draft/);
  finish(); await mail.flushMailDrafts();
  assert.equal(beforeUnload().defaultPrevented, false);
});

test('reply inputs survive background revisions, autosave, message changes and returning from the phone list', async t => {
  const { state, mail, ctx, view, drafts, routes, open, input } = await fixture(t);
  await open();
  const field = input('Reply body', 'Keep this exact reply while background checks finish.');
  state.rev += 1;
  assert.equal(mail.renderMail({ ...ctx, sub: 'message-one' }), view);
  await settle();
  assert.equal(view.querySelector('[aria-label="Reply body"]'), field);
  assert.equal(field.value, 'Keep this exact reply while background checks finish.');
  t.mock.timers.tick(900);
  await settle();
  assert.equal(drafts.get('message-one').body, field.value);
  input('Reply body', 'Save this newer edit before changing emails.');
  view.querySelectorAll('.mail-row')[1].click();
  await settle();
  assert.equal(drafts.get('message-one').body, 'Save this newer edit before changing emails.');
  assert.equal(routes.at(-1), '#/mail/message-two');
  await open('message-one');
  assert.equal(view.querySelector('[aria-label="Reply body"]'), field);
  assert.equal(field.value, 'Save this newer edit before changing emails.');
  findButton(view, 'Back to emails').click();
  await settle();
  assert.equal(view.dataset.pane, 'list');
  assert.equal(routes.at(-1), '#/mail');
});

test('The configured AI drafts only after a click, saves current work first, and never sends generated text', async t => {
  const { view, calls, open, input } = await fixture(t);
  await open();
  input('Reply body', 'My original note');
  input('Draft instructions', 'Confirm the original schedule, briefly.');
  findButton(view, 'Draft with AI').click();
  await settle();
  assert.deepEqual(calls.filter(call => !['mailMessages', 'mailMessage'].includes(call.name)).map(call => call.name),
    ['saveMailReply', 'draftMailReply']);
  assert.equal(calls.find(call => call.name === 'draftMailReply').args[0].instructions, 'Confirm the original schedule, briefly.');
  assert.equal(view.querySelector('[aria-label="Reply body"]').value, 'Yes, the original schedule works.');
  assert.match(text(view.querySelector('.mail-reply-status')), /Draft ready/);
  assert.equal(calls.some(call => call.name === 'sendMailReply'), false);
});

test('sending requires an exact server review and only the final Send reply button can send once', async t => {
  const { view, calls, handlers, open, input } = await fixture(t);
  await open();
  input('To', 'intended@example.test');
  input('Subject', 'Re: Exact review');
  input('Reply body', 'Exact body\nwith two lines.');
  findButton(view, 'Review reply').click();
  await settle();
  const review = view.querySelector('.mail-review');
  assert.match(text(review), /Work <owner@example.test>.*intended@example.test.*Re: Exact review.*Exact body/);
  assert.equal(review.querySelector('.mail-review-body').textContent, 'Exact body\nwith two lines.');
  assert.equal(calls.some(call => call.name === 'sendMailReply'), false);
  assert.deepEqual(calls.filter(call => ['saveMailReply', 'prepareMailReply'].includes(call.name)).map(call => call.name),
    ['saveMailReply', 'prepareMailReply']);
  let finish;
  handlers.sendMailReply = () => new Promise(resolve => { finish = resolve; });
  const send = findButton(review, 'Send reply');
  assert.equal(send.disabled, false, 'a prepared review must enable its final Send button');
  assert.equal(findButton(review, 'Back to editing').disabled, false);
  send.click(); send.click();
  assert.deepEqual(calls.filter(call => call.name === 'sendMailReply').map(call => call.args[0]), [{ reviewId: 'review-1' }]);
  finish({ ok: true, status: 'sent' });
  await settle();
  assert.match(text(view.querySelector('.mail-reply-status')), /Reply sent/);
  assert.equal(findButton(view, 'Send reply'), undefined);
  assert.equal(findButton(view, 'Back to editing'), undefined);
});

test('ambiguous delivery locks the reply and checks the same review instead of retrying or preparing another send', async t => {
  const { view, calls, handlers, open, input } = await fixture(t);
  await open();
  input('Reply body', 'Do not duplicate this reply.');
  findButton(view, 'Review reply').click();
  await settle();
  handlers.sendMailReply = async () => { throw new Error('Connection lost'); };
  findButton(view, 'Send reply').click();
  await settle();
  assert.match(text(view.querySelector('.mail-reply-status')), /Delivery is not confirmed/);
  assert.equal(findButton(view, 'Send reply'), undefined);
  assert.equal(findButton(view, 'Back to editing'), undefined);
  assert.equal(view.querySelector('[aria-label="Reply body"]').disabled, true);
  handlers.mailDelivery = async () => ({ status: 'sending', reviewId: 'review-1' });
  findButton(view, 'Check delivery status').click();
  await settle();
  assert.equal(calls.at(-1).name, 'mailDelivery');
  assert.equal(calls.at(-1).args[0], 'review-1');
  handlers.mailDelivery = async () => ({ ok: true, status: 'sent', reviewId: 'review-1' });
  findButton(view, 'Check delivery status').click();
  await settle();
  assert.equal(calls.filter(call => call.name === 'sendMailReply').length, 1);
  assert.equal(calls.filter(call => call.name === 'prepareMailReply').length, 1);
  assert.match(text(view.querySelector('.mail-reply-status')), /Reply sent/);
});

test('a draft deep link restores uncertain delivery without sending or silently unlocking it', async t => {
  const review = { id: 'old-review', from: 'owner@example.test', to: 'partner@example.test', subject: 'Re: Atlas decision',
    body: 'The previously reviewed reply.', accountId: account.id };
  const draft = { id: 'existing-draft', message_id: 'message-one', account_id: account.id, to_email: review.to,
    subject: review.subject, body: review.body, state: 'edited', delivery: { status: 'uncertain', reviewId: review.id, review } };
  const { mail, ctx, view, calls } = await fixture(t, { existingDraft: draft });
  mail.renderMail({ ...ctx, mailDraftId: draft.id });
  await settle();
  assert.equal(view.querySelector('.mail-review-body').textContent, review.body);
  assert.ok(findButton(view, 'Check delivery status'));
  assert.equal(findButton(view, 'Send reply'), undefined);
  assert.equal(calls.some(call => ['sendMailReply', 'prepareMailReply', 'draftMailReply'].includes(call.name)), false);
});

test('a failed save keeps the reply visible and blocks review or navigation until it can be saved', async t => {
  const { mail, view, calls, handlers, routes, open, input } = await fixture(t);
  await open();
  const field = input('Reply body', 'Keep my unsaved reply.');
  handlers.saveMailReply = async () => { throw new Error('Storage unavailable'); };
  findButton(view, 'Review reply').click();
  await settle();
  assert.equal(calls.some(call => call.name === 'prepareMailReply'), false);
  assert.equal(field.value, 'Keep my unsaved reply.');
  assert.match(text(view.querySelector('.mail-reply-status')), /Storage unavailable/);
  view.querySelectorAll('.mail-row')[1].click();
  await settle();
  assert.deepEqual(routes, []);
  assert.equal(view.querySelector('[aria-label="Reply body"]'), field);
  await assert.rejects(mail.flushMailDrafts(), /Storage unavailable/);
});

test('typing during an autosave is serialized into a second write before leaving', async t => {
  const { mail, handlers, drafts, calls, open, input } = await fixture(t);
  await open();
  const save = handlers.saveMailReply;
  let finishFirst;
  let first = true;
  handlers.saveMailReply = value => {
    if (!first) return save(value);
    first = false;
    return new Promise(resolve => { finishFirst = async () => resolve(await save(value)); });
  };
  input('Reply body', 'First version');
  t.mock.timers.tick(900);
  await settle();
  input('Reply body', 'The latest version typed during the save');
  const leaving = mail.flushMailDrafts();
  await finishFirst();
  await leaving;
  assert.deepEqual(calls.filter(call => call.name === 'saveMailReply').map(call => call.args[0].body),
    ['First version', 'The latest version typed during the save']);
  assert.equal(drafts.get('message-one').body, 'The latest version typed during the save');
});

test('stopping local generation keeps the saved reply through background rerenders and sends nothing', async t => {
  const { mail, ctx, state, view, calls, handlers, open, input } = await fixture(t);
  await open();
  const field = input('Reply body', 'Keep my original wording');
  handlers.draftMailReply = (_value, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
  });
  findButton(view, 'Draft with AI').click();
  await settle();
  assert.equal(field.disabled, true);
  state.rev += 1;
  assert.equal(mail.renderMail({ ...ctx, sub: 'message-one' }), view);
  await settle();
  assert.equal(view.querySelector('[aria-label="Reply body"]'), field);
  findButton(view, 'Stop drafting').click();
  await settle();
  assert.equal(field.value, 'Keep my original wording');
  assert.equal(field.disabled, false);
  assert.match(text(view.querySelector('.mail-reply-status')), /Drafting stopped/);
  assert.equal(calls.some(call => ['prepareMailReply', 'sendMailReply'].includes(call.name)), false);
});

test('an expired review is recoverable after status read-back without an automatic replacement or send', async t => {
  const { view, calls, handlers, open, input } = await fixture(t);
  await open();
  input('Reply body', 'Review this again if it expires.');
  findButton(view, 'Review reply').click();
  await settle();
  handlers.sendMailReply = async () => { throw new Error('This review expired'); };
  findButton(view, 'Send reply').click();
  await settle();
  handlers.mailDelivery = async () => ({ status: 'review', reviewId: 'review-1', review: {
    id: 'review-1', from: account.address, to: 'replies@example.test', subject: 'Re: Atlas decision',
    body: 'Review this again if it expires.', accountId: account.id, expiresAt: '2000-01-01T00:00:00Z',
  } });
  findButton(view, 'Check delivery status').click();
  await settle();
  assert.match(text(view.querySelector('.mail-reply-status')), /review expired or changed/i);
  assert.ok(findButton(view, 'Back to editing'));
  assert.equal(findButton(view, 'Send reply'), undefined);
  assert.equal(calls.filter(call => call.name === 'sendMailReply').length, 1);
  assert.equal(calls.filter(call => call.name === 'prepareMailReply').length, 1);
  findButton(view, 'Back to editing').click();
  assert.equal(view.querySelector('[aria-label="Reply body"]').value, 'Review this again if it expires.');
  assert.equal(view.querySelector('.mail-reply-fields').hidden, false);
});
