/** ChatGPT sign-in has its own lifecycle and never reads or writes API keys. */
import { el, button, replace } from './dom.js';
import { api } from './api.js';

const POLL_MS = 2000;
const SIGN_IN_MS = 15 * 60 * 1000;
const INSTALL_URL = 'https://learn.chatgpt.com/docs/cli';

/** A provider address is still data. Never render credentials or executable links. */
export function subscriptionAuthUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com'
      && !url.username && !url.password && !url.port && url.pathname === '/oauth/authorize'
      ? url.href : null;
  } catch { return null; }
}

function link(href, label, className = 'btn quiet') {
  return el('a', { href, class: className, target: '_blank', rel: 'noopener noreferrer', text: label });
}

export function subscriptionPanel({ model = 'auto', maxTokens = 8192, onSave } = {}) {
  const node = el('div', { class: 'subscription-setup stack' });
  const content = el('div', { class: 'stack' });
  const notice = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const modelChoices = el('select', { class: 'input', 'aria-label': 'ChatGPT choice' });
  const installGuide = link(INSTALL_URL, 'Open Codex installation guide');
  let selectedModel = model || 'auto';
  let accountState = null;
  let flow = null;
  let poll = null;
  let observer = null;
  let disposed = false;
  let generation = 0;
  let pollingStarted = 0;
  let checking = false;
  let busy = false;
  let lastPaint = '';

  function message(text, bad = false) {
    notice.textContent = text;
    notice.className = `status${bad ? ' is-bad' : ''}`;
  }
  function stopPolling() { if (poll !== null) clearTimeout(poll); poll = null; }
  function active(version = generation) { return !disposed && version === generation; }
  function controlsDisabled(value) {
    busy = value;
    for (const control of content.querySelectorAll('button, select')) control.disabled = value;
  }
  function drawChoices(models = []) {
    const choices = [{ id: 'auto', label: 'Account default (recommended)' }, ...models.filter(m => m?.id && m.id !== 'auto')];
    if (!choices.some(m => m.id === selectedModel)) choices.push({ id: selectedModel, label: selectedModel });
    modelChoices.replaceChildren(...choices.map(m => el('option', { value: m.id, text: m.label || m.displayName || m.id })));
    modelChoices.value = selectedModel;
  }
  modelChoices.addEventListener('change', () => { selectedModel = modelChoices.value || 'auto'; });
  drawChoices();

  function schedule() {
    stopPolling();
    if (!active() || accountState?.login?.status !== 'pending') return;
    if (!pollingStarted) pollingStarted = Date.now();
    if (Date.now() - pollingStarted >= SIGN_IN_MS) {
      message('Sign-in is taking longer than expected. Check again, or cancel and start a new sign-in.', true);
      return;
    }
    poll = setTimeout(() => {
      poll = null;
      if (!node.isConnected) { dispose(); return; }
      void refresh({ automatic: true });
    }, POLL_MS);
    poll?.unref?.();
  }

  function paint() {
    if (!active()) return;
    const status = accountState;
    const pending = status?.login?.status === 'pending';
    // Polling must not replace the focused Cancel button every two seconds.
    const signature = JSON.stringify([status?.installed, status?.connected, status?.account, status?.login, flow?.authUrl, busy]);
    if (lastPaint === signature) return;
    lastPaint = signature;
    if (!status?.installed) {
      replace(content, [
        el('p', { text: 'Install OpenAI’s Codex command-line app on this Mac or Windows PC, then return here. Zelos uses it to connect to your ChatGPT plan.' }),
        el('div', { class: 'row-inline' }, [installGuide, button('Check again', { class: 'btn quiet', onClick: () => refresh() })]),
      ]);
    } else if (pending) {
      const authUrl = flow?.loginId === status.login.loginId ? subscriptionAuthUrl(flow.authUrl) : null;
      replace(content, [
        el('p', { text: 'Finish signing in with OpenAI in your browser. Return here when you are done.' }),
        el('div', { class: 'row-inline' }, [
          authUrl ? link(authUrl, 'Continue to OpenAI', 'btn solid') : null,
          button('Check sign-in', { class: 'btn quiet', onClick: () => refresh() }),
          button('Cancel sign-in', { class: 'btn quiet', onClick: cancel }),
        ]),
      ]);
    } else if (status.connected) {
      const account = status.account || {};
      replace(content, [
        el('p', { text: `Connected${account.email ? ` as ${account.email}` : ''}${account.planType ? ` · ${account.planType}` : ''}.` }),
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'ChatGPT choice' }), modelChoices]),
        el('div', { class: 'row-inline' }, [
          button('Use ChatGPT subscription', { class: 'btn solid', onClick: save }),
          button('Refresh choices', { class: 'btn quiet', onClick: listModels }),
          button('Check a reply', { class: 'btn quiet', onClick: test }),
          button('Sign out of Zelos', { class: 'btn quiet', onClick: logout }),
        ]),
        el('p', { class: 'quiet-note', text: 'Checking a reply uses a small amount of your plan allowance. Saving this choice does not send a question.' }),
      ]);
    } else {
      replace(content, [
        el('p', { text: 'Sign in with the ChatGPT account whose plan you want Zelos to use.' }),
        el('div', { class: 'row-inline' }, [button('Sign in with ChatGPT', { class: 'btn solid', onClick: login }), installGuide]),
      ]);
    }
    controlsDisabled(busy);
  }

  async function refresh({ automatic = false } = {}) {
    if (checking || disposed) return null;
    checking = true;
    const version = generation;
    try {
      const status = await api.subscriptionStatus();
      if (!active(version)) return null;
      accountState = status;
      paint();
      const loginState = status.login;
      if (status.error) message(status.error, true);
      else if (loginState?.status === 'failed') message(loginState.error || 'Sign-in did not finish. Please try again.', true);
      else if (loginState?.status === 'canceled') message('Sign-in canceled.');
      else if (status.connected) message('Your ChatGPT account is connected. Choose Use ChatGPT subscription to save it.');
      else if (!automatic) message(loginState?.status === 'pending' ? 'Waiting for you to finish sign-in.' : '');
      schedule();
      return status;
    } catch (err) {
      if (active(version)) {
        stopPolling();
        message(`Could not check ChatGPT. ${err.message} Try checking again.`, true);
        // Keep a way to recover even when the first request failed.
        if (!accountState) replace(content, [button('Check again', { class: 'btn quiet', onClick: () => refresh() })]);
      }
      return null;
    } finally { if (active(version)) checking = false; }
  }

  async function login() {
    if (busy || disposed) return;
    const version = ++generation;
    controlsDisabled(true);
    message('Preparing your OpenAI sign-in…');
    try {
      const started = await api.subscriptionLogin();
      if (!active(version)) {
        if (started?.loginId) await api.subscriptionCancel(started.loginId).catch(() => {});
        return;
      }
      if (!started?.loginId || !subscriptionAuthUrl(started.authUrl)) {
        if (started?.loginId) await api.subscriptionCancel(started.loginId).catch(() => {});
        throw new Error('OpenAI did not return a valid sign-in page. Please try again.');
      }
      flow = started;
      pollingStarted = Date.now();
      accountState = { ...accountState, login: { loginId: started.loginId, status: 'pending' } };
      message('Open the sign-in page below. Zelos will check for completion here.');
    } catch (err) { if (active(version)) message(err.message, true); }
    finally { if (active(version)) { controlsDisabled(false); lastPaint = ''; paint(); schedule(); } }
  }

  async function cancel() {
    if (busy || disposed) return;
    const loginId = accountState?.login?.loginId || flow?.loginId;
    if (!loginId) return;
    const version = ++generation;
    checking = false;
    stopPolling();
    controlsDisabled(true);
    try {
      await api.subscriptionCancel(loginId);
      if (!active(version)) return;
      flow = null;
      accountState = { ...accountState, login: { loginId, status: 'canceled' } };
      message('Sign-in canceled.');
    } catch (err) { if (active(version)) message(`Could not cancel sign-in: ${err.message}`, true); }
    finally { if (active(version)) { controlsDisabled(false); lastPaint = ''; paint(); schedule(); } }
  }

  function spec() {
    return { protocol: 'chatgpt', label: 'ChatGPT subscription', baseUrl: 'https://chatgpt.com', model: selectedModel, keyRef: null, maxTokens };
  }
  async function connectedAction(action) {
    if (busy || disposed) return;
    const version = generation;
    controlsDisabled(true);
    try {
      const status = await api.subscriptionStatus();
      if (!active(version)) return;
      if (!status.connected) {
        accountState = status;
        lastPaint = '';
        paint();
        throw new Error(status.error || 'Your ChatGPT account is no longer connected. Sign in again.');
      }
      await action();
    } catch (err) { if (active(version)) message(err.message, true); }
    finally { if (active(version)) controlsDisabled(false); }
  }
  async function save() {
    await connectedAction(async () => {
      message('Saving…');
      await onSave(spec());
      if (active()) message('Saved. Zelos will use your ChatGPT subscription.');
    });
  }
  async function test() {
    await connectedAction(async () => {
      message('Asking ChatGPT for a short reply…');
      const result = await api.testModel(spec());
      if (!active()) return;
      message(result.ok ? `ChatGPT answered: “${result.sample}”` : result.error || 'ChatGPT could not answer. Please try again.', !result.ok);
    });
  }
  async function listModels() {
    if (busy || disposed) return;
    const version = generation;
    controlsDisabled(true);
    try {
      const models = await api.listModels({ protocol: 'chatgpt' });
      if (!active(version)) return;
      drawChoices(Array.isArray(models) ? models : []);
      message('Choices refreshed. Account default follows the choice available to your plan.');
    } catch (err) { if (active(version)) message(`Could not load choices: ${err.message}`, true); }
    finally { if (active(version)) controlsDisabled(false); }
  }
  async function logout() {
    if (busy || disposed) return;
    const version = ++generation;
    checking = false;
    controlsDisabled(true);
    stopPolling();
    try {
      await api.subscriptionLogout();
      if (!active(version)) return;
      flow = null;
      accountState = { ...accountState, connected: false, account: null, login: null };
      message('Signed out of Zelos. If ChatGPT is your saved choice, AI answers and automatic reviews pause until you sign in again or choose another service.');
    } catch (err) { if (active(version)) message(`Could not sign out: ${err.message}`, true); }
    finally { if (active(version)) { controlsDisabled(false); lastPaint = ''; paint(); } }
  }
  function dispose({ cancel: shouldCancel = false } = {}) {
    if (disposed) return;
    disposed = true;
    generation += 1;
    stopPolling();
    observer?.disconnect();
    const loginId = accountState?.login?.status === 'pending' && (accountState.login.loginId || flow?.loginId);
    if (shouldCancel && loginId) void api.subscriptionCancel(loginId).catch(() => {});
  }

  replace(node, [
    el('div', { class: 'chosen-head' }, el('span', { class: 'chosen-label', text: 'Your ChatGPT subscription' })),
    el('p', { text: 'Use your ChatGPT plan for Ask and your mail and board reviews. No separate key required.' }),
    el('p', { class: 'quiet-note', text: 'Your plan must include Codex. Its usage limits apply, including automatic reviews. Zelos does not switch to a separately billed service when you reach them.' }),
    el('p', { class: 'quiet-note', text: 'Your existing privacy choices still apply. Local-only health, money, and mail-drafting features still need an AI program on this computer.' }),
    content,
    notice,
    el('p', { class: 'quiet-note', text: 'This connection belongs to Zelos. Signing in or out here does not change your separate Codex app sign-in.' }),
  ]);
  message('Checking your ChatGPT connection…');
  // Removal stops polling; a reopened panel can resume a pending provider flow.
  if (typeof MutationObserver === 'function') {
    let mounted = false;
    observer = new MutationObserver(() => {
      if (node.isConnected) mounted = true;
      else if (mounted) dispose();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  void refresh();
  return { node, dispose };
}
