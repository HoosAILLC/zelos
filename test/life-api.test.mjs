/** Authenticated HTTP wiring with synthetic records and an injected model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'zelos-life-api-'));
process.env.ZELOS_HOME=home;process.env.ZELOS_SECRETS_BACKEND='encrypted-file';process.env.ZELOS_LOG_LEVEL='silent';
const {createServer,listen}=await import('../core/server.mjs');
const database=await import('../core/db.mjs');
const {loadConfig}=await import('../core/config.mjs');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
async function fixture(t,choices=[],options={}){
 const db=database.open(':memory:');database.migrate(db);
 const defaults=loadConfig();const config={...defaults,model:{...defaults.model,baseUrl:'http://127.0.0.1:1/v1',protocol:'openai',model:'synthetic',keyRef:null},sweep:{...defaults.sweep,auto:false}};
 let calls=0;
 const server=createServer({db,config,assistantComplete:async()=>{calls++;if(!choices.length)throw Error('Unexpected model call');return {text:JSON.stringify(choices.shift()),stopReason:'stop'};},...options});
 const {port}=await listen(server,{port:0});const base=`http://127.0.0.1:${port}`;
 t.after(async()=>{server.zelos.assistant.stop();server.closeAllConnections();await new Promise(r=>server.close(r));database.close(db);});
 async function call(route,{method='GET',body,token=server.sessionToken,origin=base}={}){
  const res=await fetch(base+route,{method,headers:{...(token?{'X-Zelos-Token':token}:{}),Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const bytes=Buffer.from(await res.arrayBuffer());let json;try{json=JSON.parse(bytes);}catch{}
  return {status:res.status,json,bytes,headers:res.headers};
 }
 return {db,call,server,get calls(){return calls;}};
}
const mutations=['/finance/review','/progress/pdf','/assistant/jobs','/assistant/jobs/example/cancel','/finance/entities','/finance/accounts','/finance/import','/finance/transactions','/finance/invoices','/health-tracking/profile','/health-tracking/walking','/health-tracking/walking/import','/health-tracking/labs','/health-tracking/metrics','/health-tracking/plans','/health-tracking/plan-state','/health-tracking/groceries','/health-tracking/delete'];
test('new workspaces and downloads preserve private session and origin checks',async t=>{
 const ctx=await fixture(t);
 for(const route of mutations){assert.equal((await ctx.call('/api'+route,{method:'POST',body:{},token:null})).status,401,route);assert.equal((await ctx.call('/api'+route,{method:'POST',body:{},origin:'https://foreign.example'})).status,403,route);}
 for(const route of ['/finance/review','/progress','/conversations','/conversations/example','/assistant/jobs','/assistant/jobs/example/report.pdf','/finance','/finance/export','/health-tracking'])assert.equal((await ctx.call('/api'+route,{token:null})).status,401,route);
 assert.equal(ctx.calls,0);assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM assistant_jobs').get().n,0);
});
test('money and health writes persist exact values and export authenticated local data',async t=>{
 const ctx=await fixture(t);const post=(route,body)=>ctx.call(route,{method:'POST',body});
 const entity=await post('/api/finance/entities',{name:'Synthetic Studio',type:'company',defaultCurrency:'USD'});assert.equal(entity.status,200);
 const money=await post('/api/finance/transactions',{entityId:entity.json.entity.id,date:'2026-09-11',description:'Synthetic materials',amountCents:-1049,currency:'USD',category:'Supplies',status:'confirmed',kind:'expense'});assert.equal(money.status,200);
 const totals=await ctx.call('/api/finance');assert.equal(totals.json.summary.currencies[0].expenseCents,1049);
 const csv=await ctx.call('/api/finance/export');assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(csv.bytes.toString(),/Synthetic materials/);assert.match(csv.headers.get('cache-control'),/no-store/);
 assert.equal((await post('/api/health-tracking/walking',{date:'2026-09-11',steps:7200,distance:3,distanceUnit:'mi'})).status,200);
 const health=await ctx.call('/api/health-tracking');assert.equal(health.json.walking[0].steps,7200);
 assert.equal((await post('/api/health-tracking/walking',{date:'bad',steps:-1})).status,400);
 assert.equal((await ctx.call('/api/health-tracking')).json.walking.length,1);
});
test('weekly PDFs and assigned report artifacts are real local downloads',async t=>{
 const ctx=await fixture(t,[{tool:'weekly_report',args:{week:'2026-09-07',title:'Synthetic weekly report'}},{finish:'Created the weekly report.',status:'completed'}]);
 const row=database.upsertItem(ctx.db,{key:'done-test',kind:'task',bucket:'today',headline:'Synthetic completed work',sourceRefs:[],payload:{}}).id;
 database.setItemState(ctx.db,row,'done',{now:'2026-09-10T12:00:00Z'});
 const progress=await ctx.call('/api/progress?week=2026-09-07');assert.equal(progress.status,200);assert.equal(progress.json.entries.length,1);
 const pdf=await ctx.call('/api/progress/pdf',{method:'POST',body:{week:'2026-09-07',selectedIds:[row]}});assert.equal(pdf.status,200);assert.equal(pdf.bytes.subarray(0,5).toString(),'%PDF-');assert.match(pdf.headers.get('content-disposition'),/attachment/);
 const queued=await ctx.call('/api/assistant/jobs',{method:'POST',body:{prompt:'Create my weekly PDF report.'}});assert.equal(queued.status,202);
 const jobId=queued.json.job.id;let job;
 for(let i=0;i<100;i++){job=(await ctx.call('/api/assistant/jobs/'+jobId)).json.job;if(!['running','queued'].includes(job.status))break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(job.status,'completed');assert.equal(job.steps[0].status,'complete');assert.equal(ctx.calls,2);
 const artifact=await ctx.call(job.result.artifacts[0].download);assert.equal(artifact.status,200);assert.equal(artifact.bytes.subarray(0,5).toString(),'%PDF-');
 assert.equal((await ctx.call(`/api/assistant/jobs/${jobId}/reportXpdf`)).status,404);
});

test('separate guest listener exposes only the preview and closes with the private workspace',async t=>{
 const ctx=await fixture(t,[],{bookingGuestOrigin:'http://127.0.0.1:1'});
 const endpoint=await ctx.server.zelos.startGuest({port:0});
 const status=await ctx.call('/api/booking');assert.equal(status.json.guestReady,true);assert.equal(status.json.published,false);assert.equal(status.json.url,'http://127.0.0.1:1');
 const http=await import('node:http');
 const get=route=>new Promise((resolve,reject)=>{const req=http.get({agent:false,host:'127.0.0.1',port:endpoint.port,path:route,headers:{Host:'127.0.0.1:1'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
 assert.equal(await get('/'),200);assert.equal(await get('/api/state'),404);assert.equal(await get('/assets/icon.svg'),404);
 await ctx.server.zelos.stopBackgroundWork();await assert.rejects(get('/'),{code:'ECONNREFUSED'});
});
