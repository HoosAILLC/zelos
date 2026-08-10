# Zelos

**A local-first second brain.** It reads your mail and your calendar, works out what actually
needs you, and hands you one page: what needs you now, what you owe, what owes you, what is coming.

It runs on your own machine, stores everything in one directory you control, and thinks with
whatever model you choose — including one running on your own desk.

→ **[zelos-app.netlify.app](https://zelos-app.netlify.app)** · [live demo](https://zelos-app.netlify.app/demo/) · MIT

---

## Zero dependencies

Not "few" — zero. There is no `dependencies` block, no `node_modules`, no postinstall script,
nothing to audit but the code itself.

That is not asceticism. It is the product's central claim: an app that reads your mail should not
ask you to trust a supply chain you cannot see. Everything is Node built-ins — `node:sqlite`
(with FTS5 compiled in), `node:tls`, `node:http`, `node:crypto`, `node:test`, and global `fetch`.

The consequence is that the IMAP client, the MIME and RFC 2047 decoders, the RFC 5545 parser with
RRULE expansion, the CalDAV client and the model adapter are all written here, from the RFCs.
About 23,000 lines, and a test suite that is a substantial fraction of it.

## Run it

```bash
node zelos.mjs
```

Node **22.16+ or 24+**. Not "22 or newer": Zelos's index needs SQLite's FTS5 extension, and Node's
bundled SQLite is built without it before 22.16 and throughout the whole Node 23 line. On a runtime
that lacks it, Zelos refuses to start and names the versions that work.

It opens in your browser at `127.0.0.1` and stays there. Nothing to install, no account, no server.

```bash
zelos              # run it — this is the one you want
zelos sweep        # read your sources once, think, print what changed, stop
zelos doctor       # check every part of the setup and say what to do about what is wrong
zelos mcp          # serve read-only MCP tools so another AI client can read your board
```

## What leaves your machine

Exactly three things, and you chose all three: your mail provider, your calendar address, and your
model endpoint. Point it at a local model and that becomes none. No telemetry, no analytics, no
update pings, no crash reports.

Your keys live in your operating system's keychain. On macOS and Linux the database is `0600` inside
a `0700` home; on Windows there are no POSIX modes to set, so the protection is the ACL on your user
profile — see [docs/SECURITY.md](docs/SECURITY.md#5-what-leaves-your-machine) for what that does and
does not buy you.
The local server binds `127.0.0.1` only, mints a new session token every launch, requires it on
every `/api/*` request, and rejects foreign origins.

**One thing said plainly:** your mail is written by other people, so a message can contain text
aimed at the model. Zelos never acts on what the model says — it renders, and you click. That is a
stronger guarantee than claiming a model cannot be fooled. See [docs/SECURITY.md](docs/SECURITY.md).

## Any model

Two wire protocols (`openai` and `anthropic`) cover every hosted provider and every local runtime.
Settings probes the usual local ports — Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000 —
and offers whatever is already running before it offers you a paid one.

## Tests

```bash
node --test test/*.test.mjs
```

Including an adversarial security suite: exploit tests for credential leaks, path traversal, DNS
rebinding, FTS injection, token forgery and MCP scope escapes.

## Docs

| | |
|---|---|
| [docs/README.md](docs/README.md) | the long version |
| [docs/INSTALL.md](docs/INSTALL.md) | installing, including the unsigned-app dance |
| [docs/SECURITY.md](docs/SECURITY.md) | the threat model, stated honestly |
| [docs/SPEC.md](docs/SPEC.md) · [docs/SPEC-v2.md](docs/SPEC-v2.md) | what it is meant to do |
| [docs/OAUTH.md](docs/OAUTH.md) | why there is no "Sign in with Google" button yet |

## Licence

MIT.
