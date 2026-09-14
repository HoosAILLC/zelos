import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, TestNode, text, findButton, settle } from './helpers/ui-dom.mjs';

const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function recipes() {
  return [
    ['Berry oatmeal', 'breakfast', 10, 100, 200, ['vegan', 'gluten-free'], 'Grains', 'American'],
    ['Chickpea bowl', 'lunch', 25, 200, 300, ['vegan', 'dairy-free'], 'Legumes', 'Mediterranean'],
    ['Lemon chicken', 'dinner', 35, 450, 600, ['dairy-free'], 'Chicken', 'Mediterranean'],
    ['Berry yogurt', 'breakfast', 5, 200, 250, ['vegetarian', 'gluten-free'], 'Dairy', 'American'],
    ['Rice tofu bowl', 'dinner', 20, 300, 350, ['vegan', 'dairy-free', 'gluten-free'], 'Tofu', 'Asian'],
  ].map(([title, slot, minutes, costLow, costHigh, tags, protein, cuisine], i) => ({
    id: `r${i}`, discoveryId: `catalog:recipe-${i}`, title, slot, minutes, costLow, costHigh, tags, protein, cuisine,
    servings: 1, priceCurrency: 'USD', origin: 'library', description: 'A simple meal made in your kitchen.',
    ingredients: [{ name: 'Brown rice', quantity: 50, unit: 'g' }], steps: ['Cook the rice. Serve warm.'],
    reason: 'Fits your saved preferences.', healthNotes: ['Based on saved preferences.'], basisIds: ['profile:goals'],
  }));
}
async function fixture(t, { count, emptyWeek = false, data: patch = {} } = {}) {
  const document = installDom(t), { api } = await import('../ui/lib/api.js');
  // The shared minimal fixture only handles single selectors in closest().
  // Native closest also accepts selector lists, used by input gesture guards.
  const closest = TestNode.prototype.closest;
  t.mock.method(TestNode.prototype, 'closest', function(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector.split(',').some(part => closest.call(node, part.trim()) === node)) return node;
    }
    return null;
  });
  let rows = recipes();
  if (count) rows = Array.from({ length: count }, (_, i) => ({ ...rows[i % rows.length], title: `Meal idea ${i}`, id: `r${i}`, discoveryId: `catalog:recipe-${i}` }));
  const data = { recipes: rows, favorites: [], skipped: [], revision: 'taste1', currency: 'USD', totalCount: rows.length,
    excludedCount: 0, weekRevision: 'week1', note: 'Approximate ingredient costs per serving, not live store prices.',
    sources: [{ id: 'profile:goals', title: 'Saved food preferences' }], ...patch };
  const current = { weekStart: '2026-09-14', week: emptyWeek ? null : { revision: 'week1' }, profile: { currency: 'USD' },
    dirty: false, preferencesDirty: false, stale: false, locked: false };
  const calls = [], updated = [], visits = [], reads = [];
  const taste = async body => {
    calls.push({ type: 'taste', body: structuredClone(body) });
    assert.equal(body.expectedRevision, data.revision);
    data.favorites = data.favorites.filter(id => id !== body.recipeId); data.skipped = data.skipped.filter(id => id !== body.recipeId);
    if (body.action === 'favorite') data.favorites.push(body.recipeId);
    if (body.action === 'skip') data.skipped.push(body.recipeId);
    data.revision = `taste${calls.length + 1}`;
    return structuredClone({ favorites: data.favorites, skipped: data.skipped, revision: data.revision });
  };
  const handlers = { library: async weekStart => { reads.push(weekStart); return structuredClone(data); }, taste,
    add: async body => { calls.push({ type: 'add', body: structuredClone(body) }); return { week: { weekStart: body.weekStart, revision: 'week2', selectedIds: [body.mealId] }, profile: current.profile, stale: false, health: { synthetic: true }, storePreferences: { stores: [] }, unchanged: false }; } };
  t.mock.method(api, 'mealLibrary', value => handlers.library(value));
  t.mock.method(api, 'saveMealTaste', value => handlers.taste(value));
  t.mock.method(api, 'addMealFromLibrary', value => handlers.add(value));
  t.mock.method(api, 'buildMealGroceries', () => { throw new Error('Discovery must not build or order groceries'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Discovery must only use its private API'); });
  const { createMealDiscovery } = await import('../ui/lib/meal-discovery.js');
  const discovery = createMealDiscovery({ getWeek: () => current, onWeekUpdated: async response => { updated.push(response); current.week = response.week; }, onViewWeek: () => visits.push('week') });
  const view = document.body.appendChild(discovery.root); t.after(() => discovery.dispose()); await settle();
  return { document, data, current, calls, updated, visits, reads, handlers, discovery, view,
    control: name => view.querySelector(`[aria-label="${name}"]`),
    change(name, value, event = 'change') { const node = this.control(name); assert.ok(node, name); node.value = value; node.fire(event); return node; },
    async click(name) { const node = findButton(view, name); assert.ok(node, name); node.click(); await settle(); },
    titles: () => view.querySelectorAll('.md-card').map(card => text(card.querySelector('h3'))),
  };
}

test('Browse loads local photos and 24-card pages without saving or generating', async t => {
  const f = await fixture(t, { count: 30 });
  assert.equal(f.view.querySelectorAll('.md-card').length, 24); assert.equal(f.view.querySelector('.md-filters').open, false);
  assert.match(text(f.view), /30 ideas/); assert.match(text(f.view), /10 min/); assert.match(text(f.view), /1\.00.*2\.00 \/ serving/);
  assert.ok(f.view.querySelectorAll('img').every(image => image.getAttribute('src').startsWith('/assets/meals/')));
  assert.ok(f.view.querySelectorAll('img').every(image => image.getAttribute('loading') === 'lazy'));
  assert.equal(f.view.querySelector('.md-about').open, false); assert.match(text(f.view.querySelector('.md-about')), /not live store prices/);
  assert.match(text(f.view.querySelector('.md-origin')), /Recipe library/);
  await f.click('Show 24 more'); assert.equal(f.view.querySelectorAll('.md-card').length, 30);
  assert.equal(findButton(f.view, 'Show 24 more').hidden, true); assert.deepEqual(f.calls, []);
});

test('sort starts on its actual recommended option and retains explicit choices across refresh and reset', async t => {
  const f = await fixture(t), sort = f.control('Sort meal ideas');
  assert.equal(sort.value, 'recommended');
  assert.equal(text(sort.querySelectorAll('option').find(option => option.value === sort.value)), 'Recommended');
  f.change('Sort meal ideas', 'quickest'); await f.discovery.reload();
  assert.equal(f.control('Sort meal ideas'), sort); assert.equal(sort.value, 'quickest');
  await f.click('Reset filters'); assert.equal(sort.value, 'recommended');
  assert.equal(f.calls.length, 0);
});

test('recommended cards mix meal types deterministically and swipe advances without restarting the mix', async t => {
  const source = recipes(), grouped = ['breakfast', 'lunch', 'dinner'].flatMap((slot, slotIndex) =>
    Array.from({ length: 2 }, (_, index) => ({ ...source[slotIndex], slot, title: `${slot} idea ${index + 1}`,
      id: `${slot}-${index}`, discoveryId: `catalog:${slot}-${index}` })));
  const f = await fixture(t, { data: { recipes: grouped, totalCount: grouped.length } });
  const order = ['breakfast idea 1', 'lunch idea 1', 'dinner idea 1', 'breakfast idea 2', 'lunch idea 2', 'dinner idea 2'];
  assert.deepEqual(f.titles(), order);
  await f.discovery.reload(); assert.deepEqual(f.titles(), order);
  f.change('Meal type', 'lunch'); assert.deepEqual(f.titles(), ['lunch idea 1', 'lunch idea 2']);
  f.change('Meal type', ''); await f.click('Swipe');
  assert.deepEqual(f.titles(), [order[0]]);
  await f.click('Skip breakfast idea 1'); assert.deepEqual(f.titles(), [order[1]]);
  await f.click('Save recipe lunch idea 1'); assert.deepEqual(f.titles(), [order[2]]);
  await f.click('Skip dinner idea 1'); assert.deepEqual(f.titles(), [order[3]]);
  await f.click('Undo last choice'); assert.deepEqual(f.titles(), [order[2]]);
});

test('combined filters, chips and reset preserve the actual input node and focus across refresh', async t => {
  const f = await fixture(t), search = f.change('Search meal ideas', 'berry', 'input');
  search.focus(); search.selectionStart = 3; search.selectionEnd = 3;
  assert.deepEqual(f.titles(), ['Berry oatmeal', 'Berry yogurt']);
  f.change('Diet filter', 'vegan'); f.change('Meal type', 'breakfast'); f.change('Maximum cooking minutes', '15');
  f.change('Maximum price per serving in USD', '2', 'input'); f.change('Protein filter', 'Grains'); f.change('Cuisine filter', 'American');
  assert.deepEqual(f.titles(), ['Berry oatmeal']); assert.match(text(f.view.querySelector('.md-filter-count')), /7 active/);
  await f.discovery.reload();
  assert.equal(f.control('Search meal ideas'), search); assert.equal(search.value, 'berry'); assert.equal(f.document.activeElement, search);
  assert.equal(search.selectionStart, 3); assert.equal(search.selectionEnd, 3);
  f.change('Maximum price per serving in USD', '1.50', 'input'); assert.deepEqual(f.titles(), []);
  await f.click('Clear price filter'); assert.deepEqual(f.titles(), ['Berry oatmeal']);
  await f.click('Reset filters'); assert.equal(search.value, ''); assert.equal(f.titles().length, 5);
  assert.equal(f.control('Diet filter').value, ''); assert.equal(f.control('Protein filter').value, '');
});

test('quickest and price sorts use numeric values and a USD price filter excludes other currencies', async t => {
  const f = await fixture(t);
  f.change('Sort meal ideas', 'quickest'); assert.equal(f.titles()[0], 'Berry yogurt');
  f.change('Sort meal ideas', 'price'); assert.equal(f.titles()[0], 'Berry oatmeal');
  f.data.recipes[0].priceCurrency = 'EUR'; await f.discovery.reload();
  f.change('Maximum price per serving in USD', '3', 'input');
  assert.deepEqual(new Set(f.titles()), new Set(['Chickpea bowl', 'Berry yogurt']));
});

test('favorite saves are serialized and Saved and Undo reflect only confirmed taste state', async t => {
  const f = await fixture(t), pending = defer(), original = f.handlers.taste;
  f.handlers.taste = async body => { await pending.promise; return original(body); };
  const save = findButton(f.view, 'Save Berry oatmeal'); save.click(); save.click();
  assert.equal(findButton(f.view, 'Save Berry oatmeal').disabled, true); assert.equal(f.calls.length, 0);
  pending.resolve(); await settle(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { recipeId: 'catalog:recipe-0', action: 'favorite', expectedRevision: 'taste1' });
  await f.click('Saved'); assert.deepEqual(f.titles(), ['Berry oatmeal']);
  await f.click('Unsave Berry oatmeal'); assert.deepEqual(f.titles(), []);
  await f.click('Undo last choice'); assert.deepEqual(f.titles(), ['Berry oatmeal']);
  assert.equal(f.calls.at(-1).body.action, 'favorite'); assert.equal(f.calls.at(-1).body.expectedRevision, 'taste3');
});

test('swipe buttons advance the deck and undo restores the last undecided recipe', async t => {
  const f = await fixture(t); await f.click('Swipe');
  assert.deepEqual(f.titles(), ['Berry oatmeal']); await f.click('Skip Berry oatmeal');
  assert.deepEqual(f.titles(), ['Chickpea bowl']); await f.click('Save recipe Chickpea bowl');
  assert.deepEqual(f.titles(), ['Lemon chicken']); await f.click('Undo last choice');
  assert.deepEqual(f.titles(), ['Chickpea bowl']); assert.equal(f.calls.at(-1).body.action, 'clear');
  assert.equal(f.document.activeElement, f.view.querySelector('.md-swipe-card'));
});

test('replaying skipped recipes does not bulk-write choices and undo restores a prior skip', async t => {
  const f = await fixture(t, { data: { skipped: ['catalog:recipe-0', 'catalog:recipe-1'] } });
  await f.click('Replay skipped'); assert.deepEqual(f.titles(), ['Berry oatmeal']); assert.equal(f.calls.length, 0);
  await f.click('Skip Berry oatmeal'); assert.deepEqual(f.titles(), ['Chickpea bowl']);
  await f.click('Save recipe Chickpea bowl'); assert.deepEqual(f.titles(), []); assert.match(text(f.view), /end of this deck/);
  await f.click('Undo last choice'); assert.deepEqual(f.titles(), ['Chickpea bowl']); assert.equal(f.calls.at(-1).body.action, 'skip');
});

test('pointer swipes require deliberate horizontal motion and preserve vertical scrolling and form interaction', async t => {
  const f = await fixture(t); await f.click('Swipe');
  const card = f.view.querySelector('.md-swipe-card');
  function move(dx, dy, cancel = false) {
    card.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    const event = card.fire('pointermove', { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
    card.fire(cancel ? 'pointercancel' : 'pointerup', { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy }); return event;
  }
  assert.equal(move(10, 110).defaultPrevented, false); assert.equal(f.calls.length, 0);
  move(40, 2); move(110, 2, true); assert.equal(f.calls.length, 0);
  const select = f.control('Day for Berry oatmeal');
  card.fire('pointerdown', { target: select, pointerId: 2, clientX: 0, clientY: 0, button: 0 });
  card.fire('pointermove', { pointerId: 2, clientX: 150, clientY: 0 }); card.fire('pointerup', { pointerId: 2, clientX: 150, clientY: 0 });
  assert.equal(f.calls.length, 0);
  assert.equal(move(110, 4).defaultPrevented, true); await settle(); assert.equal(f.calls[0].body.action, 'favorite');
  const next = f.view.querySelector('.md-swipe-card');
  next.fire('pointerdown', { pointerId: 3, clientX: 150, clientY: 100, button: 0 });
  next.fire('pointermove', { pointerId: 3, clientX: 30, clientY: 105 }); next.fire('pointerup', { pointerId: 3, clientX: 30, clientY: 105 });
  await settle(); assert.equal(f.calls[1].body.action, 'skip');
});

test('keyboard choices ignore inputs, detached views and disposed components', async t => {
  const f = await fixture(t); await f.click('Swipe');
  const search = f.control('Search meal ideas');
  assert.equal(search.fire('keydown', { key: 'ArrowRight' }).defaultPrevented, false); assert.equal(f.calls.length, 0);
  const card = f.view.querySelector('.md-swipe-card');
  assert.equal(card.fire('keydown', { key: 'ArrowRight' }).defaultPrevented, true); await settle(); assert.equal(f.calls.length, 1);
  f.view.remove(); assert.equal(f.view.fire('keydown', { key: 'ArrowLeft' }).defaultPrevented, false); assert.equal(f.calls.length, 1);
  f.document.body.appendChild(f.view); f.discovery.dispose();
  assert.equal(f.view.fire('keydown', { key: 'ArrowLeft' }).defaultPrevented, false); assert.equal(f.calls.length, 1);
});

test('failed choices remain in the deck and stale revisions require a successful refresh before retry', async t => {
  const f = await fixture(t); await f.click('Swipe');
  const original = f.handlers.taste;
  f.handlers.taste = async () => { throw new Error('Connection unavailable'); };
  await f.click('Save recipe Berry oatmeal'); assert.deepEqual(f.titles(), ['Berry oatmeal']); assert.match(text(f.view), /Connection unavailable/);
  assert.equal(findButton(f.view, 'Save recipe Berry oatmeal').disabled, false);
  f.handlers.taste = async () => { throw Object.assign(new Error('Your preferences changed on another device. Reload.'), { status: 409 }); };
  await f.click('Save recipe Berry oatmeal'); assert.equal(findButton(f.view, 'Save recipe Berry oatmeal').disabled, true);
  f.data.revision = 'external'; f.handlers.taste = original; await f.click('Refresh ideas');
  await f.click('Save recipe Berry oatmeal'); assert.equal(f.calls.at(-1).body.expectedRevision, 'external');
  assert.deepEqual(f.titles(), ['Chickpea bowl']);
});

test('Add uses the chosen day and fixed recipe slot, passes the whole response and never builds groceries', async t => {
  const f = await fixture(t), day = f.change('Day for Chickpea bowl', '4');
  assert.equal(day.querySelectorAll('option').length, 7); assert.match(text(day), /Fri, Sep 18.*Lunch/);
  await f.discovery.reload(); assert.equal(f.control('Day for Chickpea bowl').value, '4');
  await f.click('Add Chickpea bowl to week');
  assert.deepEqual(f.calls, [{ type: 'add', body: { weekStart: '2026-09-14', recipeId: 'catalog:recipe-1', mealId: '4-lunch', expectedRevision: 'week1' } }]);
  assert.equal(f.updated.length, 1); assert.equal(f.updated[0].health.synthetic, true); assert.equal(f.updated[0].week.revision, 'week2');
  assert.match(text(f.view), /Review your week to build the grocery list/);
  await f.click('View your week'); assert.deepEqual(f.visits, ['week']);
});

test('empty weeks use a null revision and parent dirty, stale or busy state blocks adding', async t => {
  const f = await fixture(t, { emptyWeek: true });
  for (const property of ['dirty', 'preferencesDirty', 'stale', 'locked']) {
    f.current[property] = true; await f.discovery.reload();
    assert.equal(findButton(f.view, 'Add Berry oatmeal to week').disabled, true, property);
    await f.click('Add Berry oatmeal to week'); assert.equal(f.calls.length, 0);
    f.current[property] = false;
  }
  await f.discovery.reload(); await f.click('Add Berry oatmeal to week');
  assert.equal(f.calls[0].body.expectedRevision, null); assert.equal(f.calls[0].body.mealId, '0-breakfast');
});

test('adding to an old week never overwrites the newly selected week and double clicks send once', async t => {
  const f = await fixture(t), pending = defer(); let calls = 0;
  f.handlers.add = async () => { calls++; return pending.promise; };
  const add = findButton(f.view, 'Add Berry oatmeal to week'); add.click(); add.click();
  assert.equal(calls, 1); f.current.weekStart = '2026-09-21'; await f.discovery.reload();
  pending.resolve({ week: { weekStart: '2026-09-14', revision: 'old-week2' }, stale: false }); await settle();
  assert.equal(f.updated.length, 0); assert.equal(f.reads.at(-1), '2026-09-21');
});

test('late library reads cannot replace a newer week, and disposal ignores pending results', async t => {
  const f = await fixture(t), old = defer(), latest = defer();
  f.handlers.library = weekStart => weekStart === '2026-09-14' ? old.promise : latest.promise;
  const first = f.discovery.reload(); f.current.weekStart = '2026-09-21'; const second = f.discovery.reload();
  latest.resolve({ ...f.data, recipes: [{ ...f.data.recipes[0], title: 'New week oatmeal' }] }); await second;
  old.resolve({ ...f.data, recipes: [{ ...f.data.recipes[0], title: 'Old week oatmeal' }] }); await first;
  assert.deepEqual(f.titles(), ['New week oatmeal']);
  const pending = defer(); f.handlers.library = () => pending.promise; const reload = f.discovery.reload(); f.discovery.dispose();
  pending.resolve({ ...f.data, recipes: [{ ...f.data.recipes[0], title: 'Disposed response' }] }); await reload;
  assert.deepEqual(f.titles(), ['New week oatmeal']);
});

test('recipe details and hostile text stay literal, with fixed Health and bundled photo attribution links', async t => {
  const f = await fixture(t); f.data.recipes[0].title = '<img src=x onerror=bad> Oatmeal';
  f.data.recipes[0].imageUrl = 'https://untrusted.example/track'; f.data.recipes[0].steps = ['<script>bad()</script> Cook the oats.'];
  f.data.recipes[0].origin = 'local-ai'; f.data.sources[0].href = 'https://untrusted.example/health';
  await f.discovery.reload(); const card = f.view.querySelectorAll('.md-card')[0], details = card.querySelector('details');
  details.open = true; await f.discovery.reload();
  assert.equal(f.view.querySelectorAll('.md-card')[0].querySelector('details').open, true);
  assert.match(text(f.view), /<script>bad\(\)<\/script> Cook the oats/); assert.equal(f.view.querySelectorAll('script').length, 0);
  assert.ok(f.view.querySelectorAll('img').every(image => image.getAttribute('src').startsWith('/assets/meals/')));
  assert.ok(f.view.querySelectorAll('a').every(link => link.getAttribute('href') === '#/health/profile' || link.getAttribute('rel') === 'noopener noreferrer'));
  assert.match(text(f.view.querySelector('.md-origin')), /Local AI suggestion/);
  assert.doesNotMatch(text(f.view), /untrusted\.example/);
});
