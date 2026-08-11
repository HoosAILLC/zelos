/**
 * core/connectors/ics.mjs — a subscribed .ics document over http(s).
 *
 * `fetchIcsText` below is lifted out of core/sweep.mjs unchanged, and it
 * deliberately does NOT go through `ctx.http`. Routing it there would turn a 401
 * on a subscription URL into an `AuthError`, and an `AuthError` rests the source
 * for six hours — where today it throws "calendar at host returned 401" on every
 * sweep and the user sees the banner every time they look. That is a behaviour
 * change with a test-visible surface, and this pass is a refactor. New
 * connectors get `ctx.http`; this one keeps its own reader until somebody wants
 * to pay for the change on purpose.
 */

import { calendarConnector, eventsFrom } from './calendar.mjs';

const ICS_TIMEOUT_MS = 20_000;
const ICS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read an .ics document over HTTP.
 *
 * At most one redirect is followed, and credentials are never carried across an
 * origin change — a calendar URL that redirects elsewhere must not hand that
 * host the user's password.
 */
export async function fetchIcsText(rawUrl, { user, pass, signal, timeoutMs = ICS_TIMEOUT_MS } = {}) {
  const url = new URL(String(rawUrl).replace(/^webcal:/i, 'https:'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`calendar URL must be http, https or webcal (got ${url.protocol})`);
  }

  const headers = { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' };
  if (user) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}`;
  }

  const request = async (target, withAuth) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const sendHeaders = withAuth ? headers : { accept: headers.accept };
    return fetch(target, {
      headers: sendHeaders,
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
  };

  let res = await request(url, true);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) throw new Error(`calendar at ${url.host} redirected without a destination`);
    const next = new URL(location, url);
    const sameOrigin = next.origin === url.origin;
    res = await request(next, sameOrigin);
  }
  if (!res.ok) throw new Error(`calendar at ${url.host} returned ${res.status}`);

  const text = await res.text();
  if (text.length > ICS_MAX_BYTES) {
    throw new Error(`calendar at ${url.host} returned ${text.length} bytes — refusing to parse it`);
  }
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error(`calendar at ${url.host} did not return an iCalendar document`);
  }
  return text;
}

export default calendarConnector({
  type: 'ics',
  label: 'Calendar',
  option: 'Subscribed calendar (.ics over the web)',
  credential: {
    label: 'Password',
    help: 'Only if the address is protected. Most published calendars are not.',
    url: '',
    required: false,
  },
  async read({ source, pass, signal, window }) {
    const text = await fetchIcsText(source.url, { user: source.user, pass, signal });
    return eventsFrom(text, window);
  },
});
