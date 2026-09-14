import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {detectRecurring, findDuplicateCandidates, normalizeMoneyDescription, stablePatternKey} from '../ui/lib/money-patterns.js';

const base = {entityId: 'personal', accountId: 'card', currency: 'USD', description: 'Example service', amountCents: -1299,
  category: 'Entertainment', kind: 'expense', status: 'review', source: 'manual', importSource: 'bank', reference: '', updatedAt: '2026-09-10T00:00:00Z'};
const row = (id, date, extra = {}) => ({...base, id, date, ...extra});
const monthly = (extra = {}) => ['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => row('r' + i, date, extra));
const today = '2026-09-10';
const recurring = rows => detectRecurring(rows, {today});
const pair = (extraA = {}, extraB = {}) => [row('a', '2026-08-10', {source: 'csv', importSource: 'csv', ...extraA}), row('b', '2026-08-11', extraB)];
const account = (id, name, extra = {}) => ({id, name, type: 'credit_card', entityId: 'personal', currency: 'USD', ...extra});
const amex = [account('statement', 'American Express Gold • 91009'), account('linked', 'American Express® Gold Card • 1009')];

test('stable evidence SHA-256 matches native hashes for ASCII, Unicode and multiblock input', () => {
  for (const input of ['', 'abc', '💳 café', 'x'.repeat(1000), ['a', 1, null]]) {
    assert.equal(stablePatternKey(input), createHash('sha256').update(JSON.stringify(input)).digest('hex'));
  }
  assert.equal(stablePatternKey({b: 2, a: 1}), stablePatternKey({a: 1, b: 2}));
});

test('monthly evidence reports recorded amount and a labeled estimate without mutating records', () => {
  const rows = monthly(), before = structuredClone(rows);
  const [candidate] = recurring(rows);
  assert.equal(candidate.cadence, 'monthly');
  assert.equal(candidate.latestAmountCents, 1299);
  assert.equal(candidate.lastDate, '2026-08-15');
  assert.equal(candidate.estimatedNextDate, '2026-09-15');
  assert.equal(candidate.stale, false);
  assert.equal(candidate.suggestion, true);
  assert.deepEqual(candidate.rowIds, ['r0', 'r1', 'r2']);
  assert.equal(candidate.key, candidate.id);
  assert.match(candidate.evidence, /3 similar charges/);
  assert.equal('monthlyTotalCents' in candidate, false);
  assert.deepEqual(rows, before);
});

test('candidate keys are input-order independent and invalidate each relevant evidence change', () => {
  const rows = monthly(), key = recurring(rows)[0].key;
  assert.equal(recurring([...rows].reverse())[0].key, key);
  for (const change of [
    {status: 'confirmed'}, {category: 'Media'}, {date: '2026-06-16'}, {amountCents: -1300},
    {description: 'APLPAY Example service'}, {updatedAt: '2026-09-11T00:00:00Z'}, {reference: 'changed'}, {importSource: 'csv'}
  ]) {
    const changed = rows.map((value, i) => i === 0 ? {...value, ...change} : value);
    assert.notEqual(recurring(changed)[0]?.key, key, JSON.stringify(change));
  }
});

test('account, workspace and currency never combine into one recurring series', () => {
  for (const field of ['accountId', 'entityId', 'currency']) {
    const rows = monthly(); rows[2] = {...rows[2], [field]: field === 'currency' ? 'EUR' : 'other'};
    assert.equal(recurring(rows).length, 0, field);
  }
  const twoAccounts = [...monthly(), ...monthly({accountId: 'other'}).map(r => ({...r, id: r.id + '-other'}))];
  assert.equal(recurring(twoAccounts).length, 2);
  assert.equal(recurring(monthly({accountId: null})).length, 0);
});

test('recurring requires three posted expenses and does not reuse categorized or uncertain evidence', () => {
  assert.equal(recurring(monthly().slice(0, 2)).length, 0);
  for (const change of [{kind: 'transfer'}, {status: 'excluded'}, {status: 'pending'}, {pending: true}, {kind: 'income', amountCents: 1299},
    {date: '2026-09-30'}, {date: '2026-02-30'}, {amountCents: NaN}, {amountCents: 0}, {id: ''}]) {
    const rows = monthly(); rows[2] = {...rows[2], ...change};
    assert.equal(recurring(rows).length, 0, JSON.stringify(change));
  }
  for (const category of ['Subscriptions', 'Recurring bill', 'Possible subscriptions — confirm']) {
    const rows = monthly(); rows[1].category = category;
    assert.equal(recurring(rows).length, 0, category);
  }
});

test('repeated IDs, same-day charges, adjacent duplicate copies and missing months suppress a series', () => {
  const rows = monthly();
  assert.equal(recurring([...rows, {...rows[0]}]).length, 0);
  assert.equal(recurring([...rows, {...rows[0], id: 'another'}]).length, 0);
  assert.equal(recurring([...rows, {...rows[0], id: 'another', date: '2026-06-16'}]).length, 0);
  assert.equal(recurring([row('a', '2026-03-15'), row('b', '2026-05-15'), row('c', '2026-06-15')]).length, 0);
});

test('calendar recurrence handles leap-day and month-end clamping without rollover drift', () => {
  const rows = ['2024-01-31','2024-02-29','2024-03-31'].map((date, i) => row(String(i), date));
  assert.equal(detectRecurring(rows, {today: '2024-04-01'})[0].estimatedNextDate, '2024-04-30');
  const ordinary = ['2026-01-31','2026-02-28','2026-03-31'].map((date, i) => row(String(i), date));
  assert.equal(detectRecurring(ordinary, {today: '2026-04-01'})[0].estimatedNextDate, '2026-04-30');
});

test('weekly, quarterly and annual patterns need repeated regular intervals', () => {
  for (const [cadence, dates, date, next] of [
    ['weekly', ['2026-08-24','2026-08-31','2026-09-07'], today, '2026-09-14'],
    ['quarterly', ['2026-01-15','2026-04-16','2026-07-15'], today, '2026-10-15'],
    ['annual', ['2024-12-01','2025-12-02','2026-12-01'], '2026-12-02', '2027-12-01']
  ]) {
    const [candidate] = detectRecurring(dates.map((d, i) => row(String(i), d)), {today: date});
    assert.equal(candidate.cadence, cadence);
    assert.equal(candidate.estimatedNextDate, next);
  }
  assert.equal(recurring(['2026-07-01','2026-08-15','2026-09-02'].map((date, i) => row(String(i), date))).length, 0);
});

test('stale series can be reviewed but never receive an invented future renewal', () => {
  const [candidate] = detectRecurring(monthly(), {today: '2026-11-01'});
  assert.equal(candidate.stale, true);
  assert.equal('estimatedNextDate' in candidate, false);
  assert.throws(() => detectRecurring(monthly(), {today: '2026-02-30'}), /valid date/);
});

test('amount variation is bounded and tiny charges do not receive a large absolute tolerance', () => {
  const close = monthly(); close[1].amountCents = -1330;
  assert.equal(recurring(close).length, 1);
  close[1].amountCents = -1499;
  assert.equal(recurring(close).length, 0);
  const tiny = monthly({amountCents: -1}); tiny[1].amountCents = -2;
  assert.equal(recurring(tiny).length, 0);
});

test('known biller references normalize but Uber trips and store branches remain separate', () => {
  const spotify = monthly().map((r, i) => ({...r, description: `SPOTIFY P${i}ABCD` }));
  assert.equal(recurring(spotify)[0].name, 'Spotify');
  const trips = monthly({description: 'Uber One'}); trips[2].description = 'Uber Trip';
  assert.equal(recurring(trips).length, 0);
  const stores = monthly({description: 'STARBUCKS #123'}); stores[2].description = 'STARBUCKS #124';
  assert.equal(recurring(stores).length, 0);
});

test('same-account duplicate suggestions preserve signed values and original records', () => {
  const rows = pair(), before = structuredClone(rows), [candidate] = findDuplicateCandidates(rows);
  assert.deepEqual(candidate.rowIds, ['a','b']);
  assert.equal(candidate.entityId, 'personal');
  assert.equal(candidate.accountId, 'card');
  assert.equal(candidate.currency, 'USD');
  assert.equal(candidate.ambiguous, false);
  assert.equal(candidate.suggestion, true);
  assert.match(candidate.reason, /different import sources/);
  assert.deepEqual(rows, before);
  assert.equal(findDuplicateCandidates([...rows].reverse())[0].key, candidate.key);
  assert.notEqual(findDuplicateCandidates([rows[0], {...rows[1], updatedAt: '2026-09-12'}])[0].key, candidate.key);
  assert.equal(findDuplicateCandidates(pair({amountCents: 1299, kind: 'income'}, {amountCents: 1299, kind: 'income'})).length, 1);
});

test('duplicates do not cross account, entity, currency, amount sign or the two-day window', () => {
  for (const change of [{accountId: 'another'}, {entityId: 'business'}, {currency: 'EUR'}, {amountCents: 1299},
    {amountCents: -1300}, {date: '2026-08-13'}, {description: 'Another service'}, {kind: 'transfer'}, {status: 'excluded'},
    {pending: true}, {status: 'pending'}, {accountId: null}, {date: '2026-02-30'}, {amountCents: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.equal(findDuplicateCandidates(pair({}, change)).length, 0, JSON.stringify(change));
  }
  assert.equal(findDuplicateCandidates(pair({}, {date: '2026-08-12'})).length, 1);
});

test('duplicate merchant normalization strips payment wrappers while retaining different store digits', () => {
  assert.equal(normalizeMoneyDescription('AplPay TST* CAFE #123  INDIANAPOLIS IN'), 'CAFE 123');
  assert.equal(findDuplicateCandidates(pair({description: 'AplPay CAFE #123  CITY'}, {description: 'Cafe #123'})).length, 1);
  assert.equal(findDuplicateCandidates(pair({description: 'CAFE #123'}, {description: 'Cafe #124'})).length, 0);
  assert.equal(findDuplicateCandidates(pair({description: 'Spotify P111'}, {description: 'Spotify P222'})).length, 0);
});

test('separate statement and bank account suggestions require matching Amex product and masked last four', () => {
  const rows = pair({accountId: 'statement', source: 'manual', importSource: 'document'}, {accountId: 'linked'});
  const [candidate] = findDuplicateCandidates(rows, {accounts: amex});
  assert.ok(candidate);
  assert.equal(candidate.accountId, null);
  assert.equal(candidate.ambiguous, true);
  assert.match(candidate.reason, /Verify these account records represent the same card/);
  assert.equal(findDuplicateCandidates(rows, {accounts: amex.map(a => a.id === 'linked' ? {...a, name: 'American Express Platinum Card • 1009'} : a)}).length, 0);
  assert.equal(findDuplicateCandidates(rows, {accounts: amex.map(a => a.id === 'linked' ? {...a, name: 'American Express Gold Card • 2009'} : a)}).length, 0);
  assert.equal(findDuplicateCandidates(rows, {accounts: amex.map(a => ({...a, name: 'Chase Gold • 1009'}))}).length, 0);
  assert.equal(findDuplicateCandidates(rows, {accounts: amex.map(a => ({...a, type: 'bank'}))}).length, 0);
  assert.equal(findDuplicateCandidates(rows, {accounts: amex.map(a => ({...a, currency: 'EUR'}))}).length, 0);
  assert.equal(findDuplicateCandidates(rows, {accounts: amex.map(a => ({...a, entityId: 'other'}))}).length, 0);
});

test('unproven manual records and explicit source metadata cannot masquerade as statement or bank provenance', () => {
  const rows = pair({accountId: 'statement', source: 'manual', importSource: 'manual'}, {accountId: 'linked'});
  assert.equal(findDuplicateCandidates(rows, {accounts: amex}).length, 0);
  rows[0].importSource = 'document'; rows[1].importSource = 'manual'; rows[1].reference = 'Plaid transaction forged';
  assert.equal(findDuplicateCandidates(rows, {accounts: amex}).length, 0);
  assert.equal(findDuplicateCandidates(pair({importSource: 'bank'}, {}))[0].ambiguous, true);
});

test('overlapping duplicate matches remain separate and explicitly ambiguous', () => {
  const rows = [...pair(), row('c', '2026-08-12')];
  const candidates = findDuplicateCandidates(rows);
  assert.equal(candidates.length, 3);
  assert.equal(new Set(candidates.map(c => c.key)).size, 3);
  assert.ok(candidates.every(c => c.ambiguous && /more than one possible match/.test(c.reason)));
  assert.equal(findDuplicateCandidates([...pair(), {...pair()[0]}]).length, 0);
});

test('candidate scans bound dense matches and disclose incomplete results', () => {
  const rows = Array.from({length: 100}, (_, i) => row(String(i).padStart(3, '0'), '2026-08-10'));
  const candidates = findDuplicateCandidates(rows);
  assert.equal(candidates.length, 250);
  assert.equal(candidates.truncated, true);
  assert.ok(candidates.every(c => c.ambiguous));
  const unrelatedAccounts = Array.from({length: 400}, (_, i) => row(String(i), '2026-08-10', {accountId: 'account-' + i}));
  const unmatched = findDuplicateCandidates(unrelatedAccounts);
  assert.equal(unmatched.length, 0);
  assert.equal(unmatched.truncated, true);
});

test('duplicate decision identity changes with account compatibility evidence', () => {
  const rows = pair({accountId: 'statement', importSource: 'csv'}, {accountId: 'linked'});
  const first = findDuplicateCandidates(rows, {accounts: amex})[0].key;
  const renamed = amex.map(a => a.id === 'linked' ? {...a, name: 'Amex Gold • 1009'} : a);
  assert.notEqual(findDuplicateCandidates(rows, {accounts: renamed})[0].key, first);
});
