import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';

const privateFeed = 'https://calendar.example.invalid/private-feed.ics?token=FICTIONAL-FEED-KEY';

async function fixture(t, { fail = false } = {}) {
  const document = installDom(t);
  const { state } = await import('../ui/lib/store.js');
  const settings = await import('../ui/views/settings.js');
  const config = { identity: {}, calendars: [{ id: 'private-calendar', url: privateFeed }] };
  const board = {
    items: [{ id: 'one', headline: 'Private board reminder', sourceRefs: [] }],
    counts: { now: 1 }, finished: [{ id: 'done', headline: 'A completed reminder' }],
    events: [{ id: 'event', title: 'Private appointment', description: 'Private meeting notes', starts_at: '2026-09-11T09:00:00Z',
      raw: `BEGIN:VCALENDAR\nX-SUBSCRIPTION-URL:${privateFeed}`, raw_ics: privateFeed, transport: { url: privateFeed } }],
    drafts: [{ id: 'draft', body: 'Private draft reply' }], notes: ['Private board note'], first: 'one',
    eventWindow: { from: '2026-09-01', to: '2026-09-30' }, now: '2026-09-10T12:00:00Z',
    runs: { last: { error: `Could not fetch ${privateFeed}` } }, sourceStatus: [{ error: privateFeed }],
    futureDiagnostics: { connection: privateFeed }, tokens: { tokensIn: 25 },
  };
  state.config = config;
  state.health = { version: 'test-version', home: '/fictional/zelos', backend: { name: 'encrypted-file' } };
  const calls = [];
  const blobs = [];
  const revoked = [];
  const downloads = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:fixture-snapshot'; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    if (tag === 'a') node.click = () => downloads.push({ ...node.attributes });
    return node;
  };
  t.mock.method(globalThis, 'fetch', async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET' });
    if (path === '/api/state' && fail) return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'Board unavailable.' }) };
    const value = path === '/api/state' ? board : path === '/api/config' ? { config } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  });
  const panel = document.body.appendChild(settings.renderSettings({ sub: 'data', navigate() {}, rerender() {} }));
  await settle();
  return { panel, board, calls, blobs, downloads, revoked };
}

async function exportSnapshot(panel) {
  const button = findButton(panel, 'Save board snapshot');
  assert.ok(button);
  await button.listeners.get('click')[0]();
}

test('board snapshot downloads board content while excluding settings, diagnostics and raw event imports', async t => {
  const { panel, board, calls, blobs, downloads, revoked } = await fixture(t);
  await exportSnapshot(panel);
  assert.equal(blobs.length, 1);
  const raw = await blobs[0].text();
  assert.equal(raw.includes(privateFeed), false, 'a connection credential must not enter the snapshot from settings, diagnostics or raw event data');
  const payload = JSON.parse(raw);
  assert.deepEqual(Object.keys(payload).sort(), ['board', 'exportedAt', 'version']);
  assert.equal(payload.version, 'test-version');
  assert.ok(Number.isFinite(Date.parse(payload.exportedAt)));
  assert.deepEqual(Object.keys(payload.board).sort(), ['counts', 'drafts', 'eventWindow', 'events', 'finished', 'first', 'items', 'notes', 'now']);
  for (const key of ['items', 'counts', 'finished', 'drafts', 'notes', 'first', 'eventWindow', 'now']) assert.deepEqual(payload.board[key], board[key]);
  assert.deepEqual(payload.board.events, [{ id: 'event', title: 'Private appointment', description: 'Private meeting notes', starts_at: '2026-09-11T09:00:00Z' }]);
  assert.deepEqual(calls.map(call => call.path), ['/api/data', '/api/state'], 'snapshot does not request connection settings');
  assert.equal(downloads.length, 1); assert.match(downloads[0].download, /^zelos-board-\d+\.json$/);
  assert.match(text(panel), /private board content/i);
  assert.match(text(panel), /excludes connection settings/i);
  assert.doesNotMatch(text(panel), /contains no passwords|without passwords|safe to share/i);
  t.mock.timers.tick(10_000); assert.deepEqual(revoked, ['blob:fixture-snapshot']);
});

test('failed snapshot reads show an error without downloading an empty file or claiming success', async t => {
  const { panel, blobs, downloads } = await fixture(t, { fail: true });
  await exportSnapshot(panel);
  assert.deepEqual(blobs, []); assert.deepEqual(downloads, []);
  assert.match(text(panel), /Board unavailable/);
  assert.doesNotMatch(text(panel), /Board snapshot saved/);
});
