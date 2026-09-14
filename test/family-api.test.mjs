import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-family-api-'));
process.env.ZELOS_HOME=home;process.env.ZELOS_SECRETS_BACKEND='encrypted-file';process.env.ZELOS_LOG_LEVEL='silent';
const {createServer,listen}=await import('../core/server.mjs');
const database=await import('../core/db.mjs');
const {loadConfig}=await import('../core/config.mjs');
const {acceptFamilyInvite,completeFamilyMfa,authenticateFamily,familyState}=await import('../core/family.mjs');
const {totpCode}=await import('../core/family-mfa.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));

async function fixture(t,options={}){
 const db=database.open(':memory:');database.migrate(db);
 const defaults=loadConfig(),config={...defaults,sweep:{...defaults.sweep,auto:false}};
 const server=createServer({db,config,...options}),{port}=await listen(server,{port:0}),base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await server.zelos.stopBackgroundWork();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));database.close(db);});
 async function call(route,{method='GET',body,token=server.sessionToken,origin=base}={}){
  const response=await fetch(base+route,{method,headers:{...(token?{'X-Zelos-Token':token}:{}),Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const bytes=Buffer.from(await response.arrayBuffer());let json;try{json=JSON.parse(bytes);}catch{}
  return {status:response.status,json,bytes,headers:response.headers};
 }
 const action=(action,input)=>call('/api/family/action',{method:'POST',body:{action,input}});
 return {db,server,call,action};
}

test('family owner routes retain the existing private session and origin boundary',async t=>{
 const f=await fixture(t);
 for(const route of ['/api/family','/api/family/sources','/api/family/documents/missing'])assert.equal((await f.call(route,{token:null})).status,401,route);
 for(const route of ['/api/family/action','/api/family/snapshot']){
  assert.equal((await f.call(route,{method:'POST',body:{},token:null})).status,401);
  assert.equal((await f.call(route,{method:'POST',body:{},origin:'https://another.example'})).status,403);
 }
 const state=await f.call('/api/family');assert.equal(state.status,200);assert.equal(state.json.me.id,'owner');assert.deepEqual(state.json.portal,{url:null,ready:false,published:false});
 assert.equal((await f.action('unknown',{})).status,400);
});

test('selected owner records become reviewed snapshots without exposing private records to a parent',async t=>{
 const f=await fixture(t);
 const original=database.upsertItem(f.db,{key:'family-source',kind:'task',bucket:'today',headline:'Review the race plan',why:'Discuss next week with the trainer',sourceRefs:[],payload:{privateDetail:'not projected'}});
 const before=f.db.prepare('SELECT * FROM items WHERE id=?').get(original.id);
 const listing=await f.call('/api/family/sources');assert.equal(listing.status,200);
 const source=listing.json.sources.find(row=>row.id===`task:${original.id}`);assert.ok(source);assert.equal(JSON.stringify(source).includes('privateDetail'),false);
 assert.equal((await f.call('/api/family')).json.records.length,0);
 const stale=await f.call('/api/family/snapshot',{method:'POST',body:{sourceId:source.id,visibility:'private',fingerprint:'old'}});assert.equal(stale.status,409);
 const saved=await f.call('/api/family/snapshot',{method:'POST',body:{sourceId:source.id,fingerprint:source.fingerprint,visibility:'private'}});assert.equal(saved.status,200,JSON.stringify(saved.json));
 assert.equal(saved.json.record.title,source.title);assert.match(saved.json.record.source,/Snapshot/);
 assert.deepEqual(f.db.prepare('SELECT * FROM items WHERE id=?').get(original.id),before);
 const invited=await f.action('member.invite',{name:'Second parent',email:'parent@example.test',role:'parent'});assert.equal(invited.status,200,JSON.stringify(invited.json));
 const setup=await acceptFamilyInvite(f.db,{token:invited.json.inviteToken,password:'a long synthetic password'});
 assert.equal(setup.mfaRequired,true);assert.equal(setup.token,undefined);
 const accepted=await completeFamilyMfa(f.db,{challenge:setup.challenge,code:totpCode(setup.enrollment.secret)});
 const parent=authenticateFamily(f.db,accepted.token);
 assert.equal(familyState(f.db,parent).records.some(record=>record.id===saved.json.record.id),false);
 assert.equal((await f.call('/api/family',{token:accepted.token})).status,401);
});

test('family document downloads are attachments and preserve original uploaded bytes',async t=>{
 const f=await fixture(t),bytes=Buffer.from('A synthetic training plan.');
 const uploaded=await f.action('document.upload',{filename:'training-plan.txt',base64:bytes.toString('base64'),title:'Training plan',visibility:'private',idempotencyKey:'family-api-document-1'});
 assert.equal(uploaded.status,200,JSON.stringify(uploaded.json));
 const id=uploaded.json.record.id,download=await f.call(`/api/family/documents/${id}`);
 assert.equal(download.status,200);assert.deepEqual(download.bytes,bytes);assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('content-type'),'application/octet-stream');
 assert.equal((await f.call(`/api/family/documents/${id}`,{token:null})).status,401);
});

test('guest lifecycle advertises only configured portal and shuts down with owner server',async t=>{
 const f=await fixture(t,{familyGuestOrigin:'https://family.example',familyPublished:true});
 assert.equal((await f.call('/api/family')).json.portal.ready,false);
 const address=await f.server.zelos.startFamily({port:0});assert.ok(address);
 assert.deepEqual((await f.call('/api/family')).json.portal,{url:'https://family.example',ready:true,published:true});
 await f.server.zelos.stopBackgroundWork();
 assert.equal((await f.call('/api/family')).json.portal.ready,false);
});
