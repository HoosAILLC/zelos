import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mail-send-test-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
const forbidden = () => { throw new Error('Transport tests must not open network connections.'); };
mock.method(net, 'connect', forbidden);
mock.method(net, 'createConnection', forbidden);
mock.method(tls, 'connect', forbidden);
const { mailSendCapability, sendMail, verifyMailAccount } = await import('../core/mail-send.mjs');
const { default: nodemailer } = await import('nodemailer');
after(() => { mock.restoreAll(); fs.rmSync(home, { recursive: true, force: true }); });

const account = Object.freeze({ id: 'm_test', enabled: true, host: 'imap.gmail.com', user: 'sender@example.com', auth: 'password', keyRef: 'mail.synthetic' });
const message = Object.freeze({
  envelope: { from: account.user, to: ['recipient@example.org'] },
  from: account.user, to: ['recipient@example.org'],
  subject: 'A reviewed reply', text: 'The exact reviewed text.\n\nThank you!',
  messageId: '<outbound-fixed-id@example.com>',
  inReplyTo: '<parent-id@example.org>', references: ['<first-id@example.org>', '<parent-id@example.org>'],
});

function fake({ info = { accepted: message.envelope.to, rejected: [], messageId: message.messageId }, error, verifyError, verifyValue = true, closeError } = {}) {
  const calls = { secret: [], options: [], messages: [], verify: 0, close: 0 };
  return {
    calls,
    deps: {
      secretReader: async ref => { calls.secret.push(ref); return 'synthetic-app-password'; },
      transportFactory: options => {
        calls.options.push(options);
        return {
          sendMail: async value => { calls.messages.push(value); if (error) throw error; return info; },
          verify: async () => { calls.verify++; if (verifyError) throw verifyError; return verifyValue; },
          close: () => { calls.close++; if (closeError) throw closeError; },
        };
      },
    },
  };
}

test('only supported configured Gmail app-password accounts are offered, without reading secrets', () => {
  assert.deepEqual(mailSendCapability(account), { supported: true, provider: 'gmail', from: account.user });
  assert.equal(mailSendCapability({ ...account, auth: undefined }).supported, true);
  assert.equal(mailSendCapability({ ...account, host: 'IMAP.GMAIL.COM' }).supported, true);
  for (const patch of [{ host: 'imap.example.com' }, { host: 'imap.gmail.com.attacker.example' }, { auth: 'google-oauth' }, { auth: null }, { enabled: false }, { user: 'not an email' }, { keyRef: '../password' }]) {
    assert.equal(mailSendCapability({ ...account, ...patch }).supported, false);
  }
});

test('passes the exact reviewed message and threading fields once over fixed authenticated TLS', async () => {
  const { calls, deps } = fake();
  const result = await sendMail({ ...account, smtp: { host: 'attacker.example', secure: false }, password: 'not-used' }, message, deps);
  assert.deepEqual(result, { status: 'accepted', accepted: message.to, rejected: [], messageId: message.messageId });
  assert.deepEqual(calls.secret, [account.keyRef]);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.verify, 0);
  assert.equal(calls.close, 1);
  for (const [key, value] of Object.entries(message)) assert.deepEqual(calls.messages[0][key], value);
  const opts = calls.options[0];
  assert.equal(opts.host, 'smtp.gmail.com');
  assert.equal(opts.port, 465);
  assert.equal(opts.secure, true);
  assert.equal(opts.forceAuth, true);
  assert.deepEqual(opts.auth, { user: account.user, pass: 'synthetic-app-password' });
  assert.deepEqual(opts.tls, { servername: 'smtp.gmail.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  for (const key of ['pool', 'logger', 'debug', 'transactionLog']) assert.equal(opts[key], false);
  for (const key of ['disableFileAccess', 'disableUrlAccess']) assert.equal(opts[key], true);
  assert.equal(Object.hasOwn(opts, 'proxy'), false);
});

test('rejects unsupported accounts and unsafe or mismatched reviewed fields before secret access', async () => {
  const variants = [
    { from: 'other@example.com' },
    { envelope: { ...message.envelope, from: 'other@example.com' } },
    { envelope: { ...message.envelope, to: ['hidden@example.com'] } },
    { to: ['recipient@example.org', 'RECIPIENT@example.org'] },
    { to: 'recipient@example.org, hidden@example.com' },
    { to: { address: 'recipient@example.org' } },
    { subject: 'Hello\r\nBcc: hidden@example.com' },
    { text: { path: '/private/secret' } },
    { text: '' },
    { text: 'x'.repeat(20_001) },
    { messageId: '' },
    { messageId: '<id@example.org>\r\nBcc: hidden@example.com' },
    { inReplyTo: 'not-a-message-id' },
    { references: ['<good@example.org>', 'bad'] },
    { headers: { Bcc: 'hidden@example.com' } },
    { attachments: [{ path: '/private/secret' }] },
    { raw: { href: 'https://attacker.example' } },
    { envelope: { ...message.envelope, dsn: {} } },
    { auth: { user: 'attacker' } },
  ];
  for (const patch of variants) {
    const { calls, deps } = fake();
    assert.equal((await sendMail(account, { ...message, ...patch }, deps)).status, 'failed');
    assert.deepEqual(calls.secret, []);
    assert.deepEqual(calls.options, []);
  }
  const { calls, deps } = fake();
  const result = await sendMail({ ...account, host: 'imap.attacker.example' }, message, deps);
  assert.equal(result.error.code, 'EUNSUPPORTED');
  assert.deepEqual(calls.secret, []);
});

test('missing or unreadable secrets fail without transport creation or secret-bearing errors', async () => {
  for (const secretReader of [async () => null, async () => '', async () => ({ password: 'hidden' }), async () => { throw new Error('private password and message body'); }]) {
    const { calls, deps } = fake();
    const result = await sendMail(account, message, { ...deps, secretReader });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'ESECRET');
    assert.deepEqual(calls.options, []);
    assert.doesNotMatch(JSON.stringify(result), /private password|message body|hidden/);
  }
});

test('explicit SMTP rejections and known pre-send failures are failed, without retry', async () => {
  for (const error of [
    { code: 'EAUTH', command: 'AUTH LOGIN', responseCode: 535 },
    { code: 'EDNS', command: 'CONN' },
    { code: 'ETLS', command: 'CONN' },
    { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, rejected: message.to },
    { code: 'EMESSAGE', command: 'DATA', responseCode: 554 },
    { code: 'EMESSAGE', command: 'DATA', responseCode: 451 },
  ]) {
    const { calls, deps } = fake({ error: { ...error, message: 'secret and full body', response: 'sensitive server echo' } });
    const result = await sendMail(account, message, deps);
    assert.equal(result.status, 'failed');
    assert.equal(calls.messages.length, 1);
    assert.equal(calls.close, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret and full body|sensitive server echo/);
  }
});

test('lost DATA confirmation, generic failures and CONN timeouts stay uncertain and are never retried', async () => {
  for (const error of [
    { code: 'ETIMEDOUT', command: 'DATA' },
    { code: 'ETIMEDOUT', command: 'CONN' },
    { code: 'ESOCKET', command: 'CONN' },
    { code: 'ECONNECTION', command: 'CONN' },
    { code: 'ESTREAM', command: 'API' },
    { code: 'EPROTOCOL', responseCode: 250 },
    new Error('Unexpected socket close'),
  ]) {
    const { calls, deps } = fake({ error });
    const result = await sendMail(account, message, deps);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.error.code, 'EDELIVERYUNCERTAIN');
    assert.equal(result.messageId, message.messageId);
    assert.deepEqual(result.accepted, []);
    assert.equal(calls.messages.length, 1);
    assert.equal(calls.close, 1);
  }
});

test('partial recipient acceptance is preserved; missing acceptance evidence is uncertain', async () => {
  const to = ['recipient@example.org', 'second@example.net'];
  const partial = fake({ info: { accepted: [to[0]], rejected: [to[1]] } });
  assert.deepEqual(await sendMail(account, { ...message, to, envelope: { from: account.user, to } }, partial.deps), {
    status: 'accepted', accepted: [to[0]], rejected: [to[1]], messageId: message.messageId,
  });
  assert.equal(partial.calls.messages.length, 1);
  const unknown = fake({ info: { accepted: [], rejected: [] } });
  assert.equal((await sendMail(account, message, unknown.deps)).status, 'uncertain');
  const rejected = fake({ info: { accepted: [], rejected: message.to } });
  assert.equal((await sendMail(account, message, rejected.deps)).status, 'failed');
});

test('cleanup failure cannot overwrite SMTP acceptance or cause a retry', async () => {
  const { calls, deps } = fake({ closeError: new Error('cleanup failure') });
  assert.equal((await sendMail(account, message, deps)).status, 'accepted');
  assert.equal(calls.messages.length, 1);
});

test('verify connects/authenticates through the injected transport and never calls sendMail', async () => {
  const { calls, deps } = fake();
  assert.deepEqual(await verifyMailAccount(account, deps), { status: 'verified' });
  assert.equal(calls.verify, 1);
  assert.deepEqual(calls.messages, []);
  assert.equal(calls.close, 1);
  const failed = fake({ verifyError: { code: 'ETIMEDOUT', message: 'credential-bearing detail' } });
  const result = await verifyMailAccount(account, failed.deps);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EVERIFY');
  assert.deepEqual(failed.calls.messages, []);
  assert.doesNotMatch(JSON.stringify(result), /credential-bearing/);
});

test('the installed Nodemailer composes the exact plain-text and reply headers entirely in memory', async () => {
  let composed;
  const transportFactory = () => {
    const local = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix', disableFileAccess: true, disableUrlAccess: true });
    return {
      sendMail: async prepared => {
        const info = await local.sendMail(prepared);
        composed = info.message.toString('utf8');
        assert.equal(info.messageId, message.messageId);
        assert.deepEqual(info.envelope, message.envelope);
        return { ...info, accepted: info.envelope.to, rejected: [] };
      },
      close: () => local.close(),
    };
  };
  const result = await sendMail(account, message, { transportFactory, secretReader: async () => 'synthetic-only' });
  assert.equal(result.status, 'accepted');
  assert.match(composed, /From: sender@example.com\r?\n/);
  assert.match(composed, /To: recipient@example.org\r?\n/);
  assert.match(composed, /Subject: A reviewed reply\r?\n/);
  assert.match(composed, /Message-ID: <outbound-fixed-id@example.com>\r?\n/);
  assert.match(composed, /In-Reply-To: <parent-id@example.org>\r?\n/);
  assert.match(composed, /References: <first-id@example.org> <parent-id@example.org>\r?\n/);
  assert.equal(composed.split(/\r?\n\r?\n/).slice(1).join('\n\n').replace(/\r\n/g, '\n').trimEnd(), message.text);
});
