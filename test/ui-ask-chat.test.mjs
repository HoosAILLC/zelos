import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';

let fixtureId = 0;

async function fixture(t) {
  const document = installDom(t);
  const { state } = await import('../ui/lib/store.js');
  const previousHealth = state.health;
  state.health = { model: { configured: true } };
  t.after(() => { state.health = previousHealth; });
  const { api }=await import('../ui/lib/api.js');
  t.mock.method(api,'conversations',async()=>({threads:[]}));
  t.mock.method(api,'askRequest',async()=>({id:'synthetic-thread',answerId:'synthetic-answer'}));
  t.mock.method(api,'stopAnswer',async()=>({ok:true}));
  const ask = await import(`../ui/views/ask.js?chat-fixture=${++fixtureId}`);
  const view = document.body.appendChild(ask.renderAsk({ navigate() {} }));
  const field = view.querySelector('.ask-field');
  const form = view.querySelector('form');
  const transcript = view.querySelector('.transcript');
  const requests = [];
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/ask');
    let streamController;
    let closed = false, terminal = false;
    const stream = new ReadableStream({
      start(controller) { streamController = controller; },
      cancel() { closed = true; },
    });
    const request = {
      body: (()=>{const {requestId,continueOnDisconnect,...body}=JSON.parse(options.body);
        assert.match(requestId,/^[a-f0-9-]{36}$/); assert.equal(continueOnDisconnect,true); return body;})(), signal: options.signal,
      send(event, data) { if(event==='done'||event==='error')terminal=true; streamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); },
      // A normal completed server stream carries done; closing without it is
      // a disconnect and deliberately starts the separate recovery workflow.
      close() { if (!closed) { if(!terminal)this.send('done',{stopReason:'stop'}); closed = true; streamController.close(); } },
      abort() { if (!closed) { closed = true; streamController.error(new DOMException('Stopped', 'AbortError')); } },
    };
    options.signal.addEventListener('abort', request.abort, { once: true });
    requests.push(request);
    return new Response(stream);
  });
  t.after(async () => { for (const request of requests) request.close(); await settle(); });
  return {
    document, ask, view, field, form, transcript, requests,
    submit(question) { field.value = question; form.fire('submit'); },
  };
}

test('Ask suggestions only fill and focus a persistent composer beneath the conversation', async t => {
  const { document, ask, view, field, form, transcript, requests } = await fixture(t);
  assert.match(text(view.querySelector('.ask-welcome')), /What would you like to know/);
  assert.match(text(view), /private records/);
  assert.equal(view.children.at(-1), form);
  assert.ok(view.children.indexOf(transcript) < view.children.indexOf(form));
  for (const [label, question] of [
    ['Summarize a project', 'Summarize the latest updates about '],
    ['Find a decision', 'What was decided about '],
    ['Prepare for a meeting', 'Help me prepare for my meeting about '],
  ]) {
    findButton(view, label).click();
    assert.equal(field.value, question);
    assert.equal(document.activeElement, field);
  }
  assert.equal(requests.length, 0, 'choosing a suggestion must not contact the AI');
  assert.equal(ask.renderAsk({ navigate() {} }), view);
  assert.equal(view.querySelector('form'), form);
  assert.equal(field.value, 'Help me prepare for my meeting about ');
});

test('Mac and Windows submit shortcuts ignore composition, repeats and extra modifiers',async t=>{
  const {field,form}=await fixture(t);let submits=0;form.requestSubmit=()=>{submits++;};
  for(const modifiers of [{metaKey:true},{ctrlKey:true}]) {
    for(const ignored of [{isComposing:true},{repeat:true},{altKey:true},{shiftKey:true}]) {
      const event=field.fire('keydown',{key:'Enter',...modifiers,...ignored});assert.equal(event.defaultPrevented,false);
    }
    assert.equal(submits,modifiers.metaKey?0:1);
    assert.equal(field.fire('keydown',{key:'Enter',...modifiers}).defaultPrevented,true);
  }
  assert.equal(submits,2);assert.equal(field.fire('keydown',{key:'Enter'}).defaultPrevented,false);
});

test('Ask appends exchanges chronologically and reveals complete source information on demand', async t => {
  const { ask, view, form, transcript, requests, submit } = await fixture(t);
  submit('What happened on the Atlas project?');
  assert.equal(view.querySelector('.ask-welcome').hidden, true);
  requests[0].send('sources', [
    { kind: 'message', title: 'Atlas decision', excerpt: 'Keep the original timeline.', ref: 'msg:one' },
    { kind: 'item', title: 'Prior Atlas task', sourceInactive: true, ref: 'item:two' },
  ]);
  await settle();
  const first = transcript.children[0];
  const sourceToggle = findButton(first, '2 sources');
  const sources = first.querySelector('.sources-list');
  assert.ok(sourceToggle, 'sources are discoverable before the answer starts');
  assert.equal(sources.hidden, true);
  assert.equal(sourceToggle.getAttribute('aria-expanded'), 'false');
  sourceToggle.click();
  assert.equal(sources.hidden, false);
  assert.equal(sourceToggle.getAttribute('aria-expanded'), 'true');
  assert.match(text(sources), /Atlas decision.*Keep the original timeline.*Prior Atlas task.*No longer in task selection/);
  sourceToggle.click();
  assert.equal(sources.hidden, true);
  requests[0].send('delta', { text: 'The project kept its original timeline.' });
  requests[0].send('done', { stopReason: 'stop' });
  requests[0].close();
  await settle();
  submit('Who owns the Atlas follow-up?');
  requests[1].send('delta', { text: 'The project owner handles the follow-up.' });
  requests[1].close();
  await settle();
  assert.deepEqual(transcript.children.map(node => text(node.querySelector('.question'))), [
    'What happened on the Atlas project?', 'Who owns the Atlas follow-up?',
  ]);
  assert.equal(text(first.querySelector('.assistant-label')), 'Zelos');
  assert.equal(ask.renderAsk({ navigate() {} }), view);
  assert.equal(view.children.at(-1), form);
  assert.deepEqual(requests.map(request => request.body), [
    { question: 'What happened on the Atlas project?' }, { question: 'Who owns the Atlas follow-up?' },
  ], 'new conversations omit an id until the server creates one');
});

test('Stop retains the partial answer and Copy excludes source labels and the stop notice', async t => {
  const { view, transcript, requests, submit } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async value => { copied = value; } },
  } });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  });
  submit('Summarize Atlas');
  requests[0].send('delta', { text: 'The current plan is' });
  await settle();
  findButton(view, 'Stop').click();
  await settle();
  const exchange = transcript.children[0];
  const answer = exchange.querySelector('.answer');
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(text(answer), 'The current plan is');
  assert.equal(answer.getAttribute('aria-busy'), 'false');
  assert.match(text(exchange.querySelector('.exchange-note-slot')), /Stopped.*as far as it got/);
  assert.equal(exchange.querySelector('.exchange-actions').hidden, false);
  assert.equal(findButton(view, 'Stop').hidden, true);
  assert.equal(findButton(view, 'Ask').disabled, false);
  // The small DOM fixture does not aggregate descendant textContent itself.
  Object.defineProperty(answer, 'textContent', { get: () => answer.children.map(text).join('') });
  findButton(exchange, 'Copy').click();
  await settle();
  assert.equal(copied, 'The current plan is');
});

test('failed questions return to the composer without replacing a newly typed question', async t => {
  const { view, field, transcript, requests, submit } = await fixture(t);
  submit('Find the Atlas decision');
  requests[0].send('error', { error: 'Please try again.' });
  requests[0].close();
  await settle();
  assert.equal(field.value, 'Find the Atlas decision');
  assert.equal(transcript.children[0].querySelector('.exchange-actions').hidden, true);
  submit('Try the Atlas decision again');
  field.value = 'My next question';
  requests[1].send('error', { error: 'Still unavailable.' });
  requests[1].close();
  await settle();
  assert.equal(field.value, 'My next question');
  assert.equal(findButton(view, 'Ask').disabled, false);
});

test('a second submit cannot overlap a saved conversation answer and Stop releases the composer', async t => {
  const { view, transcript, requests, submit } = await fixture(t);
  submit('First Atlas question');
  await settle();
  submit('Second Atlas question');
  await settle();
  assert.equal(requests.length,1);
  assert.equal(requests[0].signal.aborted, false);
  assert.equal(view.querySelector('.ask-actions').querySelector('[type="submit"]').disabled, true);
  assert.equal(findButton(view, 'Stop').hidden, false);
  requests[0].send('delta', { text: 'The first answer.' });
  await settle();
  findButton(view, 'Stop').click();
  await settle();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(text(transcript.children[0].querySelector('.answer')), 'The first answer.');
  assert.equal(findButton(view, 'Ask').disabled, false);
});

test('Ask continues the server conversation on follow-up and New conversation clears its id', async t=>{
  const {view,requests,submit}=await fixture(t);
  submit('Hello');requests[0].send('conversation',{id:'saved-thread'});requests[0].send('delta',{text:'Hello back'});requests[0].close();await settle();
  submit('Remember that');assert.equal(requests[1].body.threadId,'saved-thread');requests[1].close();await settle();
  findButton(view,'New conversation').click();submit('Start fresh');assert.equal(requests[2].body.threadId,undefined);requests[2].close();await settle();
});

test('assignment is serialized, preserves newer typing, and reports errors in the page',async t=>{
  const {view,field,requests}=await fixture(t);
  const {api}=await import('../ui/lib/api.js');let finish,calls=0;
  t.mock.method(api,'assignJob',()=>{calls++;return new Promise((resolve,reject)=>{finish=reject;});});
  field.value='Make a weekly report';findButton(view,'Assign to Zelos').click();findButton(view,'Assign to Zelos').click();
  assert.equal(calls,1);assert.equal(requests.length,0);field.value='Next thought';finish(new Error('Task queue is full.'));await settle();
  assert.equal(field.value,'Next thought');assert.match(text(view),/Task queue is full/);assert.equal(findButton(view,'Assign to Zelos').disabled,false);
});

test('new questions and followed chunks stay above the composer without overriding a reader who scrolls up', async t => {
  const { document, view, form, transcript, requests, submit } = await fixture(t);
  const scrolls = [];
  const entries = [];
  let contentBottom = 1900;
  const page = { scrollHeight: 2176 };
  document.scrollingElement = page;
  window.innerHeight = 720;
  window.scrollY = 100;
  window.scrollTo = options => {
    scrolls.push(options);
    window.scrollY = options.top;
  };
  // Layout is synthetic here; the assertions exercise real scrolling choices
  // against a 176px composer, while browser QA checks actual positioning.
  form.getBoundingClientRect = () => ({ height: 176 });
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    if (tag === 'article') {
      node.getBoundingClientRect = () => ({ bottom: contentBottom - window.scrollY });
      node.scrollIntoView = options => { entries.push(options); window.scrollY = 1200; };
    }
    return node;
  };
  submit('Show the latest Atlas decision');
  assert.deepEqual(entries, [{ block: 'center', behavior: 'auto' }]);
  assert.deepEqual(scrolls, [{ top: 1380, behavior: 'auto' }]);
  assert.equal(contentBottom - window.scrollY, window.innerHeight - 176 - 24,
    'a new exchange must remain above the sticky composer, with a reading gap');

  const answer = transcript.children[0].querySelector('.answer');
  const append = answer.appendChild.bind(answer);
  answer.appendChild = node => {
    const result = append(node);
    contentBottom += 300;
    page.scrollHeight += 300;
    return result;
  };
  // Before the chunk, the document is 76px from bottom. Afterwards it would
  // be 376px away without following: the decision must use the earlier size.
  requests[0].send('delta', { text: 'A long first part. ' });
  await settle();
  assert.equal(window.scrollY, 1680);
  assert.equal(contentBottom - window.scrollY, window.innerHeight - 176 - 24);

  window.scrollY = 800;
  const callsBeforeReading = scrolls.length;
  requests[0].send('delta', { text: 'Another long part. ' });
  await settle();
  assert.equal(window.scrollY, 800, 'streaming must not pull the reader away from earlier answers');
  assert.equal(scrolls.length, callsBeforeReading);

  window.scrollY = page.scrollHeight - window.innerHeight;
  requests[0].send('delta', { text: 'The reader returned to the bottom. ' });
  await settle();
  assert.equal(scrolls.length, callsBeforeReading + 1, 'following resumes when the reader returns');
  assert.equal(contentBottom - window.scrollY, window.innerHeight - 176 - 24);

  const callsBeforeLeaving = scrolls.length;
  view.remove();
  requests[0].send('delta', { text: 'This arrives while another view is open.' });
  requests[0].close();
  await settle();
  assert.equal(scrolls.length, callsBeforeLeaving, 'a detached Ask view must not scroll another screen');
  assert.ok(scrolls.every(options => options.behavior === 'auto'), 'streaming never forces animated movement');
});

test('copying a saved answer retains its button after the browser clears currentTarget', async t => {
  const { view } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api } = await import('../ui/lib/api.js');
  t.mock.method(api,'conversation',async()=>({messages:[{role:'user',content:'A saved question'},{role:'assistant',content:'The exact saved answer',sources:[],state:'complete'}]}));
  const history=view.querySelector('[aria-label="Conversation history"]');history.value='saved';history.fire('change');await settle();
  const copy=findButton(view,'Copy');assert.ok(copy);
  let finish;let copied;
  const prior=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{copied=value;await new Promise(resolve=>{finish=resolve;});}}}});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'navigator',prior);else delete globalThis.navigator;});
  const event={currentTarget:copy};const pending=copy.listeners.get('click')[0](event);
  event.currentTarget=null;finish();await pending;
  assert.equal(copied,'The exact saved answer');assert.match(text(copy),/Copied/);
});
