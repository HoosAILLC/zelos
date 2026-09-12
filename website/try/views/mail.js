/** Stored email, local reply drafting, and an explicit review before delivery. */
import { el, button, focusQuietly } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { mailPreferencesPanel } from '../lib/mail-preferences.js';
import { state } from '../lib/store.js';
import { formatDay, formatTime, toZonedISO } from '../lib/time.js';

let root, list, listStatus, pane, accountFilter, scopeFilter, searchField, moreButton, refreshButton;
let accounts = [], messages = [], nextCursor = null, accountId = '', query = '';
let scope = 'important', counts = null;
let listRequest = null, messageRequest = null, searchTimer = null, lastRev = null;
let selectedId = null, selectedDraftId = null, lastVisit = null, navigateTo = () => {};
let timezone;
const editors = new Map();
const importanceControls = new Map();

const address = value => typeof value === 'string' ? value : value?.email || value?.address || '';
const addresses = values => (Array.isArray(values) ? values : [values]).map(address).filter(Boolean).join(', ');
const zonedDate = value => value ? toZonedISO(value, timezone) : null;
const dateLabel = value => {
  const date = zonedDate(value);
  return [formatDay(date), formatTime(date)].filter(Boolean).join(' · ');
};
const accountFor = id => accounts.find(account => account.id === id);
const deliveryLocked = editor => ['sending', 'sent', 'uncertain'].includes(editor.delivery?.status);
const busy = editor => editor.generating || editor.preparing || editor.sending || editor.checking;
const refreshable = editor => editor && editor.savedVersion === editor.version && !editor.savePromise
  && !busy(editor) && !editor.review && !deliveryLocked(editor);

function field(label, control) {
  return el('label', { class: 'mail-field' }, [el('span', { text: label }), control]);
}

function status(editor, message, tone = '') {
  editor.status.textContent = message;
  editor.status.setAttribute('class', `mail-reply-status${tone ? ` is-${tone}` : ''}`);
}

function controls(editor) {
  const locked = deliveryLocked(editor) || busy(editor);
  for (const input of Object.values(editor.inputs)) input.disabled = locked;
  editor.generate.disabled = locked || !state.health?.model?.configured;
  editor.stop.hidden = !editor.generating;
  editor.reviewButton.disabled = locked || !accountFor(editor.accountId)?.canSend;
  editor.fields.hidden = Boolean(editor.review) || deliveryLocked(editor);
  editor.actions.hidden = editor.fields.hidden;
  editor.sendIssue.textContent = accountFor(editor.accountId)?.canSend
    ? '' : accountFor(editor.accountId)?.sendIssue || 'Set up sending for this account in Settings → Email.';
}

function accountOptions(select, chosen, includeAll = false) {
  select.replaceChildren(...[
    ...(includeAll ? [el('option', { value: '', text: 'All accounts' })] : []),
    ...accounts.map(account => el('option', { value: account.id, text: account.address
      ? `${account.label || account.address} <${account.address}>` : account.label || account.id })),
  ]);
  select.value = chosen;
}

function setAccounts(next) {
  accounts = Array.isArray(next) ? next : [];
  accountOptions(accountFilter, accountId, true);
  for (const editor of editors.values()) {
    accountOptions(editor.inputs.accountId, editor.accountId);
    controls(editor);
  }
}

function renderList() {
  list.replaceChildren(...messages.map(message => button([
    el('span', { class: 'mail-row-top' }, [
      el('span', { class: 'mail-sender', text: message.from_name || message.from_email || 'Unknown sender' }),
      el('span', { class: 'mail-date', text: formatDay(zonedDate(message.sent_at)) || '' }),
    ]),
    el('span', { class: 'mail-row-subject', text: message.subject || '(No subject)' }),
    message.preparedDraftId ? el('span',{class:'mail-draft-badge',text:'Draft ready'}) : null,
    el('span', { class: 'mail-snippet', text: message.snippet || '' }),
  ], {
    class: 'mail-row', 'aria-current': message.id === selectedId ? 'true' : null,
    onClick: () => selectMessage(message.id),
  })));
  if (!messages.length) {
    const empty = scope === 'important' ? (query ? 'No important emails match this search.' : 'No important emails here right now.')
      : scope === 'filtered' ? (query ? 'No filtered emails match this search.' : 'No emails have been filtered out.')
        : query ? 'No saved emails match this search.' : 'No emails here yet. Check your connected accounts to read new mail.';
    list.appendChild(el('div', { class: 'mail-empty' }, [el('p', { text: empty }),
      el('div', { class: 'mail-empty-actions' }, [
        scope !== 'important' && button('View Important', { class: 'btn quiet', onClick: () => changeScope('important') }),
        scope === 'important' && button('View filtered out', { class: 'btn quiet', onClick: () => changeScope('filtered') }),
        scope !== 'all' && button('View all mail', { class: 'btn quiet', onClick: () => changeScope('all') }),
      ]),
    ]));
  }
  moreButton.hidden = !nextCursor;
}

function listSummary() {
  const total = counts?.[scope] ?? messages.length;
  const noun = scope === 'important' ? 'important email' : scope === 'filtered' ? 'filtered email' : 'email';
  return `${total} ${noun}${total === 1 ? '' : 's'}${nextCursor ? ` · ${messages.length} shown` : ''}`
    + (scope === 'important' && counts ? ` · ${counts.filtered} filtered out` : '');
}

function changeScope(next) {
  if (!['important', 'filtered', 'all'].includes(next) || scope === next) return;
  clearTimeout(searchTimer);
  query = searchField.value.trim();
  scope = next; scopeFilter.value = next; nextCursor = null;
  messages = []; counts = null; list.replaceChildren(); moreButton.hidden = true;
  loadMessages();
}

async function loadMessages({ more = false } = {}) {
  listRequest?.abort();
  const mine = new AbortController();
  listRequest = mine;
  listStatus.textContent = more ? 'Loading more emails…' : 'Loading emails…';
  refreshButton.disabled = true;
  moreButton.disabled = true;
  if (!more) { nextCursor = null; moreButton.hidden = true; }
  try {
    const result = await api.mailMessages({ scope, accountId, q: query, cursor: more ? nextCursor : null, limit: 50, signal: mine.signal });
    if (listRequest !== mine) return;
    setAccounts(result.accounts);
    const incoming = Array.isArray(result.messages) ? result.messages : [];
    messages = more ? [...new Map([...messages, ...incoming].map(message => [message.id, message])).values()] : incoming;
    nextCursor = result.nextCursor || null;
    counts = result.counts && ['important', 'filtered', 'all'].every(key => Number.isInteger(result.counts[key]) && result.counts[key] >= 0)
      ? result.counts : null;
    renderList();
    listStatus.textContent = listSummary();
  } catch (error) {
    if (error?.name !== 'AbortError' && listRequest === mine) listStatus.textContent = error.message;
  } finally {
    if (listRequest === mine) {
      listRequest = null;
      refreshButton.disabled = false;
      moreButton.disabled = false;
    }
  }
}

function paintImportance(control) {
  const known = typeof control.value?.important === 'boolean';
  control.node.hidden = !known;
  control.button.disabled = control.pending || !known;
  if(control.scope)control.scope.disabled=control.pending;
  control.button.replaceChildren(document.createTextNode(control.value?.important ? 'Move out of Important' : 'Keep in Important'));
  control.reason.textContent = control.value?.reason || '';
  control.note.textContent = control.notice || '';
  control.note.setAttribute('class', `mail-importance-status${control.error ? ' is-bad' : ''}`);
}

function importanceControl(message, detail, version) {
  let control = importanceControls.get(message.id);
  if (!control) {
    control = { id: message.id, value: null, pending: false, version: 0, notice: '', error: false };
    control.button = button('Keep in Important', { class: 'btn quiet', onClick: () => changeImportance(control) });
    control.reason = el('p', { class: 'mail-importance-reason' });
    control.note = el('p', { class: 'mail-importance-status', role: 'status' });
    control.scope=el('select',{class:'input','aria-label':'Apply email preference to'},[
      el('option',{value:'similar',text:'Similar emails from this sender'}),el('option',{value:'message',text:'Only this email'}),el('option',{value:'sender',text:'All emails from this sender'})]);
    control.scope.value='similar';
    control.node = el('div', { class: 'mail-importance' }, [control.button,control.scope, control.reason, control.note]);
    importanceControls.set(message.id, control);
  }
  const incoming = detail.importance || message.importance || messages.find(row => row.id === message.id)?.importance;
  if (!control.pending && version === control.version && typeof incoming?.important === 'boolean') control.value = incoming;
  paintImportance(control);
  return control.node;
}

async function changeImportance(control) {
  if (control.pending || typeof control.value?.important !== 'boolean') return;
  const important = !control.value.important;
  control.pending = true; control.version += 1; control.notice = 'Saving your email preference…'; control.error = false;
  paintImportance(control);
  try {
    const result = await api.setMailImportance({ messageId: control.id, important, scope: control.scope.value });
    if (typeof result?.importance?.important !== 'boolean') throw new Error('The email preference could not be confirmed. Try again.');
    control.value = result.importance;
    control.notice = (control.value.important ? 'Kept in Important.' : 'Moved to Filtered out.') + (result.learned ? ' Zelos will use this preference for future matching emails.' : '');
    messages = messages.map(message => message.id === control.id ? { ...message, importance: control.value } : message)
      .filter(message => message.id !== control.id || scope === 'all' || (scope === 'important') === control.value.important);
    renderList();
    // Only reload the list. Refreshing the selected message would reset a
    // clean editor or disturb a review while this independent preference saves.
    loadMessages();
  } catch (error) {
    control.notice = error.message; control.error = true;
  } finally {
    control.pending = false; control.version += 1; paintImportance(control);
  }
}

function applyDraft(editor, draft) {
  if (!draft) return;
  editor.draftId = draft.id || editor.draftId;
  editor.accountId = draft.account_id || editor.accountId;
  editor.to = draft.to_email ?? draft.to ?? editor.to;
  editor.subject = draft.subject ?? editor.subject;
  editor.body = draft.body ?? editor.body;
  for (const key of ['accountId', 'to', 'subject', 'body']) editor.inputs[key].value = editor[key];
  editor.version += 1;
  editor.savedVersion = editor.version;
  if (draft.delivery) restoreDelivery(editor, draft.delivery);
}

/** Serialize saves; typing during one write must land in a subsequent write. */
async function saveEditor(editor) {
  clearTimeout(editor.timer);
  if (editor.savePromise) {
    await editor.savePromise;
    return saveEditor(editor);
  }
  if (deliveryLocked(editor) || editor.savedVersion === editor.version) return;
  const version = editor.version;
  const payload = { messageId: editor.messageId, accountId: editor.accountId, draftId: editor.draftId || undefined,
    to: editor.to, subject: editor.subject, body: editor.body };
  status(editor, 'Saving draft…');
  editor.savePromise = api.saveMailReply(payload);
  try {
    const result = await editor.savePromise;
    editor.draftId = result.draft.id;
    editor.savedVersion = version;
    status(editor, 'Draft saved.');
  } catch (error) {
    status(editor, `${error.message} Your text is still here.`, 'bad');
    throw error;
  } finally {
    editor.savePromise = null;
  }
  if (editor.savedVersion !== editor.version) return saveEditor(editor);
}

/** The shell can await this before leaving Mail or closing a desktop window. */
export async function flushMailDrafts() {
  for (const editor of editors.values()) await saveEditor(editor);
}

// Browser clients cannot await the desktop's flush callback. Warn only when
// unsaved text or its write is at risk, and save when a phone backgrounds us.
window.addEventListener('beforeunload', event => {
  const unsaved = [...editors.values()].some(editor => editor.savePromise
    || (!deliveryLocked(editor) && editor.savedVersion !== editor.version));
  if (!unsaved) return;
  event.preventDefault();
  event.returnValue = '';
  flushMailDrafts().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushMailDrafts().catch(() => {});
});

function changed(editor, key) {
  if (deliveryLocked(editor) || busy(editor)) return;
  editor[key] = editor.inputs[key].value;
  if (key === 'instructions') return;
  editor.version += 1;
  status(editor, 'Unsaved changes');
  controls(editor);
  clearTimeout(editor.timer);
  editor.timer = setTimeout(() => { saveEditor(editor).catch(() => {}); }, 900);
}

async function generate(editor) {
  if (busy(editor) || deliveryLocked(editor)) return;
  editor.generating = true;
  editor.generation = new AbortController();
  controls(editor);
  try {
    await saveEditor(editor);
    status(editor, 'Nemotron is drafting a reply on Spark…');
    const result = await api.draftMailReply({ messageId: editor.messageId, accountId: editor.accountId,
      instructions: editor.instructions }, { signal: editor.generation.signal });
    applyDraft(editor, result.draft);
    status(editor, 'Draft ready. Edit it, then review your reply.');
  } catch (error) {
    status(editor, error?.name === 'AbortError' ? 'Drafting stopped. Your text is still here.' : error.message,
      error?.name === 'AbortError' ? '' : 'bad');
  } finally {
    editor.generating = false;
    editor.generation = null;
    controls(editor);
  }
}

function envelope(entries) {
  return el('dl', { class: 'mail-envelope' }, entries.flatMap(([label, value]) => [
    el('dt', { text: label }), el('dd', { text: value || '—' }),
  ]));
}

function restoreDelivery(editor, delivery) {
  editor.delivery = delivery;
  editor.reviewId = delivery.reviewId || delivery.review?.id || editor.reviewId;
  if (delivery.review) editor.review = Object.freeze({ ...delivery.review });
}

function deliveryStatus(editor, result) {
  restoreDelivery(editor, result);
  if (result.status === 'sent') status(editor, `Reply sent${result.sentAt ? ` · ${dateLabel(result.sentAt)}` : ''}.`, 'good');
  else if (result.status === 'failed') status(editor, result.error || 'The reply was not sent. You can edit it and try again.', 'bad');
  else if (result.status === 'sending') status(editor, 'Sending is still in progress. Check its status in a moment.');
  else if (result.status === 'review' || result.status === 'cancelled') {
    if (result.status === 'cancelled' || Date.parse(editor.review?.expiresAt) <= Date.now()) {
      editor.delivery = { ...editor.delivery, status: 'failed' };
      status(editor, 'This review expired or changed. Go back to editing and review the reply again.', 'bad');
    } else {
      status(editor, 'This review has not been sent. You can send the reviewed reply or return to editing.');
    }
  }
  else {
    editor.delivery = { ...editor.delivery, status: 'uncertain' };
    status(editor, result.error || 'Delivery is not confirmed. Check its status before trying anything else.', 'bad');
  }
  renderReview(editor);
}

async function prepare(editor) {
  if (busy(editor) || deliveryLocked(editor)) return;
  if (!editor.to.trim() || !editor.subject.trim() || !editor.body.trim()) {
    status(editor, 'Add a recipient, subject and reply before reviewing.', 'bad');
    return;
  }
  editor.preparing = true;
  controls(editor);
  try {
    await saveEditor(editor);
    status(editor, 'Preparing your review…');
    const result = await api.prepareMailReply({ draftId: editor.draftId, accountId: editor.accountId,
      to: editor.to, subject: editor.subject, body: editor.body });
    editor.review = Object.freeze({ ...result.review });
    editor.reviewId = result.review.id;
    editor.delivery = null;
    status(editor, 'Review the exact reply below. It has not been sent.');
  } catch (error) {
    status(editor, error.message, 'bad');
  } finally {
    editor.preparing = false;
    renderReview(editor);
    if (editor.review) focusQuietly(editor.reviewSlot.querySelector('h3'));
  }
}

async function send(editor) {
  if (!editor.reviewId || busy(editor) || deliveryLocked(editor)) return;
  editor.sending = true;
  editor.delivery = { status: 'sending', reviewId: editor.reviewId };
  status(editor, 'Sending reply…');
  renderReview(editor);
  try {
    const result = await api.sendMailReply({ reviewId: editor.reviewId });
    deliveryStatus(editor, result);
  } catch (error) {
    // The server may have accepted delivery before the response was lost.
    // Keep this review ID, lock editing, and ask only for its delivery status.
    deliveryStatus(editor, { status: 'uncertain', reviewId: editor.reviewId,
      error: `${error.message} Delivery is not confirmed; check its status.` });
  } finally {
    editor.sending = false;
    renderReview(editor);
  }
}

async function checkDelivery(editor) {
  if (!editor.reviewId || busy(editor)) return;
  editor.checking = true;
  status(editor, 'Checking delivery status…');
  renderReview(editor);
  try {
    deliveryStatus(editor, await api.mailDelivery(editor.reviewId));
  } catch (error) {
    status(editor, `${error.message} Keep this reply as it is until delivery is confirmed.`, 'bad');
  } finally {
    editor.checking = false;
    renderReview(editor);
  }
}

function renderReview(editor) {
  const review = editor.review;
  const locked = deliveryLocked(editor);
  const pending = ['sending', 'uncertain'].includes(editor.delivery?.status);
  const failed = editor.delivery?.status === 'failed';
  editor.reviewSlot.replaceChildren();
  editor.reviewSlot.hidden = !review && !locked;
  if (review || locked) {
    editor.reviewSlot.appendChild(el('div', { class: 'mail-review' }, [
      el('h3', { text: editor.delivery?.status === 'sent' ? 'Sent reply' : 'Review reply', tabindex: '-1' }),
      review ? envelope([['From', review.from], ['To', review.to], ['Subject', review.subject]]) : null,
      review ? el('p', { class: 'mail-review-body', text: review.body })
        : el('p', { class: 'mail-review-intro', text: 'This draft has a delivery in progress. Check its status to recover the saved review.' }),
      el('div', { class: 'mail-review-actions' }, [
        !locked ? button('Back to editing', { class: 'btn quiet', disabled: busy(editor), onClick: () => {
          editor.review = null;
          editor.reviewId = null;
          editor.delivery = null;
          renderReview(editor);
          status(editor, 'Draft saved.');
          focusQuietly(editor.inputs.body);
        } }) : null,
        review && !locked && !failed ? button('Send reply', { class: 'btn solid', disabled: busy(editor), onClick: () => send(editor) }) : null,
        pending ? button('Check delivery status', { class: 'btn quiet', disabled: busy(editor) || !editor.reviewId,
          onClick: () => checkDelivery(editor) }) : null,
      ]),
    ]));
  }
  controls(editor);
}

function makeEditor(message, detail) {
  const draft = detail.draft;
  const editor = { messageId: message.id, ...replyDefaults(message, detail),
    instructions: '', version: 0, savedVersion: 0, timer: null, savePromise: null,
    review: null, reviewId: null, delivery: null, generating: false, preparing: false, sending: false, checking: false };
  editor.inputs = {
    accountId: el('select', { class: 'input', 'aria-label': 'From account' }),
    to: el('input', { class: 'input', type: 'email', 'aria-label': 'To', autocomplete: 'off' }),
    subject: el('input', { class: 'input', type: 'text', 'aria-label': 'Subject' }),
    body: el('textarea', { class: 'input mail-reply-body', rows: '9', 'aria-label': 'Reply body',
      placeholder: 'Write your reply, or ask Nemotron for a draft.' }),
    instructions: el('input', { class: 'input', type: 'text', 'aria-label': 'Instructions for Nemotron',
      placeholder: 'Optional: what would you like to say?' }),
  };
  for (const [key, input] of Object.entries(editor.inputs)) {
    input.value = editor[key];
    input.addEventListener(key === 'accountId' ? 'change' : 'input', () => changed(editor, key));
  }
  accountOptions(editor.inputs.accountId, editor.accountId);
  editor.generate = button('Draft with Nemotron', { class: 'btn quiet', onClick: () => generate(editor) });
  editor.stop = button('Stop drafting', { class: 'btn quiet', hidden: true, onClick: () => editor.generation?.abort() });
  editor.reviewButton = button('Review reply', { class: 'btn solid', onClick: () => prepare(editor) });
  editor.status = el('p', { class: 'mail-reply-status', role: 'status' });
  editor.sendIssue = el('p', { class: 'mail-draft-note' });
  editor.fields = el('div', { class: 'mail-reply-fields' }, [
    el('div', { class: 'mail-reply-addresses' }, [field('From', editor.inputs.accountId), field('To', editor.inputs.to)]),
    field('Subject', editor.inputs.subject), field('Reply', editor.inputs.body),
    field('Draft instructions', editor.inputs.instructions),
  ]);
  editor.actions = el('div', { class: 'mail-reply-actions' }, [editor.generate, editor.stop, editor.reviewButton]);
  editor.reviewSlot = el('div', { hidden: true });
  editor.node = el('section', { class: 'mail-reply' }, [
    el('h2', { text: 'Your reply' }), editor.fields, editor.actions, editor.sendIssue, editor.status, editor.reviewSlot,
  ]);
  applyDraft(editor, draft);
  renderReview(editor);
  if (editor.delivery) deliveryStatus(editor, editor.delivery);
  else status(editor, draft ? 'Draft saved.' : 'Your reply stays a draft until you review and send it.');
  return editor;
}

function replyDefaults(message, detail) {
  const draft = detail.draft;
  return { draftId: draft?.id || null,
    accountId: draft?.account_id || detail.accountId || message.source_id,
    to: address(detail.replyTo) || message.from_email || '',
    subject: /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || ''}`,
    body: '' };
}

function showMessage(message, detail, importanceVersion = 0) {
  let editor = editors.get(message.id);
  const focused = editor?.node.contains(document.activeElement) ? document.activeElement : null;
  const focusedValue = focused?.value;
  const selection = focused && typeof focused.selectionStart === 'number'
    ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  if (!editor) {
    editor = makeEditor(message, detail);
    editors.set(message.id, editor);
  } else if (refreshable(editor)) {
    // A removed/quarantined draft is authoritative too. Reset clean fields to
    // this message's defaults so its old recipient/body/ID cannot linger.
    clearTimeout(editor.timer);
    Object.assign(editor, replyDefaults(message, detail), { review: null, reviewId: null, delivery: null });
    for (const key of ['accountId', 'to', 'subject', 'body']) editor.inputs[key].value = editor[key];
    if (detail.draft) applyDraft(editor, detail.draft);
    else { editor.version += 1; editor.savedVersion = editor.version; }
    renderReview(editor);
    if (editor.delivery) deliveryStatus(editor, editor.delivery);
    else status(editor, detail.draft ? 'Draft saved.' : 'Your reply stays a draft until you review and send it.');
  }
  pane.replaceChildren(...[
    button('Back to emails', { class: 'btn quiet mail-back', onClick: async () => {
      try {
        await flushMailDrafts();
        root.dataset.pane = 'list';
        navigateTo('#/mail');
        focusQuietly(searchField);
      } catch { /* The editor already explains why leaving was held. */ }
    } }),
    el('div', { class: 'mail-message-heading' }, [
      el('h2', { class: 'mail-message-subject', text: message.subject || '(No subject)' }),
      envelope([['From', message.from_name ? `${message.from_name} <${message.from_email || ''}>` : message.from_email],
        ['To', addresses(message.to)], ['Date', dateLabel(message.sent_at)]]),
      importanceControl(message, detail, importanceVersion),
    ]),
    detail.automaticDraft ? el('div',{class:'mail-prepared-note'},[el('strong',{text:detail.automaticDraft.status==='ready'?'Reply prepared for your review':'Reply needs attention'}),el('p',{text:detail.automaticDraft.reason}),detail.automaticDraft.request_quote ? el('blockquote',{text:detail.automaticDraft.request_quote}):null]) : null,
    el('div', { class: 'mail-message-body', text: message.body || message.snippet || 'This email has no saved text.' }),
    editor.node,
  ].filter(Boolean));
  root.dataset.pane = 'message';
  if (focused) {
    focusQuietly(focused);
    if (selection && focused.value === focusedValue) focused.setSelectionRange?.(...selection);
  }
}

async function refreshSelectedMessage() {
  const id = selectedId, draftId = selectedDraftId, editor = editors.get(id);
  if (!id || messageRequest || !refreshable(editor)) return;
  const version = editor.version, mine = new AbortController();
  const importanceVersion = importanceControls.get(id)?.version || 0;
  messageRequest = mine;
  const current = () => messageRequest === mine && selectedId === id && selectedDraftId === draftId
    && editors.get(id) === editor && editor.version === version && refreshable(editor);
  try {
    // Use the original message even on a draft route: the old draft may have
    // been removed while this pane remained open.
    const result = await api.mailMessage(id, { signal: mine.signal });
    if (!current()) return;
    if (!result.message) throw new Error('The original email is no longer saved. Open another email to reply.');
    const mode = root.dataset.pane;
    showMessage(result.message, result, importanceVersion);
    root.dataset.pane = mode;
    renderList();
  } catch (error) {
    if (error?.name !== 'AbortError' && current()) status(editor, `${error.message} Refresh again to reload this email.`, 'bad');
  } finally {
    if (messageRequest === mine) messageRequest = null;
  }
}

function refreshMail() {
  loadMessages();
  refreshSelectedMessage();
}

async function openMessage(id, draftId = null) {
  messageRequest?.abort();
  const mine = new AbortController();
  const knownId = id || [...editors.values()].find(editor => editor.draftId === draftId)?.messageId;
  const importanceVersion = importanceControls.get(knownId)?.version || 0;
  messageRequest = mine;
  selectedId = id;
  selectedDraftId = draftId;
  root.dataset.pane = 'message';
  pane.replaceChildren(el('p', { class: 'mail-empty', role: 'status', text: 'Opening email…' }));
  renderList();
  try {
    const result = draftId ? await api.mailDraft(draftId, { signal: mine.signal }) : await api.mailMessage(id, { signal: mine.signal });
    if (messageRequest !== mine) return;
    const message = result.message;
    if (!message) throw new Error('The original email is no longer saved. Open another email to reply.');
    selectedId = message.id;
    showMessage(message, result, importanceVersion);
    renderList();
  } catch (error) {
    if (error?.name === 'AbortError' || messageRequest !== mine) return;
    pane.replaceChildren(el('p', { class: 'mail-empty', role: 'status', text: error.message }),
      button('Back to emails', { class: 'btn quiet', onClick: () => { root.dataset.pane = 'list'; navigateTo('#/mail'); } }));
  } finally {
    if (messageRequest === mine) messageRequest = null;
  }
}

async function selectMessage(id) {
  try {
    await flushMailDrafts();
    openMessage(id);
    navigateTo(`#/mail/${encodeURIComponent(id)}`);
  } catch (error) {
    listStatus.textContent = `${error.message} Save your reply before changing emails.`;
  }
}

function build() {
  scopeFilter = el('select', { class: 'input', 'aria-label': 'Email view' }, [
    el('option', { value: 'important', text: 'Important' }), el('option', { value: 'filtered', text: 'Filtered out' }),
    el('option', { value: 'all', text: 'All mail' }),
  ]);
  scopeFilter.value = scope;
  scopeFilter.addEventListener('change', () => changeScope(scopeFilter.value));
  accountFilter = el('select', { class: 'input', 'aria-label': 'Filter by account' });
  accountOptions(accountFilter, '', true);
  accountFilter.addEventListener('change', () => { accountId = accountFilter.value; loadMessages(); });
  searchField = el('input', { class: 'input', type: 'search', placeholder: 'Search saved emails', 'aria-label': 'Search saved emails' });
  searchField.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchField.value.trim(); loadMessages(); }, 250);
  });
  searchField.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    clearTimeout(searchTimer);
    if (event.key === 'Escape') searchField.value = '';
    query = searchField.value.trim();
    loadMessages();
  });
  refreshButton = button('Refresh', { class: 'btn quiet', onClick: refreshMail });
  listStatus = el('p', { class: 'mail-list-status', role: 'status' });
  list = el('div', { class: 'mail-list', 'aria-label': 'Saved emails' });
  moreButton = button('Load more emails', { class: 'btn quiet mail-more', hidden: true, onClick: () => loadMessages({ more: true }) });
  pane = el('div', { class: 'mail-message-pane' }, el('div', { class: 'mail-empty' }, [
    el('h2', { text: 'Choose an email' }), el('p', { text: 'Read it here, write a reply, or ask Nemotron to prepare one.' }),
  ]));
  root = el('div', { class: 'view view-mail', dataset: { pane: 'list' } }, [
    el('div', { class: 'mail-heading' }, el('div', {}, [
      el('h1', { text: 'Email' }), el('p', { text: 'Important emails first, with filtered mail always available and replies you can review and send.' }),
    ])),
    el('div', { class: 'mail-filters' }, [field('Email view', scopeFilter), field('Account', accountFilter), field('Search', searchField), refreshButton]),
    mailPreferencesPanel(()=>loadMessages()),
    el('div', { class: 'mail-layout' }, [el('div', { class: 'mail-list-pane' }, [listStatus, list, moreButton]), pane]),
  ]);
}

export function renderMail(ctx) {
  navigateTo = ctx.navigate;
  const timezoneChanged = timezone !== ctx.tz;
  timezone = ctx.tz;
  const entering = ctx.mailVisit != null && ctx.mailVisit !== lastVisit;
  lastVisit = ctx.mailVisit ?? lastVisit;
  if (!root) build();
  if (timezoneChanged) renderList();
  const revisionChanged = lastRev !== state.rev;
  if (revisionChanged) {
    lastRev = state.rev;
    loadMessages();
  }
  if (ctx.mailDraftId && (entering || ctx.mailDraftId !== selectedDraftId)) openMessage(null, ctx.mailDraftId);
  else if (!ctx.mailDraftId && ctx.sub) {
    let id;
    try { id = decodeURIComponent(ctx.sub); } catch { id = ctx.sub; }
    if (entering || id !== selectedId || selectedDraftId) openMessage(id);
    else root.dataset.pane = 'message';
  } else if (!ctx.mailDraftId && !ctx.sub) root.dataset.pane = 'list';
  if (revisionChanged) refreshSelectedMessage();
  for (const editor of editors.values()) controls(editor);
  return root;
}
