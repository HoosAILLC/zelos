/** Local statements, reviewed transactions, and company/personal money views. */
import { el, button, focusQuietly } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { disclosure } from '../lib/workspace.js';

const view = { root: null, data: null, entityId: '', month: localDay().slice(0, 7), loading: false,
  request: 0, busy: false, error: '', notice: '', editor: null, importing: null, search: '', review: 'all', limit: 100, tab: 'overview', currency: 'USD' };
function localDay() { const day = new Date(); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; }
const note = message => el('p', { class: 'finance-note', text: message });
const field = (label, control) => el('label', { class: 'finance-field' }, [el('span', { text: label }), control]);
const entities = () => view.data?.entities || [];
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
  try { const data = await api.finance({ entityId: view.entityId, month: view.month }); if (request === view.request) view.data = data; }
  catch (error) { if (request === view.request) view.error = error.message; }
  finally { if (request === view.request) { view.loading = false; paint(); } }
}
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
  if (type === 'entity') values = { name: '', type: 'company', defaultCurrency: 'USD', ...record };
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
      if (type === 'entity') view.entityId = (result.entity || result).id;
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

function metrics(bucket) {
  return el('section', { class: 'finance-currency', 'aria-label': `${bucket.currency} money overview` }, [
    el('h2', { text: bucket.currency }),
    el('div', { class: 'finance-metrics' }, [['Money in', bucket.incomeCents], ['Money out', bucket.expenseCents], ['Net flow', bucket.netCents]].map(([label, value]) =>
      el('div', { class: 'finance-metric' }, [el('span', { text: label }), el('strong', { text: money(value, bucket.currency), class: value < 0 ? 'is-negative' : '' })]))),
    bucket.reviewCount > 0 && button(`${bucket.reviewCount} transactions need review`,{class:'btn quiet finance-review-link',onClick:()=>{view.review='review';view.tab='transactions';paint();}}),
    el('div', { class: 'finance-charts' }, [trendChart(bucket), categoryChart(bucket)]),
    el('h3', { text: 'Open invoices · all dates' }),
    el('div', { class: 'finance-invoice-metrics' }, [['Owed to you', bucket.receivableCents], ['You owe', bucket.payableCents], ['Overdue to you', bucket.overdueCents], ['Overdue to suppliers', bucket.overduePayableCents]].map(([label, value]) =>
      el('div', {}, [el('span', { text: label }), el('strong', { text: money(value, bucket.currency) })]))),
  ]);
}
function trendChart(bucket) {
  const months = bucket.months || [], max = Math.max(1, ...months.flatMap(month => [month.incomeCents, month.expenseCents]));
  return el('section', { class: 'finance-chart-panel' }, [el('h3', { text: 'Monthly flow' }), note('Money in and money out · last 12 months'),
    el('div', { class: 'finance-trend', role: 'img', 'aria-label': months.map(month => `${month.month}: ${money(month.incomeCents, bucket.currency)} in, ${money(month.expenseCents, bucket.currency)} out, net ${money(month.netCents, bucket.currency)}`).join('; ') },
      months.map(month => el('div', { class: 'finance-trend-month', title: `${month.month}: net ${money(month.netCents, bucket.currency)}` }, [
        el('div', { class: 'finance-trend-pair', 'aria-hidden': 'true' }, [el('span', { class: 'finance-bar-in', style: { height: `${Math.max(0, month.incomeCents / max * 100)}%` } }), el('span', { class: 'finance-bar-out', style: { height: `${Math.max(0, month.expenseCents / max * 100)}%` } })]),
        el('span', { text: month.month.slice(5), class: 'finance-month-label' }),
      ]))),
  ]);
}
function categoryChart(bucket) {
  const categories = (bucket.categories || []).filter(category => category.expenseCents > 0).slice(0, 8), max = Math.max(1, ...categories.map(category => category.expenseCents));
  return el('section', { class: 'finance-chart-panel' }, [el('h3', { text: 'Spending by category' }),
    ...(categories.length ? categories.map(category => el('div', { class: 'finance-category' }, [
      el('div', {}, [el('span', { text: category.category }), el('strong', { text: money(category.expenseCents, bucket.currency) })]),
      el('div', { class: 'finance-category-track', 'aria-hidden': 'true' }, el('span', { style: { width: `${category.expenseCents / max * 100}%` } })),
    ])) : [note('Categorized spending will appear here.')]),
  ]);
}
function transactionsPanel() {
  const query = view.search.toLowerCase();
  const rows = (view.data.transactions || []).filter(row => (view.review === 'all' || row.status === view.review) && `${row.description} ${row.category} ${accountName(row.accountId)}`.toLowerCase().includes(query));
  const search = input('Search transactions', view.search, value => { view.search = value; view.limit = 100; paintTransactions(); }, { type: 'search', placeholder: 'Description, category or account' });
  const filter = select('Transaction review filter', view.review, [['all', 'All entries'], ['review', 'Needs review'], ['confirmed', 'Reviewed'], ['excluded', 'Excluded']], value => { view.review = value; view.limit = 100; paint(); });
  const panel = el('section', { class: 'finance-panel finance-transactions' }, [
    el('div', { class: 'finance-section-heading' }, [el('h2', { text: 'Transactions' }), el('div',{class:'workspace-actions'},[button('Import CSV',{class:'btn quiet',disabled:view.busy,onClick:startImport}),button('Add transaction', { class: 'btn solid', onClick: () => openEditor('transaction') })])]),
    el('div', { class: 'finance-table-filters' }, [field('Search', search), field('Review', filter)]),
    transactionTable(rows),
  ]);
  return panel;
}
function transactionTable(rows) {
  return el('div', { class: 'finance-transaction-results' }, [note(`${rows.length} entries for ${view.month}. Transfers and excluded entries are omitted from totals.`),
    rows.length ? el('div', { class: 'finance-table-scroll' }, el('table', { class: 'finance-table', 'aria-label': 'Transactions' }, [
      el('thead', {}, el('tr', {}, ['Date', 'Description', 'Account / workspace', 'Category', 'Amount', 'Review', ''].map(label => el('th', { text: label })))),
      el('tbody', {}, rows.slice(0, view.limit).map(row => el('tr', {}, [
        el('td', { text: row.date }), el('td', {}, [el('strong', { text: row.description }), row.kind === 'transfer' && el('span', { class: 'finance-tag', text: 'Transfer' })]),
        el('td', {}, [el('span', { text: accountName(row.accountId) }), el('small', { text: entityName(row.entityId) })]),
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
  const query = view.search.toLowerCase();
  const rows = view.data.transactions.filter(row => (view.review === 'all' || row.status === view.review) && `${row.description} ${row.category} ${accountName(row.accountId)}`.toLowerCase().includes(query));
  old.replaceWith(transactionTable(rows));
}
function invoicesPanel() {
  const invoices = view.data.invoices || [];
  return el('section', { class: 'finance-panel' }, [el('div', { class: 'finance-section-heading' }, [el('h2', { text: 'Invoices · all dates' }), button('Add invoice', { class: 'btn quiet', onClick: () => openEditor('invoice') })]),
    note('Invoice status is separate from transaction cashflow. Paying an invoice does not automatically add a bank entry.'),
    ...(invoices.length ? invoices.map(invoice => el('div', { class: 'finance-invoice-row' }, [
      el('div', {}, [el('strong', { text: `${invoice.number} · ${invoice.counterparty}` }), el('small', { text: `${entityName(invoice.entityId)} · ${invoice.direction === 'receivable' ? 'Owed to you' : 'You owe'} · Due ${invoice.dueDate}` })]),
      el('strong', { class: 'finance-amount', text: money(invoice.amountCents, invoice.currency) }),
      el('span', { class: 'finance-tag', text: invoice.status === 'paid' ? `Paid ${invoice.paidDate || ''}` : invoice.dueDate < localDay() ? 'Overdue' : 'Unpaid' }),
      el('div', { class: 'finance-actions' }, [button('Edit', { class: 'btn quiet', 'aria-label': `Edit invoice ${invoice.number}`, onClick: () => openEditor('invoice', invoice) }),
        button(invoice.status === 'paid' ? 'Mark unpaid' : 'Mark paid', { class: 'btn quiet', disabled: view.busy, 'aria-label': `${invoice.status === 'paid' ? 'Mark unpaid' : 'Mark paid'} ${invoice.number}`, onClick: () => act(() => api.saveFinanceInvoice({ id: invoice.id, status: invoice.status === 'paid' ? 'unpaid' : 'paid', paidDate: localDay() }), () => { view.notice = 'Invoice status updated.'; }) })]),
    ])) : [note('Add invoices you are waiting to receive or need to pay.')]),
  ]);
}
async function exportCsv() {
  if (view.busy) return;
  view.busy = true; view.error = ''; paint();
  try {
    const response = await api.exportFinanceCsv({ entityId: view.entityId, month: view.month });
    const blob = response.blob || response;
    if (!(blob instanceof Blob)) throw new Error('The CSV export could not be downloaded.');
    const url = URL.createObjectURL(blob), link = el('a', { href: url, download: response.filename || `zelos-transactions-${view.month}.csv` });
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    view.notice = 'CSV exported for the selected workspace and month.';
  } catch (error) { view.error = error.message; }
  finally { view.busy = false; paint(); }
}
function paint() {
  if (!view.root) return;
  const workspace = select('Finance workspace filter', view.entityId, [['', 'All companies + personal'], ...entities().map(entity => [entity.id, entity.name])], value => { view.entityId = value; view.limit = 100; load(); });
  const month = input('Finance month', view.month, value => { if (/^\d{4}-\d{2}$/.test(value)) { view.month = value; view.limit = 100; load(); } }, { type: 'month' });
  const children = [el('div', { class: 'finance-heading' }, [el('div', {}, [el('h1', { text: 'Money' }), note('Your companies and personal finances, together.')]),
    el('div', { class:'workspace-actions' }, [button('Refresh', { class: 'btn quiet', disabled: view.loading || view.busy, onClick: load }), el('a', { class: 'btn solid', href: '#/documents/statement', text: 'Import statement' })])]),
    el('div', { class: 'finance-controls' }, [field('Workspace', workspace), field('Month', month), button('Export month CSV', { class: 'btn quiet', disabled: view.busy || !view.data, onClick: exportCsv })]),
    el('nav', { class:'workspace-tabs', 'aria-label':'Money sections' }, [['overview','Overview'],['transactions','Transactions'],['invoices','Invoices']].map(([key,label]) => button(label,{class:'btn quiet','aria-pressed':view.tab===key?'true':'false',onClick:()=>{view.tab=key;paint();}}))),
    view.error && el('p', { class: 'finance-error', role: 'alert', text: view.error }),
    view.notice && el('p', { class: 'finance-notice', role: 'status', text: view.notice }),
    view.loading && note('Loading your money records…'),
  ];
  if (view.editor) children.push(editorPanel());
  if (view.importing && view.data) children.push(importPanel());
  if (view.data) {
    const currencies=view.data.summary?.currencies || [];
    if(!currencies.some(bucket=>bucket.currency===view.currency))view.currency=currencies[0]?.currency || 'USD';
    if (!entities().length) children.push(el('section', { class: 'workspace-empty' }, [el('h2', { text: 'Add a company or personal workspace' }), note('Create a company or personal workspace, then add an account to organize your statements and invoices.'),button('Add workspace',{class:'btn solid',onClick:()=>openEditor('entity')})]));
    else {
      const overview=el('div',{class:'finance-overview',hidden:view.tab!=='overview'},[
        el('div',{class:'workspace-section-head'},[el('h2',{text:'Cash flow'}), currencies.length>1 ? field('Currency',select('Summary currency',view.currency,currencies.map(bucket=>[bucket.currency,bucket.currency]),value=>{view.currency=value;paint();})) : note(view.currency)]),
        ...currencies.map(bucket=>el('div',{hidden:bucket.currency!==view.currency},metrics(bucket))),
        !currencies.length ? note('Import a statement or add a transaction to see your cash flow.') : null,
        note('Each currency has its own totals. These reflect recorded transactions, not bank balances.'),
      ]);
      const transactions=transactionsPanel();transactions.hidden=view.tab!=='transactions';
      const invoices=invoicesPanel();invoices.hidden=view.tab!=='invoices';
      children.push(overview,transactions,invoices,
        disclosure('finance-accounts','Workspaces and accounts',[note('Direct bank sign-ins are not connected. Add an account to organize imported statements.'),
          el('div',{class:'workspace-actions'},[button('Add workspace',{class:'btn quiet',disabled:view.busy,onClick:()=>openEditor('entity')}),button('Add account',{class:'btn quiet',disabled:view.busy,onClick:()=>openEditor('account')})]),
          ...entities().filter(entity => !view.entityId || entity.id === view.entityId).map(entity => el('div', { class: 'finance-account-row' }, [
            el('div', {}, [el('strong', { text: entity.name }), note(`${entity.type === 'company' ? 'Company' : 'Personal'} · Default ${entity.defaultCurrency}`)]), button('Edit workspace', { class: 'btn quiet', onClick: () => openEditor('entity', entity) }),
            ...(view.data.accounts || []).filter(account => account.entityId === entity.id).map(account => button(`${account.name} · ${account.currency}`, { class: 'btn quiet', onClick: () => openEditor('account', account) })),
          ])),
        ]));
    }
  }
  view.root.replaceChildren(...children.filter(Boolean));
}

export function renderFinance() {
  if (!view.root) { view.root = el('div', { class: 'view view-finance' }); load(); }
  else if (!view.root.isConnected && !view.loading && !view.busy) load();
  return view.root;
}
