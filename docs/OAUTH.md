# What it takes to offer "Sign in with Google" and "Sign in with Microsoft"

Researched 2026-08-09 against Google's and Microsoft's own documentation, not blog summaries —
several of the blogs get the Calendar classification wrong. Sources at the bottom.

**The short version:** Google **Calendar** is genuinely achievable — about ten days, no money, no
audit. Google **Gmail** is a real commitment: a paid third-party security audit, repeated every
year, forever. Microsoft sits in between and costs nothing but a partner account.

That asymmetry should shape the product: put a Google Calendar button in front of people, and keep
mail on app passwords until Gmail is worth paying an annual audit for.

---

## Google: everything turns on which tier your scope is in

Google sorts OAuth scopes into three tiers, and the tier — not the API — decides what you owe.

| tier | example | what you must do |
|---|---|---|
| Basic | email, profile | nothing |
| **Sensitive** | **reading Google Calendar events** | verification: a review, a demo video, a privacy policy, a verified domain. **No audit. No fee.** |
| **Restricted** | **reading Gmail messages** | everything above **plus** a CASA Tier 2 security assessment, **repeated every 12 months** |

Google's own sensitive-scope page names "reading events stored in Google Calendar" as its example
of a *sensitive* scope, and its restricted-scope page confirms the security assessment applies to
restricted scopes only. This is the single most important fact here and it is worth not taking on
faith from a blog.

### Google Calendar — the achievable one

What you actually have to produce:

1. A Google Cloud project with the Calendar API enabled and an OAuth consent screen filled in.
2. **A domain you own, verified in Google Search Console.** `zelos-app.netlify.app` will not do —
   Google requires a domain you control, so this needs a real domain for Zelos.
3. **A privacy policy hosted on that domain**, stating what data is accessed and why.
4. **An unlisted YouTube video** showing the OAuth consent screen, the client ID visible in the
   browser address bar, and the feature actually working.
5. A written justification for the scope, including why a narrower one will not do.

Timeline: **up to about 10 days.** Cost: **nothing.** No annual re-audit.

Ask for `calendar.readonly` and nothing more. Zelos only reads.

### Gmail — the expensive one

Any scope that reads message content (`gmail.readonly`, `gmail.modify`, `https://mail.google.com/`)
is **restricted**. On top of everything above:

- **CASA Tier 2** — an independent security assessment by a Google-approved lab. The self-serve
  path runs roughly **$540–$1,000**; the older manual assessments ran $15k–$75k.
- **Re-assessment every 12 months**, forever, to keep the scope.
- Total elapsed time to first approval: commonly **4–12 weeks**.

One nuance I could **not** confirm and will not claim: Google's restricted-scope page frames the
assessment around apps that "access data from or through a third-party server", which arguably does
not describe a desktop app that never sends mail anywhere. But the Security Assessment page states
flatly that apps requesting restricted scopes must undergo an annual assessment, with no local-app
carve-out written down. **Assume CASA applies** unless Google's Trust & Safety team tells you
otherwise in writing.

### The testing-mode shortcut, and why it is not a shipping plan

An unverified app can stay in "testing" with up to 100 named users immediately. But refresh tokens
issued by an app in testing **expire after 7 days**, so every user reconnects weekly. That is fine
for a pilot with a handful of people. It is not something to ship to strangers.

---

## Microsoft: cheaper, but with a gate of its own

There is no CASA equivalent. The requirement is **publisher verification** on a multi-tenant
Entra ID app registration:

1. Register the app in Microsoft Entra ID as **multi-tenant**.
2. Set a **publisher domain** you control.
3. Hold a **Microsoft AI Cloud Partner Program account with a Partner One ID**, verified, whose
   email domain matches the publisher domain.
4. Request delegated `Calendars.Read` (and `offline_access`).

Without publisher verification, the consent screen shows **"Unverified"**, and — this is the part
that actually blocks you — organisations with risk-based step-up consent enabled will simply
**refuse to let their users consent at all** for apps registered after November 2020 requesting
anything beyond basic sign-in. So for business users it is effectively mandatory.

Work and school accounts additionally need an admin to grant consent in many tenants.

---

## What Zelos does about it now

`core/sources/oauth.mjs` implements **OAuth 2.0 Authorization Code with PKCE and a loopback
redirect** — the correct flow for a desktop app, and the one that needs **no client secret**, which
matters because a client secret shipped inside a downloadable app is not a secret.

It is wired for Google Calendar and Microsoft Graph Calendar, with the client IDs blank and the
whole path inert until an app registration exists. Refresh tokens go to the OS keychain, never to
`config.json`. **Gmail is deliberately not wired.**

## The recommendation

1. **Get a real domain for Zelos.** Everything else is blocked on it — Google requires a verified
   domain and a privacy policy hosted on it, and Microsoft requires a publisher domain.
2. **Do Google Calendar first.** Ten days, no money, and it removes the most annoying half of
   setup for the largest group of users.
3. **Then Microsoft Calendar**, if business users matter — the cost is a partner account, not an
   audit.
4. **Leave Gmail on app passwords** until there are enough users to justify $540–1,000 a year plus
   an audit cycle. Zelos already reads Gmail perfectly well over IMAP with an app password; the
   only thing OAuth buys is a nicer first two minutes.

---

Sources:
- [Restricted scope verification — Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Sensitive scope verification — Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Security assessment — Google Cloud Help](https://support.google.com/cloud/answer/13465431)
- [OAuth API verification FAQ — Google Cloud Help](https://support.google.com/cloud/answer/9110914)
- [Publisher verification overview — Microsoft Entra](https://github.com/MicrosoftDocs/entra-docs/blob/main/docs/identity-platform/publisher-verification-overview.md)
- [Convert an app to multi-tenant — Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant)
