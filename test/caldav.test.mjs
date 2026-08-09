/**
 * test/caldav.test.mjs — the CalDAV client against a local mock server.
 *
 * Every request goes to a node:http server on 127.0.0.1 that replays response
 * shapes taken from Nextcloud, iCloud and Fastmail — differing namespace
 * prefixes, absolute vs path-only hrefs, split propstat blocks. Nothing here
 * reaches a third-party host and nothing touches the real ~/.zelos.
 *
 * Assertions are on what hits the socket (method, path, Depth, Authorization,
 * request body) as much as on what comes back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Buffer } from 'node:buffer';

import { discover, fetchRange, testConnection } from '../core/sources/caldav.mjs';
import { parseICS_toEvents } from '../core/sources/ics.mjs';

const USER = 'nemo@example.test';
const PASS = 'app-specific-password';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;

/**
 * Start a mock server. `routes` maps "METHOD /path" to a handler that returns
 * {status, body, headers} — or a plain string, meaning 207 + XML.
 * Every request is recorded for assertions.
 */
async function startServer(routes, { requireAuth = true } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url;
      requests.push({
        method: req.method,
        path,
        depth: req.headers.depth ?? null,
        auth: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? null,
        body,
      });

      if (requireAuth && req.headers.authorization !== EXPECTED_AUTH) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
        res.end('Unauthorized');
        return;
      }

      const route = routes[`${req.method} ${path}`] ?? routes[`${req.method} *`];
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const result = typeof route === 'function' ? route({ body }) : route;
      if (typeof result === 'string') {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(result);
        return;
      }
      res.writeHead(result.status ?? 207, {
        'content-type': 'application/xml; charset=utf-8',
        ...(result.headers || {}),
      });
      res.end(result.body ?? '');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { origin, requests, close, server };
}

/* ------------------------------------------------------------------ *
 * Response fixtures
 * ------------------------------------------------------------------ */

/** Nextcloud: `d:` prefix, path-only hrefs. */
const NEXTCLOUD_PRINCIPAL = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/</d:href>
  <d:propstat>
   <d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/nemo/</d:href></d:current-user-principal></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><d:resourcetype/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const NEXTCLOUD_HOME = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/principals/users/nemo/</d:href>
  <d:propstat>
   <d:prop><cal:calendar-home-set><d:href>/remote.php/dav/calendars/nemo/</d:href></cal:calendar-home-set></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

/**
 * The collection listing, with everything that must be filtered out: the home
 * collection itself, a VTODO-only list, a scheduling inbox and an addressbook.
 */
const NEXTCLOUD_COLLECTIONS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"
               xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/personal/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Personal &amp; family</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
    <cs:getctag>http://sabre.io/ns/sync/42</cs:getctag>
    <ic:calendar-color>#C1440EFF</ic:calendar-color>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/tasks/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Tasks</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/inbox/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/><cal:schedule-inbox/></d:resourcetype><d:displayname>Inbox</d:displayname></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/addressbooks/nemo/contacts/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/></d:resourcetype></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/work/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><d:displayname/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const EVENT_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mock//EN',
  'BEGIN:VEVENT',
  'UID:cd-1@example.test',
  'DTSTART;TZID=America/New_York:20260811T140000',
  'DTEND;TZID=America/New_York:20260811T150000',
  'SUMMARY:Kickoff with Marcus & co',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const RECURRING_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mock//EN',
  'BEGIN:VEVENT',
  'UID:cd-2@example.test',
  'DTSTART;TZID=America/New_York:20261029T090000',
  'DTEND;TZID=America/New_York:20261029T100000',
  'RRULE:FREQ=WEEKLY;COUNT=2',
  'SUMMARY:Thursday sync',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** calendar-data escaped as text — the common form. */
function reportBody(items) {
  const responses = items
    .map(
      (ics, i) => `
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/personal/e${i}.ics</d:href>
  <d:propstat>
   <d:prop><d:getetag>"etag-${i}"</d:getetag><cal:calendar-data>${xmlEscape(ics)}</cal:calendar-data></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>`,
    )
    .join('');
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${responses}
</d:multistatus>`;
}

const NEXTCLOUD_ROUTES = {
  'PROPFIND /': NEXTCLOUD_PRINCIPAL,
  'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
  'PROPFIND /remote.php/dav/calendars/nemo/': NEXTCLOUD_COLLECTIONS,
  'REPORT /remote.php/dav/calendars/nemo/personal/': () => reportBody([EVENT_ICS, RECURRING_ICS]),
  'REPORT /remote.php/dav/calendars/nemo/work/': () => reportBody([]),
};

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

test('discover walks principal -> home-set -> calendars', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });

  assert.equal(result.principal, `${mock.origin}/remote.php/dav/principals/users/nemo/`);
  assert.equal(result.homeSet, `${mock.origin}/remote.php/dav/calendars/nemo/`);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Personal & family', 'work'],
    'VTODO-only lists, inboxes, addressbooks and the home collection are all filtered out',
  );
  assert.equal(result.calendars[0].href, `${mock.origin}/remote.php/dav/calendars/nemo/personal/`);
  assert.equal(result.calendars[0].color, '#C1440EFF');
  assert.equal(result.calendars[0].ctag, 'http://sabre.io/ns/sync/42');
  assert.deepEqual(result.calendars[0].components, ['VEVENT', 'VTODO']);
});

test('discovery sends Basic auth and the right Depth on every hop', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  await discover({ url: mock.origin, user: USER, pass: PASS });

  assert.deepEqual(
    mock.requests.map((r) => [r.method, r.path, r.depth]),
    [
      ['PROPFIND', '/', '0'],
      ['PROPFIND', '/remote.php/dav/principals/users/nemo/', '0'],
      ['PROPFIND', '/remote.php/dav/calendars/nemo/', '1'],
    ],
  );
  for (const r of mock.requests) {
    assert.equal(r.auth, EXPECTED_AUTH, 'every request carries the credentials');
    assert.match(r.contentType, /xml/);
  }
  assert.match(mock.requests[0].body, /current-user-principal/);
  assert.match(mock.requests[1].body, /calendar-home-set/);
  assert.match(mock.requests[2].body, /supported-calendar-component-set/);
});

test('a URL pointing straight at one calendar is discovered by the same call', async (t) => {
  const single = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/dav/calendars/personal/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Just this one</d:displayname></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

  const mock = await startServer({
    'PROPFIND /dav/calendars/personal/': ({ body }) =>
      body.includes('current-user-principal')
        ? `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/calendars/personal/</d:href><d:propstat><d:prop><d:current-user-principal/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`
        : single,
  });
  t.after(() => mock.close());

  const result = await discover({ url: `${mock.origin}/dav/calendars/personal/`, user: USER, pass: PASS });
  assert.equal(result.principal, null);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Just this one'],
  );
});

test('discovery falls back to /.well-known/caldav when the root is not a DAV resource', async (t) => {
  const mock = await startServer({
    'PROPFIND /': { status: 405, body: 'Method Not Allowed' },
    'PROPFIND /.well-known/caldav': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': NEXTCLOUD_COLLECTIONS,
  });
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.calendars.length, 2);
  assert.deepEqual(
    mock.requests.map((r) => r.path).slice(0, 2),
    ['/', '/.well-known/caldav'],
  );
});

test('iCloud-shaped responses: default namespace and absolute hrefs', async (t) => {
  let origin = '';
  const mock = await startServer({
    'PROPFIND /': () => `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <response>
  <href>/</href>
  <propstat><prop><current-user-principal><href>${origin}/1472538/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat>
 </response>
</multistatus>`,
    'PROPFIND /1472538/principal/': () => `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <response>
  <href>/1472538/principal/</href>
  <propstat><prop><cal:calendar-home-set><href>${origin}/1472538/calendars/</href></cal:calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat>
 </response>
</multistatus>`,
    'PROPFIND /1472538/calendars/': () => `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <response>
  <href>${origin}/1472538/calendars/home/</href>
  <propstat>
   <prop>
    <resourcetype><collection/><cal:calendar/></resourcetype>
    <displayname>Home</displayname>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
   </prop>
   <status>HTTP/1.1 200 OK</status>
  </propstat>
 </response>
</multistatus>`,
  });
  origin = mock.origin;
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.principal, `${mock.origin}/1472538/principal/`);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Home'],
  );
  assert.equal(result.calendars[0].href, `${mock.origin}/1472538/calendars/home/`);
});

test('Fastmail-shaped responses: uppercase prefixes', async (t) => {
  const mock = await startServer({
    'PROPFIND /': `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <D:response><D:href>/dav/</D:href>
  <D:propstat><D:prop><D:current-user-principal><D:href>/dav/principals/user/nemo@example.test/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
 </D:response>
</D:multistatus>`,
    'PROPFIND /dav/principals/user/nemo@example.test/': `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <D:response><D:href>/dav/principals/user/nemo@example.test/</D:href>
  <D:propstat><D:prop><C:calendar-home-set><D:href>/dav/calendars/user/nemo@example.test/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
 </D:response>
</D:multistatus>`,
    'PROPFIND /dav/calendars/user/nemo@example.test/': `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <D:response><D:href>/dav/calendars/user/nemo@example.test/6f9c/</D:href>
  <D:propstat><D:prop>
   <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
   <D:displayname>Fastmail calendar</D:displayname>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
 </D:response>
</D:multistatus>`,
  });
  t.after(() => mock.close());

  const result = await discover({ url: `${mock.origin}/`, user: USER, pass: PASS });
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Fastmail calendar'],
  );
});

/* ------------------------------------------------------------------ *
 * Redirects
 * ------------------------------------------------------------------ */

test('one redirect is followed with the method and body intact', async (t) => {
  const mock = await startServer({
    'PROPFIND /': { status: 301, headers: { location: '/remote.php/dav/' }, body: '' },
    'PROPFIND /remote.php/dav/': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': NEXTCLOUD_COLLECTIONS,
  });
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.calendars.length, 2);

  const redirected = mock.requests[1];
  assert.equal(redirected.method, 'PROPFIND', 'the method survives the redirect');
  assert.match(redirected.body, /current-user-principal/, 'so does the body');
  assert.equal(redirected.depth, '0');
});

test('a second redirect is refused', async (t) => {
  const mock = await startServer({
    'PROPFIND /': { status: 302, headers: { location: '/one/' }, body: '' },
    'PROPFIND /one/': { status: 302, headers: { location: '/two/' }, body: '' },
    'PROPFIND /.well-known/caldav': { status: 404, body: '' },
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /redirected more than once/);
});

test('a redirect to a non-HTTP location is refused', async (t) => {
  const mock = await startServer({
    'PROPFIND *': { status: 302, headers: { location: 'file:///etc/passwd' }, body: '' },
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /non-HTTP/);
});

/* ------------------------------------------------------------------ *
 * testConnection
 * ------------------------------------------------------------------ */

test('testConnection reports the calendars it found', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Personal & family', 'work'],
  );
  assert.deepEqual(Object.keys(result.calendars[0]).sort(), ['href', 'name']);
});

test('wrong credentials fail fast with an actionable message', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: 'wrong' });
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected the credentials/);
  assert.match(result.error, /app-specific password/);
  assert.match(result.error, /127\.0\.0\.1/, 'the message names the host that failed');
  assert.equal(mock.requests.length, 1, 'a 401 stops discovery instead of probing more paths');
});

test('a server with no calendars says so instead of claiming success', async (t) => {
  const mock = await startServer({
    'PROPFIND /': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`,
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /found no calendars/);
});

test('an unreachable host reports the host, not a stack trace', async () => {
  const mock = await startServer({});
  const origin = mock.origin;
  await mock.close(); // nothing is listening any more

  const result = await testConnection({ url: origin, user: USER, pass: PASS, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not reach 127\.0\.0\.1/);
});

test('a non-HTTP scheme is rejected before any socket is opened', async () => {
  const result = await testConnection({ url: 'ftp://calendar.example.test/dav/', user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be http or https/);
});

/* ------------------------------------------------------------------ *
 * fetchRange
 * ------------------------------------------------------------------ */

test('fetchRange issues a calendar-query with the requested window', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const texts = await fetchRange({
    url: mock.origin,
    user: USER,
    pass: PASS,
    from: '2026-08-01T00:00:00Z',
    to: '2026-11-30T00:00:00Z',
  });

  assert.equal(texts.length, 2);
  for (const text of texts) assert.match(text, /^BEGIN:VCALENDAR/);
  assert.ok(texts[0].includes('Kickoff with Marcus & co'), 'XML entities are decoded back to the raw ICS');

  const reports = mock.requests.filter((r) => r.method === 'REPORT');
  assert.deepEqual(
    reports.map((r) => r.path),
    ['/remote.php/dav/calendars/nemo/personal/', '/remote.php/dav/calendars/nemo/work/'],
    'every discovered calendar is queried',
  );
  assert.equal(reports[0].depth, '1');
  assert.match(reports[0].body, /<c:comp-filter name="VEVENT">/);
  assert.match(reports[0].body, /start="20260801T000000Z"/);
  assert.match(reports[0].body, /end="20261130T000000Z"/);
  assert.match(reports[0].body, /calendar-data/);
});

test('fetchRange output parses into events that carry their offsets', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const texts = await fetchRange({
    url: mock.origin,
    user: USER,
    pass: PASS,
    from: '2026-08-01T00:00:00Z',
    to: '2026-11-30T00:00:00Z',
  });

  const events = texts.flatMap((text) =>
    parseICS_toEvents(text, { from: '2026-08-01T00:00:00Z', to: '2026-11-30T00:00:00Z', tzid: 'America/New_York' }),
  );

  assert.deepEqual(
    events.map((e) => e.startsAt),
    [
      '2026-08-11T14:00:00-04:00',
      '2026-10-29T09:00:00-04:00',
      '2026-11-05T09:00:00-05:00', // the series crosses the end of DST
    ],
  );
  assert.equal(events[0].title, 'Kickoff with Marcus & co');
});

test('calendar-data delivered as CDATA is read too', async (t) => {
  const mock = await startServer({
    ...NEXTCLOUD_ROUTES,
    'REPORT /remote.php/dav/calendars/nemo/personal/': () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/remote.php/dav/calendars/nemo/personal/e0.ics</d:href>
  <d:propstat><d:prop><cal:calendar-data><![CDATA[${EVENT_ICS}]]></cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`,
  });
  t.after(() => mock.close());

  const texts = await fetchRange({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes('SUMMARY:Kickoff with Marcus & co'));
});

test('one failing calendar does not cost the user the others', async (t) => {
  const mock = await startServer({
    ...NEXTCLOUD_ROUTES,
    'REPORT /remote.php/dav/calendars/nemo/personal/': { status: 500, body: 'boom' },
    'REPORT /remote.php/dav/calendars/nemo/work/': () => reportBody([EVENT_ICS]),
  });
  t.after(() => mock.close());

  const texts = await fetchRange({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(texts.length, 1);
});

test('responses that are not calendar data are ignored', async (t) => {
  const mock = await startServer({
    ...NEXTCLOUD_ROUTES,
    'REPORT /remote.php/dav/calendars/nemo/personal/': `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/x.ics</d:href>
  <d:propstat><d:prop><cal:calendar-data>not a calendar at all</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response><d:href>/y.ics</d:href>
  <d:propstat><d:prop><cal:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
</d:multistatus>`,
    'REPORT /remote.php/dav/calendars/nemo/work/': () => reportBody([]),
  });
  t.after(() => mock.close());

  assert.deepEqual(await fetchRange({ url: mock.origin, user: USER, pass: PASS }), []);
});

/* ------------------------------------------------------------------ *
 * Hostile responses
 * ------------------------------------------------------------------ */

test('a DOCTYPE with entity declarations is skipped, never expanded', async (t) => {
  // The billion-laughs shape. If these declarations were honoured the parser
  // would allocate gigabytes; they are skipped along with the whole DOCTYPE, so
  // "&lol9;" survives as literal text and expands to nothing.
  const bomb = `<?xml version="1.0"?>
<!DOCTYPE multistatus [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol9 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/personal/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>&lol9;</d:displayname></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

  const noPrincipal = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`;
  const mock = await startServer({
    // The Depth:0 principal probe and the Depth:1 listing hit the same path;
    // the request body is what distinguishes them.
    'PROPFIND /': ({ body }) => (body.includes('current-user-principal') ? noPrincipal : bomb),
    'PROPFIND /.well-known/caldav': { status: 404, body: '' },
  });
  t.after(() => mock.close());

  const started = Date.now();
  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.calendars.length, 1);
  assert.equal(result.calendars[0].name, '&lol9;', 'an undeclared-as-far-as-we-care entity stays literal');
});

test('an href pointing at another scheme is dropped rather than followed', async (t) => {
  const mock = await startServer({
    'PROPFIND /': `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/</d:href>
  <d:propstat><d:prop><d:current-user-principal><d:href>file:///etc/passwd</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`,
    'PROPFIND /.well-known/caldav': { status: 404, body: '' },
  });
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.principal, null, 'a file: principal is not a principal');
  assert.deepEqual(result.calendars, []);
  assert.ok(
    mock.requests.every((r) => r.method === 'PROPFIND'),
    'nothing outside the DAV flow was requested',
  );
});

test('malformed XML degrades instead of throwing', async (t) => {
  const mock = await startServer({
    'PROPFIND *': '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/broken/',
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /found no calendars/);
});

test('an oversized response is refused before it is buffered', async (t) => {
  const mock = await startServer({
    'PROPFIND *': { status: 207, headers: { 'content-length': String(64 * 1024 * 1024) }, body: '' },
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /too large/);
});

test('a 207 whose body never finishes is abandoned at the deadline', async (t) => {
  // The trap this guards: fetch() resolves as soon as the headers arrive, so a
  // deadline torn down at that moment leaves the body read unbounded — a
  // server that sends "207, <?xml" and then goes silent used to hang the
  // whole sweep forever.
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.write('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">');
      // ...and nothing more, ever.
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  // The race is the assertion: with the old behaviour testConnection never
  // settles, and only the sentinel comes back.
  let sentinel;
  const result = await Promise.race([
    testConnection({ url: `http://127.0.0.1:${server.address().port}`, user: USER, pass: PASS, timeoutMs: 300 }),
    new Promise((resolve) => {
      sentinel = setTimeout(() => resolve('hung'), 5000);
    }),
  ]);
  clearTimeout(sentinel);

  assert.notEqual(result, 'hung', 'the stalled body must be abandoned, not awaited forever');
  assert.equal(result.ok, false);
  assert.match(result.error, /within 300ms/);
});

test('a chunked body past the size cap is cut off with "too large"', async (t) => {
  // No content-length header, so the pre-flight check cannot catch it: the cap
  // has to be enforced while the body streams. The server sends well past the
  // cap and then goes quiet without ever finishing — a client that only checks
  // size after buffering the whole body never gets a whole body to check, so
  // the streaming check is the only thing that can end this request.
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/.well-known/caldav') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.on('error', () => {}); // the client is expected to hang up on us
      let sent = 0;
      const pump = () => {
        while (sent < 48 * 1024 * 1024 && res.writable) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        // ...and then silence: the response is never ended.
      };
      pump();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  let sentinel;
  const result = await Promise.race([
    testConnection({
      url: `http://127.0.0.1:${server.address().port}`,
      user: USER,
      pass: PASS,
      timeoutMs: 15000,
    }),
    new Promise((resolve) => {
      sentinel = setTimeout(() => resolve('hung'), 10000);
    }),
  ]);
  clearTimeout(sentinel);

  assert.notEqual(result, 'hung', 'the cap must trip mid-stream, not after a body that never completes');
  assert.equal(result.ok, false);
  assert.match(result.error, /too large/);
});
