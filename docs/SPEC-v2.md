# Zelos v2 — integration contract for the AI-access, packaging and onboarding work

Read `docs/SPEC.md` first; it still governs. Everything here is additive. The v1 constraints hold
without exception — **zero third-party runtime dependencies**, ESM, `127.0.0.1` only, secrets never
in argv or logs, and the app never acts on model output.

---

## 1. Zelos as a knowledge source for someone else's AI

The ask: *"use this as a master knowledge source for their AI, set up an API directly with it, and
select what data comes and goes from that API."*

That is **MCP** — the protocol every current AI client speaks. Zelos becomes a server their
assistant connects to, exposing the mail, calendar and board it has already indexed.

### The governing principle

**Off by default, and scoped by the user, forever.** Zelos exists because people don't want their
mail on someone else's computer. An AI-access feature that is loose by default would betray the
entire product. So:

- The master switch starts **off**. Nothing is exposed until a human turns it on.
- Every scope is **individually** toggled. Turning on "calendar" must not turn on "mail bodies".
- The panel states, in plain words, what each scope actually hands over.
- Access needs a token the user mints, can name, can see the last-used time of, and can revoke.
- Every MCP call is logged locally with the tool, the scope, and how many rows it returned, and
  that log is visible in the UI. Someone must be able to answer "what did my AI read?"

### `core/mcp.mjs` — the server

Implement MCP over **JSON-RPC 2.0**, both transports:
- **stdio** — `zelos mcp` runs a server on stdin/stdout. This is what desktop AI clients spawn.
- **HTTP** — `POST /api/mcp` on the existing local server, token-gated, for clients that prefer it.

```js
export const SCOPES        // the closed set, see below
export function toolsFor(scopes)                  // -> MCP tool descriptors the scopes allow
export async function handle(request, ctx)        // -> JSON-RPC response
export function createStdioServer({ db, config, logger })
export async function serveStdio(opts)            // runs until stdin closes
```

Implement at least `initialize`, `tools/list`, `tools/call`, and `ping`. Unknown methods get a
proper JSON-RPC error, never a crash.

### Scopes — a closed set, stored in `config.ai.scopes`

| scope | tool(s) | what it actually hands over |
|---|---|---|
| `board` | `zelos_board`, `zelos_item` | the triaged items: headline, why, bucket, due, person |
| `calendar` | `zelos_calendar` | events in a window: title, time, location, attendees |
| `mail.metadata` | `zelos_search`, `zelos_thread` | sender, subject, date, snippet — **no body** |
| `mail.bodies` | upgrades the above | full message text. Implies `mail.metadata`. |
| `drafts` | `zelos_drafts` | drafts Zelos has written |
| `people` | `zelos_people` | who you correspond with, and how recently |

`mail.bodies` is the one that matters. It must be **off** unless explicitly enabled, must be
visibly marked as the most exposing choice, and enabling it must not be a side effect of anything.

Config shape:
```jsonc
"ai": {
  "enabled": false,
  "scopes": { "board": true, "calendar": true, "mail.metadata": false,
              "mail.bodies": false, "drafts": false, "people": false },
  "tokens": [{ "id": "t_x", "label": "Claude Desktop", "ref": "ai.t_x",
               "createdAt": "…", "lastUsedAt": null }],
  "maxRows": 50
}
```
Token *values* live in the secret store like every other credential — `config.json` holds refs.

**Never expose a tool that writes.** No send, no delete, no config change. This surface is
read-only, and that is a security property, not an oversight.

### `ui/views/settings.js` — an "AI access" panel

New panel between Privacy and Data. It must contain: the master switch; one row per scope with an
honest one-line description; token minting (show the value **once**, at creation, because it can
never be read back); a revoke button; the recent-access log; and a copy-paste config block for
Claude Desktop / a generic MCP client with the real path filled in.

---

## 2. `npx zelos-app`

The npm name `zelos` is taken; **`zelos-app` is registered to us**. Publishing is the operator's
call — prepare it, do not publish.

- `package.json`: `name: "zelos-app"`, `bin: { "zelos": "./zelos.mjs" }`, `files` allowlisting
  exactly what ships, `engines.node >= 22.5.0`, and **still no dependencies**.
- `npx zelos-app` must start the app. `npm i -g zelos-app && zelos` must work too.
- Subcommands, parsed in `zelos.mjs`: bare (run), `mcp` (stdio MCP), `sweep` (one sweep, print a
  summary, exit), `doctor` (check Node version, home dir perms, model reachability, source
  connectivity — and print what is wrong in words a non-programmer can act on).
- `npm pack` must produce a tarball that runs from a clean extract. Verify that, don't assume it.

---

## 3. OAuth, built but not enabled

Researched and settled — do not re-litigate:

- **Google Calendar** read is a **sensitive** scope: verification only (~10 days, demo video,
  privacy policy, verified domain). **No CASA, no annual audit, no fee.** Genuinely achievable.
- **Gmail** read is a **restricted** scope: CASA Tier 2, ~$540–1,000, re-assessed annually,
  4–12 weeks. A real commitment, not a paperwork step.
- **Microsoft** needs a multi-tenant Entra app plus publisher verification (Partner One ID +
  verified domain). No CASA equivalent.

So: build `core/sources/oauth.mjs` implementing **OAuth 2.0 + PKCE with a loopback redirect** —
the correct flow for a desktop app, and the one that needs no client secret. Wire Google Calendar
and Microsoft Graph Calendar behind a config flag, with the client id blank by default and a clear
note in Settings that it stays inert until an app registration exists. Refresh tokens go in the
secret store. **Do not wire Gmail.** IMAP stays the supported mail path.

---

## 4. Onboarding

Cut the first run to the shortest honest path.

- **One screen to a usable app.** Detect a local model and offer it as one click; if none is
  running, the top choice is still "skip and look around", not a form.
- `zelos doctor` output should be reachable from the UI when something is wrong.
- The app-password step is where people fall off. Give the exact per-provider link, say plainly
  that the normal password will not work and why, and validate the connection before moving on.
- A **"Try it with sample data"** button that loads the demo dataset into a scratch home, so
  someone can see the board before connecting anything. It must be obvious that it is sample data
  and one click to clear.

## 5. Tests

Everything above ships with tests in `test/`, run with `node --test "test/*.test.mjs"`.
Required: scope enforcement (a disabled scope's tool is absent from `tools/list` **and** refused by
`tools/call`); `mail.bodies` off means no body text in any response; token auth required and
revocation effective; no write-capable tool exists; JSON-RPC error shapes; `npm pack` extract runs;
`doctor` exits non-zero when something is genuinely wrong.
