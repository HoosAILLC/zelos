# Zelos 1.8.0

This release adds backup and recovery tools, a clearer record of changes, and faster navigation.

- **Back up and restore:** Settings → Your data can create a private backup of the archive, drafts, captures, history, settings and portable credentials. Restore validates the file, previews its contents, asks before replacement, and keeps a recovery copy. Other Zelos and AI clients must close before the data is replaced.
- **What changed?:** Item cards show recorded changes to deadlines, priority, status and explanations. Repeated unchanged assessments add no noise. History begins with this version; older changes are not invented. Task-selection changes remain distinct from completing a task.
- **Commands:** The visible Commands button and ⌘/Ctrl+Shift+P open searchable navigation, capture and check actions with keyboard selection and focus return.
- **Connection recovery:** Reading warnings open the exact account. Setup status distinguishes saved configuration from a recorded successful read; retry controls respect connection waiting times.
- **Manual update checks:** Settings → About checks the official GitHub release only when pressed, without account content or credentials. It shows release notes and downloads; installation remains a user action.
- **Maintenance reliability:** Delayed password-store checks cannot start a retired scheduled run after stop/restart. Tests cover sleep, outage recovery, backup corruption, interrupted restore and the new controls.
- **Faster archive imports:** Initial search indexing checks existing references once per source batch. A synthetic 50,000-message import fell from 360 seconds to 3.3 seconds on the review Mac, with replacement and duplicate handling preserved. See QA-1.8.md for scope and repeatable benchmarks.

## Install or update

Choose the DMG for Apple silicon (`arm64`) or Intel (`x64`), or the Windows installer for your PC (`x64` for most PCs, `arm64` for Windows on Arm). Quit Zelos before replacing the application. Your existing data folder is retained and its database is upgraded on first launch.

Before upgrading, quit Zelos and copy your data folder to a safe location. The default is `~/.zelos`; a custom data folder is shown in Settings. From 1.8 onward, native backups are also available. A board snapshot is not a full backup. Keep the backup if you may need to return to an older application version; older versions may not support schema 4. Backup files are not password protected and may contain portable credentials. Credentials kept in the operating system's keychain may need reconnecting on a different computer.

These builds are unsigned on Windows and ad-hoc signed, without Apple notarisation, on macOS. Only continue past an operating-system warning if you trust this release. Checksums verify that your downloaded file matches the release; they are not an independent security review. See INSTALL.md for first-launch instructions.

Google and Microsoft OAuth client registrations are not bundled. Gmail supports app-password setup when your account permits it; OAuth connections require the registration described in OAUTH.md. A model is needed for assessment and answers; sample data is available to explore the interface first. Zelos does not send messages or modify connected tasks.
