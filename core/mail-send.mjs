/**
 * Explicit, one-attempt delivery of a reviewed plain-text email.
 * The caller owns approval and durable idempotency BEFORE calling sendMail.
 * SMTP acceptance means Gmail accepted responsibility, not inbox delivery.
 *
 * https://nodemailer.com/smtp
 * https://nodemailer.com/message
 * https://nodemailer.com/errors
 * https://nodemailer.com/guides/using-gmail
 */
import nodemailer from 'nodemailer';
import { getSecret } from './secrets.mjs';
import { isValidRef } from './config.mjs';

const MAX_RECIPIENTS = 50;
const HEADER_CONTROLS = /[\x00-\x1f\x7f]/;
const MAILBOX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const MESSAGE_ID = /^<[^\s<>@]+@[^\s<>@]+>$/;
const ERROR_MESSAGES = Object.freeze({
  EUNSUPPORTED: 'Sending is supported only for enabled Gmail accounts using an app password.',
  EACCOUNT: 'The sending account needs a valid email address and stored app-password reference.',
  EINPUT: 'The reviewed email contains invalid or unsupported fields.',
  ESENDER: 'The sender and envelope sender must match the selected account.',
  ERECIPIENTS: 'The envelope recipients must match the reviewed To recipients exactly.',
  ESECRET: 'The stored app password could not be read.',
  EAUTH: 'Gmail did not accept the account credentials.',
  ENOAUTH: 'Gmail requires authentication.',
  EDNS: 'Gmail’s mail server could not be resolved.',
  ETLS: 'A verified TLS connection to Gmail could not be established.',
  EENVELOPE: 'Gmail did not accept the sender or recipients.',
  EMAXRECIPIENTS: 'The email has too many recipients.',
  EMESSAGE: 'Gmail did not accept the message.',
  ECONFIG: 'The mail transport could not be initialized.',
  ESMTP: 'Gmail rejected the mail transaction.',
  EDELIVERYUNCERTAIN: 'Gmail may have accepted this email. Check Sent mail before considering another send.',
  EVERIFY: 'The connection or sign-in check did not complete. No email was sent.',
});

function fail(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  error.code = code;
  throw error;
}

function mailbox(value) {
  return typeof value === 'string' && value.length <= 254 && MAILBOX.test(value)
    && !value.startsWith('.') && !value.split('@')[0].endsWith('.') && !value.split('@')[0].includes('..');
}

/** This checks local configuration only: it never reads a secret or connects. */
export function mailSendCapability(account) {
  if (!account || account.enabled === false || typeof account.host !== 'string'
    || account.host.trim().toLowerCase() !== 'imap.gmail.com'
    || (account.auth === undefined ? 'password' : account.auth) !== 'password') {
    return { supported: false, reason: ERROR_MESSAGES.EUNSUPPORTED, code: 'EUNSUPPORTED' };
  }
  if (!mailbox(account.user) || !isValidRef(account.keyRef)) {
    return { supported: false, reason: ERROR_MESSAGES.EACCOUNT, code: 'EACCOUNT' };
  }
  return { supported: true, provider: 'gmail', from: account.user };
}

function validateAccount(account) {
  const capability = mailSendCapability(account);
  if (!capability.supported) fail(capability.code);
}

function addresses(value) {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.length > MAX_RECIPIENTS || !list.every(mailbox)) fail('EINPUT');
  if (new Set(list.map(address => address.toLowerCase())).size !== list.length) fail('EINPUT');
  return list.slice();
}

function header(value, max, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max || HEADER_CONTROLS.test(value)) fail('EINPUT');
  return value;
}

function messageID(value) {
  if (!MESSAGE_ID.test(header(value, 998))) fail('EINPUT');
  return value;
}

function reviewedMessage(account, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) fail('EINPUT');
  // Only these fields are supported. Never forward raw, attachments, auth,
  // custom headers, transport endpoints, or content paths from a caller.
  const allowed = new Set(['envelope', 'from', 'to', 'subject', 'text', 'messageId', 'inReplyTo', 'references']);
  if (Object.keys(message).some(key => !allowed.has(key))) fail('EINPUT');
  const { envelope } = message;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).some(key => !['from', 'to'].includes(key))) fail('EINPUT');
  if (!mailbox(message.from) || !mailbox(envelope.from)) fail('EINPUT');
  if (message.from.toLowerCase() !== account.user.toLowerCase()
    || envelope.from.toLowerCase() !== account.user.toLowerCase()) fail('ESENDER');
  const to = addresses(message.to);
  const envelopeTo = addresses(envelope.to);
  if (to.length !== envelopeTo.length || to.some((address, index) => address !== envelopeTo[index])) fail('ERECIPIENTS');
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 20_000 || message.text.includes('\0')) fail('EINPUT');
  const result = {
    envelope: { from: envelope.from, to: envelopeTo },
    from: message.from,
    to: typeof message.to === 'string' ? message.to : to,
    subject: header(message.subject, 500, { empty: true }),
    text: message.text,
    messageId: messageID(message.messageId),
    disableFileAccess: true,
    disableUrlAccess: true,
    maxRecipients: MAX_RECIPIENTS,
  };
  if (message.inReplyTo != null) result.inReplyTo = messageID(message.inReplyTo);
  if (message.references != null) {
    const refs = typeof message.references === 'string' ? message.references.split(' ') : message.references;
    if (!Array.isArray(refs) || !refs.length || refs.length > 50) fail('EINPUT');
    refs.forEach(messageID);
    result.references = typeof message.references === 'string' ? message.references : refs.slice();
  }
  return result;
}

async function makeTransport(account, { transportFactory = nodemailer.createTransport, secretReader = getSecret } = {}) {
  let password;
  try { password = await secretReader(account.keyRef); }
  catch { fail('ESECRET'); }
  if (typeof password !== 'string' || !password.trim()) fail('ESECRET');
  // No caller-supplied SMTP host, URL, service, proxy, OAuth, or TLS override.
  try {
    return await transportFactory({
      host: 'smtp.gmail.com', port: 465, secure: true,
      tls: { servername: 'smtp.gmail.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: account.user, pass: password }, forceAuth: true,
      pool: false, logger: false, debug: false, transactionLog: false,
      disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000,
    });
  } catch { fail('ECONFIG'); }
}

function safeError(error, { started = false, verify = false } = {}) {
  const smtpRejected = Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599;
  // Nodemailer uses command=CONN even for timeouts/socket loss AFTER DATA.
  // Neither CONN nor a connection error proves the message was not accepted.
  const known = new Set(['EAUTH', 'ENOAUTH', 'EDNS', 'ETLS', 'EENVELOPE', 'EMAXRECIPIENTS', 'ECONFIG']);
  const uncertain = started && !verify && !smtpRejected && !known.has(error?.code);
  let code = uncertain ? 'EDELIVERYUNCERTAIN' : error?.code;
  if (!Object.hasOwn(ERROR_MESSAGES, code)) code = verify ? 'EVERIFY' : smtpRejected ? 'ESMTP' : 'ECONFIG';
  return {
    status: uncertain ? 'uncertain' : 'failed',
    error: { code, message: ERROR_MESSAGES[code], ...(smtpRejected ? { responseCode: error.responseCode } : {}) },
  };
}

function recipients(value, requested) {
  if (!Array.isArray(value)) return [];
  const allowed = new Map(requested.map(address => [address.toLowerCase(), address]));
  return [...new Set(value.filter(mailbox).map(address => allowed.get(address.toLowerCase())).filter(Boolean))];
}

async function closeTransport(transport) {
  // Cleanup errors must never turn a known SMTP acceptance into a failed send.
  try { await transport?.close?.(); } catch { /* no credential-bearing error logs */ }
}

/**
 * Send exactly once, with no preflight verify or automatic retry.
 * Returns {status, accepted, rejected, messageId, error?}; never expose raw
 * Nodemailer errors/responses, which may echo credentials or message content.
 * An 'accepted' result may include rejected recipients; do not resend the list.
 */
export async function sendMail(account, message, deps = {}) {
  let transport, prepared, started = false;
  let id = null;
  try {
    validateAccount(account);
    prepared = reviewedMessage(account, message);
    id = prepared.messageId;
    transport = await makeTransport(account, deps);
    if (typeof transport?.sendMail !== 'function') fail('ECONFIG');
    started = true;
    const info = await transport.sendMail(prepared);
    const accepted = recipients(info?.accepted, prepared.envelope.to);
    const rejected = recipients(info?.rejected, prepared.envelope.to);
    if (accepted.length) return { status: 'accepted', accepted, rejected, messageId: id };
    const failure = rejected.length === prepared.envelope.to.length
      ? safeError({ code: 'EENVELOPE' }) : safeError({}, { started: true });
    return { ...failure, accepted, rejected, messageId: id };
  } catch (error) {
    return {
      ...safeError(error, { started }), accepted: [],
      rejected: recipients(error?.rejected, prepared?.envelope.to || []), messageId: id,
    };
  } finally { await closeTransport(transport); }
}

/** Connect and authenticate only; verify() never sends MAIL FROM or DATA. */
export async function verifyMailAccount(account, deps = {}) {
  let transport;
  try {
    validateAccount(account);
    transport = await makeTransport(account, deps);
    if (typeof transport?.verify !== 'function') fail('ECONFIG');
    if (await transport.verify() !== true) return safeError({}, { verify: true });
    return { status: 'verified' };
  } catch (error) { return safeError(error, { verify: true }); }
  finally { await closeTransport(transport); }
}
