/**
 * core/connectors/file.mjs — an .ics file on this machine.
 *
 * The one source that reaches nothing: no socket, no credential, no origin. It
 * is what an exported calendar, a Dropbox-synced .ics, or a scripted dump looks
 * like to Zelos, and it is the reason `credential` is nullable rather than
 * merely optional — there is no password to be missing, so the host must never
 * write "No password stored for …" about it.
 */

import fs from 'node:fs/promises';

import { parseICS } from '../sources/ics.mjs';
import { calendarConnector, eventsFrom } from './calendar.mjs';

export default calendarConnector({
  type: 'file',
  label: 'Calendar',
  option: 'A calendar file on this machine',
  credential: null,
  async read({ source, window }) {
    const text = await fs.readFile(source.url, 'utf8');
    return eventsFrom(text, window);
  },

  /**
   * What `zelos doctor` used to ask inside `if (calendar.kind === 'file')`.
   *
   * It moved here because "is this source reachable, and what came back" is
   * protocol knowledge, and a diagnostic holding one branch per kind is the same
   * defect the run loop had before the registry: every new connector meant an
   * edit to a file that has nothing to do with it.
   *
   * Every sentence below is the one doctor printed, character for character —
   * test/doctor.test.mjs reads them, and a person who has hit this before should
   * not have to recognise a new wording for the same fault. `stat` before `read`
   * is what makes "a directory, a socket, a file too big to hold" answerable at
   * all rather than arriving as an EISDIR from somewhere deeper.
   *
   * `ctx.maxBytes` is the host's cap rather than this file's. The number belongs
   * to whoever is paying for the memory, and doctor already owns one for the
   * calendar it fetches over http — two constants for one ceiling is how they
   * drift.
   */
  async check(source, ctx) {
    const cap = Number(ctx?.maxBytes) || 0;
    try {
      const stat = await fs.stat(source.url);
      if (!stat.isFile()) throw new Error('that path is not a file');
      if (cap && stat.size > cap) throw new Error(`the file is larger than ${cap} bytes`);
      const parsed = parseICS(await fs.readFile(source.url, 'utf8'));
      return {
        status: 'pass',
        detail: `${source.url} · ${parsed.vevents.length} entr${parsed.vevents.length === 1 ? 'y' : 'ies'}`,
      };
    } catch (err) {
      return {
        status: 'fail',
        detail: `${source.url}: ${err?.message || String(err ?? 'unknown error')}`,
        action: 'Check the path in Settings → Calendars. It must be a readable .ics file on this machine.',
      };
    }
  },
});
