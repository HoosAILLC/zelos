import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const fresh=()=>import(`../website/try/lib/api.js?test=${Math.random()}`);
// Use request directly so each test owns an independent browser-memory fixture.
test('interactive preview supports completion, undo, history and new notes',async()=>{
 const {request}=await fresh();const before=await request('/api/state'),item=before.items.find(x=>x.state==='open');
 await request(`/api/items/${item.id}/state`,{method:'POST',body:{state:'done'}});
 const done=await request('/api/state');assert(done.finished.some(x=>x.id===item.id));assert(!done.items.some(x=>x.id===item.id));
 const changes=await request(`/api/items/${item.id}/history`);assert.equal(changes.entries[0].changes[0].after,'done');
 await request(`/api/items/${item.id}/state`,{method:'POST',body:{state:'open'}});assert((await request('/api/state')).items.some(x=>x.id===item.id));
 await request('/api/capture',{method:'POST',body:{text:'Remember the Northstar handoff'}});assert((await request('/api/search?q=Remember%20the%20Northstar')).results.some(x=>x.kind==='capture'));
});
test('grocery edits update list totals and health records together',async()=>{
 const {request}=await fresh();const before=await request('/api/shopping'),item=before.items.find(x=>x.state==='needed');
 await request('/api/shopping/item',{method:'POST',body:{id:item.id,state:'bought'}});
 const after=await request('/api/shopping');assert.equal(after.totals.items,before.totals.items-1);assert.equal(after.totals.estimatedMinor,before.totals.estimatedMinor-Math.round(item.estimatedCost*100));
 assert.equal((await request('/api/health-tracking')).groceryItems.find(x=>x.id===item.id).state,'bought');
});
test('finance filters and edits reconcile totals and monthly chart',async()=>{
 const {request}=await fresh();const before=await request('/api/finance'),entity=before.entities[0].id,month=before.summary.month;
 const filtered=await request('/api/finance?entityId='+entity);assert(filtered.transactions.every(x=>x.entityId===entity));
 await request('/api/finance/transactions',{method:'POST',body:{entityId:entity,date:month+'-05',amountCents:12345,currency:'USD',description:'Example income',category:'Client work',kind:'income',status:'confirmed'}});
 const after=await request('/api/finance');assert.equal(after.summary.currencies[0].incomeCents,before.summary.currencies[0].incomeCents+12345);
 assert.equal(after.summary.currencies[0].months.at(-1).incomeCents,after.summary.currencies[0].incomeCents);
 const historic=before.summary.currencies[0].months[0].month;assert((await request('/api/finance?month='+historic)).transactions.length>0);
});
test('sample conversations stream honestly, save history and support cancellation',async()=>{
 const {request,openStream}=await fresh();const events=[];await openStream('/api/ask',{body:{question:'Prepare me for Northstar'},onEvent:(event,data)=>events.push({event,data})});
 assert.equal(events.at(-1).event,'done');const text=events.filter(x=>x.event==='delta').map(x=>x.data.text).join('');assert.match(text,/no live AI call/);assert.match(text,/print quantities/);
 const thread=events.find(x=>x.event==='conversation').data.id;const saved=await request('/api/conversations/'+thread);assert.equal(saved.messages.at(-1).content,text);assert.equal(saved.messages.at(-1).state,'complete');
 const controller=new AbortController();await openStream('/api/ask',{body:{question:'What needs my attention?'},signal:controller.signal,onEvent:event=>{if(event==='delta')controller.abort();}});
 const latest=(await request('/api/conversations')).threads[0];assert.equal((await request('/api/conversations/'+latest.id)).messages.at(-1).state,'interrupted');
});
test('progress supports different weeks and exports only selected entries',async()=>{
 const {request,download}=await fresh();const current=await request('/api/progress');const prev=new Date(current.week+'T12:00:00Z');prev.setUTCDate(prev.getUTCDate()-7);
 const previous=await request('/api/progress?week='+prev.toISOString().slice(0,10));assert.notEqual(previous.week,current.week);assert(previous.entries.length>0);
 const entry=current.entries[0];const pdf=await download('/api/progress/pdf',{body:{week:current.week,selectedIds:[entry.id],includeTitles:true,title:'My sample report'}});assert.equal(pdf.type,'application/pdf');const bytes=await pdf.text();assert.match(bytes,/%PDF-1.4/);assert.match(bytes,/1 selected completed items/);
});
test('external actions are blocked and demo transport has no network or persistence',async()=>{
 const {request}=await fresh();for(const path of ['/api/mail/send','/api/secrets','/api/documents/preview','/api/shopping/list','/api/mail/oauth'])await assert.rejects(request(path,{method:'POST',body:{}}),/installed app/);
 const source=fs.readFileSync(new URL('../website/try/lib/api.js',import.meta.url),'utf8');assert.doesNotMatch(source,/\bfetch\s*\(|new EventSource|new WebSocket|localStorage|sessionStorage/);
 const sample=fs.readFileSync(new URL('../website/try/lib/sample-data.js',import.meta.url),'utf8');assert.doesNotMatch(sample,/\/Users\/|\/private\/|ebe25ca50874/);
});
