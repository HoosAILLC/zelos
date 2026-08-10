import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decodeCharset,
  decodeTransfer,
  decodeWords,
  htmlToText,
  parseAddressList,
  parseDate,
  parseHeaders,
  threadKeyFor,
} from '../core/sources/mime.mjs';

// Pure functions, no disk — but the real ~/.zelos stays off limits regardless.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mime-test-'));
process.env.ZELOS_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/* ------------------------------------------------------------------ *
 * decodeWords — RFC 2047
 * ------------------------------------------------------------------ */

test('decodeWords leaves text without encoded words untouched', () => {
  assert.equal(decodeWords('Re: invoice 4471'), 'Re: invoice 4471');
  assert.equal(decodeWords(''), '');
  assert.equal(decodeWords(null), '');
});

test('decodeWords decodes a base64 UTF-8 subject', () => {
  const subject = 'Überfällige Zahlung für März';
  const encoded = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  assert.equal(decodeWords(encoded), subject);
});

test('decodeWords drops the whitespace that folds two adjacent words', () => {
  const a = `=?utf-8?B?${Buffer.from('Hello ', 'utf8').toString('base64')}?=`;
  const b = `=?utf-8?B?${Buffer.from('world', 'utf8').toString('base64')}?=`;
  assert.equal(decodeWords(`${a} ${b}`), 'Hello world');
  // ...but real whitespace between an encoded word and plain text survives.
  assert.equal(decodeWords(`${a} plain ${b}`), 'Hello  plain world');
});

test('decodeWords reassembles a multi-byte character split across two words', () => {
  // "für" in UTF-8 is 66 C3 BC 72; the split falls between the two bytes of "ü".
  const first = Buffer.from([0x66, 0xc3]).toString('base64');
  const second = Buffer.from([0xbc, 0x72]).toString('base64');
  assert.equal(decodeWords(`=?utf-8?B?${first}?= =?utf-8?B?${second}?=`), 'für');
});

test('decodeWords handles Q encoding, including underscore-as-space', () => {
  assert.equal(decodeWords('=?ISO-8859-1?Q?Jos=E9_Garc=EDa?='), 'José García');
  assert.equal(decodeWords('=?utf-8?q?50=25_off?='), '50% off');
});

test('decodeWords keeps surrounding prose and handles mixed charsets', () => {
  const utf = `=?UTF-8?B?${Buffer.from('Ärger', 'utf8').toString('base64')}?=`;
  const latin = '=?ISO-8859-1?Q?caf=E9?=';
  assert.equal(decodeWords(`Re: ${utf} ${latin} (fwd)`), 'Re: Ärgercafé (fwd)');
});

test('decodeWords falls back to lossy utf-8 for a charset nobody has', () => {
  const encoded = `=?x-made-up-charset?B?${Buffer.from('plain', 'utf8').toString('base64')}?=`;
  assert.equal(decodeWords(encoded), 'plain');
});

/* ------------------------------------------------------------------ *
 * decodeTransfer
 * ------------------------------------------------------------------ */

test('decodeTransfer decodes base64 that is wrapped across lines', () => {
  const body = 'The quote is attached and the number is firm.';
  const wrapped = Buffer.from(body, 'utf8').toString('base64').replace(/(.{8})/g, '$1\r\n');
  assert.equal(decodeTransfer(Buffer.from(wrapped, 'latin1'), 'base64').toString('utf8'), body);
});

test('decodeTransfer joins quoted-printable soft line breaks', () => {
  const encoded = Buffer.from(
    'This line was too long for the encoder so it =\r\nwrapped in the middle.\r\nNext line.',
    'latin1',
  );
  assert.equal(
    decodeTransfer(encoded, 'quoted-printable').toString('utf8'),
    'This line was too long for the encoder so it wrapped in the middle.\r\nNext line.',
  );
});

test('decodeTransfer decodes quoted-printable escapes and keeps a lone equals', () => {
  const encoded = Buffer.from('total =3D =E2=82=AC40 (a =? b)', 'latin1');
  assert.equal(decodeTransfer(encoded, 'quoted-printable').toString('utf8'), 'total = €40 (a =? b)');
});

test('decodeTransfer strips insignificant trailing whitespace but keeps encoded spaces', () => {
  const encoded = Buffer.from('trailing removed   \r\nkept=20\r\n', 'latin1');
  assert.equal(
    decodeTransfer(encoded, 'quoted-printable').toString('utf8'),
    'trailing removed\r\nkept \r\n',
  );
});

test('decodeTransfer passes 7bit, 8bit and unknown encodings straight through', () => {
  const buf = Buffer.from([0x68, 0x69, 0xc3, 0xa9]);
  for (const encoding of ['7bit', '8BIT', 'binary', '', undefined, 'x-uuencode']) {
    assert.deepEqual(decodeTransfer(buf, encoding), buf);
  }
});

/* ------------------------------------------------------------------ *
 * decodeCharset
 * ------------------------------------------------------------------ */

test('decodeCharset decodes the charsets mail actually uses', () => {
  assert.equal(decodeCharset(Buffer.from('héllo', 'utf8'), 'UTF-8'), 'héllo');
  assert.equal(decodeCharset(Buffer.from([0x4a, 0x6f, 0x73, 0xe9]), 'iso-8859-1'), 'José');
  assert.equal(decodeCharset(Buffer.from([0x93, 0x68, 0x69, 0x94]), 'windows-1252'), '“hi”');
  assert.equal(decodeCharset(Buffer.from([0x4a, 0x6f, 0x73, 0xe9]), '"LATIN1"'), 'José');
});

test('decodeCharset falls back to lossy utf-8 for an unknown label', () => {
  const utf8 = Buffer.from('naïve', 'utf8');
  assert.equal(decodeCharset(utf8, 'x-nonesuch'), 'naïve');
  assert.equal(decodeCharset(utf8, null), 'naïve');
  assert.equal(decodeCharset(utf8, 'utf-8*en'), 'naïve');
  // Invalid utf-8 becomes replacement characters rather than throwing.
  assert.equal(decodeCharset(Buffer.from([0xff, 0xfe, 0x41]), 'utf-8'), '��A');
});

/* ------------------------------------------------------------------ *
 * parseHeaders
 * ------------------------------------------------------------------ */

test('parseHeaders unfolds, lowercases keys and keeps repeated fields', () => {
  const block = Buffer.from(
    [
      'Subject: a subject that was',
      '  folded across two lines',
      'From: Marcus <marcus@riverstone.example>',
      'Received: from a.example',
      'Received: from b.example',
      'Message-ID: <one@riverstone.example>',
      '',
      'Subject: this is body text, not a header',
    ].join('\r\n'),
    'utf8',
  );
  const headers = parseHeaders(block);
  assert.equal(headers.get('subject')[0], 'a subject that was  folded across two lines');
  assert.equal(headers.get('subject').length, 1, 'the body line must not be parsed as a header');
  assert.deepEqual(headers.get('received'), ['from a.example', 'from b.example']);
  assert.equal(headers.get('message-id')[0], '<one@riverstone.example>');
  assert.equal(headers.get('From'), undefined, 'keys are lowercased');
});

test('parseHeaders reads raw 8-bit header bytes as latin-1 when they are not utf-8', () => {
  const headers = parseHeaders(Buffer.concat([
    Buffer.from('Subject: caf', 'latin1'),
    Buffer.from([0xe9]),
    Buffer.from('\r\n', 'latin1'),
  ]));
  assert.equal(headers.get('subject')[0], 'café');
});

test('parseHeaders ignores lines that are not headers instead of guessing', () => {
  const headers = parseHeaders('garbage line with no colon\r\nSubject: still found\r\n');
  assert.equal(headers.get('subject')[0], 'still found');
  assert.equal(headers.size, 1);
});

/* ------------------------------------------------------------------ *
 * parseAddressList
 * ------------------------------------------------------------------ */

test('parseAddressList keeps a comma that lives inside a quoted display name', () => {
  const list = parseAddressList('"Reyes, Marcus" <marcus@riverstone.example>, jane@aldervance.example');
  assert.deepEqual(list, [
    { name: 'Reyes, Marcus', email: 'marcus@riverstone.example' },
    { name: '', email: 'jane@aldervance.example' },
  ]);
});

test('parseAddressList expands a group and drops its label', () => {
  const list = parseAddressList('Project Team: ann@x.example, bob@y.example;, carol@z.example');
  assert.deepEqual(list.map((a) => a.email), ['ann@x.example', 'bob@y.example', 'carol@z.example']);
});

test('parseAddressList takes a name from a comment', () => {
  assert.deepEqual(parseAddressList('marcus@riverstone.example (Marcus Reyes)'), [
    { name: 'Marcus Reyes', email: 'marcus@riverstone.example' },
  ]);
});

test('parseAddressList decodes encoded display names', () => {
  const encoded = `=?UTF-8?B?${Buffer.from('Ana Müller', 'utf8').toString('base64')}?=`;
  assert.deepEqual(parseAddressList(`${encoded} <ana@x.example>`), [
    { name: 'Ana Müller', email: 'ana@x.example' },
  ]);
});

test('parseAddressList normalises the odd shapes real headers contain', () => {
  assert.deepEqual(parseAddressList('Jane Roe jane@x.example'), [
    { name: 'Jane Roe', email: 'jane@x.example' },
  ]);
  assert.deepEqual(parseAddressList('<@relay.example:real@x.example>'), [
    { name: '', email: 'real@x.example' },
  ]);
  assert.deepEqual(parseAddressList('Marcus@riverstone.example'), [
    { name: '', email: 'marcus@riverstone.example' },
  ]);
  assert.deepEqual(parseAddressList('undisclosed-recipients:;'), []);
  assert.deepEqual(parseAddressList('   '), []);
  assert.deepEqual(parseAddressList('not an address at all'), []);
});

/* ------------------------------------------------------------------ *
 * htmlToText
 * ------------------------------------------------------------------ */

test('htmlToText drops scripts and styles entirely', () => {
  const html = '<style>.a{color:red}</style><p>Visible</p><script>alert("no")</script>';
  const text = htmlToText(html);
  assert.equal(text, 'Visible');
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('color'));
});

test('htmlToText turns block elements into line breaks and decodes entities', () => {
  const html = '<div>Line one</div><p>Line&nbsp;two &amp; a half</p>Line<br>three&hellip;';
  // A closing block and the opening one after it each break the line, so
  // paragraphs stay visually separated instead of running together.
  assert.equal(htmlToText(html), 'Line one\n\nLine two & a half\nLine\nthree…');
});

test('htmlToText collapses runaway whitespace and blank blocks', () => {
  const html = '<p>  spaced   out  </p><p></p><p></p><p>after</p>';
  assert.equal(htmlToText(html), 'spaced out\n\nafter');
});

test('htmlToText never returns markup, even for malformed input', () => {
  const text = htmlToText('<p>hi<img src=x onerror="steal()"><a href="http://x">link</a>');
  assert.ok(!text.includes('<'), text);
  assert.ok(!text.includes('onerror'), text);
  assert.ok(text.includes('link'));
});

test('htmlToText decodes numeric entities and leaves unknown ones alone', () => {
  assert.equal(htmlToText('<p>&#8364;40 &#x2014; &notarealentity;</p>'), '€40 — &notarealentity;');
});

/* ------------------------------------------------------------------ *
 * parseDate
 * ------------------------------------------------------------------ */

test('parseDate preserves the stated offset rather than converting', () => {
  assert.equal(parseDate('Fri, 08 Aug 2026 09:15:00 -0400'), '2026-08-08T09:15:00-04:00');
  assert.equal(parseDate('8 Aug 2026 09:15:00 +0530'), '2026-08-08T09:15:00+05:30');
  assert.equal(parseDate('Fri, 08 Aug 2026 13:15:00 GMT'), '2026-08-08T13:15:00+00:00');
});

test('parseDate handles named zones, -0000, comments and two-digit years', () => {
  assert.equal(parseDate('Fri, 08 Aug 2026 09:15:00 EDT'), '2026-08-08T09:15:00-04:00');
  assert.equal(parseDate('Fri, 08 Aug 2026 09:15:00 -0000'), '2026-08-08T09:15:00+00:00');
  assert.equal(parseDate('Fri, 08 Aug 2026 09:15:00 -0400 (EDT)'), '2026-08-08T09:15:00-04:00');
  assert.equal(parseDate('Fri, 08 Aug 2026 09:15:00 (EST)'), '2026-08-08T09:15:00-05:00');
  assert.equal(parseDate('8 Aug 96 09:15:00 +0000'), '1996-08-08T09:15:00+00:00');
});

test('parseDate reads the IMAP INTERNALDATE shape too', () => {
  assert.equal(parseDate('08-Aug-2026 09:15:00 -0400'), '2026-08-08T09:15:00-04:00');
});

test('parseDate returns null for anything it cannot trust', () => {
  assert.equal(parseDate('31 Feb 2026 09:00:00 +0000'), null);
  assert.equal(parseDate('yesterday afternoon'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate('Fri, 08 Aug 2026 33:15:00 -0400'), null);
});

test('parseDate normalises an already-ISO string', () => {
  assert.equal(parseDate('2026-08-08T09:15:00-04:00'), '2026-08-08T09:15:00-04:00');
  assert.equal(parseDate('2026-08-08T09:15Z'), '2026-08-08T09:15:00+00:00');
});

/* ------------------------------------------------------------------ *
 * threadKeyFor
 * ------------------------------------------------------------------ */

test('threadKeyFor puts a reply and its original on the same key', () => {
  const original = threadKeyFor({
    messageId: '<root@riverstone.example>',
    subject: 'Invoice 4471',
  });
  const reply = threadKeyFor({
    messageId: '<reply@aldervance.example>',
    inReplyTo: '<root@riverstone.example>',
    references: ['<root@riverstone.example>'],
    subject: 'Re: Invoice 4471',
  });
  assert.equal(original, 'root@riverstone.example');
  assert.equal(reply, original);
});

test('threadKeyFor prefers the root of the References chain', () => {
  const key = threadKeyFor({
    messageId: '<c@x>',
    inReplyTo: '<b@x>',
    references: '<a@x> <b@x>',
    subject: 'Re: thing',
  });
  assert.equal(key, 'a@x');
});

test('threadKeyFor falls back to a normalised subject when there are no ids', () => {
  const a = threadKeyFor({ subject: 'Re: Fwd:  Site  walk Friday' });
  const b = threadKeyFor({ subject: 'Site walk Friday' });
  assert.equal(a, 'subject:site walk friday');
  assert.equal(a, b);
  assert.equal(threadKeyFor({}), null);
  assert.equal(threadKeyFor(), null);
});
