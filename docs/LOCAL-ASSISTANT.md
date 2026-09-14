# Local assistant features

Email opens to Important. Correct an email using the scope beside the importance button: similar emails from that sender (default), this email only, or the whole sender. Rules apply within the connected account; they do not change provider folders. Email preferences lists rules and lets you forget them. An explicit per-message choice takes precedence. A similar-email rule uses the local message category, such as newsletter or conversation, not an inferred domain-wide preference.

Email preferences also controls automatic replies. When enabled, the existing background check can prepare up to three replies from recent (seven-day) incoming mail. Messages must be important, addressed directly to the account, and contain an authored request; automated notices, obvious broadcasts and superseded threads are skipped. Drafts use your configured AI, and the existing claim checks also apply to automatic drafts. Existing, edited, discarded and sent replies are never replaced. Missing facts may leave a message needing review. No background process can send an email. Open Draft ready, review and edit the reply, then complete the review and choose **Send reply** to send it.

Ask retrieves relevant saved Money, Progress, Health, saved plans and committed import records freshly for each answer. Sources name the page and exact record. Totals come from database summaries, which also describe omitted records. Money records are not live bank balances; different currencies remain separate. Progress reports recorded completion decisions. Document context includes committed rows and their source evidence; full original PDFs and unsaved import previews are not available. Personal-record conversations require a configured model server on this computer or the local network. The model server's own routing determines where it processes requests.

Now includes a daily brief with recent important replies, today's saved meetings and source-backed or user-reviewed deadlines over the next seven days. It shows when the last check completed and whether any source failed. No model invents the brief's counts or deadlines.

Use an item's More menu → Source & corrections to see the original quote, author and sync date. Confirm it, correct its title or deadline, or dismiss it. Your correction is recorded locally and wins over later automatic updates to that item.

Ask keeps answering on the computer running Zelos for up to five minutes if a connected browser disconnects, provided Zelos and that computer keep running. It saves partial text and citations, and the browser recovers the same answer through read-only requests. Reopening Ask restores the last conversation in that browser tab. Stop explicitly cancels the server's answer. Quitting Zelos or restarting its service can interrupt unfinished work; its saved text remains available.

## Encrypted recovery copies

Settings → Your data controls daily encrypted backups and Back up now. Scheduled copies run while Zelos is running and idle; the latest seven verified copies are retained. Each snapshot includes the database, settings and portable credential files. AES-256-GCM authenticates the encrypted archive, and each completed backup is decrypted into a private temporary directory and validated before being retained. Temporary plaintext is removed afterward. These copies do not include operating-system keychain credentials, installed models or the rest of the computer.

Copies are under `backups/automatic/` inside the data folder shown in Settings. The separately stored recovery key is `.automatic-backup-key` at the root of that folder. With the default `~/.zelos` data folder, those are `~/.zelos/backups/automatic/` and `~/.zelos/.automatic-backup-key`; a Spark configured with `~/.zelos-spark` uses that folder instead. The key is not included in the encrypted archives or exposed by the web API. Copy an encrypted archive and protect a separate copy of its key on another device to survive loss of the machine; local copies alone cannot protect against disk failure or a compromised computer.

To prepare a recovery archive, with a compatible Zelos version installed:

```
node scripts/recover-automatic-backup.mjs /path/to/copy.zelos-encrypted /path/to/recovery-key /private/path/recovered.zelos-backup
```

This validates the `.zelos-encrypted` copy and creates a new decrypted `.zelos-backup` portable archive. It never replaces live data or an existing output file. Use the Zelos version that created the backup, or a version that explicitly supports its format and database schema. Keep the output private because it is not password protected, contains records and may contain credentials. Restore only after stopping other Zelos sessions and connected AI clients, using the desktop's reviewed **Restore a backup…** workflow; do not replace a live SQLite file. No restore is run automatically. Connections whose credentials are held by the operating system may need reconnecting on another computer.
