/** Fictional account snapshots and review receipts. Nothing leaves module memory. */
import {detectRecurring, findDuplicateCandidates} from './money-patterns.js';

const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const day = date => date.toISOString().slice(0, 10);

export function createDemoMoney(finance, {now = () => new Date().toISOString(), fail = message => { throw new Error(message); }} = {}) {
  const today = new Date(now()), stamp = now();
  const personal = finance.entities.find(entity => entity.type === 'personal');
  const business = finance.entities.find(entity => entity.type === 'company');
  const checking = finance.accounts.find(account => account.entityId === personal.id);
  const studio = finance.accounts.find(account => account.entityId === business.id);
  const card = {id:'demo_card', entityId:personal.id, name:'Everyday credit card', type:'credit_card', currency:'USD'};
  const reserve = {id:'demo_reserve', entityId:personal.id, name:'New savings account', type:'savings', currency:'USD'};
  finance.accounts.push(card, reserve);
  for (const row of finance.transactions) row.importSource ||= row.source === 'manual' ? 'manual' : 'csv';
  const row = (id, account, date, description, amountCents, importSource, category) => ({id, entityId:account.entityId,
    accountId:account.id, date, description, amountCents, currency:account.currency, category, kind:'expense',
    status:'confirmed', source:importSource === 'bank' ? 'plaid' : importSource, importSource,
    reference:importSource === 'document' ? 'Sample receipt QR-1042' : '', createdAt:stamp, updatedAt:stamp});
  for (let offset = 2; offset >= 0; offset--) {
    const date = day(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1, 12)));
    finance.transactions.push(row(`demo_music_${offset}`, checking, date, 'Fable Music', -1299, 'bank', 'Entertainment'));
  }
  const posted = day(new Date(+today - 86400000));
  finance.transactions.push(row('demo_duplicate_bank', studio, posted, 'Paper Kite Stationery', -3850, 'bank', 'Supplies'),
    row('demo_duplicate_receipt', studio, posted, 'Paper Kite Stationery', -3850, 'document', 'Supplies'));
  const retrievedAt = new Date(+today - 2 * 3600000).toISOString();
  const balances = (currentCents, availableCents, limitCents = null) => ({currentCents, availableCents, limitCents,
    currency:'USD', retrievedAt, sourceUpdatedAt:null, cached:true});
  const remote = (account, mask, value) => ({id:'remote_' + account.id, name:account.name, mask, currency:account.currency,
    mapping:{accountId:account.id, entityId:account.entityId, fromDate:day(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1)))}, balances:value});
  const bank = {configured:true, sessions:[], existingAccounts:finance.accounts, items:[{
    id:'demo_bank', institution:'Example Bank · fictional', lastSync:retrievedAt, balanceWarning:null,
    accounts:[remote(checking, '1042', balances(482345, 471235)), remote(studio, '2048', balances(1728450, null)),
      remote(card, '3042', balances(174200, 425800, 600000)), remote(reserve, '4080', balances(0, 0))],
  }], pending:[{id:'demo_pending_coffee', itemId:'demo_bank', accountId:checking.id, entityId:personal.id,
    date:day(today), description:'Juniper Coffee · pending', amountCents:-650, currency:'USD', kind:'expense'},
  {id:'demo_pending_supplies', itemId:'demo_bank', accountId:studio.id, entityId:business.id,
    date:day(today), description:'Studio supplies · pending', amountCents:-4675, currency:'USD', kind:'expense'}]};
  const receipts = [];
  const changes = new Map();
  let sequence = 0;
  const conflict = message => fail(message, 409);
  function review(body = {}) {
    const byId = new Map(finance.transactions.map(row => [row.id, row]));
    if (body.action === 'undo') {
      const decision = receipts.find(value => value.id === body.decisionId);
      if (!decision) return fail('Choose a saved review decision.', 404);
      if (!decision.undone) {
        const edits = changes.get(decision.id);
        if (edits.some(change => !same(byId.get(change.after.id), change.after))) return conflict('A record changed after this decision. Review it in Transactions before changing it again.');
        for (const change of edits) Object.assign(byId.get(change.before.id), {category:change.before.category, status:change.before.status, updatedAt:now()});
        decision.undone = true;
      }
      return {decision:clone(decision)};
    }
    if (!['recurring','duplicate'].includes(body.type) || !['dismiss','confirm-recurring','exclude-duplicate'].includes(body.action)
        || body.action === 'confirm-recurring' && body.type !== 'recurring' || body.action === 'exclude-duplicate' && body.type !== 'duplicate'
        || typeof body.key !== 'string' || !Array.isArray(body.rowIds) || body.rowIds.length < 2 || body.rowIds.length > 500
        || new Set(body.rowIds).size !== body.rowIds.length) return fail('Choose a complete suggestion to review.');
    const previous = receipts.find(decision => decision.key === body.key && !decision.undone);
    if (previous) {
      if (previous.action !== body.action || previous.type !== body.type || previous.excludeId !== (body.excludeId || null)) return conflict('This suggestion was already reviewed. Refresh to see that decision.');
      return {decision:clone(previous)};
    }
    const rows = body.rowIds.map(id => byId.get(id));
    if (rows.some(row => !row)) return conflict('A record is no longer available. Refresh the suggestions.');
    const {start, end} = body.scope || {};
    const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && day(new Date(value)) === value;
    if (!validDay(start) || !validDay(end) || start > end || Date.parse(end) - Date.parse(start) > 732 * 86400000
        || rows.some(row => row.date < start || row.date > end)) return fail('Include the displayed date range when reviewing a suggestion.');
    const accounts = new Set(rows.map(row => row.accountId));
    const evidence = finance.transactions.filter(row => row.entityId === rows[0].entityId && row.currency === rows[0].currency
      && accounts.has(row.accountId) && row.date >= start && row.date <= end);
    const candidates = body.type === 'recurring' ? detectRecurring(evidence, {today:day(today)}) : findDuplicateCandidates(evidence, {accounts:finance.accounts});
    const candidate = candidates.find(value => value.key === body.key && same([...value.rowIds].sort(), [...body.rowIds].sort()));
    if (!candidate) return conflict('The evidence changed or no longer supports this suggestion. Refresh and review it again.');
    if (body.action === 'exclude-duplicate' && !body.rowIds.includes(body.excludeId)) return fail('Choose which of these two records to exclude.');
    const edited = body.action === 'confirm-recurring' ? rows : body.action === 'exclude-duplicate' ? rows.filter(row => row.id === body.excludeId) : [];
    const edits = edited.map(row => ({before:clone(row), after:{...row, category:body.action === 'confirm-recurring' ? 'Recurring bill' : row.category,
      status:body.action === 'exclude-duplicate' ? 'excluded' : row.status, updatedAt:now()}}));
    const decision = {id:`demo_review_${++sequence}`, key:body.key, type:body.type, action:body.action,
      rowIds:[...body.rowIds], entityId:candidate.entityId, accountId:candidate.accountId, currency:candidate.currency,
      label:candidate.name || rows[0].description, excludeId:body.excludeId || null, createdAt:now(), undone:false};
    for (const edit of edits) Object.assign(byId.get(edit.after.id), edit.after);
    changes.set(decision.id, edits); receipts.unshift(decision);
    return {decision:clone(decision)};
  }
  return {status:() => clone(bank), reviews:() => ({decisions:clone(receipts)}), review};
}
