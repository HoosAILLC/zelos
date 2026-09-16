# Zelos

**Zelos reads your mail and your calendar and gives you one page: what needs
you now, what you owe people, what people owe you, and what's coming.**

It runs on your computer. Your mail stays on your computer. The only thing that
ever leaves is the question Zelos asks the model you chose — and if you choose
a model running on your own machine, none of that content leaves. Manual update
checks contact GitHub without account content or credentials.

Named for **Ζῆλος / Zelos**, the Greek daimon of zeal — one of the four winged
enforcers who stood beside Zeus.

---

## The promise, in plain language

Most "AI assistant" products work by uploading your inbox to a company's servers
and asking you to trust them. Zelos is built the other way round:

- **Your mail is read on your machine.** Zelos connects to your mail server
  directly, the same way Apple Mail or Outlook does, and stores what it reads in
  a single file in your home folder.
- **You choose the model, and you can choose one that runs on your laptop.**
  Ollama, LM Studio, llama.cpp — Zelos treats them exactly like a paid API.
  With one of those selected, Zelos makes no outbound connection except to
  your own mail and calendar servers, and to the host of any source you add
  in Settings → Sources, unless you request a manual update check.
- **Nothing else phones home.** No analytics, no telemetry, no crash reports, no
  automatic update checks, no web fonts, no tracking pixels. There is no code in Zelos
  that talks to us, because there is no "us" to talk to.
- **It has no third-party code.** Zelos is written entirely against what Node
  ships with. There are no packages to audit, no supply chain, nothing that can
  be replaced under you by someone else's release.
- **It never sends mail.** Zelos writes drafts. Sending is your click, in your
  mail app, every time.
- **It never acts on what the model says.** The model's output is drawn on the
  screen. It is never run, followed, or clicked. This matters more than it
  sounds like it does — see [SECURITY.md](SECURITY.md).

You do not have to take any of that on faith.
[Check it yourself](#checking-for-yourself-that-nothing-leaves) — the section at
the end shows you how, in about five minutes, without being a programmer.

---

## What you need

- **A computer** running macOS, Windows or Linux.
- **Node.js 22.16 or newer — or 24 or newer.** Not simply "22 or newer", and
  the exception is worth a sentence because it will otherwise waste an hour of
  your life: Zelos stores everything in the SQLite that comes built into Node,
  and uses its full-text search extension for the index. That extension is
  missing from Node's build until **22.16**, and missing from the **whole of
  the Node 23 line**, whatever the bigger number suggests. On any of those,
  Zelos refuses to start and says so rather than failing halfway through.
  Node 26 is what it is developed and tested against. Download it from
  [nodejs.org](https://nodejs.org) and take the default options. To check what
  you have, open Terminal (macOS/Linux) or PowerShell (Windows) and run:

  ```
  node --version
  ```

- **A mail account that speaks IMAP.** Gmail, iCloud, Outlook, Yahoo, Fastmail
  and almost every work mail server do. See [Connecting your
  mail](#connecting-your-mail).
- **Either** an API key from a model provider **or** a model running on your own
  machine. See [Choosing a model](#choosing-a-model).

There is nothing to install beyond Node. Zelos has no dependencies, so there
is no `npm install` step. If a set of instructions ever tells you to run
`npm install` inside Zelos, something is wrong.

---

## Running it

From the `zelos` folder:

```
node zelos.mjs
```

You will see something like this:

```
  ZELOS 1.8.2
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Open   http://127.0.0.1:7777/?t=fb52ad7d…a43da8be

  Data   /Users/you/.zelos
  Model  not set up yet — the app will walk you through it
  Mail   none yet
  Cal    none yet
  Sweep  every 30m between 6:00 and 23:00
```

Your browser should open by itself. If it doesn't, copy that whole `Open` line
into your browser — **including the `?t=…` part**, which is the key to the door.
The first thing you'll see is setup: pick a model, connect mail, connect a
calendar, run the first sweep. You can stop at any step and come back.

Press **Ctrl-C** in the terminal to stop Zelos.

### The `?t=…` in the URL

`127.0.0.1` means "this computer" — but every web page you have open can also
send requests to `127.0.0.1`. A page you visit could otherwise talk to Zelos
behind your back. So Zelos invents a new random password on every launch,
prints it in that URL, and refuses every request that doesn't carry it.

Two consequences worth knowing:

- **The link changes every time you restart.** A bookmark of the old link will
  load the page but nothing will work. Copy the new one from the terminal.
- **Don't paste that URL into a chat window or a bug report.** Treat it like a
  password, because it is one. Restarting Zelos invalidates it.

When Zelos opens your browser for you, it does *not* use that link. Handing a
URL to the browser means handing it to `open` (or `xdg-open`, or `cmd start`)
as a command-line argument — and on a shared machine, command lines are
readable by every other process running as you. So the browser gets a one-shot
ticket instead: a random id that is good for ten seconds, is spent the first
time it is used, and is worth nothing afterwards. The link in the terminal is
still there for you to copy by hand.

### Options

| Option | What it does |
| --- | --- |
| `--port 8080` | Listen on a different port. If it's busy, Zelos walks up until it finds one that's free. |
| `--home ~/zelos-work` | Keep the data somewhere other than `~/.zelos`. Useful for a second, separate setup (work and personal, say). |
| `--no-open` | Don't open a browser; just print the link. |
| `--sweep-now` | Run a sweep immediately instead of waiting for the schedule. |
| `--version` | Print the version. |
| `--help` | Print the options. |

---

## Choosing a model

Zelos speaks two "wire protocols", and between them they cover essentially
every provider and every local runtime. **The protocol is not the company** —
Google, Groq, Mistral, DeepSeek, Ollama and LM Studio all speak the one labelled
`openai`. In Settings you pick a provider from the list and Zelos fills in the
technical parts.

### Option A — a model on your own machine

AI assessment and answers stay on your computer with a local model. Reading
connected sources still contacts their services, and manual update checks contact
GitHub. Zelos looks for local models automatically when you first open Settings
and offers whatever it finds first.

**Ollama** — the simplest one to start with.

1. Install it from [ollama.com](https://ollama.com).
2. In a terminal, download a model:
   ```
   ollama pull llama3.2
   ```
   (Bigger is better here. If your machine has 32GB of memory or more, try
   `ollama pull qwen2.5:32b` instead — the quality difference on this kind of
   work is large.)
3. Ollama runs in the background on `http://127.0.0.1:11434`. Open Zelos
   Settings; it should already have found it. Pick your model. **Leave the API
   key blank** — local models don't need one, and Zelos will not ask.

**LM Studio** — if you prefer a graphical app.

1. Install it from [lmstudio.ai](https://lmstudio.ai), download a model in its
   interface.
2. Go to its **Developer / Local Server** tab and press **Start Server**. It
   listens on `http://127.0.0.1:1234`.
3. Zelos will find it. Again: no key.

**llama.cpp, vLLM, LocalAI** and anything else with an OpenAI-compatible server
work the same way. If Zelos doesn't find yours automatically, choose the
matching preset — or "Custom (OpenAI-compatible)" — and type the address its
server prints, ending in `/v1`. Zelos checks the address by asking it for its
model list, and tells you exactly what went wrong if it can't reach it.

> **A note on quality.** A small local model will produce a rougher board than a
> large hosted one — it will miscategorise things and write clumsier drafts.
> That's a real trade, not a detail. Try both; some people find a 7B model's
> "good enough" board is worth more than a perfect one that costs privacy.

### Option B — a hosted model

You paste an API key once. Zelos stores it in your system keychain and it is
never written into any config file, never passed on a command line, and never
included in a log.

| Provider | Where to get a key |
| --- | --- |
| Anthropic (Claude) | console.anthropic.com → API keys |
| OpenAI | platform.openai.com → API keys |
| Google Gemini | aistudio.google.com → Get API key |
| Groq | console.groq.com → API keys |
| Mistral, DeepSeek, xAI, Together, OpenRouter, Fireworks, Cerebras | each provider's console, under API keys |

Pick the provider in Settings, paste the key, choose a model from the list
Zelos fetches, and press **Test**. A green result means the whole path works.

**Cost.** A sweep asks the model once — by default at most once every 30
minutes, and only when something has actually changed. It sends your recent
messages, not your whole mailbox.

That is not the only thing that spends money, and the other one is you: **every
question on the Ask page is its own model call**, streamed, with the matching
mail and events as context. So is each press of **Test** in Settings → AI.
Neither is on a schedule — they happen when you ask — but a long session on the
Ask page can outspend a day of sweeps.

On a normal inbox with a mid-priced model the sweeps are cents a day, not
dollars. If you want it cheaper, turn
**Send message bodies** off in Settings → Privacy: Zelos will then send only
headers and short snippets. That is a genuine change in what leaves your
machine, and the board gets noticeably less sharp — the app says so honestly
rather than pretending otherwise.

---

## Connecting your mail

Zelos connects over IMAP and **only ever reads**. It uses `BODY.PEEK`, the
IMAP command that fetches a message without marking it as read, so nothing in
your inbox changes because Zelos looked at it. It never deletes, never moves,
never sends.

**If you get stuck, every setup step has an Ask Claude link.**
[zelos-app.netlify.app/help](https://zelos-app.netlify.app/help) carries one
message per step — opening the app the first time, choosing the AI, each mail
provider below, each calendar — written so that Claude (or ChatGPT) knows which
screen you are on, what that screen needs and the provider's real steps, and is
told to go one step at a time, in plain words, and to ask you what you see. A
message names the step and the provider and nothing else: never your address, a
password or a key, and it tells Claude never to ask for one.

**The short way.** Under **Settings → Mail → Add a mailbox**, type your email
address. Zelos recognises the provider — Gmail, iCloud, Yahoo, AOL, Fastmail,
Zoho, Outlook, and a custom domain hosted on Google Workspace or Microsoft 365,
which it recognises through the domain's own DNS records — and shows one
button.

For **Gmail and Google Workspace** the button is **Sign in with Google**: it
opens Google's consent page in your browser, you approve, the browser comes back
to Zelos on `127.0.0.1`, and the mailbox is connected. For **Outlook, Hotmail,
Live, MSN and Microsoft 365** it is **Sign in with Microsoft**: Zelos shows a
short code, you type it at microsoft.com in a browser you already trust, and it
connects. Microsoft no longer accepts passwords of any kind from a mail app on
personal accounts, so there this is the only door. Both sign-ins are built and
wired, but the registrations they run against are not shipped yet, so today
each needs a one-time registration of your own before its button works — the
app walks you through the Microsoft one, about ten minutes at Microsoft's
website, and steers Gmail to the app-password path below, which needs no wait.
[OAUTH.md](OAUTH.md) has what each sign-in sends where and what shipping the
registrations takes.

For **everyone else** — and for Gmail too, if you prefer it — the button is
**Get an app password**, which opens the exact page on your provider's site
where you create one: a long generated password that works only for mail apps
and that you can revoke on its own without changing anything else. Copy it,
paste it into Zelos, and press **Connect**: Zelos tests the connection, finds
your sent folder, and saves the account in one go. If the server refuses, Zelos
repeats what it said, and **Advanced** opens the full form with everything
filled in. Proton addresses go to the full form, because Proton Bridge supplies
its own host, port and password.

The rest of this section is the long way — the same settings, entered by hand
under **Advanced** — and what each provider's app-password page asks for.

### Gmail

1. You must have 2-Step Verification turned on. If you don't:
   [myaccount.google.com/security](https://myaccount.google.com/security) →
   **2-Step Verification** → turn it on.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Type a name — `Zelos` — and press **Create**.
4. Google shows you 16 letters in four groups. Copy them. **You cannot see them
   again.**
5. In Zelos: server `imap.gmail.com`, port `993`, SSL on, username your full
   Gmail address, password the 16 letters (spaces don't matter).

To revoke it later, come back to that page and delete the entry. Your account
password is unaffected.

### iCloud

1. Go to [account.apple.com](https://account.apple.com) → **Sign-In and
   Security** → **App-Specific Passwords**.
2. Press **+**, name it `Zelos`, confirm with your Apple Account password.
3. Copy the password Apple shows you. **You cannot see it again.**
4. In Zelos: server `imap.mail.me.com`, port `993`, SSL on, username your full
   iCloud address (`you@icloud.com`, or `you@me.com` if that's what you sign in
   with), password the generated one.

### Others

| Provider | Server | Port | Note |
| --- | --- | --- | --- |
| Outlook / Hotmail | `outlook.office365.com` | 993 | **Sign in with Microsoft** — a personal account accepts no password of any kind from a mail app any more. A work account may need your IT department to allow IMAP, or to consent to the app. |
| Yahoo | `imap.mail.yahoo.com` | 993 | Account Security → Generate app password. |
| Fastmail | `imap.fastmail.com` | 993 | Settings → Privacy & Security → App passwords, with the **Mail (IMAP)** scope. |
| Proton | `127.0.0.1` | 1143 | Proton encrypts mail on their servers, so IMAP only works through **Proton Bridge** running on your machine. Use the host, port and password Bridge shows you — not your Proton password. |
| Anything else | ask your provider for "IMAP settings" | usually 993 | |

Zelos guesses the server from your email address, so usually you type your
address and the app password and press **Connect** — or, under **Advanced**,
**Test the connection** and then **Save account**.

**About encryption, since one row above turns it off.** Every account has a
*Require encryption* setting, and left alone it does the right thing: anything
that is not on your own machine has to end up encrypted before your password is
sent, so a server that will not do it is refused rather than fallen back from.
That matters because the fallback is silent — a network able to strip the
upgrade offer would otherwise be handed your password in plain text. The one
account that legitimately runs unencrypted is Proton Bridge, because it lives
on `127.0.0.1` and the traffic never leaves your machine; that is why it is a
setting and not a rule.

**How much it reads.** By default, the last 14 days of `INBOX`, up to 400
messages. Both are settings. Reading your sent mail as well is what lets Zelos
tell "they owe me" from "I owe them", so it's worth turning on: **Settings →
Mail → Sent folder**, prefilled from whatever your server flags with IMAP
`SPECIAL-USE` when you press **Test**, and editable if it guessed wrong (Gmail
calls it `[Gmail]/Sent Mail`, some servers `Sent Items`).

---

## Connecting a calendar

Three kinds, in order of how common they are:

**A subscription link (`.ics`)** — the usual choice, and read-only by nature.

- *Google Calendar*: Settings → click the calendar under "Settings for my
  calendars" → **Integrate calendar** → copy **Secret address in iCal format**.
  It is secret: anyone with that link can read that calendar. Treat it like a
  password.
- *Apple Calendar (iCloud)*: iCloud.com → Calendar → the broadcast icon next to
  a calendar → **Public Calendar** → copy the link. It'll start `webcal://`;
  paste it as-is, Zelos handles that.
- *Outlook.com*: Settings → Calendar → Shared calendars → Publish a calendar →
  choose **ICS**.

**CalDAV** — for iCloud, Fastmail or Nextcloud with your own credentials. Paste
the server address and your username; the password goes in the same way a mail
password does. For iCloud, use an app-specific password here too.

> **If Zelos says a host asked for a password and it is not the host you
> typed**, that is the pin working, not a bug — and the fix is one paste.
> Zelos will not send your calendar password to a host it was merely *pointed
> at* by another host's answer, and iCloud in particular partitions accounts
> across per-user servers (`p43-caldav.icloud.com` and the like), so discovery
> from the generic address routinely lands on one. Put the address Zelos names
> in the error straight into the calendar URL, and it will authenticate to the
> host you typed. The error message says this too; it is here because
> `caldav.icloud.com` does not work for every account and it used to look like
> a wrong password.

**A file on this computer** — point Zelos at an `.ics` file and it will read
it. Useful for exports and for calendars that only publish downloads.

---

## Connecting everything else

Mail and calendar are the two Zelos needs. Beyond them it can read nine more
things, all of them from **Settings → Sources**:

| | |
| --- | --- |
| **GitHub** | What needs you — assignments, review requests, mentions |
| **Slack** | Your conversations, with a token you mint in your own workspace |
| **Fireflies** | Meeting recaps, with the action items |
| **Linear** | The issues assigned to you that are due |
| **Todoist** | Tasks due today or overdue |
| **A feed** | Any RSS or Atom address |
| **iPhone texts** | Text already synced to Messages on this Mac, with your permission |
| **A folder** | Anything a script drops into a directory on this machine |
| **A WhatsApp export** | A chat you exported yourself |

Every one of them is a credential **you** mint in your own account, or a file on
your own disk. For these additional sources, Zelos publishes no OAuth app — no client id, no
consent screen, no "Connect with…" button. The two built for mail — Google and
Microsoft sign-in, [OAUTH.md](OAUTH.md), whose own registrations are not
shipped yet — need no server either: the Google one comes back to the Zelos
port on `127.0.0.1`, and the Microsoft one is a code you type. All of them are read-only, and that is enforced by the shape of
the interface rather than by convention.

**[SOURCES.md](SOURCES.md)** is the page for these: one section each, with where
you mint the credential, what scopes it needs, what it costs, what it
deliberately does not do, and where it stops. Two things worth knowing before
you go looking for them:

- **The watched folder is the answer to "webhook".** Zelos opens no inbound
  port, so a webhook is impossible rather than missing — and a directory anything
  can write into buys the same thing with no public URL and no token to leak.
- **The WhatsApp source is an archive, not a connection.** It shows nothing new
  until you export the chat again.
- **iPhone texts come from the Mac's Messages app.** Sign in with the same Apple
  Account, make sure the texts are already on the Mac, and grant the installed
  Zelos app Full Disk Access yourself. It imports text only, with no sending,
  attachments, calls or voicemail. See the [Messages setup guide](SOURCES.md#iphone-texts-from-messages-on-this-mac).

**Read sources now** in Sources imports all enabled connections without asking
AI. Keep automatic checks off in **Settings → Schedule** for local-only import.
**Check now**, a full review, automatic checks, or a question to the AI can use
the imported text with your configured AI. Saving a source changes neither the
schedule nor the AI settings.

And one whole category needs no source at all. **[NOTETAKERS.md](NOTETAKERS.md)**
covers the AI notetakers — Fireflies, Otter, Grain, Fathom, tl;dv, Read.ai,
Circleback and Granola. Seven of the eight email you a structured recap when a
meeting ends, and Zelos already reads your mail: turn the setting on, scope it to
yourself, and the action items you agreed to out loud arrive on the board with no
key and no API. That page says, per vendor, which setting produces the mail and
how to aim it at yourself only.

---

## Where your data lives

Everything is in one folder: **`~/.zelos`** — that's
`/Users/you/.zelos` on macOS, `/home/you/.zelos` on Linux,
`C:\Users\you\.zelos` on Windows. (Use `--home` to put it somewhere else.)

On macOS and Linux that folder is created readable by you and nobody else. **On
Windows it is not, and the difference is worth one sentence:** Windows has no
POSIX file modes, so what guards the folder there is the NTFS ACL your user
profile already carries, which also lets Administrators read it.
[SECURITY.md § 5](SECURITY.md#5-what-leaves-your-machine) states that exactly,
and is the only place it is stated.

| File | What's in it |
| --- | --- |
| `zelos.db` | The database: your messages, calendar events, the board, drafts, notes and the run history. This is the whole app's memory. |
| `config.json` | Your settings — servers, addresses, preferences. **Never any password or key.** Only short names like `"mail.m_9f3a1c"` that point at the keychain. |
| `logs/` | Created on every launch, but **only the desktop app writes to it**, and the file it writes is `desktop.log`. Run Zelos from a terminal and the log is the terminal. Passwords and keys are stripped before anything is written, by key name and by shape. |
| `cache/` | Scratch space. Safe to delete at any time. |
| `window.json` | Desktop app only: window size and position. |
| `secrets.enc`, `.seed` | Present when this home is on the encrypted-file backend — see below. `.seed` holds the key that decrypts `secrets.enc`, in the same folder. |
| `secrets.backend.json` | Which secret store this home committed to, the first time it stored one. Zelos keeps using that store afterwards even if a keychain later appears, because moving would orphan the secrets already written. |
| `secrets.namespace.json`, `secrets.index.json`, `secrets.migrated/` | OS credential identity, known names, and upgrade markers; never key values. Keep them with a backup or a moved home. A new empty `--home` gets an independent identity; copying the entire folder copies its existing identity. |
| `.seed.unreadable-<ts>`, `secrets.enc.unreadable-<ts>` | Only after damage: a seed or store Zelos could not read is renamed aside as a matched pair sharing one timestamp, rather than overwritten. To recover, put the 64 hex characters back in `.seed`, rename the store back to `secrets.enc`, and the secrets read again. |

**Your passwords and API keys are not in that folder** — **unless this home is
on the encrypted-file fallback, in which case they are, and so is the key that
opens them.** That case is not exotic: any machine without a working keychain
lands there, and a home that fell back once stays there. Check which one you
are on in **Settings → About**, with `zelos doctor`, or by looking for
`secrets.enc` in the folder. When there is a keychain, they're in it: 

- **macOS** — the login Keychain. Open *Keychain Access* and search for
  `com.zelos.app` to see them listed. You can delete them from there.
- **Windows** — encrypted with DPAPI so only your Windows account can read them,
  under `%LOCALAPPDATA%\Zelos\secrets`.
- **Linux** — your desktop keyring, if `secret-tool` is installed.
- **No keychain available** — an encrypted file, `secrets.enc`, in the Zelos
  folder. Zelos will tell you, in the app, exactly what that does and doesn't
  protect you from. Short version: it protects a stolen backup; it does not
  protect you from another program running under your own user account.

---

## Taking your data out, or deleting all of it

**To back it up or move it to another computer**, quit Zelos and copy the
whole `~/.zelos` folder. That's the complete state. On the new machine, put it
in the same place and enter your passwords again (keychain entries deliberately
don't travel).

**To read the data with something else**, `zelos.db` is a plain
[SQLite](https://sqlite.org) file — the most widely supported database format in
the world. Any SQLite browser will open it. To pull everything out as JSON with
no extra software:

```
sqlite3 -json ~/.zelos/zelos.db "SELECT * FROM messages"  > messages.json
sqlite3 -json ~/.zelos/zelos.db "SELECT * FROM events"    > events.json
sqlite3 -json ~/.zelos/zelos.db "SELECT * FROM items"     > board.json
sqlite3 -json ~/.zelos/zelos.db "SELECT * FROM drafts"    > drafts.json
```

(`sqlite3` is already on macOS and most Linux systems.)

**To delete everything**, quit Zelos and:

```
rm -rf ~/.zelos
```

On Windows, delete the `.zelos` folder in your user folder, and the
`Zelos` folder inside `%LOCALAPPDATA%`.

That removes the database, the settings and the logs. **Whether it also removes
the passwords depends on which secret store this home was on** — if there was
no keychain, `secrets.enc` and `.seed` were in that folder and are now gone
with it, and you are done. If there was a keychain, the passwords are still in
it. Remove those too:

- **macOS** — open *Keychain Access*, search for `com.zelos.app`, and delete
  every entry it finds.
- **Linux** — open *Passwords and Keys* (Seahorse) and delete the Zelos
  entries, or run `secret-tool clear service com.zelos.app account <name>`.
- **Windows** — deleting the `Zelos` folder in `%LOCALAPPDATA%` is enough;
  that's where the encrypted blobs live.

Doing it in that order costs you the ability to check: once `~/.zelos` is gone
so is `secrets.backend.json`, which is the file that would have told you which
case you were in. Look before you delete, or just do both.

If Zelos is still running, you can do this the easy way instead: in Settings,
each stored password and key has a **Forget** control beside it that removes it
from the keychain. Use those first, then delete the folder.

Nothing is left anywhere else. There is no server-side copy, because there is no
server.

---

## Checking Zelos's network requests

Don't take the promise on trust. Here are four checks, from easiest to most
convincing.

### 1. Inspect the dependencies

`package.json` declares two pinned runtime dependencies: Nodemailer 10.0.9 for
reviewed SMTP replies and PDFKit 0.19.1 for local PDF reports. `package-lock.json`
records their transitive packages and integrity hashes. The import audit permits
Nodemailer only in `core/mail-send.mjs`, PDFKit only in `core/progress.mjs`, and
specific offline tests. A dependency list is part of the audit, not proof that a
package cannot open a connection.

The desktop shell separately uses Electron and electron-builder. Those build
and run the window; they are not imports of the core application or browser UI.
The document importer also invokes installed Poppler and Tesseract binaries,
as described below. Reports use bundled fonts, and the UI loads its scripts,
styles, icons and fonts locally.

### 2. Count the places it *could* phone home

Start with the built-in fetch calls and direct IMAP socket sites. This first
pass does not include SMTP inside Nodemailer, public-web HTTP requests, or DNS;
the second pass accounts for those. In the `zelos` folder:

```
grep -rn "fetch\s*(\|globalThis\.fetch\|tls\.connect\|net\.connect" core/ zelos.mjs
```

The escaped dots avoid matching unrelated prose. `globalThis\.fetch` includes
the shared connector transport and injected fetch implementations, which a
search for `fetch(` alone misses. Aliases can hide a primitive's later call, so
also inspect `grep -rnw fetch core/ zelos.mjs` and follow the imports rather
than treating a grep count as proof of completeness.

The command above returns **24 lines** today. Eleven are discarded:

- **Comments.** Eight of the 24 lines are prose in comments.
- **Zelos's own IMAP object.** Three lines use `async fetch(` or `client.fetch(`
  for an IMAP command on a socket that is already open.

The remaining **thirteen outbound entries** are connection calls or fetch
implementation selections. The table names their owning functions; the first
row contains two socket-opening alternatives. Counts describe code locations,
not how often requests happen.

| Where | Function | What it connects to |
| --- | --- | --- |
| `core/sources/imap.mjs` | `#openSocket` | Your configured mail server: TLS, or a plain socket that must meet the account's STARTTLS policy before authentication |
| `core/sources/imap.mjs` | `#startTls` | The same mail socket, upgraded to TLS |
| `core/sources/imap.mjs` | `postForm` | `login.microsoftonline.com` for Microsoft sign-in and token refresh |
| `core/sources/caldav.mjs` | `request` | Your configured CalDAV calendar |
| `core/connectors/ics.mjs` | `fetchIcsText` | Your configured `.ics` feed |
| `core/server.mjs` | `fetchIcsOnce` | The calendar address entered for a connection test |
| `core/llm.mjs` | `requestWithRetry` | The selected model endpoint; local model endpoints keep inference on your machine |
| `core/doctor.mjs` | `DEFAULT_DEPS.fetchImpl` | Your configured model and calendar endpoints during diagnostics |
| `core/connectors/http.mjs` | `createHttp` | Source origins declared by each connector, widened only by its configured address fields |
| `core/sources/oauth.mjs` | `postForm` | `oauth2.googleapis.com` for Google sign-in and token refresh |
| `core/updates.mjs` | `createUpdateChecker` | `api.github.com` only for an explicit update check, without account content or credentials |
| `core/shopping.mjs` | `requestProvider` | `connect.instacart.com`, or the explicitly selected development endpoint `connect.dev.instacart.tools`; retailer lookup sends a postal/country code, and an explicitly approved hosted list sends selected grocery names and quantities. Redirects are refused. Creating a list does not place an order |

`test/repo.test.mjs` runs this recipe and compares the counts and table with
the tree. Its connector audit separately refuses network primitives outside
the shared `ctx.http` transport.

Check the other network and process entry points too:

```
grep -rn "http\.request\|https\.request\|transport\.request\|node:http\|node:dgram\|node:http2\|node:dns\|child_process\|createTransport" core/ zelos.mjs
```

**Fifteen lines come back.** They account for:

- `core/family-guest.mjs` creates the separate loopback family HTTP listener; its `node:net` import validates client address syntax and does not open a connection.

- Four lines in `core/web-research.mjs`: the HTTP and HTTPS imports, public DNS
  lookup, and `(deps.request || transport.request)` in `pinnedRequest`. A public
  page lookup sends the requested URL to its host; keyed web search sends the
  search query to the fixed Brave endpoint
  `https://api.search.brave.com/res/v1/web/search`. The module reads no mail,
  calendar, health records, browser cookies or history. Every resolved address
  must be public, and one validated address is pinned into each request's
  lookup while TLS hostname verification remains enabled. A dedicated agent
  ignores ambient proxy settings. Page reads allow at most three revalidated
  redirects and no HTTPS downgrade; Brave allows no redirect and receives its
  key only at its exact endpoint. The total deadline is 15 seconds, with 1 MB
  caps on both transferred and decompressed content. Linked resources and
  search-result pages are not fetched automatically.
- `core/mail-send.mjs` constructs the pinned Nodemailer SMTP transport. Only the
  reviewed mail workspace can call it, with the frozen sender, recipient,
  subject and body approved by the user. URL fetching, arbitrary attachments,
  file reads and caller-selected transport endpoints are disabled.
- `core/sources/imap.mjs` uses the system resolver for MX and SRV discovery
  during mailbox setup. The typed domain, not the full email address, is sent.
- Three local HTTP listeners: `core/server.mjs`, `core/sources/oauth.mjs` and
  `core/booking-guest.mjs`. Their HTTP imports serve requests; they do not
  establish an outbound connection. A `node:dns` comment in `core/server.mjs`
  is the remaining prose match.
- Four native-process imports: `core/secrets.mjs` runs the keychain helper,
  `zelos.mjs` opens the browser, and `core/documents.mjs` runs only `pdfinfo`,
  `pdftotext`, `pdftoppm` or `tesseract` on generated private temporary files.
  Document commands use `execFile` with `shell:false`, bounded time/output and
  cleanup on failure or cancellation. Uploaded filenames and model text do
  not become executable names or shell commands.
  `core/codex-subscription.mjs` launches the installed official Codex app-server
  directly, without a shell, for the optional ChatGPT subscription connection.
  It uses a separate credential home, filters inherited environment variables,
  and requires an ephemeral text-only session with tools, workspace access,
  plugins, MCP servers and web search disabled. The CLI owns OpenAI sign-in and
  its network requests; selected mail/calendar/board context leaves the machine
  when this cloud option is used. API keys are never used as a fallback.
  See [AI subscriptions](AI-SUBSCRIPTIONS.md) for credential storage, plan limits,
  and the separate Claude Desktop sharing option.

The second recipe includes `transport.request` and `node:http` because the web
reader aliases the selected HTTP(S) module. Searching only `http.request` and
`https.request` would miss that call. The tests pin its owning file, the SMTP
entry point and both DNS import locations. Native binaries and dependency
internals still need inspection when their versions or configuration change.

Opening the fixed WHO, CDC, FDA, Instacart-help, Brave-key or official release links is
browser navigation after a click. Those URLs are not remote fonts, scripts,
images or automatic page loads. The UI audits exempt exact declarations and
anchors, not entire domains, and test that Health citations use the fixed URL
allowlist. An Instacart result link is provided only after a reviewed list was
created and its provider URL passed server validation.

For possible analytics code, inspect the matches rather than assuming every
word is a request:

```
grep -rni "analytics\|telemetry\|sentry\|posthog\|mixpanel\|gtag\|amplitude" core/ ui/ zelos.mjs
```

The current application has no analytics endpoint or third-party browser
script. Function names such as `findClosingTag` and privacy copy can appear in
this search; the network entry-point audit above is the check for actual traffic.

### 3. Watch the connections yourself

With Zelos running, in another terminal:

- **macOS / Linux:**
  ```
  lsof -nP -iTCP -sTCP:ESTABLISHED -c node
  ```
- **Windows (PowerShell):**
  ```
  Get-NetTCPConnection -State Established | Where-Object OwningProcess -in (Get-Process node).Id
  ```

Press **Check now** in Zelos and run it again. You should see three kinds of
connection by default and no others: **your mail server**, **your calendar
host**, and **the model address you chose** — plus one host for each source you
have added in Settings → Sources, which is also an address you chose:
`api.github.com` if you added GitHub, the feed's own host if you added a feed.
Each connector names its host (`origins` in `core/connectors/*.mjs`) and the
transport they share refuses any other. If you picked a local model, the model
one is `127.0.0.1` — your own machine.

For a continuous view, macOS users can use [Little Snitch](https://obdev.at) or
LuLu, which will show you every connection attempt as it happens and let you
block anything you didn't expect. There will not be anything you didn't expect.

### 4. Pull the plug

The strongest test, and the shortest:

1. Set Zelos up with a **local** model (Ollama or LM Studio).
2. Run one sweep so it has your mail.
3. **Turn off your Wi-Fi.**
4. Use Zelos. The board still works. Ask questions on the Ask page; you'll get
   real, streamed answers about your archived mail from the local model. Viewing
   your stored board and asking that local model still work with the network
   disconnected. Online source refreshes and update checks need a network connection.

For the full technical account — what the model actually receives, what happens
to a malicious email that tries to give the model instructions, and an honest
list of what Zelos does *not* protect you from — read
[SECURITY.md](SECURITY.md). It is written to be read, not to reassure.

---

## When something goes wrong

**"The page loads but nothing works / everything says unauthorized."**
You're using an old link. Every launch mints a new key. Copy the current `Open`
line from the terminal, `?t=…` and all.

**The browser didn't open.** Copy the link by hand, or use `--no-open` and stop
expecting it to.

**"Port already in use."** It isn't — Zelos walks up until it finds a free
port and prints the one it took. Check the URL in the banner; it may be 7778.

**Mail sign-in fails.** Nine times in ten this is the app password. Your normal
password will not work for Gmail, iCloud or Yahoo. See [Connecting your
mail](#connecting-your-mail). Zelos shows you the server's own words for why
it refused, which is usually specific enough to act on. If you signed in with
Google or Microsoft instead, the usual cause is a sign-in that expired or was
revoked — Settings → Mail says so and offers **Connect again**. A Google sign-in
made while Zelos is still in Google's testing tier expires every seven days;
that is Google's rule, not a fault.

**The model test fails.** The error names the address it tried. If that address
is `127.0.0.1`, your local model isn't running — start Ollama, or press Start
Server in LM Studio. If it's a provider's address, the key is wrong or has no
credit.

**The board is empty after a sweep.** Check Settings → Mail says how many
messages it read. If it's zero, widen the lookback window or check you selected
the right mailbox. If it read messages but produced nothing, your model is
likely too small to follow the format — try a larger one.

**It feels slow.** A full sweep re-reads your mail and asks the model; a light
sweep just refreshes what's on screen. Both happen on the schedule. A local
model on a laptop can take a minute or two, and that's the model thinking, not
Zelos stalling — the progress line tells you which phase it's in.

**Something else.** Where the record is depends on how you launched Zelos, and
**there is no `zelos.log`** — the name this page used to print does not exist
and never has.

- **From a terminal** (`node zelos.mjs`, `zelos`, `zelos sweep`, `zelos
  doctor`): the log is that terminal. Nothing is written to disk, so an empty
  `~/.zelos/logs/` is correct rather than a fault. Redirect it if you want to
  keep it: `zelos sweep 2> sweep.log`. Note that `ZELOS_LOG_LEVEL=debug` buys
  you **nothing** here — `debug` lines are written to the log *file* and
  deliberately not to the terminal, and the CLI has no file, so they go
  nowhere. Debug logging is a desktop-app facility only.
- **The desktop app**, which has no terminal to write to: `~/.zelos/logs/desktop.log`,
  one JSON object per line. **Board → Show logs** opens the folder.

Credentials are stripped either way — by key name and by value shape, in
`core/log.mjs`, on every line before it goes anywhere.

---

## Where things are, if you want to look

```
zelos.mjs          the launcher — subcommands, flags, banner, the browser
core/
  server.mjs         the local web server and its security model
  db.mjs             the database and every query
  config.mjs         settings, and the rule that no secret is ever written to them
  secrets.mjs        the only place a password is allowed to exist
  llm.mjs            talking to models — both protocols, every provider
  safety.mjs         treating mail as hostile
  triage.mjs         what gets asked, and how the answer is checked
  sweep.mjs          the loop: fetch, think, update, schedule
  mcp.mjs            the tools an AI client can call, and their audit log
  ai-access.mjs      AI tokens, scopes, and the gate in front of them
  doctor.mjs         every check `zelos doctor` runs
  sample-data.mjs    the demo board, and the manifest that removes it exactly
  home-lock.mjs      one Zelos per data folder, and a warning when there are two
  log.mjs, time.mjs  redacted logging; zone-aware clock arithmetic
  sources/           imap.mjs, mime.mjs, ics.mjs, caldav.mjs, oauth.mjs
  connectors/        one file per source, plus the registry and the one way out
ui/                  the page you look at — plain HTML, CSS and JavaScript
desktop/             the Electron shell — a window and a tray, nothing more
test/                the tests; run them with `node --test "test/*.test.mjs"`
docs/                SPEC.md (what it must do), SECURITY.md (what it defends),
                     SOURCES.md (the eight sources), NOTETAKERS.md (the category
                     that needs none)
```

Two notes on that list. `core/sources/oauth.mjs` is the Google sign-in — PKCE,
the callback on the Zelos port, the code exchange and the refresh, with the
grant filed in the keychain; its calendar scopes are still wired to no reader.
The Microsoft *mail* sign-in is a device-code flow in
`core/sources/imap.mjs` § 6. Both are reached from **Settings → Mail → Add a
mailbox** and run against the client ids Zelos ships; [OAUTH.md](OAUTH.md) has
the registrations and the review behind them. And `desktop/` is
the only directory with a `node_modules`: Electron and electron-builder, both
`devDependencies` of the shell, neither reaching the core.

Every file is meant to be read. If a comment explains *what* the code does
rather than *why*, that's a bug in the comment.
