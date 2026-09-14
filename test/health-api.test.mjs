/** Synthetic authenticated HTTP tests for Health response contracts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-health-api-'));
process.env.ZELOS_HOME=home;process.env.ZELOS_SECRETS_BACKEND='encrypted-file';process.env.ZELOS_LOG_LEVEL='silent';
const {createServer,listen}=await import('../core/server.mjs');
const database=await import('../core/db.mjs');
const {loadConfig}=await import('../core/config.mjs');
const {HealthPlannerError}=await import('../core/health-planner.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
async function fixture(t,planner=async()=>{throw Error('Unexpected model call');}){
 const db=database.open(':memory:');database.migrate(db);const defaults=loadConfig();
 const config={...defaults,model:{protocol:'openai',baseUrl:'http://127.0.0.1:1/v1',model:'synthetic',keyRef:null},sweep:{...defaults.sweep,auto:false}};
 const server=createServer({db,config,healthPlanner:planner});const {port}=await listen(server,{port:0});const base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await server.zelos.stopBackgroundWork();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));database.close(db);});
 async function call(route,{method='GET',body,token=server.sessionToken,origin=base,signal}={}){
  const res=await fetch(base+route,{method,signal,headers:{Origin:origin,...(token?{'X-Zelos-Token':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await res.text();let json;try{json=JSON.parse(text);}catch{}return {status:res.status,json,text,headers:res.headers};
 }
 return {db,server,call,post:(route,body,extra={})=>call(route,{method:'POST',body,...extra})};
}
const preferences={goals:'A consistent routine',diet:'none',allergies:'none',exerciseLimitations:'none',householdSize:1};
function preview(stamp){return {id:'health_preview_http',weekStart:'2026-09-14',title:'Reviewed meals and movement',profileUpdatedAt:stamp,reviewRequired:true,saved:false,ordered:false,
 entries:[{date:'2026-09-14',kind:'meal',mealSlot:'breakfast',title:'Rice and fruit',details:'Cook the rice and slice the apple.',ingredients:[{name:'Apple',quantity:1,unit:'item'}]},
  {date:'2026-09-14',kind:'workout',activity:'walking',title:'Easy walk',details:'Use a flat route.',durationMinutes:15,intensity:'light'}],
 groceries:[{name:'Apple',quantity:1,unit:'item',mealRefs:[0]}],assumptions:['Prices and availability are not checked.'],sources:[{title:'WHO: Healthy diet',url:'https://www.who.int/news-room/fact-sheets/detail/healthy-diet'}]};}

test('Health mutations return one response wrapper with usable record IDs and timestamps',async t=>{
 const ctx=await fixture(t);
 const profile=await ctx.post('/api/health-tracking/profile',preferences);assert.equal(profile.status,200);assert.equal(profile.json.profile.goals,preferences.goals);assert.equal(typeof profile.json.profile.updatedAt,'string');assert.equal(profile.json.profile.profile,undefined);
 const walking=await ctx.post('/api/health-tracking/walking',{date:'2026-09-11',steps:6000,distance:3,distanceUnit:'mi'});assert.equal(walking.status,200);assert.equal(walking.json.walking.id,'walking_2026-09-11');assert.equal(walking.json.walking.steps,6000);
 const lab=await ctx.post('/api/health-tracking/labs',{date:'2026-09-11',name:'Synthetic test',value:'5.2',unit:'mg/L'});assert.equal(lab.status,200);assert.equal(typeof lab.json.lab.id,'string');assert.equal(lab.json.lab.value,'5.2');
 const metric=await ctx.post('/api/health-tracking/metrics',{date:'2026-09-11',kind:'sleep',value:7.5,unit:'hours'});assert.equal(metric.status,200);assert.equal(metric.json.metric.value,7.5);assert.equal(typeof metric.json.metric.id,'string');
 const plan=await ctx.post('/api/health-tracking/plans',{title:'My manual week',weekStart:'2026-09-14',entries:[{date:'2026-09-14',kind:'meal',title:'Chosen lunch'}]});assert.equal(plan.status,200);assert.equal(plan.json.plan.entries.length,1);assert.equal(typeof plan.json.plan.id,'string');
 const grocery=await ctx.post('/api/health-tracking/groceries',{name:'Apple',quantity:'1 item',planId:plan.json.plan.id,entryId:plan.json.plan.entries[0].id});assert.equal(grocery.status,200);assert.equal(typeof grocery.json.item.id,'string');assert.equal(grocery.json.item.planId,plan.json.plan.id);
 const state=await ctx.post('/api/health-tracking/plan-state',{id:plan.json.plan.entries[0].id,state:'done'});assert.equal(state.status,200);assert.equal(state.json.plan.entries[0].state,'done');
 const imported=await ctx.post('/api/health-tracking/walking/import',{csv:'date,steps\n2026-09-12,7000'});assert.equal(imported.status,200);assert.equal(imported.json.imported,1);
 const deleted=await ctx.post('/api/health-tracking/delete',{kind:'lab',id:lab.json.lab.id});assert.equal(deleted.status,200);assert.equal(deleted.json.ok,true);
});

test('preview API forwards only planning inputs and commit retains source, recipe and activity fields',async t=>{
 let request;const ctx=await fixture(t,async options=>{request=options;return {preview:preview(database.getKV(options.db,'fixture.profile.stamp')),model:'synthetic-local',usage:{input:10,output:20}};});
 const profile=await ctx.post('/api/health-tracking/profile',preferences);database.setKV(ctx.db,'fixture.profile.stamp',profile.json.profile.updatedAt);
 const draft=await ctx.post('/api/health-tracking/plan-preview',{weekStart:'2026-09-14',instructions:'Quick preparation',extra:'ignore this'});assert.equal(draft.status,200);assert.equal(draft.json.preview.title,'Reviewed meals and movement');assert.equal(draft.json.model,'synthetic-local');assert.deepEqual(draft.json.usage,{input:10,output:20});
 assert.equal(request.db,ctx.db);assert.equal(request.weekStart,'2026-09-14');assert.equal(request.instructions,'Quick preparation');assert.equal(request.extra,undefined);assert.ok(request.signal instanceof AbortSignal);assert.match(draft.headers.get('cache-control'),/no-store/);
 assert.equal((await ctx.call('/api/health-tracking')).json.plans.length,0);
 const saved=await ctx.post('/api/health-tracking/plan-save',{preview:draft.json.preview,reviewed:true});assert.equal(saved.status,200);assert.equal(saved.json.saved,true);assert.equal(saved.json.ordered,false);assert.equal(saved.json.groceryCount,1);
 assert.equal(saved.json.plan.entries[0].ingredients[0].name,'Apple');assert.equal(saved.json.plan.entries[0].mealSlot,'breakfast');assert.equal(saved.json.plan.entries[1].durationMinutes,15);assert.equal(saved.json.plan.entries[1].intensity,'light');assert.match(saved.json.plan.note,/WHO: Healthy diet/);assert.match(saved.json.plan.note,/https:\/\/www.who.int/);
 const repeated=await ctx.post('/api/health-tracking/plan-save',{preview:draft.json.preview,reviewed:true});assert.deepEqual(repeated.json,saved.json);
 const health=(await ctx.call('/api/health-tracking')).json;assert.equal(health.plans.length,1);assert.equal(health.groceryItems.length,1);
});

test('preview and save require the private token and same origin before any model or write',async t=>{
 let calls=0;const ctx=await fixture(t,async()=>{calls++;return {};});
 for(const route of ['/api/health-tracking/plan-preview','/api/health-tracking/plan-save']){
  assert.equal((await ctx.post(route,{}, {token:null})).status,401);assert.equal((await ctx.post(route,{}, {origin:'https://foreign.example'})).status,403);
 }
 assert.equal(calls,0);assert.equal((await ctx.call('/api/health-tracking')).json.plans.length,0);
});

test('expected planner clarification keeps its actionable message and HTTP status',async t=>{
 const ctx=await fixture(t,async()=>{throw new HealthPlannerError('List specific foods to avoid, or enter none.',{code:'clarification_needed',status:409});});
 const result=await ctx.post('/api/health-tracking/plan-preview',{weekStart:'2026-09-14'});assert.equal(result.status,409);assert.match(result.json.error,/List specific foods/);
 assert.equal((await ctx.call('/api/health-tracking')).json.plans.length,0);
});

test('disconnecting a preview request aborts the model and leaves no plan behind',async t=>{
 let started,aborted;const start=new Promise(resolve=>{started=resolve;});const ended=new Promise(resolve=>{aborted=resolve;});
 const ctx=await fixture(t,options=>new Promise((resolve,reject)=>{started();options.signal.addEventListener('abort',()=>{aborted();reject(options.signal.reason);},{once:true});}));
 const controller=new AbortController();const pending=ctx.post('/api/health-tracking/plan-preview',{weekStart:'2026-09-14'},{signal:controller.signal});await start;controller.abort();
 await assert.rejects(pending,{name:'AbortError'});await ended;assert.equal((await ctx.call('/api/health-tracking')).json.plans.length,0);
});
