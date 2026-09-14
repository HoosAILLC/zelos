/** Web requests carry only explicit public lookup text; model inference stays local. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-web-api-'));
process.env.ZELOS_HOME=home;process.env.ZELOS_SECRETS_BACKEND='encrypted-file';process.env.ZELOS_LOG_LEVEL='silent';
const {createServer,listen}=await import('../core/server.mjs');
const database=await import('../core/db.mjs');const {DEFAULTS}=await import('../core/config.mjs');
const {WEB_SEARCH_SECRET_REF}=await import('../core/web-research.mjs');
const {getSecret,deleteSecret}=await import('../core/secrets.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
async function fixture(t,overrides={}){
 const sent=[];const model=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;sent.push(JSON.parse(raw));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({model:'synthetic',choices:[{delta:{content:'Source-based answer.'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 const db=database.open(':memory:');database.migrate(db);const config=structuredClone(DEFAULTS);config.sweep.auto=false;config.identity.timezone='America/Indiana/Indianapolis';config.model={...config.model,protocol:'openai',model:'synthetic',baseUrl:`http://127.0.0.1:${model.address().port}`,keyRef:null};
 const lookups=[];const page={kind:'page',title:'Public source',url:'https://www.iana.org/help/example-domains',excerpt:'PUBLIC_EVIDENCE_83',date:null,dateKind:null,fetchedAt:'2026-09-11T00:00:00Z'};
 const server=createServer({db,config,webReader:async input=>{lookups.push(input);return page;},webSearcher:async input=>{lookups.push(input);return {kind:'search',sources:[page],fetchedAt:page.fetchedAt};},...overrides});
 const {port}=await listen(server,{port:0});const base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await server.zelos.stopBackgroundWork();server.closeAllConnections();await new Promise(r=>server.close(r));model.closeAllConnections();await new Promise(r=>model.close(r));database.close(db);await deleteSecret(WEB_SEARCH_SECRET_REF);});
 async function call(route,{body,token=server.sessionToken,origin=base,signal}={}){const res=await fetch(base+route,{method:body===undefined?'GET':'POST',signal,headers:{Origin:origin,...(token?{'X-Zelos-Token':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const text=await res.text();let json;try{json=JSON.parse(text);}catch{}return {status:res.status,text,json};}
 return {db,server,call,sent,lookups,page};
}
test('ordinary Ask has no web call and page mode forwards only the explicitly entered public URL',async t=>{
 const x=await fixture(t);database.insertCapture(x.db,'PRIVATE_ORCHID_82 is a private note.');
 assert.equal((await x.call('/api/ask',{body:{question:'Explain triangles'}})).status,200);assert.equal(x.lookups.length,0);
 const reply=await x.call('/api/ask',{body:{question:'Connect PRIVATE_ORCHID_82 to the public source',web:{mode:'page',url:x.page.url,privateHistory:'NEVER_FORWARD'}}});assert.equal(reply.status,200);
 assert.deepEqual(Object.keys(x.lookups[0]).sort(),['signal','url']);assert.equal(x.lookups[0].url,x.page.url);
 assert.match(JSON.stringify(x.sent[1]),/PRIVATE_ORCHID_82/);assert.match(JSON.stringify(x.sent[1]),/PUBLIC_EVIDENCE_83/);assert.match(JSON.stringify(x.sent[1]),/untrusted/i);
 const rows=x.db.prepare("SELECT sources_json FROM assistant_messages WHERE role='assistant' ORDER BY rowid DESC").get();assert.equal(JSON.parse(rows.sources_json).find(source=>source.kind==='web').url,x.page.url);
});
test('web key stays encrypted and explicit search sends neither private question nor conversation history',async t=>{
 const x=await fixture(t);const before=await x.call('/api/web/settings');assert.equal(before.json.searchConfigured,false);
 const key='synthetic-web-key-PRIVATE_84';const saved=await x.call('/api/web/settings',{body:{apiKey:key}});assert.deepEqual(saved.json,{provider:'brave',searchConfigured:true});assert.doesNotMatch(saved.text,/PRIVATE_84/);assert.equal(await getSecret(WEB_SEARCH_SECRET_REF),key);
 const response=await x.call('/api/ask',{body:{question:'PRIVATE_QUESTION_85',web:{mode:'search',query:'public building design'}}});assert.equal(response.status,200);assert.deepEqual(Object.keys(x.lookups[0]).sort(),['apiKey','query','signal']);assert.equal(x.lookups[0].query,'public building design');assert.doesNotMatch(JSON.stringify(x.lookups[0]),/PRIVATE_QUESTION_85/);
 assert.equal((await x.call('/api/web/settings',{body:{apiKey:'not saved'},token:null})).status,401);assert.equal((await x.call('/api/web/settings',{body:{apiKey:'not saved'},origin:'https://foreign.example'})).status,403);assert.equal(await getSecret(WEB_SEARCH_SECRET_REF),key);
});
test('private URLs and unauthorized Ask never reach a web transport',async t=>{
 const x=await fixture(t);const body={question:'Read this',web:{mode:'page',url:'http://127.0.0.1:11434'}};
 assert.equal((await x.call('/api/ask',{body})).status,400);assert.equal((await x.call('/api/ask',{body,token:null})).status,401);assert.equal(x.lookups.length,0);assert.equal(x.sent.length,0);
});
test('shutdown waits for interrupted web Ask to record its state before database close',async t=>{
 let started;const begin=new Promise(r=>{started=r;});
 const x=await fixture(t,{webReader:({signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new Error('Stopped')),{once:true});})});
 const response=x.call('/api/ask',{body:{question:'Read source',web:{mode:'page',url:'https://www.iana.org/help/example-domains'}}});await begin;await x.server.zelos.stopBackgroundWork();await response;
 assert.equal(x.db.prepare("SELECT state FROM assistant_messages WHERE role='assistant'").get().state,'interrupted');assert.equal(x.sent.length,0);
});
test('document receipts and unconfigured owner booking settings have their actual UI shapes',async t=>{
 const x=await fixture(t);assert.deepEqual((await x.call('/api/documents/receipts')).json,{receipts:[]});const booking=(await x.call('/api/booking')).json;assert.equal(booking.settings.timezone,'America/Indiana/Indianapolis');assert.equal(booking.published,false);assert.equal(booking.guestReady,false);assert.equal(booking.url,null);
});
