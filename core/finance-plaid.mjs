/** Owner-only, read-data Plaid Hosted Link. Tokens live in the Zelos secret store. */
import crypto from 'node:crypto';
import * as secrets from './secrets.mjs';
import {FinanceError, financeDate, saveAccount, saveTransaction} from './finance.mjs';
const fail=(message,status=400)=>{throw new FinanceError(status,message);};
const clean=(x,max=200)=>String(x??'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,max);
const uuid=()=>crypto.randomUUID();
const ref=id=>'finance.plaid.'+crypto.createHash('sha256').update(id).digest('hex').slice(0,40);
const nextDay=date=>new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const toCents=value=>{
 if(typeof value!=='number'||!Number.isFinite(value))fail('Plaid returned an invalid amount.',502);
 const amount=Math.sign(value)*Math.round((Math.abs(value)+Number.EPSILON*Math.abs(value))*100);
 if(!Number.isSafeInteger(amount)||Math.abs(amount)>1_000_000_000_000)fail('Plaid returned an invalid amount.',502);
 return amount===0?0:amount;
};
const balances=(value={},retrievedAt=null)=>({
 currentCents:value.current==null?null:toCents(value.current),availableCents:value.available==null?null:toCents(value.available),limitCents:value.limit==null?null:toCents(value.limit),
 currency:/^[A-Z]{3}$/.test(value.iso_currency_code||'')?value.iso_currency_code:null,retrievedAt,sourceUpdatedAt:timestamp(value.last_updated_datetime),cached:true,
});
const services=new WeakMap();
export function plaidService(db){if(!services.has(db))services.set(db,createPlaidService(db));return services.get(db);}
export function createPlaidService(db,{vault=secrets,fetcher=fetch}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS finance_plaid_items(id TEXT PRIMARY KEY, institution TEXT NOT NULL, accounts TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', last_sync TEXT, disconnected INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS finance_plaid_sessions(id TEXT PRIMARY KEY, item_id TEXT, expires TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_plaid_accounts(remote_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,local_id TEXT NOT NULL UNIQUE,from_date TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_plaid_transactions(remote_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,local_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS finance_plaid_pending(item_id TEXT NOT NULL,remote_id TEXT NOT NULL,remote_account_id TEXT NOT NULL,account_id TEXT NOT NULL,entity_id TEXT NOT NULL,date TEXT NOT NULL,description TEXT NOT NULL,amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(item_id,remote_id));
 CREATE TABLE IF NOT EXISTS finance_plaid_sync_state(item_id TEXT PRIMARY KEY,pending_initialized INTEGER NOT NULL DEFAULT 0,balance_warning TEXT);`);
 let queue=Promise.resolve();
 const lock=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
 const read=async name=>{const value=await vault.getSecret(ref(name));return value?JSON.parse(value):null;};
 const write=(name,value)=>vault.setSecret(ref(name),JSON.stringify(value));
 const item=id=>{const x=db.prepare('SELECT * FROM finance_plaid_items WHERE id=? AND disconnected=0').get(String(id));if(!x)fail('Bank connection not found.',404);return x;};
 async function call(path,body={}){
  if(!['/link/token/create','/link/token/get','/item/public_token/exchange','/accounts/get','/transactions/sync','/item/remove'].includes(path))fail('This integration only supports bank data access.',403);
  const cfg=await read('config');if(!cfg)fail('Set up your Plaid application before linking a bank.',409);
  let response,data;
  try {response=await fetcher('https://production.plaid.com'+path,{method:'POST',headers:{'Content-Type':'application/json','Plaid-Version':'2020-09-14'},body:JSON.stringify({...body,client_id:cfg.clientId,secret:cfg.secret}),signal:AbortSignal.timeout(30000),redirect:'error'});data=await response.json();}
  catch {fail('Plaid could not be reached. Please try again.',502);}
  if(!response.ok){const code=/^[A-Z_]{1,80}$/.test(data.error_code||'')?data.error_code:'REQUEST_FAILED';
   const messages={INVALID_API_KEYS:'Check your Plaid client ID and production secret.',ITEM_LOGIN_REQUIRED:'This bank needs you to reconnect.',PRODUCT_NOT_READY:'The bank is still preparing transactions. Try Sync again shortly.',TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION:'Bank records changed during sync. Try Sync again; no partial changes were saved.'};
   fail(messages[code]||`Plaid could not complete this request (${code}). Check your Plaid dashboard or try again.`,502);
  }
  return data;
 }
 async function status(){
  const cfg=await read('config');
  return {configured:!!cfg,environment:'production',items:db.prepare('SELECT * FROM finance_plaid_items WHERE disconnected=0').all().map(x=>({id:x.id,institution:x.institution,lastSync:x.last_sync,balanceWarning:db.prepare('SELECT balance_warning FROM finance_plaid_sync_state WHERE item_id=?').get(x.id)?.balance_warning||null,accounts:JSON.parse(x.accounts).map(a=>({...a,balances:a.balances||balances(),mapping:db.prepare('SELECT local_id AS accountId,from_date AS fromDate FROM finance_plaid_accounts WHERE remote_id=? AND item_id=?').get(a.id,x.id)||null}))})),
   pending:db.prepare(`SELECT p.remote_id AS id,p.item_id AS itemId,p.account_id AS accountId,p.entity_id AS entityId,p.date,p.description,p.amount_cents AS amountCents,p.currency,p.kind FROM finance_plaid_pending p
    JOIN finance_plaid_items i ON i.id=p.item_id AND i.disconnected=0
    JOIN finance_plaid_accounts m ON m.item_id=p.item_id AND m.remote_id=p.remote_account_id AND m.local_id=p.account_id
    JOIN finance_accounts a ON a.id=p.account_id AND a.entity_id=p.entity_id AND a.currency=p.currency ORDER BY p.date DESC,p.item_id,p.remote_id`).all(),
   sessions:db.prepare('SELECT id,item_id AS itemId,expires FROM finance_plaid_sessions WHERE expires>? AND item_id IS NULL').all(new Date(Date.now()-6*3600000).toISOString()),existingAccounts:db.prepare('SELECT a.id,a.entity_id AS entityId,a.name,a.currency,MAX(t.date) AS latestDate FROM finance_accounts a LEFT JOIN finance_transactions t ON t.account_id=a.id GROUP BY a.id').all()};
 }
 async function configure(data){
  if(!/^[a-f0-9]{24}$/i.test(data.clientId||'')||!/^[a-f0-9]{30}$/i.test(data.secret||''))fail('Enter the client ID and production secret from your Plaid dashboard.');
  const old=await read('config');
  if(old&&old.clientId!==data.clientId&&db.prepare('SELECT 1 FROM finance_plaid_items WHERE disconnected=0').get())fail('Disconnect existing banks before changing Plaid applications.',409);
  await write('config',{clientId:data.clientId,secret:data.secret,userId:old?.userId||uuid()});return {configured:true};
 }
 async function start(){
  const cfg=await read('config');if(!cfg)fail('Set up Plaid first.',409);
  const r=await call('/link/token/create',{client_name:'Zelos',user:{client_user_id:cfg.userId},products:['transactions'],country_codes:['US'],language:'en',transactions:{days_requested:730},hosted_link:{url_lifetime_seconds:1800}});
  let url;try{url=new URL(r.hosted_link_url);}catch{fail('Plaid did not return a bank sign-in link.',502);}
  if(url.protocol!=='https:'||url.hostname!=='secure.plaid.com'||url.username||url.password)fail('Plaid returned an unexpected sign-in address.',502);
  const id=uuid();await write('session.'+id,{linkToken:r.link_token,url:url.href});
  db.prepare('INSERT INTO finance_plaid_sessions(id,expires) VALUES(?,?)').run(id,r.expiration);
  return {id,url:url.href,expires:r.expiration};
 }
 async function complete(data){
  const s=db.prepare('SELECT * FROM finance_plaid_sessions WHERE id=?').get(String(data.id));if(!s)fail('Start a new bank connection.',404);
  if(s.item_id)return {itemId:s.item_id};
  // Plaid retains completed Hosted Link results for six hours, even after the link expires.
  if(Date.now()>Date.parse(s.expires)+6*3600000)fail('This link session expired. Start a new connection.',410);
  const saved=await read('session.'+s.id);if(!saved)fail('Start a new bank connection.',410);
  let exchange=saved.exchange, metadata=saved.metadata;
  if(!exchange){
   const result=await call('/link/token/get',{link_token:saved.linkToken});
   const success=(result.link_sessions||[]).flatMap(x=>x.results?.item_add_results|| (x.on_success?[{...x.on_success.metadata,public_token:x.on_success.public_token}]:[])).find(x=>x.public_token);
   if(!success)return {pending:true};
   exchange=await call('/item/public_token/exchange',{public_token:success.public_token});metadata=success;
   // Persist immediately: a one-use public token cannot be exchanged again after a retry.
   await write('session.'+s.id,{...saved,exchange,metadata});
  }
  const existing=db.prepare('SELECT id FROM finance_plaid_items WHERE id=?').get(exchange.item_id);
  if(!existing){
   const r=await call('/accounts/get',{access_token:exchange.access_token});
   if(!Array.isArray(r.accounts)||r.item?.item_id&&r.item.item_id!==exchange.item_id)fail('Plaid returned an incomplete account response.',502);
   const allowed=new Set((metadata.accounts||[]).map(a=>a.id)),retrievedAt=new Date().toISOString();
   const accounts=r.accounts.filter(a=>!allowed.size||allowed.has(a.account_id)).filter(a=>['depository','credit'].includes(a.type)).map(a=>({id:a.account_id,name:clean(a.name,100),mask:clean(a.mask,10),type:a.type,currency:a.balances?.iso_currency_code||null,balances:balances(a.balances||{},retrievedAt)}));
   await write('item.'+exchange.item_id,{accessToken:exchange.access_token});
   db.prepare('INSERT INTO finance_plaid_items(id,institution,accounts) VALUES(?,?,?)').run(exchange.item_id,clean(metadata.institution?.name||'Linked bank',120),JSON.stringify(accounts));
  }
  db.prepare('UPDATE finance_plaid_sessions SET item_id=? WHERE id=?').run(exchange.item_id,s.id);
  await vault.deleteSecret(ref('session.'+s.id));return {itemId:exchange.item_id};
 }
 function mapAccounts(data){
  const bank=item(data.itemId),remote=JSON.parse(bank.accounts);
  if(!Array.isArray(data.mappings)||!data.mappings.length||data.mappings.length>100)fail('Choose at least one account to import.');
  const plans=data.mappings.map(m=>{
   const a=remote.find(a=>a.id===m.remoteId);if(!a||!a.currency||!/^[A-Z]{3}$/.test(a.currency))fail('This account does not have a supported currency.');
   if(db.prepare('SELECT 1 FROM finance_plaid_accounts WHERE remote_id=?').get(a.id))fail('This bank account is already assigned.');
   const entity=db.prepare('SELECT id FROM finance_entities WHERE id=?').get(String(m.entityId));if(!entity)fail('Choose a personal or company workspace for every account.');
   const local=m.accountId?db.prepare('SELECT * FROM finance_accounts WHERE id=?').get(String(m.accountId)):null;
   if(m.accountId&&(!local||local.entity_id!==entity.id||local.currency!==a.currency))fail('Choose an existing account in the same workspace and currency.');
   if(local&&db.prepare('SELECT 1 FROM finance_plaid_accounts WHERE local_id=?').get(local.id))fail('That local account is already linked to a bank.');
   const from=financeDate(m.fromDate);
   const latest=local&&db.prepare('SELECT MAX(date) AS date FROM finance_transactions WHERE account_id=?').get(local.id).date;
   if(latest&&from<=latest)fail(`Start syncing this existing account on ${nextDay(latest)} or later to avoid overlapping its recorded activity.`);
   return {a,entity,local,from};
  });
  if(new Set(plans.map(p=>p.a.id)).size!==plans.length)fail('Choose each bank account once.');
  db.exec('SAVEPOINT plaid_map');try{
   for(const p of plans){const local=p.local||saveAccount(db,{entityId:p.entity.id,name:clean(p.a.name+(p.a.mask?' • '+p.a.mask:''),120),type:p.a.type==='credit'?'credit_card':'bank',currency:p.a.currency});
    db.prepare('INSERT INTO finance_plaid_accounts(remote_id,item_id,local_id,from_date) VALUES(?,?,?,?)').run(p.a.id,bank.id,local.id,p.from);
   }
   db.prepare("UPDATE finance_plaid_items SET cursor='' WHERE id=?").run(bank.id);db.exec('RELEASE plaid_map');
  }catch(e){db.exec('ROLLBACK TO plaid_map; RELEASE plaid_map');throw e;}
  return {mapped:plans.length};
 }
 async function transactionPages(accessToken,startCursor){
  let cursor=startCursor,changes=[],removed=[];
  for(let page=0;page<100;page++){
   const r=await call('/transactions/sync',{access_token:accessToken,cursor,count:500});
   if(typeof r.next_cursor!=='string'||typeof r.has_more!=='boolean'||['added','modified','removed'].some(key=>r[key]!=null&&!Array.isArray(r[key])))fail('Plaid returned an incomplete transaction response.',502);
   changes.push(...(r.added||[]),...(r.modified||[]));removed.push(...(r.removed||[]));cursor=r.next_cursor;
   if(!r.has_more)break;if(page===99)fail('This sync exceeded the page limit. No partial changes were saved.',502);
  }
  return {cursor,changes,removed};
 }
 async function refreshedAccounts(bank,accessToken){
  const accounts=JSON.parse(bank.accounts);
  try{
   // /accounts/get retrieves cached balances without requesting paid live Balance.
   const r=await call('/accounts/get',{access_token:accessToken}),retrievedAt=new Date().toISOString();
   if(!Array.isArray(r.accounts)||r.item?.item_id&&r.item.item_id!==bank.id)fail('Plaid returned an incomplete account response.',502);
   let warning=null;
   const refreshed=accounts.map(a=>{
    const current=r.accounts.find(remote=>remote.account_id===a.id);
    if(!current){warning='Some account balances were unavailable. Previously retrieved balances are shown.';return a;}
    const latest=balances(current.balances||{},retrievedAt);
    if(latest.currency&&a.currency&&latest.currency!==a.currency){warning='A bank account currency changed. Its previously retrieved balance is shown.';return a;}
    return {...a,balances:latest};
   });
   return {accounts:refreshed,warning};
  }catch(error){return {accounts,warning:'Transactions synced, but account balances could not be retrieved. '+clean(error.message,250)};}
 }
 async function sync(data){
  const bank=item(data.itemId),secret=await read('item.'+bank.id);if(!secret)fail('Reconnect this bank; its token is unavailable.',409);
  const mappings=db.prepare('SELECT m.*,a.entity_id,a.currency FROM finance_plaid_accounts m JOIN finance_accounts a ON a.id=m.local_id WHERE m.item_id=?').all(bank.id);
  if(!mappings.length)fail('Assign bank accounts to workspaces before syncing.');
  const initialized=db.prepare('SELECT pending_initialized FROM finance_plaid_sync_state WHERE item_id=?').get(bank.id)?.pending_initialized;
  // Older installations already have a cursor but have never stored pending rows.
  // Replay a separate snapshot for pending only, then apply the normal saved-cursor
  // delta. Save the delta's cursor, never the independent replay's cursor.
  const bootstrap=!initialized&&bank.cursor?await transactionPages(secret.accessToken,''):null;
  const delta=await transactionPages(secret.accessToken,bank.cursor);
  const snapshots=bootstrap?[bootstrap,delta]:[delta];
  const accountRefresh=await refreshedAccounts(bank,secret.accessToken);
  const mapping=new Map(mappings.map(m=>[m.remote_id,m]));
  const checked=r=>{
   if(!r||typeof r!=='object'||typeof r.transaction_id!=='string'||!r.transaction_id)fail('Plaid returned an invalid transaction.',502);
   const m=mapping.get(r.account_id);if(!m)return null;
   const date=financeDate(r.date);if(date<m.from_date)return null;
   if(r.iso_currency_code!==m.currency)fail('A transaction currency changed. No partial changes were saved.',409);
   const amount=-toCents(r.amount),primary=r.personal_finance_category?.primary||'',detail=r.personal_finance_category?.detailed||'';
   const transfer=/^TRANSFER_(IN|OUT)$/.test(primary)||detail==='LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';
   return {m,date,amount,kind:transfer?'transfer':amount<0?'expense':'income',category:clean(primary.toLowerCase().replaceAll('_',' ').replace(/^./,x=>x.toUpperCase())||'Uncategorized',80),description:clean(r.merchant_name||r.name||'Bank transaction',500)};
  };
  let imported=0,updated=0,excluded=0;
  db.exec('SAVEPOINT plaid_sync');try{
   if(bootstrap||!bank.cursor)db.prepare('DELETE FROM finance_plaid_pending WHERE item_id=?').run(bank.id);
   for(const snapshot of snapshots){
    for(const r of snapshot.changes){
     if(!r.pending)continue;
     const value=checked(r);if(!value)continue;const {m,date,amount,kind,description}=value;
     const old=db.prepare('SELECT remote_account_id FROM finance_plaid_pending WHERE item_id=? AND remote_id=?').get(bank.id,r.transaction_id);
     if(old&&old.remote_account_id!==r.account_id)fail('A bank transaction changed accounts. No partial changes were saved.',409);
     db.prepare(`INSERT INTO finance_plaid_pending(item_id,remote_id,remote_account_id,account_id,entity_id,date,description,amount_cents,currency,kind) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(item_id,remote_id) DO UPDATE SET date=excluded.date,description=excluded.description,amount_cents=excluded.amount_cents,kind=excluded.kind`).run(bank.id,r.transaction_id,r.account_id,m.local_id,m.entity_id,date,description,amount,m.currency,kind);
    }
    // Reconcile only after every page has been staged. A posted record can precede
    // its pending removal (or a late pending row) on another page.
    for(const r of snapshot.removed){
     db.prepare('DELETE FROM finance_plaid_pending WHERE item_id=? AND remote_id=? AND (? IS NULL OR remote_account_id=?)').run(bank.id,r.transaction_id,r.account_id??null,r.account_id??null);
    }
    for(const r of snapshot.changes){
     if(r.pending||!mapping.has(r.account_id))continue;
     for(const id of [r.transaction_id,r.pending_transaction_id].filter(Boolean))db.prepare('DELETE FROM finance_plaid_pending WHERE item_id=? AND remote_id=? AND remote_account_id=?').run(bank.id,id,r.account_id);
    }
   }
   const posted=new Map();
   for(const r of delta.changes){if(r.pending)continue;const value=checked(r);if(value){if(posted.has(r.transaction_id)&&posted.get(r.transaction_id).m.remote_id!==r.account_id)fail('A bank transaction changed accounts. No partial changes were saved.',409);posted.set(r.transaction_id,{r,...value});}}
   for(const {r,m,date,amount,kind,category,description} of posted.values()){
    const match=db.prepare('SELECT item_id,local_id FROM finance_plaid_transactions WHERE remote_id=?').get(r.transaction_id);
    if(match&&match.item_id!==bank.id)fail('A bank transaction belongs to another connection. No partial changes were saved.',409);
    const old=match&&db.prepare('SELECT * FROM finance_transactions WHERE id=?').get(match.local_id);
    if(old&&(old.account_id!==m.local_id||old.entity_id!==m.entity_id||old.currency!==m.currency))fail('A bank transaction changed accounts. No partial changes were saved.',409);
    const row=saveTransaction(db,{id:old?.id,entityId:m.entity_id,accountId:m.local_id,date,description,amountCents:amount,currency:m.currency,category:old?.category||category,kind:old?.kind==='transfer'?'transfer':kind,status:old?.status||'review'});
    db.prepare('UPDATE finance_transactions SET reference=? WHERE id=?').run('Plaid transaction '+clean(r.transaction_id,160),row.id);
    db.prepare('INSERT INTO finance_plaid_transactions(remote_id,item_id,local_id) VALUES(?,?,?) ON CONFLICT(remote_id) DO UPDATE SET local_id=excluded.local_id WHERE item_id=excluded.item_id').run(r.transaction_id,bank.id,row.id);
    old?updated++:imported++;
   }
   for(const r of delta.removed){
    // Removal targets its exact remote ID. Settlements have a new posted ID,
    // so deleting the old pending ID cannot exclude the settled transaction.
    // A removal of the posted ID itself must still be honored (Plaid Pattern).
    const m=db.prepare(`SELECT t.local_id FROM finance_plaid_transactions t JOIN finance_transactions f ON f.id=t.local_id
     JOIN finance_plaid_accounts a ON a.item_id=t.item_id AND a.local_id=f.account_id
     WHERE t.remote_id=? AND t.item_id=? AND (? IS NULL OR a.remote_id=?)`).get(r.transaction_id,bank.id,r.account_id??null,r.account_id??null);
    if(m){const result=db.prepare("UPDATE finance_transactions SET status='excluded',updated_at=? WHERE id=? AND status!='excluded'").run(new Date().toISOString(),m.local_id);excluded+=Number(result.changes);}
   }
   db.prepare('UPDATE finance_plaid_items SET cursor=?,last_sync=?,accounts=? WHERE id=?').run(delta.cursor,new Date().toISOString(),JSON.stringify(accountRefresh.accounts),bank.id);
   db.prepare('INSERT INTO finance_plaid_sync_state(item_id,pending_initialized,balance_warning) VALUES(?,1,?) ON CONFLICT(item_id) DO UPDATE SET pending_initialized=1,balance_warning=excluded.balance_warning').run(bank.id,accountRefresh.warning);
   db.exec('RELEASE plaid_sync');
  }catch(e){db.exec('ROLLBACK TO plaid_sync; RELEASE plaid_sync');throw e;}
  return {imported,updated,excluded,pending:db.prepare('SELECT COUNT(*) n FROM finance_plaid_pending WHERE item_id=?').get(bank.id).n,balanceWarning:accountRefresh.warning};
 }
 async function disconnect(data){const bank=item(data.itemId),secret=await read('item.'+bank.id);if(secret)await call('/item/remove',{access_token:secret.accessToken});db.exec('SAVEPOINT plaid_disconnect');try{db.prepare('UPDATE finance_plaid_items SET disconnected=1 WHERE id=?').run(bank.id);db.prepare('DELETE FROM finance_plaid_accounts WHERE item_id=?').run(bank.id);db.prepare('DELETE FROM finance_plaid_pending WHERE item_id=?').run(bank.id);db.prepare('DELETE FROM finance_plaid_sync_state WHERE item_id=?').run(bank.id);db.exec('RELEASE plaid_disconnect');}catch(error){db.exec('ROLLBACK TO plaid_disconnect; RELEASE plaid_disconnect');throw error;}await vault.deleteSecret(ref('item.'+bank.id));return {disconnected:true};}
 const valid=d=>{if(!d||typeof d!=='object'||Array.isArray(d))fail('Send valid bank connection details.');return d;};
 return {status:()=>lock(status),configure:d=>lock(()=>configure(valid(d))),start:()=>lock(start),complete:d=>lock(()=>complete(valid(d))),map:d=>lock(()=>mapAccounts(valid(d))),sync:d=>lock(()=>sync(valid(d))),disconnect:d=>lock(()=>disconnect(valid(d)))};
}
