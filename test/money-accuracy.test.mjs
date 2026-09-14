import test from 'node:test';
import assert from 'node:assert/strict';
import { balancePresentation, scopedBankSnapshot, scopedReviewDecisions, snapshotTime } from '../ui/lib/money-accuracy.js';

const entities=[{id:'business',type:'company'},{id:'personal',type:'personal'}];
const accounts=[{id:'checking',entityId:'business',currency:'USD',type:'bank'},{id:'card',entityId:'personal',currency:'USD',type:'credit_card'},{id:'euro',entityId:'business',currency:'EUR',type:'bank'}];
const status={items:[{id:'bank',accounts:accounts.map(account=>({mapping:{accountId:account.id},balances:{currentCents:100,currency:account.currency}}))}],pending:accounts.map(account=>({id:'pending-'+account.id,entityId:account.entityId,accountId:account.id,currency:account.currency,date:'2020-01-01',amountCents:-100}))};

test('bank snapshots filter ownership, workspace, account and currency, independent of spending dates',()=>{
  const scope={entities,section:'business',entityId:'business',currency:'USD',start:'2026-09-01',end:'2026-09-30'};
  const snapshot=scopedBankSnapshot(status,accounts,scope);
  assert.deepEqual(snapshot.balances.map(row=>row.account.id),['checking']);
  assert.deepEqual(snapshot.pending.map(row=>row.accountId),['checking']);
  assert.equal(scopedBankSnapshot(status,accounts,{...scope,accountId:'card'}).balances.length,0);
  assert.equal(scopedBankSnapshot(status,accounts,{...scope,currency:'EUR'}).pending[0].accountId,'euro');
  assert.equal(scopedBankSnapshot(status,accounts,{...scope,section:'personal'}).pending.length,0);
});

test('unmapped bank data cannot be attributed to a workspace',()=>{
  const snapshot=scopedBankSnapshot({items:[{accounts:[{mapping:null,balances:{currentCents:100,currency:'USD'}}]}]},accounts,{entities,currency:'USD'});
  assert.deepEqual(snapshot,{balances:[],pending:[]});
});

test('unknown or changed bank currency never borrows the local account currency for numeric amounts',()=>{
  for(const currency of [null,'EUR']) {
    const source={items:[{accounts:[{mapping:{accountId:'checking'},currency:'USD',balances:{currency,currentCents:12345,availableCents:0,limitCents:50000}}]}]};
    const snapshot=scopedBankSnapshot(source,accounts,{entities,section:'business',currency:'USD'});
    assert.equal(snapshot.balances.length,1);assert.equal(snapshot.balances[0].currency,'USD');
    assert.equal(snapshot.balances[0].balance.currentCents,null);assert.equal(snapshot.balances[0].balance.availableCents,null);assert.equal(snapshot.balances[0].balance.limitCents,null);
    assert.match(snapshot.balances[0].currencyWarning,/Amounts are unavailable/);
    assert.equal(scopedBankSnapshot(source,accounts,{entities,currency:'EUR'}).balances.length,0);
  }
});

test('unknown balances stay unknown while zero, card debt and card credit remain distinct',()=>{
  assert.equal(balancePresentation('bank',null).amountCents,null);
  assert.equal(balancePresentation('bank',{currentCents:null,availableCents:null}).availableCents,null);
  assert.equal(balancePresentation('bank',{currentCents:0}).amountCents,0);
  assert.equal(balancePresentation('bank',{currentCents:-500}).amountCents,-500);
  assert.equal(balancePresentation('credit_card',{currentCents:2300}).label,'Amount owed');
  assert.equal(balancePresentation('credit_card',{currentCents:2300}).amountCents,2300);
  assert.equal(balancePresentation('credit_card',{currentCents:-700}).label,'Credit on card');
  assert.equal(balancePresentation('credit_card',{currentCents:-700}).amountCents,700);
  assert.equal(balancePresentation('credit_card',{currentCents:null}).amountCents,null);
  assert.equal(balancePresentation('credit_card',{limitCents:0}).limitCents,0);
  assert.equal(snapshotTime('not-a-date'),'Unavailable');
});

test('undo receipts remain inside the visible owner/account/currency and loaded evidence',()=>{
  const scope={entities,section:'business',currency:'USD',accountId:'checking'};
  const rows=[{id:'visible',entityId:'business',accountId:'checking',currency:'USD'}];
  const receipt={id:'review',entityId:'business',accountId:'checking',currency:'USD',rowIds:['visible'],undone:false};
  const others=[{...receipt,id:'personal',entityId:'personal'},{...receipt,id:'euro',currency:'EUR'},{...receipt,id:'old',rowIds:['old']},{...receipt,id:'undone',undone:true},{...receipt,id:'other-account',accountId:'other',rowIds:['other']}];
  assert.deepEqual(scopedReviewDecisions([receipt,...others],rows,scope).map(d=>d.id),['review']);
});
