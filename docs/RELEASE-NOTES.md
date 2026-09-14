# Zelos 1.8.4 — QA candidate

This candidate is under native build and acceptance testing. It is **not a
published release**; GitHub Actions artifacts are for QA and do not establish
that all platform checks have passed.

- **Money accuracy:** Connected accounts show cached bank-reported balances
  with retrieval times and any available bank update time. Missing amounts stay
  unavailable; card debt stays separate from cash. Pending transactions appear
  separately from posted spending totals. Balance and pending snapshots remain
  current snapshots when reviewing historical spending.
- **Review suggestions:** Recurring-charge and possible-duplicate suggestions
  show their supporting records. Confirm, dismiss or exclude an exact duplicate
  copy, with Undo for saved decisions. Similar charges from the same source sit
  behind a disclosure because they may be separate purchases. Suggestions do not
  change records automatically.
- **Email and assistant:** Draft replies with your configured AI and review the
  recipient and final text before choosing **Send reply**. Optional background
  drafting never sends. Ask can use saved personal records with citations and
  recover saved answer text after a browser disconnect while Zelos stays running.
- **Document imports:** Preview statement, invoice and lab records from PDFs
  or images, check the evidence and choose what to save. Text extraction needs
  optional Poppler or Tesseract tools; AI review requires a configured model on
  this computer or the local network. See [document prerequisites](INSTALL.md#optional-pdf-and-scan-imports).
- **Desktop reliability:** Packaging includes the pinned runtime dependencies
  and checks each Mac and Windows architecture separately. Clipboard fallback
  restores focus and selection, Ask handles Command/Ctrl shortcuts without
  sending during composition, newer file selections win over older reads, and
  task refreshes preserve focus and expanded details. Platform guidance now
  distinguishes the computer running Zelos from an optional Spark host.
- **Recovery copies:** Daily encrypted backups retain seven verified copies.
  Recovery requires the separately stored key and produces a portable archive
  for reviewed restoration. See the backup scope below before upgrading.

## Earlier changes included: 1.8.2

This patch fixes long Claude inbox reviews. Zelos receives the response as Claude produces it and waits for the complete board before saving any results. An active response can take longer than two minutes; a connection that stops making progress still times out.

- **Long Claude reviews:** Full Anthropic reviews use the existing streaming connection. Thinking and keepalive messages keep the connection active, while only the finished response is used to build the board. Cancelled, interrupted or truncated replies cannot replace the board.
- **Response limit:** Settings → AI → Advanced → Response limit (tokens) exposes the reply allowance. For Sonnet 5 this covers reasoning as well as the visible answer; increase it if a review reaches the limit. Existing settings are preserved when another AI field is saved.

This version also includes the privacy wording corrections in 1.8.1 and the backup, history and navigation improvements introduced in 1.8.

- **Back up and restore:** Settings → Your data can create a private backup of the archive, drafts, captures, history, settings and portable credentials. Restore validates the file, previews its contents, asks before replacement, and keeps a recovery copy. Other Zelos and AI clients must close before the data is replaced.
- **What changed?:** Item cards show recorded changes to deadlines, priority, status and explanations. Repeated unchanged assessments add no noise. History begins when this feature is first installed; older changes are not invented. Task-selection changes remain distinct from completing a task.
- **Commands:** The visible Commands button and ⌘/Ctrl+Shift+P open searchable navigation, capture and check actions with keyboard selection and focus return.
- **Connection recovery:** Reading warnings open the exact account. Setup status distinguishes saved configuration from a recorded successful read; retry controls respect connection waiting times.
- **Manual update checks:** Settings → About checks the official GitHub release only when pressed, without account content or credentials. It shows release notes and downloads; installation remains a user action.
- **Maintenance reliability:** Delayed password-store checks cannot start a retired scheduled run after stop/restart. Tests cover sleep, outage recovery, backup corruption, interrupted restore and the new controls.
- **Faster archive imports:** Initial search indexing checks existing references once per source batch. A synthetic 50,000-message import fell from 360 seconds to 3.3 seconds on the review Mac, with replacement and duplicate handling preserved. See QA-1.8.md for scope and repeatable benchmarks.

## Install or update

Choose the DMG for Apple silicon (`arm64`) or Intel (`x64`), or the Windows installer for your PC (`x64` for most PCs, `arm64` for Windows on Arm). Quit Zelos before replacing the application. Your existing data folder is retained and its database is upgraded on first launch.

Before upgrading, quit Zelos and copy your data folder to a safe location. The default is `~/.zelos`; a custom data folder is shown in Settings. A board snapshot is not a full backup. Keep the copy if you may need to return to an older application version; restore with the version that created the backup or one that explicitly supports its format and database schema.

Desktop **Create backup** produces a `.zelos-backup` archive of the database, settings and portable credential files. It is not password protected. **Daily encrypted backups** and **Back up now** produce `.zelos-encrypted` copies that require the separate `.automatic-backup-key`. Recovery first creates a decrypted `.zelos-backup` for the reviewed restore workflow; it does not replace live data automatically. Keep a protected archive and separate key on another device. Neither format backs up installed models or the rest of the computer. Credentials kept in the operating system's keychain may need reconnecting on another computer. See [recovery steps](LOCAL-ASSISTANT.md#encrypted-recovery-copies).

These builds are unsigned on Windows and ad-hoc signed, without Apple notarisation, on macOS. Only continue past an operating-system warning if you trust this release. Checksums verify that your downloaded file matches the release; they are not an independent security review. See INSTALL.md for first-launch instructions.

Google and Microsoft OAuth client registrations are not bundled. Gmail supports app-password setup when your account permits it; OAuth connections require the registration described in OAUTH.md. A model is needed for assessment and answers; sample data is available to explore the interface first. Zelos sends an email only after the user's review and explicit **Send reply** action. Background checks and draft generation do not send messages, and Zelos does not modify connected tasks. Reading Messages from an iPhone's synced texts is available only on a Mac with the required permission.
