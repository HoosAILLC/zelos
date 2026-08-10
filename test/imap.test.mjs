import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  ImapClient,
  fetchRecent,
  guessImapHost,
  isLoopbackHost,
  testConnection,
  tlsRequiredByDefault,
} from '../core/sources/imap.mjs';

// Nothing here reads the Zelos home, but no test should ever be one refactor
// away from writing into the user's real ~/.zelos.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-imap-test-'));
process.env.ZELOS_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

/* ================================================================== *
 * A mock IMAP server.
 *
 * It speaks real IMAP over a real socket on 127.0.0.1 — no stubbing of the
 * client's internals — and records every line the client sends so tests can
 * assert on what actually went over the wire.
 * ================================================================== */

const DEFAULT_GREETING = '* OK [CAPABILITY IMAP4rev1] Zelos mock ready';

function startMockImap({ greeting = DEFAULT_GREETING, onCommand }) {
  const received = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {}); // a client that hangs up mid-test is not a failure
    socket.on('close', () => sockets.delete(socket));
    if (greeting) socket.write(`${greeting}\r\n`);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);

        const parts = line.split(' ');
        let verb = (parts[1] || '').toUpperCase();
        let argStart = 2;
        if (verb === 'UID') {
          verb = `UID ${(parts[2] || '').toUpperCase()}`;
          argStart = 3;
        }
        onCommand({
          line,
          tag: parts[0] || '',
          verb,
          args: parts.slice(argStart).join(' '),
          socket,
          send: (text) => socket.write(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')),
        });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        async close() {
          for (const socket of sockets) socket.destroy();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/** Handles the boilerplate every session needs; `extra` answers the rest. */
function session({ capability = 'IMAP4rev1', exists = 3, extra }) {
  return (ctx) => {
    const { tag, verb, send } = ctx;
    switch (verb) {
      case 'CAPABILITY':
        send(`* CAPABILITY ${capability}\r\n${tag} OK CAPABILITY completed\r\n`);
        return;
      case 'LOGIN':
        send(`${tag} OK LOGIN completed\r\n`);
        return;
      case 'EXAMINE':
      case 'SELECT':
        send(
          `* ${exists} EXISTS\r\n` +
            '* OK [UIDVALIDITY 1234567890] UIDs valid\r\n' +
            '* OK [UIDNEXT 9001] Predicted next UID\r\n' +
            '* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n' +
            `${tag} OK [READ-ONLY] EXAMINE completed\r\n`,
        );
        return;
      case 'LOGOUT':
        send(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
        return;
      default:
        if (extra && extra(ctx)) return;
        send(`${tag} BAD unexpected command in mock\r\n`);
    }
  };
}

/** `* n FETCH (… BODY[section] {len}\r\n<payload>)` as exact bytes. */
function fetchLine({ seq, uid, items = '', section, payload }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([
    Buffer.from(`* ${seq} FETCH (UID ${uid}${items ? ` ${items}` : ''} BODY[${section}] {${body.length}}\r\n`, 'utf8'),
    body,
    Buffer.from(')\r\n', 'utf8'),
  ]);
}

const HEADER_SECTION = 'HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID)';

/**
 * Answers UID SEARCH and both UID FETCH passes from a list of fixtures.
 * Each fixture: {uid, flags, internalDate, structure, headers, parts:{[n]:payload}}
 */
function mailbox(messages, { write = (send, buf) => send(buf) } = {}) {
  const byUid = new Map(messages.map((m) => [String(m.uid), m]));
  return ({ tag, verb, args, send }) => {
    if (verb === 'UID SEARCH') {
      send(`* SEARCH ${messages.map((m) => m.uid).join(' ')}\r\n${tag} OK UID SEARCH completed\r\n`);
      return true;
    }
    if (verb !== 'UID FETCH') return false;

    const set = args.slice(0, args.indexOf('(')).trim().split(',').filter(Boolean);
    const wanted = set.map((uid) => byUid.get(uid)).filter(Boolean);
    const spec = args.slice(args.indexOf('('));

    if (spec.includes('BODYSTRUCTURE')) {
      wanted.forEach((m, i) => {
        write(send, fetchLine({
          seq: i + 1,
          uid: m.uid,
          items: `FLAGS (${m.flags ?? '\\Seen'}) INTERNALDATE "${m.internalDate}" BODYSTRUCTURE ${m.structure}`,
          section: HEADER_SECTION,
          payload: m.headers,
        }));
      });
    } else {
      const part = /BODY\.PEEK\[([^\]]*)\]/.exec(spec)?.[1] ?? '1';
      wanted.forEach((m, i) => {
        const payload = m.parts?.[part];
        if (payload === undefined) return;
        write(send, fetchLine({ seq: i + 1, uid: m.uid, section: part, payload }));
      });
    }
    send(`${tag} OK UID FETCH completed\r\n`);
    return true;
  };
}

const PLAIN_TEXT_STRUCTURE = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 120 4 NIL NIL NIL NIL)';

/** Every command line the client sent, minus its tag. */
function commands(received) {
  return received.map((line) => line.replace(/^\S+\s*/, ''));
}

async function withServer(options, fn) {
  const server = await startMockImap(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

/* ================================================================== *
 * Literals
 * ================================================================== */

test('a literal carrying CRLF, ")" and a fake literal marker is parsed intact', async () => {
  const headers = [
    'From: "Reyes, Marcus" <marcus@riverstone.example>',
    'To: Nemo Hale <nemo@northgate.example>, "Roe, Jane" <jane@aldervance.example>',
    'Subject: Re: change order (final) ) and a stray paren',
    'X-Decoy: this line ends with what looks like a literal {7}',
    'Date: Fri, 08 Aug 2026 09:15:00 -0400',
    'Message-ID: <a1@riverstone.example>',
    'In-Reply-To: <root@aldervance.example>',
    'References: <root@aldervance.example> <a0@riverstone.example>',
    '',
    '',
  ].join('\r\n');

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 101,
            internalDate: '08-Aug-2026 09:15:00 -0400',
            structure: PLAIN_TEXT_STRUCTURE,
            headers,
            parts: { 1: 'Numbers are firm.\r\n\r\nThanks,\r\nMarcus\r\n' },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      const messages = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'pw', timeoutMs: 5000,
      });

      assert.equal(messages.length, 1);
      const [msg] = messages;
      assert.equal(msg.subject, 'Re: change order (final) ) and a stray paren');
      assert.deepEqual(msg.from, { name: 'Reyes, Marcus', email: 'marcus@riverstone.example' });
      assert.deepEqual(msg.to, [
        { name: 'Nemo Hale', email: 'nemo@northgate.example' },
        { name: 'Roe, Jane', email: 'jane@aldervance.example' },
      ]);
      assert.equal(msg.date, '2026-08-08T09:15:00-04:00');
      assert.equal(msg.messageId, 'a1@riverstone.example');
      assert.deepEqual(msg.references, ['root@aldervance.example', 'a0@riverstone.example']);
      assert.equal(msg.threadKey, 'root@aldervance.example');
      assert.equal(msg.text, 'Numbers are firm.\n\nThanks,\nMarcus');
      assert.equal(msg.snippet, 'Numbers are firm. Thanks, Marcus');
      assert.equal(msg.folder, 'INBOX');
      assert.deepEqual(msg.flags, ['\\Seen']);
      assert.equal(msg.hasAttachments, false);

      // The decoy "{7}" inside the literal must not have been read as a length.
      assert.ok(commands(received).some((c) => c === 'LOGOUT'), 'the session ran to completion');
    },
  );
});

test('a literal that opens with a space and closes with one keeps every byte', async () => {
  // Whitespace is how the tokenizer separates values, so a literal payload that
  // starts with a space is the case where an over-eager parser eats data.
  const payload = ' )not the end\r\nstill inside the literal ';
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID FETCH') return false;
          const body = Buffer.from(payload, 'utf8');
          send(Buffer.concat([
            Buffer.from(`* 1 FETCH (UID 9 BODY[TEXT] {${body.length}}\r\n`, 'utf8'),
            body,
            Buffer.from(` FLAGS (\\Answered \\Seen))\r\n${tag} OK UID FETCH completed\r\n`, 'utf8'),
          ]));
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      const [row] = await client.fetch([9], 'UID BODY.PEEK[TEXT]');
      assert.equal(row.uid, 9);
      assert.equal(row.sections.get('TEXT').toString('utf8'), payload);
      assert.deepEqual(row.flags, ['\\Answered', '\\Seen'], 'parsing resumed after the literal');
      await client.close();
    },
  );
});

test('a zero-length literal is kept as an empty value so FETCH pairing holds', async () => {
  // "{0}" is a legal literal — an empty body part, say — and it is still a
  // value. Dropping it shifts every FETCH item after it onto the wrong key,
  // which is how this exact wire once parsed UID 9 into uid null.
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID FETCH') return false;
          send(`* 1 FETCH (BODY[1] {0}\r\n UID 9)\r\n${tag} OK UID FETCH completed\r\n`);
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      const [row] = await client.fetch([9], 'UID BODY.PEEK[1]');
      assert.equal(row.uid, 9, 'the UID that follows the empty literal must not shift into its slot');
      const section = row.sections.get('1');
      assert.ok(Buffer.isBuffer(section), 'the empty literal is a value, not a hole');
      assert.equal(section.length, 0);
      await client.close();
    },
  );
});

test('HEADER.FIELDS matching nothing comes back as {0} and pairs cleanly', async () => {
  // A message with none of the requested headers is served as a zero-length
  // literal; the items after it must still land on their own keys.
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID FETCH') return false;
          send(`* 1 FETCH (BODY[HEADER.FIELDS (X-NOPE)] {0}\r\n UID 12 FLAGS (\\Seen))\r\n${tag} OK UID FETCH completed\r\n`);
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      const [row] = await client.fetch([12], 'UID FLAGS BODY.PEEK[HEADER.FIELDS (X-NOPE)]');
      assert.equal(row.uid, 12);
      assert.deepEqual(row.flags, ['\\Seen'], 'FLAGS pairs with its own list, not a shifted neighbour');
      const section = row.sections.get('HEADER.FIELDS (X-NOPE)');
      assert.ok(Buffer.isBuffer(section));
      assert.equal(section.length, 0);
      await client.close();
    },
  );
});

test('an empty search result short-circuits without fetching anything', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID SEARCH') return false;
          send(`* SEARCH\r\n${tag} OK UID SEARCH completed\r\n`);
          return true;
        },
      }),
    },
    async ({ port, received }) => {
      const messages = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      assert.deepEqual(messages, []);
      assert.ok(!commands(received).some((c) => c.startsWith('UID FETCH')), 'nothing to fetch, nothing fetched');
    },
  );
});

test('a dropped connection rejects queued commands as well as the in-flight one', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ verb, socket }) => {
          if (verb !== 'UID SEARCH') return false;
          socket.destroy();
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();

      // Two commands issued back to back: one goes on the wire, one waits in
      // the queue. Neither may be left hanging when the socket dies.
      const results = await Promise.allSettled([client.search(['ALL']), client.search(['UNSEEN'])]);
      assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
      for (const result of results) {
        assert.match(result.reason.message, /IMAP 127\.0\.0\.1:\d+/);
      }
      await client.close();
    },
  );
});

/* ================================================================== *
 * The commands that go on the wire
 * ================================================================== */

test('the client only ever uses UID commands, BODY.PEEK, and read-only EXAMINE', async () => {
  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 101,
            internalDate: '08-Aug-2026 09:15:00 -0400',
            structure: PLAIN_TEXT_STRUCTURE,
            headers: 'Subject: hello\r\nFrom: a@b.example\r\nDate: Fri, 08 Aug 2026 09:15:00 -0400\r\n\r\n',
            parts: { 1: 'body\r\n' },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'pw', timeoutMs: 5000 });
      const sent = commands(received);

      // BODY[ without PEEK sets \Seen. It must never appear.
      for (const line of received) {
        assert.ok(!/\bBODY\s*\[/i.test(line), `command marks mail as read: ${line}`);
      }
      assert.ok(sent.some((c) => c.includes('BODY.PEEK[')), 'bodies are fetched with PEEK');

      assert.ok(sent.some((c) => c.startsWith('UID SEARCH ')), 'search is by UID');
      assert.ok(sent.some((c) => c.startsWith('UID FETCH ')), 'fetch is by UID');
      assert.ok(!sent.some((c) => /^(SEARCH|FETCH)\b/.test(c)), 'no sequence-number commands');

      assert.ok(sent.some((c) => c === 'EXAMINE "INBOX"'), 'the mailbox is opened read-only');
      assert.ok(!sent.some((c) => c.startsWith('SELECT ')), 'SELECT would allow \\Seen to be set');

      assert.ok(
        sent.some((c) =>
          /^UID FETCH [\d,]+ \(UID FLAGS INTERNALDATE BODYSTRUCTURE BODY\.PEEK\[HEADER\.FIELDS \(FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID\)\]\)$/.test(c)),
        `cheap first pass not as specified: ${sent.join(' | ')}`,
      );
      assert.ok(sent.some((c) => /^UID FETCH [\d,]+ \(UID BODY\.PEEK\[1\]\)$/.test(c)), 'second pass pulls one part');
    },
  );
});

test('fetch() refuses to put a \\Seen-setting BODY[...] on the wire', async () => {
  await withServer({ onCommand: session({}) }, async ({ port, received }) => {
    const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
    await client.connect();
    await client.login();
    await assert.rejects(
      () => client.fetch([1], 'UID BODY[]'),
      /refusing to send BODY\[/,
    );
    assert.ok(!received.some((line) => /\bBODY\s*\[/i.test(line)), 'nothing was sent');
    await client.close();
  });
});

test('UID sets are chunked to at most 100 per command', async () => {
  const uids = Array.from({ length: 250 }, (_, i) => 1000 + i);
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb === 'UID SEARCH') {
            send(`* SEARCH ${uids.join(' ')}\r\n${tag} OK UID SEARCH completed\r\n`);
            return true;
          }
          if (verb === 'UID FETCH') {
            send(`${tag} OK UID FETCH completed\r\n`);
            return true;
          }
          return false;
        },
      }),
    },
    async ({ port, received }) => {
      await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', limit: 250, timeoutMs: 5000 });
      const fetches = commands(received).filter((c) => c.startsWith('UID FETCH '));
      assert.equal(fetches.length, 3, 'three chunks for 250 uids');
      const counts = fetches.map((c) => c.split(' ')[2].split(',').length);
      assert.deepEqual(counts, [100, 100, 50]);
      const all = fetches.flatMap((c) => c.split(' ')[2].split(',').map(Number));
      assert.equal(new Set(all).size, 250, 'every uid was requested exactly once');
    },
  );
});

/* ================================================================== *
 * Decoding real message shapes
 * ================================================================== */

test('an RFC 2047 base64 UTF-8 subject survives the round trip', async () => {
  const subject = 'Überfällige Zahlung für März — Projekt Süd';
  const half = Math.ceil(Buffer.byteLength(subject, 'utf8') / 2);
  const bytes = Buffer.from(subject, 'utf8');
  // Deliberately split the encoded words mid-character, the way real mailers do.
  const word = (buf) => `=?UTF-8?B?${buf.toString('base64')}?=`;
  const headers = [
    `Subject: ${word(bytes.subarray(0, half))}`,
    ` ${word(bytes.subarray(half))}`,
    'From: =?UTF-8?Q?Ana_M=C3=BCller?= <ana@sued.example>',
    'Date: Fri, 08 Aug 2026 11:00:00 +0200',
    'Message-ID: <m2@sued.example>',
    '',
    '',
  ].join('\r\n');

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 77,
            internalDate: '08-Aug-2026 11:00:00 +0200',
            structure: PLAIN_TEXT_STRUCTURE,
            headers,
            parts: { 1: 'Bitte prüfen.\r\n' },
          },
        ]),
      }),
    },
    async ({ port }) => {
      const [msg] = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000,
      });
      assert.equal(msg.subject, subject);
      assert.deepEqual(msg.from, { name: 'Ana Müller', email: 'ana@sued.example' });
      assert.equal(msg.date, '2026-08-08T11:00:00+02:00');
    },
  );
});

test('a multipart message with no text/plain falls back to the html part', async () => {
  const structure =
    '((("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 412 12 NIL NIL NIL NIL)' +
    ' "ALTERNATIVE" ("BOUNDARY" "b2") NIL NIL NIL)' +
    '("APPLICATION" "PDF" ("NAME" "quote.pdf") NIL NIL "BASE64" 90210 NIL' +
    ' ("attachment" ("FILENAME" "quote.pdf")) NIL NIL)' +
    ' "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)';

  const html =
    '<html><body><p>Hi Nemo,</p><p>The change order is approved =\r\n' +
    'at the number we discussed &euro;4,200.</p><style>p{color:red}</style></body></html>';

  const plainStructure = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 200 5 NIL NIL NIL NIL)';
  const plainBody =
    'Marcus,\r\n\r\nThe number we agreed was =E2=82=AC4,200 and the schedule =\r\nholds through Friday.\r\n';

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 201,
            internalDate: '08-Aug-2026 12:00:00 -0400',
            structure,
            headers: 'Subject: Change order approved\r\nFrom: pm@aldervance.example\r\nDate: Fri, 08 Aug 2026 12:00:00 -0400\r\nMessage-ID: <m201@aldervance.example>\r\n\r\n',
            parts: { '1.1': html },
          },
          {
            uid: 202,
            internalDate: '08-Aug-2026 08:00:00 -0400',
            structure: plainStructure,
            headers: 'Subject: Re: Change order\r\nFrom: nemo@northgate.example\r\nDate: Fri, 08 Aug 2026 08:00:00 -0400\r\nMessage-ID: <m202@northgate.example>\r\n\r\n',
            parts: { 1: plainBody },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      const messages = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000,
      });
      assert.equal(messages.length, 2);

      const htmlMessage = messages.find((m) => m.uid === 201);
      assert.equal(
        htmlMessage.text,
        'Hi Nemo,\n\nThe change order is approved at the number we discussed €4,200.',
      );
      assert.ok(!htmlMessage.text.includes('<'), 'no markup reaches the caller');
      assert.equal(htmlMessage.hasAttachments, true, 'the pdf part is an attachment');

      const plainMessage = messages.find((m) => m.uid === 202);
      assert.equal(
        plainMessage.text,
        'Marcus,\n\nThe number we agreed was €4,200 and the schedule holds through Friday.',
      );
      assert.equal(plainMessage.hasAttachments, false);

      // Newest first.
      assert.deepEqual(messages.map((m) => m.uid), [201, 202]);

      const sent = commands(received);
      assert.ok(sent.some((c) => c.includes('BODY.PEEK[1.1]')), 'the nested html part number was resolved');
      assert.ok(sent.some((c) => /\(UID BODY\.PEEK\[1\]\)$/.test(c)), 'the plain message used part 1');
    },
  );
});

test('a message with no usable BODYSTRUCTURE falls back to the TEXT section', async () => {
  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 300,
            internalDate: '08-Aug-2026 07:30:00 -0400',
            structure: 'NIL',
            headers: 'Subject: no structure\r\nFrom: odd@server.example\r\nDate: Fri, 08 Aug 2026 07:30:00 -0400\r\n\r\n',
            parts: { TEXT: 'The server would not describe this message.\r\n' },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      const [msg] = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      assert.equal(msg.text, 'The server would not describe this message.');
      assert.equal(msg.hasAttachments, false);
      assert.ok(commands(received).some((c) => c.includes('BODY.PEEK[TEXT]')));
    },
  );
});

/* ================================================================== *
 * Transport hazards
 * ================================================================== */

test('a response split mid-multibyte-character across TCP packets still decodes', async () => {
  const subject = 'Überfällig — Zahlung für März';
  const headers = [
    `Subject: ${subject}`, // raw 8-bit header, as plenty of mailers still send
    'From: Ana <ana@sued.example>',
    'Date: Fri, 08 Aug 2026 11:00:00 +0200',
    'Message-ID: <split@sued.example>',
    '',
    '',
  ].join('\r\n');
  const body = 'Grüße aus München — bitte prüfen.\r\n';

  // Write each response in three packets: the first ends between the CR and LF
  // that terminate the literal marker, the second ends between the two bytes of
  // a multi-byte character inside the payload.
  const splittingWrite = (send, buf) => {
    const afterMarker = buf.indexOf(Buffer.from('}\r\n', 'utf8')) + 3;
    let lead = -1;
    for (let i = afterMarker; i < buf.length; i++) {
      if (buf[i] >= 0xc0) { lead = i; break; }
    }
    assert.ok(lead > afterMarker, 'fixture must contain a multibyte character in the payload');
    send(buf.subarray(0, afterMarker - 1));
    send(buf.subarray(afterMarker - 1, lead + 1));
    send(buf.subarray(lead + 1));
  };

  await withServer(
    {
      onCommand: session({
        extra: mailbox(
          [
            {
              uid: 55,
              internalDate: '08-Aug-2026 11:00:00 +0200',
              structure: PLAIN_TEXT_STRUCTURE,
              headers,
              parts: { 1: body },
            },
          ],
          { write: splittingWrite },
        ),
      }),
    },
    async ({ port }) => {
      const [msg] = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000,
      });
      assert.equal(msg.subject, subject);
      assert.equal(msg.text, 'Grüße aus München — bitte prüfen.');
    },
  );
});

test('an authentication failure rejects with the host and the server code', async () => {
  await withServer(
    {
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'LOGIN') {
          send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'bad', timeoutMs: 5000 });
      await client.connect();
      await assert.rejects(
        () => client.login(),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/, 'the error names the host');
          assert.match(err.message, /AUTHENTICATIONFAILED/);
          assert.equal(err.status, 'NO');
          assert.equal(err.code, 'AUTHENTICATIONFAILED');
          assert.equal(err.host, '127.0.0.1');
          return true;
        },
      );
      await client.close();
    },
  );
});

test('testConnection reports the failure instead of throwing', async () => {
  await withServer(
    {
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'LOGIN') {
          send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port }) => {
      const result = await testConnection({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'bad', timeoutMs: 5000 });
      assert.equal(result.ok, false);
      assert.match(result.error, /AUTHENTICATIONFAILED/);
      assert.match(result.error, /127\.0\.0\.1/);
      assert.deepEqual(result.mailboxes, []);
    },
  );
});

test('* BYE followed by a dropped connection rejects the in-flight command', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ verb, send, socket }) => {
          if (verb !== 'UID SEARCH') return false;
          send('* BYE Server shutting down for maintenance\r\n');
          setTimeout(() => socket.destroy(), 10);
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      await client.select('INBOX');
      await assert.rejects(
        () => client.search(['ALL']),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          assert.match(err.message, /Server shutting down for maintenance/);
          return true;
        },
      );
      await client.close();
    },
  );
});

test('a server that never answers times out with a message naming the host', async () => {
  await withServer(
    {
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'CAPABILITY' || verb === 'LOGIN') send(`${tag} OK fine\r\n`);
        // Everything else: silence.
      },
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 250 });
      await client.connect();
      await client.login();
      await assert.rejects(
        () => client.select('INBOX'),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          assert.match(err.message, /for 250ms/);
          return true;
        },
      );
      await client.close();
    },
  );
});

/* ================================================================== *
 * Authentication paths
 * ================================================================== */

test('LOGINDISABLED switches to AUTHENTICATE PLAIN and never sends the password as a command argument', async () => {
  const password = 'correct horse battery staple';
  let credentials = null;
  let authTag = null;

  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, line, send }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        if (verb === 'AUTHENTICATE') {
          authTag = tag;
          send('+ \r\n');
          return;
        }
        if (authTag && !line.includes(' ')) {
          // The SASL payload arrives as a bare line, with no tag of its own.
          credentials = Buffer.from(line, 'base64').toString('utf8').split('\0');
          send(`${authTag} OK AUTHENTICATE completed\r\n`);
          authTag = null;
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: password, timeoutMs: 5000 });
      await client.connect();
      await client.login();
      assert.deepEqual(credentials, ['', 'nemo', password]);
      assert.ok(commands(received).includes('AUTHENTICATE PLAIN'));
      assert.ok(!received.some((line) => line.includes(password)), 'the password never appears in clear text');
      await client.close();
    },
  );
});

test('a plaintext connection upgrades when the server advertises STARTTLS', async () => {
  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send, socket }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        if (verb === 'STARTTLS') {
          send(`${tag} OK Begin TLS negotiation now\r\n`);
          // This mock cannot actually do TLS; dropping the socket proves the
          // client attempted the handshake and reports the failure honestly.
          setTimeout(() => socket.destroy(), 10);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 3000 });
      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.match(err.message, /STARTTLS handshake failed/);
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          return true;
        },
      );
      assert.ok(commands(received).includes('STARTTLS'), 'the upgrade was attempted before any credentials');
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)), 'no credentials on the plaintext socket');
      await client.close();
    },
  );
});

/* ================================================================== *
 * Requiring TLS
 *
 * REGRESSION. With `secure: false` the client offered to upgrade and then went
 * ahead regardless, because "the server did not advertise STARTTLS" and "there
 * is nobody in the middle" look identical from here. Stripping one word out of
 * a CAPABILITY reply was enough to be handed the password in the clear, and
 * nothing anywhere said so.
 * ================================================================== */

test('the TLS requirement is on by default everywhere except loopback', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', 'LOCALHOST',
    'bridge.localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(tlsRequiredByDefault(host), false, host);
  }
  // Near-misses. Each of these is a real network address that has fooled a
  // loopback check written with `includes` or `startsWith` somewhere before.
  for (const host of ['imap.example.com', '192.168.1.10', '128.0.0.1', '10.0.0.1',
    '127.0.0.1.evil.example', 'localhost.evil.example', 'notlocalhost', '227.0.0.1',
    '127.0.0.999', '::ffff:8.8.8.8', '']) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.equal(tlsRequiredByDefault(host), true, host);
  }
});

test('a client takes its TLS requirement from the host, and an explicit setting wins', () => {
  assert.equal(new ImapClient({ host: 'imap.example.com', secure: false }).requireTls, true);
  assert.equal(new ImapClient({ host: '127.0.0.1', port: 1143, secure: false }).requireTls, false);
  assert.equal(new ImapClient({ host: 'imap.example.com', secure: false, requireTls: false }).requireTls, false);
  assert.equal(new ImapClient({ host: '127.0.0.1', secure: false, requireTls: true }).requireTls, true);
  // Anything that is not a deliberate `false` is a requirement. A form field
  // that arrives as the string "false" must not switch encryption off.
  assert.equal(new ImapClient({ host: '127.0.0.1', secure: false, requireTls: 'false' }).requireTls, true);
});

test('a server that never offers STARTTLS gets no credentials, and says why', async () => {
  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send }) => {
        // A capability list with STARTTLS quietly removed — exactly what a
        // machine in the middle would send.
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({
        host: '127.0.0.1', port, secure: false, requireTls: true,
        user: 'nemo', pass: 'hunter2', timeoutMs: 3000,
      });

      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          assert.match(err.message, /still in the clear/);
          assert.match(err.message, /never offered STARTTLS/);
          assert.match(err.message, /requireTls/, 'the error has to name the way out');
          return true;
        },
      );
      // And the credential gate holds on its own, without connect() in front.
      await assert.rejects(() => client.login(), /still in the clear/);

      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)),
        `credentials went out over cleartext: ${received.join(' | ')}`);
      assert.ok(!received.some((line) => line.includes('hunter2')));
      await client.close();
    },
  );
});

test('a loopback bridge still connects and logs in with no TLS at all', async () => {
  await withServer(
    { greeting: '* OK Zelos mock ready', onCommand: session({}) },
    async ({ port, received }) => {
      // No requireTls given: 127.0.0.1 is where Proton Bridge lives, and that
      // is the documented reason plaintext is still allowed.
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'p', timeoutMs: 3000 });
      await client.connect();
      await client.login();
      assert.ok(commands(received).some((c) => c.startsWith('LOGIN')), 'the bridge case must keep working');
      await client.close();
    },
  );
});

test('testConnection carries the requirement through and reports it as a failure', async () => {
  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const refused = await testConnection({
        host: '127.0.0.1', port, secure: false, requireTls: true, user: 'nemo', pass: 'hunter2', timeoutMs: 3000,
      });
      assert.equal(refused.ok, false);
      assert.match(refused.error, /still in the clear/);
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)));
    },
  );
});

/* ================================================================== *
 * Mailboxes
 * ================================================================== */

test('listMailboxes decodes modified UTF-7 names and reports special-use folders', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'LIST') return false;
          send(
            '* LIST (\\HasNoChildren) "/" "INBOX"\r\n' +
              '* LIST (\\HasNoChildren \\Sent) "/" "Gesendete Objekte"\r\n' +
              '* LIST (\\HasNoChildren \\Trash) "/" "Gel&APY-schte Objekte"\r\n' +
              '* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"\r\n' +
              `${tag} OK LIST completed\r\n`,
          );
          return true;
        },
      }),
    },
    async ({ port }) => {
      const result = await testConnection({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      assert.equal(result.ok, true, result.error ?? '');
      assert.deepEqual(result.mailboxes.map((m) => m.name), [
        'INBOX',
        'Gesendete Objekte',
        'Gelöschte Objekte',
        '[Gmail]',
      ]);
      assert.deepEqual(result.mailboxes.map((m) => m.specialUse), ['inbox', 'sent', 'trash', null]);
      assert.equal(result.mailboxes[0].delimiter, '/');
      assert.ok(result.capabilities.includes('IMAP4REV1'));
    },
  );
});

test('select reports the mailbox facts the sync needs', async () => {
  await withServer({ onCommand: session({ exists: 42 }) }, async ({ port }) => {
    const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
    await client.connect();
    await client.login();
    const box = await client.select('INBOX');
    assert.equal(box.exists, 42);
    assert.equal(box.uidValidity, 1234567890);
    assert.equal(box.uidNext, 9001);
    assert.ok(box.flags.includes('\\Seen'));
    assert.equal(box.readOnly, true);
    await client.close();
  });
});

/* ================================================================== *
 * guessImapHost
 * ================================================================== */

test('guessImapHost knows the providers that need an app password', () => {
  const appPassword = /app[- ]?(specific[- ])?password/i;

  const gmail = guessImapHost('nemo@gmail.com');
  assert.equal(gmail.host, 'imap.gmail.com');
  assert.equal(gmail.port, 993);
  assert.equal(gmail.secure, true);
  assert.match(gmail.note, appPassword);

  const icloud = guessImapHost('Nemo@ICLOUD.com');
  assert.equal(icloud.host, 'imap.mail.me.com');
  assert.match(icloud.note, appPassword);

  const yahoo = guessImapHost('nemo@ymail.com');
  assert.equal(yahoo.host, 'imap.mail.yahoo.com');
  assert.match(yahoo.note, appPassword);
});

test('guessImapHost covers the other common providers and degrades sensibly', () => {
  assert.equal(guessImapHost('a@outlook.com').host, 'outlook.office365.com');
  assert.equal(guessImapHost('a@fastmail.com').host, 'imap.fastmail.com');

  const proton = guessImapHost('a@proton.me');
  assert.equal(proton.host, '127.0.0.1');
  assert.equal(proton.port, 1143);
  assert.equal(proton.secure, false);
  assert.match(proton.note, /Bridge/);

  const guessed = guessImapHost('marcus@deco-associates.example');
  assert.equal(guessed.host, 'imap.deco-associates.example');
  assert.equal(guessed.port, 993);
  assert.ok(guessed.note.length > 0);

  for (const bad of ['', null, 'not-an-email', 'a@localhost']) {
    const result = guessImapHost(bad);
    assert.equal(result.host, '');
    assert.equal(result.port, 993);
    assert.ok(result.note.length > 0, 'the user is always told what to do next');
  }
});
