# Installing Zelos

Zelos is available as a desktop app or a source download. Both run the same
program. The desktop app includes its runtime and opens in its own window.

**Not a programmer?** You want the desktop app. Download it for your Mac or
Windows PC from [the Zelos download page](https://zelos-app.netlify.app/#download).
The currently published **1.8.1 installers are unsigned** and updates are manual.
Your computer may show a warning; continue only if you trust that download. The sections
[Installing on macOS](#installing-on-macos--and-what-you-will-actually-see) and
[Installing on Windows](#installing-on-windows--and-what-you-will-actually-see)
below explain installation on each platform. Command-line setup is optional.

This checkout describes the **1.8.4 QA candidate**, which is not a published
release. Candidate installers are temporary GitHub Actions artifacts; native
build and acceptance checks must finish before release. The download links above
continue to point to published builds. Signing and in-app update support in this
checkout are not evidence of a signed release: publisher accounts, credentials,
and the first complete signed release still need to be configured and verified.

## Updating from an earlier version

### Existing 1.8.1 installations and unsigned previews

Updates remain manual for these builds. **Check for updates** can open the
official release information; it cannot install a replacement inside Zelos.
Download and install the first signed release once to enable its native updater.

Quit Zelos, then copy the data folder shown in Settings to a safe location before
installing the update. The usual folder is `~/.zelos`. Install the new app over
the old one; it retains your data and upgrades the database on first launch.
Keep the copy if you may need to return to an older version. A board snapshot
is not a complete backup, and credentials in your operating system's keychain
may need reconnecting on another computer.

Release notes, all four installers, source, and SHA-256 checksums are on the
[GitHub releases page](https://github.com/HoosAILLC/zelos/releases).

Starting with 1.8, the desktop app also offers **Settings → Your data → Create backup**.
It saves a consistent archive of the database, captures, drafts, item history,
settings and portable credentials. Keep the `.zelos-backup` file private: it is
not password protected and can include credentials. Passwords held outside the
data folder by the operating system may need reconnecting on another computer.

**Restore a backup…** validates the file and previews its date and contents before
asking to replace your current data. Zelos keeps a private recovery copy, then
restarts after a successful restore. Close other Zelos sessions and connected AI
clients before starting; restore refuses to replace data while another client is
using it. Only restore a backup you trust, with a version that supports its schema.
The command-line/browser app retains the full-folder backup procedure above.

**Daily encrypted backups** and **Back up now** create `.zelos-encrypted`
recovery copies in the data folder and keep the latest seven verified copies.
Recovering one requires its separate `.automatic-backup-key`; it first produces
a private, decrypted `.zelos-backup` archive for the reviewed restore workflow.
Keep a copy of the archive and a separately protected key on another device.
See [Encrypted recovery copies](LOCAL-ASSISTANT.md#encrypted-recovery-copies)
for locations and recovery steps. These copies are not a full computer backup
and do not include operating-system keychain credentials or installed AI models.

**Settings → About → Check for updates** checks the official GitHub release when
pressed. It sends no account content or credentials, and does not install anything.

### Installed signed Mac and Windows releases

Signed releases check for updates **45 seconds after startup, then every six
hours** while Zelos is running. Turn this off with **Settings → About → Updates →
Check for updates automatically**; **Check for updates** remains available.
Checks read public release information from GitHub without sending your archived
content or account credentials. They select the update for your platform and
processor architecture.

An available-update notification opens **About** when clicked. Choose **Download
update** to download it. Zelos does not start downloads automatically, and it does
not install a downloaded update just because you quit the app.

When the download is ready, choose **Update and restart** and confirm in the
desktop dialog. Zelos saves open drafts and creates a private local recovery
backup before stopping its core, installing, and restarting. If saving or backup
fails, the app stays open and the update is not installed. Keep that backup private;
like a manual `.zelos-backup`, it can contain personal records and portable
credentials. It is saved under the data folder's `backups/` directory as
`Before-update-<id>.zelos-backup`. This recovery copy does not replace keeping a
backup on another device.

**Custom launches keep manual updates.** If you start Zelos with `--home`,
`--port`, `ZELOS_HOME`, or `ZELOS_PORT`, in-app updating is disabled so an installer cannot
restart it with different data-folder or connection settings. Download the new
release manually, retain your backup, and reopen with the same custom settings.
On a Mac, move Zelos from the disk image or another folder into **Applications**
and reopen it before using in-app updates. Source, browser, and unsupported
desktop installations continue to use manual downloads.

The first signed release and an upgrade between signed versions still require
real signing and installation verification. The existing 1.8.1 release and unsigned
development previews do not gain these capabilities from a source-code update.

## Optional PDF and scan imports

Imports accepts PDF, PNG and JPEG files up to **8 MB**, with PDFs limited to
**12 pages**. Install the following optional tools on the computer running Zelos:

- **Poppler** provides `pdfinfo` and `pdftotext` for PDFs, plus `pdftoppm` for
  scanned PDF pages.
- **Tesseract OCR**, with its English (`eng`) language data, reads PNG/JPEG
  images and scanned PDF pages. Scanned PDFs need both tools.

These tools are not included in the desktop installer. Zelos checks the system
PATH and common installation folders. If it cannot find a tool, install it and
reopen Zelos. On Windows, add the folder containing the tool's executables to
PATH if it is not found automatically.

Text extraction runs on the computer running Zelos. The extracted text is then
sent to your configured AI on that computer or local network to prepare a
preview; configure that model in Settings first. Review the preview and choose
which records to save. No records are committed just by selecting a file.

## Path 1 — Command-line usage

Download and unpack the source archive, then open a terminal in its `zelos`
folder. The npm package is not part of this release; use `node zelos.mjs`
followed by any subcommand below.

### The four things you can type

```
node zelos.mjs                Run the app. This is the one you want.
node zelos.mjs sweep          Read your sources once, think about them, print what
                     changed, and stop. Exits non-zero if the sweep failed,
                     so it is safe to put in a cron job.
node zelos.mjs doctor         Check every part of the setup and say, in plain words,
                     what to do about anything that is wrong.
node zelos.mjs mcp            Serve Zelos's read-only tools over MCP on stdin/stdout,
                     for an AI client that spawns it. Off unless you have
                     switched AI access on in Settings.
```

Every one of them takes `--home <dir>`. `zelos sweep` and `zelos doctor` also
take `--json`, if you would rather have data than sentences.

### When something is not working, ask the doctor first

```
zelos doctor
```

It checks your Node version, the permissions on your data folder, whether your
settings file loads, whether the secret store can be written, whether your model
answers, whether each mail account signs in, and whether each calendar link
resolves. Every line that is not a `✓` ends in a specific thing to do:

```
  ✕  Model          Could not reach the model at http://127.0.0.1:11434/v1
       →  Nothing is listening there. Start your local model first — for
          Ollama that is: ollama serve

  ✕  Mail · Work    imap.gmail.com: [AUTHENTICATIONFAILED] Invalid credentials
       →  Gmail requires 2-Step Verification plus a 16-character App
          Password. Your normal password will not work over IMAP.
```

It exits `0` when nothing is broken and `1` when something is. Things you simply
have not set up yet are marked `!`, not `✕` — a fresh install is unfinished, not
faulty.

---

## Path 2 — Run it from source

### What you need

This path is for people who already type commands. If that is not you, the
desktop app in [Path 3](#path-3--the-desktop-app) is the same program in a
window — take that instead.

**Node.js 22.16 or newer, or 24 or newer** — and the gap in the middle is real,
not a typo. Zelos keeps everything in the SQLite built into Node, and its index
needs that SQLite's full-text search extension. Node's build did not include it
until **22.16**, and does not include it anywhere in the **Node 23** line. On a
runtime without it Zelos will not start, and says which versions do work rather
than failing partway through a migration. **Node 26 is what it is developed and
tested against**, and it is what you want. Get Node from
[nodejs.org](https://nodejs.org) and take the defaults.

To check what you have, open Terminal (macOS/Linux) or PowerShell (Windows):

```
node --version
```

### Get Zelos and start it

```
cd zelos
npm ci --omit=dev --ignore-scripts
node zelos.mjs
```

The install command uses the exact runtime dependency versions in the lockfile.
It works in Terminal on macOS and PowerShell on Windows. Desktop installers
already include these dependencies; they do not need this step.

You will see a banner like this, and your browser will open:

```
  ZELOS 1.8.4
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Open   http://127.0.0.1:7777/?t=9c1f…

  Data   /Users/you/.zelos
  Model  not set up yet — the app will walk you through it
  …
```

**That `?t=…` is a session token, and it is not decoration.** Any web page you
have open can send requests to `127.0.0.1`; the token is what stops one from
reading your board. It is new on every launch, so the previous link stops
working when you restart. Do not paste it into anything.

### Options

```
node zelos.mjs --port 7788     # a different port (default 7777, or $ZELOS_PORT)
node zelos.mjs --home ~/zdata  # keep the data somewhere else (default ~/.zelos)
node zelos.mjs --no-open       # do not open a browser, just print the URL
node zelos.mjs --sweep-now     # sweep immediately on start
node zelos.mjs --help
```

The subcommands from Path 1 work here too — `node zelos.mjs doctor`,
`node zelos.mjs sweep`, `node zelos.mjs mcp`.

Press `Ctrl-C` in the terminal to stop it.

---

## Path 3 — The desktop app

### What the shell adds

- A real application window and a Dock/taskbar icon.
- A tray icon with **Check now**, **Open Zelos** and **Quit**.
- A menu bar supports copy/paste and view shortcuts: ⌘/Ctrl+1–5 and 7–9,
  with ⌘/Ctrl+F for Search.
- It keeps running when you close the window, so scheduled sweeps keep
  happening. Exactly when, by platform:
  - **macOS** — always. That is how macOS apps work; ⌘Q quits.
  - **Windows** — when automatic sweeps are on *and* a tray icon was created.
    With sweeps off, closing the window quits.
  - **Linux** — closing the window **quits**, even with sweeps on and a tray
    icon apparently made, **unless you set `ZELOS_TRAY_RESIDENT=1`**. A tray
    icon there is a StatusNotifierItem published on the session bus, and
    publishing succeeds whether or not any panel is watching — so `new Tray()`
    returning an object proves nothing. Rather than hide the window into a tray
    that may not exist, Zelos quits and makes you say out loud that your tray
    works. Losing a background sweep costs one click; losing the way back into
    the app does not.

### What it does not add

- No Zelos account and no telemetry. Signed desktop releases check public GitHub
  release information automatically unless you turn that setting off; older
  unsigned builds check only when asked. Neither sends archived content or
  account credentials. The shell blocks every
  outbound request from the window that is not the local board — **including
  WebSockets**, which is the class it silently missed until the guard's match
  pattern was widened from `*://*/*` to `<all_urls>` (`*` in a scheme position
  means http and https and nothing else, so `new WebSocket('wss://…')` used to
  sail past). It denies every browser permission except the one the "copy draft"
  buttons need, and turns spellcheck off because Chromium fetches its
  dictionaries from a Google server.
- No hidden launch. **Open Zelos at login** puts Zelos in the OS login-items
  list and nothing more: at login the window opens, in front of whatever you sat
  down to do. It never launched hidden, and the code no longer implies it might.
- No second copy of anything. The shell runs the Zelos core **inside its own
  process** — it does not launch a background Node.

### Optional: read iPhone texts already on your Mac

The Messages source needs texts to be available in Messages on this Mac and
**Full Disk Access for the installed Zelos app**, granted by you in macOS
System Settings → Privacy & Security. Quit and reopen Zelos after granting it.
No Apple password is entered in Zelos. Follow the
[Messages setup guide](SOURCES.md#iphone-texts-from-messages-on-this-mac) for
iPhone syncing, permissions and import limits.

Use **Read sources now** inside Zelos to import without asking AI. Keep
automatic checks off in **Settings → Schedule** for local-only import; a later
AI review or question can send selected imported text to your configured AI.
This imports text only; it does not send messages or read attachments, calls or
voicemail.

### Where a build comes from

Published installers and source archives are available on the
[GitHub Releases page](https://github.com/HoosAILLC/zelos/releases).
Choose the release version and architecture that match your computer:

| Computer | Installer filename pattern |
| --- | --- |
| Apple Silicon Mac | `Zelos-VERSION-arm64.dmg` |
| Intel Mac | `Zelos-VERSION-x64.dmg` |
| Windows x64 PC | `Zelos-VERSION-setup-x64.exe` |
| Windows ARM64 PC | `Zelos-VERSION-setup-arm64.exe` |

On a Mac, Apple menu → About This Mac shows the chip. On Windows,
Settings → System → About → System type shows the processor architecture.

The signed release workflow builds Mac releases on matching native runners.
Windows packages are signed on x64 and then installed and checked on matching
x64 and ARM64 runners. Manual QA runs keep candidates as temporary GitHub Actions
artifacts; a successful version-tagged release publishes verified installers,
Mac update ZIPs, update feeds, exact source, and checksums to Releases. The separate
preview workflow produces unsigned artifacts. A QA artifact is not itself a
published release. Maintainer account setup is in [Signing releases](SIGNING.md).

### Building it yourself

From the source root, install the pinned runtime and desktop build dependencies:

```
npm ci --omit=dev --ignore-scripts
cd desktop
npm ci
npm start            # run the desktop app without packaging
npm run dist:mac     # build macOS disk images on a Mac
npm run dist:win     # build Windows installers on Windows
```

Finished installers land in `desktop/dist/`. Packaging stages the production
runtime dependencies from the root lockfile and keeps Electron's build tools
out of the core's dependency folder.

Build disk images on macOS and Windows installers on Windows. The GitHub
workflow provides separate runners for Apple Silicon, Intel Macs, Windows x64
and Windows ARM64, and runs packaged startup and backup checks on each.

---

## Installing on macOS — and what you will actually see

For the published **1.8.1** build, your Mac may block the first opening. If you
trust that download, press **Done**, not **Move to Trash**, then open **System
Settings → Privacy & Security** and choose **Open Anyway**. These steps are for
the existing download, whose publisher Apple cannot yet verify.

**Published 1.8.1 and unsigned previews:** the app has an ad-hoc signature, which
allows Apple Silicon to load it but does not verify the publisher. These builds
are not notarized. The local packaging defaults in `desktop/package.json` produce
these development builds; the separate signed workflow requires a Developer ID
certificate, hardened runtime, and notarization.

Open the `.dmg`, drag **Zelos** to **Applications**, eject the disk image, and
open the installed app. For a signed release, macOS should be able to verify the
publisher and notarization, though it may still ask whether to open an app
downloaded from the internet. The first signed release has not yet been published.

For the existing unsigned build, macOS may say it cannot verify the developer
or check the app for malware. If you deliberately trust that release:

1. Dismiss the warning with **Done**.
2. Open **System Settings → Privacy & Security** and locate the blocked app
   in the Security section.
3. Choose **Open Anyway**, authenticate when asked, and confirm **Open**.

Do not use this unsigned-build exception to dismiss an unexpected signature
warning on a release advertised as signed. Check the release notes and download
the original artifact again instead.

### If it says "Zelos is damaged and can't be opened"

A missing or invalid signature, a modified bundle, or a damaged download can
cause this message. Download a fresh copy from the official release and verify
its checksum. Re-signing a downloaded app yourself removes the publisher's
signature and is not a repair for a signed release. For a local development
build, rebuild from your reviewed source instead.

---

## Installing on Windows — and what you will actually see

For the published **1.8.1** build, Windows may show **Windows protected your PC**.
Choose **More info**, then **Run anyway** only if you trust the download.
Windows cannot verify the publisher of this existing installer.

**Published 1.8.1 and unsigned previews:** Windows cannot verify the installer
publisher. A future signed release must pass the release checks for the
installer, application, and uninstaller; that first signed release is still
waiting for publisher account setup and verification.

1. Choose `Zelos-VERSION-setup-x64.exe` for an ordinary PC or
   `Zelos-VERSION-setup-arm64.exe` for Windows on ARM. Check **Settings → System →
   About → System type** if unsure. Each architecture has its own installer.
2. Download from the official release page and run the installer. If SmartScreen
   shows **Windows protected your PC**, **More info** shows the publisher and any
   available **Run anyway** option. Only continue if you trust the source.
   Existing unsigned builds show **Unknown publisher**. On a signed release,
   check that the verified publisher matches the release information; an unknown
   or unexpected publisher is not the expected signed-release result.
3. The installer normally installs per-user without an administrator password
   into `C:\Users\<you>\AppData\Local\Programs\Zelos`. You can change the
   location, and choose desktop and Start menu shortcuts. It launches Zelos when
   setup finishes.

Signing identifies the publisher and lets Windows detect changes to signed
files. A new signed download can still trigger SmartScreen because reputation
also matters. See [Microsoft's explanation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).
Your browser or organization may apply additional download restrictions.

To uninstall: **Settings → Apps → Installed apps → Zelos → Uninstall**. It
leaves `C:\Users\<you>\.zelos` alone, on purpose — see **Where your things
live** below.

### One thing that is genuinely weaker on Windows

Zelos asks for `0700` on its home folder and `0600` on every file it writes
there. On Windows those calls do almost nothing — there are no POSIX modes to
set — so the protection around your mail cache is the NTFS ACL your user profile
already carries, which also lets Administrators read it.
[SECURITY.md § 5](SECURITY.md#5-what-leaves-your-machine) states that properly
and is the one place it is kept up to date; if you are on a machine you do not
solely administer, read it before you connect a mail account.

---

## Where your things live

| | macOS / Linux | Windows |
|---|---|---|
| Your data (database, config, logs) | `~/.zelos` | `C:\Users\<you>\.zelos` |
| Window size and position | `~/.zelos/window.json` | same |
| Logs | `~/.zelos/logs/desktop.log` — **desktop app only** | same |
| Secrets | your login Keychain, service `com.zelos.app` (or `secrets.enc` + `.seed` in `~/.zelos` if there is no keychain) | `%LOCALAPPDATA%\Zelos\secrets`, DPAPI-encrypted |
| The shell's browser profile (your theme choice, nothing else) | `~/Library/Application Support/Zelos` | `%APPDATA%\Zelos` |

**There is no `zelos.log`.** The `logs/` directory is created on every launch,
but only the desktop shell ever writes to it, and the file it writes is
`desktop.log`. Run Zelos from a terminal and the log is the terminal — nothing
is written to disk. An empty `~/.zelos/logs/` after a CLI session is correct,
not a fault.

**Uninstalling never deletes `~/.zelos`.** Your mail cache, your board and
your settings survive, on purpose, so that reinstalling does not lose your work.

Getting rid of it is two deliberate steps, and Zelos makes you do both by
hand. There is no "wipe everything" button and no API route that erases the
database — a local server that will destroy your data on request is a local
server some stray web page can be pointed at.

1. Quit Zelos, then delete the folder: `rm -rf ~/.zelos`
   (Windows: delete `C:\Users\<you>\.zelos`). If you installed the command
   globally, remove it too: `npm uninstall -g zelos-app`. (`npx` leaves nothing
   behind but an npm cache entry, which npm clears on its own.)
2. Your mail passwords and API keys are usually **not in that folder** — but
   check, because there is one case where they are. On macOS they are in your
   login keychain under the service `com.zelos.app` — remove them with Keychain
   Access. On Windows they are DPAPI-encrypted files in
   `%LOCALAPPDATA%\Zelos\secrets` — delete that folder. On Linux they are in
   your desktop keyring under the same service name. **If no keychain was
   available**, they are `secrets.enc` in `~/.zelos`, decrypted by `.seed` in
   the same folder, and step 1 has already deleted both. **Settings → About**
   tells you which store your machine actually ended up using, and so does
   `zelos doctor`; the folder itself now records the answer in
   `secrets.backend.json`.

**Settings → Your data** inside the app shows the exact path and offers a board
snapshot containing private board content, excluding connection settings and diagnostics. The desktop
app also offers backup and restore; a board snapshot alone cannot restore the full archive. The
`Board → Show data folder` and `Board → Show logs` menu items open these
directly.

---

## Honest notes about these builds

- **Published 1.8.1 and development previews are unsigned.** Mac previews use
  an ad-hoc signature without notarization; Windows previews have no verified
  publisher signature. The signed release workflow does not change older files.
- **Automated checks do not replace native acceptance testing.** The desktop
  workflow builds and checks each supported Mac and Windows architecture.
  A passing build does not establish that native dialogs, clipboard permissions,
  tray behaviour or input methods work in every setup. The 1.8.4 QA candidate
  remains under verification; report platform-specific issues before release.
- **The app is shipped unpacked, on purpose.** Most Electron apps bundle their
  code into an opaque `app.asar` archive. Zelos does not: `asar` is off in the
  build configuration. Open `/Applications/Zelos.app/Contents/Resources/`
  (right-click the app → Show Package Contents) and you will find `core/`,
  `ui/`, `assets/` and the shell itself in `app/` as ordinary readable files —
  byte for byte the ones in this repository. An app whose entire claim is "you
  can check what it does" should not hide its own code. Diff them against a
  clone if you want to be sure.
- **Signed releases can check automatically; downloads and restarts are your
  choice.** Existing 1.8.1 and unsigned previews retain manual updates. See
  [Updating from an earlier version](#updating-from-an-earlier-version) for the
  first signed installation and the recovery backup made before later upgrades.
- **One copy at a time, and it tells you rather than stopping you.** Launching
  the app while the app is already running brings the existing window forward.
  The other pairing — a `zelos` running in a terminal and the app in the tray,
  both pointed at the same home — is caught differently: both write a
  `zelos.lock` in the data directory, and the second one to arrive *warns* you,
  naming what it thinks is already running and where its board is. It does not
  refuse. That check reads a file to guess whether another process is alive,
  and a guess is occasionally wrong; a wrong guess that could stop you opening
  your own app would be a worse bug than the overlap it prevents. If you know
  nothing else is running, the warning tells you which file to delete. What the
  overlap actually costs, if you do run two: the same mail fetched twice and
  the same model calls paid for twice.
- **The desktop board is not reachable from your browser.** The shell keeps the
  session token to itself and never prints it. If you want the board in your own
  browser, use Path 1 or Path 2, where the launcher prints the URL for you.
- **Architecture matters on both platforms.** Take the `arm64` build for Apple
  Silicon and Windows on ARM, and the `x64` build for Intel Macs and ordinary
  PCs. The wrong one either runs slowly under emulation or does not run at all.
  Windows installers are separate for each architecture. Check System type in
  Windows Settings if you are unsure which to download.

---

## Troubleshooting

**Start here: `zelos doctor`.** It is the shortest path from "it isn't working"
to "here is the line to fix", and it names the specific next action rather than
the exception it caught. From source that is `node zelos.mjs doctor`; in the
desktop app, **Settings → About** shows the same findings.

**Claude connects, but an inbox review reaches its response limit.**
Open **Settings → AI → Advanced → Response limit (tokens)**. [Sonnet 5 uses this
allowance for reasoning and the visible answer together](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5). A starting allowance of
32,768 can help a review that stops at 8,192; stay within your chosen model's
supported output limit. The allowance is a ceiling, not a request to fill it,
but a longer answer can use more paid tokens. Save and run the review again.

**A long Claude review times out even though the connection test works.**
Use Zelos 1.8.2 or later. Full Anthropic reviews receive the response as it is
produced, so thinking and keepalive messages count as progress. The connection
still fails after two minutes without progress, and an incomplete response is
never saved as a finished board.

**"Zelos could not start" on launch.**
Almost always a port or a data folder problem. The dialog names the actual
error. If another Zelos is already running, quit that one first. To use a
different port: `open -a Zelos --args --port 7788` on macOS, or add
`--port 7788` to the shortcut's target on Windows.

**The window is blank.**
Use `Board → Reload board` (⌘R / Ctrl+R). It reloads the URL the shell holds,
token included — an ordinary browser refresh would not.

**Links do not open.**
By design, only `http`, `https` and `mailto` links leave the app, and they open
in your normal browser rather than inside the window. Anything else — `file:`,
`data:`, or an app-specific scheme like `zoommtg:` — is refused outright and
logged. Mail is written by strangers; a link in it does not get to reach into
this machine.

**Where did the app go when I closed the window?**
It is in the tray (macOS: the menu bar, top right). That is where **Check now**,
**Open Zelos** and **Quit** live. On Windows this only happens when automatic
sweeps are switched on; with them off, closing the window quits. On Linux,
closing the window quits even with sweeps on, unless you have set
`ZELOS_TRAY_RESIDENT=1` — see "What the shell adds" above for why.

**Something is wrong and I want to see why.**
Run `zelos doctor` first. If you want the raw record after that:
`Board → Show logs`, then open `desktop.log`. Passwords and API keys are
redacted before anything is written, so the file is safe to read and safe to
send to someone — but read it first anyway.
