/**
 * test/connector-whatsapp.test.mjs — the export parser, across the shapes a
 * real person's file actually has.
 *
 * There is no WhatsApp API to test against and that is the point of the
 * connector: the Business Cloud API has no read endpoint, and the libraries
 * that read a personal account risk the account. What this reads is a file the
 * user exported themselves, so the whole risk surface is the parser, and the
 * parser's whole risk is that "the WhatsApp export format" is not one format.
 *
 * It differs by platform (iOS brackets the timestamp, Android does not), by
 * clock (12h with AM/PM, or 24h), by date order (d/m/y nearly everywhere,
 * m/d/y in the US), by separator, and by digit set. A parser written against
 * one locale works for the person who wrote it and silently drops everybody
 * else's messages — silently, because an unparsed line looks exactly like a
 * continuation of the previous one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const whatsappModule = await import('../core/connectors/whatsapp.mjs');
const {
  parseExport, parseHeader, classifyBody, resolveOwner, rowFor, normalizeDigits,
} = whatsappModule;
const whatsapp = whatsappModule.default;

/* ------------------------------------------------------------------ *
 * The platform and locale matrix
 * ------------------------------------------------------------------ */

test('every platform and clock shape a real export uses is parsed, not swallowed', () => {
  const shapes = [
    {
      name: 'iOS, 24h, bracketed',
      text: '[09/08/2026, 14:02:11] Kit Alder: Retainage schedule is posted',
    },
    {
      name: 'iOS, 12h, bracketed',
      text: '[09/08/2026, 2:02:11 PM] Kit Alder: Retainage schedule is posted',
    },
    {
      name: 'Android, 24h, dash',
      text: '09/08/2026, 14:02 - Kit Alder: Retainage schedule is posted',
    },
    {
      name: 'Android, 12h, dash',
      text: '09/08/2026, 2:02 pm - Kit Alder: Retainage schedule is posted',
    },
  ];

  for (const shape of shapes) {
    const header = parseHeader(shape.text);
    assert.ok(header, `${shape.name}: the header did not parse, so this whole export reads as one run-on message`);
    const parsed = parseExport(shape.text, { timezone: 'UTC' });
    assert.equal(parsed.messages.length, 1, `${shape.name}: message lost`);
    assert.equal(parsed.messages[0].sender, 'Kit Alder', `${shape.name}: sender lost`);
    assert.match(parsed.messages[0].text, /Retainage schedule is posted/, `${shape.name}: body lost`);
  }
});

test('an unambiguous day disambiguates the date order for the whole file', () => {
  /* `09/08/2026` is a real date under both readings, so no single line can
     settle it — but `13/08/2026` can only be d/m/y, and one such line anywhere
     in the file settles every other line in it. Getting this wrong moves every
     message in the export by up to eleven months, which puts a conversation
     from last week outside the sweep window and onto no board at all. */
  const dmy = [
    '[13/08/2026, 09:00:00] Kit Alder: the thirteenth is not a month',
    '[09/08/2026, 09:01:00] Kit Alder: so this one is the ninth of August',
  ].join('\n');

  const parsed = parseExport(dmy, { timezone: 'UTC' });
  assert.equal(parsed.order, 'dmy', 'a day over twelve did not settle the order');
  assert.match(parsed.messages[1].iso, /^2026-08-09/, 'the ambiguous line was read in the wrong order');

  // And the override beats the heuristic, because a file with no unambiguous
  // day in it is genuinely undecidable from its content alone.
  const forced = parseExport('[09/08/2026, 09:00:00] Kit Alder: hello', { timezone: 'UTC', order: 'dmy' });
  assert.match(forced.messages[0].iso, /^2026-08-09/, 'the explicit order was ignored');
});

test('a message that wraps is one message, not one per line', () => {
  const wrapped = [
    '[09/08/2026, 14:04:00] Kit Alder: It spans',
    'two lines',
    'and a third',
    '[09/08/2026, 14:05:00] Nemo Hale: Understood',
  ].join('\n');

  const parsed = parseExport(wrapped, { timezone: 'UTC', order: 'dmy' });
  assert.equal(parsed.messages.length, 2, 'a wrapped message was split, or a real one was eaten');
  assert.match(parsed.messages[0].text, /It spans\ntwo lines\nand a third/,
    'the continuation lines did not join the message they belong to');
});

test('system lines are counted, never filed as somebody saying something', () => {
  /* These carry no sender and are not obligations. Filing the encryption
     notice as a message from a person is how a board grows an item nobody
     wrote and nobody can action. */
  const withSystem = [
    'Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
    '[09/08/2026, 14:00:00] Kit Alder created group "Alder site"',
    '[09/08/2026, 14:02:00] Kit Alder: a real message',
    '[09/08/2026, 14:03:00] Nemo Hale: ‎image omitted',
  ].join('\n');

  const parsed = parseExport(withSystem, { timezone: 'UTC', order: 'dmy' });
  const bodies = parsed.messages.map((m) => m.text);
  assert.ok(!bodies.some((b) => /end-to-end encrypted/.test(b)), 'the encryption notice was filed as a message');
  assert.ok(!bodies.some((b) => /created group/.test(b)), 'a group-creation line was filed as a message');
  assert.ok(parsed.systemCount >= 1, 'system lines were dropped without being counted');
  assert.ok(bodies.some((b) => /a real message/.test(b)), 'a real message was lost among the system lines');
});

test('classifyBody knows an attachment placeholder from a sentence', () => {
  /* It is handed the WHOLE body after the timestamp — `Sender: text` — not the
     text alone, because "is there a sender" is most of what separates a message
     from a system line. A bare sentence with no sender prefix is therefore
     correctly a system line: that is what WhatsApp's own notices look like. */
  assert.equal(classifyBody('Kit Alder: Bring the schedule of values.').kind, 'message');
  assert.notEqual(classifyBody('Messages and calls are end-to-end encrypted.').kind, 'message');
  assert.notEqual(classifyBody('Kit Alder created group "Alder site"').kind, 'message');

  /* An attachment placeholder stays a MESSAGE, flagged rather than discarded,
     and that is the right call rather than a missed case: a person really did
     send something at that moment, and dropping the line would leave a silence
     in the conversation where a photo was. The flag is what lets the board say
     "sent a photo" instead of showing an empty row. */
  const img = classifyBody('Kit Alder: ‎image omitted');
  assert.equal(img.kind, 'message', 'an attachment is something a person sent, not a system notice');
  assert.equal(img.attached, true, 'the attachment is not flagged, so the row reads as an empty message');
  assert.equal(classifyBody('Kit Alder: Bring the schedule of values.').attached, false);

  // A colon inside the message must not be mistaken for the sender delimiter.
  const colon = classifyBody('Kit Alder: 9:30 works for me');
  assert.equal(colon.kind, 'message');
  assert.equal(colon.sender, 'Kit Alder', 'the split took the wrong colon');
});

test('non-ASCII digits in a timestamp are read, not refused', () => {
  // Arabic-Indic digits appear in exports from Arabic and Persian locales, and
  // a parser that only knows 0-9 reads such a file as zero messages.
  assert.equal(normalizeDigits('١٣'), '13');
});

/* ------------------------------------------------------------------ *
 * Which side is the user
 * ------------------------------------------------------------------ */

test('the owner is resolved from evidence, and never guessed', () => {
  /* An export has display names and no addresses, so "which of these is me"
     has no answer in the file. The connector's rule is that a coin-flip
     dressed as a result is worse than saying it does not know — a wrong guess
     files everything the user said as owed TO them, inverting the board. */
  const senders = ['Kit Alder', 'Nemo Hale'];

  /* It returns `{name, how}` rather than a bare name, and the `how` is not
     decoration: `collect` reports which evidence it used, so a board that filed
     the wrong side can be explained instead of merely disbelieved. */
  const bySetting = resolveOwner({ configured: 'Nemo Hale', senders });
  assert.equal(bySetting.name, 'Nemo Hale', 'an explicitly configured name must win outright');
  assert.equal(bySetting.how, 'setting');

  const byFile = resolveOwner({ senders, fileName: 'WhatsApp Chat with Kit Alder.txt' });
  assert.equal(byFile.name, 'Nemo Hale',
    'a two-person chat is named after the OTHER party, which names the user by elimination');
  assert.equal(byFile.how, 'filename');

  assert.equal(resolveOwner({ senders, identityEmail: 'nemo@example.com' }).name, 'Nemo Hale',
    'the local part matching exactly one sender is real evidence');

  // A group export is named after the GROUP, so elimination has nothing to
  // eliminate — and naming a member anyway would invert that person's board.
  const unknown = resolveOwner({
    senders: ['Kit Alder', 'Nemo Hale', 'Dana Vance'],
    fileName: 'WhatsApp Chat with Alder site.txt',
  });
  assert.ok(!unknown.name, `a group chat must not nominate a member as the user, got ${JSON.stringify(unknown)}`);
});

/* ------------------------------------------------------------------ *
 * The row the database will actually see
 * ------------------------------------------------------------------ */

test('a row carries no uid at all, so re-importing does not re-insert the chat', () => {
  /* The rule that has already cost this project: `uid: null` coerces to 0 in
     upsertMessage while an omitted uid stays null, and the two hash to
     different row ids — so a connector that flips between them re-inserts
     every row it has ever seen. An export is re-read on every sweep, so this
     connector re-imports the same file forever; if the id moved, so would the
     whole conversation, every half hour. */
  const parsed = parseExport('[09/08/2026, 14:02:00] Kit Alder: hello', { timezone: 'UTC', order: 'dmy' });
  const row = rowFor(parsed.messages[0], { chatKey: 'chat-1', chatName: 'Kit Alder', ownerName: 'Nemo Hale' });

  assert.equal(Object.prototype.hasOwnProperty.call(row, 'uid'), false,
    'the row carries a uid key — omit it entirely or always give it a number, never null');
  assert.ok(row.messageId, 'a row with no messageId gets a random id and re-inserts on every sweep');
  assert.equal(row.direction, 'in', 'a message from the other party is inbound');

  const mine = rowFor({ ...parsed.messages[0], sender: 'Nemo Hale' },
    { chatKey: 'chat-1', chatName: 'Kit Alder', ownerName: 'Nemo Hale' });
  assert.equal(mine.direction, 'out', 'what the user wrote is outbound, or "you promised" cannot be mined from it');

  // Same input, same id — the property that makes re-reading the file safe.
  const again = rowFor(parsed.messages[0], { chatKey: 'chat-1', chatName: 'Kit Alder', ownerName: 'Nemo Hale' });
  assert.equal(again.messageId, row.messageId, 'the id is not stable, so every sweep duplicates the chat');
});

/* ------------------------------------------------------------------ *
 * The file on disk
 * ------------------------------------------------------------------ */

test('REGRESSION: collect reads a plain .txt export — the binary guard must not refuse every text file', async (t) => {
  /* The guard in readExport tested `text.includes('')` — an EMPTY needle, which
     String.prototype.includes answers true for on every string — so every .txt
     export threw ExportError and collect reported the file as "not text (it
     contains NUL bytes)" with zero rows. Android's "Export chat → Without
     media" produces a .txt, so the connector's primary input path never worked
     once; only the .zip branch, which returns before the guard, ever did — and
     check() parses the same .txt head directly, so doctor said "pass" about a
     file the sweep called unreadable. The intended needle is a real NUL byte,
     as folder.mjs spells it. Driven through the real collect(), because every
     other test here calls the parser directly and the parser was never the
     problem. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-whatsapp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'WhatsApp Chat with Kit Alder.txt');
  fs.writeFileSync(file, [
    '[9/8/26, 9:14:02 AM] Kit Alder: Retainage schedule is posted',
    '[9/8/26, 9:15:00 AM] Nemo Hale: On it',
  ].join('\n'));

  const collectFrom = (target) => whatsapp.collect({
    source: { id: 's_wa', settings: { path: target, yourName: 'Nemo Hale' } },
    label: 'WhatsApp',
    cursor: null,
    timezone: 'UTC',
    identityEmail: '',
    emit() {},
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const [part] = (await collectFrom(file)).parts;
  assert.equal(part.error, null, `a clean ASCII export was refused: ${part.error}`);
  assert.equal(part.rows.length, 2, 'the export parses on its own and collect still delivered nothing');
  assert.equal(part.rows[0].from.name, 'Kit Alder');

  // The guard still exists for what it was written against: a renamed binary.
  const binary = path.join(dir, 'not-really-a-chat.txt');
  fs.writeFileSync(binary, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
  const refused = (await collectFrom(binary)).parts[0];
  assert.equal(refused.rows.length, 0);
  assert.match(String(refused.error), /NUL bytes/, 'a real binary must still be refused by name');
});

test('the manifest says out loud that this is an archive, not a connection', () => {
  /* The most important line in the connector is not code. WhatsApp offers no
     way to read a personal account live, so a user who reads "WhatsApp" in a
     source list and assumes it updates has been misled by the product rather
     than by their own optimism. */
  assert.equal(whatsapp.credential, null, 'there is nothing to authenticate against a file on disk');
  assert.deepEqual(whatsapp.origins, [], 'a file reader must not be able to reach the network at all');
  assert.match(`${whatsapp.option}`, /export|file|archive/i,
    'the picker sentence does not say this is a file the user exports');
});
