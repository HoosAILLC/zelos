import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-meal-api-'));process.env.ZELOS_HOME=home;process.env.ZELOS_LOG_LEVEL='silent';process.env.ZELOS_SECRETS_BACKEND='encrypted-file';
const {createServer,listen}=await import('../core/server.mjs');const database=await import('../core/db.mjs');const {loadConfig}=await import('../core/config.mjs');
const {generateMealWeek}=await import('../core/meal-planner.mjs');const {samplePlan}=await import('./helpers/meal-fixture.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
async function fixture(t){
 const db=database.open(':memory:');database.migrate(db);const defaults=loadConfig();let calls=0;
 const config={...defaults,model:{protocol:'openai',baseUrl:'http://127.0.0.1:1/v1',model:'synthetic',keyRef:null},sweep:{...defaults.sweep,auto:false}};
 const server=createServer({db,config,mealGenerator:args=>{calls++;return generateMealWeek({...args,complete:async()=>({text:JSON.stringify(samplePlan()),stopReason:'stop'})});}});const {port}=await listen(server,{port:0});const base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await server.zelos.stopBackgroundWork();server.closeAllConnections();await new Promise(r=>server.close(r));database.close(db);});
 async function call(route,{method='GET',body,token=server.sessionToken,origin=base}={}){const res=await fetch(base+route,{method,headers:{Origin:origin,...(token?{'X-Zelos-Token':token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await res.text();let json;try{json=JSON.parse(text);}catch{}return {status:res.status,json,headers:res.headers};}
 return {db,call,calls:()=>calls,post:(route,body,extra={})=>call(route,{method:'POST',body,...extra})};
}
test('weekly endpoints require a private session and same origin before inference or writes',async t=>{const c=await fixture(t);assert.equal((await c.call('/api/shopping/week?weekStart=2026-09-14',{token:null})).status,401);for(const route of ['generate','build','cancel']) {assert.equal((await c.post('/api/shopping/week/'+route,{}, {token:null})).status,401);assert.equal((await c.post('/api/shopping/week/'+route,{}, {origin:'https://untrusted.example'})).status,403);}assert.equal(c.calls(),0);});
test('generation, revisit, meal swaps and idempotent grocery building work over authenticated HTTP',async t=>{const c=await fixture(t);await c.post('/api/health-tracking/profile',{goals:'Varied meals',diet:'none',allergies:'none',householdSize:1});const started=await c.post('/api/shopping/week/generate',{weekStart:'2026-09-14',servings:1,maxMinutes:45});assert.equal(started.status,202);assert.match(started.headers.get('cache-control'),/no-store/);let state;for(let i=0;i<20;i++){state=await c.call('/api/shopping/week?weekStart=2026-09-14');if(state.json.job.status!=='running')break;await new Promise(r=>setImmediate(r));}assert.equal(state.json.job.status,'complete');assert.equal(state.json.week.meals.length,21);assert.equal(c.calls(),1);const w=state.json.week,body={weekStart:w.weekStart,weekId:w.id,expectedRevision:w.revision,selectedIds:['0-breakfast','0-dinner'],choices:{'0-breakfast':'r1'}};const built=await c.post('/api/shopping/week/build',body);assert.equal(built.status,200);assert.equal(built.json.groceryCount,3);assert.equal((await c.post('/api/shopping/week/build',body)).json.unchanged,true);assert.equal((await c.call('/api/shopping')).json.items.length,3);assert.equal((await c.call('/api/shopping/week?weekStart=2026-09-14')).json.week.meals[0].recipeId,'r1');});

test('store preferences require a private session and same-origin writes without changing saved data', async t => {
 const c = await fixture(t), route = '/api/shopping/store-preferences', body = { storeIds: ['costco', 'kroger', 'meijer'], expectedRevision: null };
 assert.equal((await c.call(route, { token: null })).status, 401);
 assert.equal((await c.post(route, body, { token: null })).status, 401);
 assert.equal((await c.post(route, body, { origin: 'https://untrusted.example' })).status, 403);
 const initial = await c.call(route);
 assert.equal(initial.status, 200); assert.deepEqual(initial.json.stores, []); assert.equal(initial.json.revision, null);
 assert.match(initial.headers.get('cache-control'), /no-store/); assert.equal(c.calls(), 0);
});

test('store preferences validate selections and revision, persist across reads, and clear only on an explicit current save', async t => {
 const c = await fixture(t), route = '/api/shopping/store-preferences';
 for (const storeIds of [['invented-retailer'], ['costco', 'costco'], ['Krojer'], 'costco', null]) {
  assert.equal((await c.post(route, { storeIds, expectedRevision: null })).status, 400);
 }
 assert.equal((await c.post(route, { storeIds: ['costco'] })).status, 409);
 const saved = await c.post(route, { storeIds: ['costco', 'kroger', 'meijer'], expectedRevision: null });
 assert.equal(saved.status, 200); assert.deepEqual(saved.json.stores.map(s => s.name), ['Costco', 'Kroger', 'Meijer']);
 assert.equal(typeof saved.json.revision, 'string'); assert.match(saved.json.note, /not checked store quotes/);
 assert.deepEqual((await c.call(route)).json, saved.json);
 assert.deepEqual((await c.call('/api/shopping')).json.storePreferences, saved.json);
 assert.deepEqual((await c.call('/api/shopping/week?weekStart=2026-09-14')).json.storePreferences, saved.json);
 const stale = await c.post(route, { storeIds: ['aldi'], expectedRevision: null });
 assert.equal(stale.status, 409); assert.match(stale.json.error, /another device/);
 assert.deepEqual((await c.call(route)).json, saved.json);
 const cleared = await c.post(route, { storeIds: [], expectedRevision: saved.json.revision });
 assert.equal(cleared.status, 200); assert.deepEqual(cleared.json.stores, []); assert.notEqual(cleared.json.revision, saved.json.revision);
 assert.equal(c.calls(), 0);
});

test('saving stores over HTTP keeps selected meals and health records intact and requires no Instacart account', async t => {
 const c = await fixture(t), weekStart = '2026-09-14';
 await c.post('/api/health-tracking/profile', { goals: 'Varied meals', diet: 'none', allergies: 'none', householdSize: 1 });
 await c.post('/api/shopping/week/generate', { weekStart, servings: 1, maxMinutes: 45 });
 let state;
 for (let i = 0; i < 20; i++) { state = (await c.call(`/api/shopping/week?weekStart=${weekStart}`)).json; if (state.job.status !== 'running') break; await new Promise(r => setImmediate(r)); }
 assert.equal(state.job.status, 'complete');
 const selected = await c.post('/api/shopping/week/build', { weekStart, weekId: state.week.id, expectedRevision: state.week.revision, selectedIds: ['0-lunch'], choices: { '0-lunch': 'r4' } });
 assert.equal(selected.status, 200);
 const before = (await c.call(`/api/shopping/week?weekStart=${weekStart}`)).json, groceries = (await c.call('/api/shopping')).json;
 await c.post('/api/shopping/store-preferences', { storeIds: ['costco', 'kroger', 'meijer'], expectedRevision: null });
 const after = (await c.call(`/api/shopping/week?weekStart=${weekStart}`)).json, updated = (await c.call('/api/shopping')).json;
 assert.deepEqual(after.week, before.week); assert.equal(after.stale, false); assert.deepEqual(after.profile, before.profile); assert.deepEqual(after.health, before.health);
 assert.deepEqual(updated.items, groceries.items); assert.deepEqual(updated.settings, groceries.settings); assert.equal(updated.settings.provider, ''); assert.equal(updated.settings.keySaved, false);
 assert.equal(c.calls(), 1, 'saving stores never starts inference');
});
