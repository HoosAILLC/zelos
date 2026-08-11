/**
 * core/connectors/imap.mjs — a mailbox, read over IMAP.
 *
 * The protocol lives in core/sources/imap.mjs (1,643 lines behind 1,507 lines of
 * tests) and none of it moved. What moved here is the three functions between
 * the protocol and the sweep — which mailboxes to read, which direction a
 * message went, and the reader the sweep's `deps.fetchMail` seam defaults to —
 * because all three are IMAP semantics that the run loop happened to be
 * holding.
 *
 * `fields` is deliberately empty. A mail account is edited by `mailForm` in
 * ui/views/settings.js, and genericising that form would cost the three-way TLS
 * selector, the SPECIAL-USE sent-folder reader and the `identity.email`
 * adoption — three behaviours with tests and a written history. A field schema
 * that cannot express them would not be a description of this connector; it
 * would be a worse editor for it.
 */

import { fetchRecent } from '../sources/imap.mjs';

/**
 * Mailboxes to read for one account: the configured list plus the sent folder,
 * which is not optional — `promised` is mined from what the user themselves
 * wrote, and without the sent folder half the board cannot exist.
 */
export function mailboxesFor(account) {
  const list = Array.isArray(account.mailboxes) && account.mailboxes.length
    ? account.mailboxes.filter((m) => typeof m === 'string' && m.trim())
    : ['INBOX'];
  const out = [...new Set(list)];
  const sent = typeof account.sentMailbox === 'string' ? account.sentMailbox.trim() : '';
  if (sent && !out.includes(sent)) out.push(sent);
  return out;
}

export function directionOf(message, mailbox, account, identityEmail) {
  // Compared against the trimmed name, because that is what mailboxesFor asked for.
  if (mailbox === String(account.sentMailbox ?? '').trim()) return 'out';
  const from = String(message?.from?.email ?? '').toLowerCase();
  if (from && (from === String(identityEmail).toLowerCase() || from === String(account.user).toLowerCase())) {
    return 'out';
  }
  return 'in';
}

/**
 * The default mail reader: one IMAP connection per mailbox.
 *
 * `signal` is forwarded, and that is the half of Ctrl-C that used to be missing.
 * The caller's check between mailboxes only ever caught a sweep between reads;
 * a read already on the wire ran to its own end, so the first Ctrl-C did
 * nothing a user could see and what actually ended the process was the
 * launcher's 5 s escape timer — a force-exit, not a stop. `fetchRecent` now
 * hands the signal to the client, which fails the command in flight and
 * destroys the socket, so `abort()` in the run loop is reached with the
 * connection already closed rather than still reading.
 *
 * `requireTls` is forwarded deliberately, and `?? null` rather than `|| null`,
 * because the setting is three-valued: `false` is a standing permission to talk
 * to this one host in the clear, and collapsing it into "not set" would put the
 * requirement back on a Proton Bridge the user has already excused. An account
 * saved before the field existed has no value at all, which is what `null`
 * means — the client then decides from the host, as it always has.
 */
export function read({ account, mailbox, pass, sinceDays, limit, onProgress, signal }) {
  return fetchRecent({
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.user,
    pass,
    requireTls: account.requireTls ?? null,
    mailbox,
    sinceDays,
    limit,
    onProgress,
    signal,
  });
}

export default {
  type: 'imap',
  family: 'mail',
  label: 'Mail',
  option: 'IMAP mailbox',
  configKey: 'mail',
  sink: 'messages',

  credential: {
    label: 'App password',
    help: 'Gmail, iCloud and Outlook all want an app-specific password rather than the one you log in with.',
    url: '',
    required: true,
  },

  /* IMAP is not HTTP. `ctx.http` is handed over anyway — every connector gets
     the same ctx — but with nothing on the allow-list, so a future edit that
     reaches for it fails loudly instead of quietly gaining an exit. */
  origins: [],
  fields: [],
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: null },

  /** NOT part of the contract; see core/connectors/calendar.mjs. */
  read,

  /**
   * One part per mailbox, which is the whole reason `parts[]` exists.
   *
   * The sweep has always pushed one `sources[]` row per MAILBOX rather than per
   * account — test/sweep.test.mjs asserts two rows for one account, INBOX and
   * Sent — so a generator, or a bare throw, would lose Sent because INBOX was
   * unreachable. A part carries its own failure and the rest of the account
   * still arrives.
   *
   * Mailboxes are read one at a time per account: they share a host, and opening
   * four IMAP connections to the same server at once is how a sweep gets
   * rate-limited or refused.
   */
  async collect(ctx) {
    const { source: account, secret: pass, deps, emit, signal, identityEmail, label } = ctx;
    const parts = [];
    for (const mailbox of mailboxesFor(account)) {
      if (signal?.aborted === true) break;
      try {
        const rows = await deps.fetchMail({
          account,
          mailbox,
          pass,
          sinceDays: account.lookbackDays ?? 14,
          limit: account.maxMessages ?? 400,
          onProgress: (p) => emit(`${label}: ${p.message}`, p.done, p.total),
          signal,
        });
        parts.push({
          label: mailbox,
          rows: (rows || []).map((row) => ({
            ...row,
            direction: directionOf(row, mailbox, account, identityEmail),
          })),
          error: null,
          note: null,
        });
      } catch (err) {
        parts.push({ label: mailbox, rows: [], error: err, note: null });
      }
    }
    return { parts };
  },
};
