import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';

let fixtureId = 0;
async function fixture(t, { configured = false, settingsFailure = false } = {}) {
  const requests = [];
  t.after(async () => { requests.forEach(request => request.close()); await settle(); });
  const document = installDom(t), { state } = await import('../ui/lib/store.js'), { api } = await import('../ui/lib/api.js');
  const previousHealth = state.health; state.health = { model: { configured: true } };
  t.after(() => { state.health = previousHealth; });
  let settingsReads = 0; const savedSettings = [], assigned = [];
  t.mock.method(api, 'conversations', async () => ({ threads: [] }));
  t.mock.method(api, 'askRequest', async () => ({ id: 'synthetic-thread', answerId: 'synthetic-answer' }));
  t.mock.method(api, 'stopAnswer', async () => ({ ok: true }));
  t.mock.method(api, 'webSettings', async () => { settingsReads++; if (settingsFailure) throw new Error('Setup unavailable'); return { searchConfigured: configured, provider: 'brave' }; });
  t.mock.method(api, 'saveWebSettings', async body => { savedSettings.push(body); return { searchConfigured: true, provider: 'brave' }; });
  t.mock.method(api, 'assignJob', async prompt => { assigned.push(prompt); return { job: {} }; });
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/ask', 'No browser-side external requests');
    let streamController, closed = false, terminal = false;
    const stream = new ReadableStream({ start(value) { streamController = value; }, cancel() { closed = true; } });
    const request = { body: (()=>{const {requestId,continueOnDisconnect,...body}=JSON.parse(options.body);
      assert.match(requestId,/^[a-f0-9-]{36}$/); assert.equal(continueOnDisconnect,true); return body;})(), signal: options.signal,
      send(event, value) { if(event==='done'||event==='error')terminal=true; streamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)); },
      // Completed server streams include done; disconnect recovery is tested separately.
      close() { if (!closed) { if(!terminal)this.send('done',{stopReason:'stop'}); closed = true; streamController.close(); } },
      abort() { if (!closed) { closed = true; streamController.error(new DOMException('Stopped', 'AbortError')); } },
    };
    options.signal.addEventListener('abort', request.abort, { once: true }); requests.push(request); return new Response(stream);
  });
  const ask = await import(`../ui/views/ask.js?web-fixture=${++fixtureId}`);
  const view = document.body.appendChild(ask.renderAsk({ navigate() {} }));
  const field = view.querySelector('.ask-field'), form = view.querySelector('form');
  // The current composer exposes explicit page/search buttons and a selected
  // context chip instead of the earlier dropdown. Read its real visible state.
  const mode = { get value() { const chip=view.querySelector('.ask-web-chip'); return chip.hidden?'off':chip.dataset.mode; } };
  return { document, view, field, form, mode, requests, savedSettings, assigned, settingsReads: () => settingsReads,
    page: view.querySelector('.ask-web-url'), query: view.querySelector('.ask-web-query'), key: view.querySelector('.ask-web-key'),
    setMode(value) {
      const label={page:'Read a public page',search:'Search the web',off:'Remove web lookup'}[value];
      if(value!=='off')findButton(view,'Add context').click();
      findButton(view,label).click();
    },
    submit(question) { field.value = question; form.fire('submit'); },
  };
}

test('web starts off, performs no setup call until selected, and never extracts a URL from the private question', async t => {
  const f = await fixture(t);
  assert.equal(f.mode.value, 'off'); assert.equal(f.settingsReads(), 0); assert.equal(f.requests.length, 0);
  assert.equal(text(f.view.querySelector('.ask-web-local')), 'Selected AI');
  assert.equal(f.view.querySelector('.ask-web-details').hidden, true);
  f.submit('Compare my private records with https://example.com/news');
  assert.deepEqual(f.requests[0].body, { question: 'Compare my private records with https://example.com/news' });
  assert.equal(f.settingsReads(), 0);
});

test('reading a page requires a separate explicit URL and resets to web off for the next turn', async t => {
  const f = await fixture(t); f.setMode('page');
  f.submit('Explain this public article'); assert.equal(f.requests.length, 0);
  assert.match(text(f.view.querySelector('.ask-web-status')), /Enter a public/);
  f.page.value = 'https://example.com/article'; f.page.fire('input'); f.form.fire('submit');
  assert.deepEqual(f.requests[0].body, { question: 'Explain this public article', web: { mode: 'page', url: 'https://example.com/article' } });
  assert.equal(f.mode.value, 'off'); assert.equal(f.settingsReads(), 0);
  f.requests[0].send('delta', { text: 'An answer grounded in the article.' }); f.requests[0].close(); await settle();
  f.submit('Now discuss my private next steps');
  assert.deepEqual(f.requests[1].body, { question: 'Now discuss my private next steps' });
});

test('search setup is explicit and keeps the key out of Ask requests and rendered readback', async t => {
  const f = await fixture(t); f.setMode('search'); await settle();
  assert.equal(f.settingsReads(), 1); assert.equal(f.view.querySelector('.ask-web-setup').hidden, false);
  assert.match(text(f.view), /Only the lookup entered here goes to the website or search provider/);
  assert.match(text(f.view), /private records are not included in that web request/);
  f.query.value = 'public transport news'; f.submit('How does this compare with my private notes?');
  assert.equal(f.requests.length, 0); assert.match(text(f.view.querySelector('.ask-web-status')), /Save a Brave/);
  f.key.value = 'synthetic-KEY-private'; findButton(f.view, 'Save search key').click(); await settle();
  assert.deepEqual(f.savedSettings, [{ apiKey: 'synthetic-KEY-private' }]); assert.equal(f.key.value, '');
  assert.equal(f.view.querySelector('.ask-web-setup').hidden, true); assert.ok(!text(f.view).includes('synthetic-KEY-private'));
  assert.equal(f.requests.length, 0, 'Saving a key does not start a lookup');
  f.form.fire('submit');
  assert.deepEqual(f.requests[0].body, { question: 'How does this compare with my private notes?', web: { mode: 'search', query: 'public transport news' } });
  assert.ok(!JSON.stringify(f.requests[0].body).includes('synthetic-KEY-private'));
});

test('configured search requires a separately entered query and does not copy the question into it', async t => {
  const f = await fixture(t, { configured: true }); f.setMode('search'); await settle();
  f.submit('Use my private invoice and health history to explain my options');
  assert.equal(f.query.value, ''); assert.equal(f.requests.length, 0);
  assert.match(text(f.view.querySelector('.ask-web-status')), /separate search query/);
  f.query.value = 'official public information'; f.form.fire('submit');
  assert.deepEqual(f.requests[0].body.web, { mode: 'search', query: 'official public information' });
  assert.equal(f.mode.value, 'off');
});

test('failed lookup retries retain exactly the approved URL without automatically retrying', async t => {
  const f = await fixture(t); f.setMode('page'); f.page.value = 'https://example.com/article';
  f.submit('Summarize the article'); f.requests[0].send('error', { error: 'The website is unavailable.' }); f.requests[0].close(); await settle();
  assert.equal(f.field.value, 'Summarize the article'); assert.equal(f.mode.value, 'page'); assert.equal(f.page.value, 'https://example.com/article');
  assert.equal(f.requests.length, 1);
  f.form.fire('submit'); assert.deepEqual(f.requests[1].body, f.requests[0].body);
});

test('a failure cannot attach the old lookup to a newer question or replace new lookup edits', async t => {
  const f = await fixture(t); f.setMode('page'); f.page.value = 'https://example.com/old'; f.submit('Old article question');
  f.field.value = 'A new private question'; f.requests[0].send('error', { error: 'Unavailable' }); f.requests[0].close(); await settle();
  assert.equal(f.field.value, 'A new private question'); assert.equal(f.mode.value, 'off'); f.form.fire('submit');
  assert.deepEqual(f.requests[1].body, { question: 'A new private question' }); f.requests[1].close(); await settle();
  f.setMode('page'); f.page.value = 'https://example.com/old'; f.submit('Another old question');
  f.setMode('page'); f.page.value = 'https://example.com/new'; f.page.fire('input');
  f.requests[2].send('error', { error: 'Unavailable' }); f.requests[2].close(); await settle();
  assert.equal(f.page.value, 'https://example.com/new'); assert.equal(f.mode.value, 'page');
});

test('stopping a lookup aborts the request and does not leave web enabled for a later private question', async t => {
  const f = await fixture(t); f.setMode('page'); f.page.value = 'https://example.com/article'; f.submit('Read this');
  findButton(f.view, 'Stop').click(); await settle();
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.mode.value, 'off');
  f.submit('My private follow-up'); assert.equal(f.requests[1].body.web, undefined);
});

test('web sources have safe direct links, visible references and honest date labels', async t => {
  const f = await fixture(t); f.submit('A question');
  f.requests[0].send('sources', [
    { kind: 'web', ref: 'web:1', title: '<img onerror=bad> Official report', url: 'https://example.com/report', excerpt: 'Plain source text.',
      date: '2026-09-10T12:00:00Z', dateKind: 'published_or_modified', fetchedAt: '2026-09-11T12:00:00Z' },
    { kind: 'web', ref: 'web:2', title: 'Unsafe link', url: 'javascript:alert(1)', date: null, fetchedAt: '2026-09-11T12:00:00Z' },
    { kind: 'web', ref: 'web:3', title: 'Credential link', url: 'https://name:secret@example.com/' },
  ]); await settle();
  findButton(f.view, '3 sources').click(); const sources = f.view.querySelector('.sources-list'), links = sources.querySelectorAll('a');
  assert.equal(links.length, 1); assert.equal(links[0].getAttribute('href'), 'https://example.com/report');
  assert.equal(links[0].getAttribute('rel'), 'noreferrer noopener'); assert.equal(links[0].getAttribute('target'), '_blank');
  assert.equal(sources.querySelectorAll('img').length, 0); assert.match(text(sources), /<img onerror=bad> Official report/);
  assert.match(text(sources), /web:1 · Published or updated/); assert.match(text(sources), /Retrieved/);
  assert.match(text(sources), /web:2 · Source date not provided/);
});

test('assigning work with web enabled requires choosing Ask and never silently drops the requested lookup', async t => {
  const f = await fixture(t); f.setMode('page'); f.page.value = 'https://example.com/'; f.field.value = 'Research this page';
  findButton(f.view, 'Assign to Zelos').click(); await settle();
  assert.equal(f.assigned.length, 0); assert.match(text(f.view), /Choose Ask for this web lookup/);
  f.setMode('off'); findButton(f.view, 'Assign to Zelos').click(); await settle();
  assert.deepEqual(f.assigned, ['Research this page']);
});

test('new conversations reset web fields and an unavailable setup remains an honest unconfigured state', async t => {
  const f = await fixture(t, { settingsFailure: true }); f.setMode('search'); await settle();
  assert.match(text(f.view.querySelector('.ask-web-status')), /Setup unavailable/);
  f.query.value = 'public query'; f.submit('Question'); assert.equal(f.requests.length, 0);
  f.key.value = 'unfinished-key'; findButton(f.view, 'New conversation').click();
  assert.equal(f.mode.value, 'off'); assert.equal(f.query.value, ''); assert.equal(f.page.value, ''); assert.equal(f.key.value, '');
});
