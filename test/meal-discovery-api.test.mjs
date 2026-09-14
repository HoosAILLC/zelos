import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-meal-discovery-api-'));
process.env.ZELOS_HOME=home;process.env.ZELOS_LOG_LEVEL='silent';process.env.ZELOS_SECRETS_BACKEND='encrypted-file';
const {createServer,listen}=await import('../core/server.mjs');
const database=await import('../core/db.mjs');const {loadConfig}=await import('../core/config.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
async function fixture(t){
 const db=database.open(':memory:');database.migrate(db);const config=loadConfig();config.sweep.auto=false;
 const server=createServer({db,config,runSweep:async()=>({ok:true})});const {port}=await listen(server,{port:0});const base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await server.zelos.stopBackgroundWork();server.closeAllConnections();await new Promise(r=>server.close(r));database.close(db);});
 async function call(route,{method='GET',body,token=server.sessionToken,origin=base}={}){
  const response=await fetch(base+route,{method,headers:{Origin:origin,...(token?{'X-Zelos-Token':token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  let json;try{json=await response.json();}catch{}return{status:response.status,json,headers:response.headers};
 }
 return {db,call,post:(route,body,extra={})=>call(route,{method:'POST',body,...extra})};
}
const root='/api/shopping/meals',date='2026-09-14';
test('discovery data and mutations retain private session and origin guards',async t=>{
 const c=await fixture(t);assert.equal((await c.call(root+'?weekStart='+date,{token:null})).status,401);
 for(const action of ['taste','add']){
  assert.equal((await c.post(root+'/'+action,{}, {token:null})).status,401);
  assert.equal((await c.post(root+'/'+action,{}, {origin:'https://untrusted.example'})).status,403);
 }
 assert.equal(c.db.prepare("SELECT count(*) AS count FROM kv WHERE k LIKE 'shopping.meals.%'").get().count,0);
});
test('browse, save, choose a day and build a combined list work without inference or a shopping account',async t=>{
 const c=await fixture(t);
 await c.post('/api/health-tracking/profile',{goals:'Simple meals',diet:'none',allergies:'none',householdSize:1});
 const listing=await c.call(root+'?weekStart='+date);assert.equal(listing.status,200);assert.match(listing.headers.get('cache-control'),/no-store/);
 assert.ok(listing.json.recipes.length>=90);assert.equal(c.db.prepare('SELECT count(*) AS n FROM health_records').get().n,0);
 const recipe=listing.json.recipes.find(r=>r.slot==='breakfast'),recipeId=recipe.discoveryId;
 const taste=await c.post(root+'/taste',{recipeId,action:'favorite',expectedRevision:listing.json.revision});
 assert.equal(taste.status,200);assert.ok(taste.json.favorites.includes(recipeId));
 const added=await c.post(root+'/add',{weekStart:date,recipeId,mealId:'0-breakfast',expectedRevision:null});
 assert.equal(added.status,200);assert.ok(added.json.week.selectedIds.includes('0-breakfast'));
 assert.equal(c.db.prepare('SELECT count(*) AS n FROM health_records').get().n,0,'choosing a recipe only saves the weekly selection');
 const w=added.json.week;
 const built=await c.post('/api/shopping/week/build',{weekStart:date,weekId:w.id,expectedRevision:w.revision,selectedIds:w.selectedIds,choices:{}});
 assert.equal(built.status,200);assert.ok(built.json.groceryCount>0);
 const revisit=await c.call(root+'?weekStart='+date);assert.ok(revisit.json.favorites.includes(recipeId));
 assert.equal((await c.call('/api/shopping?weekStart='+date)).json.settings.provider,'');
});
test('stale tastes and incompatible or unknown recipe choices fail without changing the week',async t=>{
 const c=await fixture(t);await c.post('/api/health-tracking/profile',{diet:'none',allergies:'none',householdSize:1});
 const library=(await c.call(root+'?weekStart='+date)).json,recipe=library.recipes.find(r=>r.slot==='breakfast'),recipeId=recipe.discoveryId;
 const first=await c.post(root+'/taste',{recipeId,action:'favorite',expectedRevision:library.revision});assert.equal(first.status,200);
 assert.equal((await c.post(root+'/taste',{recipeId,action:'skip',expectedRevision:library.revision})).status,409);
 assert.equal((await c.post(root+'/add',{weekStart:date,recipeId,mealId:'0-dinner',expectedRevision:null})).status,400);
 assert.equal((await c.post(root+'/add',{weekStart:date,recipeId:'catalog_does_not_exist',mealId:'0-breakfast',expectedRevision:null})).status,409);
 assert.equal((await c.call('/api/shopping/week?weekStart='+date)).json.week,null);
});
