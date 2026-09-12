/**
 * ui/views/ask.js — a question against your own index.
 *
 * The answer is streamed from POST /api/ask, which grounds it in FTS5 hits over
 * your mail, calendar, items and notes. The sources arrive first, as their own
 * SSE event, and they are rendered before a single token of the answer — so what
 * the model was allowed to look at is visible whether or not you like what it
 * said.
 *
 * This view owns a persistent root node. A sweep finishing mid-answer must not
 * re-render the transcript out from under a stream that is still running.
 *
 * An answer in progress can be stopped, and stopping keeps every word that had
 * already arrived — a long answer going the wrong way is a thing you interrupt,
 * not a thing you throw away. A question that failed goes back into the field
 * for the same reason: the retry is the point, and retyping it is not.
 */

import { el, button, copyText, focusQuietly } from '../lib/dom.js';
import { emptyState } from '../lib/items.js';
import { openStream, ApiError, api } from '../lib/api.js';
import { state } from '../lib/store.js';
import { recoverAnswer } from '../lib/answer-recovery.js';
import { renderMarkdown, markdownText } from '../lib/markdown.js';
import { icon } from '../lib/icons.js';

let root = null;
let welcome = null;
let transcript = null;
let form = null;
let field = null;
let askButton = null;
let stopButton = null;
let controller = null;
let navigateTo = null;
/** What Stop does right now, or null when nothing is streaming. */
let stopCurrent = null;
let threadId = null, historySelect, newChatButton, historyLoading = false;
let conversationLoading=false, conversationRequest=0, assignButton, assignNote, assigning=false;
let webMode, webDetails, webPageField, webQueryField, webSetup, webKeyField, webStatus, webSaveButton, webModelLabel;
let conversationTimer=null;
const rememberedKey='zelos.demo.ask.active';
function remember(value){try{sessionStorage.setItem(rememberedKey,JSON.stringify(value));}catch{}}
let webConfigured = false, webSettingsLoaded = false, webSettingsLoading = false, webSaving = false, webRevision = 0;
let webPopover, webTrigger, webChip, webChipLabel, webChoices=[];
async function loadThreads() {
  if(historyLoading || typeof api?.conversations !== 'function')return;
  historyLoading=true;
  try {
    const {threads}=await api.conversations();
    historySelect.replaceChildren(el('option',{value:'',text:'New conversation'}),...threads.map(thread=>el('option',{value:thread.id,text:thread.title})));
    historySelect.value=threadId||'';
  } catch { /* Current conversation stays usable if the list cannot refresh. */ }
  finally { historyLoading=false; }
}
async function showConversation(id) {
  if(controller || assigning)return;
  clearTimeout(conversationTimer);remember({threadId:id||null});
  if (webMode) { webMode.value = 'off'; webPageField.value = ''; webQueryField.value = ''; webKeyField.value = ''; webRevision++; refreshWebControls();showWebOptions(false); }
  const request=++conversationRequest;
  threadId=id||null;transcript.replaceChildren();welcome.hidden=!!id;root.classList.toggle('has-conversation',!!id);
  conversationLoading=!!id;
  historySelect.disabled=!!id;askButton.disabled=!!id;assignButton.disabled=!!id;
  if(!id)return;
  try {
    const data=await api.conversation(id);
    if(request!==conversationRequest)return;
    let item=null;
    let pending=false;
    for(const message of data.messages){
      if(message.role==='user'){item=exchange(message.content);transcript.appendChild(item.node);}
      else if(item){renderMarkdown(item.answer,message.content||'No completed answer was saved.');item.answer.setAttribute('aria-busy','false');item.actions.hidden=!message.content;
        const sources=sourceList(message.sources||[]);if(sources)item.sourcesSlot.appendChild(sources);
        if(message.state!=='complete')item.noteSlot.appendChild(el('p',{class:'exchange-note',text:message.state==='streaming'?'Still answering on your Spark. This page will update automatically.':'This answer was interrupted. The saved text is shown above.'}));
        if(message.state==='streaming'){pending=true;item.noteSlot.appendChild(button('Stop this answer',{class:'btn quiet',onClick:async()=>{await api.stopAnswer(message.id);showConversation(id);}}));}}
    }
    if(pending)conversationTimer=setTimeout(()=>{if(request===conversationRequest && !controller)showConversation(id);},4000);
  }catch(error){if(request===conversationRequest)transcript.appendChild(el('p',{class:'quiet-note',text:error.message}));}
  finally{if(request===conversationRequest){conversationLoading=false;historySelect.disabled=false;askButton.disabled=false;assignButton.disabled=false;}}
}

const KIND_LABEL = { message: 'mail', event: 'calendar', item: 'board', capture: 'note', health: 'Health', money:'Money',progress:'Progress',document:'Imports',library:'Saved records', web: 'web' };

function webLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value) ? url.href : null;
  } catch { return null; }
}
function webDate(source) {
  const formatted = value => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  };
  const date = formatted(source.date), fetched = formatted(source.fetchedAt);
  const label = { published: 'Published', modified: 'Updated', published_or_modified: 'Published or updated' }[source.dateKind] || 'Source date';
  return [date ? `${label} ${date}` : 'Source date not provided', fetched ? `Retrieved ${fetched}` : ''].filter(Boolean).join(' · ');
}

function refreshWebControls() {
  const mode = webMode.value;
  webDetails.hidden = mode === 'off';
  webPageField.hidden = mode !== 'page'; webQueryField.hidden = mode !== 'search';
  webPageField.disabled = mode !== 'page'; webQueryField.disabled = mode !== 'search';
  webSetup.hidden = mode !== 'search' || webConfigured || !webSettingsLoaded;
  webChip.hidden=mode==='off';webChip.dataset.mode=mode;
  webChipLabel.textContent=mode==='page'?'Public page':'Web search';
  webChoices.forEach(({value,control})=>control.setAttribute('aria-pressed',String(value===mode)));
}
function showWebOptions(open){
  webPopover.hidden=!open;webTrigger.setAttribute('aria-expanded',String(open));
}
function webMessage(message) { webStatus.textContent = message; webStatus.hidden = !message; }
async function loadWebSettings() {
  if (webSettingsLoading) return;
  webSettingsLoading = true; webMessage('Checking web search setup…');
  try {
    const settings = await api.webSettings(); webConfigured = settings.searchConfigured === true;
    webSettingsLoaded = true;
    webMessage(webConfigured ? 'Brave Search is connected. Only your entered search query is shared.' : 'Add a Brave Search API key to search. Public page reading works without a key.');
  } catch (error) { webSettingsLoaded = true; webMessage(error.message || 'Search setup could not be checked.'); }
  finally { webSettingsLoading = false; refreshWebControls(); }
}
function buildWebControls() {
  webMode = {value:'off'};
  function choose(value){
    webMode.value=value;webRevision++;webMessage('');refreshWebControls();
    if(value==='off'){showWebOptions(false);focusQuietly(field);return;}
    showWebOptions(true);focusQuietly(value==='page'?webPageField:webQueryField);
    if(value==='search'&&!webSettingsLoaded)loadWebSettings();
  }
  webPageField = el('input', { class: 'input ask-web-url', type: 'url', placeholder: 'https://…', maxlength: '4096',
    'aria-label': 'Public URL to read', autocomplete: 'off', spellcheck: 'false', hidden: true, disabled: true });
  webQueryField = el('input', { class: 'input ask-web-query', type: 'text', placeholder: 'Enter exactly what to search for…', maxlength: '600',
    'aria-label': 'Query sent to Brave Search', autocomplete: 'off', hidden: true, disabled: true });
  for (const input of [webPageField, webQueryField]) input.addEventListener('input', () => { webRevision++; webMessage(''); });
  webStatus = el('p', { class: 'ask-web-status', role: 'status', hidden: true });
  webKeyField = el('input', { class: 'input ask-web-key', type: 'password', placeholder: 'Brave Search API key',
    'aria-label': 'Brave Search API key', autocomplete: 'new-password', spellcheck: 'false' });
  webSaveButton = button('Save search key', { class: 'btn quiet', onClick: async () => {
    if (webSaving) return;
    const apiKey = webKeyField.value.trim();
    if (!apiKey) { webMessage('Enter your Brave Search API key.'); webKeyField.focus(); return; }
    webSaving = true; webSaveButton.disabled = true;
    try {
      const settings = await api.saveWebSettings({ apiKey });
      webKeyField.value = ''; webConfigured = settings.searchConfigured === true; webSettingsLoaded = true;
      webMessage(webConfigured ? 'Search key saved on your Spark. Enter a query, then choose Ask.' : 'The key was saved. Check search setup before trying again.');
    } catch (error) { webMessage(error.message || 'The search key could not be saved.'); }
    finally { webSaving = false; webSaveButton.disabled = false; refreshWebControls(); }
  } });
  webSetup = el('div', { class: 'ask-web-setup', hidden: true }, [
    el('p', { text: 'Connect your own Brave Search key. It is saved in the Spark’s secret store and never sent to the AI.' }),
    el('a', { href: 'https://api-dashboard.search.brave.com/app/keys', target: '_blank', rel: 'noopener noreferrer', text: 'Get a Brave Search API key ↗' }),
    el('div', { class: 'ask-web-key-row' }, [webKeyField, webSaveButton]),
  ]);
  webDetails = el('div', { class: 'ask-web-details', hidden: true }, [
    webPageField, webQueryField,
    el('p', { class: 'ask-web-privacy', text: 'Only the lookup entered here goes to the website or search provider. Your chat and private records are not included in that web request.' }),
    webStatus, webSetup,
  ]);
  webChoices=[['page','Read a public page','documents'],['search','Search the web','search']].map(([value,label,glyph])=>({value,
    control:button([icon(glyph),el('span',{text:label})],{class:'ask-context-option','aria-label':label,'aria-pressed':'false',onClick:()=>choose(value)})}));
  webTrigger=button(icon('plus'),{class:'ask-context-trigger','aria-label':'Add context',title:'Add context','aria-expanded':'false','aria-controls':'ask-context-options',onClick:()=>{
    showWebOptions(webPopover.hidden);if(!webPopover.hidden)focusQuietly(webChoices[0].control);
  }});
  webChipLabel=el('span');
  webChip=el('div',{class:'ask-web-chip',hidden:true,dataset:{mode:'off'}},[
    button(webChipLabel,{class:'ask-context-chip-label','aria-label':'Edit web lookup',onClick:()=>{showWebOptions(true);focusQuietly(webMode.value==='page'?webPageField:webQueryField);}}),
    button('×',{class:'ask-context-remove','aria-label':'Remove web lookup',onClick:()=>choose('off')}),
  ]);
  webPopover=el('div',{class:'ask-context-popover',id:'ask-context-options',hidden:true,role:'group','aria-label':'Add context'},[
    el('div',{class:'ask-context-heading'},[el('strong',{text:'Add context'}),button('×',{class:'ask-context-close','aria-label':'Close context options',onClick:()=>{showWebOptions(false);focusQuietly(webTrigger);}})]),
    el('div',{class:'ask-context-choices'},webChoices.map(c=>c.control)),webDetails,
  ]);
  webPopover.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();showWebOptions(false);focusQuietly(webTrigger);}});
  document.addEventListener('pointerdown',event=>{if(!webPopover.hidden&&!webPopover.contains(event.target)&&!webTrigger.contains(event.target)&&!webChip.contains(event.target))showWebOptions(false);});
  webModelLabel = el('span', { class: 'ask-web-local' });
  return el('div',{class:'ask-composer-tools'},[webTrigger,webChip,webModelLabel,webPopover]);
}
function chosenWebLookup() {
  if (webMode.value === 'off') return null;
  if (webMode.value === 'page') {
    const url = webPageField.value.trim();
    if (!webLink(url)) throw new Error('Enter a public http:// or https:// URL without sign-in credentials.');
    return { mode: 'page', url };
  }
  if (webMode.value === 'search') {
    if (!webConfigured) throw new Error(webSettingsLoading ? 'Wait for the search setup check.' : 'Save a Brave Search key before searching.');
    const query = webQueryField.value.trim();
    if (!query || query.length > 600 || query.split(/\s+/).length > 75) throw new Error('Enter a separate search query, up to 600 characters and 75 words.');
    return { mode: 'search', query };
  }
  throw new Error('Choose a web lookup option.');
}

/** Read before a chunk changes the page height, so scrolling up opts out. */
function nearDocumentBottom() {
  if (!root?.isConnected) return false;
  const page = document.scrollingElement || document.documentElement;
  const top = window.scrollY ?? page.scrollTop;
  const height = window.innerHeight;
  return Number.isFinite(top) && Number.isFinite(height) && height > 0
    && Number.isFinite(page.scrollHeight) && page.scrollHeight - top - height <= 96;
}

/** Leave the latest text above the sticky composer, including its phone size. */
function revealEnd(node) {
  if (!root?.isConnected) return;
  const bottom = node.getBoundingClientRect?.().bottom;
  const composerHeight = form.getBoundingClientRect?.().height || 0;
  const covered = bottom - (window.innerHeight - composerHeight - 24);
  if (Number.isFinite(covered) && covered > 0) {
    window.scrollTo?.({ top: (window.scrollY || 0) + covered, behavior: 'auto' });
  }
}

function sourceList(sources) {
  if (!sources.length) return null;
  const list = el('ul', { class: 'sources-list', hidden: true }, sources.map((s) => {
    const destination=typeof s.ref==='string' && s.ref.startsWith(`${s.kind}:`) ? {health:'#/health',money:'#/finance',progress:'#/progress',document:'#/documents'}[s.kind] : null;
    const health = s.kind === 'health' && typeof s.ref === 'string' && s.ref.startsWith('health:');
    return el('li', { class: 'source' }, [
      el('span', { class: 'source-kind mono', text: KIND_LABEL[s.kind] || s.kind || 'source' }),
      destination ? el('a', { class: 'source-title', href: destination, text: s.title || s.ref }) :
      s.kind === 'web' && webLink(s.url) ? el('a', { class: 'source-title source-web-link', href: webLink(s.url), target: '_blank',
        rel: 'noreferrer noopener', text: s.title || s.ref || 'Web source' }) : el('span', { class: 'source-title', text: s.title || s.ref }),
      destination ? el('span', { class: 'source-excerpt source-ref mono', text: s.ref }) : null,
      s.kind === 'web' ? el('span', { class: 'source-web-date', text: `${s.ref ? `${s.ref} · ` : ''}${webDate(s)}` }) : null,
      s.sourceInactive ? el('span', { class: 'source-excerpt', text: 'No longer in task selection' }) : null,
      s.excerpt ? el('span', { class: 'source-excerpt', text: s.excerpt }) : null,
    ]);
  }));
  const toggle = button(`${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`, {
    class: 'btn quiet sources-toggle',
    'aria-expanded': 'false',
    onClick: () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      list.hidden = open;
    },
  });
  return el('div', { class: 'sources' }, [toggle, list]);
}

/**
 * One question and its answer. The copy button is built with the exchange but
 * stays hidden until there is something to copy: an affordance offered over an
 * empty answer copies an empty string, which is worse than not offering it.
 */
function exchange(question) {
  const answer = el('div', { class: 'answer', 'aria-live': 'polite', 'aria-busy': 'true' });
  const sourcesSlot = el('div', { class: 'sources-slot' });
  const copyButton = button('Copy', {
    class: 'btn quiet',
    onClick: async (e) => {
      const btn = e.currentTarget;
      const ok = await copyText(markdownText(answer));
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1_600);
    },
  });
  const actions = el('div', { class: 'exchange-actions', hidden: true }, [copyButton]);
  // Anything said ABOUT the answer sits outside it, so Copy hands over what the
  // model wrote and nothing else.
  const noteSlot = el('div', { class: 'exchange-note-slot' });
  const node = el('article', { class: 'exchange' }, [
    el('p', { class: 'question' }, [
      el('span', { class: 'question-text', text: question }),
    ]),
    el('div', { class: 'assistant-message' }, [
      el('p', { class: 'assistant-label', text: 'Zelos' }),
      sourcesSlot,
      answer,
      noteSlot,
      actions,
    ]),
  ]);
  return { node, answer, sourcesSlot, actions, noteSlot };
}

/**
 * Ask, and stream the answer in.
 *
 * Two pieces of bookkeeping here are load-bearing. The controller is compared
 * by identity before anything is cleaned up, because a question asked while a
 * previous one is still streaming leaves two of these running: the older one's
 * `finally` would otherwise re-enable the form and null out the controller
 * belonging to the answer still arriving, leaving Stop pointing at nothing.
 * And the question is put back in the field if the exchange failed — losing
 * what you typed because the model was misconfigured means typing it again to
 * find out whether the fix worked.
 */
async function ask(question, web = null, retryRevision = webRevision) {
  if (controller) controller.abort();
  const mine = new AbortController();
  controller = mine;
  let stoppedByUser = false, stopConfirmed = null;
  let failed = false,answerId=null,streamDone=false,needsRecovery=false;
  const requestId=globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return(c==='x'?r:(r&3)|8).toString(16);});
  remember({requestId,threadId});

  const { node, answer, sourcesSlot, actions, noteSlot } = exchange(question);
  welcome.hidden = true;
  root.classList.add('has-conversation');
  transcript.appendChild(node);
  answer.textContent = 'Thinking…';
  answer.classList.add('is-waiting');
  askButton.disabled = true;
  assignButton.disabled = true;
  historySelect.disabled = true; newChatButton.disabled = true;
  askButton.textContent = 'Answering…';
  stopButton.hidden = false;
  stopCurrent = () => {
    stoppedByUser = true;
    stopConfirmed = (async()=>{
      try {
        const id=answerId || (await api.askRequest(requestId)).answerId;
        await api.stopAnswer(id);return true;
      } catch {return false;}
    })();
    mine.abort();
  };
  // A new question is an explicit navigation to its exchange. Subsequent
  // chunks follow only while the reader remains at the bottom of the page.
  if (root.isConnected) {
    node.scrollIntoView({ block: 'center', behavior: 'auto' });
    revealEnd(node);
  }

  // `started` is "the placeholder is gone"; `gotAnswer` is "the model actually
  // said something". They differ on the run that produces nothing but an error
  // message, which is written into the answer but is not an answer — there is
  // nothing there worth a Copy button, and the question is worth keeping.
  let started = false;
  let gotAnswer = false;
  let rawAnswer='';
  const write = (text) => {
    const follow = controller === mine && nearDocumentBottom();
    if (!started) {
      answer.textContent = '';
      answer.classList.remove('is-waiting');
      started = true;
    }
    rawAnswer+=text;renderMarkdown(answer,rawAnswer);
    if (follow) revealEnd(node);
  };

  async function recover(){
    if(typeof api?.askRequest!=='function')return false;
    noteSlot.replaceChildren(el('p',{class:'exchange-note',text:'Reconnecting to the answer saved on your Spark…'}));
    const saved=await recoverAnswer({requestId,threadId,answerId,api,signal:mine.signal,onUpdate:message=>{
      if(controller!==mine)return;threadId=message.threadId;answerId=message.id;remember({requestId,threadId,answerId});
      answer.classList.remove('is-waiting','is-bad');rawAnswer=message.content||'';renderMarkdown(answer,rawAnswer||'Still thinking on your Spark…');
      gotAnswer=!!message.content;started=!!message.content;sourcesSlot.replaceChildren();const sources=sourceList(message.sources||[]);if(sources)sourcesSlot.appendChild(sources);
    }});
    noteSlot.replaceChildren(el('p',{class:'exchange-note',text:saved.state==='complete'?'Reconnected. Your saved answer is complete.':'The answer was interrupted on your Spark. The saved text is shown above.'}));
    failed=saved.state!=='complete';streamDone=true;return true;
  }
  try {
    await openStream('/api/ask', {
      method: 'POST',
      body: { question, requestId, continueOnDisconnect:true, ...(threadId ? {threadId} : {}), ...(web ? { web } : {}) },
      signal: mine.signal,
      onEvent(event, data) {
        if (event === 'conversation' && controller === mine) { threadId=data.id;answerId=data.answerId;remember({requestId,threadId,answerId}); loadThreads(); }
        else if(event==='recover'){needsRecovery=true;}
        else if(event==='done'){streamDone=true;if(data?.stopReason==='length')noteSlot.appendChild(el('p',{class:'exchange-note',text:'The AI reached its answer limit, so this reply may be incomplete. Try a narrower question.'}));}
        else if (event === 'sources') {
          sourcesSlot.replaceChildren();
          const list = sourceList(Array.isArray(data) ? data : []);
          if (list) sourcesSlot.appendChild(list);
        } else if (event === 'delta') {
          gotAnswer = true;
          write(String(data?.text ?? ''));
        } else if (event === 'error') {
          failed = true;
          write(`\n\n${String(data?.error || 'the AI stopped answering')}`);
          answer.classList.add('is-bad');
        }
      },
    });
    if((needsRecovery || !streamDone) && !failed && !stoppedByUser)await recover();
    if (!started) {
      answer.textContent = 'The AI returned nothing.';
      answer.classList.remove('is-waiting');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      let recovered=false;
      if(!stoppedByUser && (!err.status || err.status>=500)){
        try{recovered=await recover();}catch(recoveryError){if(recoveryError.name==='AbortError')return;}
      }
      if(recovered)return;
      failed = true;
      answer.classList.remove('is-waiting');
      answer.classList.add('is-bad');
      if(!gotAnswer)answer.textContent = err instanceof ApiError && err.status === 409 && /model.*configured|no.*model/i.test(err.message)
        ? 'No AI has been chosen yet. Pick one under Settings → AI and ask again.'
        : err.message;
      if(gotAnswer)noteSlot.replaceChildren(el('p',{class:'exchange-note',text:'Connection interrupted. Your saved answer is kept on your Spark.'}));
      if(threadId)noteSlot.appendChild(button('Recover saved answer',{class:'btn quiet',onClick:()=>showConversation(threadId)}));
    }
  } finally {
    const follow = controller === mine && nearDocumentBottom();
    // A stop keeps every word that had already arrived — that is the whole
    // point of stopping rather than asking something else — and says so, so a
    // half-finished paragraph is not mistaken for the model's whole answer.
    if (stoppedByUser) {
      answer.classList.remove('is-waiting');
      if (!await stopConfirmed) {
        if(!gotAnswer)answer.textContent='The connection was stopped on this device.';
        noteSlot.appendChild(el('p',{class:'exchange-note',text:'Could not confirm Stop on your Spark. Reopen this conversation when connected to stop or recover the saved answer.'}));
      } else if (gotAnswer) {
        noteSlot.appendChild(el('p', { class: 'exchange-note mono', text: 'Stopped — this is as far as it got.' }));
      } else {
        answer.textContent = 'Stopped before the AI said anything.';
      }
    }
    answer.setAttribute('aria-busy', 'false');
    actions.hidden = !gotAnswer;
    // Only the stream that is actually current may hand the form back. An older
    // one finishing its abort must not re-enable Ask under a live answer.
    if (controller === mine) {
      controller = null;
      stopCurrent = null;
      stopButton.hidden = true;
      askButton.disabled = false;
      assignButton.disabled = false;
      historySelect.disabled = false; newChatButton.disabled = false; loadThreads();
      askButton.textContent = 'Ask';
      // The field was cleared when the question went out. If nothing came back,
      // it goes back in — unless the user has already typed the next question,
      // which is theirs and must not be overwritten.
      if (failed && !gotAnswer && !field.value.trim()) {
        field.value = question;
        // Restore only this failed turn's explicit lookup. New composer edits own their settings.
        if (web && webRevision === retryRevision && webMode.value === 'off') {
          webMode.value = web.mode;
          if (web.mode === 'page') webPageField.value = web.url; else webQueryField.value = web.query;
          refreshWebControls();
        }
      }
    }
    if (follow) revealEnd(node);
  }
}

function build() {
  field = el('textarea', {
    class: 'ask-field',
    rows: '2',
    placeholder: 'Ask anything, or describe work for Zelos…',
    'aria-label': 'Your question',
  });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  field.addEventListener('input',()=>{field.style.height='auto';field.style.height=`${Math.min(180,Math.max(76,field.scrollHeight||76))}px`;});

  askButton = el('button', { type: 'submit', class: 'btn solid', text: 'Ask' });

  // One Stop button for the page, not one per exchange: only one answer streams
  // at a time, and a row of dead Stop buttons down the transcript would be a
  // control that means nothing everywhere except the current exchange.
  stopButton = button('Stop', {
    class: 'btn quiet',
    hidden: true,
    onClick: () => { if (stopCurrent) stopCurrent(); },
  });

  assignNote=el('p',{class:'quiet-note',role:'status',hidden:true});
  assignButton=button('Assign to Zelos',{class:'btn quiet',onClick:async()=>{
    const prompt=field.value.trim();
    if(!prompt||controller||assigning||conversationLoading)return;
    if (webMode.value !== 'off') { assignNote.textContent = 'Choose Ask for this web lookup, or turn web off to assign a task.'; assignNote.hidden = false; return; }
    assigning=true;assignButton.disabled=true;askButton.disabled=true;newChatButton.disabled=true;historySelect.disabled=true;assignNote.hidden=true;
    try{await api.assignJob(prompt);if(field.value.trim()===prompt)field.value='';navigateTo('#/jobs');}
    catch(error){assignNote.textContent=error.message;assignNote.hidden=false;}
    finally{assigning=false;assignButton.disabled=false;askButton.disabled=false;newChatButton.disabled=false;historySelect.disabled=false;}
  }});

  const tools=buildWebControls();
  form = el('form', { class: 'ask-form', 'aria-label': 'Ask Zelos' }, [el('div',{class:'ask-composer'},[
    field,
    el('div', { class: 'ask-actions' }, [
      tools,
      assignButton,
      askButton,
      stopButton,
    ]),
  ]),
    assignNote,
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = field.value.trim();
    if (!question || assigning || conversationLoading || controller) return;
    let web;
    try { web = chosenWebLookup(); }
    catch (error) { webMessage(error.message);showWebOptions(true);return; }
    field.value = '';field.style.height='';
    webMode.value = 'off'; refreshWebControls();showWebOptions(false);
    ask(question, web, webRevision);
  });

  transcript = el('div', { class: 'transcript', role: 'region', 'aria-label': 'Questions and answers' });

  const suggestions = [
    { label: 'Summarize a project', question: 'Summarize the latest updates about ' },
    { label: 'Find a decision', question: 'What was decided about ' },
    { label: 'Prepare for a meeting', question: 'Help me prepare for my meeting about ' },
  ];
  welcome = el('div', { class: 'ask-welcome' }, [
    el('h1', { class: 'ask-title', text: 'What would you like to know?' }),
    el('p', { class: 'ask-lede', text: 'Ask a question, think through an idea, or work with your private records. Assign a task when you want Zelos to carry out work.' }),
    el('div', { class: 'ask-suggestions' }, suggestions.map(({ label, question }) => button(label, {
      class: 'btn quiet ask-suggestion',
      onClick: () => {
        field.value = question;
        focusQuietly(field);
        field.setSelectionRange?.(question.length, question.length);
      },
    }))),
  ]);

  historySelect=el('select',{class:'input','aria-label':'Conversation history'});
  historySelect.addEventListener('change',()=>showConversation(historySelect.value));
  newChatButton=button('New chat',{class:'btn quiet','aria-label':'New conversation',onClick:()=>{showConversation(null);historySelect.value='';field.focus();}});
  root = el('div', { class: 'view view-ask' }, [
    el('div',{class:'ask-history'},[historySelect,newChatButton]),
    welcome,
    transcript,
    form,
  ]);
  loadThreads();
  try{
    const saved=JSON.parse(sessionStorage.getItem(rememberedKey)||'null');
    if(saved?.threadId)showConversation(saved.threadId);
    else if(saved?.requestId && typeof api?.askRequest==='function')api.askRequest(saved.requestId).then(info=>showConversation(info.id)).catch(()=>{});
  }catch{}
  window.addEventListener?.('online',()=>{if(root?.isConnected && threadId && !controller)showConversation(threadId);});
  document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='visible' && root?.isConnected && threadId && !controller)showConversation(threadId);});
}

export function renderAsk(ctx) {
  navigateTo = ctx.navigate;
  if (!root) build();
  webModelLabel.textContent = state.health?.model?.local === true ? 'Local AI' : 'Selected AI';
  webModelLabel.setAttribute('title',state.health?.model?.label||'Your selected AI');

  if (!state.health?.model?.configured) {
    return el('div', { class: 'view view-ask' }, emptyState({
      title: 'Ask needs an AI',
      detail: 'Ask general questions and work with your private records using the AI you choose. Choose an AI to get started.',
      action: button('Choose an AI', { class: 'btn solid', onClick: () => navigateTo('#/settings/model') }),
    }));
  }
  return root;
}
