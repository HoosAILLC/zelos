/** Cached bank snapshots are independent of the selected spending dates. */
export function moneyScope(row, { entities = [], section = 'all', entityId = '', accountId = '', currency = 'USD' } = {}) {
  const entity = entities.find(value => value.id === row.entityId);
  return Boolean(entity && (section === 'all' || entity.type === (section === 'business' ? 'company' : 'personal')) &&
    (!entityId || row.entityId === entityId) && (!accountId || row.accountId === accountId) && row.currency === currency);
}

export function scopedBankSnapshot(status, accounts, scope) {
  const balances = [];
  for (const item of status?.items || []) {
    for (const remote of item.accounts || []) {
      const account = accounts.find(value => value.id === remote.mapping?.accountId);
      if (!account) continue;
      const reported = remote.balances;
      const currency = account.currency;
      const currencyWarning = reported && (!reported.currency || reported.currency !== account.currency)
        ? 'The bank balance currency could not be matched to this account. Amounts are unavailable.' : '';
      const balance = currencyWarning ? { ...reported, currentCents: null, availableCents: null, limitCents: null } : reported;
      if (!moneyScope({ ...account, accountId: account.id, currency }, scope)) continue;
      balances.push({ account, remote, item, currency, balance: balance || null, currencyWarning });
    }
  }
  return { balances, pending: (status?.pending || []).filter(row => moneyScope(row, scope)) };
}

export function balancePresentation(accountType, balances) {
  const value = balances?.currentCents;
  const known = Number.isSafeInteger(value);
  const credit = accountType === 'credit_card' || accountType === 'credit';
  return {
    label: credit ? known && value < 0 ? 'Credit on card' : 'Amount owed' : 'Bank balance',
    amountCents: known ? credit ? Math.abs(value) : value : null,
    availableCents: Number.isSafeInteger(balances?.availableCents) ? balances.availableCents : null,
    availableLabel: credit ? 'Available credit' : 'Available to spend',
    limitCents: Number.isSafeInteger(balances?.limitCents) ? balances.limitCents : null,
  };
}

export function snapshotTime(value) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unavailable';
}

export function scopedReviewDecisions(decisions, rows, scope) {
  const inRange = new Set(rows.map(row => row.id));
  return (decisions || []).filter(decision => !decision.undone &&
    moneyScope(decision, { ...scope, accountId: '' }) &&
    (!scope.accountId || decision.accountId === scope.accountId ||
      decision.rowIds?.every(id => rows.some(row => row.id === id && row.accountId === scope.accountId))) &&
    decision.rowIds?.some(id => inRange.has(id)));
}
