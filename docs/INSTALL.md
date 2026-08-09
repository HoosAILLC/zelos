# Installing Zelos

There are three ways to run Zelos, and all three run **the same program**. The
desktop app is not a different Zelos — it is the same core, in a window, with
a tray icon.

|  | `npx zelos-app` | Run from source | Desktop app |
|---|---|---|---|
| What you install | nothing permanent | Node.js | a `.dmg` or a `.exe` |
| Third-party code | none | none | Electron (the window), and only in the shell |
| Where the board opens | your own browser | your own browser | its own window |
| Download | ~280 KB (plus Node, if you don't have it) | ~60 MB (Node) | ~120 MB, ~300 MB installed |
| Runs in the background | while the terminal is open | while the terminal is open | yes, from the tray |
| Warns on first open | no | no | **yes — see below.** These builds are not signed |

**If you just want to see it: `npx zelos-app`.** One line, nothing installed
permanently, and it is the same code as everything else here.

---

## Path 1 — `npx zelos-app`

You need **Node.js 22.5 or newer** (see the next section for why, and how to
check). Then:

```
npx zelos-app
```

That downloads one package, runs it, and opens your browser at the board. There
is no install step, no configuration file to write first, and nothing to undo
afterwards.

To keep it around instead:

```
npm install -g zelos-app     # installs the `zelos` command
zelos                        # …and this starts it
```

**What that actually downloads.** One package, about 280 KB, and nothing else —
Zelos has no dependencies, so there is no tree of other people's code behind it.
It declares no install scripts either, so `npm` runs nothing on the way in:
downloading it and running it are two separate decisions, and you make both.

> The npm name is **`zelos-app`** (`zelos` was taken). Publishing a release is a
> deliberate, manual step, so if `npx` tells you the package or the version you
> want is not there, take Path 2 — the source is the same program.

### The four things you can type

```
zelos                Run the app. This is the one you want.
zelos sweep          Read your sources once, think about them, print what
                     changed, and stop. Exits non-zero if the sweep failed,
                     so it is safe to put in a cron job.
zelos doctor         Check every part of the setup and say, in plain words,
                     what to do about anything that is wrong.
zelos mcp            Serve Zelos's read-only tools over MCP on stdin/stdout,
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

**Node.js 22.5 or newer** — that is the version that added the built-in SQLite
Zelos keeps everything in. **Node 26 is what it is developed and tested
against**, and it is what you want; on Node 22 and 23 the SQLite module is still
experimental and may need `node --experimental-sqlite zelos.mjs`. Get Node
from [nodejs.org](https://nodejs.org) and take the defaults.

To check what you have, open Terminal (macOS/Linux) or PowerShell (Windows):

```
node --version
```

### Get Zelos and start it

```
cd zelos
node zelos.mjs
```

That is the whole installation. There is **no `npm install`** step, because the
app has no dependencies — the entire thing is written against what Node ships
with. If instructions anywhere ever tell you to `npm install` in the Zelos
folder, something is wrong. (The one exception is the `desktop/` folder, which
is a separate package that exists only to put this same app in a window. See
Path 3.)

You will see a banner like this, and your browser will open:

```
  ZELOS 1.0.0
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
- A tray icon with **Sweep now**, **Open Zelos** and **Quit**.
- A menu bar, so ⌘C and ⌘V work in the draft editors, and ⌘1…⌘6 jump between
  views.
- It keeps running when you close the window, so scheduled sweeps keep
  happening. (On macOS, always — that is how macOS apps work. On Windows and
  Linux, only when automatic sweeps are switched on; with them off, closing the
  window quits.)

### What it does not add

- No account, no sign-in, no update check, no telemetry. The shell blocks every
  outbound request from the window that is not the local board, denies every
  browser permission except the one the "copy draft" buttons need, and turns
  spellcheck off because Chromium fetches its dictionaries from a Google server.
- No second copy of anything. The shell runs the Zelos core **inside its own
  process** — it does not launch a background Node.

### Building it yourself

There are no published binaries to download from anywhere in this repository.
You build it, or you take Path 1 or Path 2. Building needs one `npm install`,
and it is the only one in the project:

```
cd desktop
npm install          # downloads Electron (~120 MB) and electron-builder
npm start            # run it now, unpackaged, to see if you like it
npm run dist:mac     # build the macOS .dmg files  (must be run on a Mac)
npm run dist:win     # build the Windows installer (run it on Windows)
```

Finished installers land in `desktop/dist/`:

```
Zelos-1.0.0-arm64.dmg          Apple Silicon
Zelos-1.0.0-x64.dmg            Intel Macs
Zelos-1.0.0-setup-x64.exe      Windows
Zelos-1.0.0-setup-arm64.exe    Windows on ARM
```

Two honest limits on cross-building:

- **A macOS `.dmg` can only be built on a Mac.** It needs Apple's own tools.
- **Building the Windows installer from a Mac or Linux needs Wine**, and it
  frequently does not work. Build it on Windows.

`npm install` here installs Electron and electron-builder as *development*
dependencies of the shell only. Nothing from npm ends up in the Zelos core,
and the core still has zero dependencies — you can confirm that by looking at
the top-level `package.json`, which has no `dependencies` field at all.

---

## Installing on macOS — and what you will actually see

**These builds are not signed and not notarized.** Nobody has paid Apple $99 to
vouch for them, so macOS treats them the way it treats any unknown app. This is
not a bug to work around quietly; it is the trade, and you should know exactly
what you are agreeing to before you click past a security warning.

1. Open the `.dmg`, drag **Zelos** to **Applications**, eject the disk image.
2. Double-click Zelos in Applications. macOS refuses:

   > **Apple could not verify "Zelos" is free of malware that may harm your
   > Mac or compromise your privacy.**
   > `Move to Trash` `Done`

   (On macOS 14 and earlier the wording is *""Zelos" cannot be opened because
   the developer cannot be verified."*)

   Click **Done**. Do not move it to the trash.
3. Open **System Settings → Privacy & Security** and scroll down to the
   **Security** section. There will be a line that just appeared:

   > **"Zelos" was blocked to protect your Mac.**  `Open Anyway`

4. Click **Open Anyway** and authenticate with Touch ID or your password.
5. One more confirmation appears — *"macOS cannot verify the developer of
   "Zelos". Are you sure you want to open it?"* — click **Open**.

macOS remembers. You will not be asked again.

**On macOS 14 and earlier** there is a shortcut: Control-click (right-click) the
app in Finder → **Open** → **Open**. Apple removed that path in macOS 15, which
is why the System Settings route above is the one that works everywhere.

**From the Terminal**, if you prefer:

```
xattr -d com.apple.quarantine /Applications/Zelos.app
```

That deletes the "downloaded from the internet" flag macOS attaches to the file.
It is a real safety mechanism — only strip it from something you built yourself
or fetched deliberately, and never because a web page told you to.

### If it says "Zelos is damaged and can't be opened"

On Apple Silicon, every executable needs at least an ad-hoc signature, and an
unsigned build gets refused with that misleading message. Sign it locally:

```
codesign --force --deep --sign - /Applications/Zelos.app
```

`--sign -` is an *ad-hoc* signature: it identifies nobody, it just satisfies the
loader. The build configuration asks for exactly this (`mac.identity: "-"`), so
a build you made yourself should not hit this — the fix is here for a bundle
that was modified after it was signed, which invalidates the signature.

---

## Installing on Windows — and what you will actually see

Same story, different wording. The installer is unsigned, so it has no
reputation with Microsoft.

1. **The browser may block the download.** Edge says *"…setup.exe was blocked
   because it could harm your device"*; Chrome says *"…isn't commonly
   downloaded"*. Open the downloads list, click the **…** next to the file, and
   choose **Keep** (then **Keep anyway** on the follow-up).
2. **Running it trips SmartScreen.** A blue full-window dialog:

   > **Windows protected your PC**
   > Microsoft Defender SmartScreen prevented an unrecognized app from starting.
   > Running this app might put your PC at risk.
   > `Don't run`

   Click **More info** — it will show *Publisher: Unknown publisher* — then
   **Run anyway**.
3. The installer is per-user, so Windows does not ask for an administrator
   password. It installs to
   `C:\Users\<you>\AppData\Local\Programs\Zelos` and offers a Start menu and
   desktop shortcut.

To uninstall: **Settings → Apps → Installed apps → Zelos → Uninstall**.

---

## Where your things live

| | macOS / Linux | Windows |
|---|---|---|
| Your data (database, config, logs) | `~/.zelos` | `C:\Users\<you>\.zelos` |
| Window size and position | `~/.zelos/window.json` | same |
| Logs | `~/.zelos/logs/` | same |
| Secrets | your login Keychain, service `com.zelos.app` | `%LOCALAPPDATA%\Zelos\secrets`, DPAPI-encrypted |
| The shell's browser profile (your theme choice, nothing else) | `~/Library/Application Support/Zelos` | `%APPDATA%\Zelos` |

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
2. Your mail passwords and API keys are **not in that folder**. On macOS they
   are in your login keychain under the service `com.zelos.app` — remove them
   with Keychain Access. On Windows they are DPAPI-encrypted files in
   `%LOCALAPPDATA%\Zelos\secrets` — delete that folder. On Linux they are in
   your desktop keyring under the same service name. **Settings → About** tells
   you which store your machine actually ended up using.

**Settings → Data** inside the app shows you the exact path, copies it to the
clipboard, and can export a JSON snapshot of the database first. The
`Board → Show data folder` and `Board → Show logs` menu items open these
directly.

---

## Honest notes about these builds

- **Not signed, not notarized.** Every warning above is macOS and Windows doing
  their job. You are choosing to trust a build; the reason that is a reasonable
  choice here is that you can read the source and, if you want, produce the
  build yourself.
- **The app is shipped unpacked, on purpose.** Most Electron apps bundle their
  code into an opaque `app.asar` archive. Zelos does not: `asar` is off in the
  build configuration. Open `/Applications/Zelos.app/Contents/Resources/`
  (right-click the app → Show Package Contents) and you will find `core/`,
  `ui/`, `assets/` and the shell itself in `app/` as ordinary readable files —
  byte for byte the ones in this repository. An app whose entire claim is "you
  can check what it does" should not hide its own code. Diff them against a
  clone if you want to be sure.
- **No auto-update, at all.** The app never contacts a server to ask whether it
  is old. Check back here yourself when you want a newer version, and install it
  the same way.
- **One copy at a time.** Starting Zelos while it is already running just
  brings the existing window forward — two copies would fight over one database.
- **The desktop board is not reachable from your browser.** The shell keeps the
  session token to itself and never prints it. If you want the board in your own
  browser, use Path 1 or Path 2, where the launcher prints the URL for you.
- **Architecture matters on both platforms.** Take the `arm64` build for Apple
  Silicon and Windows on ARM, and the `x64` build for Intel Macs and ordinary
  PCs. The wrong one either runs slowly under emulation or does not run at all.

---

## Troubleshooting

**Start here: `zelos doctor`.** It is the shortest path from "it isn't working"
to "here is the line to fix", and it names the specific next action rather than
the exception it caught. From source that is `node zelos.mjs doctor`; in the
desktop app, **Settings → About** shows the same findings.

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
It is in the tray (macOS: the menu bar, top right). That is where **Sweep now**,
**Open Zelos** and **Quit** live. On Windows and Linux this only happens when
automatic sweeps are switched on; with them off, closing the window quits.

**Something is wrong and I want to see why.**
Run `zelos doctor` first. If you want the raw record after that:
`Board → Show logs`, then open `desktop.log`. Passwords and API keys are
redacted before anything is written, so the file is safe to read and safe to
send to someone — but read it first anyway.
