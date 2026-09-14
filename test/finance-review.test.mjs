import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateFinance, addEntity, saveAccount, saveTransaction, financeTransactionRows, getFinance } from '../core/finance.mjs';
import { reviewFinance, listFinanceReviews } from '../core/finance-review.mjs';
import { detectRecurring, findDuplicateCandidates } from '../ui/lib/money-patterns.js';
const today = '2026-09-20';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateFinance(db); t.after(() => db.close());
  const entity = addEntity(db, { name: 'Personal', type: 'personal' });
  const account = saveAccount(db, { entityId: entity.id, name: 'Checking', currency: 'USD' });
  const make = (date, description='Streambox', amountCents=-1299) => saveTransaction(db, { entityId: entity.id, accountId: account.id, date, description, amountCents, currency:'USD', category:'Entertainment', status:'review' });
  const rows = () => financeTransactionRows(db);
  const recurring = () => detectRecurring(rows(), {today})[0];
  const duplicate = () => findDuplicateCandidates(rows(), {accounts:[account]})[0];
  const send = (action, type, p, extra={}) => reviewFinance(db, {action,type,key:p.key,rowIds:p.rowIds,scope:{start:'2026-07-01',end:'2026-09-30'},...extra}, {today});
  return {db,entity,account,make,rows,recurring,duplicate,send};
}
test('confirm recurring keeps spending and review status, persists a receipt, and undo restores categories', t => {
  const f=fixture(t); for(const date of ['2026-07-15','2026-08-15','2026-09-15']) f.make(date);
  const p=f.recurring(); assert.ok(p);
  const before=getFinance(f.db,{month:'2026-09'}).summary;
  const first=f.send('confirm-recurring','recurring',p);
  assert.equal(f.rows().every(r=>r.category==='Recurring bill'&&r.status==='review'),true);
  assert.deepEqual(getFinance(f.db,{month:'2026-09'}).summary.currencies.map(c=>c.expenseCents),before.currencies.map(c=>c.expenseCents));
  assert.equal(f.send('confirm-recurring','recurring',p).decision.id,first.decision.id);
  assert.equal(listFinanceReviews(f.db).decisions.length,1);
  const undone=reviewFinance(f.db,{action:'undo',decisionId:first.decision.id}); assert.equal(undone.decision.undone,true);
  assert.equal(f.rows().every(r=>r.category==='Entertainment'&&r.status==='review'),true);
  assert.deepEqual(reviewFinance(f.db,{action:'undo',decisionId:first.decision.id}),undone);
});
test('dismiss changes no records and remains available after reopening the decision list',t=>{
  const f=fixture(t);for(const date of ['2026-07-15','2026-08-15','2026-09-15'])f.make(date);
  const before=f.rows(),p=f.recurring();const r=f.send('dismiss','recurring',p);
  assert.deepEqual(f.rows(),before);assert.equal(listFinanceReviews(f.db).decisions[0].id,r.decision.id);
  assert.throws(()=>f.send('confirm-recurring','recurring',p),/already reviewed/);
});
test('stale evidence and invalid actions never partially change records',t=>{
  const f=fixture(t);for(const date of ['2026-07-15','2026-08-15','2026-09-15'])f.make(date);
  const p=f.recurring();f.db.prepare('UPDATE finance_transactions SET amount_cents=-9999 WHERE id=?').run(p.rowIds[0]);const before=f.rows();
  assert.throws(()=>f.send('confirm-recurring','recurring',p),/evidence changed/i);assert.deepEqual(f.rows(),before);
  assert.throws(()=>reviewFinance(f.db,{action:'erase'}),/valid review/);
  assert.throws(()=>f.send('exclude-duplicate','recurring',p),/does not match/);
  assert.equal(listFinanceReviews(f.db).decisions.length,0);
});
test('duplicate exclusion affects exactly the selected record and undo cannot overwrite a later change',t=>{
  const f=fixture(t);f.make('2026-09-10','Office supplies',-4500);f.make('2026-09-11','Office supplies',-4500);
  const p=f.duplicate();assert.ok(p);const before=f.rows();const selected=p.rows[1];
  const r=f.send('exclude-duplicate','duplicate',p,{excludeId:selected.id});
  assert.equal(f.rows().filter(x=>x.status==='excluded').length,1);
  assert.deepEqual(f.rows().find(x=>x.id!==selected.id),before.find(x=>x.id!==selected.id));
  f.db.prepare('UPDATE finance_transactions SET description=? WHERE id=?').run('Corrected by user',selected.id);
  assert.throws(()=>reviewFinance(f.db,{action:'undo',decisionId:r.decision.id}),/changed after/);
  assert.equal(f.rows().find(x=>x.id===selected.id).description,'Corrected by user');
});
test('client cannot substitute a different account or repeat evidence rows',t=>{
  const f=fixture(t);for(const date of ['2026-07-15','2026-08-15','2026-09-15'])f.make(date);
  const p=f.recurring();const another=saveAccount(f.db,{entityId:f.entity.id,name:'Another account',currency:'USD'});
  f.db.prepare('UPDATE finance_transactions SET account_id=? WHERE id=?').run(another.id,p.rowIds[0]);
  assert.throws(()=>f.send('confirm-recurring','recurring',p),/evidence changed/i);
  assert.throws(()=>reviewFinance(f.db,{action:'dismiss',type:'recurring',key:p.key,rowIds:[p.rowIds[0],p.rowIds[0]]}),/complete suggestion/);
});

test('new contradictory surrounding evidence invalidates a previously displayed recurring suggestion',t=>{
  const f=fixture(t);for(const date of ['2026-07-15','2026-08-15','2026-09-15'])f.make(date);
  const p=f.recurring();f.make('2026-09-15');const before=f.rows();
  assert.throws(()=>f.send('confirm-recurring','recurring',p),/evidence changed/i);
  assert.deepEqual(f.rows(),before);
});
