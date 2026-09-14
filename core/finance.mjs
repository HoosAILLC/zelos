/** Local bookkeeping: integer minor units, explicit currencies, no bank network. */
import crypto from 'node:crypto';

export class FinanceError extends Error {
  constructor(status, message, detail = undefined) { super(message); this.name = 'FinanceError'; this.status = status; this.detail = detail; }
}
const fail = (message, status = 400, detail) => { throw new FinanceError(status, message, detail); };
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const stamp = () => new Date().toISOString();
const text = (value, name, max = 200, required = true) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || required && !value.trim()) fail(`${name} is missing or invalid.`);
  return value.trim();
};
const choice = (value, options, name) => { if (!options.includes(value)) fail(`Choose a valid ${name}.`); return value; };
const currency = value => { if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) fail('Currency must be a three-letter code such as USD.'); return value; };
const cents = (value, positive = false) => {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000_000 || positive && value <= 0) fail('Amount must be a valid whole number of cents.');
  return value;
};
const requireRow = (db, table, value, name) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(text(value, name, 100));
  if (!row) fail(`${name} was not found.`, 404); return row;
};
function atomic(db, operation) {
  db.exec('SAVEPOINT finance_write');
  try { const result = operation(); db.exec('RELEASE finance_write'); return result; }
  catch (error) { db.exec('ROLLBACK TO finance_write; RELEASE finance_write'); throw error; }
}

/** Safe inside the enclosing database migration transaction. */
export function migrateFinance(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('company','personal')),
      default_currency TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS finance_entity_name ON finance_entities(lower(name),type);
    CREATE TABLE IF NOT EXISTS finance_accounts (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES finance_entities(id), name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('bank','credit_card','cash','other')), currency TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finance_imports (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES finance_entities(id), account_id TEXT NOT NULL REFERENCES finance_accounts(id),
      filename TEXT NOT NULL DEFAULT '', imported INTEGER NOT NULL, duplicates INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finance_transactions (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES finance_entities(id), account_id TEXT REFERENCES finance_accounts(id),
      date TEXT NOT NULL, description TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
      category TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer')),
      status TEXT NOT NULL CHECK(status IN ('review','confirmed','excluded')), source TEXT NOT NULL CHECK(source IN ('manual','csv')),
      import_id TEXT REFERENCES finance_imports(id), source_key TEXT UNIQUE, reference TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS finance_transactions_date ON finance_transactions(entity_id,date);
    CREATE INDEX IF NOT EXISTS finance_transactions_account ON finance_transactions(account_id,date);
    CREATE TABLE IF NOT EXISTS finance_invoices (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES finance_entities(id), direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
      number TEXT NOT NULL, counterparty TEXT NOT NULL, description TEXT NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('unpaid','paid')), paid_date TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS finance_invoices_due ON finance_invoices(entity_id,status,due_date);
  `);
}

const entityView = row => ({ id: row.id, name: row.name, type: row.type, defaultCurrency: row.default_currency });
const accountView = row => ({ id: row.id, entityId: row.entity_id, name: row.name, type: row.type, currency: row.currency });
const transactionView = row => ({ id: row.id, entityId: row.entity_id, accountId: row.account_id, date: row.date,
  description: row.description, amountCents: row.amount_cents, currency: row.currency, category: row.category,
  kind: row.kind, status: row.status, source: row.source, reference: row.reference, createdAt: row.created_at, updatedAt: row.updated_at });

/** Provenance comes from saved import receipts, never a model's description. */
export function financeTransactionRows(db, entityId = '') {
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  const banks = exists('finance_plaid_transactions') ? new Set(db.prepare('SELECT local_id FROM finance_plaid_transactions').all().map(r => r.local_id)) : new Set();
  const documents = exists('document_records') ? new Set(db.prepare("SELECT record_id FROM document_records WHERE record_kind='transaction'").all().map(r => r.record_id)) : new Set();
  return db.prepare('SELECT * FROM finance_transactions WHERE (? = ? OR entity_id=?) ORDER BY date DESC,created_at DESC').all(entityId, '', entityId)
    .map(row => ({ ...transactionView(row), importSource: banks.has(row.id) ? 'bank' : documents.has(row.id) ? 'document' : row.source }));
}
const invoiceView = row => ({ id: row.id, entityId: row.entity_id, direction: row.direction, number: row.number,
  counterparty: row.counterparty, description: row.description, issueDate: row.issue_date, dueDate: row.due_date,
  amountCents: row.amount_cents, currency: row.currency, status: row.status, paidDate: row.paid_date });

export function addEntity(db, data) {
  const previous = data.id ? requireRow(db, 'finance_entities', data.id, 'Company or personal workspace') : null;
  const values = { id: previous?.id || id('entity'), name: text(data.name, 'Name', 120),
    type: choice(data.type || previous?.type || 'company', ['company', 'personal'], 'workspace type'),
    currency: currency(data.defaultCurrency || previous?.default_currency || 'USD'), now: stamp() };
  try {
    db.prepare(`INSERT INTO finance_entities(id,name,type,default_currency,created_at,updated_at) VALUES(:id,:name,:type,:currency,:now,:now)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,default_currency=excluded.default_currency,updated_at=excluded.updated_at`).run(values);
  } catch (error) { if (/UNIQUE/.test(error.message)) fail('A workspace with this name already exists.', 409); throw error; }
  return entityView(requireRow(db, 'finance_entities', values.id, 'Workspace'));
}

export function saveAccount(db, data) {
  const previous = data.id ? requireRow(db, 'finance_accounts', data.id, 'Account') : null;
  const entity = requireRow(db, 'finance_entities', data.entityId || previous?.entity_id, 'Workspace');
  const code = currency(data.currency || previous?.currency || entity.default_currency);
  if (previous && (previous.entity_id !== entity.id || previous.currency !== code)
    && db.prepare('SELECT id FROM finance_transactions WHERE account_id=? LIMIT 1').get(previous.id)) fail('An account with transactions cannot change workspace or currency. Create another account instead.', 409);
  const values = { id: previous?.id || id('account'), entity: entity.id, name: text(data.name, 'Account name', 120),
    type: choice(data.type || previous?.type || 'bank', ['bank', 'credit_card', 'cash', 'other'], 'account type'), code, now: stamp() };
  db.prepare(`INSERT INTO finance_accounts(id,entity_id,name,type,currency,created_at,updated_at) VALUES(:id,:entity,:name,:type,:code,:now,:now)
    ON CONFLICT(id) DO UPDATE SET entity_id=excluded.entity_id,name=excluded.name,type=excluded.type,currency=excluded.currency,updated_at=excluded.updated_at`).run(values);
  return accountView(requireRow(db, 'finance_accounts', values.id, 'Account'));
}

export function financeDate(value, format = 'ymd') {
  const raw = text(String(value ?? ''), 'Date', 40);
  let year, month, day;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(raw);
  if (iso) [, year, month, day] = iso.map(Number);
  else {
    choice(format, ['ymd', 'mdy', 'dmy'], 'date format');
    const parts = raw.split(/[./-]/);
    if (parts.length !== 3 || parts.some(part => !/^\d{1,4}$/.test(part))) fail(`Date “${raw}” does not match the selected format.`);
    if (format === 'ymd') [year, month, day] = parts.map(Number);
    else if (format === 'mdy') [month, day, year] = parts.map(Number);
    else [day, month, year] = parts.map(Number);
    if (year < 100) year += year < 80 ? 2000 : 1900;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2200 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) fail(`Date “${raw}” is not a calendar date.`);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Decimal strings become integer cents without binary floating-point rounding. */
export function parseFinanceAmount(value, decimalSeparator = '.') {
  let raw = text(String(value ?? ''), 'Amount', 80);
  let negative = false;
  if (/^\(.*\)$/.test(raw)) { negative = true; raw = raw.slice(1, -1); }
  raw = raw.replace(/[$€£¥\s\u00a0]/g, '');
  if (raw.endsWith('-')) { negative = true; raw = raw.slice(0, -1); }
  if (raw.startsWith('-')) { negative = !negative; raw = raw.slice(1); }
  else if (raw.startsWith('+')) raw = raw.slice(1);
  choice(decimalSeparator, ['.', ','], 'decimal separator');
  const group = decimalSeparator === '.' ? ',' : '.';
  if (raw.includes(group)) {
    const integer = raw.split(decimalSeparator)[0];
    const grouping = group === ',' ? /^\d{1,3}(?:,\d{3})+$/ : /^\d{1,3}(?:\.\d{3})+$/;
    if (!grouping.test(integer)) fail('The amount has invalid thousands separators.');
    raw = raw.split(group).join('');
  }
  if (decimalSeparator === ',') raw = raw.replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) fail('Amounts must have at most two decimal places.');
  const [whole, fraction = ''] = raw.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents(negative ? -result : result);
}

function checkedTransaction(db, data, previous) {
  const entity = requireRow(db, 'finance_entities', data.entityId || previous?.entity_id, 'Workspace');
  const accountId = data.accountId === undefined ? previous?.account_id : data.accountId;
  const account = accountId ? requireRow(db, 'finance_accounts', accountId, 'Account') : null;
  const code = currency(data.currency || previous?.currency || account?.currency || entity.default_currency);
  if (account && (account.entity_id !== entity.id || account.currency !== code)) fail('Choose an account in this workspace with the same currency.');
  const amount = cents(data.amountCents ?? previous?.amount_cents);
  const kind = choice(data.kind || (previous?.kind === 'transfer' ? 'transfer' : amount < 0 ? 'expense' : 'income'), ['income', 'expense', 'transfer'], 'transaction kind');
  if (kind !== 'transfer' && (kind === 'expense' && amount > 0 || kind === 'income' && amount < 0)) fail('Expense amounts must be negative and income amounts positive.');
  return { entity: entity.id, account: account?.id || null, date: financeDate(data.date || previous?.date),
    description: text(data.description ?? previous?.description, 'Description', 500), amount, code,
    category: text(data.category ?? previous?.category ?? 'Uncategorized', 'Category', 80), kind,
    status: choice(data.status || previous?.status || 'confirmed', ['review', 'confirmed', 'excluded'], 'review status') };
}

export function saveTransaction(db, data) {
  const previous = data.id ? requireRow(db, 'finance_transactions', data.id, 'Transaction') : null;
  const values = { id: previous?.id || id('transaction'), ...checkedTransaction(db, data, previous), now: stamp() };
  db.prepare(`INSERT INTO finance_transactions(id,entity_id,account_id,date,description,amount_cents,currency,category,kind,status,source,created_at,updated_at)
    VALUES(:id,:entity,:account,:date,:description,:amount,:code,:category,:kind,:status,'manual',:now,:now)
    ON CONFLICT(id) DO UPDATE SET entity_id=excluded.entity_id,account_id=excluded.account_id,date=excluded.date,description=excluded.description,
      amount_cents=excluded.amount_cents,currency=excluded.currency,category=excluded.category,kind=excluded.kind,status=excluded.status,updated_at=excluded.updated_at`).run(values);
  return transactionView(requireRow(db, 'finance_transactions', values.id, 'Transaction'));
}

export function saveInvoice(db, data) {
  const old = data.id ? requireRow(db, 'finance_invoices', data.id, 'Invoice') : null;
  const entity = requireRow(db, 'finance_entities', data.entityId || old?.entity_id, 'Workspace');
  const issued = financeDate(data.issueDate || old?.issue_date || new Date().toISOString().slice(0, 10));
  const due = financeDate(data.dueDate || old?.due_date);
  if (due < issued) fail('The due date cannot be before the issue date.');
  const status = choice(data.status || old?.status || 'unpaid', ['unpaid', 'paid'], 'invoice status');
  const paid = status === 'paid' ? financeDate(data.paidDate || old?.paid_date || new Date().toISOString().slice(0, 10)) : null;
  if (paid && paid < issued) fail('The paid date cannot be before the issue date.');
  const values = { id: old?.id || id('invoice'), entity: entity.id,
    direction: choice(data.direction || old?.direction || 'receivable', ['receivable', 'payable'], 'invoice direction'),
    number: text(data.number ?? old?.number, 'Invoice number', 80), counterparty: text(data.counterparty ?? old?.counterparty, 'Client or supplier', 160),
    description: text(data.description ?? old?.description ?? '', 'Description', 1000, false), issued, due,
    amount: cents(data.amountCents ?? old?.amount_cents, true), code: currency(data.currency || old?.currency || entity.default_currency), status, paid, now: stamp() };
  db.prepare(`INSERT INTO finance_invoices(id,entity_id,direction,number,counterparty,description,issue_date,due_date,amount_cents,currency,status,paid_date,created_at,updated_at)
    VALUES(:id,:entity,:direction,:number,:counterparty,:description,:issued,:due,:amount,:code,:status,:paid,:now,:now)
    ON CONFLICT(id) DO UPDATE SET entity_id=excluded.entity_id,direction=excluded.direction,number=excluded.number,counterparty=excluded.counterparty,
    description=excluded.description,issue_date=excluded.issue_date,due_date=excluded.due_date,amount_cents=excluded.amount_cents,currency=excluded.currency,
    status=excluded.status,paid_date=excluded.paid_date,updated_at=excluded.updated_at`).run(values);
  return invoiceView(requireRow(db, 'finance_invoices', values.id, 'Invoice'));
}

/** Quoted commas, CRLF, embedded newlines and escaped quotes are real CSV. */
export function parseStatementCsv(csv, delimiter = null) {
  if (typeof csv !== 'string' || !csv.trim() || Buffer.byteLength(csv, 'utf8') > 2_000_000 || csv.includes('\0')) fail('Choose a UTF-8 CSV file smaller than 2 MB.');
  csv = csv.replace(/^\uFEFF/, '');
  if (!delimiter) {
    const first = csv.split(/\r?\n/)[0];
    const counts = [',', ';', '\t'].map(char => [char, [...first.matchAll(/"(?:[^"]|"")*"|[^"\r\n]+/g)].reduce((n, match) => n + (match[0].startsWith('"') ? 0 : match[0].split(char).length - 1), 0)]);
    delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  if (![',', ';', '\t'].includes(delimiter)) fail('Use comma, semicolon or tab-separated CSV.');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const endRow = () => { row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = ''; closed = false; if (rows.length > 10_001) fail('Import at most 10,000 transactions at a time.'); };
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"') {
      if (cell || closed) fail('A quote appears inside an unquoted CSV value.'); quoted = true;
    } else if (char === delimiter) { row.push(cell); cell = ''; closed = false; }
    else if (char === '\r' || char === '\n') { if (char === '\r' && csv[i + 1] === '\n') i++; endRow(); }
    else { if (closed && !/\s/.test(char)) fail('There is text after a closing CSV quote.'); if (!closed) cell += char; }
  }
  if (quoted) fail('The CSV file contains an unfinished quoted value.');
  if (cell || row.length || closed) endRow();
  if (rows.length < 2) fail('The CSV needs a header row and at least one transaction.');
  const headers = rows.shift().map(value => text(value.trim(), 'Column heading', 160));
  if (headers.length < 2 || headers.length > 80) fail('The CSV must have between 2 and 80 columns.');
  if (rows.some(values => values.length !== headers.length)) fail('Some CSV rows have a different number of columns from the header.');
  return { headers, rows, delimiter };
}

function mappingFor(headers, mapping) {
  const result = {};
  for (const key of ['date', 'description', 'amount', 'debit', 'credit', 'category', 'reference']) {
    const value = mapping?.[key];
    if (value === undefined || value === null || value === '') continue;
    const column = typeof value === 'number' ? value : headers.filter(header => header === value).length === 1 ? headers.indexOf(value) : -1;
    if (!Number.isInteger(column) || column < 0 || column >= headers.length) fail(`Choose the ${key} column from this CSV.`);
    result[key] = column;
  }
  if (result.date === undefined || result.description === undefined) fail('Map the date and description columns.');
  if (result.amount === undefined && result.debit === undefined && result.credit === undefined) fail('Map an amount column or debit and credit columns.');
  if (result.amount !== undefined && (result.debit !== undefined || result.credit !== undefined)) fail('Use either one signed amount column or separate debit and credit columns.');
  if (new Set(Object.values(result)).size !== Object.values(result).length) fail('Each mapped field needs its own column.');
  return result;
}

function suggest(headers) {
  const definitions = { date: /^(transaction |posting |posted |post )?date$/i, description: /^(description|memo|details|payee|merchant|transaction description)$/i,
    amount: /^(amount|transaction amount)$/i, debit: /^(debit|debits|withdrawal|withdrawals|charge|charges)$/i,
    credit: /^(credit|credits|deposit|deposits)$/i, category: /^category$/i, reference: /^(reference|transaction id|id|check number)$/i };
  return Object.fromEntries(Object.entries(definitions).map(([key, pattern]) => [key, headers.findIndex(value => pattern.test(value))]).filter(([, index]) => index >= 0));
}

export function importStatement(db, data) {
  const parsed = parseStatementCsv(data.csv, data.delimiter);
  if (data.preview === true) return { preview: { headers: parsed.headers, sampleRows: parsed.rows.slice(0, 6), suggestedMapping: suggest(parsed.headers), delimiter: parsed.delimiter }, rowCount: parsed.rows.length };
  const entity = requireRow(db, 'finance_entities', data.entityId, 'Workspace');
  const account = requireRow(db, 'finance_accounts', data.accountId, 'Account');
  if (account.entity_id !== entity.id) fail('Choose an account in the selected workspace.');
  const mapping = mappingFor(parsed.headers, data.mapping);
  const format = choice(data.dateFormat || 'ymd', ['ymd', 'mdy', 'dmy'], 'date format');
  const sign = choice(data.amountSign || 'signed', ['signed', 'invert'], 'amount direction');
  const decimal = choice(data.decimalSeparator || '.', ['.', ','], 'decimal separator');
  const occurrence = new Map(), errors = [];
  const prepared = parsed.rows.map((values, index) => {
    try {
      const day = financeDate(values[mapping.date], format);
      const description = text(values[mapping.description], 'Description', 500);
      let amount;
      if (mapping.amount !== undefined) amount = parseFinanceAmount(values[mapping.amount], decimal) * (sign === 'invert' ? -1 : 1);
      else {
        const debit = mapping.debit === undefined || !values[mapping.debit].trim() ? 0 : parseFinanceAmount(values[mapping.debit], decimal);
        const credit = mapping.credit === undefined || !values[mapping.credit].trim() ? 0 : parseFinanceAmount(values[mapping.credit], decimal);
        if (debit < 0 || credit < 0 || debit && credit) fail('Separate debit and credit cells must be positive, with only one filled per row.');
        amount = credit - debit;
      }
      cents(amount);
      const category = mapping.category === undefined || !values[mapping.category].trim() ? 'Uncategorized' : text(values[mapping.category], 'Category', 80);
      const reference = mapping.reference === undefined ? '' : text(values[mapping.reference], 'Reference', 200, false);
      const basis = JSON.stringify([account.id, day, description.replace(/\s+/g, ' ').toLowerCase(), amount, account.currency]);
      const ordinal = (occurrence.get(basis) || 0) + 1; occurrence.set(basis, ordinal);
      const sourceKey = crypto.createHash('sha256').update(reference ? JSON.stringify([account.id, 'reference', reference]) : `${basis}:${ordinal}`).digest('hex');
      return { day, description, amount, category, reference, sourceKey };
    } catch (error) { errors.push({ row: index + 2, message: error.message }); return null; }
  });
  if (errors.length) fail(`Nothing was imported. Fix ${errors.length} invalid row${errors.length === 1 ? '' : 's'} and try again. First: row ${errors[0].row}, ${errors[0].message}`, 400, { errors: errors.slice(0, 50) });
  return atomic(db, () => {
    const importId = id('import'), timestamp = stamp();
    const filename = text(data.filename || '', 'Filename', 200, false);
    db.prepare('INSERT INTO finance_imports(id,entity_id,account_id,filename,imported,duplicates,created_at) VALUES(?,?,?,?,0,0,?)').run(importId, entity.id, account.id, filename, timestamp);
    let imported = 0, duplicates = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO finance_transactions(id,entity_id,account_id,date,description,amount_cents,currency,category,kind,status,source,import_id,source_key,reference,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'review','csv',?,?,?,?,?)`);
    for (const transaction of prepared) {
      const result = insert.run(id('transaction'), entity.id, account.id, transaction.day, transaction.description, transaction.amount, account.currency,
        transaction.category, transaction.amount < 0 ? 'expense' : 'income', importId, transaction.sourceKey, transaction.reference, timestamp, timestamp);
      if (result.changes) imported++; else duplicates++;
    }
    db.prepare('UPDATE finance_imports SET imported=?,duplicates=? WHERE id=?').run(imported, duplicates, importId);
    return { importId, imported, duplicates, errors: [], rowCount: prepared.length,
      note: 'Imported transactions need review. Card payments and transfers should be marked Transfer to avoid counting them as spending. Matching imports are skipped; identical rows within one file are retained unless a reference column identifies them as duplicates.' };
  });
}

const sum = (a, b) => { const result = a + b; if (!Number.isSafeInteger(result)) fail('The total is too large to represent safely.'); return result; };
function monthKeys(month) {
  const [year, number] = month.split('-').map(Number);
  return Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(year, number - 12 + index, 1)).toISOString().slice(0, 7));
}

export function getFinance(db, { entityId = '', month = new Date().toISOString().slice(0, 7), today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Choose a month in YYYY-MM format.');
  today = financeDate(today);
  if (entityId) requireRow(db, 'finance_entities', entityId, 'Workspace');
  const entities = db.prepare('SELECT * FROM finance_entities ORDER BY type,name').all().map(entityView);
  const accounts = db.prepare('SELECT * FROM finance_accounts ORDER BY name').all().map(accountView);
  const transactions = financeTransactionRows(db, entityId);
  const invoices = db.prepare('SELECT * FROM finance_invoices WHERE (? = ? OR entity_id=?) ORDER BY due_date,status').all(entityId, '', entityId).map(invoiceView);
  const monthTransactions = transactions.filter(transaction => transaction.date.startsWith(month));
  const keys = monthKeys(month), groups = new Map();
  const group = code => {
    if (!groups.has(code)) groups.set(code, { currency: code, incomeCents: 0, expenseCents: 0, netCents: 0,
      receivableCents: 0, payableCents: 0, overdueCents: 0, overduePayableCents: 0, reviewCount: 0, categories: new Map(),
      months: keys.map(key => ({ month: key, incomeCents: 0, expenseCents: 0, netCents: 0 })) });
    return groups.get(code);
  };
  for (const transaction of transactions) {
    const relevant = transaction.date.startsWith(month), bucket = group(transaction.currency);
    if (transaction.status === 'review' && relevant) bucket.reviewCount++;
    if (transaction.status === 'excluded' || transaction.kind === 'transfer') continue;
    const income = transaction.amountCents > 0 ? transaction.amountCents : 0, expense = transaction.amountCents < 0 ? -transaction.amountCents : 0;
    const trend = bucket.months.find(value => transaction.date.startsWith(value.month));
    if (trend) { trend.incomeCents = sum(trend.incomeCents, income); trend.expenseCents = sum(trend.expenseCents, expense); trend.netCents = trend.incomeCents - trend.expenseCents; }
    if (!relevant) continue;
    bucket.incomeCents = sum(bucket.incomeCents, income); bucket.expenseCents = sum(bucket.expenseCents, expense); bucket.netCents = bucket.incomeCents - bucket.expenseCents;
    const category = bucket.categories.get(transaction.category) || { category: transaction.category, incomeCents: 0, expenseCents: 0, netCents: 0 };
    category.incomeCents = sum(category.incomeCents, income); category.expenseCents = sum(category.expenseCents, expense); category.netCents = category.incomeCents - category.expenseCents;
    bucket.categories.set(transaction.category, category);
  }
  for (const invoice of invoices) {
    const bucket = group(invoice.currency);
    if (invoice.status === 'paid') continue;
    const field = invoice.direction === 'receivable' ? 'receivableCents' : 'payableCents';
    bucket[field] = sum(bucket[field], invoice.amountCents);
    if (invoice.dueDate < today) { const overdue = invoice.direction === 'receivable' ? 'overdueCents' : 'overduePayableCents'; bucket[overdue] = sum(bucket[overdue], invoice.amountCents); }
  }
  return { entities, accounts, transactions: monthTransactions, invoices,
    summary: { month, entityId, currencies: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(value => ({ ...value, categories: [...value.categories.values()].sort((a, b) => b.expenseCents - a.expenseCents) })) },
    limits: { csvBytes: 2_000_000, csvRows: 10_000 },
    capabilities: { csv: true, manual: true, bankConnection: false, pdfImport: false },
  };
}

function csvCell(value) {
  let string = String(value ?? '');
  // Spreadsheet programs interpret formula prefixes even inside quoted CSV.
  if (/^[\s]*[=+@-]/.test(string)) string = `'${string}`;
  return `"${string.replaceAll('"', '""')}"`;
}
export function exportFinanceCsv(db, filters = {}) {
  const result = getFinance(db, filters);
  const names = new Map(result.entities.map(entity => [entity.id, entity.name]));
  const accounts = new Map(result.accounts.map(account => [account.id, account.name]));
  const columns = ['Date', 'Workspace', 'Account', 'Description', 'Amount', 'Currency', 'Category', 'Kind', 'Status', 'Source', 'Reference'];
  const lines = [columns.map(csvCell).join(',')];
  for (const transaction of result.transactions) {
    const values = [transaction.date, names.get(transaction.entityId), accounts.get(transaction.accountId) || '', transaction.description,
      (transaction.amountCents / 100).toFixed(2), transaction.currency, transaction.category, transaction.kind, transaction.status, transaction.source, transaction.reference];
    lines.push(values.map((value, index) => index === 4 ? String(value) : csvCell(value)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
