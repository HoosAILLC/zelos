import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateFinance, addEntity, saveAccount, saveTransaction, saveInvoice, importStatement,
  getFinance, exportFinanceCsv, parseStatementCsv, parseFinanceAmount, financeDate } from '../core/finance.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateFinance(db); t.after(() => db.close());
  const company = addEntity(db, { name: 'Studio One', type: 'company', defaultCurrency: 'USD' });
  const personal = addEntity(db, { name: 'Personal', type: 'personal', defaultCurrency: 'USD' });
  const bank = saveAccount(db, { entityId: company.id, name: 'Checking', type: 'bank', currency: 'USD' });
  const card = saveAccount(db, { entityId: personal.id, name: 'Personal card', type: 'credit_card', currency: 'USD' });
  const transaction = patch => saveTransaction(db, { entityId: company.id, accountId: bank.id, date: '2026-09-11', description: 'Office purchase', amountCents: -1200, currency: 'USD', category: 'Office', ...patch });
  const invoice = patch => saveInvoice(db, { entityId: company.id, direction: 'receivable', number: 'INV-01', counterparty: 'Client', issueDate: '2026-09-01', dueDate: '2026-09-10', amountCents: 15000, currency: 'USD', ...patch });
  const report = patch => getFinance(db, { month: '2026-09', today: '2026-09-11', ...patch });
  const statement = patch => importStatement(db, { entityId: company.id, accountId: bank.id,
    csv: 'Date,Description,Amount\n2026-09-10,Office supplies,-12.34\n2026-09-11,Client payment,250.10\n',
    mapping: { date: 0, description: 1, amount: 2 }, dateFormat: 'ymd', ...patch });
  return { db, company, personal, bank, card, transaction, invoice, report, statement };
}

test('finance migration is idempotent and works inside the root schema transaction', () => {
  const db = new DatabaseSync(':memory:');
  try { db.exec('BEGIN'); migrateFinance(db); migrateFinance(db); db.exec('COMMIT'); assert.equal(db.prepare('SELECT COUNT(*) n FROM finance_entities').get().n, 0); }
  finally { db.close(); }
});

test('decimal parsing preserves cents, negatives and refunds without float rounding', () => {
  for (const [raw, expected] of [['0.10', 10], ['0.29', 29], ['12.3', 1230], ['$1,234.56', 123456], ['($12.34)', -1234], ['12.34-', -1234], ['-0.01', -1], ['+12.34', 1234]]) assert.equal(parseFinanceAmount(raw), expected, raw);
  assert.equal(parseFinanceAmount('1.234,56', ','), 123456);
  for (const raw of ['1.234', '1,23.45', '1e5', 'Infinity', '', '=SUM(1,2)', '999999999999999.99']) assert.throws(() => parseFinanceAmount(raw));
});

test('dates use explicit date formats and reject rollover dates', () => {
  assert.equal(financeDate('09/11/2026', 'mdy'), '2026-09-11');
  assert.equal(financeDate('11/09/2026', 'dmy'), '2026-09-11');
  assert.equal(financeDate('2026-09-11T23:30:00-04:00'), '2026-09-11');
  assert.equal(financeDate('9/11/26', 'mdy'), '2026-09-11');
  for (const raw of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', 'tomorrow']) assert.throws(() => financeDate(raw));
});

test('CSV parser handles BOM, quoted delimiters, newlines and doubled quotes', () => {
  const parsed = parseStatementCsv('\uFEFFDate,Description,Amount\r\n2026-09-11,"A, B\nsaid ""hello""",-12.00\r\n');
  assert.deepEqual(parsed.headers, ['Date', 'Description', 'Amount']);
  assert.deepEqual(parsed.rows, [['2026-09-11', 'A, B\nsaid "hello"', '-12.00']]);
  assert.equal(parseStatementCsv('Date;Description;Amount\n11/09/2026;Coffee;2,40').delimiter, ';');
  assert.throws(() => parseStatementCsv('Date,Amount\n2026-09-11,"12'));
  assert.throws(() => parseStatementCsv('Date,Amount\n2026-09-11,12,extra'));
});

test('CSV preview is read-only and suggests actual mapped columns', t => {
  const f = fixture(t);
  const preview = f.statement({ preview: true });
  assert.deepEqual(preview.preview.suggestedMapping, { date: 0, description: 1, amount: 2 });
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.preview.sampleRows[0][2], '-12.34');
  assert.equal(f.report().transactions.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_imports').get().n, 0);
});

test('bank CSV import is real, atomic, categorized for review and deduplicated on reimport', t => {
  const f = fixture(t);
  const first = f.statement();
  assert.equal(first.imported, 2); assert.equal(first.duplicates, 0);
  const second = f.statement();
  assert.equal(second.imported, 0); assert.equal(second.duplicates, 2);
  const report = f.report();
  assert.equal(report.transactions.length, 2);
  assert.ok(report.transactions.every(transaction => transaction.source === 'csv' && transaction.status === 'review'));
  assert.equal(report.summary.currencies[0].incomeCents, 25010);
  assert.equal(report.summary.currencies[0].expenseCents, 1234);
  assert.equal(report.summary.currencies[0].netCents, 23776);
});

test('identical legitimate rows are retained while a repeat import retains the same multiplicity', t => {
  const f = fixture(t);
  const csv = 'Date,Description,Amount\n2026-09-10,Coffee,-2.00\n2026-09-10,Coffee,-2.00';
  assert.equal(f.statement({ csv }).imported, 2);
  assert.equal(f.statement({ csv }).duplicates, 2);
  assert.equal(f.report().summary.currencies[0].expenseCents, 400);
});

test('bank reference mapping identifies duplicated rows and overlapping exports', t => {
  const f = fixture(t);
  const mapping = { date: 0, description: 1, amount: 2, reference: 3 };
  const csv = 'Date,Description,Amount,ID\n2026-09-10,Coffee,-2.00,bank-1\n2026-09-10,Coffee,-2.00,bank-1';
  assert.equal(f.statement({ csv, mapping }).imported, 1);
  assert.equal(f.statement({ csv: 'Date,Description,Amount,ID\n2026-09-10,Coffee,-2.00,bank-1\n2026-09-11,Coffee,-2.00,bank-2', mapping }).imported, 1);
  assert.equal(f.report().transactions.length, 2);
});

test('debit and credit columns and reversed credit-card signs retain negative charges and positive refunds', t => {
  const f = fixture(t);
  f.statement({ csv: 'Date,Description,Debit,Credit\n2026-09-10,Purchase,100.10,\n2026-09-11,Refund,,20.29', mapping: { date: 0, description: 1, debit: 2, credit: 3 } });
  assert.equal(f.report().summary.currencies[0].netCents, -7981);
  f.statement({ entityId: f.personal.id, accountId: f.card.id,
    csv: 'Date,Description,Amount\n2026-09-10,Purchase,100.10\n2026-09-11,Refund,-20.29', amountSign: 'invert' });
  const personal = f.report({ entityId: f.personal.id });
  assert.equal(personal.summary.currencies[0].netCents, -7981);
  assert.equal(personal.transactions.find(transaction => transaction.description === 'Refund').amountCents, 2029);
});

test('invalid CSV rows roll back the entire import and return row details', t => {
  const f = fixture(t);
  assert.throws(() => f.statement({ csv: 'Date,Description,Amount\n2026-09-10,Valid,-12.34\n2026-02-30,Invalid,30.00' }), error => error.status === 400 && error.detail.errors[0].row === 3);
  assert.equal(f.report().transactions.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM finance_imports').get().n, 0);
});

test('CSV mapping rejects collisions, ambiguous amount modes and cross-company account use', t => {
  const f = fixture(t);
  for (const mapping of [{ date: 0, description: 0, amount: 2 }, { date: 0, description: 1, amount: 2, debit: 2 }, { date: 20, description: 1, amount: 2 }, { date: 0, description: 1 }]) assert.throws(() => f.statement({ mapping }));
  assert.throws(() => f.statement({ accountId: f.card.id }));
  assert.equal(f.report().transactions.length, 0);
});

test('CSV dedupe is isolated by account and company', t => {
  const f = fixture(t);
  assert.equal(f.statement().imported, 2);
  assert.equal(f.statement({ entityId: f.personal.id, accountId: f.card.id }).imported, 2);
  assert.equal(f.report().transactions.length, 4);
  assert.equal(f.report({ entityId: f.company.id }).transactions.length, 2);
});

test('editing imported transactions preserves dedupe metadata and review decisions', t => {
  const f = fixture(t); f.statement();
  const transaction = f.report().transactions[0];
  saveTransaction(f.db, { id: transaction.id, description: 'Reviewed description', category: 'Client receipts', amountCents: 20000, status: 'confirmed' });
  assert.equal(f.statement().duplicates, 2);
  const edited = f.report().transactions.find(value => value.id === transaction.id);
  assert.equal(edited.amountCents, 20000); assert.equal(edited.description, 'Reviewed description');
  assert.equal(edited.status, 'confirmed'); assert.equal(edited.source, 'csv');
});

test('manual amounts require safe integer cents and accounts must match entity and currency', t => {
  const f = fixture(t);
  for (const amountCents of [0.29, NaN, Infinity, 1_000_000_000_001]) assert.throws(() => f.transaction({ amountCents }));
  assert.throws(() => f.transaction({ accountId: f.card.id }));
  assert.throws(() => f.transaction({ currency: 'EUR' }));
  assert.throws(() => f.transaction({ entityId: 'missing' }));
  assert.throws(() => f.transaction({ amountCents: 1200, kind: 'expense' }));
  assert.equal(f.report().transactions.length, 0);
});

test('monthly reports separate every currency and company without inventing an exchange rate', t => {
  const f = fixture(t);
  f.transaction({ amountCents: 10000, category: 'Sales' }); f.transaction({ amountCents: -2500 });
  f.transaction({ accountId: null, currency: 'EUR', amountCents: 7000, category: 'Sales' });
  f.transaction({ entityId: f.personal.id, accountId: f.card.id, amountCents: -9900, category: 'Personal' });
  const combined = f.report().summary.currencies;
  assert.deepEqual(combined.map(value => [value.currency, value.netCents]), [['EUR', 7000], ['USD', -2400]]);
  assert.equal(f.report({ entityId: f.company.id }).summary.currencies.find(value => value.currency === 'USD').netCents, 7500);
  assert.equal(Object.hasOwn(f.report().summary, 'netCents'), false);
});

test('transfers and excluded entries do not inflate cashflow or category totals', t => {
  const f = fixture(t);
  f.transaction(); f.transaction({ amountCents: -50000, kind: 'transfer', category: 'Card payment' });
  f.transaction({ amountCents: -10000, status: 'excluded' });
  const summary = f.report().summary.currencies[0];
  assert.equal(summary.expenseCents, 1200);
  assert.equal(summary.categories.length, 1);
  assert.equal(summary.categories[0].expenseCents, 1200);
  assert.equal(f.report().transactions.length, 3);
});

test('month filtering and twelve-month trend use stored dates without timezone drift', t => {
  const f = fixture(t);
  f.transaction({ date: '2026-08-31', amountCents: 1000 });
  f.transaction({ date: '2026-09-01', amountCents: 2000 });
  f.transaction({ date: '2026-10-01', amountCents: 3000 });
  const report = f.report();
  assert.equal(report.transactions.length, 1); assert.equal(report.summary.currencies[0].incomeCents, 2000);
  const months = report.summary.currencies[0].months;
  assert.equal(months.length, 12); assert.equal(months[0].month, '2025-10'); assert.equal(months.at(-1).month, '2026-09');
  assert.equal(months.find(value => value.month === '2026-08').incomeCents, 1000);
  assert.throws(() => f.report({ month: '2026-13' }));
});

test('receivable, payable, overdue and paid invoices are distinct and do not fabricate cash transactions', t => {
  const f = fixture(t);
  const incoming = f.invoice(); f.invoice({ direction: 'payable', number: 'BILL-2', amountCents: 5000 });
  f.invoice({ number: 'INV-03', amountCents: 2500, dueDate: '2026-09-11' });
  const before = f.report().summary.currencies[0];
  assert.equal(before.receivableCents, 17500); assert.equal(before.payableCents, 5000);
  assert.equal(before.overdueCents, 15000); assert.equal(before.overduePayableCents, 5000);
  saveInvoice(f.db, { id: incoming.id, status: 'paid', paidDate: '2026-09-11' });
  assert.equal(f.report().summary.currencies[0].receivableCents, 2500);
  assert.equal(f.report().summary.currencies[0].overdueCents, 0);
  assert.equal(f.report().transactions.length, 0);
  saveInvoice(f.db, { id: incoming.id, status: 'unpaid' });
  assert.equal(f.report().invoices.find(invoice => invoice.id === incoming.id).paidDate, null);
});

test('invoices reject negative amounts, missing counterparties and impossible date order', t => {
  const f = fixture(t);
  for (const patch of [{ amountCents: -1 }, { amountCents: 0 }, { counterparty: '' }, { dueDate: '2026-08-01' }, { status: 'paid', paidDate: '2026-08-01' }]) assert.throws(() => f.invoice(patch));
});

test('accounts with transactions cannot silently change currency or company', t => {
  const f = fixture(t); f.transaction();
  assert.throws(() => saveAccount(f.db, { id: f.bank.id, name: f.bank.name, currency: 'EUR' }), error => error.status === 409);
  assert.throws(() => saveAccount(f.db, { id: f.bank.id, name: f.bank.name, entityId: f.personal.id }), error => error.status === 409);
  assert.equal(saveAccount(f.db, { id: f.bank.id, name: 'Renamed checking' }).name, 'Renamed checking');
});

test('CSV export obeys filters, preserves cents, quotes text and neutralizes spreadsheet formulas', t => {
  const f = fixture(t);
  f.transaction({ description: '=HYPERLINK("https://example.invalid","open")', category: '@SUM(1,2)', amountCents: -1234 });
  f.transaction({ date: '2026-08-01', description: 'Previous month' });
  const csv = exportFinanceCsv(f.db, { month: '2026-09', entityId: f.company.id });
  assert.match(csv, /-12\.34/); assert.match(csv, /'=HYPERLINK/); assert.match(csv, /'@SUM/);
  assert.doesNotMatch(csv, /Previous month/);
  assert.equal(parseStatementCsv(csv).rows.length, 1);
});

test('no bank or PDF capability is claimed and no credentials are stored in finance tables', t => {
  const f = fixture(t);
  assert.deepEqual(f.report().capabilities, { csv: true, manual: true, bankConnection: false, pdfImport: false });
  for (const table of ['finance_entities', 'finance_accounts', 'finance_transactions', 'finance_invoices']) {
    assert.ok(f.db.prepare(`PRAGMA table_info(${table})`).all().every(column => !/password|secret|token|credential/i.test(column.name)));
  }
});
