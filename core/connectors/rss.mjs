/**
 * core/connectors/rss.mjs — an RSS or Atom feed.
 *
 * This is the connector written to prove the interface, and it was chosen
 * because it needs no credential and no vendor account: the whole of it can be
 * exercised against a local HTTP server with no secret store involved. If the
 * contract were awkward for a source this plain, it would be wrong.
 *
 * Three things it demonstrates that a mail account cannot:
 *
 *  - THE CURSOR IS OPAQUE, and here it is HTTP's own incremental mechanism.
 *    `ETag` and `Last-Modified` come back as `If-None-Match` and
 *    `If-Modified-Since`, and a 304 is a successful read of nothing. Zelos never
 *    looks inside the value; it stores what it was handed and hands it back.
 *  - A ROW WITHOUT A `uid`. core/db.mjs:384 reads `Number.isFinite(Number(uid))
 *    ? Number(uid) : null`, so `uid: null` becomes 0 and an OMITTED uid becomes
 *    null — two different row ids for the same entry (36c5d228c13041e4 against
 *    58ac70ac2a9131aa, measured). A connector that emits `uid: null` on one
 *    release and omits it on the next re-inserts every row it has ever seen, on
 *    every sweep, forever. There is no `uid` key anywhere below and there must
 *    never be one: a feed entry has no integer identity.
 *  - `sink: 'messages'` FOR SOMETHING THAT IS NOT MAIL. `source_id` and `folder`
 *    are free text and `from_email` is never validated as an address, so an
 *    article is a message that arrived from a publication — which is exactly
 *    how the board should read it. The record types are named for how the board
 *    reads a thing, not for the vendor's noun.
 *
 * The parser is deliberately small and deliberately not a parser. A feed is a
 * stranger's XML; the only questions asked of it are "which elements are items"
 * and "what text is inside this one", and both are answered by scanning rather
 * than by building a tree. Nothing here evaluates, resolves an entity file, or
 * follows a URL the document names — `ctx.http` would refuse the last one
 * anyway, which is the point of the allow-list.
 */

import crypto from 'node:crypto';

import { htmlToText, parseDate } from '../sources/mime.mjs';

/** How much of a feed is worth reading. Beyond this it is an archive, not news. */
const MAX_ENTRIES = 200;

/** The snippet the board shows; the body it can open. */
const SNIPPET_CHARS = 400;
const BODY_CHARS = 20_000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

/** `<![CDATA[…]]>` is a quoting device, not content. */
const unwrapCdata = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

/**
 * The text of one element, markup removed and entities decoded.
 *
 * `htmlToText` is core/sources/mime.mjs's, the same function that turns an HTML
 * mail part into something a model can read: a feed's `<description>` is HTML
 * inside XML about half the time, and re-deriving a tag stripper here would be a
 * second answer to a question this repo has already answered carefully.
 */
const textOf = (raw) => htmlToText(unwrapCdata(raw ?? ''));

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A tag, namespace prefix optional: `<title>`, `<dc:creator>`, `<atom:link>`. */
function tagRe(name, flags = '') {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${name}\\s*>`, flags);
}

/** The body of the first matching element, or ''. */
function first(xml, name) {
  const m = tagRe(name).exec(xml);
  return m ? m[2] : '';
}

/** One attribute off a tag's attribute string. */
function attr(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs || '');
  return m ? (m[2] ?? m[3] ?? '') : '';
}

/**
 * The entry's link.
 *
 * RSS puts it in `<link>`'s body; Atom puts it in a `href` attribute on a
 * self-closing tag and may offer several, of which `rel="alternate"` (or no
 * `rel` at all) is the one a human would click. `rel="enclosure"` is a media
 * file and `rel="self"` is the feed itself, and neither is the article.
 */
/**
 * XML entities, decoded — in a URL, where leaving them is not cosmetic.
 *
 * `&` is not legal raw in XML character data, so a feed that publishes
 * `?a=1&b=2` MUST escape it, and publishers vary in how: `&amp;` from most,
 * `&#038;` from WordPress. Found by pointing this connector at NASA's real feed
 * rather than at a fixture — 2 of 10 entries came back with
 * `?post_type=image-article&#038;p=1036264`, because a person writing a test
 * fixture types a clean URL and never sees this.
 *
 * It matters beyond the href being slightly wrong. That string is the `<guid>`
 * fallback, so it becomes `messageId`, and `messageRowId` hashes it: if the
 * publisher ever changes escaping — `&#038;` to `&amp;`, or a CDN normalising
 * on the way out — the same article hashes to a different row and arrives
 * again as new. It is also `threadKey`, so one article can become two threads.
 *
 * Only the five predefined XML entities plus numeric references are decoded.
 * The HTML named set (`&nbsp;`, `&copy;`, …) is deliberately not: those are not
 * XML entities, a conforming feed cannot use them bare, and decoding them here
 * would mean guessing at bytes the publisher never wrote.
 */
function decodeXmlEntities(s) {
  return String(s ?? '').replace(/&(#\d+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // A reference outside Unicode, or to a surrogate half, is left as written
      // rather than turned into a replacement character.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body] ?? whole;
  });
}

function linkOf(xml) {
  const body = first(xml, 'link');
  const inline = collapse(unwrapCdata(body));
  if (inline) return decodeXmlEntities(inline);
  for (const m of xml.matchAll(/<(?:[A-Za-z0-9_.-]+:)?link(\s[^>]*)\/?>/g)) {
    const rel = attr(m[1], 'rel').toLowerCase();
    if (rel && rel !== 'alternate') continue;
    const href = attr(m[1], 'href');
    if (href) return decodeXmlEntities(href.trim());
  }
  return '';
}

/**
 * -> {title, entries: [{title, link, id, author, date, body}]}
 *
 * Comments are removed first, because a commented-out `<item>` is a real thing
 * in hand-edited feeds and it is not an entry.
 */
export function parseFeed(input) {
  const xml = String(input ?? '').replace(/<!--[\s\S]*?-->/g, '');

  const blocks = [];
  for (const m of xml.matchAll(tagRe('item', 'g'))) blocks.push(m[2]);
  if (!blocks.length) for (const m of xml.matchAll(tagRe('entry', 'g'))) blocks.push(m[2]);

  // The feed's own title is whatever `<title>` comes before the first entry;
  // taking the first `<title>` in the document without that check picks up the
  // first article's title on a feed whose channel has none.
  const firstEntryAt = blocks.length ? xml.indexOf(blocks[0]) : xml.length;
  const head = xml.slice(0, Math.max(0, firstEntryAt));
  const title = collapse(textOf(first(head, 'title')));

  const entries = blocks.slice(0, MAX_ENTRIES).map((block) => ({
    title: collapse(textOf(first(block, 'title'))),
    link: linkOf(block),
    // The guid gets the same treatment as the link, and for the same reason:
    // it is usually a URL, it is the FIRST choice for messageId, and an escaped
    // ampersand in it is a row identity that moves when the publisher's
    // escaping does.
    id: decodeXmlEntities(collapse(unwrapCdata(first(block, 'guid') || first(block, 'id')))),
    author: collapse(textOf(first(block, 'creator') || first(block, 'author') || first(block, 'name'))),
    date: collapse(unwrapCdata(
      first(block, 'pubDate') || first(block, 'published') || first(block, 'updated') || first(block, 'date'),
    )),
    body: textOf(
      first(block, 'encoded') || first(block, 'content') || first(block, 'description') || first(block, 'summary'),
    ),
  }));

  return { title, entries };
}

export default {
  type: 'rss',
  family: 'rss',
  label: 'Feed',
  option: 'RSS or Atom feed',
  configKey: 'sources',
  sink: 'messages',

  /* No credential at all — not an optional one. The host must therefore never
     write "No password stored for …" about a feed, which is what makes
     `credential: null` different from `{required: false}`. */
  credential: null,

  /* Empty, and it is not an oversight: the only address this connector may
     contact is the one the user typed into the `url` field below, and the host
     adds the origin of every `type: 'url'` field to the allow-list. A feed that
     redirects off its own origin, or names one in a <link>, is refused. */
  origins: [],

  fields: [
    { name: 'url', type: 'url', label: 'Feed address', required: true, hint: 'The .xml or /feed address, not the site.' },
    { name: 'maxItems', type: 'int', label: 'Entries to keep', default: 50, min: 1, max: MAX_ENTRIES },
  ],

  /* A feed is a static file on somebody's CDN. There is nothing to be gentle
     about, and `maxRows` is the only real limit: a feed that answers with ten
     thousand entries is an archive dump and it is not going in the board. */
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: MAX_ENTRIES },

  async collect(ctx) {
    const url = String(ctx.source?.settings?.url ?? '').trim();
    if (!url) throw new Error('this feed has no address yet — add one in Settings');

    const cursor = ctx.cursor && typeof ctx.cursor === 'object' ? ctx.cursor : {};
    const headers = {};
    if (cursor.etag) headers['if-none-match'] = cursor.etag;
    if (cursor.lastModified) headers['if-modified-since'] = cursor.lastModified;

    const res = await ctx.http.get(url, {
      headers,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    });

    if (res.status === 304) {
      // A successful read of nothing. The cursor is handed straight back so a
      // server that answers 304 forever is never re-read, and the source is
      // reported ok with a count of zero — which is what happened.
      ctx.emit(`${ctx.label}: unchanged`, 0, 0);
      return { parts: [{ label: '', rows: [], error: null, note: null }], cursor };
    }

    const feed = parseFeed(res.text);
    const folder = feed.title || new URL(url).host;
    const keep = Math.max(1, Math.min(Number(ctx.source?.settings?.maxItems) || 50, MAX_ENTRIES));

    const rows = feed.entries.slice(0, keep).map((entry) => {
      const date = parseDate(entry.date) || null;
      /* The row identity, and the one thing in this file that must be right
         forever: `messageRowId(sourceId, uid, messageId)` is the primary key, so
         a messageId that changes between releases re-inserts every entry and a
         messageId that collides loses one. A `<guid>` is the publisher's own
         promise of stability and is used verbatim; a link is the next best
         thing; a hash of title-and-date is the last resort and is namespaced so
         it can never be mistaken for a real guid. */
      const messageId = entry.id
        || (entry.link ? `rss:sha256:${sha256(entry.link)}` : `rss:sha256:${sha256(`${entry.title}\n${entry.date}`)}`);
      const body = entry.body.slice(0, BODY_CHARS);
      return {
        messageId,
        threadKey: messageId,
        folder,
        direction: 'in',
        from: { name: entry.author || folder, email: '' },
        to: [],
        cc: [],
        subject: entry.title || entry.link || '(untitled)',
        date,
        snippet: collapse(body).slice(0, SNIPPET_CHARS),
        text: entry.link ? `${body}\n\n${entry.link}`.trim() : body,
        hasAttachments: false,
        flags: [],
      };
    });

    ctx.emit(`${ctx.label}: ${rows.length} entries`, rows.length, rows.length);

    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    // `null` clears a cursor the feed no longer supports; `undefined` would mean
    // "leave whatever was there", which would keep sending a validator this
    // server has stopped honouring.
    const next = etag || lastModified ? { etag: etag || null, lastModified: lastModified || null } : null;

    return { parts: [{ label: '', rows, error: null, note: null }], cursor: next };
  },
};
