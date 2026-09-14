/** Owner-reviewed financial suggestions. No model or bank calls. */
import crypto from 'node:crypto';
import { FinanceError, financeTransactionRows, financeDate } from './finance.mjs';
import { detectRecurring, findDuplicateCandidates } from '../ui/lib/money-patterns.js';

const fail = (message, status = 400) => { throw new FinanceError(status, message); };
export function migrateFinanceReviews(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS finance_review_decisions (
    id TEXT PRIMARY KEY, pattern_key TEXT NOT NULL, type TEXT NOT NULL,
    action TEXT NOT NULL, metadata_json TEXT NOT NULL, changes_json TEXT NOT NULL,
    created_at TEXT NOT NULL, undone_at TEXT
  );`);
}
const decisionView = row => ({ id: row.id, key: row.pattern_key, type: row.type, action: row.action,
  ...JSON.parse(row.metadata_json), createdAt: row.created_at, undone: Boolean(row.undone_at) });
export function listFinanceReviews(db) {
  migrateFinanceReviews(db);
  return { decisions: db.prepare('SELECT * FROM finance_review_decisions ORDER BY created_at DESC,id DESC').all().map(decisionView) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function reviewFinance(db, body, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Choose a valid review action.');
  const actions = ['dismiss', 'confirm-recurring', 'exclude-duplicate', 'undo'];
  if (!actions.includes(body.action)) fail('Choose a valid review action.');
  migrateFinanceReviews(db);
  db.exec('SAVEPOINT finance_review');
  try {
    // Take the write lock before reading evidence from another browser or sync.
    db.prepare('UPDATE finance_review_decisions SET id=id WHERE id=?').run('');
    const allRows = financeTransactionRows(db), byId = new Map(allRows.map(row => [row.id, row]));
    let decision;
    if (body.action === 'undo') {
      if (typeof body.decisionId !== 'string') fail('Choose a saved decision.');
      decision = db.prepare('SELECT * FROM finance_review_decisions WHERE id=?').get(body.decisionId);
      if (!decision) fail('This review decision was not found.', 404);
      if (!decision.undone_at) {
        const changes = JSON.parse(decision.changes_json);
        for (const change of changes) if (!same(byId.get(change.after.id), change.after)) fail('A record changed after this decision. Review it in Transactions before changing it again.', 409);
        for (const change of changes) db.prepare('UPDATE finance_transactions SET category=?,status=?,updated_at=? WHERE id=?')
          .run(change.before.category, change.before.status, new Date().toISOString(), change.before.id);
        db.prepare('UPDATE finance_review_decisions SET undone_at=? WHERE id=?').run(new Date().toISOString(), decision.id);
        decision = db.prepare('SELECT * FROM finance_review_decisions WHERE id=?').get(decision.id);
      }
    } else {
      if (!['recurring', 'duplicate'].includes(body.type) || typeof body.key !== 'string' || body.key.length > 256
        || !Array.isArray(body.rowIds) || body.rowIds.length < 2 || body.rowIds.length > 500
        || body.rowIds.some(id => typeof id !== 'string' || id.length > 100) || new Set(body.rowIds).size !== body.rowIds.length) fail('Choose a complete suggestion to review.');
      if (body.action === 'confirm-recurring' && body.type !== 'recurring' || body.action === 'exclude-duplicate' && body.type !== 'duplicate') fail('This action does not match the suggestion.');
      // A repeated request returns the original receipt, even after it changed records.
      const previous = db.prepare('SELECT * FROM finance_review_decisions WHERE pattern_key=? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1').get(body.key);
      if (previous) {
        if (previous.action !== body.action || previous.type !== body.type || JSON.parse(previous.metadata_json).excludeId !== (body.excludeId || null)) fail('This suggestion was already reviewed. Refresh to see that decision.', 409);
        decision = previous;
      } else {
        const rows = body.rowIds.map(id => byId.get(id));
        if (rows.some(row => !row)) fail('A record is no longer available. Refresh the suggestions.', 409);
        if (!body.scope || typeof body.scope !== 'object') fail('Include the displayed date range when reviewing a suggestion.');
        const start = financeDate(body.scope.start), end = financeDate(body.scope.end);
        if (start > end || Date.parse(end) - Date.parse(start) > 732 * 86400000 || rows.some(row => row.date < start || row.date > end)) fail('Choose a valid suggestion date range.');
        const evidenceAccounts = new Set(rows.map(row => row.accountId));
        // New imports can contradict a displayed pattern without changing its
        // original rows. Recompute the complete displayed account/date evidence.
        const evidence = allRows.filter(row => row.entityId === rows[0].entityId && row.currency === rows[0].currency
          && evidenceAccounts.has(row.accountId) && row.date >= start && row.date <= end);
        const accounts = db.prepare('SELECT id,entity_id AS entityId,name,type,currency FROM finance_accounts').all();
        const candidates = body.type === 'recurring' ? detectRecurring(evidence, { today }) : findDuplicateCandidates(evidence, { accounts });
        const pattern = candidates.find(p => (p.key || p.id) === body.key && same([...p.rowIds].sort(), [...body.rowIds].sort()));
        if (!pattern) fail('The evidence changed or no longer supports this suggestion. Refresh and review it again.', 409);
        if (body.action === 'exclude-duplicate' && !body.rowIds.includes(body.excludeId)) fail('Choose which of these two records to exclude.');
        const changes = [];
        const edited = body.action === 'confirm-recurring' ? rows : body.action === 'exclude-duplicate' ? rows.filter(row => row.id === body.excludeId) : [];
        for (const row of edited) {
          const category = body.action === 'confirm-recurring' ? 'Recurring bill' : row.category;
          const status = body.action === 'exclude-duplicate' ? 'excluded' : row.status;
          const updatedAt = new Date().toISOString();
          db.prepare('UPDATE finance_transactions SET category=?,status=?,updated_at=? WHERE id=?').run(category, status, updatedAt, row.id);
          changes.push({ before: row, after: { ...row, category, status, updatedAt } });
        }
        const id = 'review_' + crypto.randomUUID(), now = new Date().toISOString();
        const metadata = { rowIds: body.rowIds, entityId: pattern.entityId, accountId: pattern.accountId,
          currency: pattern.currency, label: pattern.name || rows[0].description, excludeId: body.excludeId || null };
        db.prepare('INSERT INTO finance_review_decisions VALUES(?,?,?,?,?,?,?,NULL)').run(id, body.key, body.type, body.action, JSON.stringify(metadata), JSON.stringify(changes), now);
        decision = db.prepare('SELECT * FROM finance_review_decisions WHERE id=?').get(id);
      }
    }
    db.exec('RELEASE finance_review');
    return { decision: decisionView(decision) };
  } catch (error) { db.exec('ROLLBACK TO finance_review; RELEASE finance_review'); throw error; }
}
