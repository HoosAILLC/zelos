import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildWebsite} from '../scripts/build-website.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-preview-test-'));
buildWebsite({root,out:output});
process.on('exit',()=>fs.rmSync(output,{recursive:true,force:true}));
import {detectRecurring,findDuplicateCandidates} from '../ui/lib/money-patterns.js';
import {balancePresentation,scopedBankSnapshot} from '../ui/lib/money-accuracy.js';
const fresh=()=>import(pathToFileURL(path.join(output,'try/lib/api.js')).href+`?test=${Math.random()}`);
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

async function moneyHistory(request) {
 const current=await request('/api/finance');
 const months=current.summary.currencies[0].months.map(value=>value.month);
 const pages=await Promise.all(months.map(month=>request('/api/finance?month='+month)));
 const rows=pages.flatMap(page=>page.transactions);
 const dates=rows.map(row=>row.date).sort();
 return {...current,transactions:rows,scope:{start:dates[0],end:dates.at(-1)}};
}
const reviewBody=(candidate,type,action,scope,extra={})=>({key:candidate.key,rowIds:candidate.rowIds,type,action,scope,...extra});
test('Money snapshot preserves unknown, zero and credit amounts and keeps pending outside posted totals and exports',async()=>{
 const {request,download}=await fresh();const history=await moneyHistory(request),bank=await request('/api/finance/plaid');
 const balances=bank.items[0].accounts;
 assert(balances.every(account=>account.balances.cached&&account.balances.retrievedAt&&account.balances.sourceUpdatedAt===null));
 const unknown=balances.find(account=>account.balances.availableCents===null);assert(unknown);assert.equal(unknown.balances.availableCents,null);
 const zero=balances.find(account=>account.mapping.accountId==='demo_reserve');assert.equal(zero.balances.currentCents,0);assert.equal(zero.balances.availableCents,0);
 const credit=balances.find(account=>account.mapping.accountId==='demo_card');assert.equal(balancePresentation('credit_card',credit.balances).label,'Amount owed');assert.equal(credit.balances.currentCents,174200);
 const scope={entities:history.entities,section:'personal',accountId:'demo_reserve',currency:'USD'};
 assert.equal(scopedBankSnapshot(bank,history.accounts,scope).balances.length,1);assert.equal(scopedBankSnapshot(bank,history.accounts,scope).pending.length,0);
 assert.equal(bank.pending.length,2);assert(bank.pending.every(pending=>!history.transactions.some(row=>row.id===pending.id)));
 const csv=await (await download('/api/finance/export')).text();for(const pending of bank.pending)assert(!csv.includes(pending.description));
 credit.balances.currentCents=0;assert.equal((await request('/api/finance/plaid')).items[0].accounts.find(account=>account.mapping.accountId==='demo_card').balances.currentCents,174200);
});
test('Money recurring confirmation is explicit, idempotent and reversible without changing recorded spending',async()=>{
 const {request}=await fresh();const before=await moneyHistory(request);
 const candidate=detectRecurring(before.transactions).find(value=>value.name==='Fable Music');assert(candidate);assert.equal(candidate.rows.length,3);
 const body=reviewBody(candidate,'recurring','confirm-recurring',before.scope);
 const {decision}=await request('/api/finance/review',{method:'POST',body});assert.equal(decision.action,'confirm-recurring');
 const repeated=await request('/api/finance/review',{method:'POST',body});assert.equal(repeated.decision.id,decision.id);
 const confirmed=await moneyHistory(request);assert(confirmed.transactions.filter(row=>candidate.rowIds.includes(row.id)).every(row=>row.category==='Recurring bill'));
 assert.equal(confirmed.summary.currencies[0].expenseCents,before.summary.currencies[0].expenseCents);
 assert.equal((await request('/api/finance/review')).decisions.length,1);
 await request('/api/finance/review',{method:'POST',body:{action:'undo',decisionId:decision.id}});
 const restored=await moneyHistory(request);assert(restored.transactions.filter(row=>candidate.rowIds.includes(row.id)).every(row=>row.category==='Entertainment'));
 assert.equal((await request('/api/finance/review')).decisions[0].undone,true);
});
test('Money duplicate evidence excludes only the chosen import and Undo restores it',async()=>{
 const {request}=await fresh();const before=await moneyHistory(request);
 const candidate=findDuplicateCandidates(before.transactions,{accounts:before.accounts}).find(value=>value.rowIds.includes('demo_duplicate_receipt'));assert(candidate);assert.equal(candidate.ambiguous,false);
 assert.deepEqual(new Set(candidate.rows.map(row=>row.importSource)),new Set(['bank','document']));
 const body=reviewBody(candidate,'duplicate','exclude-duplicate',before.scope,{excludeId:'demo_duplicate_receipt'});
 const result=await request('/api/finance/review',{method:'POST',body});
 const month=candidate.rows[0].date.slice(0,7);
 const originalTotal=before.transactions.filter(row=>row.date.startsWith(month)&&row.status!=='excluded'&&row.kind!=='transfer'&&row.amountCents<0).reduce((total,row)=>total-row.amountCents,0);
 const after=await request('/api/finance?month='+month);assert.equal(after.summary.currencies[0].expenseCents,originalTotal-3850);
 assert.equal(after.transactions.find(row=>row.id==='demo_duplicate_receipt').status,'excluded');assert.equal(after.transactions.find(row=>row.id==='demo_duplicate_bank').status,'confirmed');
 await request('/api/finance/review',{method:'POST',body});assert.equal((await request('/api/finance?month='+month)).summary.currencies[0].expenseCents,originalTotal-3850);
 await request('/api/finance/review',{method:'POST',body:{action:'undo',decisionId:result.decision.id}});assert.equal((await request('/api/finance?month='+month)).summary.currencies[0].expenseCents,originalTotal);
 const reset=await fresh();assert.deepEqual((await reset.request('/api/finance/review')).decisions,[]);
});
test('Money rejects stale evidence and refuses Undo after an intervening edit',async()=>{
 const {request}=await fresh();const before=await moneyHistory(request);
 const candidate=findDuplicateCandidates(before.transactions,{accounts:before.accounts}).find(value=>value.rowIds.includes('demo_duplicate_receipt'));
 const body=reviewBody(candidate,'duplicate','exclude-duplicate',before.scope,{excludeId:'demo_duplicate_receipt'});
 await assert.rejects(request('/api/finance/review',{method:'POST',body:{...body,excludeId:'unrelated'}}),/which of these two/);
 const {decision}=await request('/api/finance/review',{method:'POST',body});
 await request('/api/finance/transactions',{method:'POST',body:{id:'demo_duplicate_receipt',description:'Edited receipt'}});
 await assert.rejects(request('/api/finance/review',{method:'POST',body:{action:'undo',decisionId:decision.id}}),error=>error.status===409&&/changed after/.test(error.message));
 const recurring=detectRecurring(before.transactions).find(value=>value.name==='Fable Music');
 await request('/api/finance/transactions',{method:'POST',body:{id:recurring.rowIds[0],amountCents:-999999}});
 await assert.rejects(request('/api/finance/review',{method:'POST',body:reviewBody(recurring,'recurring','confirm-recurring',before.scope)}),error=>error.status===409&&/evidence changed/.test(error.message));
 const current=await moneyHistory(request);assert.equal(current.transactions.find(row=>row.id==='demo_duplicate_receipt').status,'excluded');
});
test('Family previews isolate private records, selected collaborator access and stable source snapshots',async()=>{
 const {request}=await fresh();const owner=await request('/api/family'),parent=await request('/api/family?person=jamie'),collaborator=await request('/api/family?person=sam');
 assert.equal(owner.me.id,'alex');assert(owner.records.some(row=>row.id==='family_alex_private'));assert(!owner.records.some(row=>row.id==='family_jamie_private'));
 assert.deepEqual(new Set(parent.records.map(row=>row.id)),new Set(['family_school','family_meal_snapshot','family_jamie_private']));
 assert.deepEqual(collaborator.records.map(row=>row.id),['family_task_snapshot']);assert.deepEqual(collaborator.children,[]);
 assert.equal(collaborator.grants[0].includeFuture,false);assert.equal(collaborator.grants[0].permissions.submitTasks,false);assert.equal(collaborator.grants[0].permissions.uploadDocuments,false);assert(collaborator.grants[0].expiresAt);
 for(const view of [owner,parent,collaborator]){assert.equal(view.demo.readOnly,true);assert.equal(view.permissions.manage,false);assert.equal(view.portal.ready,false);assert.deepEqual(view.credentials,[]);assert.deepEqual(view.invitations,[]);}
 const task=owner.records.find(row=>row.id==='family_task_snapshot'),plan=owner.records.find(row=>row.id==='family_meal_snapshot');
 const source=(await request('/api/state')).items.find(row=>row.id===task.source.id);assert.equal(task.title,source.headline);
 assert.equal(plan.source.id,(await request('/api/health-tracking')).plans[0].id);
 await request(`/api/items/${source.id}/correction`,{method:'POST',body:{decision:'corrected',headline:'Changed in Today'}});
 assert.equal((await request('/api/family')).records.find(row=>row.id===task.id).title,task.title);
 await assert.rejects(request('/api/family?person=unknown'),error=>error.status===404);
});
test('new preview surfaces cannot link banks, share, invite or mint credentials and all local module imports resolve',async()=>{
 const {request}=await fresh();
 for(const path of ['/api/finance/plaid/start','/api/finance/plaid/configure','/api/finance/plaid/sync','/api/finance/plaid/disconnect','/api/family/action','/api/family/snapshot','/api/family/invite','/api/family/credentials'])await assert.rejects(request(path,{method:'POST',body:{action:'invite.create'}}),/installed app/);
 for(const file of ['api.js','demo-money.js','demo-family.js','bank-link.js']){const source=fs.readFileSync(new URL('../website/try/lib/'+file,import.meta.url),'utf8');assert.doesNotMatch(source,/\bfetch\s*\(|new EventSource|new WebSocket|localStorage|sessionStorage/);}
 const family=fs.readFileSync(new URL('../website/try/views/family.js',import.meta.url),'utf8');assert.match(family,/mountFamily/);assert.doesNotMatch(family,/type:\s*['"](?:password|file)['"]|navigator\.clipboard|window\.open/);
 const app=fs.readFileSync(pathToFileURL(path.join(output,'try/app.js')),'utf8');assert.match(app,/id: 'family', label: 'Family'/);
 assert.match(fs.readFileSync(new URL('../website/try/demo.js',import.meta.url),'utf8'),/'finance','family','health'/);
 const pending=[pathToFileURL(path.join(output,'try/app.js'))],seen=new Set();
 while(pending.length){const url=pending.pop();if(seen.has(url.href))continue;seen.add(url.href);const source=fs.readFileSync(url,'utf8');for(const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){const dependency=new URL(match[1],url);assert(fs.existsSync(dependency),'Missing '+dependency.pathname);pending.push(dependency);}}
});

test('current meal discovery uses the app recipe catalog, isolated favorites and reversible choices',async()=>{
 const {request}=await fresh();const week=new Date().toISOString().slice(0,10),url='/api/shopping/meals?weekStart='+week;
 const before=await request(url);assert.equal(before.recipes.length,90);assert.match(before.note,/no live AI call/);
 const recipe=before.recipes.find(value=>value.title==='Blueberry walnut oatmeal');assert(recipe);assert(recipe.ingredients.length);assert(recipe.steps.length);
 const saved=await request('/api/shopping/meals/taste',{method:'POST',body:{recipeId:recipe.id,action:'favorite',expectedRevision:before.revision}});
 assert(saved.favorites.includes(recipe.id));
 await assert.rejects(request('/api/shopping/meals/taste',{method:'POST',body:{recipeId:recipe.id,action:'skip',expectedRevision:before.revision}}),error=>error.status===409);
 const undone=await request('/api/shopping/meals/taste',{method:'POST',body:{recipeId:recipe.id,action:'clear',expectedRevision:saved.revision}});assert(!undone.favorites.includes(recipe.id));
 const separate=await fresh();assert.deepEqual((await separate.request(url)).favorites,[]);
});

test('current weekly planner builds only selected sample meals and updates the same health grocery records',async()=>{
 const {request}=await fresh(),weekStart=new Date().toISOString().slice(0,10);
 const before=await request('/api/shopping/week?weekStart='+weekStart);assert.equal(before.week.meals.length,21);
 const library=await request('/api/shopping/meals?weekStart='+weekStart),recipe=library.recipes.find(value=>value.slot==='dinner');
 const added=await request('/api/shopping/meals/add',{method:'POST',body:{weekStart,mealId:'0-dinner',recipeId:recipe.id,expectedRevision:before.week.revision}});
 assert.equal(added.week.meals.find(value=>value.id==='0-dinner').recipeId,recipe.id);
 const built=await request('/api/shopping/week/build',{method:'POST',body:{weekStart,weekId:added.week.id,expectedRevision:added.week.revision,selectedIds:['0-dinner'],choices:{}}});
 assert.deepEqual(built.week.selectedIds,['0-dinner']);assert.match(built.notice,/No order was placed/);
 const health=await request('/api/health-tracking'),groceries=health.groceryItems.filter(value=>value.planId===added.week.id);
 assert.equal(groceries.length,built.groceryCount);assert.equal(health.plans.find(value=>value.id===added.week.id).entries.length,1);
 assert.equal(groceries.find(value=>value.name===recipe.ingredients[0].name).quantity,recipe.ingredients[0].quantity*added.week.servings+' '+recipe.ingredients[0].unit);
 const shopping=await request('/api/shopping');assert.equal(shopping.mealPlanner,true);assert(shopping.items.some(value=>value.id===groceries[0].id));
 await assert.rejects(request('/api/shopping/week/build',{method:'POST',body:{weekStart,weekId:added.week.id,expectedRevision:added.week.revision,selectedIds:[],choices:{}}}),error=>error.status===409);
 await assert.rejects(request('/api/shopping/list',{method:'POST',body:{}}),/installed app/);
});

test('generated preview cannot reach network transports and includes the current app assets and controls',()=>{
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
 for(const file of walk(path.join(output,'try')).filter(file=>file.endsWith('.js'))){
  const source=fs.readFileSync(file,'utf8');assert.doesNotMatch(source,/\bfetch\s*\(|new (?:EventSource|WebSocket|XMLHttpRequest)\b/,path.relative(output,file));
 }
 const index=fs.readFileSync(path.join(output,'try/index.html'),'utf8');assert.match(index,/meal-discovery.css/);assert.match(index,/zelos-launch-brand/);
 assert(fs.existsSync(path.join(output,'try/assets/meals/oatmeal.jpg')));assert(fs.existsSync(path.join(output,'try/lib/select.js')));
 const app=fs.readFileSync(path.join(output,'try/app.js'),'utf8');assert.match(app,/installSelects\(\)/);assert.match(app,/animateLaunch\(/);
 const store=fs.readFileSync(path.join(output,'try/lib/store.js'),'utf8');assert.match(store,/'zelos.demo.accent'/);assert.doesNotMatch(store,/'zelos.accent'/);
});


test('prepared Ask examples never substitute Northstar for a different meeting topic',async()=>{
 const {openStream}=await fresh();let answer='';await openStream('/api/ask',{body:{question:'Help me prepare for my meeting about Cedar House.'},onEvent:(event,data)=>{if(event==='delta')answer+=data.text;}});
 assert.match(answer,/Cedar House review/);assert.match(answer,/Owen/);assert.doesNotMatch(answer,/Northstar launch/);
 answer='';await openStream('/api/ask',{body:{question:'Help me prepare for a meeting about an unrelated project.'},onEvent:(event,data)=>{if(event==='delta')answer+=data.text;}});
 assert.match(answer,/prepared example answers/);assert.doesNotMatch(answer,/## Northstar/);
});

test('Health prepares an honest editable dinner example and saves the reviewed plan exactly once',async()=>{
 const {request}=await fresh(),weekStart=new Date().toISOString().slice(0,10);
 const result=await request('/api/health-tracking/plan-preview',{method:'POST',body:{weekStart,instructions:'Simple dinners for two'}});
 assert.match(result.model,/prepared example/);assert.match(result.preview.assumptions.join(' '),/not a response to your instructions/);assert.equal(result.preview.entries.length,7);
 result.preview.title='Reviewed sample dinners';result.preview.groceries.pop();
 await assert.rejects(request('/api/health-tracking/plan-save',{method:'POST',body:{preview:result.preview,reviewed:false}}),/Review/);
 const saved=await request('/api/health-tracking/plan-save',{method:'POST',body:{preview:result.preview,reviewed:true}});assert.equal(saved.saved,true);assert.equal(saved.plan.title,'Reviewed sample dinners');
 const repeated=await request('/api/health-tracking/plan-save',{method:'POST',body:{preview:result.preview,reviewed:true}});assert.equal(repeated.plan.id,saved.plan.id);
 const health=await request('/api/health-tracking');assert.equal(health.plans.filter(plan=>plan.id===saved.plan.id).length,1);
 assert.equal(health.groceryItems.filter(item=>item.planId===saved.plan.id).length,result.preview.groceries.length);
 const shopping=await request('/api/shopping');assert.equal(shopping.totals.unknownPrices,result.preview.groceries.length);
 const stale=await request('/api/health-tracking/plan-preview',{method:'POST',body:{weekStart}});
 await request('/api/health-tracking/profile',{method:'POST',body:{goals:'Changed example goal'}});
 await assert.rejects(request('/api/health-tracking/plan-save',{method:'POST',body:{preview:stale.preview,reviewed:true}}),error=>error.status===409);
});
