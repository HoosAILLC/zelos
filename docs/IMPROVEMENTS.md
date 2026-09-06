# Follow-up product improvements

Reviewed against the 1.6.0 application and the fixes proposed in the September 6, 2026 follow-up review. These are recommendations, not a claim that the features below are already implemented.

## Recommended order

| Priority | Improvement | Why it matters | A useful first version |
| --- | --- | --- | --- |
| 1 | Publish one consistent release | The public site still identifies its demo as 1.5.0, while this repository is 1.6.0. The desktop workflow uploads build artifacts but does not publish a GitHub release or update Netlify. A source-code fix does not reach people using those downloads. | Build installers and source archives from the same tested tag, publish checksums and release notes, and update the site's version and links together. Keep the previous release available for rollback. |
| 2 | Carry task completion through to the board | External tasks have a lifecycle: open, completed, reopened, deleted. Treating each connector only as a source of incoming text leaves the app without a reliable way to retire old obligations. | Give task records a stable source identity and explicit status. Feed changes into reassessment; only infer absence after a proven complete source read. Show a visible reason when an obligation is resolved. |
| 3 | Make each source's freshness visible | A quiet board can mean nothing new, a failed connection, or a source that has not been checked yet. The current Now banner reports the latest run's failures, and Settings can test a connection; a persistent per-source status would make recovery easier. | Show last successful read, last attempt, and the actionable error on each source card. Offer a retry for that source and a direct link to its settings. Preserve the last successful timestamp when a retry fails. |
| 4 | Explain changes to an item | The app shows why an item matters now, but a deadline or priority changing is easier to trust when the user can see what changed and which source caused it. | A small activity panel showing the previous value, new value, assessment time, source link, and the stored explanation. Distinguish the time a source was read from the time the board was assessed. Use observable facts and saved reasons, not invented model reasoning. |
| 5 | Add guided backup and restore | Copying the data folder works, but the app should explain when it is safe to copy it and what happens to OS-stored credentials on another computer. A board snapshot is useful for sharing or inspection, but it cannot restore the application. | Create a consistent backup with a format/version manifest, then provide a restore preview that checks integrity and shows what will be restored before replacing anything. Explain which accounts need reconnecting. Keep backups local unless the user chooses a destination. |
| 6 | Add a small keyboard command menu | Desktop view shortcuts already exist. Common daily actions such as capture, search, check now, and opening a source could be easier to discover in both the desktop app and browser. | An accessible command menu with visible shortcuts, clear focus handling, and no activation while typing in an editor. Start with navigation and capture; keep destructive actions out of the first version. |

## Small improvements included in this review

- Name the data export **Save board snapshot** and explain its contents and limits.
- Recommend quitting before copying the whole data folder, and explain that OS keychain credentials may need reconnecting on another computer.
- Label relative snoozes by their actual interval and show the date when the chosen time crosses into another day.
- Tell the user when an AI answer stopped at its output limit while keeping the partial answer available to read and copy.

## What to defer

Keep automatic sending, broad background notifications, and cloud synchronization out of this reliability pass. They introduce new permissions and product decisions. The immediate value is a board that reflects current source facts, reports failures clearly, and reaches users through a consistent release process.
