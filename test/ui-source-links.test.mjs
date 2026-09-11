import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, walk, text } from './helpers/ui-dom.mjs';

test('item source links show the parsed destination in both row sizes', async t => {
  installDom(t);
  const { state } = await import('../ui/lib/store.js');
  const { itemRow, itemHero } = await import('../ui/lib/items.js');
  state.config = { identity: { timezone: 'UTC' } };
  state.board = { ...state.board, runs: {} };
  const item = { id: 'fixture', headline: 'Review the source', state: 'open', bucket: 'now', sourceRefs: [] };
  for (const render of [itemRow, itemHero]) {
    for (const [link, destination] of [
      ['https://documents.example.invalid/report?view=1', 'documents.example.invalid'],
      ['https://friendly.example.invalid@actual.example.invalid:8443/report', 'actual.example.invalid:8443'],
      ['https://b\u00fccher.example.invalid/report', 'xn--bcher-kva.example.invalid'],
    ]) {
      const node = render({ ...item, link }, { tz: 'UTC' });
      const anchor = walk(node).find(child => child.tag === 'a');
      assert.ok(anchor);
      assert.equal(text(anchor), `Open ${destination}`);
      assert.equal(anchor.getAttribute('href'), new URL(link).href);
      assert.equal(anchor.getAttribute('target'), '_blank');
      assert.equal(anchor.getAttribute('rel'), 'noreferrer noopener');
    }
    for (const link of ['mailto:person@example.invalid?body=sample', 'javascript:void(0)', 'data:text/plain,sample', '/local-route', '//example.invalid/report']) {
      assert.equal(walk(render({ ...item, link }, { tz: 'UTC' })).some(child => child.tag === 'a'), false,
        `item links must be absolute web source URLs: ${link}`);
    }
  }
});
