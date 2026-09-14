/** Model-facing assigned-task context must respect the same content limits as Ask. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-assistant-privacy-'));
process.env.ZELOS_HOME=home;process.env.ZELOS_SECRETS_BACKEND='encrypted-file';process.env.ZELOS_LOG_LEVEL='silent';
const db_=await import('../core/db.mjs');const {DEFAULTS}=await import('../core/config.mjs');const {createServer}=await import('../core/server.mjs');const {enqueueJob,getJob}=await import('../core/assistant.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
async function fixture(t,privacy,baseUrl='http://127.0.0.1:1/v1'){
 const db=db_.open(':memory:');db_.migrate(db);const config=structuredClone(DEFAULTS);config.privacy={...config.privacy,...privacy};
 config.model={...config.model,protocol:'openai',baseUrl,model:'synthetic',keyRef:null};config.sweep.auto=false;
 const prompts=[];let count=0;
 const server=createServer({db,config,assistantComplete:async request=>{
  prompts.push(request.messages.map(message=>message.content).join('\n'));
  return {text:JSON.stringify(++count===1?{tool:'search_records',args:{query:'FictionalOrchid'}}:{finish:'Read the allowed source context.',status:'completed'}),stopReason:'stop'};
 }});
 t.after(()=>{server.zelos.assistant.stop();db_.close(db);});
 return {db,async run(){const queued=enqueueJob(db,{prompt:'Look up FictionalOrchid in my records'});await server.zelos.assistant.runNext();assert.equal(getJob(db,queued.id).status,'completed');assert.equal(prompts.length,2);return prompts[1];}};
}
test('assigned search does not expose message body excerpts when full-content sharing is off',async t=>{
 const ctx=await fixture(t,{sendBodies:false});
 db_.upsertMessage(ctx.db,{sourceId:'fictional',messageId:'one',direction:'in',subject:'FictionalOrchid planning',from:{email:'fictional@example.test'},date:'2026-09-11T10:00:00Z',snippet:'Visible preview.',text:'FICTIONAL_HIDDEN_MESSAGE_DETAIL_71 FictionalOrchid private body.'});
 assert.match(db_.search(ctx.db,'FictionalOrchid')[0].excerpt,/FICTIONAL_HIDDEN_MESSAGE_DETAIL_71/);
 const sent=await ctx.run();assert.match(sent,/Visible preview/);assert.doesNotMatch(sent,/FICTIONAL_HIDDEN_MESSAGE_DETAIL_71/);
});
test('assigned search does not expose calendar description excerpts when full-content sharing is off',async t=>{
 const ctx=await fixture(t,{sendBodies:false});
 db_.upsertEvent(ctx.db,{calendarId:'fictional',uid:'one',title:'FictionalOrchid planning',startsAt:'2026-09-11T10:00:00Z',description:'FICTIONAL_HIDDEN_EVENT_DETAIL_72 FictionalOrchid private description.'});
 assert.match(db_.search(ctx.db,'FictionalOrchid')[0].excerpt,/FICTIONAL_HIDDEN_EVENT_DETAIL_72/);
 const sent=await ctx.run();assert.match(sent,/FictionalOrchid planning/);assert.doesNotMatch(sent,/FICTIONAL_HIDDEN_EVENT_DETAIL_72/);
});
test('assigned search cannot bypass a body cap through a matching source excerpt',async t=>{
 const ctx=await fixture(t,{sendBodies:true,bodyChars:200});
 db_.upsertEvent(ctx.db,{calendarId:'fictional',uid:'one',title:'FictionalOrchid planning',startsAt:'2026-09-11T10:00:00Z',description:`Allowed opening. ${'neutral '.repeat(80)} FictionalOrchid FICTIONAL_BEYOND_LIMIT_73`});
 assert.match(db_.search(ctx.db,'FictionalOrchid')[0].excerpt,/FICTIONAL_BEYOND_LIMIT_73/);
 const sent=await ctx.run();assert.match(sent,/Allowed opening/);assert.doesNotMatch(sent,/FICTIONAL_BEYOND_LIMIT_73/);
});
test('ordinary assigned mail search with a hosted model still honors content sharing limits',async t=>{
 const ctx=await fixture(t,{sendBodies:false},'https://model.example.invalid/v1');
 db_.upsertMessage(ctx.db,{sourceId:'fictional',messageId:'hosted',direction:'in',subject:'FictionalOrchid planning',from:{email:'fictional@example.test'},date:'2026-09-11T10:00:00Z',snippet:'Visible preview.',text:'FICTIONAL_HIDDEN_HOSTED_BODY FictionalOrchid private body.'});
 const sent=await ctx.run();assert.match(sent,/Visible preview/);assert.doesNotMatch(sent,/FICTIONAL_HIDDEN_HOSTED_BODY/);
});
