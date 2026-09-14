import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installDom,TestNode,findButton,text,settle } from './helpers/ui-dom.mjs';
import * as health from '../core/health.mjs';
let fixtureId=0;
async function fixture(t){
 const document=installDom(t);const windowEvents=new Map();window.addEventListener=(name,handler)=>windowEvents.set(name,[...(windowEvents.get(name)||[]),handler]);
 const beforeUnload=()=>{const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};for(const handler of windowEvents.get('beforeunload')||[])handler(event);return event;};
 const original=Object.getOwnPropertyDescriptor(TestNode.prototype,'insertBefore');
 TestNode.prototype.insertBefore=function(node,before){const index=this.children.indexOf(before);if(index<0)return this.appendChild(node);node.parentNode=this;this.children.splice(index,0,node);return node;};
 t.after(()=>{if(original)Object.defineProperty(TestNode.prototype,'insertBefore',original);else delete TestNode.prototype.insertBefore;});
 const db=new DatabaseSync(':memory:');health.migrateHealth(db);t.after(()=>db.close());
 const {api}=await import('../ui/lib/api.js');const calls=[];const handlers={
  generateHealthPlan:()=>{throw new Error('No synthetic plan configured');},saveHealthPlanPreview:()=>{throw new Error('No synthetic save configured');},
  healthTracking:()=>health.getHealth(db),saveHealthProfile:value=>health.saveProfile(db,value),saveHealthWalking:value=>health.saveWalking(db,value),
  importHealthWalking:value=>health.importWalking(db,value),saveHealthLab:value=>health.saveLab(db,value),saveHealthMetric:value=>health.saveMetric(db,value),
  saveHealthPlan:value=>health.savePlan(db,value),setHealthPlanEntryState:value=>health.setPlanEntryState(db,value),saveHealthGrocery:value=>health.saveGroceryItem(db,value),deleteHealthRecord:value=>health.deleteHealthRecord(db,value),
 };
 const descriptors=Object.fromEntries(Object.keys(handlers).map(name=>[name,Object.getOwnPropertyDescriptor(api,name)]));
 for(const name of Object.keys(handlers))api[name]=async(value,options)=>{calls.push({name,value,options});return handlers[name](value,options);};
 t.after(()=>{for(const [name,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(api,name,descriptor);else delete api[name];}});
 const viewModule=await import(`../ui/views/health.js?fixture=${++fixtureId}`);const ctx={tz:'America/Indiana/Indianapolis'};
 const view=document.body.appendChild(viewModule.renderHealth(ctx));await settle();
 const control=label=>view.querySelector(`[aria-label="${label}"]`);
 const input=(label,value)=>{const node=control(label);assert.ok(node,label);node.value=String(value);node.fire(node.tag==='select'?'change':'input');return node;};
 const click=async label=>{const node=findButton(view,label);assert.ok(node,label);node.click();await settle();};
 return {view,viewModule,ctx,db,document,calls,handlers,input,control,click,beforeUnload};
}

test('profile editing survives navigation and background renders, and saves only health preferences',async t=>{
 const {view,viewModule,ctx,db,input,control,click,calls}=await fixture(t);
 await click('Goals & preferences');const goals=input('Health goals','Build a consistent routine');input('Food allergies and foods to avoid','Peanuts');input('Weekly grocery budget','80');
 await click('Lab results');await click('Goals & preferences');
 assert.equal(control('Health goals'),goals);assert.equal(goals.value,'Build a consistent routine');
 assert.equal(viewModule.renderHealth({...ctx,rev:500}),view);assert.equal(goals.value,'Build a consistent routine');
 await click('Save preferences');assert.equal(health.getHealth(db).profile.allergies,'Peanuts');assert.equal(health.getHealth(db).profile.weeklyBudget,80);
 assert.equal(calls.filter(call=>call.name==='saveHealthProfile').length,1);assert.match(text(view),/Saved in Zelos/);
});
test('returning from Imports opens the requested Health section, refreshes records and keeps dirty preferences',async t=>{
 const f=await fixture(t);await f.click('Goals & preferences');f.input('Health goals','Keep this unfinished goal');
 f.view.remove();health.saveLab(f.db,{date:'2026-09-11',name:'Imported observation',value:'Recorded as printed',unit:'unit'});
 f.document.body.appendChild(f.viewModule.renderHealth({...f.ctx,sub:'labs'}));await settle();
 assert.match(text(f.view),/Imported observation/);assert.equal(findButton(f.view,'Lab results').getAttribute('aria-pressed'),'true');
 await f.click('Goals & preferences');assert.equal(f.control('Health goals').value,'Keep this unfinished goal');
 f.viewModule.renderHealth({...f.ctx,sub:'labs',rev:100});assert.equal(findButton(f.view,'Goals & preferences').getAttribute('aria-pressed'),'true','A background render does not force the original deep link again');
 assert.equal(f.calls.filter(call=>call.name==='saveHealthProfile').length,0);
});
test('walking and measurement forms support saves, edits, CSV import and chart history',async t=>{
 const {view,db,input,click}=await fixture(t);await click('Walking & measurements');
 input('Walking date','2026-09-10');input('Steps','5000');input('Distance','2');input('Distance unit','mi');await click('Save walking');
 assert.equal(health.getHealth(db).walking[0].distanceKm,3.218688);input('Steps','5100');await click('Save walking');assert.equal(health.getHealth(db).walking.length,1);assert.equal(health.getHealth(db).walking[0].steps,5100);
 input('Measurement date','2026-09-10');input('Measurement','sleep');input('Measurement value','7.5');await click('Save measurement');assert.equal(health.getHealth(db).metrics[0].unit,'hours');
 input('Walking CSV','date,steps,distance,distance_unit\n2026-09-11,6000,4,km');await click('Import CSV');assert.equal(health.getHealth(db).walking.length,2);
 await click('Overview');assert.ok(view.querySelectorAll('.health-chart').length>=3);assert.match(text(view),/6000 steps/);assert.match(text(view),/7.5 hours/);
});

test('walking CSV file failures keep the existing draft and present a recoverable error',async t=>{
  const f=await fixture(t);await f.click('Walking & measurements');f.input('Walking CSV','Keep my pasted rows');
  const file=f.control('Choose walking CSV');file.files=[{name:'unreadable.csv',size:300,text:async()=>{throw new Error('File is unavailable');}}];
  await assert.doesNotReject(()=>file.listeners.get('change')[0]());
  assert.equal(f.control('Walking CSV').value,'Keep my pasted rows');assert.match(text(f.view),/Could not read.*File is unavailable/);
  assert.equal(findButton(f.view,'Import CSV').disabled,false);assert.equal(f.calls.filter(call=>call.name==='importHealthWalking').length,0);
});

test('walking CSV reads keep the newest file or typed draft and block importing before the read finishes',async t=>{
  const f=await fixture(t);await f.click('Walking & measurements');const file=f.control('Choose walking CSV');
  let finishOld,finishNew;file.files=[{name:'older.csv',size:300,text:()=>new Promise(resolve=>{finishOld=resolve;})}];
  const older=file.listeners.get('change')[0]();assert.equal(findButton(f.view,'Import CSV').disabled,true);
  file.closest('form').fire('submit');assert.equal(f.calls.filter(call=>call.name==='importHealthWalking').length,0);
  file.files=[{name:'newer.csv',size:300,text:()=>new Promise(resolve=>{finishNew=resolve;})}];const newer=file.listeners.get('change')[0]();
  finishNew('Newer file rows');await newer;finishOld('Older file rows');await older;
  assert.equal(f.control('Walking CSV').value,'Newer file rows');assert.equal(findButton(f.view,'Import CSV').disabled,false);
  file.files=[{name:'slow.csv',size:300,text:()=>new Promise(resolve=>{finishOld=resolve;})}];const delayed=file.listeners.get('change')[0]();
  f.input('Walking CSV','My new pasted draft');finishOld('Late file rows');await delayed;
  assert.equal(f.control('Walking CSV').value,'My new pasted draft');assert.equal(findButton(f.view,'Import CSV').disabled,false);
  file.files=[{name:'slow.csv',size:300,text:()=>new Promise(resolve=>{finishOld=resolve;})}];const cleared=file.listeners.get('change')[0]();
  findButton(file.closest('form'),'Clear form').click();finishOld('Do not restore after clear');await cleared;assert.equal(f.control('Walking CSV').value,'');
});
test('failed lab saves preserve input and rendered values cannot create executable markup',async t=>{
 const {view,db,input,control,click}=await fixture(t);await click('Lab results');
 input('Lab date','2026-02-30');input('Test name','<img src="https://tracker.example.test">');input('Result value','6.2');input('Lab result unit','mg/L');input('Lab reference minimum','2');input('Lab reference maximum','9');input('Document note','Discuss at appointment');
 await click('Save lab result');assert.equal(health.getHealth(db).labs.length,0);assert.equal(control('Result value').value,'6.2');assert.match(text(view),/real calendar date/);
 input('Lab date','2026-09-11');await click('Save lab result');assert.equal(health.getHealth(db).labs.length,1);assert.equal(view.querySelectorAll('img').length,0);assert.match(text(view),/does not interpret/);
 input('Result value','6.3');await click('Save lab result');assert.equal(health.getHealth(db).labs.length,1);assert.equal(health.getHealth(db).labs[0].value,'6.3');
});
test('manual plans save entries, mark completion and link groceries without an order action',async t=>{
 const {view,db,input,click,calls}=await fixture(t);await click('Meal & exercise plans');
 input('Plan title','My chosen week');input('Week starting','2026-09-14');await click('Add meal or workout');
 input('Entry date','2026-09-14');input('Entry type','meal');input('Meal or workout title','Lunch I chose');input('Entry details','Use the ingredients already at home.');await click('Save plan');
 let plan=health.getHealth(db).plans[0];assert.equal(plan.entries.length,1);await click('Mark completed');plan=health.getHealth(db).plans[0];assert.equal(plan.entries[0].state,'done');
 await click('Groceries');input('Grocery item','Tomatoes');input('Quantity','3');input('Estimated cost','4.50');input('Related plan',plan.id);input('Related meal',plan.entries[0].id);await click('Save grocery item');
 const item=health.getHealth(db).groceryItems[0];assert.equal(item.entryId,plan.entries[0].id);assert.equal(item.state,'needed');
 await click('Review shopping list');assert.match(text(view),/No order has been placed/);assert.match(text(view),/\$4.50/);assert.equal(findButton(view,'Place order'),undefined);
 assert.ok(calls.every(call=>!/(order|checkout|send)/i.test(call.name)));
});
test('a record requires a second explicit delete click and failed deletes keep records visible',async t=>{
 const {view,db,handlers,input,click}=await fixture(t);await click('Lab results');input('Lab date','2026-09-11');input('Test name','Example test');input('Result value','Not detected');await click('Save lab result');
 await click('Delete');assert.equal(health.getHealth(db).labs.length,1);handlers.deleteHealthRecord=()=>{throw new Error('Temporary save error');};await click('Confirm delete');assert.equal(health.getHealth(db).labs.length,1);assert.match(text(view),/Temporary save error/);
 handlers.deleteHealthRecord=value=>health.deleteHealthRecord(db,value);await click('Confirm delete');assert.equal(health.getHealth(db).labs.length,0);
});

function syntheticPreview(stamp){return {id:'health_preview_fixture',weekStart:'2026-09-14',title:'My draft week',profileUpdatedAt:stamp,reviewRequired:true,saved:false,ordered:false,
 entries:[{date:'2026-09-14',kind:'meal',mealSlot:'lunch',title:'Rice and vegetables',details:'Cook and combine.',ingredients:[{name:'Brown rice',quantity:100,unit:'g'}]},
  {date:'2026-09-14',kind:'workout',activity:'walking',title:'Easy walk',details:'Choose a flat route.',durationMinutes:10,intensity:'light'}],
 groceries:[{name:'Brown rice',quantity:100,unit:'g',mealRefs:[0]}],assumptions:['Prices have not been checked.'],sources:[{title:'WHO: Healthy diet',url:'https://www.who.int/news-room/fact-sheets/detail/healthy-diet'}]};}
async function preparePlanner(f){health.saveProfile(f.db,{goals:'A consistent routine',diet:'none',allergies:'none',exerciseLimitations:'none'});await f.click('Refresh records');await f.click('Meal & exercise plans');f.input('Draft week starting','2026-09-14');f.handlers.generateHealthPlan=()=>({preview:syntheticPreview(health.getHealth(f.db).profile.updatedAt),model:'nemotron-local'});}

test('local weekly draft stays editable across navigation and saves only after explicit review',async t=>{
 const f=await fixture(t);await preparePlanner(f);f.input('Planning instructions','Simple lunches');await f.click('Draft a week with your AI');
 assert.equal(f.calls.filter(call=>call.name==='saveHealthPlanPreview').length,0);assert.match(text(f.view),/Nothing has been saved or ordered/);
 const title=f.input('Reviewed plan title','Reviewed and personalized');f.input('Activity 2 duration','15');
 await f.click('Walking & measurements');await f.click('Meal & exercise plans');assert.equal(f.control('Reviewed plan title'),title);assert.equal(title.value,'Reviewed and personalized');
 let submitted;f.handlers.saveHealthPlanPreview=value=>{submitted=value;return {saved:true,groceryCount:1};};await f.click('Save reviewed plan');
 assert.equal(submitted.reviewed,true);assert.equal(submitted.preview.title,'Reviewed and personalized');assert.equal(submitted.preview.entries[1].durationMinutes,15);assert.equal(submitted.preview.id,'health_preview_fixture');
 assert.match(text(f.view),/Saved your plan and 1 grocery items/);assert.ok(findButton(f.view,'Save reviewed plan').disabled);assert.ok(title.disabled);
 assert.doesNotMatch(text(f.view),/Nothing has been saved or ordered/);assert.ok(f.calls.every(call=>!/(order|checkout|send)/i.test(call.name)));
});

test('ingredient edits update groceries while explicit shopping edits are preserved for review',async t=>{
 const f=await fixture(t);await preparePlanner(f);await f.click('Draft a week with your AI');
 f.input('Meal 1 ingredient 1 quantity','200');assert.equal(f.control('Grocery 1 quantity').value,'200');
 f.input('Grocery 1 quantity','50');f.input('Meal 1 ingredient 1 quantity','300');assert.equal(f.control('Grocery 1 quantity').value,'50');
 assert.match(text(f.view),/Meal ingredients changed after you edited/);assert.ok(findButton(f.view,'Save reviewed plan').disabled);
 await f.click('Keep my grocery edits');assert.equal(findButton(f.view,'Save reviewed plan').disabled,false);assert.equal(f.control('Grocery 1 quantity').value,'50');
 f.input('Meal 1 ingredient 1 quantity','400');await f.click('Rebuild groceries from meals');assert.equal(f.control('Grocery 1 quantity').value,'400');assert.equal(findButton(f.view,'Save reviewed plan').disabled,false);
 await f.click('Add grocery item to draft');f.input('Grocery 2 name','Apples');f.input('Grocery 2 quantity','3');
 let submitted;f.handlers.saveHealthPlanPreview=value=>{submitted=value;return {saved:true,groceryCount:2};};await f.click('Save reviewed plan');assert.deepEqual(submitted.preview.groceries[1].mealRefs,[]);
});

test('stop drafting cancels the request and ignores its late response',async t=>{
 const f=await fixture(t);await preparePlanner(f);let resolve,requestSignal;
 f.handlers.generateHealthPlan=(value,options)=>{requestSignal=options.signal;return new Promise(done=>{resolve=done;});};
 await f.click('Draft a week with your AI');assert.ok(findButton(f.view,'Draft a week with your AI').disabled);assert.equal(findButton(f.view,'Stop drafting').hidden,false);
 await f.click('Stop drafting');assert.equal(requestSignal.aborted,true);assert.equal(findButton(f.view,'Draft a week with your AI').disabled,false);
 resolve({preview:syntheticPreview(health.getHealth(f.db).profile.updatedAt),model:'late-response'});await settle();assert.equal(f.control('Reviewed plan title'),null);assert.match(text(f.view),/Drafting stopped/);
});

test('save failures preserve the exact preview ID and input for repeat-safe retry',async t=>{
 const f=await fixture(t);await preparePlanner(f);await f.click('Draft a week with your AI');f.input('Reviewed plan title','Keep this title');
 let reject;f.handlers.saveHealthPlanPreview=()=>new Promise((resolve,no)=>{reject=no;});
 await f.click('Save reviewed plan');assert.ok(f.control('Reviewed plan title').disabled);assert.ok(findButton(f.view,'Save reviewed plan').disabled);
 reject(new Error('Connection interrupted'));await settle();assert.equal(f.control('Reviewed plan title').value,'Keep this title');assert.equal(f.control('Reviewed plan title').disabled,false);assert.match(text(f.view),/Connection interrupted/);
 f.handlers.saveHealthPlanPreview=()=>({saved:true,groceryCount:1});await f.click('Save reviewed plan');const saves=f.calls.filter(call=>call.name==='saveHealthPlanPreview');assert.equal(saves.length,2);assert.deepEqual(saves[0].value,saves[1].value);
});

test('changed or unsaved preferences prevent generation or stale-plan saving',async t=>{
 const f=await fixture(t);await preparePlanner(f);await f.click('Draft a week with your AI');
 health.saveProfile(f.db,{allergies:'peanuts'});await f.click('Refresh records');assert.ok(findButton(f.view,'Save reviewed plan').disabled);assert.match(text(f.view),/Your saved preferences changed/);
 await f.click('Goals & preferences');f.input('Health goals','Not saved yet');await f.click('Meal & exercise plans');assert.ok(findButton(f.view,'Draft a week with your AI').disabled);assert.match(text(f.view),/Save your changed preferences/);
});

test('invalid edited quantities never reach the save API and source links stay bounded',async t=>{
 const f=await fixture(t);await preparePlanner(f);const value=syntheticPreview(health.getHealth(f.db).profile.updatedAt);value.sources.push({title:'<img onerror=alert(1)>',url:'javascript:alert(1)'});
 f.handlers.generateHealthPlan=()=>({preview:value,model:'local'});await f.click('Draft a week with your AI');assert.equal(f.view.querySelectorAll('img').length,0);assert.ok(f.view.querySelectorAll('a').every(node=>node.getAttribute('href')!=='javascript:alert(1)'));
 f.input('Grocery 1 quantity','-1');await f.click('Save reviewed plan');assert.match(text(f.view),/Review every grocery/);assert.equal(f.calls.filter(call=>call.name==='saveHealthPlanPreview').length,0);
});

test('saved generated recipe metadata is displayed and survives editing a plan title',async t=>{
 const f=await fixture(t);const preview=syntheticPreview(null);const plan=health.savePlan(f.db,{title:'Saved generated week',weekStart:preview.weekStart,entries:preview.entries}).plan;
 await f.click('Refresh records');await f.click('Meal & exercise plans');assert.match(text(f.view),/Brown rice · 100 g/);assert.match(text(f.view),/10 minutes · light/);
 await f.click('Edit plan');f.input('Plan title','Renamed week');await f.click('Save plan');const saved=health.getHealth(f.db).plans.find(value=>value.id===plan.id);assert.equal(saved.entries[0].ingredients[0].name,'Brown rice');assert.equal(saved.entries[1].durationMinutes,10);
 await f.click('Lab results');assert.equal(f.view.querySelector('[href="#/documents/labs"]').getAttribute('href'),'#/documents/labs');await f.click('Groceries');assert.equal(f.view.querySelector('[href="#/shopping"]').getAttribute('href'),'#/shopping');
});


test('browser-close protection covers active generation and unsaved previews, then clears after save',async t=>{
 const f=await fixture(t);await preparePlanner(f);assert.equal(f.beforeUnload().defaultPrevented,false);
 let resolve;f.handlers.generateHealthPlan=()=>new Promise(done=>{resolve=done;});await f.click('Draft a week with your AI');assert.equal(f.beforeUnload().defaultPrevented,true);
 resolve({preview:syntheticPreview(health.getHealth(f.db).profile.updatedAt),model:'local'});await settle();assert.equal(f.beforeUnload().defaultPrevented,true);
 f.handlers.saveHealthPlanPreview=()=>({saved:true,groceryCount:1});await f.click('Save reviewed plan');assert.equal(f.beforeUnload().defaultPrevented,false);
});
