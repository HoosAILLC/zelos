# Zelos 1.7.0

This release makes the board follow changes in your sources more reliably and makes setup failures easier to recover from.

- Todoist and Linear tasks that disappear from a complete source selection stop generating active obligations. History stays searchable, and reappearing tasks become active again. A missing task is labelled as outside the current selection; it is not assumed completed.
- Source cards show their last successful read and current error. Failed or partial reads keep the previous success time.
- Setup stays in place until you finish or skip it, with visible errors and retry for sample data. Finished items have clear Restore/Reopen actions, and custom snooze dates explain invalid input.
- Changed messages and events trigger reassessment even when no new row is added. Cancelled calendar events stop contributing conflicts, and complete calendar reads retire vanished events conservatively.
- Draft autosave and discard are ordered safely. Interrupted or malformed model responses report failure, and answers cut short by the model show a notice without losing the partial text.
- Credentials are isolated by data folder, revoked AI tokens are checked again before dispatch, and logging failures no longer crash the app.
- The website demo, source archive, and four desktop downloads are built from the same tagged source. SHA256SUMS.txt and release.json identify the published files.

## Install or update

Choose the DMG for Apple silicon (`arm64`) or Intel (`x64`), or the Windows installer for your PC (`x64` for most PCs, `arm64` for Windows on Arm). Quit Zelos before replacing the application. Your existing data folder is retained and its database is upgraded on first launch.

Before upgrading, quit Zelos and copy your data folder to a safe location. The default is `~/.zelos`; a custom data folder is shown in Settings. A board snapshot is not a full backup. Keep the backup if you may need to return to an older application version; older versions may not support the upgraded database. Credentials kept in the operating system's keychain may need reconnecting on a different computer.

These builds are unsigned on Windows and ad-hoc signed, without Apple notarisation, on macOS. Only continue past an operating-system warning if you trust this release. Checksums verify that your downloaded file matches the release; they are not an independent security review. See INSTALL.md for first-launch instructions.

Google and Microsoft OAuth client registrations are not bundled. Gmail supports app-password setup when your account permits it; OAuth connections require the registration described in OAUTH.md. A model is needed for assessment and answers; sample data is available to explore the interface first. Zelos does not send messages or modify connected tasks.
