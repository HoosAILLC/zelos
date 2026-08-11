/**
 * core/connectors/caldav.mjs — a CalDAV collection.
 *
 * The protocol lives in core/sources/caldav.mjs (1,112 lines behind 1,341 lines
 * of tests) and none of it moved. This file is the manifest the sweep reads and
 * the ten lines that turn a list of documents into a window of events.
 */

import { fetchRange } from '../sources/caldav.mjs';
import { calendarConnector, eventsFrom } from './calendar.mjs';

export default calendarConnector({
  type: 'caldav',
  label: 'Calendar',
  option: 'CalDAV (Fastmail, Nextcloud, iCloud…)',
  credential: {
    label: 'App password',
    help: 'Most CalDAV hosts want an app-specific password rather than the one you log in with.',
    url: '',
    required: false,
  },
  async read({ source, pass, signal, window }) {
    const docs = await fetchRange({
      url: source.url,
      user: source.user,
      pass,
      from: window.from,
      to: window.to,
      signal,
    });
    const events = [];
    // Each document is expanded and capped on its own, so the truncation is
    // per-document: a collection of a hundred small VEVENT files cannot fill the
    // budget between them, and one enormous recurring series can.
    let truncated = false;
    for (const doc of docs) {
      const part = eventsFrom(doc, window);
      if (part.truncated) truncated = true;
      events.push(...part.events);
    }
    return { events, truncated };
  },
});
