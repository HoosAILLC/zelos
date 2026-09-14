import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installDom, text, findButton, settle, walk } from './helpers/ui-dom.mjs';
import * as finance from '../core/finance.mjs';
import { listFinanceReviews, reviewFinance } from '../core/finance-review.mjs';

let fixtureId = 0;
async function fixture(t, { empty = false } = {}) {
  const document = installDom(t);
  const createSVG=document.createElementNS;document.createElementNS=(ns,tag)=>{const n=createSVG(ns,tag);n.append=(...children)=>children.forEach(c=>n.appendChild(c));return n;};
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); finance.migrateFinance(db); t.after(() => db.close());
  let company, personal, bank, card;
  if (!empty) {
    company = finance.addEntity(db, { name: 'Studio One', type: 'company', defaultCurrency: 'USD' });
    personal = finance.addEntity(db, { name: 'Personal', type: 'personal', defaultCurrency: 'EUR' });
    bank = finance.saveAccount(db, { entityId: company.id, name: 'Checking', type: 'bank', currency: 'USD' });
    card = finance.saveAccount(db, { entityId: personal.id, name: 'Travel card', type: 'credit_card', currency: 'EUR' });
    finance.saveTransaction(db, { entityId: company.id, accountId: bank.id, date: '2026-09-11', description: 'Office supplies', amountCents: -1234, currency: 'USD', category: 'Office', status: 'review' });
    finance.saveTransaction(db, { entityId: personal.id, accountId: card.id, date: '2026-09-11', description: 'Travel refund', amountCents: 3000, currency: 'EUR', category: 'Travel' });
  }
  const { api } = await import('../ui/lib/api.js');
  const { bankApi } = await import('../ui/lib/bank-link.js');
  const bankState = { status: { configured: false, items: [], pending: [] } };
  const calls = [];
  const handlers = {
    finance: async options => finance.getFinance(db, { ...options, today: '2026-09-11' }),
    addFinanceEntity: async data => ({ entity: finance.addEntity(db, data) }),
    saveFinanceAccount: async data => ({ account: finance.saveAccount(db, data) }),
    importFinanceStatement: async data => finance.importStatement(db, data),
    saveFinanceTransaction: async data => ({ transaction: finance.saveTransaction(db, data) }),
    saveFinanceInvoice: async data => ({ invoice: finance.saveInvoice(db, data) }),
    exportFinanceCsv: async filters => new Blob([finance.exportFinanceCsv(db, filters)], { type: 'text/csv' }),
    financeReviews: async () => listFinanceReviews(db),
    reviewFinance: async body => reviewFinance(db, body),
    bankStatus: async () => bankState.status,
    bankAction: async () => ({ imported: 0, updated: 0, excluded: 0 }),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    if(name.startsWith('bank'))continue;
    const before = api[name]; api[name] = (...args) => { calls.push({ name, args: structuredClone(args) }); return handlers[name](...args); };
    t.after(() => { api[name] = before; });
  }
  for(const [name,handler] of [['status','bankStatus'],['action','bankAction']]) {
    const before=bankApi[name];bankApi[name]=(...args)=>{calls.push({name:handler,args:structuredClone(args)});return handlers[handler](...args);};
    t.after(()=>{bankApi[name]=before;});
  }
  const module = await import(`../ui/views/finance.js?fixture=${++fixtureId}`);
  const root = document.body.appendChild(module.renderFinance()); await settle();
  const f = { document, root, db, company, personal, bank, card, calls, handlers, bankState, module,
    input(label, value) {
      const node = root.querySelector(`[aria-label="${label}"]`); assert.ok(node, label);
      node.value = value; node.fire(node.tag === 'select' ? 'change' : 'input'); return node;
    },
    click(label) { if(!findButton(root,label)){const tab=/invoice|INV-42/.test(label)?'Invoices':'Transactions';findButton(root,tab)?.click();} const node = findButton(root, label); assert.ok(node, label); node.click(); return node; },
    submit() { const form = root.querySelector('form'); assert.ok(form); form.fire('submit'); },
    report: () => finance.getFinance(db, { month: '2026-09', today: '2026-09-11' }),
  };
  f.input('Spending period','custom'); f.input('Range start','2026-09-01');f.input('Range end','2026-09-30');f.click('Apply dates');await settle();
  return f;
}

test('money view renders separate currencies, links to document imports and identifies unconnected bank sign-ins', async t => {
  const f = await fixture(t);
  assert.match(text(f.root), /Total spending/);
  assert.match(text(f.root), /Use Link bank for Plaid connections/);
  assert.ok(f.root.querySelectorAll('a').some(link => link.getAttribute('href') === '#/documents/statement'));
  assert.equal(f.root.querySelectorAll('svg').length,2);
  assert.match(text(f.root), /12.34/);
  f.input('Summary currency','EUR');assert.match(text(f.root), /30.00/);
  f.input('Finance workspace filter',f.company.id);await settle();
  assert.equal(f.root.querySelector('[aria-label="Summary currency"]'),null);
  f.click('Transactions');assert.doesNotMatch(text(f.root), /Travel refund/);
});

test('returning from Imports reloads Money records while preserving an unfinished editor', async t => {
  const f = await fixture(t); f.click('Add transaction'); f.input('Description', 'My unfinished entry'); f.input('Amount', '14.25');
  f.root.remove();
  finance.saveTransaction(f.db, { entityId: f.company.id, accountId: f.bank.id, date: '2026-09-11', description: 'New imported record', amountCents: -1900, currency: 'USD' });
  f.document.body.appendChild(f.module.renderFinance()); await settle();
  assert.match(text(f.root), /New imported record/);
  assert.equal(f.root.querySelector('[aria-label="Description"]').value, 'My unfinished entry');
  assert.equal(f.root.querySelector('[aria-label="Amount"]').value, '14.25');
  assert.equal(f.calls.filter(call => call.name === 'saveFinanceTransaction').length, 0);
});

test('first-use workspace and account forms persist real local records', async t => {
  const f = await fixture(t, { empty: true });
  assert.match(text(f.root), /Add a company or personal workspace/);
  assert.equal(findButton(f.root, 'Import CSV'), undefined);
  f.click('Add workspace'); f.input('Workspace name', 'New Company'); f.input('Default currency', 'usd'); f.submit(); await settle();
  assert.equal(f.report().entities[0].name, 'New Company');
  f.click('Add account'); f.input('Account name', 'Business checking'); f.submit(); await settle();
  assert.equal(f.report().accounts[0].name, 'Business checking');
  assert.equal(f.report().accounts[0].currency, 'USD');
  f.click('Transactions');assert.equal(findButton(f.root, 'Import CSV').disabled, false);
});

test('manual entry uses exact integer cents and the selected company account', async t => {
  const f = await fixture(t);
  f.input('Finance workspace filter', f.company.id); await settle();
  f.click('Add transaction'); f.input('Account', f.bank.id); f.input('Transaction date', '2026-09-12');
  f.input('Description', 'Printer paper'); f.input('Amount', '0.29'); f.input('Category', 'Office'); f.submit(); await settle();
  const saved = f.report().transactions.find(row => row.description === 'Printer paper');
  assert.equal(saved.amountCents, -29); assert.equal(saved.entityId, f.company.id); assert.equal(saved.accountId, f.bank.id);
  assert.equal(saved.status, 'confirmed');
  assert.equal(f.calls.findLast(call => call.name === 'saveFinanceTransaction').args[0].amountCents, -29);
});

test('review editing can categorize, confirm and mark imported card payments as transfers', async t => {
  const f = await fixture(t);
  f.click('Edit Office supplies'); f.input('Category', 'Card payment'); f.input('Money direction', 'transfer_out'); f.input('Review status', 'confirmed'); f.submit(); await settle();
  const saved = f.report().transactions.find(row => row.description === 'Office supplies');
  assert.equal(saved.kind, 'transfer'); assert.equal(saved.category, 'Card payment'); assert.equal(saved.status, 'confirmed');
  assert.equal(f.report().summary.currencies.find(value => value.currency === 'USD').expenseCents, 0);
});

test('CSV upload previews real rows, accepts mapping and performs deduplicated imports', async t => {
  const f = await fixture(t);
  f.input('Finance workspace filter', f.company.id); await settle();
  const csv = 'Posted,Merchant,Charge\n09/10/2026,Paper shop,10.25\n09/11/2026,Paper refund,-2.10';
  async function importFile() {
    f.click('Import CSV'); f.input('Import account', f.bank.id);
    const file = f.root.querySelector('[aria-label="Statement CSV file"]'); file.files = [{ name: 'statement.csv', size: csv.length, text: async () => csv }]; file.fire('change'); await settle();
    assert.match(text(f.root.querySelector('[aria-label="Statement sample"]')), /Paper shop/);
    f.input('CSV date', '0'); f.input('CSV description', '1'); f.input('CSV amount', '2');
    f.input('CSV date format', 'mdy'); f.input('CSV amount direction', 'invert'); f.click('Import transactions'); await settle();
  }
  await importFile();
  assert.equal(f.report().transactions.find(row => row.description === 'Paper shop').amountCents, -1025);
  assert.equal(f.report().transactions.find(row => row.description === 'Paper refund').amountCents, 210);
  assert.match(text(f.root), /2 imported; 0 previously imported/);
  await importFile(); assert.match(text(f.root), /0 imported; 2 previously imported/);
  assert.equal(f.report().transactions.filter(row => row.source === 'csv').length, 2);
});

test('CSV errors preserve the mapping screen and show an actionable row error without partial records', async t => {
  const f = await fixture(t);
  f.click('Import CSV'); f.input('Import workspace', f.company.id); f.input('Import account', f.bank.id);
  const csv = 'Date,Description,Amount\n2026-09-10,Valid,-5.00\n2026-02-30,Invalid,-6.00';
  const file = f.root.querySelector('[aria-label="Statement CSV file"]'); file.files = [{ name: 'bad.csv', size: csv.length, text: async () => csv }]; file.fire('change'); await settle();
  f.click('Import transactions'); await settle();
  assert.match(text(f.root.querySelector('[role="alert"]')), /Nothing was imported.*row 3/);
  assert.ok(f.root.querySelector('.finance-import'));
  assert.equal(f.report().transactions.filter(row => row.source === 'csv').length, 0);
});

test('invoice entry and paid status persist without adding a duplicate cash transaction', async t => {
  const f = await fixture(t);
  f.input('Finance workspace filter', f.company.id); await settle();
  f.click('Add invoice'); f.input('Invoice number', 'INV-42'); f.input('Client or supplier', 'Example client');
  f.input('Issue date', '2026-09-01'); f.input('Due date', '2026-09-10'); f.input('Invoice amount', '150.29'); f.submit(); await settle();
  assert.equal(f.report().invoices[0].amountCents, 15029);
  const before = f.report().transactions.length;
  f.click('Mark paid INV-42'); await settle();
  assert.equal(f.report().invoices[0].status, 'paid'); assert.equal(f.report().transactions.length, before);
  f.click('Mark unpaid INV-42'); await settle(); assert.equal(f.report().invoices[0].status, 'unpaid');
});

test('transaction search preserves focus and hostile descriptions remain text', async t => {
  const f = await fixture(t);
  finance.saveTransaction(f.db, { entityId: f.company.id, date: '2026-09-11', description: '<img src=x onerror=alert(1)>', amountCents: -200, currency: 'USD', category: 'Test' });
  f.click('Refresh'); await settle();
  f.click('Transactions');const search = f.input('Search transactions', '<img'); search.focus();
  assert.equal(document.activeElement, search);
  assert.match(text(f.root.querySelector('[aria-label="Transactions"]')), /<img src=x onerror=alert\(1\)>/);
  assert.equal(f.root.querySelectorAll('img').length, 0);
  assert.equal(f.root.querySelectorAll('script').length, 0);
});

test('CSV download exports authenticated loaded records within the selected filters', async t => {
  const f = await fixture(t);
  let output;
  t.mock.method(URL, 'createObjectURL', blob => { output = blob; return 'blob:synthetic-finance'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.input('Finance workspace filter', f.company.id); await settle(); f.click('Export ↗'); await settle();
  assert.ok(output instanceof Blob); assert.match(await output.text(), /Office supplies/); assert.doesNotMatch(await output.text(), /Travel refund/);
  assert.ok(f.calls.some(call=>call.name==='finance'&&call.args[0].entityId===f.company.id));
  assert.match(text(f.root), /Exported the selected date range/); t.mock.timers.tick(1000);
});

test('invalid manual amount never reaches the server and keeps the editor', async t => {
  const f = await fixture(t);
  f.click('Add transaction'); f.input('Description', 'Invalid amount'); f.input('Amount', '1.234'); f.submit(); await settle();
  assert.match(text(f.root.querySelector('[role="alert"]')), /at most two decimal places/);
  assert.ok(f.root.querySelector('.finance-editor'));
  assert.equal(f.calls.filter(value => value.name === 'saveFinanceTransaction').length, 0);
});

test('Personal and Business sections separate accounts, charts, transactions and invoices',async t=>{
 const f=await fixture(t);
 finance.saveInvoice(f.db,{entityId:f.company.id,direction:'payable',number:'BUS-1',counterparty:'Business vendor',issueDate:'2026-09-01',dueDate:'2026-09-20',amountCents:8000,currency:'USD'});
 finance.saveInvoice(f.db,{entityId:f.personal.id,direction:'payable',number:'PER-1',counterparty:'Personal vendor',issueDate:'2026-09-01',dueDate:'2026-09-20',amountCents:5000,currency:'EUR'});
 f.click('Personal');await settle();assert.match(text(f.root),/Your personal finances/);assert.doesNotMatch(text(f.root.querySelector('[aria-label="Money account"]')),/Checking/);
 f.click('Transactions');assert.match(text(f.root),/Travel refund/);assert.doesNotMatch(text(f.root),/Office supplies/);
 f.click('Invoices');assert.match(text(f.root),/Personal vendor/);assert.doesNotMatch(text(f.root),/Business vendor/);
 f.click('Business');await settle();assert.match(text(f.root),/Business vendor/);assert.doesNotMatch(text(f.root),/Personal vendor/);
 f.click('Overview');assert.match(text(f.root),/Your companies/);assert.ok(findButton(f.root,'Open company Studio One'));
 assert.doesNotMatch(text(f.root.querySelector('[aria-label="Money account"]')),/Travel card/);
 f.click('Transactions');assert.match(text(f.root),/Office supplies/);assert.doesNotMatch(text(f.root),/Travel refund/);
 f.click('All finances');await settle();assert.ok(f.root.querySelector('[aria-label="Summary currency"]'));
});

test('Business section can create a company without misclassifying it as personal',async t=>{
 const f=await fixture(t,{empty:true});f.click('Business');await settle();assert.match(text(f.root),/Give each company its own workspace/);
 f.click('Add company');f.input('Workspace name','Second Company');f.submit();await settle();
 assert.equal(f.report().entities[0].type,'company');assert.ok(findButton(f.root,'Open company Second Company'));
});

test('section switching is disabled while an unsaved editor is open',async t=>{
 const f=await fixture(t);f.click('Add transaction');f.input('Description','Keep this draft');
 assert.equal(findButton(f.root,'Business').disabled,true);assert.equal(findButton(f.root,'Personal').disabled,true);
 findButton(f.root,'Business').click();assert.equal(f.root.querySelector('[aria-label="Description"]').value,'Keep this draft');
 assert.equal(f.calls.filter(c=>c.name==='saveFinanceTransaction').length,0);
});

function linkedSnapshot(f) {
  return {configured:true,items:[{id:'bank-connection',institution:'Snapshot Bank',accounts:[
    {id:'remote-bank',mapping:{accountId:f.bank.id},balances:{currentCents:null,availableCents:0,currency:'USD',retrievedAt:'2026-09-14T15:00:00Z',sourceUpdatedAt:'2026-09-13T11:00:00Z',cached:true}},
    {id:'remote-card',mapping:{accountId:f.card.id},balances:{currentCents:-700,availableCents:null,currency:'EUR',retrievedAt:'2026-09-14T15:00:00Z',sourceUpdatedAt:null,cached:true}},
  ]}],pending:[
    {id:'pending-business',itemId:'bank-connection',accountId:f.bank.id,entityId:f.company.id,date:'2026-08-31',description:'Unposted office purchase',amountCents:-9999,currency:'USD',kind:'expense'},
    {id:'pending-personal',itemId:'bank-connection',accountId:f.card.id,entityId:f.personal.id,date:'2026-09-14',description:'Unposted personal purchase',amountCents:-2500,currency:'EUR',kind:'expense'},
  ]};
}

test('cached balances distinguish unknown, zero and card credit with retrieval separate from bank update',async t=>{
  const f=await fixture(t);f.bankState.status=linkedSnapshot(f);f.click('Refresh');await settle();
  const panel=f.root.querySelector('[aria-label="Bank balance snapshot"]');
  const bank=panel.querySelector(`[aria-label="Balance for ${f.bank.name}"]`);
  assert.equal(text(bank.querySelector('.money-balance-amount')),'Unavailable');
  assert.match(text(bank),/Available to spend.*0.00/);
  assert.match(text(bank),/Retrieved by Zelos:.*Sep 14, 2026.*Updated by bank:.*Sep 13, 2026/);
  assert.doesNotMatch(text(panel),/Travel card/);
  f.input('Summary currency','EUR');
  const card=f.root.querySelector(`[aria-label="Balance for ${f.card.name}"]`);
  assert.match(text(card),/Credit on card.*7.00/);assert.match(text(card),/Updated by bank: Unavailable/);
  assert.doesNotMatch(text(f.root.querySelector('[aria-label="Bank balance snapshot"]')),/Checking/);
  f.click('Business');await settle();assert.ok(f.root.querySelector(`[aria-label="Balance for ${f.bank.name}"]`));
});

test('pending entries stay outside historical spending, posted rows and CSV exports while respecting ownership',async t=>{
  const f=await fixture(t);f.bankState.status=linkedSnapshot(f);f.click('Refresh');await settle();
  assert.match(text(f.root.querySelector('.money-hero-main')),/12.34/);
  f.click('Pending');const pending=f.root.querySelector('[aria-label="Pending transactions"]');
  assert.match(text(pending),/2026-08-31.*Unposted office purchase/);assert.doesNotMatch(text(pending),/personal purchase/);
  assert.match(text(f.root),/spending date filter does not apply/);
  f.click('Transactions');assert.doesNotMatch(text(f.root.querySelector('[aria-label="Transactions"]')),/Unposted/);
  let output;t.mock.method(URL,'createObjectURL',blob=>{output=blob;return 'blob:test';});t.mock.method(URL,'revokeObjectURL',()=>{});
  t.mock.timers.enable({apis:['setTimeout']});f.click('Export ↗');assert.doesNotMatch(await output.text(),/Unposted/);t.mock.timers.tick(1000);
  f.click('Personal');await settle();f.click('Pending');
  assert.match(text(f.root.querySelector('[aria-label="Pending transactions"]')),/Unposted personal purchase/);
  assert.doesNotMatch(text(f.root.querySelector('[aria-label="Pending transactions"]')),/office purchase/);
});

test('a bank balance with missing or changed currency renders unavailable inside its local account scope',async t=>{
  const f=await fixture(t);f.bankState.status=linkedSnapshot(f);
  const balance=f.bankState.status.items[0].accounts[0].balances;
  for(const currency of [null,'EUR']) {
    Object.assign(balance,{currency,currentCents:123456,availableCents:123456});f.click('Refresh');await settle();
    const card=f.root.querySelector(`[aria-label="Balance for ${f.bank.name}"]`);assert.ok(card);
    assert.equal(text(card.querySelector('.money-balance-amount')),'Unavailable');
    assert.doesNotMatch(text(card),/1,234.56/);assert.match(text(card),/currency could not be matched/);
  }
});

test('bank status failure degrades the snapshot while posted finance remains usable',async t=>{
  const f=await fixture(t);f.handlers.bankStatus=async()=>{throw new Error('Bank service unavailable');};f.click('Refresh');await settle();
  assert.match(text(f.root.querySelector('[aria-label="Bank balance snapshot"]')),/Bank snapshot could not be reloaded/);
  assert.match(text(f.root.querySelector('.money-hero-main')),/12.34/);
  f.click('Transactions');assert.match(text(f.root.querySelector('[aria-label="Transactions"]')),/Office supplies/);
});

test('bank sync uses the actual sync action once and reloads cached values',async t=>{
  const f=await fixture(t);f.bankState.status=linkedSnapshot(f);f.click('Refresh');await settle();
  let finish;f.handlers.bankAction=()=>new Promise(resolve=>{finish=resolve;});
  const trigger=f.click('Sync Snapshot Bank');trigger.click();
  assert.equal(findButton(f.root,'Sync Snapshot Bank').disabled,true);
  assert.equal(f.calls.filter(c=>c.name==='bankAction').length,1);
  assert.deepEqual(f.calls.find(c=>c.name==='bankAction').args,['sync',{itemId:'bank-connection'}]);
  f.bankState.status.items[0].accounts[0].balances.currentCents=45678;finish({imported:2,updated:1});await settle();
  assert.match(text(f.root.querySelector('[aria-label="Bank balance snapshot"]')),/456.78/);
  assert.equal(findButton(f.root,'Sync Snapshot Bank').disabled,false);
});

const actionStarting=(root,prefix)=>walk(root).find(node=>node.tag==='button'&&node.getAttribute('aria-label')?.startsWith(prefix));
const expandSimilar=root=>{const section=root.querySelector('.money-similar-charges');assert.ok(section);section.open=true;return section;};
test('recurring review confirms only selected evidence and Undo restores the categories',async t=>{
  const f=await fixture(t);
  for(const date of ['2026-07-10','2026-08-10','2026-09-10'])finance.saveTransaction(f.db,{entityId:f.company.id,accountId:f.bank.id,date,description:'Cloud Studio',amountCents:-1299,currency:'USD',category:'Office',status:'review'});
  f.input('Range start','2026-07-01');f.click('Apply dates');await settle();f.click('Review suggestions');
  assert.match(text(f.root),/Possible recurring charge/);assert.match(text(f.root),/estimate, not a bill/);
  const confirm=actionStarting(f.root,'Confirm recurring ');assert.ok(confirm);confirm.click();confirm.click();await settle();
  const calls=f.calls.filter(c=>c.name==='reviewFinance');assert.equal(calls.length,1);assert.equal(calls[0].args[0].rowIds.length,3);assert.deepEqual(calls[0].args[0].scope,{start:'2026-07-01',end:'2026-09-30'});
  assert.equal(calls[0].args[0].action,'confirm-recurring');assert.equal(f.report().transactions.find(row=>row.description==='Cloud Studio').category,'Recurring bill');
  assert.match(text(f.root),/Recent review decisions/);assert.equal(actionStarting(f.root,'Confirm recurring '),undefined);
  const undo=actionStarting(f.root,'Undo review decision ');assert.ok(undo);undo.click();await settle();
  assert.equal(f.report().transactions.find(row=>row.description==='Cloud Studio').category,'Office');assert.ok(actionStarting(f.root,'Confirm recurring '));
});

test('duplicate review dismisses persistently, restores suggestions on Undo and excludes the exact chosen entry',async t=>{
  const f=await fixture(t);
  finance.saveTransaction(f.db,{entityId:f.company.id,accountId:f.bank.id,date:'2026-09-12',description:'Office supplies',amountCents:-1234,currency:'USD',category:'Office',status:'review'});
  f.click('Refresh');await settle();f.click('Review suggestions');
  assert.equal(f.root.querySelector('.money-similar-charges').open,false);expandSimilar(f.root);
  const dismiss=actionStarting(f.root,'Dismiss duplicate suggestion ');assert.ok(dismiss);dismiss.click();await settle();
  assert.equal(actionStarting(f.root,'Dismiss duplicate suggestion '),undefined);
  f.root.remove();f.document.body.appendChild(f.module.renderFinance());await settle();
  assert.equal(actionStarting(f.root,'Dismiss duplicate suggestion '),undefined);assert.ok(actionStarting(f.root,'Undo review decision '));
  f.click('Personal');await settle();assert.equal(actionStarting(f.root,'Undo review decision '),undefined);
  f.click('Business');await settle();actionStarting(f.root,'Undo review decision ').click();await settle();
  expandSimilar(f.root);
  const exclude=actionStarting(f.root,'Exclude duplicate entry 2:');assert.ok(exclude);exclude.click();await settle();
  const choice=f.calls.filter(c=>c.name==='reviewFinance').at(-1).args[0];assert.equal(choice.action,'exclude-duplicate');
  const rows=f.report().transactions;assert.equal(rows.filter(r=>r.status==='excluded').length,1);assert.equal(rows.find(r=>r.id===choice.excludeId).status,'excluded');
  actionStarting(f.root,'Undo review decision ').click();await settle();assert.equal(f.report().transactions.filter(r=>r.status==='excluded').length,0);
});

test('review list errors leave evidence visible but disable edits until saved decisions are available',async t=>{
  const f=await fixture(t);finance.saveTransaction(f.db,{entityId:f.company.id,accountId:f.bank.id,date:'2026-09-12',description:'Office supplies',amountCents:-1234,currency:'USD',category:'Office'});
  f.handlers.financeReviews=async()=>{throw new Error('Try again');};f.click('Refresh');await settle();f.click('Review suggestions');
  assert.match(text(f.root),/Saved review decisions could not be loaded/);
  expandSimilar(f.root);
  const exclude=actionStarting(f.root,'Exclude duplicate entry ');assert.ok(exclude);assert.equal(exclude.disabled,true);exclude.click();
  assert.equal(f.calls.filter(c=>c.name==='reviewFinance').length,0);
});

test('review queue puts recurring and cross-source evidence first and keeps same-source charges collapsed and reviewable',async t=>{
  const f=await fixture(t);
  const add=(date,description,amountCents=-900)=>finance.saveTransaction(f.db,{entityId:f.company.id,accountId:f.bank.id,date,description,amountCents,currency:'USD',category:'Office',status:'review'});
  for(const date of ['2026-07-10','2026-08-10','2026-09-10'])add(date,'Cloud Studio',-1299);
  for(const description of ['Morning coffee','Printer paper','Fallback purchase'])for(const date of ['2026-09-09','2026-09-10'])add(date,description);
  const loadFinance=f.handlers.finance;
  f.handlers.finance=async options=>{
    const data=await loadFinance(options);
    return {...data,transactions:data.transactions.map(row=>{
      const first=row.date==='2026-09-09';
      if(row.description==='Morning coffee')return {...row,source:first?'manual':'csv',importSource:'bank',reference:'Plaid transaction opaque-coffee-reference'};
      if(row.description==='Printer paper')return {...row,source:'csv',importSource:first?'bank':'document',reference:first?'opaque-bank-reference':'invoice-102'};
      if(row.description==='Fallback purchase')return {...row,source:first?'manual':'csv',importSource:undefined,reference:'receipt-99'};
      return row;
    })};
  };
  f.input('Range start','2026-07-01');f.click('Apply dates');await settle();f.click('Review suggestions');
  const panel=f.root.querySelector('[aria-label="Money review suggestions"]');
  const primary=panel.children.filter(node=>node.getAttribute('class')==='money-suggestion');
  assert.equal(primary.length,3);assert.match(text(primary[0]),/Possible recurring charge.*Cloud Studio/);
  assert.match(primary.slice(1).map(text).join(' '),/Printer paper/);assert.match(primary.slice(1).map(text).join(' '),/Fallback purchase/);
  assert.doesNotMatch(primary.map(text).join(' '),/Morning coffee/);
  assert.match(text(panel.querySelector('h2')),/Review suggestions · 3/);
  const similar=panel.querySelector('.money-similar-charges');assert.ok(similar);assert.equal(similar.open,false);
  assert.equal(text(similar.querySelector('summary')),'Show similar charges from the same source (1)');
  assert.match(text(similar),/may be genuine separate purchases/);assert.match(text(similar),/Morning coffee/);
  assert.equal(similar.querySelectorAll('.money-suggestion').length,1);
  expandSimilar(f.root);assert.equal(similar.open,true);assert.ok(actionStarting(similar,'Exclude duplicate entry '));assert.ok(actionStarting(similar,'Dismiss duplicate suggestion '));
  assert.equal(f.calls.filter(c=>c.name==='reviewFinance').length,0);
  assert.doesNotMatch(text(panel),/opaque-coffee-reference|opaque-bank-reference/);
  assert.match(text(panel),/Bank sync/);assert.match(text(panel),/Document import/);
  assert.match(text(panel),/Reference: invoice-102/);assert.match(text(panel),/Reference: receipt-99/);
});
