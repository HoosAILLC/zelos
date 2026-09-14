import {el,button} from './dom.js';
import {request} from './api.js';
export const bankApi={status:()=>request('/api/finance/plaid'),action:(action,body={})=>request('/api/finance/plaid/'+action,{method:'POST',body})};
const note=text=>el('p',{class:'finance-note',text});
const field=(label,node)=>el('label',{class:'finance-field'},[el('span',{text:label}),node]);
const external=(text,href)=>el('a',{class:'btn quiet',text,href,target:'_blank',rel:'noopener noreferrer'});
function select(label,value,options,change){const n=el('select',{class:'input','aria-label':label},options.map(([value,text])=>el('option',{value,text})));n.value=value;n.addEventListener('change',()=>change(n.value));return n;}
const historyStart=()=>new Date(Date.now()-730*86400000).toISOString().slice(0,10);
const after=date=>new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
export function createBankPanel({getData,onChange,onClose}){
 const root=el('section',{class:'finance-panel money-bank-panel','aria-label':'Bank connections'});
 const state={data:null,busy:false,error:'',notice:'',setup:false,session:null,drafts:{},disconnect:null};
 async function refresh(){state.data=await bankApi.status();}
 async function run(fn){if(state.busy)return;state.busy=true;state.error='';paint();try{await fn();}catch(e){state.error=e.message;}finally{state.busy=false;paint();}}
 async function check(id){await run(async()=>{const r=await bankApi.action('complete',{id});state.notice=r.pending?'Finish the bank sign-in in the Plaid tab, then check again.':'Bank linked. Choose where each account belongs below.';if(!r.pending)state.session=null;await refresh();if(!r.pending)await onChange();});}
 function setup(){
  const client=el('input',{class:'input','aria-label':'Plaid client ID',autocomplete:'off',required:true});
  const secret=el('input',{class:'input','aria-label':'Plaid production secret',type:'password',autocomplete:'new-password',required:true});
  const form=el('form',{class:'money-bank-setup'},[
   el('span',{class:'money-eyebrow',text:'One-time setup'}),el('h3',{text:'Enable bank linking for your Zelos'}),
   note('Create or sign in to your Plaid developer account and activate real-account access through Trial or Production. Enable Transactions and your bank’s OAuth access. Then enter your application keys here.'),
   el('div',{class:'workspace-actions'},[external('Open Plaid dashboard ↗','https://dashboard.plaid.com/'),external('Trial setup guide ↗','https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan')]),
   el('div',{class:'workspace-form-grid'},[field('Client ID',client),field('Production secret',secret)]),
   note('Use the production secret, including for Trial. These are application keys, not your bank password. Zelos stores them in its encrypted credential store on the computer running Zelos and never displays them again.'),
   button('Save Plaid setup',{class:'btn solid',type:'submit',disabled:state.busy})]);
  form.addEventListener('submit',event=>{event.preventDefault();const body={clientId:client.value.trim(),secret:secret.value.trim()};client.value='';secret.value='';run(async()=>{await bankApi.action('configure',body);body.secret='';state.setup=false;state.notice='Plaid keys saved. Continue to Plaid to verify access and choose a bank.';await refresh();});});
  return form;
 }
 function accountRow(bank,a){
  const entities=getData()?.entities||[];
  if(a.mapping){const local=state.data.existingAccounts.find(x=>x.id===a.mapping.accountId),entity=entities.find(x=>x.id===local?.entityId);return el('div',{class:'money-bank-account'},[el('strong',{text:a.name+(a.mask?' • '+a.mask:'')}),note(`${entity?.name||'Workspace'} · ${local?.name||'Linked account'} · importing from ${a.mapping.fromDate}`)]);}
  const key=bank.id+':'+a.id,d=state.drafts[key]||{remoteId:a.id,entityId:'',accountId:'',fromDate:historyStart()};state.drafts[key]=d;
  const candidates=state.data.existingAccounts.filter(x=>x.entityId===d.entityId&&x.currency===a.currency);
  const date=el('input',{class:'input','aria-label':'Import from '+a.name,type:'date',value:d.fromDate});date.addEventListener('input',()=>{d.fromDate=date.value;});
  return el('div',{class:'money-bank-account'},[el('strong',{text:a.name+(a.mask?' • '+a.mask:'')+' · '+(a.currency||'Currency unavailable')}),
   !a.currency?note('This account cannot be imported without a supported currency.'):el('div',{class:'workspace-form-grid'},[
    field('Belongs to',select('Workspace for '+a.name,d.entityId,[['','Skip this account'],...entities.map(e=>[e.id,e.name+(e.type==='company'?' · Business':' · Personal')])],v=>{d.entityId=v;d.accountId='';d.fromDate=historyStart();paint();})),
    d.entityId&&field('Account in Zelos',select('Match account '+a.name,d.accountId,[['','Create a new account'],...candidates.map(x=>[x.id,x.name])],v=>{d.accountId=v;const old=candidates.find(x=>x.id===v);d.fromDate=old?.latestDate?after(old.latestDate):historyStart();paint();})),
    d.entityId&&field('Import transactions from',date)]),
   d.entityId&&note(d.accountId?'Existing transactions stay as they are. Sync starts after the last recorded day to prevent overlapping imports.':'Already imported this account? Match it to the existing account above to avoid counting its statement twice.')]);
 }
 function bankCard(bank){const unmapped=bank.accounts.filter(a=>!a.mapping);return el('article',{class:'money-bank-card'},[
  el('div',{class:'money-card-head'},[el('div',{},[el('h3',{text:bank.institution}),note(bank.lastSync?'Last synced '+new Date(bank.lastSync).toLocaleString():'Not synced yet')]),el('span',{class:'money-bank-badge',text:'Read access'})]),
  ...bank.accounts.map(a=>accountRow(bank,a)),!bank.accounts.length&&note('No supported checking, savings, or credit card accounts were returned.'),
  el('div',{class:'workspace-actions'},[
   unmapped.length>0&&button('Save account assignments',{class:'btn solid',disabled:state.busy,onClick:()=>run(async()=>{const mappings=unmapped.map(a=>state.drafts[bank.id+':'+a.id]).filter(d=>d?.entityId);await bankApi.action('map',{itemId:bank.id,mappings});state.notice='Accounts assigned. Click Sync transactions to bring in their activity.';await refresh();await onChange();})}),
   bank.accounts.some(a=>a.mapping)&&button('Sync transactions',{class:'btn solid',disabled:state.busy,onClick:()=>run(async()=>{const r=await bankApi.action('sync',{itemId:bank.id});state.notice=`Sync complete: ${r.imported} added, ${r.updated} updated, ${r.excluded} removed entries excluded. If your bank is preparing history, sync again shortly.`;await refresh();await onChange();})}),
   button('Disconnect bank',{class:'btn quiet',disabled:state.busy,onClick:()=>{state.disconnect=bank.id;paint();}})]),
  state.disconnect===bank.id&&el('div',{class:'money-bank-confirm'},[note('Revoke this Plaid connection? Imported transactions will stay in Zelos.'),button('Yes, disconnect',{class:'btn solid',disabled:state.busy,onClick:()=>run(async()=>{await bankApi.action('disconnect',{itemId:bank.id});state.disconnect=null;state.notice='Bank disconnected. Your imported records were kept.';await refresh();await onChange();})}),button('Keep connected',{class:'btn quiet',disabled:state.busy,onClick:()=>{state.disconnect=null;paint();}})])]);}
 function paint(){
  const children=[el('div',{class:'money-card-head'},[el('div',{},[el('span',{class:'money-eyebrow',text:'Connected money'}),el('h2',{text:'Link your bank. Know your money.'})]),button('Close bank connections',{class:'btn quiet',disabled:state.busy,onClick:onClose})]),
   note('Connect Chase, Amex, or another supported bank through Plaid. Authorize data access in the bank’s sign-in flow, then assign each account to Personal or a company. This integration cannot make payments.'),
   note('Plaid processes the financial data you authorize. Zelos keeps imported records and encrypted connection credentials on the computer running Zelos. Transactions sync when you click Sync transactions. Pending charges appear separately in Money and stay out of posted totals. Bank balances are cached snapshots, not guaranteed real-time figures.'),
   state.error&&el('p',{role:'alert',class:'finance-error',text:state.error}),state.notice&&el('p',{role:'status',class:'finance-notice',text:state.notice}),state.busy&&note('Working…')];
  if(state.data){
   if(!state.data.configured||state.setup)children.push(setup());
   else children.push(el('div',{class:'workspace-actions'},[button('Continue to Plaid',{class:'btn solid',disabled:state.busy,onClick:()=>run(async()=>{state.session=await bankApi.action('start');state.notice='Open the secure sign-in below. When finished, return here and click “I finished linking.”';})}),button('Edit Plaid setup',{class:'btn quiet',disabled:state.busy,onClick:()=>{state.setup=true;paint();}})]));
   if(state.session)children.push(el('div',{class:'money-bank-session'},[external('Open secure bank sign-in ↗',state.session.url),button('I finished linking',{class:'btn solid',disabled:state.busy,onClick:()=>check(state.session.id)}),note('The sign-in link lasts 30 minutes. Keep this Zelos tab open while you link.') ]));
   for(const s of state.data.sessions||[])if(s.id!==state.session?.id)children.push(el('div',{class:'money-bank-session'},[note('An earlier bank sign-in is waiting. If you completed it, retrieve your accounts here.'),button('Check completed sign-in',{class:'btn quiet',disabled:state.busy,onClick:()=>check(s.id)})]));
   children.push(...state.data.items.map(bankCard));
  }
  root.replaceChildren(...children.filter(Boolean));
 }
 run(refresh);return root;
}
