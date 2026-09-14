# Money: balances, pending activity and review suggestions

Money shows bank-reported balances separately from recorded spending. Each linked
account has its own balance card, scoped to the selected personal/company workspace,
account and currency. Positive credit-card balances mean amounts owed; a negative
card balance is credit on the card. Missing or unknown-currency amounts are shown as
Unavailable, while a reported zero is displayed as zero.

**Sync [bank name]** retrieves transactions and the cached balances supplied through
Plaid's `/accounts/get`. This does not request a paid real-time balance lookup. The
card distinguishes when Zelos retrieved the data from the bank's update timestamp,
which often is unavailable. If balances cannot refresh, the previous snapshot and a
warning remain visible. Opening Money reads saved data; it does not contact the bank.

**Pending** shows the latest saved pending activity, independently of the selected
historical spending period. Pending entries never count toward posted spending,
income, recurring-charge analysis, or transaction exports. A pending entry may change
amount, disappear, or be replaced by a posted transaction. Zelos applies those changes
after all sync pages are retrieved. Available balances may already reflect pending
activity, so Zelos does not subtract it a second time. Banks may omit pending data.

The first sync after this update retrieves pending history separately from the saved
transaction cursor, then applies the normal transaction changes. Existing reviewed
categories and exclusions remain intact.

**Review suggestions** finds possible duplicates and recurring charges in the selected
spending period. Recurring suggestions require at least three similar charges with a
consistent cadence in one account and currency. Estimates are labeled and omitted
for older patterns whose expected date has passed. The existing date picker supports
up to 24 calendar months; insufficient history can prevent detection. Suggestions are
not a complete subscription list or a statement of future obligations.

Duplicate suggestions compare signed amounts, dates and descriptions. Cross-account
matching is limited to documented/CSV Amex statements and linked feeds with compatible
card names and final digits; those matches still require verification. Multiple
possible matches remain explicit. Large result sets are capped with a visible notice.

- **Confirm recurring** categorizes the displayed charges as Recurring bill, preserving
  their amounts and review status. It does not create a future bill or a merchant rule.
- **Exclude this entry** changes only the selected copy's status. The original record
  remains in Transactions and can be restored.
- **Dismiss suggestion** saves the decision without changing financial records.
- **Undo** restores the fields changed by that decision if no later edit or sync has
  changed the affected records. Otherwise, review the current record in Transactions.

The server rechecks the current evidence and surrounding records within the displayed
date range before accepting a decision. Repeated submissions return the saved receipt.
No suggestion is applied automatically. Automatic encrypted backups recognize both
the new optional tables and backups from before this update.

Provider behavior: [Plaid accounts](https://plaid.com/docs/api/accounts/) and
[pending/posted transaction states](https://plaid.com/docs/transactions/transactions-data/).
