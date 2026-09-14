import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,findButton,text,settle} from './helpers/ui-dom.mjs';
let fixtureId=0;
async function fixture(t,jobs=[]){
 const document=installDom(t);t.mock.method(globalThis,'setInterval',()=>0);
 const {api}=await import('../ui/lib/api.js');const calls=[];const handlers={jobs:async()=>({jobs}),assignJob:async prompt=>({job:{id:'new',prompt,status:'queued'}}),cancelJob:async id=>({job:{id,status:'cancelled'}}),jobReport:async()=>new Blob(['Synthetic report'],{type:'application/pdf'})};
 for(const name of Object.keys(handlers))t.mock.method(api,name,(...args)=>{calls.push({name,args});return handlers[name](...args);});
 const module=await import(`../ui/views/jobs.js?fixture=${++fixtureId}`);const view=document.body.appendChild(module.renderJobs());await settle();
 return {document,module,view,calls,handlers,field:view.querySelector('[aria-label="Task for Zelos"]')};
}
const job=(id,status,extra={})=>({id,prompt:`Synthetic task ${id}`,status,created_at:'2026-09-11T12:00:00Z',steps:[],result:null,...extra});
test('completed step artifacts stay accessible when a later task step fails or is cancelled',async t=>{
 const jobs=[job('report','failed',{steps:[{tool:'weekly_report',status:'complete',result:{download:'/api/assistant/jobs/report/report.pdf'}},{tool:'read_progress',status:'failed',error:'Could not read'}]}),job('draft','cancelled',{steps:[{tool:'draft_email',status:'complete',result:{reviewUrl:'#/mail/draft/draft_123',sent:false}}]})];
 const {view}=await fixture(t,jobs);
 assert.ok(findButton(view,'Download report'));
 const draft=view.querySelectorAll('a').find(link=>link.getAttribute('href')==='#/mail/draft/draft_123');assert.ok(draft);assert.equal(text(draft),'Review email draft');
 assert.match(text(view),/Could not finish/);assert.match(text(view),/Cancelled/);
});
test('artifact links are deduplicated and refused unless they match the allowed local destinations',async t=>{
 const artifact={download:'/api/assistant/jobs/report/report.pdf'};
 const {view}=await fixture(t,[job('report','completed',{result:{text:'Done',artifacts:[artifact,{download:'https://foreign.example/report.pdf'},{reviewUrl:'javascript:alert(1)'},{download:'/api/assistant/jobs/another/report.pdf'}]},steps:[{tool:'weekly_report',status:'complete',result:artifact}]}),job('unsafe','failed',{steps:[{tool:'draft_email',status:'complete',result:{reviewUrl:'#/mail/draft/../../settings'}}]})]);
 assert.equal(view.querySelectorAll('button').filter(button=>text(button)==='Download report').length,1);
 assert.equal(view.querySelectorAll('a').length,0);
});
test('assigning preserves text typed during an in-flight request and reports queued work truthfully',async t=>{
 const {view,field,handlers,calls}=await fixture(t);let finish;
 handlers.assignJob=prompt=>new Promise(resolve=>{finish=()=>resolve({job:{id:'new',prompt,status:'queued'}});});
 field.value='Prepare my weekly report';findButton(view,'Assign to Zelos').click();await settle();
 assert.equal(findButton(view,'Assign to Zelos').disabled,true);field.value='My next task, still being written';finish();await settle();
 assert.equal(field.value,'My next task, still being written');assert.equal(findButton(view,'Assign to Zelos').disabled,false);assert.match(text(view),/saved in Zelos/);assert.match(text(view),/Keep Zelos running/);assert.doesNotMatch(text(view),/Zelos is working/);
 assert.deepEqual(calls.find(call=>call.name==='assignJob').args,['Prepare my weekly report']);
});
test('failed assignment keeps the original task and permits a retry without auto-assignment',async t=>{
 const {view,field,handlers,calls}=await fixture(t);field.value='Do not lose this task';handlers.assignJob=async()=>{throw new Error('Spark is unavailable');};
 findButton(view,'Assign to Zelos').click();await settle();assert.equal(field.value,'Do not lose this task');assert.equal(findButton(view,'Assign to Zelos').disabled,false);assert.match(text(view),/Spark is unavailable/);assert.equal(calls.filter(call=>call.name==='assignJob').length,1);
});
test('task prompts and results render as text, and stopping never assigns another task',async t=>{
 const {view,handlers,calls}=await fixture(t,[job('one','running',{prompt:'<img src="https://tracker.example.test">',result:{text:'<script>not executable</script>'}})]);
 assert.equal(view.querySelectorAll('img').length,0);assert.equal(view.querySelectorAll('script').length,0);
 handlers.cancelJob=async id=>{handlers.jobs=async()=>({jobs:[job(id,'cancelled')]});return {job:{id,status:'cancelled'}};};
 findButton(view,'Stop task').click();await settle();assert.match(text(view),/Cancelled/);assert.equal(calls.filter(call=>call.name==='cancelJob').length,1);assert.equal(calls.some(call=>call.name==='assignJob'),false);
});

test('background task refresh preserves open work steps and keyboard focus when jobs are unchanged',async t=>{
  const {view,module,document}=await fixture(t,[job('report','completed',{steps:[{tool:'weekly_report',status:'complete',result:{download:'/api/assistant/jobs/report/report.pdf'}}]})]);
  const card=view.querySelector('.job-card'),details=card.querySelector('details'),download=findButton(card,'Download report');details.open=true;download.focus();
  module.renderJobs();await settle();
  assert.ok(view.querySelector('.job-card')===card);assert.equal(view.querySelector('details').open,true);assert.ok(document.activeElement===download);assert.equal(download.isConnected,true);
});

test('changing task progress preserves expanded details and returns focus to the same available action',async t=>{
  const steps=[{tool:'weekly_report',status:'complete',result:{download:'/api/assistant/jobs/report/report.pdf'}}];
  const {view,handlers,document,module,field}=await fixture(t,[job('report','running',{steps})]);
  view.querySelector('details').open=true;findButton(view,'Download report').focus();field.value='An unfinished next task';
  handlers.jobs=async()=>({jobs:[job('report','completed',{steps,result:{text:'Report finished'}})]});module.renderJobs();await settle();
  assert.match(text(view),/Report finished/);assert.equal(view.querySelector('details').open,true);
  assert.ok(document.activeElement===findButton(view,'Download report'));assert.equal(field.value,'An unfinished next task');
});

test('successful task refresh clears the previous connection error and keeps saved tasks available',async t=>{
  const {view,handlers,module}=await fixture(t,[job('report','completed')]);
  handlers.jobs=async()=>{throw new Error('Connection interrupted');};module.renderJobs();await settle();assert.match(text(view),/Connection interrupted/);assert.match(text(view),/Synthetic task report/);
  handlers.jobs=async()=>({jobs:[job('report','completed')]});module.renderJobs();await settle();assert.doesNotMatch(text(view),/Connection interrupted/);assert.match(text(view),/Synthetic task report/);
});
