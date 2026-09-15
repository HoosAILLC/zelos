import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULTS } from '../core/config.mjs';
import { installDom, walk, text, findButton, settle } from './helpers/ui-dom.mjs';

const presets = [
  { id: 'anthropic', protocol: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', suggestedModels: ['claude-sonnet-5'] },
  { id: 'openai', protocol: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', suggestedModels: ['test-model'] },
];

async function fixture(t, { model = {}, stored = true, testOk = true, saveOk = true } = {}) {
  const document = installDom(t);
  const store = await import('../ui/lib/store.js');
  const settings = await import('../ui/views/settings.js');
  let config = { ...structuredClone(DEFAULTS), model: { ...DEFAULTS.model, model: 'claude-sonnet-5', ...model } };
  const refs = new Set(stored ? [config.model.keyRef] : []);
  const calls = [];
  store.notify(null);
  store.state.config = structuredClone(config);
  store.state.secretRefs = [...refs];
  store.state.health = { model: { configured: stored }, backend: { name: 'encrypted-file' } };
  t.after(() => store.notify(null));
  t.mock.method(globalThis, 'fetch', async (path, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method, body });
    let value;
    if (path === '/api/model/presets') value = presets;
    else if (path === '/api/local/probe') value = [];
    else if (path === '/api/help') value = {};
    else if (path === '/api/secrets') { refs.add(body.ref); value = { ok: true }; }
    else if (path === '/api/model/test') value = testOk ? { ok: true, sample: 'ready', ms: 12 } : { ok: false, error: 'The provider refused this key.' };
    else if (path === '/api/config' && method === 'PUT') {
      if (!saveOk) return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'Settings could not be saved.' }) };
      config = { ...config, model: { ...config.model, ...body.model } };
      value = { config: structuredClone(config), errors: [], secretRefs: [...refs] };
    } else if (path === '/api/health') value = { model: { configured: true } };
    else throw new Error(`Unexpected request ${method} ${path}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  });
  const panel = document.body.appendChild(settings.modelPanel());
  await settle();
  return { document, store, settings, panel, calls };
}

function labeledInput(panel, label) {
  const name = walk(panel).find(node => node.tag === 'label' && text(node) === label);
  assert.ok(name, `Missing field: ${label}`);
  return walk(panel).find(node => (node.id || node.getAttribute('id')) === name.getAttribute('for'));
}
const actionButton = (panel, label) => findButton(panel, label)
  || walk(panel).find(node => node.tag === 'button' && text(node).replace(/^▸\s*/, '') === label);
async function click(panel, label) {
  const button = actionButton(panel, label);
  assert.ok(button, `Missing button: ${label}`);
  for (const listener of button.listeners.get('click') || []) await listener.call(button);
  await settle();
}
const writes = calls => calls.filter(call => call.method !== 'GET' && call.path !== '/api/help');

test('AI Advanced exposes the saved response limit and preserves it when changing another model field', async t => {
  const { panel, calls, store } = await fixture(t, { model: { maxTokens: 32768, temperature: 0.2 } });
  const limit = labeledInput(panel, 'Response limit (tokens)');
  assert.equal(limit.value, '32768');
  assert.equal(limit.getAttribute('type'), 'number');
  assert.equal(limit.getAttribute('min'), '1'); assert.equal(limit.getAttribute('max'), '1000000');
  assert.equal(limit.getAttribute('step'), '1');
  assert.equal(limit.closest('.unfold-body').hidden, true, 'advanced controls stay out of first-run setup');
  await click(panel, 'Advanced');
  const model = labeledInput(panel, 'Model'); model.value = 'another-model'; model.fire('input');
  await click(panel, 'Save');
  const saved = writes(calls).find(call => call.path === '/api/config');
  assert.equal(saved.body.model.maxTokens, 32768);
  assert.equal(saved.body.model.model, 'another-model');
  assert.equal(store.state.config.model.temperature, 0.2, 'unrelated model settings remain intact');
  assert.deepEqual(writes(calls).map(call => call.path), ['/api/config'], 'changing the limit never makes a model call');
  assert.match(store.state.toast.message, /AI settings saved/);
});

test('edited response limits persist numerically across provider selection and accept both server boundaries', async t => {
  const { panel, calls, store } = await fixture(t);
  assert.equal(labeledInput(panel, 'Response limit (tokens)').value, String(DEFAULTS.model.maxTokens));
  let limit = labeledInput(panel, 'Response limit (tokens)'); limit.value = '32768'; limit.fire('input');
  const other = walk(panel).find(node => node.tag === 'button' && text(node).startsWith('OpenAI, who make ChatGPT'));
  other.click();
  limit = labeledInput(panel, 'Response limit (tokens)'); assert.equal(limit.value, '32768');
  for (const value of ['32768', '1', '1000000']) {
    limit.value = value; limit.fire('input');
    await click(panel, 'Save');
    assert.equal(store.state.config.model.maxTokens, Number(value));
    assert.equal(writes(calls).at(-1).body.model.maxTokens, Number(value));
  }
});

test('invalid response limits are explained and revealed before saving credentials or testing a model', async t => {
  const { document, panel, calls } = await fixture(t, { stored: false });
  const limit = labeledInput(panel, 'Response limit (tokens)');
  const key = walk(panel).find(node => node.getAttribute('type') === 'password'); key.value = 'synthetic-key';
  for (const value of ['', '0', '-1', '1.5', '1000001', 'Infinity', 'nonsense']) {
    for (const action of ['Save', 'Check it works']) {
      limit.value = value; limit.fire('input'); calls.length = 0;
      const advanced = limit.closest('.unfold-body'); advanced.hidden = true;
      actionButton(panel, 'Advanced').setAttribute('aria-expanded', 'false');
      await click(panel, action);
      assert.deepEqual(writes(calls), [], `${action} with ${JSON.stringify(value)} must make no write or model call`);
      assert.match(text(panel), /Response limit.*whole number.*1.*1,000,000/);
      assert.equal(advanced.hidden, false); assert.equal(document.activeElement, limit);
      assert.equal(limit.getAttribute('aria-invalid'), 'true');
      assert.equal(key.value, 'synthetic-key', 'validation must not discard the unsaved key');
    }
  }
});

test('guided connection success survives the config-triggered panel replacement and renders in the app toast', async t => {
  const { document, panel, calls, store, settings } = await fixture(t, { model: { maxTokens: 32768 } });
  let current = panel;
  let revision = store.state.rev;
  const unsubscribe = store.subscribe(() => {
    if (store.state.rev === revision) return;
    revision = store.state.rev;
    const next = settings.modelPanel(); current.replaceWith(next); current = next;
  });
  t.after(unsubscribe);
  await click(panel, 'Check it works');
  assert.equal(panel.isConnected, false, 'the test must reproduce removal of the status node during save');
  assert.equal(current.isConnected, true);
  assert.deepEqual(writes(calls).map(call => call.path), ['/api/model/test', '/api/config']);
  assert.equal(writes(calls).at(-1).body.model.maxTokens, 32768);
  assert.equal(store.state.toast?.message, 'Working. Zelos will use Claude.');
  const { el, button } = await import('../ui/lib/dom.js');
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const toast = source.match(/function toastBar\(\) \{[\s\S]*?\n\}/)[0];
  const rendered = vm.runInNewContext(`${toast}\ntoastBar()`, { state: store.state, notify: store.notify, el, button });
  document.body.appendChild(rendered.node); rendered.text.textContent = store.state.toast.message;
  assert.match(text(document.body), /Working\. Zelos will use Claude\./);
});

test('failed connection or save leaves a truthful error without a success toast', async t => {
  for (const options of [{ testOk: false }, { saveOk: false }]) {
    await t.test(JSON.stringify(options), async child => {
      const { panel, calls, store } = await fixture(child, options);
      await click(panel, 'Check it works');
      assert.equal(store.state.toast, null);
      assert.match(text(panel), options.testOk === false ? /provider refused/ : /Settings could not be saved/);
      if (options.testOk === false) assert.equal(writes(calls).some(call => call.path === '/api/config'), false);
    });
  }
});
