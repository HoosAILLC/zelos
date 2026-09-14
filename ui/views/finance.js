import { loadingState } from '../lib/loading.js';
/** Local statements, reviewed transactions, and company/personal money views. */
import { el, button, focusQuietly } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { createBankPanel, bankApi } from '../lib/bank-link.js';
import { disclosure } from '../lib/workspace.js';
import { analyzeMoney, monthList, presetRange, merchantName, exportRowsCsv } from '../lib/money-analysis.js';
import { spendingChart, categoryChart as spendingMix, ownedCategories, monthlyChart, merchantsChart, insights, subscriptionPanel, dateLabel } from '../lib/money-charts.js';

import { ownershipAnalysis, ownershipSplit, ownershipMonthly, ownershipFlow, ownershipWorkspaces } from '../lib/money-ownership.js';
import { balancePresentation, scopedBankSnapshot, scopedReviewDecisions, snapshotTime } from '../lib/money-accuracy.js';
import { detectRecurring, findDuplicateCandidates } from '../lib/money-patterns.js';

const view = { root: null, data: null, entityId: '', month: localDay().slice(0, 7), loading: false,
  bankPanel:null, bankStatus:null, bankError:'', decisions:[], reviewError:'', request: 0, busy: false, error: '', notice: '', editor: null, importing: null, search: '', review: 'all', limit: 100, tab: 'overview', currency: 'USD', section:'all', preset:'activity', start:'', end:'', draftStart:'', draftEnd:'', accountId:'', chartMode:'cumulative', drill:null };
function localDay() { const day = new Date(); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; }
const note = message => el('p', { class: 'finance-note', text: message });
const field = (label, control) => el('label', { class: 'finance-field' }, [el('span', { text: label }), control]);
const allEntities = () => view.data?.entities || [];
const entities = () => allEntities().filter(entity=>view.section==='all'||entity.type===(view.section==='business'?'company':'personal'));
const ownerOf=id=>{const type=allEntities().find(e=>e.id===id)?.type;return type==='personal'?'personal':type==='company'?'business':'unassigned';};
const ownerLabel=key=>key==='personal'?'Personal':key==='business'?'Business':'Unassigned';
const ownerBadge=id=>el('span',{class:'money-owner-badge','data-owner':ownerOf(id),text:ownerLabel(ownerOf(id))});
function showOwner(section){view.section=section;view.entityId='';view.accountId='';view.drill=null;view.search='';view.review='all';load();}
function showWorkspace(id){view.entityId=id;view.accountId='';view.drill=null;load();}
const sectionLabel=()=>view.section==='business'?'Business':view.section==='personal'?'Personal':'All finances';
const accountName = id => view.data?.accounts.find(account => account.id === id)?.name || 'Manual';
const entityName = id => entities().find(entity => entity.id === id)?.name || '';
const money = (value, code) => new Intl.NumberFormat(undefined, { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((value || 0) / 100);
const decimal = value => (Math.abs(value || 0) / 100).toFixed(2);
const entityDefault = () => view.entityId || entities()[0]?.id || '';
const defaultCurrency = entityId => entities().find(entity => entity.id === entityId)?.defaultCurrency || 'USD';

export function financeInputCents(raw) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(raw).trim())) throw new Error('Enter an amount such as 24.50, with at most two decimal places.');
  const [whole, fraction = ''] = String(raw).trim().split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value > 1_000_000_000_000) throw new Error('This amount is too large.');
  return value;
}

function input(label, value, update, props = {}) {
  const node = el('input', { class: 'input', 'aria-label': label, value: value ?? '', ...props });
  node.addEventListener('input', () => update(node.value));
  return node;
}
function select(label, value, options, update) {
  const node = el('select', { class: 'input', 'aria-label': label }, options.map(([key, name]) => el('option', { value: key, text: name })));
  node.value = value ?? '';
  node.addEventListener('change', () => update(node.value));
  return node;
}
async function load() {
  const request = ++view.request; view.loading = true; view.error = ''; paint();
  const extras = Promise.allSettled([bankApi.status(), api.financeReviews()]);
  try {
    const range=view.preset==='custom'?{start:view.draftStart,end:view.draftEnd}:presetRange(view.preset,localDay());
    const months=monthList(range.start,range.end), results=[];
    for(let i=0;i<months.length;i+=4){
      const batch=await Promise.all(months.slice(i,i+4).map(month=>api.finance({entityId:view.entityId,month})));
      if(request!==view.request)return;
      results.push(...batch);
    }
    const transactions=[...new Map(results.flatMap(r=>r.transactions||[]).map(t=>[t.id,t])).values()].filter(t=>t.date>=range.start&&t.date<=range.end);
    view.data={...results.at(-1),transactions};
    const dates=transactions.map(t=>t.date).sort();
    view.start=view.preset==='activity'&&dates.length?dates[0]:range.start;
    view.end=view.preset==='activity'&&dates.length?dates.at(-1):range.end;
    view.draftStart=view.start;view.draftEnd=view.end;
    const [bank, reviews] = await extras;
    if(request!==view.request)return;
    view.bankError=bank.status==='rejected'?bank.reason.message:'';
    if(bank.status==='fulfilled')view.bankStatus=bank.value;
    view.reviewError=reviews.status==='rejected'?reviews.reason.message:'';
    view.decisions=reviews.status==='fulfilled'?reviews.value.decisions||[]:[];
  } catch (error) { if(request===view.request){view.error=error.message;view.data=null;} }
  finally { if (request === view.request) { view.loading = false; paint(); } }
}
function rangeLabel(){return view.start&&view.end?`${dateLabel(view.start)}, ${view.start.slice(0,4)} – ${dateLabel(view.end)}, ${view.end.slice(0,4)}`:'Selected period';}
function scopeRows(){const allowed=new Set(entities().map(e=>e.id));return (view.data?.transactions||[]).filter(t=>allowed.has(t.entityId)&&(!view.entityId||t.entityId===view.entityId)&&(!view.accountId||t.accountId===view.accountId)&&t.currency===view.currency);}
const snapshotScope=()=>({entities:allEntities(),section:view.section,entityId:view.entityId,accountId:view.accountId,currency:view.currency});
const bankSnapshot=()=>scopedBankSnapshot(view.bankStatus,view.data?.accounts||[],snapshotScope());
function drillTo(type,value){view.drill={type,value};view.search='';view.review='all';view.tab='transactions';view.limit=100;paint();view.root.querySelector('.finance-transactions')?.scrollIntoView?.({behavior:'smooth',block:'start'});}
function chooseMonth(month){view.preset='custom';view.draftStart=month+'-01';const last=new Date(month+'-01T12:00:00Z');last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);view.draftEnd=last.toISOString().slice(0,10);view.drill=null;load();}
function filteredRows(){const q=view.search.toLowerCase();return scopeRows().filter(t=>{
  if(view.review!=='all'&&t.status!==view.review)return false;
  if(!`${t.description} ${merchantName(t.description)} ${t.category} ${accountName(t.accountId)}`.toLowerCase().includes(q))return false;
  if(!view.drill)return true;
  if(t.status==='excluded'||t.kind==='transfer'||t.amountCents>=0)return false;
  return view.drill.type==='category'?t.category===view.drill.value:view.drill.type==='merchant'?merchantName(t.description)===view.drill.value:t.date===view.drill.value;
});}
async function act(operation, done = () => {}) {
  if (view.busy) return;
  view.busy = true; view.error = ''; paint();
  try { const result = await operation(); done(result); await load(); }
  catch (error) { view.error = error.message; }
  finally { view.busy = false; paint(); }
}
function openEditor(type, record = {}) {
  if (view.busy) return;
  if(type==='transaction') view.tab='transactions';
  if(type==='invoice') view.tab='invoices';
  const entityId = record.entityId || entityDefault();
  let values = { ...record, entityId, currency: record.currency || defaultCurrency(entityId) };
  if (type === 'entity') values = { name: '', type: view.section==='personal'?'personal':'company', defaultCurrency: 'USD', ...record };
  if (type === 'account') values = { ...values, name: record.name || '', type: record.type || 'bank' };
  if (type === 'transaction') values = { ...values, accountId: record.accountId || '', date: record.date || localDay(), description: record.description || '',
    amount: record.id ? decimal(record.amountCents) : '', direction: record.kind === 'transfer' ? record.amountCents < 0 ? 'transfer_out' : 'transfer_in' : record.amountCents > 0 ? 'income' : 'expense',
    category: record.category || 'Uncategorized', status: record.status || 'confirmed' };
  if (type === 'invoice') values = { ...values, direction: record.direction || 'receivable', number: record.number || '', counterparty: record.counterparty || '',
    description: record.description || '', issueDate: record.issueDate || localDay(), dueDate: record.dueDate || localDay(), amount: record.id ? decimal(record.amountCents) : '',
    status: record.status || 'unpaid', paidDate: record.paidDate || localDay() };
  view.editor = { type, values }; view.importing = null; view.error = ''; paint();
  const panel = view.root.querySelector('.finance-editor'); panel?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); focusQuietly(panel?.querySelector('input'));
}
function editorPanel() {
  const { type, values } = view.editor;
  const labels = { entity: 'workspace', account: 'account', transaction: 'transaction', invoice: 'invoice' };
  const fields = [];
  const write = key => value => { values[key] = value; };
  const edit = (label, key, props = {}) => fields.push(field(label, input(label, values[key], write(key), props)));
  const choose = (label, key, options, onChange = write(key)) => fields.push(field(label, select(label, values[key], options, onChange)));
  if (type !== 'entity') choose('Workspace', 'entityId', entities().map(entity => [entity.id, entity.name]), value => {
    values.entityId = value; values.accountId = ''; values.currency = defaultCurrency(value); paint();
  });
  if (type === 'entity') {
    edit('Workspace name', 'name', { maxLength: 120, placeholder: 'Company name or Personal' });
    choose('Workspace type', 'type', [['company', 'Company'], ['personal', 'Personal']]);
    edit('Default currency', 'defaultCurrency', { maxLength: 3, placeholder: 'USD' });
  } else if (type === 'account') {
    edit('Account name', 'name', { maxLength: 120, placeholder: 'Checking or a card nickname' });
    choose('Account type', 'type', [['bank', 'Bank'], ['credit_card', 'Credit card'], ['cash', 'Cash'], ['other', 'Other']]);
    edit('Currency', 'currency', { maxLength: 3 });
  } else if (type === 'transaction') {
    choose('Account', 'accountId', [['', 'Manual · no account'], ...(view.data.accounts || []).filter(account => account.entityId === values.entityId).map(account => [account.id, `${account.name} · ${account.currency}`])], value => {
      values.accountId = value; const account = view.data.accounts.find(account => account.id === value); if (account) values.currency = account.currency; paint();
    });
    edit('Transaction date', 'date', { type: 'date' });
    edit('Description', 'description', { maxLength: 500, placeholder: 'Who or what was this for?' });
    choose('Money direction', 'direction', [['expense', 'Money out'], ['income', 'Money in / refund'], ['transfer_out', 'Transfer out'], ['transfer_in', 'Transfer in']]);
    edit('Amount', 'amount', { inputmode: 'decimal', placeholder: '0.00' });
    edit('Currency', 'currency', { maxLength: 3, disabled: Boolean(values.accountId) });
    edit('Category', 'category', { maxLength: 80, placeholder: 'Office, travel, groceries…' });
    choose('Review status', 'status', [['confirmed', 'Reviewed'], ['review', 'Needs review'], ['excluded', 'Exclude from totals']]);
  } else {
    choose('Invoice direction', 'direction', [['receivable', 'A client owes you'], ['payable', 'You owe a supplier']]);
    edit('Invoice number', 'number', { maxLength: 80 }); edit('Client or supplier', 'counterparty', { maxLength: 160 });
    edit('Invoice description', 'description', { maxLength: 1000 });
    edit('Issue date', 'issueDate', { type: 'date' }); edit('Due date', 'dueDate', { type: 'date' });
    edit('Invoice amount', 'amount', { inputmode: 'decimal', placeholder: '0.00' }); edit('Currency', 'currency', { maxLength: 3 });
    choose('Invoice status', 'status', [['unpaid', 'Unpaid'], ['paid', 'Paid']], value => { values.status = value; paint(); });
    if (values.status === 'paid') edit('Paid date', 'paidDate', { type: 'date' });
  }
  const form = el('form', { class: 'finance-editor finance-panel workspace-form', 'aria-label': `${values.id ? 'Edit' : 'Add'} ${labels[type]}` }, [
    el('h2', { text: `${values.id ? 'Edit' : 'Add'} ${labels[type]}` }),
    type === 'account' && note('A local account keeps imports organized. This does not connect to your bank.'),
    el('fieldset', { disabled: view.busy, class: 'finance-form-grid' }, fields),
    type === 'transaction' && note('Mark card payments and movements between accounts as transfers. Transfers and excluded entries stay in your records but do not count as money in or out.'),
    type === 'invoice' && note('Marking an invoice paid updates its status. Record the bank payment separately, or import it from a statement.'),
    el('div', { class: 'finance-actions' }, [button(view.busy ? 'Saving…' : 'Save', { type: 'submit', class: 'btn', disabled: view.busy }), button('Cancel', { class: 'btn quiet', disabled: view.busy, onClick: () => { view.editor = null; view.error = ''; paint(); } })]),
  ]);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (view.busy) return;
    let data = { ...values };
    try {
      if (type === 'transaction') {
        const amount = financeInputCents(values.amount), negative = ['expense', 'transfer_out'].includes(values.direction);
        data = { id: values.id, entityId: values.entityId, accountId: values.accountId || null, date: values.date, description: values.description,
          amountCents: negative ? -amount : amount, currency: values.currency.toUpperCase(), category: values.category,
          kind: values.direction.startsWith('transfer') ? 'transfer' : values.direction, status: values.status };
      }
      if (type === 'invoice') { data.amountCents = financeInputCents(values.amount); data.currency = values.currency.toUpperCase(); delete data.amount; }
      if (type === 'entity') data.defaultCurrency = values.defaultCurrency.toUpperCase();
      if (type === 'account') data.currency = values.currency.toUpperCase();
    } catch (error) { view.error = error.message; paint(); return; }
    const methods = { entity: 'addFinanceEntity', account: 'saveFinanceAccount', transaction: 'saveFinanceTransaction', invoice: 'saveFinanceInvoice' };
    act(() => api[methods[type]](data), result => {
      if (type === 'entity') {const entity=result.entity||result;view.entityId=entity.id;if(view.section!=='all')view.section=entity.type==='company'?'business':'personal';}
      view.editor = null; view.notice = `${labels[type][0].toUpperCase() + labels[type].slice(1)} saved.`;
    });
  });
  return form;
}

function startImport() {
  view.editor = null; view.error = ''; view.importing = { entityId: entityDefault(), accountId: '', csv: '', filename: '', preview: null, mapping: {}, dateFormat: 'ymd', amountSign: 'signed', decimalSeparator: '.', request: 0 };
  paint(); view.root.querySelector('.finance-import')?.scrollIntoView?.({ behavior: 'smooth' });
}
async function readStatement(file) {
  const importing = view.importing; if (!file || !importing) return;
  const request = ++importing.request;
  view.error = ''; importing.preview = null;
  try {
    if (file.size > 2_000_000 || !/\.(csv|tsv|txt)$/i.test(file.name)) throw new Error('Choose a CSV or tab-separated text file smaller than 2 MB. Use Imports for PDF or image statements.');
    const csv = await file.text();
    const preview = await api.importFinanceStatement({ csv, preview: true });
    if (view.importing !== importing || request !== importing.request) return;
    importing.csv = csv; importing.filename = file.name; importing.preview = preview.preview; importing.rowCount = preview.rowCount;
    importing.mapping = { ...preview.preview.suggestedMapping };
    if (importing.mapping.amount !== undefined) { delete importing.mapping.debit; delete importing.mapping.credit; }
  } catch (error) { if (view.importing === importing && request === importing.request) view.error = error.message; }
  if (view.importing === importing) paint();
}
function importPanel() {
  const value = view.importing;
  const workspace = select('Import workspace', value.entityId, entities().map(entity => [entity.id, entity.name]), next => { value.entityId = next; value.accountId = ''; paint(); });
  const eligible = view.data.accounts.filter(account => account.entityId === value.entityId);
  const account = select('Import account', value.accountId, [['', 'Choose an account'], ...eligible.map(account => [account.id, `${account.name} · ${account.currency}`])], next => { value.accountId = next; });
  const file = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values', 'aria-label': 'Statement CSV file', disabled: view.busy });
  file.addEventListener('change', () => readStatement(file.files?.[0]));
  const children = [el('h2', { text: 'Import a statement' }), note('Export a CSV from your bank or card website. The file stays in this local workspace; no bank sign-in is required.'),
    el('div', { class: 'finance-form-grid' }, [field('Workspace', workspace), field('Account', account), field('Statement file', file)]),
    !eligible.length && note('Add a local account before importing a statement.'),
  ];
  if (value.preview) {
    const options = [['', 'Not used'], ...value.preview.headers.map((header, index) => [String(index), `${index + 1}. ${header}`])];
    const mapping = ['date', 'description', 'amount', 'debit', 'credit', 'category', 'reference'].map(key => field(`CSV ${key}`, select(`CSV ${key}`, value.mapping[key] === undefined ? '' : String(value.mapping[key]), options, next => {
      if (next === '') delete value.mapping[key]; else value.mapping[key] = Number(next);
      if (next !== '' && key === 'amount') { delete value.mapping.debit; delete value.mapping.credit; }
      if (next !== '' && ['debit', 'credit'].includes(key)) delete value.mapping.amount;
      paint();
    })));
    children.push(note(`${value.filename} · ${value.rowCount} rows. Match the columns, then check the sample before importing.`),
      el('div', { class: 'finance-form-grid' }, mapping),
      el('div', { class: 'finance-form-grid' }, [
        field('Date format', select('CSV date format', value.dateFormat, [['ymd', 'Year / month / day'], ['mdy', 'Month / day / year'], ['dmy', 'Day / month / year']], next => { value.dateFormat = next; })),
        field('Amount direction', select('CSV amount direction', value.amountSign, [['signed', 'Positive = money in; negative = money out'], ['invert', 'Reverse signs · positive card charges']], next => { value.amountSign = next; })),
        field('Decimal separator', select('CSV decimal separator', value.decimalSeparator, [['.', 'Period · 1,234.56'], [',', 'Comma · 1.234,56']], next => { value.decimalSeparator = next; })),
      ]),
      note('For separate debit and credit columns, debits are money out and credits are money in. Use a transaction/reference ID when available for the strongest duplicate matching.'),
      el('div', { class: 'finance-table-scroll' }, el('table', { class: 'finance-table', 'aria-label': 'Statement sample' }, [
        el('thead', {}, el('tr', {}, value.preview.headers.map(header => el('th', { text: header })))),
        el('tbody', {}, value.preview.sampleRows.map(row => el('tr', {}, row.map(cell => el('td', { text: cell }))))),
      ])));
  }
  children.push(el('div', { class: 'finance-actions' }, [
    button(view.busy ? 'Importing…' : 'Import transactions', { class: 'btn', disabled: view.busy || !value.preview, onClick: () => {
      if (!value.accountId) { view.error = 'Choose the account for this statement.'; paint(); return; }
      const { request, preview, rowCount, ...payload } = value;
      act(() => api.importFinanceStatement(payload), result => { view.importing = null; view.entityId = value.entityId; view.tab = 'transactions';
        view.notice = `${result.imported} imported; ${result.duplicates} previously imported rows skipped. Review categories and mark card payments or account movements as transfers.`; });
    } }),
    button('Cancel import', { class: 'btn quiet', disabled: view.busy, onClick: () => { value.request++; view.importing = null; view.error = ''; paint(); } }),
  ]));
  return el('section', { class: 'finance-panel finance-import workspace-form' }, children);
}

function companyOverview(){
 const companies=entities().filter(e=>!view.entityId||e.id===view.entityId);
 return el('section',{class:'money-companies'},[
  el('div',{class:'money-card-head'},[el('div',{},[el('h2',{text:view.entityId?'Company overview':'Your companies'}),note(`Recorded activity · ${view.currency} · ${rangeLabel()}`)]),button('+ Add company',{class:'btn quiet',onClick:()=>openEditor('entity')})]),
  el('div',{class:'money-company-grid'},companies.map(company=>{
   const rows=scopeRows().filter(t=>t.entityId===company.id),spend=rows.filter(t=>t.kind!=='transfer'&&t.status!=='excluded'&&t.amountCents<0).reduce((n,t)=>n-t.amountCents,0);
   const accountCount=(view.data.accounts||[]).filter(a=>a.entityId===company.id).length;
   return button(el('span',{},[el('span',{class:'money-company-name',text:company.name}),el('span',{class:'money-company-total',text:money(spend,view.currency)}),el('span',{class:'money-company-detail',text:`Recorded spending · ${accountCount} account${accountCount===1?'':'s'}`})]),{class:'money-company-card','aria-label':`Open company ${company.name}`,onClick:()=>{view.entityId=company.id;view.accountId='';view.drill=null;load();}});
  }))
 ]);
}
async function syncBank(item) {
  if(view.busy||view.bankPanel)return;
  await act(()=>bankApi.action('sync',{itemId:item.id}),result=>{
    view.notice=`${item.institution} synced. ${result.imported||0} posted entries added; ${result.updated||0} updated. Cached balances and pending activity reloaded.`;
  });
}
function bankSyncActions(snapshot) {
  const items=[...new Map(snapshot.balances.map(value=>[value.item.id,value.item])).values()];
  return el('div',{class:'finance-actions'},items.map(item=>button(`Sync ${item.institution}`,{
    class:'btn quiet',disabled:view.busy||view.loading||!!view.bankPanel,onClick:()=>syncBank(item),
  })));
}
function bankBalancesPanel() {
  const snapshot=bankSnapshot();
  return el('section',{class:'finance-panel money-snapshot','aria-label':'Bank balance snapshot'},[
    el('div',{class:'money-card-head'},[el('div',{},[el('span',{class:'money-eyebrow',text:'Latest saved bank snapshot'}),el('h2',{text:'Your accounts, as reported'})]),
      button(`Pending activity · ${snapshot.pending.length}`,{class:'btn quiet',onClick:()=>{view.tab='pending';paint();}})]),
    note('Balances and pending activity show the latest saved snapshot, independent of the spending dates above. Bank balances are shown separately for each account.'),
    view.bankError&&el('p',{class:'finance-error',role:'status',text:`Bank snapshot could not be reloaded. ${view.bankStatus?'Previously saved information remains below. ':''}${view.bankError}`}),
    snapshot.balances.length?el('div',{class:'money-balance-grid'},snapshot.balances.map(({account,item,remote,currency,balance,currencyWarning})=>{
      const display=balancePresentation(account.type,balance), amount=value=>value===null?'Unavailable':money(value,currency);
      return el('article',{class:'money-balance-card','data-owner':ownerOf(account.entityId),'aria-label':`Balance for ${account.name}`},[
        el('div',{class:'money-balance-heading'},[ownerBadge(account.entityId),el('span',{class:'money-snapshot-badge',text:'Cached'})]),
        el('h3',{text:account.name}),note(`${entityName(account.entityId)} · ${item.institution}${remote.mask?' · •'+remote.mask:''} · ${currency}`),
        el('span',{class:'money-eyebrow',text:display.label}),el('strong',{class:'money-balance-amount',text:amount(display.amountCents)}),
        el('div',{class:'money-balance-detail'},[el('span',{text:display.availableLabel}),el('strong',{text:amount(display.availableCents)})]),
        display.limitCents!==null&&el('div',{class:'money-balance-detail'},[el('span',{text:'Credit limit'}),el('strong',{text:money(display.limitCents,currency)})]),
        el('div',{class:'money-snapshot-times'},[note(`Retrieved by Zelos: ${snapshotTime(balance?.retrievedAt)}`),note(`Updated by bank: ${snapshotTime(balance?.sourceUpdatedAt)}`)]),
        currencyWarning&&note(currencyWarning),item.balanceWarning&&note(item.balanceWarning),
      ]);
    })):note(!view.bankStatus&&view.bankError?'Bank data is unavailable until the snapshot can be reloaded.':view.bankStatus?.items?.length?'No linked accounts match this workspace, account and currency.':'Link a bank to see reported balances. Imported statements alone do not establish an account balance.'),
    snapshot.balances.length>0&&note('Sync retrieves available bank data. It does not guarantee a real-time balance; your bank may update later.'),
    bankSyncActions(snapshot),
  ]);
}
function pendingPanel() {
  const snapshot=bankSnapshot();
  return el('section',{class:'finance-panel money-pending','aria-label':'Pending bank activity'},[
    el('div',{class:'money-card-head'},[el('div',{},[el('span',{class:'money-eyebrow',text:'Latest saved bank snapshot'}),el('h2',{text:`Pending activity · ${snapshot.pending.length}`})]),bankSyncActions(snapshot)]),
    note('These entries have not posted. They may change or disappear and are excluded from spending, income, recurring suggestions and CSV exports. The spending date filter does not apply to this snapshot.'),
    note('Your bank may already reflect some pending activity in its available balance. These entries are not subtracted again.'),
    view.bankError&&el('p',{class:'finance-error',role:'status',text:`Pending activity could not be reloaded. ${view.bankStatus?'Showing the previous snapshot. ':''}${view.bankError}`}),
    snapshot.pending.length?el('div',{class:'finance-table-scroll'},el('table',{class:'finance-table','aria-label':'Pending transactions'},[
      el('thead',{},el('tr',{},['Date','Description','Account / workspace','Amount','Status'].map(label=>el('th',{text:label})))),
      el('tbody',{},snapshot.pending.map(row=>el('tr',{class:'money-owned-transaction','data-owner':ownerOf(row.entityId)},[
        el('td',{text:row.date}),el('td',{text:row.description}),el('td',{},[ownerBadge(row.entityId),el('span',{text:accountName(row.accountId)}),el('small',{text:entityName(row.entityId)})]),
        el('td',{class:'finance-amount',text:money(row.amountCents,row.currency)}),el('td',{},[el('span',{class:'money-snapshot-badge',text:'Pending'}),el('small',{text:`Last bank sync: ${snapshotTime(view.bankStatus?.items?.find(item=>item.id===row.itemId)?.lastSync)}`})]),
      ]))),
    ])):note(!view.bankStatus&&view.bankError?'Pending data is unavailable until the snapshot can be reloaded.':view.bankStatus?.items?.length?'No pending entries in the saved snapshot for this selection.':'Link a bank to see pending activity.'),
  ]);
}
function saveSuggestion(candidate,type,action,excludeId) {
  return act(()=>api.reviewFinance({type,action,key:candidate.key||candidate.id,rowIds:candidate.rows.map(row=>row.id),scope:{start:view.start,end:view.end},...(excludeId?{excludeId}:{})}),()=>{
    view.notice=action==='dismiss'?'Suggestion dismissed. You can undo it below.':action==='confirm-recurring'?'Recurring charges confirmed. Their recorded charges now appear in categorized recurring totals.':'Duplicate entry excluded from totals. The record remains available and this can be undone.';
  });
}
const evidenceSource=row=>{const source=row.importSource||row.source;return source==='plaid'?'bank':source||'unknown';};
const sourceLabel=row=>({bank:'Bank sync',document:'Document import',csv:'Statement import',manual:'Manual entry'}[evidenceSource(row)]||'Unknown source');
const visibleReference=row=>evidenceSource(row)!=='bank'&&!/^Plaid transaction\s/i.test(row.reference||'')?row.reference:'';
function suggestionRows(candidate,type) {
  return el('div',{class:'money-evidence-rows'},candidate.rows.map((row,index)=>el('div',{class:'money-evidence-row','data-owner':ownerOf(row.entityId)},[
    el('div',{},[el('strong',{text:row.description}),note(`${row.date} · ${accountName(row.accountId)} · ${entityName(row.entityId)}`),note(`${sourceLabel(row)} · ${row.category} · ${row.status==='excluded'?'Excluded':row.status==='review'?'Needs review':'Reviewed'}${visibleReference(row)?' · Reference: '+visibleReference(row):''}`)]),
    el('strong',{class:'finance-amount',text:money(row.amountCents,row.currency)}),
    type==='duplicate'&&button('Exclude this entry',{class:'btn quiet',disabled:view.busy||view.loading||!!view.reviewError,'aria-label':`Exclude duplicate entry ${index+1}: ${row.description} on ${row.date}`,onClick:()=>saveSuggestion(candidate,type,'exclude-duplicate',row.id)}),
  ])));
}
function reviewSuggestionsPanel() {
  const rows=scopeRows(),recurring=detectRecurring(rows,{today:localDay()}),duplicates=findDuplicateCandidates(rows,{accounts:view.data.accounts||[]});
  const decisions=scopedReviewDecisions(view.decisions,rows,snapshotScope());
  const resolved=new Set(decisions.map(decision=>decision.key));
  const candidates=[...recurring.map(candidate=>({candidate,type:'recurring'})),...duplicates.map(candidate=>({candidate,type:'duplicate'}))].filter(({candidate})=>!resolved.has(candidate.key||candidate.id));
  const acrossSources=({candidate,type})=>type==='recurring'||candidate.rows.every(row=>evidenceSource(row)!=='unknown')&&new Set(candidate.rows.map(evidenceSource)).size>1;
  const primary=candidates.filter(acrossSources),similar=candidates.filter(candidate=>!acrossSources(candidate));
  const latest=[...decisions].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,10);
  return el('section',{class:'finance-panel money-review','aria-label':'Money review suggestions'},[
    el('div',{class:'money-card-head'},[el('div',{},[el('span',{class:'money-eyebrow',text:'A closer look'}),el('h2',{text:`Review suggestions · ${primary.length}`})]),el('span',{class:'money-snapshot-badge',text:'You decide'})]),
    note(`Suggestions use posted entries in this workspace, account, currency and spending period: ${rangeLabel()}. Select a longer period to find repeating charges.`),
    note('Possible recurring charges are separate from categorized subscription totals until confirmed. Duplicate matches are suggestions: compare the evidence before excluding either entry.'),
    view.reviewError&&el('p',{class:'finance-error',role:'alert',text:`Saved review decisions could not be loaded. Review actions are unavailable until you refresh. ${view.reviewError}`}),
    ...primary.map(suggestionCard),
    !primary.length&&!view.reviewError&&note(similar.length?'No recurring patterns or matches across import sources in this selection. Similar charges from the same source are available below.':'No new suggestions in this selection. As more posted history is imported, recurring patterns and possible duplicates can appear here.'),
    similar.length>0&&el('details',{class:'money-similar-charges'},[
      el('summary',{text:`Show similar charges from the same source (${similar.length})`}),
      note('These entries share a source, amount and similar description. They may be genuine separate purchases, such as daily visits or multiple purchases from one merchant. Open the evidence only when you want to compare them; nothing is excluded automatically.'),
      ...similar.map(suggestionCard),
    ]),
    duplicates.truncated&&note('Showing the first 250 possible duplicate matches. Narrow the account or date filters to review the rest.'),
    latest.length>0&&el('div',{class:'money-recent-decisions'},[
      el('h3',{text:'Recent review decisions'}),note('Undo restores the entries changed by that decision if they have not since been edited.'),
      ...latest.map(decision=>el('div',{class:'money-decision-row'},[
        el('div',{},[el('strong',{text:decision.action==='dismiss'?`${decision.type==='recurring'?'Recurring':'Duplicate'} suggestion dismissed`:decision.action==='confirm-recurring'?'Recurring charges confirmed':'Duplicate entry excluded'}),decision.label&&note(decision.label),note(`${entityName(decision.entityId)} · ${decision.currency} · ${snapshotTime(decision.createdAt)}`)]),
        button('Undo',{class:'btn quiet',disabled:view.busy||view.loading||!!view.reviewError,'aria-label':`Undo review decision for ${decision.label||decision.type} from ${snapshotTime(decision.createdAt)}`,onClick:()=>act(()=>api.reviewFinance({action:'undo',decisionId:decision.id}),()=>{view.notice='Review decision undone.';})}),
      ])),
    ]),
  ]);
}
function suggestionCard({candidate,type}) {
  return el('article',{class:'money-suggestion','data-owner':ownerOf(candidate.entityId)},[
      el('div',{class:'money-card-head'},[el('div',{},[el('span',{class:'money-eyebrow',text:type==='duplicate'?'Possible duplicate':'Possible recurring charge'}),el('h3',{text:type==='duplicate'?merchantName(candidate.rows[0].description):candidate.name})]),ownerBadge(candidate.entityId)]),
      type==='duplicate'&&candidate.ambiguous&&el('span',{class:'money-snapshot-badge',text:'Match needs verification'}),
      note(type==='duplicate'?candidate.reason:candidate.evidence),
      type==='recurring'&&note(`${candidate.cadence[0].toUpperCase()+candidate.cadence.slice(1)} pattern · ${candidate.rows.length} recorded charges${candidate.stale?' · Older pattern; current activity is uncertain':candidate.estimatedNextDate?' · Estimated next: '+candidate.estimatedNextDate:''}. This is an estimate, not a bill or confirmed obligation.`),
      suggestionRows(candidate,type),
      el('div',{class:'finance-actions'},[
        type==='recurring'&&button('Confirm recurring',{class:'btn solid',disabled:view.busy||view.loading||!!view.reviewError,'aria-label':`Confirm recurring ${candidate.name}`,onClick:()=>saveSuggestion(candidate,type,'confirm-recurring')}),
        button('Dismiss suggestion',{class:'btn quiet',disabled:view.busy||view.loading||!!view.reviewError,'aria-label':`Dismiss ${type} suggestion for ${candidate.name||candidate.rows[0].description} on ${candidate.rows.map(row=>row.date).join(', ')}`,onClick:()=>saveSuggestion(candidate,type,'dismiss')}),
      ]),
  ]);
}
function dashboard(a){
 const ownership=view.section==='all'?ownershipAnalysis(a,allEntities()):null;
 const code=view.currency,subscriptionCount=a.subscriptions.filter(s=>s.type==='identified').length;
 const stat=(label,value,description,extra='')=>el('article',{class:`money-stat ${extra}`},[el('span',{class:'money-eyebrow',text:label}),el('strong',{text:value}),note(description)]);
 const hero=el('section',{class:'money-hero'},[
   el('div',{class:'money-hero-main'},[el('span',{class:'money-eyebrow',text:'Total spending'}),el('h2',{text:money(a.total,code)}),el('p',{text:`${a.purchases.length} purchases · ${a.merchants.length} merchants`}),el('span',{class:'money-pill',text:rangeLabel()})]),
   el('div',{class:'money-hero-detail'},[el('div',{class:'money-hero-top'},[el('span',{text:'YOUR MONEY, IN FOCUS'}),el('span',{class:'money-status-dot','aria-hidden':'true'})]),
    el('div',{class:'money-mini-flow'},[el('span',{text:'Credits & money in'}),el('strong',{text:money(a.moneyIn,code)})]),
    el('div',{class:'money-mini-flow'},[el('span',{text:'Net recorded flow'}),el('strong',{text:money(a.net,code)})]),
    note(`${a.transfers.length} transfer${a.transfers.length===1?'':'s'} excluded from spending. These totals are activity, not your card balance.`)])]);
 const stats=el('div',{class:'money-stats'},[
  stat('Average purchase',money(a.average,code),'Across purchases in this period'),
  stat('Recurring charges',money(a.subscriptionTotal,code),`${subscriptionCount} categorized services · actual charges`),
  stat('Needs a look',String(a.review.length),'Transactions awaiting review'),
  stat('Top category',a.categories[0]?`${(a.categories[0].share*100).toFixed(1)}%`:'—',a.categories[0]?.name||'No spending yet')]);
 return el('div',{class:'money-overview'},[bankBalancesPanel(),hero,stats,
 el('p',{class:'money-coverage',text:view.preset==='activity'?'Showing all recorded activity loaded from the past 12 months. Imported statements may cover only part of a month.':'Showing recorded activity in the selected dates. Missing statement periods are not assumed to have zero real-world spending.'}),
 el('div',{class:'money-chart-grid'+(ownership?' money-owner-top-grid':'')},[
  spendingChart(a,{currency:code,mode:view.chartMode,onMode:mode=>{view.chartMode=mode;paint();},onDay:date=>drillTo('date',date),ownerFor:ownership?ownerOf:null}),
  ownership?ownershipSplit(ownership,code,showOwner):spendingMix(a,code,category=>drillTo('category',category))
 ]),
 ownership&&el('div',{class:'money-owner-grid'},[ownershipMonthly(ownership,code,chooseMonth),ownershipFlow(ownership,code)]),
 ownership&&el('div',{class:'money-owner-grid'},[ownershipWorkspaces(ownership,code,showWorkspace),ownedCategories(a,code,category=>drillTo('category',category),ownerOf)]),
 insights(a,code),
 el('div',{class:ownership?'money-owned-merchants':'money-chart-grid money-chart-grid-bottom'},[!ownership&&monthlyChart(a,code,chooseMonth),merchantsChart(a,code,merchant=>drillTo('merchant',merchant),ownership?ownerOf:null)]),
 el('section',{class:'money-recurring-teaser'},[el('div',{},[el('span',{class:'money-eyebrow',text:'Make the recurring visible'}),el('h2',{text:`${money(a.subscriptionTotal,code)} in subscriptions & recurring bills`}),note(`${a.possibleTotal?money(a.possibleTotal,code)+' more in possible subscriptions. ':''}See each service and its recorded charges.`)]),button('Explore subscriptions →',{class:'btn solid',onClick:()=>{view.tab='subscriptions';paint();}})])]);
}
function transactionsPanel() {
  const rows=filteredRows();
  const search = input('Search transactions', view.search, value => { view.search = value; view.limit = 100; paintTransactions(); }, { type: 'search', placeholder: 'Description, category or account' });
  const filter = select('Transaction review filter', view.review, [['all', 'All entries'], ['review', 'Needs review'], ['confirmed', 'Reviewed'], ['excluded', 'Excluded']], value => { view.review = value; view.limit = 100; paint(); });
  const panel = el('section', { class: 'finance-panel finance-transactions' }, [
    el('div', { class: 'finance-section-heading' }, [el('h2', { text: 'Transactions' }), el('div',{class:'workspace-actions'},[button('Import CSV',{class:'btn quiet',disabled:view.busy,onClick:startImport}),button('Add transaction', { class: 'btn solid', onClick: () => openEditor('transaction') })])]),
    el('div', { class: 'finance-table-filters' }, [field('Search', search), field('Review', filter)]),
    view.drill && el('div',{class:'money-filter-pill'},[el('span',{text:`Purchases · ${view.drill.type==='date'?dateLabel(view.drill.value):view.drill.value}`}),button('Clear filter ×',{onClick:()=>{view.drill=null;paint();}})]),
    transactionTable(rows),
  ]);
  return panel;
}
function transactionTable(rows) {
  return el('div', { class: 'finance-transaction-results' }, [note(`${rows.length} entries · ${rangeLabel()}. Transfers and excluded entries are omitted from totals.`),
    rows.length ? el('div', { class: 'finance-table-scroll' }, el('table', { class: 'finance-table', 'aria-label': 'Transactions' }, [
      el('thead', {}, el('tr', {}, ['Date', 'Description', 'Account / workspace', 'Category', 'Amount', 'Review', ''].map(label => el('th', { text: label })))),
      el('tbody', {}, rows.slice(0, view.limit).map(row => el('tr', {'data-owner':ownerOf(row.entityId),class:'money-owned-transaction'}, [
        el('td', { text: row.date }), el('td', {}, [el('strong', { text: merchantName(row.description) }), el('small',{text:row.description}), row.kind === 'transfer' && el('span', { class: 'finance-tag', text: 'Transfer' })]),
        el('td', {}, [ownerBadge(row.entityId),el('span', { text: accountName(row.accountId) }), el('small', { text: entityName(row.entityId) })]),
        el('td', { text: row.category }), el('td', { text: money(row.amountCents, row.currency), class: 'finance-amount' }),
        el('td', { text: row.status === 'review' ? 'Needs review' : row.status === 'excluded' ? 'Excluded' : 'Reviewed' }),
        el('td', {}, button('Edit', { class: 'btn quiet', 'aria-label': `Edit ${row.description}`, onClick: () => openEditor('transaction', row) })),
      ]))),
    ])) : note('No transactions match this view. Import a statement or add an entry.'),
    rows.length > view.limit && button('Show 100 more', { class: 'btn quiet', onClick: () => { view.limit += 100; paintTransactions(); } }),
  ]);
}
function paintTransactions() {
  const old = view.root?.querySelector('.finance-transaction-results'); if (!old) return;
  const rows=filteredRows();
  old.replaceWith(transactionTable(rows));
}
function invoicesPanel() {
  const allowed=new Set(entities().map(e=>e.id));
  const invoices = (view.data.invoices || []).filter(invoice=>allowed.has(invoice.entityId));
  return el('section', { class: 'finance-panel' }, [el('div', { class: 'finance-section-heading' }, [el('h2', { text: 'Invoices · all dates' }), button('Add invoice', { class: 'btn quiet', onClick: () => openEditor('invoice') })]),
    note('Invoice status is separate from transaction cashflow. Paying an invoice does not automatically add a bank entry.'),
    ...(invoices.length ? invoices.map(invoice => el('div', { class: 'finance-invoice-row','data-owner':ownerOf(invoice.entityId) }, [
      el('div', {}, [ownerBadge(invoice.entityId),el('strong', { text: `${invoice.number} · ${invoice.counterparty}` }), el('small', { text: `${entityName(invoice.entityId)} · ${invoice.direction === 'receivable' ? 'Owed to you' : 'You owe'} · Due ${invoice.dueDate}` })]),
      el('strong', { class: 'finance-amount', text: money(invoice.amountCents, invoice.currency) }),
      el('span', { class: 'finance-tag', text: invoice.status === 'paid' ? `Paid ${invoice.paidDate || ''}` : invoice.dueDate < localDay() ? 'Overdue' : 'Unpaid' }),
      el('div', { class: 'finance-actions' }, [button('Edit', { class: 'btn quiet', 'aria-label': `Edit invoice ${invoice.number}`, onClick: () => openEditor('invoice', invoice) }),
        button(invoice.status === 'paid' ? 'Mark unpaid' : 'Mark paid', { class: 'btn quiet', disabled: view.busy, 'aria-label': `${invoice.status === 'paid' ? 'Mark unpaid' : 'Mark paid'} ${invoice.number}`, onClick: () => act(() => api.saveFinanceInvoice({ id: invoice.id, status: invoice.status === 'paid' ? 'unpaid' : 'paid', paidDate: localDay() }), () => { view.notice = 'Invoice status updated.'; }) })]),
    ])) : [note('Add invoices you are waiting to receive or need to pay.')]),
  ]);
}
async function exportCsv() {
  if (view.busy||!view.data) return;
  const blob=new Blob([exportRowsCsv(view.tab==='transactions'?filteredRows():scopeRows())],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),link=el('a',{href:url,download:`zelos-${view.start}-to-${view.end}.csv`});
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  view.notice='Exported the selected date range and account.';paint();
}
function paint() {
  if (!view.root) return;
  view.root.setAttribute('data-money-scope',view.section);
  const workspace = select('Finance workspace filter', view.entityId, [['', view.section==='business'?'All companies':view.section==='personal'?'All personal workspaces':'All companies + personal'], ...entities().map(entity => [entity.id, entity.name])], value => { view.entityId = value; view.limit = 100; load(); });
  const allowedEntities=new Set(entities().map(e=>e.id));
  const availableAccounts=(view.data?.accounts||[]).filter(a=>allowedEntities.has(a.entityId)&&(!view.entityId||a.entityId===view.entityId));
  if(view.accountId&&!availableAccounts.some(a=>a.id===view.accountId))view.accountId='';
  const codes=[...new Set((view.data?.transactions||[]).filter(t=>allowedEntities.has(t.entityId)&&(!view.accountId||t.accountId===view.accountId)).map(t=>t.currency).concat(availableAccounts.filter(a=>!view.accountId||a.id===view.accountId).map(a=>a.currency)))].sort();
  if(codes.length&&!codes.includes(view.currency))view.currency=codes[0];
  const period=select('Spending period',view.preset,[['activity','Imported activity · past year'],['month','This month'],['last-month','Last month'],['90days','Last 90 days'],['custom','Custom dates']],value=>{view.preset=value;view.drill=null;if(value==='custom'){view.draftStart=view.start||localDay();view.draftEnd=view.end||localDay();paint();}else load();});
  const children = [el('div', { class: 'finance-heading money-heading' }, [el('div', {}, [el('span',{class:'money-eyebrow',text:`${sectionLabel().toUpperCase()} / ANALYTICS`}),el('h1', { text: view.section==='business'?'Your companies. In focus.':view.section==='personal'?'Your personal finances.':'Your money. A clearer picture.' }), note('Understand the big purchases, the everyday habits, and what keeps coming back.')]),
    el('div', { class:'workspace-actions' }, [button('Link bank', {class:'btn solid',disabled:view.busy||!!view.editor||!!view.importing,onClick:()=>{if(!view.bankPanel)view.bankPanel=createBankPanel({getData:()=>view.data,onChange:load,onClose:()=>{view.bankPanel=null;paint();}});paint();view.bankPanel.scrollIntoView?.({behavior:'smooth',block:'start'});}}),button('Refresh', { class: 'btn quiet', disabled: view.loading || view.busy, onClick: load }), el('a', { class: 'btn solid', href: '#/documents/statement', text: '+ Import statement' })])]),
    el('div',{class:'money-section-switch'},[
      el('nav',{'aria-label':'Personal and business finances'},[['all','All finances'],['personal','Personal'],['business','Business']].map(([key,label])=>button(label,{'data-owner':key,'aria-pressed':view.section===key?'true':'false',disabled:!!view.editor||!!view.importing,onClick:()=>{view.section=key;view.entityId='';view.accountId='';view.drill=null;view.search='';view.review='all';load();}}))),
      el('span',{text:view.section==='business'?`${entities().length} compan${entities().length===1?'y':'ies'} · separate accounts and records`:view.section==='personal'?'Your own accounts, spending, and subscriptions':'Personal and company finances in one place'})
    ]),
    view.section==='all'&&el('div',{class:'money-ownership-guide','aria-label':'Money color legend'},[el('span',{class:'money-ownership-guide-title',text:'One picture. Two perspectives.'}),el('span',{class:'money-owner-badge','data-owner':'personal',text:'Personal'}),el('span',{class:'money-owner-badge','data-owner':'business',text:'Business'}),el('span',{class:'money-ownership-guide-note',text:'The same colors follow your charts and records.'})]),
    el('div', { class: 'finance-controls money-controls' }, [field('Workspace',workspace),field('Account',select('Money account',view.accountId,[['','All accounts'],...availableAccounts.map(a=>[a.id,a.name])],value=>{view.accountId=value;view.drill=null;paint();})),field('Period',period),codes.length>1&&field('Currency',select('Summary currency',view.currency,codes.map(c=>[c,c]),value=>{view.currency=value;view.drill=null;paint();})),button('Export ↗', { class: 'btn quiet', disabled: view.busy || !view.data, onClick: exportCsv })]),
    view.preset==='custom'&&el('div',{class:'money-date-range'},[field('From',input('Range start',view.draftStart,value=>{view.draftStart=value;},{type:'date'})),field('Through',input('Range end',view.draftEnd,value=>{view.draftEnd=value;},{type:'date'})),button('Apply dates',{class:'btn solid',disabled:view.loading,onClick:()=>{view.drill=null;load();}})]),
    el('nav', { class:'workspace-tabs money-tabs', 'aria-label':'Money sections' }, [['overview','Overview'],['pending','Pending'],['suggestions','Review suggestions'],['subscriptions','Subscriptions'],['transactions','Transactions'],['invoices','Invoices']].map(([key,label]) => button(label,{class:'btn quiet','aria-pressed':view.tab===key?'true':'false',onClick:()=>{view.tab=key;paint();}}))),
    view.error && el('p', { class: 'finance-error', role: 'alert', text: view.error }),
    view.notice && el('p', { class: 'finance-notice', role: 'status', text: view.notice }),
    view.loading && loadingState('Loading your money records…', { layout: view.data ? 'inline' : 'cards' }),
  ];
  if (view.bankPanel) children.push(view.bankPanel);
  if (view.editor) children.push(editorPanel());
  if (view.importing && view.data) children.push(importPanel());
  if (view.data) {
    if (!entities().length) children.push(el('section', { class: 'workspace-empty money-section-empty' }, [el('span',{class:'money-eyebrow',text:sectionLabel()}),el('h2', { text: view.section==='business'?'Give each company its own workspace':view.section==='personal'?'Set up your personal finances':'Add a company or personal workspace' }), note(view.section==='business'?'Keep each company’s accounts, spending, subscriptions, and invoices together. Switch between one company and the business overview.':'Create a company or personal workspace, then add an account to organize your statements and invoices.'),button(view.section==='business'?'Add company':view.section==='personal'?'Add personal workspace':'Add workspace',{class:'btn solid',onClick:()=>openEditor('entity')})]));
    else {
      let analysis;try{analysis=analyzeMoney(scopeRows(),{start:view.start,end:view.end,currency:view.currency});}catch(error){children.push(note(error.message));view.root.replaceChildren(...children.filter(Boolean));return;}
      const active=view.tab==='overview'?dashboard(analysis):view.tab==='pending'?pendingPanel():view.tab==='suggestions'?reviewSuggestionsPanel():view.tab==='subscriptions'?subscriptionPanel(analysis,view.currency,row=>openEditor('transaction',row)):view.tab==='transactions'?transactionsPanel():invoicesPanel();
      children.push(view.section==='business'&&view.tab==='overview'&&companyOverview(),active,
        disclosure('finance-accounts','Workspaces and accounts',[note('Use Link bank for Plaid connections, or add a local account for imported statements.'),
          el('div',{class:'workspace-actions'},[button(view.section==='business'?'Add company':'Add workspace',{class:'btn quiet',disabled:view.busy,onClick:()=>openEditor('entity')}),button('Add account',{class:'btn quiet',disabled:view.busy,onClick:()=>openEditor('account')})]),
          ...entities().filter(entity => !view.entityId || entity.id === view.entityId).map(entity => el('div', { class: 'finance-account-row','data-owner':ownerOf(entity.id) }, [
            el('div', {}, [ownerBadge(entity.id),el('strong', { text: entity.name }), note(`${entity.type === 'company' ? 'Company' : 'Personal'} · Default ${entity.defaultCurrency}`)]), button('Edit workspace', { class: 'btn quiet', onClick: () => openEditor('entity', entity) }),
            ...(view.data.accounts || []).filter(account => account.entityId === entity.id).map(account => button(`${account.name} · ${account.currency}`, { class: 'btn quiet', onClick: () => openEditor('account', account) })),
          ])),
        ]));
    }
  }
  view.root.replaceChildren(...children.filter(Boolean));
}

export function renderFinance() {
  if (!view.root) { view.root = el('div', { class: 'view view-finance money-workspace' }); load(); }
  else if (!view.root.isConnected && !view.loading && !view.busy) load();
  return view.root;
}
