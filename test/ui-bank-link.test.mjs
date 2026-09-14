import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,text,findButton,settle} from './helpers/ui-dom.mjs';
async function fixture(t,data){const document=installDom(t),module=await import('../ui/lib/bank-link.js');const old={...module.bankApi},calls=[];let change=0;
 module.bankApi.status=async()=>data;module.bankApi.action=async(action,body)=>{calls.push({action,body:structuredClone(body)});if(action==='configure')data.configured=true;if(action==='start')return {id:'session',url:'https://secure.plaid.com/hl/test'};if(action==='complete')return {pending:true};if(action==='sync')return {imported:2,updated:0,excluded:0};return {};};
 t.after(()=>Object.assign(module.bankApi,old));const root=document.body.appendChild(module.createBankPanel({getData:()=>({entities:[{id:'personal',name:'Personal',type:'personal'},{id:'company',name:'HoosAI',type:'company'}]}),onChange:()=>{change++;},onClose:()=>root.remove()}));await settle();
 return {root,calls,click:name=>{const n=findButton(root,name);assert.ok(n,name);n.click();},input:(label,value)=>{const n=root.querySelector(`[aria-label="${label}"]`);assert.ok(n,label);n.value=value;n.fire(n.tag==='select'?'change':'input');},change:()=>change};}
test('setup stores keys only on submit, clears the form, then offers a real hosted link',async t=>{
 const f=await fixture(t,{configured:false,items:[],sessions:[],existingAccounts:[]});assert.match(text(f.root),/One-time setup/);
 f.input('Plaid client ID','a'.repeat(24));f.input('Plaid production secret','b'.repeat(30));assert.equal(f.calls.length,0);f.root.querySelector('form').fire('submit');await settle();
 assert.equal(f.calls[0].action,'configure');assert.equal(f.calls[0].body.secret,'b'.repeat(30));assert.equal(f.root.querySelector('[aria-label="Plaid production secret"]'),null);
 f.click('Continue to Plaid');await settle();assert.ok(f.root.querySelectorAll('a').some(x=>x.getAttribute('href')==='https://secure.plaid.com/hl/test'&&x.getAttribute('rel')==='noopener noreferrer'));
 f.click('I finished linking');await settle();assert.match(text(f.root),/Finish the bank sign-in/);
});
test('account assignment is explicit and matching an imported account advances the cutoff',async t=>{
 const data={configured:true,sessions:[],existingAccounts:[{id:'existing',entityId:'personal',name:'Old Amex',currency:'USD',latestDate:'2026-09-08'}],items:[{id:'bank',institution:'American Express',accounts:[{id:'a',name:'Gold',currency:'USD',mapping:null}]}]};const f=await fixture(t,data);
 assert.equal(f.root.querySelector('[aria-label="Workspace for Gold"]').value,'');f.input('Workspace for Gold','personal');f.input('Match account Gold','existing');assert.equal(f.root.querySelector('[aria-label="Import from Gold"]').value,'2026-09-09');
 f.click('Save account assignments');await settle();assert.deepEqual(f.calls.at(-1),{action:'map',body:{itemId:'bank',mappings:[{remoteId:'a',entityId:'personal',accountId:'existing',fromDate:'2026-09-09'}]}});assert.equal(f.change(),1);
});
test('sync reports actual outcomes and disconnect requires its concrete confirmation',async t=>{
 const f=await fixture(t,{configured:true,sessions:[],existingAccounts:[],items:[{id:'bank',institution:'Bank',accounts:[{id:'a',name:'Card',currency:'USD',mapping:{accountId:'local',fromDate:'2026-09-01'}}]}]});
 f.click('Sync transactions');await settle();assert.match(text(f.root),/2 added/);f.click('Disconnect bank');assert.equal(f.calls.length,1);f.click('Yes, disconnect');await settle();assert.equal(f.calls.at(-1).action,'disconnect');
});
