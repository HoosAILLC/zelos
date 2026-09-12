/** Browser-only transport for the real development UI. No requests, credentials,
 * model calls, sending, checkout or persistent storage. Every mutation is local.
 * Unsupported operations fail with an explicit demo limitation. */
import seed from './sample-data.js';
export {api} from './endpoints.js';
export const hasToken=()=>true;
export class ApiError extends Error{constructor(message,{status=400,path=''}={}){super(message);this.name='ApiError';this.status=status;this.path=path;}}
export const isMissingRoute=e=>e instanceof ApiError&&[404,501].includes(e.status);
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>new Date().toISOString();
let sequence=0;
const id=prefix=>`demo_${prefix}_${++sequence}`;
const today=new Date();const origin=new Date(seed.capturedAt);const days=Math.round((Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())-Date.UTC(origin.getFullYear(),origin.getMonth(),origin.getDate()))/86400000);
const monthDelta=(today.getFullYear()-origin.getFullYear())*12+today.getMonth()-origin.getMonth();
function rebase(value){
 if(Array.isArray(value))return value.map(rebase);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebase(v)]));
 if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)){const d=new Date(value.slice(0,10)+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)+value.slice(10);}
 if(typeof value==='string'&&/^\d{4}-\d{2}$/.test(value)){const [y,m]=value.split('-').map(Number);return new Date(Date.UTC(y,m-1+monthDelta,1)).toISOString().slice(0,7);}
 return value;
}
const records=rebase(clone(seed.routes));
const messages=rebase(clone(seed.messages));
const captures=rebase(clone(seed.captures));
const allItems=[...records['/api/state'].items,...records['/api/state'].finished];
const history=new Map(),drafts=new Map();
const listeners=new Set();
const checkedAt=now();
records['/api/state'].runs.last.ended_at=checkedAt;
records['/api/state'].briefing.lastChecked=checkedAt;
records['/api/state'].briefing.asOf=checkedAt;
const blocked='This action needs the installed app. The website demo uses fictional records, runs only in this tab, and never connects accounts, uploads files, sends email or makes purchases.';
function reject(path){throw new ApiError(blocked,{status:501,path});}
function findItem(itemId){const item=allItems.find(x=>x.id===itemId);if(!item)throw new ApiError('Sample item not found.',{status:404});return item;}
function emit(event,data){for(const fn of listeners)fn(event,clone(data));}
function board(){
 const b=clone(records['/api/state']);b.items=allItems.filter(x=>['open','snoozed'].includes(x.state));b.finished=allItems.filter(x=>x.state==='done');b.now=now();b.notes=captures.filter(x=>!x.processed_at);b.counts={};
 for(const item of b.items.filter(x=>x.state==='open'))b.counts[item.bucket]=(b.counts[item.bucket]||0)+1;
 b.briefing.deadlines=b.briefing.deadlines.filter(x=>findItem(x.id).state==='open');b.briefing.counts.deadlines=b.items.filter(x=>x.due_at&&x.state==='open'&&x.due_at.slice(0,10)<=new Date(Date.now()+7*86400000).toISOString().slice(0,10)).length;
 b.briefing.replies=messages.filter(m=>m.direction==='in').slice(0,3).map(m=>({id:m.id,title:m.subject,person:m.from_name,receivedAt:m.sent_at,href:'#/mail/'+m.id}));b.briefing.counts.replies=b.briefing.replies.length;
 return b;
}
function shopping(){const s=clone(records['/api/shopping']);s.items=clone(records['/api/health-tracking'].groceryItems);const wanted=s.items.filter(x=>x.state==='needed');s.groups=wanted.map(x=>({name:x.name,quantityText:x.quantity,itemIds:[x.id],estimatedMinor:Math.round((x.estimatedCost||0)*100),unknownPrices:x.estimatedCost==null?1:0,meals:[]}));s.totals.items=wanted.length;s.totals.estimatedMinor=wanted.reduce((n,x)=>n+Math.round((x.estimatedCost||0)*100),0);return s;}
function finance(params){
 const f=clone(records['/api/finance']),entity=params.get('entityId')||'',month=params.get('month')||today.toISOString().slice(0,7);
 const all=f.transactions.filter(x=>!entity||x.entityId===entity);f.transactions=all.filter(x=>x.date.startsWith(month));f.invoices=f.invoices.filter(x=>!entity||x.entityId===entity);
 f.summary.month=month;f.summary.entityId=entity;
 f.summary.currencies=[...new Set([...all,...f.invoices].map(x=>x.currency))].map(currency=>{
  const tx=f.transactions.filter(x=>x.currency===currency&&x.status!=='excluded'&&x.kind!=='transfer'),invoices=f.invoices.filter(x=>x.currency===currency&&!['paid','cancelled'].includes(x.status));
  const totals=rows=>{const incomeCents=rows.filter(x=>x.amountCents>0).reduce((n,x)=>n+x.amountCents,0),expenseCents=-rows.filter(x=>x.amountCents<0).reduce((n,x)=>n+x.amountCents,0);return {incomeCents,expenseCents,netCents:incomeCents-expenseCents};};
  const categories=[...new Set(tx.map(x=>x.category))].map(category=>({category,...totals(tx.filter(x=>x.category===category))})).sort((a,b)=>b.expenseCents-a.expenseCents);
  const months=Array.from({length:12},(_,i)=>{const d=new Date(month+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-11+i);const key=d.toISOString().slice(0,7);return {month:key,...totals(all.filter(x=>x.currency===currency&&x.status!=='excluded'&&x.kind!=='transfer'&&x.date.startsWith(key)))};});
  const sumInvoices=(direction,overdue=false)=>invoices.filter(x=>x.direction===direction&&(!overdue||x.dueDate<now().slice(0,10))).reduce((n,x)=>n+x.amountCents,0);
  return {currency,...totals(tx),reviewCount:tx.filter(x=>x.status==='review').length,categories,months,receivableCents:sumInvoices('receivable'),payableCents:sumInvoices('payable'),overdueCents:sumInvoices('receivable',true),overduePayableCents:sumInvoices('payable',true)};
 });return f;
}
function progress(params){
 const data=clone(records['/api/progress']);const date=new Date((params.get('week')||now().slice(0,10))+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));
 const start=date.toISOString().slice(0,10);const dayAt=n=>new Date(+date+n*86400000).toISOString().slice(0,10);const next=dayAt(7);
 data.week=start;data.start=start;data.end=dayAt(6);data.next=next;data.entries=data.entries.filter(x=>x.day>=start&&x.day<next);data.asOf=now();
 const completed=data.entries.filter(x=>x.status==='completed');
 const daily=Array.from({length:7},(_,i)=>({date:dayAt(i),label:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i],count:completed.filter(x=>x.day===dayAt(i)).length}));
 const groups=key=>[...new Set(completed.map(x=>x[key]))].map(value=>({key:value,label:value||'Unassigned',count:completed.filter(x=>x[key]===value).length}));
 data.totals={completed:completed.length,activeDays:daily.filter(x=>x.count).length,completionEvents:completed.reduce((n,x)=>n+x.completionEvents,0),daily,buckets:groups('bucket'),companies:groups('company')};data.completionEvents=data.totals.completionEvents;return data;
}
function search(q,limit=30,includeHistory=false){const words=q.toLowerCase().split(/\s+/).filter(Boolean);const rows=[...messages.map(m=>({kind:'message',id:m.id,title:m.subject,excerpt:m.body,date:m.sent_at,from_name:m.from_name,from_email:m.from_email})),...allItems.map(i=>({kind:'item',id:i.id,title:i.headline,excerpt:i.why,date:i.due_at,bucket:i.bucket,state:i.state})),...captures.map(c=>({kind:'capture',id:c.id,title:c.text,excerpt:c.text,date:c.created_at})),...records['/api/state'].events.map(e=>({kind:'event',id:e.id,title:e.title,excerpt:e.description||e.location,date:e.starts_at}))];const matches=rows.filter(x=>(x.kind!=='item'||includeHistory||['open','snoozed'].includes(x.state))&&words.every(word=>`${x.title} ${x.excerpt}`.toLowerCase().includes(word)));const selected=[];const groups=['item','capture','event','message'].map(kind=>matches.filter(x=>x.kind===kind));while(selected.length<limit&&groups.some(g=>g.length))for(const group of groups)if(group.length&&selected.length<limit)selected.push(group.shift());return selected.map(x=>({...x,ref:({message:'msg',event:'evt',capture:'cap',item:'item'})[x.kind]+':'+x.id,excerpt:x.excerpt?.slice(0,700)||'',snippet:x.excerpt?.slice(0,300)||''}));}
function upsert(list,body,prefix){const record={...body,id:body.id||id(prefix),createdAt:body.createdAt||now(),updatedAt:now()};const index=list.findIndex(x=>x.id===record.id);if(index>=0)list[index]={...list[index],...record};else list.unshift(record);return record;}
export async function request(path,{method='GET',body,signal}={}){
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 await delay(60);if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 const url=new URL(path,'https://demo.invalid'),route=url.pathname,p=url.searchParams;
 if(method==='GET'){
  if(route==='/api/state')return clone(board());
  if(route==='/api/shopping')return shopping();
  if(route==='/api/finance')return finance(p);
  if(route==='/api/progress')return progress(p);
  if(route==='/api/search')return {q:p.get('q')||'',results:search(p.get('q')||'',Number(p.get('limit'))||30,p.get('includeHistory')==='1')};
  if(route==='/api/events'){const start=p.get('start')||p.get('from')||'',end=p.get('end')||p.get('to')||'9999';return {events:clone(records['/api/state'].events.filter(e=>e.starts_at>=start&&e.starts_at<=end)),start,end,limited:false};}
  if(route==='/api/mail/messages'){const q=(p.get('q')||'').toLowerCase(),scope=p.get('scope')||'important';const list=messages.filter(m=>(scope==='all'||(scope==='important')===m.importance.important)&&`${m.subject} ${m.body} ${m.from_name}`.toLowerCase().includes(q));return {messages:clone(list.slice(0,100)),accounts:[{id:'s_sample',name:'Quillon Row · sample inbox',email:'alex@quillonrow.example'}],nextCursor:null,scope,counts:{all:messages.length,important:messages.filter(m=>m.importance.important).length,filtered:messages.filter(m=>!m.importance.important).length}};}
  if(route.startsWith('/api/mail/messages/')){const m=messages.find(x=>x.id===decodeURIComponent(route.split('/').pop()));return {message:clone(m),accounts:[],accountId:'s_sample',importance:m?.importance,replyTo:m?.from_email,draft:[...drafts.values()].find(d=>d.message_id===m?.id)||null};}
  if(route.startsWith('/api/mail/drafts/')){const d=drafts.get(route.split('/').pop());return {draft:clone(d),message:clone(messages.find(m=>m.id===d?.message_id))};}
  if(/\/api\/items\/[^/]+\/history$/.test(route))return {entries:clone(history.get(route.split('/')[3])||[]),nextBefore:null};
  if(/\/api\/items\/[^/]+\/evidence$/.test(route)){const item=findItem(route.split('/')[3]);return {item:clone(item),status:'Illustrative sample evidence',correction:item.payload?.userCorrection||null,sources:search(item.headline.includes('Northstar')?'Northstar':item.person||'scope',3).filter(x=>x.kind==='message').map(x=>({available:true,author:x.from_name,date:x.date,quote:x.excerpt,href:'#/mail/'+x.id})),reviewRequired:true};}
  if(route==='/api/booking/slots'){const settings=records['/api/booking'].settings;const slots=[];for(let n=1;n<=7;n++){const d=new Date();d.setDate(d.getDate()+n);if(!settings.weekdays.includes(d.getDay()))continue;d.setHours(10,0,0,0);slots.push({startsAt:d.toISOString(),endsAt:new Date(+d+settings.durationMinutes*60000).toISOString()});}return {slots,timezone:settings.timezone,durationMinutes:settings.durationMinutes};}
  if(route==='/api/sample-data')return {installed:true,counts:{messages:messages.length,events:records['/api/state'].events.length,items:allItems.length}};
  if(route==='/api/updates')return {currentVersion:'1.8.4',latest:null,checkedAt:null,canInstall:false};
  if(route==='/api/local/probe')return {found:[],note:'Live AI connections are available in the installed app.'};
  if(records[route]!==undefined)return clone(records[route]);
  return reject(path);
 }
 if(/\/api\/items\/[^/]+\/state$/.test(route)){
  const item=findItem(route.split('/')[3]),before=item.state;item.state=body.state;item.state_at=now();item.updated_at=now();item.snoozed_until=body.state==='snoozed'?(body.until??new Date(Date.now()+86400000).toISOString()):null;
  const entries=history.get(item.id)||[];entries.unshift({id:++sequence,recorded_at:now(),origin:'user',kind:'changed',changes:[{field:'state',before,after:item.state}]});history.set(item.id,entries);
  if(body.state==='done'&&before!=='done'){const progress=records['/api/progress'];progress.entries.unshift({id:item.id,eventId:sequence,title:item.headline,description:item.why,bucket:item.bucket,bucketLabel:'Today',company:'Quillon Row Studio',day:now().slice(0,10),completedAt:now(),origin:'user',completionEvents:1,status:'completed'});progress.totals.completed++;}
  if(body.state!=='done'&&before==='done'){const progress=records['/api/progress'];progress.entries=progress.entries.filter(x=>x.id!==item.id);progress.totals.completed=Math.max(0,progress.totals.completed-1);}
  return {ok:true,item:clone(item)};
 }
 if(/\/api\/items\/[^/]+\/correction$/.test(route)){const item=findItem(route.split('/')[3]);if(body.decision==='corrected'){item.headline=String(body.headline||item.headline);item.due_at=body.dueAt||null;}if(body.decision==='dismissed')item.state='dismissed';item.payload={...item.payload,userCorrection:{...body,updated_at:now()}};item.updated_at=now();return {item:clone(item)};}
 if(route==='/api/capture'){const record={id:id('note'),text:String(body.text).slice(0,10000),created_at:now(),processed_at:null};captures.unshift(record);return {ok:true,capture:clone(record)};}
 if(route==='/api/sweep'){emit('started',{runId:id('check'),mode:'demo',startedAt:now()});setTimeout(()=>emit('done',{ok:true,finishedAt:now(),mode:'demo'}),500);return {ok:true,started:true};}
 if(route==='/api/shopping/item'){const item=records['/api/health-tracking'].groceryItems.find(x=>x.id===body.id);if(item){item.state=body.state;item.updatedAt=now();}return shopping();}
 if(route==='/api/booking/settings'){Object.assign(records['/api/booking'].settings,body,{updatedAt:now()});return clone(records['/api/booking']);}
 if(route==='/api/booking/cancel'){const b=records['/api/booking'].bookings.find(x=>x.id===body.id);if(b){b.state='cancelled';b.cancelledAt=now();}return clone(records['/api/booking']);}
 if(route==='/api/health-tracking/profile'){Object.assign(records['/api/health-tracking'].profile,body);return clone(records['/api/health-tracking']);}
 const healthCollections={walking:'walking',labs:'labs',metrics:'metrics',plans:'plans',groceries:'groceryItems'};
 const healthKey=healthCollections[route.split('/').pop()];
 if(route.startsWith('/api/health-tracking/')&&healthKey){const value=upsert(records['/api/health-tracking'][healthKey],body,healthKey);return {...clone(records['/api/health-tracking']),record:value};}
 if(route==='/api/health-tracking/plan-state'){for(const plan of records['/api/health-tracking'].plans)for(const entry of plan.entries)if(entry.id===body.id||entry.id===body.entryId)entry.state=body.state;return clone(records['/api/health-tracking']);}
 if(route==='/api/health-tracking/delete'){const key=healthCollections[body.kind]||({metric:'metrics',lab:'labs',plan:'plans',grocery:'groceryItems'})[body.kind];if(key)records['/api/health-tracking'][key]=records['/api/health-tracking'][key].filter(x=>x.id!==body.id);return clone(records['/api/health-tracking']);}
 const financeKey=({entities:'entities',accounts:'accounts',transactions:'transactions',invoices:'invoices'})[route.split('/').pop()];
 if(route.startsWith('/api/finance/')&&financeKey){const value=upsert(records['/api/finance'][financeKey],body,financeKey);return {ok:true,record:value};}
 if(route==='/api/mail/importance'){const m=messages.find(x=>x.id===(body.id||body.messageId));const importance={important:body.important,reason:'Your preference in this demo'};if(m)m.importance=importance;return {importance,learned:false};}
 if(route==='/api/mail/draft'||route==='/api/mail/save'){const m=messages.find(x=>x.id===body.messageId);const draft={id:body.draftId||id('draft'),message_id:body.messageId,account_id:'s_sample',to_email:body.to||m?.from_email||'',subject:body.subject||`Re: ${m?.subject||'Your project'}`,body:body.body||'Example draft — Thanks for the update. I will review the revised scope and confirm the next steps before our meeting.\n\nAlex',state:'draft',updated_at:now()};drafts.set(draft.id,draft);return {draft:clone(draft)};}
 if(route.startsWith('/api/drafts/')){const d=records['/api/state'].drafts.find(x=>x.id===route.split('/').pop());if(d)Object.assign(d,body,{updated_at:now()});return {draft:clone(d)};}
 if(route==='/api/assistant/jobs'){
  const answer=answerFor(body.prompt);const job={id:id('job'),prompt:body.prompt,status:'completed',created_at:now(),updated_at:now(),finished_at:now(),steps:[{tool:'search_sample_records',status:'complete'},{tool:'prepare_example_result',status:'complete'}],result:{text:answer.text},error:null};records['/api/assistant/jobs'].jobs.unshift(job);return {job:clone(job)};
 }
 if(route==='/api/config'){const allowed={...records[route].config,ui:{...records[route].config.ui,...body.ui}};records[route].config=allowed;if(!body.ui)return reject(path);return clone(records[route]);}
 return reject(path);
}
function answerFor(question){
 const q=String(question||'').toLowerCase();let term='',text='';
 if(/northstar|meeting|prepare|project|review/.test(q)){term='Northstar';text='## Northstar launch review\n\nConfirm three decisions: the final presentation, print quantities, and who owns the content handoff. Bring the revised deck and scope. Leave ten minutes to agree on owners and dates.\n\nThe value: your meeting prep starts from saved project context, so you spend less time finding the thread.';}
 else if(/money|finance|income|spend|studio|invoice/.test(q)){term='invoice';const c=finance(new URLSearchParams()).summary.currencies[0];text=`## Your studio at a glance\n\nRecorded income: **$${(c.incomeCents/100).toLocaleString()}**. Recorded expenses: **$${(c.expenseCents/100).toLocaleString()}**. Net cash flow: **$${(c.netCents/100).toLocaleString()}**.\n\nOpen Money to inspect transactions, invoices, categories, and cash flow. These totals summarize the sample records; they are not a live bank connection.`;}
 else if(/health|meal|dinner|grocer|walk|food/.test(q)){term='dinner';text='## A simpler plan for the week\n\nStart with the saved meal plan: a roasted vegetable bowl, lemon chicken with greens, and a relaxed afternoon walk. Your grocery list separates what you need from what you already have.\n\nOpen Health to explore the plan and Groceries to mark ingredients as bought. In the installed app, AI can prepare a plan from the preferences and records you choose.';}
 else if(/progress|complete|report|finished/.test(q)){text=`## Work you can point to\n\nYou have **${records['/api/progress'].totals.completed} completed items** in this sample week. They include presentation reviews, scope updates, production approvals, and studio accounts.\n\nOpen Progress to inspect the completion history. In the installed app, choose work for a weekly report and create a PDF.`;}
 else if(/cedar|decision/.test(q)){term='Cedar';text='## Cedar House decisions\n\nConfirm the oak finish, check lighting lead times, and reconcile the deposit with the revised scope. Ask Owen for the preferred installation window before agreeing to a date.\n\nThis brings decisions and open questions back into one place, instead of leaving them scattered across old conversations.';}
 else if(/week|today|attention|priorit|promise|next|day/.test(q)){term='Northstar';text='## Start with what needs you\n\n1. Resolve the overlapping shop-drawing review and timber delivery.\n2. Approve the Northstar launch presentation.\n3. Send the revised Thistlebank scope.\n4. Check the promises waiting on other people.\n\nOpen Now for the briefing, Calendar for the overlap, and Promises for follow-ups.';}
 else {return {text:'This website uses prepared example answers, not a live AI model. Try **“Prepare me for the Northstar review”**, **“What needs my attention this week?”**, **“How is the studio doing?”**, or **“Plan dinners for the week.”**\n\nIn the installed app, Zelos can answer your own questions using the records you connect and the AI provider you choose.',sources:[]};}
 return {text:'*Example answer · fictional workspace · no live AI call*\n\n'+text,sources:term?search(term,3):[]};
}
export async function openStream(path,{body,signal,onEvent}={}){
 if(path==='/api/sweep/stream')return new Promise(resolve=>{listeners.add(onEvent);onEvent('hello',{running:false});const stop=()=>{listeners.delete(onEvent);resolve();};if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});});
 if(path!=='/api/ask')return reject(path);
 const answer=answerFor(body.question),threadId=body.threadId||id('thread'),answerId=id('answer');
 let thread=records['/api/conversations'].threads.find(t=>t.id===threadId);
 if(!thread){thread={id:threadId,title:body.question,created_at:now(),updated_at:now()};records['/api/conversations'].threads.unshift(thread);records['/api/conversations/'+threadId]={thread,messages:[]};}
 const conversation=records['/api/conversations/'+threadId];conversation.messages.push({id:id('question'),role:'user',content:body.question,created_at:now(),state:'complete'});
 const message={id:answerId,role:'assistant',content:'',created_at:now(),state:'streaming',sources:answer.sources};conversation.messages.push(message);
 onEvent('conversation',{id:threadId,answerId});onEvent('sources',answer.sources);
 for(const chunk of answer.text.match(/.{1,38}(?:\s|$)|.{1,38}/gs)||[]){if(signal?.aborted){message.state='interrupted';return;}message.content+=chunk;onEvent('delta',{text:chunk});await delay(18);}
 message.state='complete';onEvent('done',{stopReason:'stop',model:'Prepared example'});
}
function pdfBlob(lines){
 const clean=value=>String(value).normalize('NFKD').replace(/[^\x20-\x7E]/g,' ').replace(/[()\\]/g,'\\$&');
 const wrapped=lines.flatMap(line=>String(line).match(/.{1,88}(?:\s|$)|.{1,88}/g)||['']).slice(0,46);
 const content='BT /F1 11 Tf 50 790 Td 15 TL '+wrapped.map((line,i)=>(i?'T* ':'')+'('+clean(line)+') Tj').join('\n')+' ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream'];
 let out='%PDF-1.4\n',offsets=[0];objects.forEach((object,i)=>{offsets.push(out.length);out+=(i+1)+' 0 obj\n'+object+'\nendobj\n';});const xref=out.length;out+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';return new Blob([out],{type:'application/pdf'});
}
export async function download(path,{body}={}){
 if(path.startsWith('/api/finance/export')){const rows=finance(new URL(path,'https://demo.invalid').searchParams).transactions;const cell=value=>{let v=String(value??'');if(/^[\s]*[=+@-]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};return new Blob([['Date,Description,Amount,Currency',...rows.map(x=>[x.date,x.description,x.amountCents/100,x.currency].map(cell).join(','))].join('\n')],{type:'text/csv'});}
 if(path==='/api/progress/pdf'){const p=progress(new URLSearchParams({week:body?.week||''})),selected=p.entries.filter(x=>x.status==='completed'&&body?.selectedIds?.includes(x.id));return pdfBlob([body?.title||'Weekly progress','ZELOS WEBSITE DEMO - fictional records','Week of '+p.week,selected.length+' selected completed items','',...selected.flatMap(x=>[body.includeTitles?x.title:'Completed item',...(body.includeDetails?[x.description]:[]),...(body.includeCompanies?[x.company]:[])]),'','Demonstration export. Reload the demo to reset sample records.']);}
 if(/\/api\/assistant\/jobs\/[^/]+\/report.pdf$/.test(path)){const job=records['/api/assistant/jobs'].jobs.find(x=>x.id===path.split('/')[4]);if(job)return pdfBlob(['ZELOS WEBSITE DEMO - fictional records',job.prompt,'',job.result?.text||'Sample task result']);}
 return reject(path);
}
