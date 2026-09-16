# Use an AI subscription with Zelos

Zelos offers two different ways to use an AI account you already have. Choose
ChatGPT to power supported AI features inside Zelos, or connect Claude Desktop
to discuss selected Zelos records in Claude. API keys and local models remain
available.

ChatGPT sign-in is available in the latest **1.8.4 preview source**, not the
published **1.8.1 installers**. The website preview shows the setup choices but
cannot connect accounts or make live AI requests.

| Connection | Where you use it | What pays for the AI |
| --- | --- | --- |
| ChatGPT | Supported AI features in Zelos | Your account's Codex allowance |
| Claude Desktop | Conversations in Claude Desktop using selected Zelos records | Your Claude plan and its usage limits |
| API key | Supported AI features in Zelos | Your provider's separate API billing |
| Local model | Zelos, including features that require local inference | Your own computer or configured local runtime |

## ChatGPT in Zelos

1. Install the official **Codex CLI** on the same computer that runs Zelos.
   Follow OpenAI's [installation instructions](https://learn.chatgpt.com/docs/cli)
   for macOS or Windows. The ChatGPT website alone does not install the CLI.
2. Open **Settings → AI → Your ChatGPT subscription** in Zelos.
3. Choose **Sign in with ChatGPT**, then **Continue to OpenAI**. Finish on
   OpenAI's page using the account with the Codex access you want Zelos to use.
4. Return to Zelos and choose **Use ChatGPT subscription** to save it.
   **Check a reply** is optional and uses some of your plan allowance.

Zelos uses the installed CLI's app-server connection. OpenAI's own sign-in
handles the password, tokens, and refresh; Zelos does not ask you to paste a
ChatGPT password, browser cookie, session token, or API key.
[OpenAI documents this managed sign-in flow](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

Your account must have Codex access. Available models, limits, and workspace
restrictions are determined by OpenAI and can change. Zelos shares that
account's Codex allowance with its other Codex use; it does not create a
separate pool or unlimited access. ChatGPT sign-in and API-key billing are
[separate authentication choices](https://learn.chatgpt.com/docs/auth).

When a limit is reached or sign-in expires, Zelos reports the problem. It does
not silently use an API key, purchase credits, or switch providers. You can
wait for access to return, reconnect, or explicitly select another AI in
Settings. Charges or credits you enable directly with OpenAI remain governed
by your account settings.

### Your records and sign-in

ChatGPT mode is cloud inference, even though the CLI runs on your computer.
Selected prompts and supporting records go to OpenAI. Existing body-sharing
settings and feature-specific privacy checks still apply. The connection does
not import your ChatGPT conversation history into Zelos.

The CLI uses a separate sign-in area under the Zelos data home. It does not
reuse or replace your normal Codex home. The CLI stores credentials as a
plain JSON file at `<ZELOS_HOME>/chatgpt-subscription/codex/auth.json`; its
containing directories use owner-only permissions on macOS and Linux, and
Windows relies on your user-profile access controls. This is not Zelos's
encrypted API-key store. Credentials are kept out of Zelos's
`config.json`, database responses, and ordinary settings exports. Zelos's
guided and automatic backups omit this sign-in area. Restoring a backup does
not transfer your ChatGPT login; sign in on the destination if needed. A
manual copy of the entire Zelos folder can include this private area, so treat
that copy as sensitive.

The process receives the bounded context Zelos prepares for the request. It
does not get a general-purpose shell, file browser, or external account tools
through this connection. Existing Zelos assistant capabilities keep their own
permissions and limits. See [the security model](SECURITY.md).

### If ChatGPT will not connect

- **Codex is not installed:** follow the official installation page, then
  restart Zelos so it can find the new installation.
- **Signed in elsewhere, but Zelos is signed out:** sign in from Zelos. Its
  separate login area intentionally does not copy your normal Codex session.
- **No eligible account or model:** check the account and workspace you used
  to sign in. Zelos cannot grant additional access.
- **Usage limit reached:** wait for the provider's limit to reset or select
  another AI yourself. Repeated reconnects do not reset the allowance.

## Your Claude subscription in Claude Desktop

1. Install Claude Desktop and sign in to your Claude account.
2. In Zelos, open **Settings → Share with another AI**.
3. Turn sharing on and choose the scopes Claude may read. Start with only what
   you need; full email bodies have a separate permission.
4. Open the connection instructions and copy the **Claude Desktop** settings
   for this installation. Merge the `zelos` entry into the existing
   `mcpServers` object in Claude Desktop's configuration; do not replace other
   connections or create a second `mcpServers` key.
5. Restart Claude Desktop and check that Zelos appears among its available
   tools. Ask Claude about the records you enabled.

The configuration file is
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. Use the configuration
Zelos provides: it includes the actual executable and data-home paths for
your installation. The local stdio connection does not require an AI token or
an Anthropic API key. The sharing switch and selected scopes still apply.
Anthropic explains [local Claude Desktop connections](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

Claude can read the enabled board, calendar, email, drafts, and people data.
This connection does not expose Zelos's health or finance workspaces. It has
no tool for sending messages, deleting records, changing settings, or running
an AI review. Reading the board can wake due snoozes and maintain the normal
four-item Now limit, just as opening Zelos does.

Conversations run in Claude Desktop and follow your Claude plan's limits.
This connection does **not** run Zelos's in-app AI or its automatic reviews.
Turning sharing off stops subsequent reads; it cannot erase information
already returned to a Claude conversation.

Do not paste Zelos's localhost address into a Claude web custom connector.
[Remote connectors connect from Anthropic's cloud](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
which cannot reach this computer's loopback server. Use the local Desktop
configuration above.

### Why there is no Claude subscription sign-in inside Zelos

Anthropic permits users to run its unmodified Claude Code binary with native
authentication, but its current developer documentation also restricts
third-party products offering Claude subscription login or rate limits unless
approved. Zelos does not treat that as permission to turn a Claude login into
a general in-app model endpoint. The supported subscription path here is
Claude Desktop reading the records you grant. See
[Claude Code's authentication conditions](https://code.claude.com/docs/en/legal-and-compliance)
and [the Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk).

## Features that still require a local model

Subscription access changes how eligible AI requests are answered. It does
not change where sensitive features are allowed to run.

- Health planning and AI access to saved health, money, progress, document,
  and library records retain their local-model requirements. Ask and assigned
  work also check retained conversation context before a provider change can
  send those records to a cloud model.
- Document import previews and private email drafting retain their
  local-model checks.
- A subscription does not enable new sending, ordering, payment, or external
  account actions. Those capabilities have their own explicit controls.

If Zelos says a feature needs a local model, choose a supported local runtime
in **Settings → AI**. A cloud model launched through a local CLI is still a
cloud model.

Provider guidance above was checked on **September 15, 2026**. Provider plan
access, terms, and installation instructions may change; the linked official
pages are the source for current requirements.
