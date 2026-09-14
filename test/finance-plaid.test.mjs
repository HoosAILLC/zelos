import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPlaidService} from '../core/finance-plaid.mjs';
import {migrateFinance,addEntity,saveAccount,saveTransaction,getFinance} from '../core/finance.mjs';
const key={clientId:'a'.repeat(24),secret:'b'.repeat(30)};
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');migrateFinance(db);t.after(()=>db.close());
 const personal=addEntity(db,{name:'Personal',type:'personal'}),company=addEntity(db,{name:'Company',type:'company'});
 const vaultData=new Map(),calls=[];let responses={};
 const vault={getSecret:async k=>vaultData.get(k)||null,setSecret:async(k,v)=>{assert.ok(k.length<=64);vaultData.set(k,v);},deleteSecret:async k=>vaultData.delete(k)};
 responses['/link/token/create']={link_token:'private-link',hosted_link_url:'https://secure.plaid.com/hl/test',expiration:new Date(Date.now()+1800000).toISOString()};
 responses['/link/token/get']={link_sessions:[{results:{item_add_results:[{public_token:'public-one',institution:{name:'Test bank'},accounts:[{id:'remote-card'},{id:'remote-bank'}]}]}}]};
 responses['/item/public_token/exchange']={item_id:'item1',access_token:'private-access'};
 responses['/accounts/get']={accounts:[{account_id:'remote-card',name:'Amex',type:'credit',mask:'1234',balances:{iso_currency_code:'USD'}},{account_id:'remote-bank',name:'Checking',type:'depository',balances:{iso_currency_code:'USD'}},{account_id:'not-consented',name:'Do not import',type:'depository',balances:{iso_currency_code:'USD'}}]};
 responses['/transactions/sync']={added:[],modified:[],removed:[],has_more:false,next_cursor:'cursor1'};responses['/item/remove']={};
 const fetcher=async(url,options)=>{const path=new URL(url).pathname,body=JSON.parse(options.body);calls.push({path,body});assert.equal(new URL(url).origin,'https://production.plaid.com');const value=responses[path];const r=typeof value==='function'?await value(body):value;return {ok:!r.error_code,json:async()=>r};};
 const service=createPlaidService(db,{vault,fetcher});
 const connect=async()=>{await service.configure(key);const s=await service.start();await service.complete({id:s.id});return s;};
 const map=async(extra={})=>service.map({itemId:'item1',mappings:[{remoteId:'remote-card',entityId:personal.id,fromDate:'2026-09-01',...extra}]});
 const rows=()=>db.prepare('SELECT * FROM finance_transactions').all();
 return {db,service,vault,vaultData,fetcher,calls,responses,personal,company,connect,map,rows};
}
const charge=(id,patch={})=>({transaction_id:id,account_id:'remote-card',date:'2026-09-10',amount:12.34,iso_currency_code:'USD',name:'Coffee',pending:false,personal_finance_category:{primary:'FOOD_AND_DRINK'},...patch});
test('setup gates linking; production session requests Transactions only and exposes no tokens',async t=>{
 const f=fixture(t);assert.equal((await f.service.status()).configured,false);await assert.rejects(f.service.start(),/Set up Plaid/);
 await assert.rejects(f.service.configure({clientId:'bad',secret:'bad'}),/client ID/);await assert.rejects(f.service.configure(null),/valid/);
 await f.connect();const start=f.calls.find(c=>c.path==='/link/token/create');assert.deepEqual(start.body.products,['transactions']);assert.equal(start.body.hosted_link.delivery_method,undefined);assert.equal(start.body.webhook,undefined);
 const status=await f.service.status();assert.equal(status.items[0].accounts.length,2);assert.doesNotMatch(JSON.stringify(status),/private-access|private-link|public-one|bbbbbb/);
 const dump=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>f.db.prepare(`SELECT * FROM ${x.name}`).all());assert.doesNotMatch(JSON.stringify(dump),/private-access|private-link|public-one|bbbbbb/);
});
test('Hosted Link is resumable and cannot redirect to an untrusted host',async t=>{
 const f=fixture(t);await f.service.configure(key);f.responses['/link/token/create'].hosted_link_url='https://evil.example/';await assert.rejects(f.service.start(),/unexpected/);
 f.responses['/link/token/create'].hosted_link_url='https://secure.plaid.com/hl/test';const s=await f.service.start();
 f.responses['/link/token/get']={link_sessions:[]};assert.deepEqual(await f.service.complete({id:s.id}),{pending:true});
 f.responses['/link/token/get']={link_sessions:[{on_success:{public_token:'one-use',metadata:{institution:{name:'Bank'}}}}]};
 const good=f.responses['/accounts/get'];f.responses['/accounts/get']={error_code:'INSTITUTION_DOWN'};await assert.rejects(f.service.complete({id:s.id}),/INSTITUTION_DOWN/);
 f.responses['/accounts/get']=good;assert.equal((await f.service.complete({id:s.id})).itemId,'item1');await f.service.complete({id:s.id});assert.equal(f.calls.filter(c=>c.path==='/item/public_token/exchange').length,1);
});
test('mapping enforces ownership, currency, unique accounts and statement cutoff',async t=>{
 const f=fixture(t);await f.connect();const local=saveAccount(f.db,{entityId:f.personal.id,name:'Imported Amex',type:'credit_card',currency:'USD'});
 saveTransaction(f.db,{entityId:f.personal.id,accountId:local.id,date:'2026-09-08',description:'Statement',amountCents:-100,currency:'USD'});
 await assert.rejects(f.map({accountId:local.id,entityId:f.company.id}),/same workspace/);await assert.rejects(f.map({accountId:local.id}),/2026-09-09/);
 await f.map({accountId:local.id,fromDate:'2026-09-09'});await assert.rejects(f.map(),/already assigned/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_accounts').get().n,1);
});
test('sync keeps pending separate, skips unassigned/overlapping records and remains idempotent',async t=>{
 const f=fixture(t);await f.connect();await f.map();
 f.responses['/transactions/sync']={added:[charge('1'),charge('pending',{pending:true}),charge('old',{date:'2026-08-31'}),charge('other',{account_id:'remote-bank'})],modified:[],removed:[],next_cursor:'cursor1',has_more:false};
 assert.equal((await f.service.sync({itemId:'item1'})).imported,1);await f.service.sync({itemId:'item1'});assert.equal(f.rows().length,1);assert.equal(f.rows()[0].amount_cents,-1234);assert.equal(f.rows()[0].entity_id,f.personal.id);
 assert.equal((await f.service.status()).pending.length,1);
 f.db.prepare("UPDATE finance_transactions SET category='Dining & coffee',status='confirmed'").run();
 f.responses['/transactions/sync']={added:[],modified:[charge('1',{amount:15})],removed:[],next_cursor:'cursor2',has_more:false};await f.service.sync({itemId:'item1'});
 assert.equal(f.rows()[0].category,'Dining & coffee');assert.equal(f.rows()[0].status,'confirmed');assert.equal(f.rows()[0].amount_cents,-1500);
 f.responses['/transactions/sync']={added:[],modified:[],removed:[{transaction_id:'1'}],next_cursor:'cursor3',has_more:false};await f.service.sync({itemId:'item1'});assert.equal(f.rows()[0].status,'excluded');
});
test('sync stages every page before committing and rolls back invalid currencies',async t=>{
 const f=fixture(t);await f.connect();await f.map();
 f.responses['/transactions/sync']=body=>body.cursor===''?{added:[charge('one')],next_cursor:'page2',has_more:true}:{error_code:'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'};
 await assert.rejects(f.service.sync({itemId:'item1'}),/no partial/);assert.equal(f.rows().length,0);assert.equal(f.db.prepare('SELECT cursor FROM finance_plaid_items').get().cursor,'');
 f.responses['/transactions/sync']={added:[charge('one'),charge('wrong',{iso_currency_code:'EUR'})],next_cursor:'done',has_more:false};await assert.rejects(f.service.sync({itemId:'item1'}),/currency/);assert.equal(f.rows().length,0);
});
test('card payments are transfers and disconnect revokes access while retaining records',async t=>{
 const f=fixture(t);await f.connect();await f.map();f.responses['/transactions/sync']={added:[charge('payment',{personal_finance_category:{primary:'LOAN_PAYMENTS',detailed:'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'}})],next_cursor:'done',has_more:false};await f.service.sync({itemId:'item1'});assert.equal(f.rows()[0].kind,'transfer');
 await f.service.disconnect({itemId:'item1'});assert.equal(f.rows().length,1);assert.equal((await f.service.status()).items.length,0);assert.equal(f.calls.at(-1).path,'/item/remove');assert.doesNotMatch([...f.vaultData.values()].join(''),/private-access/);
});

test('cached balances preserve unknown versus zero and credit debt signs without network reads',async t=>{
 const f=fixture(t);
 f.responses['/accounts/get'].accounts[0].balances={iso_currency_code:'USD',current:1234.56,available:0,limit:null};
 f.responses['/accounts/get'].accounts[1].balances={iso_currency_code:'USD',current:-12.34,available:null,limit:0};
 await f.connect();await f.map();const calls=f.calls.length,status=await f.service.status();await f.service.status();assert.equal(f.calls.length,calls);
 const card=status.items[0].accounts[0].balances,bank=status.items[0].accounts[1].balances;
 assert.deepEqual({...card,retrievedAt:null},{currentCents:123456,availableCents:0,limitCents:null,currency:'USD',retrievedAt:null,sourceUpdatedAt:null,cached:true});
 assert.ok(Number.isFinite(Date.parse(card.retrievedAt)));assert.equal(bank.currentCents,-1234);assert.equal(bank.availableCents,null);assert.equal(bank.limitCents,0);
 assert.ok(f.calls.every(call=>call.path!=='/accounts/balance/get'));
 // Databases created before balances were cached expose unknowns, never zeros.
 const accounts=JSON.parse(f.db.prepare('SELECT accounts FROM finance_plaid_items').get().accounts);delete accounts[0].balances;
 f.db.prepare('UPDATE finance_plaid_items SET accounts=?').run(JSON.stringify(accounts));
 assert.deepEqual((await f.service.status()).items[0].accounts[0].balances,{currentCents:null,availableCents:null,limitCents:null,currency:null,retrievedAt:null,sourceUpdatedAt:null,cached:true});
});

test('explicit sync refreshes cached balances and keeps bank timestamp distinct from retrieval',async t=>{
 const f=fixture(t);await f.connect();await f.map();
 f.responses['/accounts/get'].accounts[0].balances={iso_currency_code:'USD',current:0,available:500,limit:500,last_updated_datetime:'2026-09-10T18:30:00Z'};
 await f.service.sync({itemId:'item1'});const status=await f.service.status(),balance=status.items[0].accounts[0].balances;
 assert.equal(balance.currentCents,0);assert.equal(balance.availableCents,50000);assert.equal(balance.limitCents,50000);
 assert.equal(balance.sourceUpdatedAt,'2026-09-10T18:30:00.000Z');assert.notEqual(balance.retrievedAt,balance.sourceUpdatedAt);assert.equal(status.items[0].balanceWarning,null);
 assert.equal(f.calls.filter(call=>call.path==='/accounts/get').length,2);
});

test('balance failure preserves the old cache while transaction sync succeeds and warns',async t=>{
 const f=fixture(t);f.responses['/accounts/get'].accounts[0].balances.current=75;await f.connect();await f.map();
 const before=(await f.service.status()).items[0].accounts[0].balances,good=f.responses['/accounts/get'];
 f.responses['/accounts/get']={error_code:'INSTITUTION_DOWN'};
 f.responses['/transactions/sync']={added:[charge('posted'),charge('pending',{pending:true})],has_more:false,next_cursor:'fresh'};
 const result=await f.service.sync({itemId:'item1'}),status=await f.service.status();
 assert.equal(result.imported,1);assert.equal(result.pending,1);assert.match(result.balanceWarning,/balances could not be retrieved/);
 assert.equal(status.items[0].balanceWarning,result.balanceWarning);assert.deepEqual(status.items[0].accounts[0].balances,before);assert.equal(f.db.prepare('SELECT cursor FROM finance_plaid_items').get().cursor,'fresh');
 f.responses['/accounts/get']=good;assert.equal((await f.service.sync({itemId:'item1'})).balanceWarning,null);assert.equal((await f.service.status()).items[0].balanceWarning,null);
});

test('unavailable and changed-currency balances keep the previous currency-isolated cache',async t=>{
 const f=fixture(t);f.responses['/accounts/get'].accounts[0].balances.current=10;await f.connect();await f.map();
 const before=(await f.service.status()).items[0].accounts[0].balances;
 f.responses['/accounts/get']={accounts:[{account_id:'remote-card',balances:{current:50,iso_currency_code:'EUR'}}]};
 await f.service.sync({itemId:'item1'});const status=await f.service.status();assert.deepEqual(status.items[0].accounts[0].balances,before);assert.ok(status.items[0].balanceWarning);
 assert.equal(status.items[0].accounts[0].currency,'USD');assert.equal(status.items[0].accounts.length,2);
});

test('pending rows carry local workspace identity and never enter posted totals',async t=>{
 const f=fixture(t);await f.connect();await f.map();
 f.responses['/transactions/sync']={added:[charge('pending',{pending:true,amount:50}),charge('refund',{pending:true,amount:-5}),charge('overlap',{pending:true,date:'2026-08-31'}),charge('unmapped',{pending:true,account_id:'remote-bank'}),charge('posted',{amount:10})],has_more:false,next_cursor:'done'};
 await f.service.sync({itemId:'item1'});const status=await f.service.status(),pending=status.pending.find(row=>row.id==='pending');
 assert.deepEqual({...pending,accountId:'local'},{id:'pending',itemId:'item1',accountId:'local',entityId:f.personal.id,date:'2026-09-10',description:'Coffee',amountCents:-5000,currency:'USD',kind:'expense'});
 assert.equal(pending.accountId,status.items[0].accounts[0].mapping.accountId);assert.equal(status.pending.find(row=>row.id==='refund').amountCents,500);
 assert.equal(status.pending.length,2);assert.equal(f.rows().length,1);
 const report=getFinance(f.db,{month:'2026-09',today:'2026-09-14'});assert.equal(report.summary.currencies[0].expenseCents,1000);assert.equal(report.transactions.length,1);
 const reopened=createPlaidService(f.db,{vault:f.vault,fetcher:f.fetcher});assert.equal((await reopened.status()).pending.length,2);
});

for(const reversed of [false,true])test(`pending settlement reconciles all pages with ${reversed?'pending':'posted'} first`,async t=>{
 const f=fixture(t);await f.connect();await f.map();
 const pending=charge('hold',{pending:true,amount:10}),posted=charge('settled',{amount:12,pending_transaction_id:'hold'});
 const pages=[{added:[posted],removed:[{transaction_id:'hold',account_id:'remote-card'}],has_more:true,next_cursor:'page2'},{added:[pending],has_more:false,next_cursor:'done'}];
 if(reversed){pages[0].added=[pending];pages[0].removed=[];pages[1].added=[posted];pages[1].removed=[{transaction_id:'hold',account_id:'remote-card'}];}
 f.responses['/transactions/sync']=body=>body.cursor===''?pages[0]:pages[1];
 const result=await f.service.sync({itemId:'item1'});assert.equal(result.imported,1);assert.equal(result.pending,0);assert.equal(f.rows()[0].amount_cents,-1200);assert.equal(f.rows()[0].status,'review');
 assert.equal((await f.service.status()).pending.length,0);
});

test('pending removals and settlement links work independently without excluding the new posted row',async t=>{
 const f=fixture(t);await f.connect();await f.map();
 f.responses['/transactions/sync']={added:[charge('hold',{pending:true}),charge('cancelled',{pending:true})],has_more:false,next_cursor:'first'};await f.service.sync({itemId:'item1'});
 f.responses['/transactions/sync']={added:[charge('posted',{pending_transaction_id:'hold'})],removed:[{transaction_id:'cancelled'}],has_more:false,next_cursor:'second'};
 await f.service.sync({itemId:'item1'});assert.equal((await f.service.status()).pending.length,0);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].status,'review');
 await f.service.sync({itemId:'item1'});assert.equal(f.rows().length,1);assert.equal(f.rows()[0].status,'review');
 f.db.prepare("UPDATE finance_transactions SET status='excluded',category='Keep my decision'").run();
 await f.service.sync({itemId:'item1'});assert.equal(f.rows()[0].status,'excluded');assert.equal(f.rows()[0].category,'Keep my decision');
});

test('removal of an actual posted ID is honored even when that ID was added in the same update',async t=>{
 const f=fixture(t);await f.connect();await f.map();
 f.responses['/transactions/sync']=body=>body.cursor===''?{added:[charge('posted')],has_more:true,next_cursor:'page2'}:{removed:[{transaction_id:'posted',account_id:'remote-card'}],has_more:false,next_cursor:'done'};
 const result=await f.service.sync({itemId:'item1'});assert.equal(result.excluded,1);assert.equal(f.rows()[0].status,'excluded');
 assert.equal(getFinance(f.db,{month:'2026-09'}).summary.currencies[0].expenseCents,0);
});

test('invalid pending data rolls back posted rows, balances, pending state and the cursor together',async t=>{
 const f=fixture(t);await f.connect();await f.map();const before=(await f.service.status()).items[0].accounts;
 f.responses['/accounts/get'].accounts[0].balances.current=999;
 f.responses['/transactions/sync']={added:[charge('pending',{pending:true}),charge('posted'),charge('invalid',{pending:true,amount:'not a number'})],has_more:false,next_cursor:'bad'};
 await assert.rejects(f.service.sync({itemId:'item1'}),/invalid amount/);assert.equal(f.rows().length,0);assert.equal((await f.service.status()).pending.length,0);assert.deepEqual((await f.service.status()).items[0].accounts,before);
 assert.equal(f.db.prepare('SELECT cursor FROM finance_plaid_items').get().cursor,'');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_plaid_sync_state').get().n,0);
});

test('old cursors bootstrap pending history once without replaying posted records or saving the replay cursor',async t=>{
 const f=fixture(t);await f.connect();await f.map();
 f.responses['/transactions/sync']={added:[charge('existing')],has_more:false,next_cursor:'legacy'};await f.service.sync({itemId:'item1'});
 f.db.prepare("UPDATE finance_transactions SET status='excluded',category='Reviewed',description='My edit',amount_cents=-999").run();
 f.db.exec('DROP TABLE finance_plaid_pending; DROP TABLE finance_plaid_sync_state');const upgraded=createPlaidService(f.db,{vault:f.vault,fetcher:f.fetcher});
 const requested=[];f.responses['/transactions/sync']=body=>{requested.push(body.cursor);if(body.cursor==='')return {added:[charge('existing'),charge('historical-hold',{pending:true})],has_more:true,next_cursor:'replay-page'};if(body.cursor==='replay-page')return {added:[charge('current-hold',{pending:true})],has_more:false,next_cursor:'replay-complete'};return {removed:[{transaction_id:'historical-hold'}],added:[charge('new-posted')],has_more:false,next_cursor:'saved-delta'};};
 const result=await upgraded.sync({itemId:'item1'});assert.deepEqual(requested,['','replay-page','legacy']);assert.equal(result.imported,1);assert.equal(result.updated,0);assert.equal(result.pending,1);
 const old=f.rows().find(row=>row.description==='My edit');assert.equal(old.amount_cents,-999);assert.equal(old.status,'excluded');assert.equal(old.category,'Reviewed');assert.equal(f.rows().length,2);
 assert.equal(f.db.prepare('SELECT cursor FROM finance_plaid_items').get().cursor,'saved-delta');assert.deepEqual((await upgraded.status()).pending.map(row=>row.id),['current-hold']);
 requested.length=0;f.responses['/transactions/sync']=body=>{requested.push(body.cursor);return {has_more:false,next_cursor:'next'};};await upgraded.sync({itemId:'item1'});assert.deepEqual(requested,['saved-delta']);
});

test('failed legacy bootstrap leaves its original cursor and posted decisions intact for retry',async t=>{
 const f=fixture(t);await f.connect();await f.map();f.db.prepare("UPDATE finance_plaid_items SET cursor='legacy'").run();
 f.responses['/transactions/sync']=body=>body.cursor===''?{added:[charge('hold',{pending:true})],has_more:false,next_cursor:'replay'}:{error_code:'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'};
 await assert.rejects(f.service.sync({itemId:'item1'}),/no partial/);assert.equal(f.db.prepare('SELECT cursor FROM finance_plaid_items').get().cursor,'legacy');assert.equal((await f.service.status()).pending.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_plaid_sync_state').get().n,0);
});

test('transaction identity stays isolated by item, account and currency',async t=>{
 const f=fixture(t);await f.connect();await f.map();await f.service.map({itemId:'item1',mappings:[{remoteId:'remote-bank',entityId:f.company.id,fromDate:'2026-09-01'}]});
 f.responses['/transactions/sync']={added:[charge('same')],has_more:false,next_cursor:'first'};await f.service.sync({itemId:'item1'});
 f.responses['/transactions/sync']={modified:[charge('same',{account_id:'remote-bank'})],has_more:false,next_cursor:'wrong'};await assert.rejects(f.service.sync({itemId:'item1'}),/changed accounts/);assert.equal(f.rows()[0].entity_id,f.personal.id);
 f.responses['/transactions/sync']={added:[charge('wrong-currency',{pending:true,iso_currency_code:'EUR'})],has_more:false,next_cursor:'wrong'};await assert.rejects(f.service.sync({itemId:'item1'}),/currency/);assert.equal((await f.service.status()).pending.length,0);
 f.db.prepare("UPDATE finance_plaid_transactions SET item_id='other-item' WHERE remote_id='same'").run();f.responses['/transactions/sync']={added:[charge('same')],has_more:false,next_cursor:'wrong'};await assert.rejects(f.service.sync({itemId:'item1'}),/another connection/);assert.equal(f.rows().length,1);
});

test('disconnect clears pending and warnings while preserving posted records',async t=>{
 const f=fixture(t);await f.connect();await f.map();f.responses['/transactions/sync']={added:[charge('pending',{pending:true}),charge('posted')],has_more:false,next_cursor:'first'};await f.service.sync({itemId:'item1'});
 await f.service.disconnect({itemId:'item1'});assert.equal((await f.service.status()).pending.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_plaid_pending').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_plaid_sync_state').get().n,0);assert.equal(f.rows().length,1);await assert.rejects(f.service.sync({itemId:'item1'}),/not found/);
});
