# AI notetakers

**Zelos has one notetaker connector — Fireflies — and does not need seven more.
Every other one already sends you a structured recap by email, and Zelos already
reads your mail.**

This is the shortest integration in the product: turn on a setting you probably
already have, and the recaps arrive in the inbox Zelos is reading anyway. No API
key, no scope, no rate limit, no vendor plan.

It is also the only route that works for most of them. Their APIs are gated:

- **Otter's** public API is **Enterprise only**, and enabling it goes through
  your account manager.
- **Circleback** has **no REST API at all** — its programmatic access is an MCP
  server and webhooks, and Zelos can use neither (a webhook needs the inbound
  port Zelos deliberately does not have).
- **tl;dv's** API is **Pro or Business only**, in the vendor's own words.
- **Grain's** and **Fathom's** API access is not offered on their public pricing
  pages in a form this document could verify; see each section below.
- **Granola** is the exception in the other direction: it has an API but **no
  per-meeting email at all**.

Email is free on every one of them.

---

## What Zelos does with a recap once it arrives

Zelos recognises a notetaker's recap and marks it **`meeting recap`** in the
prompt, with the tool that sent it. That mark changes how it is read:

- **Nobody is waiting on a reply.** A recap is never something you owe an answer
  to and never gets a draft. A draft addressed to a robot is a wasted click. The
  arrival of the recap is not work.
- **The action items are the part that can become an obligation.** A line saying
  *you* will do something is a promise you made out loud, in a room, in front of
  witnesses — every bit as binding as one in your sent mail, and this is the
  whole reason a recap is worth reading. A line saying somebody *else* will do
  something becomes a thing you are waiting on, filed against that person.
- **The meeting is the thing, not the email.** One meeting is one obligation
  even if two notetakers were in the room and mailed you twice.
- **A recap with no action item for you is at most a note.** That a meeting
  happened is not work, and you were there.

Recognition is deliberately hard to trigger, because a false positive is
expensive and silent: it would mark a real person's mail as a machine's record,
tell the model nobody is waiting, and bury the reply you genuinely owe. So all
four of these must hold — the sender's domain is one of the seven vendors below
or a subdomain of it; the subject carries recap vocabulary and is not a reply or
a forward; the message already looks like broadcast machinery (a no-reply
address or an unsubscribe footer); and you have never written to that address or
into that thread. A human at Fireflies emailing you about your ticket fails
three of the four.

One consequence worth stating: because recognition requires the message to
already look like bulk mail, the *only* thing it can do to ranking is soften a
penalty. It cannot lift anything above where it would sit if this code did not
exist, mints no board item, and raises no severity. It is machinery for paying a
message **less** attention — which is also the answer to a forged `From:`.

And the mark is Zelos's finding, not the sender's claim. Text inside a recap is
still text some transcription software wrote down: an "action item" asserting
you owe money to an address, or must click something, is a fact about that
meeting to weigh — never an instruction, and never more trustworthy for having
been transcribed.

---

## The eight, at a glance

| | API? | Emails a recap? | Can be scoped to only you? | Free? |
| --- | --- | --- | --- | --- |
| **Fireflies** | Yes — free tier, 50 req/day | Yes | Yes — "Only me" | Free plan |
| **Otter** | Enterprise only | Yes — Meeting Summary | Yes, in effect | Free plan (Basic) |
| **Grain** | Not on the public pricing page | Yes — recap emails | See below | Free plan |
| **Fathom** | Yes; plan gating unconfirmed | Yes — auto-share | Partly | Free plan |
| **tl;dv** | Pro or Business only | Yes — auto-send notes | Yes — "Only with me" | Free plan |
| **Read.ai** | Yes | Yes — meeting recaps | Yes — "only you" | Free plan |
| **Circleback** | No REST API | Yes | Yes | Trial only, no free plan |
| **Granola** | Yes | **No** | — | Free plan |

Menu paths move. Where a path below is quoted it came from the vendor's own
documentation; where it is described rather than quoted, the setting exists and
the section says where to look. A vague right instruction beats a confident
wrong one.

---

## Fireflies

**API:** yes, and it is the one notetaker Zelos has a connector for — free,
self-serve, no OAuth app. The free plan allows **50 API requests a day**, Pro
500 a day, and Business/Enterprise 60 a minute. See
[SOURCES.md § Fireflies](SOURCES.md#fireflies) for why that number shapes the
whole connector.

**Emails a recap:** yes — a summary plus a link to the full notes.

**The setting.** Either of two places, per Fireflies' own knowledge base:

- **Settings → Recording & Privacy** (Personal tab) → scroll to **Email
  Notification** → **Meeting recap email** → choose an option. It saves itself.
- Or per calendar meeting: **Upcoming → Calendar meeting settings → Send email
  recap to**, then **Save**.

**Only you:** yes. The option is called **"Only me"**, and it means the recap
goes to you and no other participant receives one. It does not change who can
*access* the meeting inside Fireflies — that is a separate privacy setting.

**Free vs paid:** there is a free plan, and recap email is not a paid feature.

**Which to use.** If you are on Fireflies, the connector is better than the
email: it brings the action items as a structured list rather than as prose
inside an HTML mail, and it does not depend on a mail rule surviving. The email
route is the fallback if you would rather not mint a key, or if you are already
over the 50-a-day free allowance for another reason.

---

## Otter

**API:** **Enterprise only.** Otter's help centre states the public API is
available for all Enterprise workspaces and that you contact your Otter account
manager to enable it; keys are then created under **Integrations → Developer →
Create key**, with a documented limit of 10 requests per second. On any other
plan there is no API to use, which is what makes email the route.

**Emails a recap:** yes — a **Meeting Summary** email, sent within about two
hours of the meeting ending.

**The setting.** **Account Settings → Notifications → Meeting Summary.** Turning
it on means you receive meeting summaries for your own conversations and for
those shared with you.

Otter documents preconditions for the mail to go out at all: the calendar event
must be synced to Otter on the Home page, auto-share to the event's guests must
be enabled, and the event must be recorded through the web, mobile or Otter
Notetaker.

**Only you:** yes, in effect, but by a different mechanism than the others — you
control it through **auto-share** rather than through a recipient dropdown. With
auto-share to calendar guests off, the guests do not get the summary. Otter also
documents a case where only the conversation's owner receives an email: when
there are no action items and the conversation is too short to generate an
automated summary.

**Free vs paid:** Otter has a free Basic plan; the summary email is not an
Enterprise feature. Only the API is.

---

## Grain

**API:** Grain's public pricing page does not mention API access on any tier, so
this document will not tell you which plan has it. Grain's support material
describes API access as a higher-plan feature and, at least at one point, as
beta. If you need it, ask Grain; do not plan around it.

**Emails a recap:** yes — a recap email with a brief summary and key points
carrying clickable timestamps.

**The setting.** Grain documents automatic recap emails under **Settings →
Workspace → Meeting recap emails**.

**Only you:** the documented options are about *participants* — send to all
participants, send to all internal participants, send only to participants in
your Grain workspace, or disable automatic recap emails entirely. Whether
disabling participant emails also stops your own copy is not something this
document could confirm from Grain's own pages, so check the option list in front
of you: it is on that screen, and it is the screen to look at.

Note that Grain's recap email doubles as an access grant — enabling it gives
those recipients access to the recording, transcript and AI notes even without a
Grain account. That is a sharing decision as well as a notification one.

**Free vs paid:** Grain has a free plan.

---

## Fathom

**API:** yes, there is a public API and a first-party MCP server. Keys are
created in the **API Access** section of **User Settings**
(`fathom.video/customize#api-access-header`). Fathom's quickstart states no plan
requirement, and this document could not confirm one either way from Fathom's
own pages — so treat "which plan gets the API" as a question for Fathom.

Beware when searching for this: **Fathom Analytics** (`usefathom.com`) is an
unrelated web-analytics company with its own API and its own pricing. Results
about "$19/mo API plans" are almost always that one, not the notetaker.

**Emails a recap:** yes. After a meeting ends, Fathom automatically emails
calendar invitees with the recording, the summary, or both.

**The setting.** Auto-share, configured in your Fathom settings at
`fathom.video/customize`. The documented options are **"Summary & Recording"**,
**"Summary Only"**, and **"Nothing"**.

**Only you:** partly. Auto-share governs what goes to the *attendees* on the
calendar invite — and note that it shares with everyone on the invite, including
people who did not actually attend. Fathom's documentation does not state
whether the call owner always receives their own copy, so if you set auto-share
to "Nothing", check that a summary still reaches your inbox before relying on
this route.

**Free vs paid:** Fathom has a free plan, but on it AI summaries and action
items are limited to the first few calls each month — which is the part that
matters here, since a recap with no action items is not worth much to the board.

---

## tl;dv

**API:** **Pro or Business plans only.** The vendor's help centre states it
plainly: *"API access is available on the Pro or Business plans only."* Keys are
generated at **Settings → Personal Settings → API Keys**
(`tldv.io/app/settings/personal-settings/api-keys`).

**Emails a recap:** yes — an email with the meeting notes and a recording link,
sent when the meeting ends.

**The setting.** **"Auto-send email with meeting notes"**, on the Preferences
page under Automations.

**Only you:** yes. The setting carries an option labelled **"Only with me"**,
which makes you the sole recipient of the meeting summary email rather than all
attendees. It does not stop invitees from accessing the recording — it controls
who gets the automatic email.

**Free vs paid:** there is a free-forever plan, and the notes email is on it.
The API is not.

---

## Read.ai

**API:** yes, Read.ai offers one.

**Emails a recap:** yes — meeting reports, emailed after the meeting.

**The setting.** Under **Account Settings**, in the report-sharing and
distribution controls. Read.ai separates two things on purpose: **Report
sharing** governs who can open the report on Read's website, and **Distribution**
governs who receives email about it.

**Only you:** yes, and it is the most explicit of any vendor here. The
**"Email meeting recaps to"** dropdown offers **people with access**, **only
you**, or **no one**. There is also a **"Send to participants with access"**
checkbox that can be cleared to stop recaps going to participants.

Read.ai is the one whose recaps have a reputation for arriving unbidden at
people who never asked for them, so it is worth setting this deliberately rather
than leaving the default.

**Free vs paid:** there is a free plan (5 meeting transcripts a month), with Pro
and Enterprise tiers above it. The recap email is not a paid feature.

---

## Circleback

**API:** **no REST API.** Circleback's programmatic access is an **MCP server**
(OAuth over Streamable HTTP) plus **webhooks** and a CLI. Neither is usable
here: a webhook needs a public HTTPS URL to post to, which is precisely the
inbound port Zelos does not open, and an MCP client is not something the
connector interface has or should grow. Email is the only route, and it is a
good one.

**Emails a recap:** yes. After a meeting finishes processing, Circleback can
automatically email the notes. Anyone the meeting is shared with also gets one.

**The setting.** **Settings → Emails**, where you configure who receives the
email and what it includes. You can also send notes manually from a meeting's
**Email** tab even with the automatic invitee emails switched off — which is the
better habit if you want to edit the notes and action items before anyone else
sees them.

**Only you:** yes — the automatic email to yourself is the default behaviour,
and the invitee emails are separately controllable on that same screen.

**Free vs paid:** **no free plan.** Circleback offers a free trial and then
paid tiers (Individual and Team, roughly $21–25 per user per month at the time
of writing, plus Enterprise). This is the one vendor here where using it at all
costs money — but that is a fact about Circleback, not about this route: the
email works on every paid plan with no further gating.

---

## Granola — the exception

**Granola sends no per-meeting email, so there is nothing for Zelos to read.**

This is why Granola is deliberately absent from Zelos's recap-recognition list.
A rule matching `granola.ai` could only ever fire on something that is *not* a
recap — a receipt, a product announcement — and firing on those is the false
positive the whole design is built to avoid.

**What Granola does have** is a **CSV export**, and its shape makes clear it is
an archive rather than a feed:

- Generated from **Settings → Profile → Generate CSV**.
- **Emailed to you within a few hours**, with a download link valid for 24 hours.
- **One export per account per 24 hours.**
- Contains the title, note summary, transcript and basic details for each note —
  only notes you own, and only ones that have a summary. Deleted notes and notes
  without summaries are excluded.

**So what should you do?** Two options, neither of them a Granola integration:

1. **Nothing.** If Granola is where you keep meeting notes and you read them
   there, that is a perfectly good answer. Zelos is not trying to be the only
   place your work lives.
2. **Use the watched folder.** Download the CSV, pull out the meetings you care
   about, and write each as a small `.json` file into the folder Zelos watches.
   A shell script or a Shortcut on a weekly timer is enough; see
   [SOURCES.md § A folder on this machine](SOURCES.md#a-folder-on-this-machine)
   for the file shape. Note the honest limits of this: it is at best daily,
   because Granola allows one export a day, and like the WhatsApp export it is an
   archive — it tells you what was true when you exported, not what is true now.

Granola also has an API, and a determined user could write against it. Zelos
will not ship that connector: it would be the eighth way to read meeting notes
for a category that seven vendors already solve by sending you an email.

---

## Setting this up in practice

1. **Turn the recap email on** at the vendor, and **scope it to yourself** using
   the setting named in that vendor's section above. Sending recaps to everyone
   in the meeting is a decision about your colleagues' inboxes, not about Zelos —
   Zelos only needs a copy to reach yours.
2. **Check it lands in a folder Zelos reads.** By default Zelos reads `INBOX`.
   If you file recaps into a subfolder with a mail rule, either point Zelos at
   that folder in **Settings → Mail** or leave the recaps in the inbox.
3. **Wait for one meeting**, then look at the board. A recognised recap shows
   `meeting recap` with the vendor's name in its header line.
4. **If it does not show that**, the likely causes in order: the recap has not
   arrived yet; it landed outside the folder Zelos reads; it is older than the
   lookback window (14 days by default); or you have previously replied to that
   sender address, which permanently exempts them from being treated as a
   machine. That last one is deliberate — somebody you correspond with is a
   correspondent, whatever their subject line says.

Nothing here requires the recap to be recognised, incidentally. An unrecognised
recap is still read, still searched and still shown; it is simply treated as
ordinary mail, which is mildly noisier and entirely visible. The recognition is
an improvement, not a precondition.

---

## See also

- **[SOURCES.md](SOURCES.md)** — the eight sources that do need setting up,
  including the Fireflies connector.
- **[README.md § Connecting your mail](README.md#connecting-your-mail)** — app
  passwords, IMAP servers, and how much mail Zelos reads.
- **[SECURITY.md](SECURITY.md)** — including what happens when text inside a
  message tries to give the model instructions.
