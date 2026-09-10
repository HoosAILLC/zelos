# Zelos 1.7.1

This patch fixes problems found while testing Zelos on a Mac.

- Draft edits are saved before reloading or quitting the desktop app, including the last keystrokes typed before the action. If saving fails, Zelos keeps the window and latest text open for retry or copying. Older failed saves cannot overwrite newer edits after a card is rebuilt.
- Quitting fully exits the Mac app after cleanup, so opening Zelos again starts a working window.
- Command-F returns focus to the search box even when Search is already open.
- External-link logs omit private draft text, credentials, paths, and query strings. If the operating system cannot open a link, Zelos shows recovery guidance.
- Month view lists each day's appointments in time order, with all-day events first and clash indicators retained.
- The native sample correctly describes the half-hour overlap between its afternoon review and delivery.

## Install or update

Choose the DMG for Apple silicon (`arm64`) or Intel (`x64`), or the Windows installer for your PC (`x64` for most PCs, `arm64` for Windows on Arm). Quit Zelos before replacing the application. Your existing data folder is retained and its database is upgraded on first launch.

Before upgrading, quit Zelos and copy your data folder to a safe location. The default is `~/.zelos`; a custom data folder is shown in Settings. A board snapshot is not a full backup. Keep the backup if you may need to return to an older application version; older versions may not support the upgraded database. Credentials kept in the operating system's keychain may need reconnecting on a different computer.

These builds are unsigned on Windows and ad-hoc signed, without Apple notarisation, on macOS. Only continue past an operating-system warning if you trust this release. Checksums verify that your downloaded file matches the release; they are not an independent security review. See INSTALL.md for first-launch instructions.

Google and Microsoft OAuth client registrations are not bundled. Gmail supports app-password setup when your account permits it; OAuth connections require the registration described in OAUTH.md. A model is needed for assessment and answers; sample data is available to explore the interface first. Zelos does not send messages or modify connected tasks.
