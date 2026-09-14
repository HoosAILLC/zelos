/** Mail stays local until an authenticated user submits an immutable review. */
import crypto from 'node:crypto';
import { getMessage, getDraft, getItem, updateDraft, upsertDraft, withTransaction, insertCapture } from './db.mjs';
import { mailSendCapability, sendMail } from './mail-send.mjs';
import { classifyMail } from './mail-importance.mjs';
import { learnMailRule } from './mail-preferences.mjs';

export class MailWorkspaceError extends Error {
  constructor(status, message) { super(message); this.name = 'MailWorkspaceError'; this.status = status; }
}
const fail = (status, message) => { throw new MailWorkspaceError(status, message); };
const string = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${label} is missing or too long.`);
  return value;
};
function address(value, label = 'Email address') {
  const email = string(value, label, 254).trim();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(email) || email.startsWith('.') || email.split('@')[0].endsWith('.') || email.split('@')[0].includes('..')) fail(400, `${label} must be one email address.`);
  return email;
}
const equalEmail = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const parentIdFor = id => `reply_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const fingerprint = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const LOCKED = ['sending', 'sent', 'uncertain'];
const now = () => new Date().toISOString();

export function mailAccounts(config) {
  return (config.mail || []).map(account => {
    const capability = mailSendCapability(account);
    return { id: account.id, label: account.label || account.user, address: account.user,
      canSend: account.enabled === true && capability.supported,
      sendIssue: account.enabled !== true ? 'This account is disabled.' : capability.reason || null };
  });
}
function accountFor(config, id, { sending = false } = {}) {
  const account = (config.mail || []).find(a => a.id === id);
  if (!account) fail(404, 'This email account is no longer connected.');
  if (sending && (!account.enabled || !mailSendCapability(account).supported)) fail(409, 'Sending is not available for this account. Use an enabled Gmail account with its saved app password.');
  return account;
}
function sourceMessage(db, config, id) {
  const message = getMessage(db, string(id, 'Message', 200));
  if (!message || !(config.mail || []).some(a => a.id === message.source_id)) fail(404, 'This email is no longer in your connected accounts.');
  if (message.direction !== 'in') fail(400, 'Choose an incoming message to reply to.');
  return message;
}
function replyAddress(message) {
  const candidate = message.replyTo?.find(a => a?.email)?.email || message.from_email;
  try { return address(candidate); } catch { return ''; }
}
function replySubject(message) {
  const subject = (message.subject || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 490);
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`;
}
function deliveryRow(db, draftId, parentId = null) {
  return db.prepare(`SELECT * FROM mail_outbox WHERE (draft_id = ? OR (? IS NOT NULL AND parent_id = ?))
    AND status IN ('sending','sent','uncertain','failed') ORDER BY CASE WHEN status = 'failed' THEN 1 ELSE 0 END, created_at DESC LIMIT 1`)
    .get(draftId, parentId, parentId);
}
function viewDelivery(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  return { ok: row.status === 'sent', status: row.status, reviewId: row.id,
    sentAt: row.sent_at || null, messageId: payload.messageId, error: row.error || null,
    review: { id: row.id, from: payload.from, to: payload.to, subject: payload.subject, body: payload.body,
      accountId: payload.accountId, expiresAt: row.expires_at } };
}
function metaFor(db, draft) {
  const saved = db.prepare('SELECT * FROM mail_drafts WHERE draft_id = ?').get(draft.id);
  if (saved) return saved;
  const item = draft.item_id ? getItem(db, draft.item_id) : null;
  if (item?.payload?.accuracyReviewRequired) return { account_id: '', parent_id: null };
  const sources = (item?.sourceRefs || []).filter(ref => ref.startsWith('msg:')).map(ref => getMessage(db, ref.slice(4))).filter(Boolean);
  // Prefer the source addressed by this draft; never borrow an account solely
  // because it is first in Settings.
  const binding = item?.payload?.draftBinding;
  const candidates = sources.filter(m => m.direction === 'in' && equalEmail(replyAddress(m), draft.to_email)
    && (!binding || binding.version === 1 && binding.messageId === m.id && binding.sourceId === m.source_id && equalEmail(binding.to, draft.to_email)));
  // Same-person threads are not interchangeable. Only an explicit binding or a
  // single unambiguous source may supply the reply's original message.
  const parent = candidates.length === 1 ? candidates[0] : null;
  return { account_id: parent?.source_id || '', parent_id: parent?.id || null };
}
function decorateDraft(db, draft) {
  if (!draft) return null;
  const meta = metaFor(db, draft);
  return { ...draft, account_id: meta.account_id, message_id: meta.parent_id, delivery: viewDelivery(deliveryRow(db, draft.id, meta.parent_id)) };
}
export function getMailDraft(db, config, id) {
  const draft = getDraft(db, string(id, 'Draft', 200));
  if (!draft) fail(404, 'This draft is no longer available.');
  if (draft.state === 'discarded') fail(409, 'This draft was removed. Open the original email to write a new reply.');
  assertGeneratedDraftSource(db, draft);
  const decorated = decorateDraft(db, draft);
  const message = decorated.message_id ? getMessage(db, decorated.message_id) : null;
  return { draft: decorated, message, accountId: decorated.account_id,
    replyTo: message ? replyAddress(message) : draft.to_email, accounts: mailAccounts(config),
    ...(message ? { importance: importanceFor(message, importanceContext(db, [message.source_id])) } : {}) };
}

const decodedList = value => { try { const data = JSON.parse(value || '[]'); return Array.isArray(data) ? data : []; } catch { return []; } };
const addressKey = (source, email) => `${source}\n${String(email || '').trim().toLowerCase()}`;
const messageKey = (source, id) => `${source}\n${String(id || '').trim().replace(/^<|>$/g, '').toLowerCase()}`;
export function importanceContext(db, ids) {
  const correspondents = new Set(), threads = new Set(), outboundIds = new Set();
  if (ids.length) {
    for (const row of db.prepare(`SELECT source_id,thread_key,message_id,to_json,cc_json FROM messages
      WHERE direction='out' AND source_id IN (${ids.map(() => '?').join(',')})`).iterate(...ids)) {
      if (row.thread_key) threads.add(addressKey(row.source_id, row.thread_key));
      if (row.message_id) outboundIds.add(messageKey(row.source_id, row.message_id));
      for (const recipient of [...decodedList(row.to_json), ...decodedList(row.cc_json)]) {
        const email = typeof recipient === 'string' ? recipient : recipient?.email || recipient?.address;
        if (email) correspondents.add(addressKey(row.source_id, email));
      }
    }
  }
  const overrides = new Map(db.prepare('SELECT message_id,important FROM mail_importance').all().map(row => [row.message_id, !!row.important]));
  const edited = new Set(db.prepare(`SELECT mail_drafts.parent_id FROM mail_drafts JOIN drafts ON drafts.id=mail_drafts.draft_id
    WHERE drafts.state='edited' AND mail_drafts.parent_id IS NOT NULL`).all().map(row => row.parent_id));
  const deliveries = new Map();
  for (const row of db.prepare("SELECT parent_id,status FROM mail_outbox WHERE parent_id IS NOT NULL AND status IN ('sending','sent','uncertain','failed') ORDER BY created_at").iterate()) deliveries.set(row.parent_id, row.status);
  const rules = new Map(db.prepare('SELECT * FROM mail_rules').all().map(row => [`${addressKey(row.account_id,row.sender)}\n${row.category}`,row]));
  const prepared = new Map(db.prepare("SELECT a.message_id,d.id FROM mail_autodrafts a JOIN drafts d ON d.id=a.draft_id WHERE a.status='ready' AND d.state IN ('pending','edited')").all().map(row=>[row.message_id,row.id]));
  return { correspondents, threads, outboundIds, overrides, edited, deliveries, rules, prepared };
}
export function importanceFor(message, context, { ignoreChoice = false } = {}) {
  if (!ignoreChoice && context.overrides.has(message.id)) {
    const important = context.overrides.get(message.id);
    return { important, reason: important ? 'You kept this email in Important.' : 'You moved this email out of Important.', category: 'personal-choice', overridden: true };
  }
  if (!ignoreChoice && (context.edited.has(message.id) || context.deliveries.has(message.id))) {
    return { important: true, reason: 'You have a saved reply or delivery to review.', category: 'reply', overridden: false };
  }
  const knownCorrespondent = context.correspondents.has(addressKey(message.source_id, message.from_email));
  const refs = [...(Array.isArray(message.references) ? message.references : decodedList(message.references_json)), message.in_reply_to].filter(Boolean);
  const hasOutboundThread = refs.some(ref => context.outboundIds.has(messageKey(message.source_id, ref)))
    || (knownCorrespondent && message.thread_key && context.threads.has(addressKey(message.source_id, message.thread_key)));
  const classification = classifyMail(message, { knownCorrespondent, hasOutboundThread: !!hasOutboundThread });
  const key = addressKey(message.source_id, message.from_email);
  const rule = !ignoreChoice && (context.rules.get(`${key}\n*`) || context.rules.get(`${key}\n${classification.category}`));
  if (rule) return { important: !!rule.important, category: classification.category, overridden: false, learned: true,
    ruleId: rule.id, reason: `${rule.important ? 'Kept' : 'Filtered'} by your ${rule.category === '*' ? 'sender' : 'similar-email'} rule.` };
  return { ...classification, overridden: false };
}
export function setMailImportance(db, config, input) {
  if (typeof input?.important !== 'boolean') fail(400, 'Choose whether this email belongs in Important.');
  const message = sourceMessage(db, config, input.messageId);
  const scope = input.scope || 'message';
  if (!['message','similar','sender'].includes(scope)) fail(400,'Choose this email, similar emails, or this sender.');
  const original = importanceFor(message, importanceContext(db,[message.source_id]), { ignoreChoice: true });
  let learned;
  withTransaction(db, () => {
  db.prepare(`INSERT INTO mail_importance(message_id,important,updated_at) VALUES(?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET important=excluded.important,updated_at=excluded.updated_at`)
    .run(message.id, Number(input.important), now());
    learned = learnMailRule(db, message, { important: input.important, category: original.category, scope });
  });
  return { importance: importanceFor(message, importanceContext(db, [message.source_id])), learned };
}
export function listMail(db, config, { accountId = '', q = '', cursor = '0', limit = 40, scope = 'important' } = {}) {
  const accounts = mailAccounts(config);
  const ids = accounts.filter(a => !accountId || a.id === accountId).map(a => a.id);
  if (accountId && !ids.length) fail(404, 'Unknown email account.');
  string(q, 'Search', 200, false);
  if (!['important', 'filtered', 'all'].includes(scope)) fail(400, 'Choose Important, Filtered out, or All mail.');
  if (!/^\d{1,6}$/.test(String(cursor))) fail(400, 'Invalid mail page.');
  const offset = Number(cursor); limit = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 40));
  const counts = { important: 0, filtered: 0, all: 0 };
  if (!ids.length) return { accounts, messages: [], nextCursor: null, scope, counts };
  const terms = [`source_id IN (${ids.map(() => '?').join(',')})`, "direction = 'in'"];
  const args = [...ids];
  if (q.trim()) {
    terms.push("(subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_email LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    const pattern = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`; args.push(pattern, pattern, pattern, pattern);
  }
  const context = importanceContext(db, ids), messages = [];
  let matching = 0;
  // Classify before paging. Scan bounded text and retain only the requested
  // page, so a page full of ads cannot hide useful messages farther down.
  for (const row of db.prepare(`SELECT id,source_id,from_name,from_email,subject,sent_at,snippet,has_attach,
    substr(body,1,16000) AS body,substr(body,-4000) AS footer,flags_json,folder,thread_key,references_json,in_reply_to
    FROM messages WHERE ${terms.join(' AND ')} ORDER BY datetime(sent_at) DESC,id DESC`).iterate(...args)) {
    const importance = importanceFor(row, context);
    counts.all++; counts[importance.important ? 'important' : 'filtered']++;
    if (scope !== 'all' && (scope === 'important') !== importance.important) continue;
    if (matching++ < offset || messages.length >= limit) continue;
    const { body, footer, flags_json, folder, thread_key, references_json, in_reply_to, ...message } = row;
    const delivery = context.deliveries.get(message.id);
    messages.push({ ...message, importance, preparedDraftId: context.prepared.get(message.id) || null, deliveryStatus: delivery === 'failed' ? null : delivery || null });
  }
  return { accounts, messages, nextCursor: matching > offset + limit ? String(offset + limit) : null, scope, counts };
}
export function getMailMessage(db, config, id) {
  const message = sourceMessage(db, config, id);
  const linked = db.prepare('SELECT draft_id FROM mail_drafts WHERE parent_id = ? ORDER BY updated_at DESC LIMIT 1').get(message.id);
  let draft = linked ? getDraft(db, linked.draft_id) : getDraft(db, parentIdFor(message.id));
  if (draft?.state === 'discarded') draft = null;
  if (draft?.state === 'pending') {
    try { assertGeneratedDraftSource(db, draft); } catch { draft = null; }
  }
  return { message, replyTo: replyAddress(message), accountId: message.source_id,
    automaticDraft: db.prepare('SELECT status,reason,request_quote,updated_at FROM mail_autodrafts WHERE message_id=?').get(message.id) || null,
    draft: decorateDraft(db, draft), accounts: mailAccounts(config), importance: importanceFor(message, importanceContext(db, [message.source_id])) };
}
export function assertDraftEditable(db, id) {
  const draft = getDraft(db, id);
  if (!draft) fail(404, 'This draft is no longer available.');
  assertGeneratedDraftSource(db, draft);
  const meta = metaFor(db, draft);
  const delivery = deliveryRow(db, id, meta.parent_id);
  if (delivery && LOCKED.includes(delivery.status)) fail(409, delivery.status === 'sent'
    ? 'This reply has already been sent.' : 'This reply may already be on its way. Check its delivery status before making another reply.');
  if (draft.state === 'used' || draft.state === 'discarded') fail(409, 'This draft has already been used or discarded.');
  return draft;
}
function assertGeneratedDraftSource(db, draft) {
  if (draft.state !== 'pending' || !draft.item_id) return;
  const item = getItem(db, draft.item_id);
  if (!item || item.payload?.accuracyReviewRequired || ['done','dismissed'].includes(item.state)) {
    fail(409, 'This automatic draft is no longer supported. Open the original email to draft a new reply.');
  }
  const meta = metaFor(db, draft), message = meta.parent_id && getMessage(db, meta.parent_id);
  if (!message || message.direction !== 'in' || !equalEmail(replyAddress(message), draft.to_email)) {
    fail(409, 'This automatic draft has no verified recipient. Open the original email to draft a new reply.');
  }
}
function checkedReply(db, config, data, { allowEmpty = false } = {}) {
  const message = data.messageId ? sourceMessage(db, config, data.messageId) : null;
  const accountId = data.accountId || message?.source_id;
  const account = accountFor(config, accountId);
  const to = allowEmpty ? string(data.to, 'To', 254, false).trim() : address(data.to, 'To');
  if (/[\x00-\x1f\x7f]/.test(to)) fail(400, 'To must be a single line.');
  const subject = string(data.subject, 'Subject', 500, !allowEmpty);
  if (/[\x00-\x1f\x7f]/.test(subject)) fail(400, 'Subject must be a single line.');
  const body = string(data.body, 'Reply', 20_000, !allowEmpty);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) fail(400, 'Reply contains unsupported control characters.');
  return { message, account, accountId, to, subject, body };
}
export function saveReply(db, config, data) {
  const checked = checkedReply(db, config, data, { allowEmpty: true });
  let id = data.draftId;
  if (id) { string(id, 'Draft', 200); assertDraftEditable(db, id); }
  else {
    if (!checked.message) fail(400, 'Choose an email before writing a reply.');
    id = parentIdFor(checked.message.id);
    if (getDraft(db, id)) assertDraftEditable(db, id);
  }
  const previous = getDraft(db, id);
  const previousMeta = previous ? metaFor(db, previous) : null;
  if (previousMeta?.parent_id && checked.message && previousMeta.parent_id !== checked.message.id) fail(409, 'This draft belongs to a different email.');
  const parentId = checked.message?.id || previousMeta?.parent_id || null;
  const timestamp = now();
  withTransaction(db, () => {
    if (!previous) upsertDraft(db, { id, itemId: '', to: checked.to, subject: checked.subject, body: checked.body, state: 'edited' }, { now: timestamp });
    else updateDraft(db, id, { to: checked.to, subject: checked.subject, body: checked.body, state: 'edited' }, { now: timestamp });
    db.prepare(`INSERT INTO mail_drafts(draft_id,account_id,parent_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET account_id=excluded.account_id,parent_id=excluded.parent_id,updated_at=excluded.updated_at`)
      .run(id, checked.accountId, parentId, timestamp);
    db.prepare("UPDATE mail_outbox SET status='cancelled' WHERE draft_id = ? AND status = 'review'").run(id);
  });
  return decorateDraft(db, getDraft(db, id));
}
export function draftDefaults(db, config, messageId) {
  const message = sourceMessage(db, config, messageId);
  return { messageId: message.id, accountId: message.source_id, to: replyAddress(message), subject: replySubject(message) };
}
export function draftRevision(db, messageId) {
  const row = db.prepare(`SELECT drafts.*,mail_drafts.account_id,mail_drafts.parent_id FROM drafts LEFT JOIN mail_drafts ON mail_drafts.draft_id = drafts.id
    WHERE mail_drafts.parent_id = ? OR drafts.id = ? ORDER BY drafts.updated_at DESC LIMIT 1`).get(messageId, parentIdFor(messageId));
  return row ? fingerprint([row.id, row.body, row.subject, row.to_email, row.state, row.updated_at, row.account_id, row.parent_id]) : null;
}
/** A background suggestion never replaces even an empty or discarded user draft. */
export function saveAutomaticReply(db, config, messageId, body) {
  if (draftRevision(db,messageId)) fail(409,'A reply already exists for this email.');
  const draft = saveReply(db,config,{...draftDefaults(db,config,messageId),body});
  updateDraft(db,draft.id,{state:'pending'});
  return getDraft(db,draft.id);
}
function safeMessageId(raw) {
  const value = String(raw || '').trim().replace(/^<|>$/g, '');
  return value.length <= 996 && /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+$/.test(value) ? `<${value}>` : null;
}
function payloadFor(db, config, draft) {
  const meta = metaFor(db, draft);
  const account = accountFor(config, meta.account_id, { sending: true });
  const checked = checkedReply(db, config, { accountId: account.id, to: draft.to_email, subject: draft.subject, body: draft.body });
  const parent = meta.parent_id ? sourceMessage(db, config, meta.parent_id) : null;
  const parentMessageId = safeMessageId(parent?.message_id);
  const references = [...new Set([...(parent?.references || []).map(safeMessageId), parentMessageId].filter(Boolean))].slice(-20);
  return { accountId: account.id, from: address(account.user, 'From'), to: checked.to,
    subject: checked.subject, body: checked.body, parentId: parent?.id || null,
    inReplyTo: parentMessageId || undefined, references };
}
function draftFingerprint(payload) {
  const { messageId, ...stable } = payload; return fingerprint(stable);
}

export function createMailWorkspace({ db, config, sender = sendMail, clock = () => Date.now() }) {
  // A stopped process cannot prove whether an SMTP acknowledgement was received.
  // Retain the reviewed message and require checking Sent instead of resending.
  db.prepare("UPDATE mail_outbox SET status='uncertain', error=? WHERE status='sending'")
    .run('Zelos restarted before delivery was confirmed. Check this account’s Sent folder; this reply will not be sent again automatically.');
  const inFlight = new Set();
  return {
    prepare(data) {
      const draft = saveReply(db, config(), { ...data, draftId: data.draftId });
      const payload = payloadFor(db, config(), draft);
      const id = crypto.randomUUID();
      payload.messageId = `<zelos.${id}@${payload.from.split('@')[1]}>`;
      const createdAt = new Date(clock()).toISOString(), expiresAt = new Date(clock() + 10 * 60_000).toISOString();
      db.prepare(`INSERT INTO mail_outbox(id,draft_id,parent_id,fingerprint,payload_json,status,created_at,expires_at) VALUES(?,?,?,?,?,'review',?,?)`)
        .run(id, draft.id, payload.parentId, draftFingerprint(payload), JSON.stringify(payload), createdAt, expiresAt);
      return { review: viewDelivery(db.prepare('SELECT * FROM mail_outbox WHERE id=?').get(id)).review };
    },
    delivery(id) {
      const row = db.prepare('SELECT * FROM mail_outbox WHERE id=?').get(string(id, 'Review', 100));
      if (!row) fail(404, 'This send review is no longer available.');
      return viewDelivery(row);
    },
    async send(id) {
      const row = db.prepare('SELECT * FROM mail_outbox WHERE id=?').get(string(id, 'Review', 100));
      if (!row) fail(404, 'Review the reply before sending it.');
      if (['sent', 'sending', 'uncertain', 'failed'].includes(row.status)) return viewDelivery(row);
      if (row.status !== 'review' || Date.parse(row.expires_at) <= clock()) fail(409, 'This review expired or the reply changed. Review it again before sending.');
      const payload = JSON.parse(row.payload_json);
      const draft = assertDraftEditable(db, row.draft_id);
      if (draftFingerprint(payloadFor(db, config(), draft)) !== row.fingerprint) fail(409, 'This reply changed after review. Review the current text before sending.');
      const account = accountFor(config(), payload.accountId, { sending: true });
      try {
        const claim = db.prepare("UPDATE mail_outbox SET status='sending' WHERE id=? AND status='review'").run(id);
        if (claim.changes !== 1) fail(409, 'This review changed. Check delivery before trying again.');
      }
      catch { fail(409, 'A reply to this email is already being sent or has been sent.'); }
      inFlight.add(id);
      let outcome;
      try {
        outcome = await sender(account, { envelope: { from: payload.from, to: [payload.to] }, from: payload.from, to: payload.to,
          subject: payload.subject, text: payload.body, messageId: payload.messageId,
          ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}), ...(payload.references.length ? { references: payload.references } : {}) });
      } catch {
        outcome = { status: 'uncertain', error: { message: 'Delivery could not be confirmed. Check this account’s Sent folder before trying another reply.' } };
      }
      const status = outcome.status === 'accepted' ? 'sent' : outcome.status === 'failed' ? 'failed' : 'uncertain';
      const timestamp = new Date(clock()).toISOString();
      const error = status === 'sent' ? null : String(outcome.error?.message || 'Delivery could not be confirmed. Check Sent before retrying.').slice(0, 600);
      try {
        withTransaction(db, () => {
          db.prepare('UPDATE mail_outbox SET status=?,sent_at=?,error=? WHERE id=?').run(status, status === 'sent' ? timestamp : null, error, id);
          if (status === 'sent') {
            updateDraft(db, row.draft_id, { state: 'used' }, { now: timestamp });
            insertCapture(db, `Email sent by the user from ${payload.from} to ${payload.to} at ${timestamp}. Subject: ${payload.subject}\n${payload.body}`, { now: timestamp });
          }
        });
      } catch {
        const error = 'Delivery may have completed, but Zelos could not save its confirmation. Check Sent before trying another reply.';
        try { db.prepare("UPDATE mail_outbox SET status='uncertain',error=? WHERE id=?").run(error, id); } catch { /* The durable sending row still prevents another send. */ }
        return { ...viewDelivery(row), ok: false, status: 'uncertain', error };
      } finally { inFlight.delete(id); }
      return this.delivery(id);
    },
    get sendingCount() { return inFlight.size; },
  };
}
