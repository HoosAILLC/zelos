# Local assistant features

Email opens to Important. Correct an email using the scope beside the importance button: similar emails from that sender (default), this email only, or the whole sender. Rules apply within the connected account; they do not change provider folders. Email preferences lists rules and lets you forget them. An explicit per-message choice takes precedence. A similar-email rule uses the local message category, such as newsletter or conversation, not an inferred domain-wide preference.

Email preferences also controls automatic replies. When enabled, the existing background check can prepare up to three replies from recent (seven-day) incoming mail. Messages must be important, addressed directly to the account, and contain an authored request; automated notices, obvious broadcasts and superseded threads are skipped. Nemotron runs locally and the existing claim checks also apply to automatic drafts. Existing, edited, discarded and sent replies are never replaced. Missing facts may leave a message needing review. No background process can send an email. Open Draft ready to review, edit and explicitly send.

Ask retrieves relevant saved Money, Progress, Health, saved plans and committed import records freshly for each answer. Sources name the page and exact record. Totals come from database summaries, which also describe omitted records. Money records are not live bank balances; different currencies remain separate. Progress reports recorded completion decisions. Document context includes committed rows and their source evidence; full original PDFs and unsaved import previews are not available. Personal-record conversations require a local model.

Now includes a daily brief with recent important replies, today's saved meetings and source-backed or user-reviewed deadlines over the next seven days. It shows when the last check completed and whether any source failed. No model invents the brief's counts or deadlines.

Use an item's More menu → Source & corrections to see the original quote, author and sync date. Confirm it, correct its title or deadline, or dismiss it. Your correction is recorded locally and wins over later automatic updates to that item.

Ask keeps answering on the Spark for up to five minutes if the phone disconnects. It saves partial text and citations, and the browser recovers the same answer through read-only requests. Reopening Ask restores the last conversation in that browser tab. Stop explicitly cancels the server's answer. A service restart can still interrupt unfinished work; its saved text remains available.

## Encrypted recovery copies

Settings → Your data controls daily encrypted backups and Back up now. They run when the app is idle and retain the latest seven verified copies. Each snapshot includes the database, settings and portable credential files. AES-256-GCM authenticates the encrypted archive, and each completed backup is decrypted into a private temporary directory and validated before being retained. Temporary plaintext is removed afterward.

On the Spark, copies are under `~/.zelos-spark/backups/automatic/`. The separately stored recovery key is `~/.zelos-spark/.automatic-backup-key` (owner-only permissions). The key is not included in those encrypted archives or exposed by the web API. Copy an encrypted archive and protect a separate copy of its key outside the Spark to survive loss of the machine; local copies alone cannot protect against disk failure or a compromised Spark.

To prepare a recovery archive, with a compatible Zelos version installed:

```
node scripts/recover-automatic-backup.mjs /path/to/copy.zelos-encrypted /path/to/recovery-key /private/path/recovered.zelos-backup
```

This validates the encrypted copy and creates a new decrypted portable archive. It never replaces live data. Keep that output private because it contains records and may contain credentials. Restore only after stopping writers and using the existing reviewed backup/restore workflow; do not replace a live SQLite file. No restore is run automatically.
