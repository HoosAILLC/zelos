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
});
