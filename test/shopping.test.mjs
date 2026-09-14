import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-shopping-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_LOG_LEVEL = 'silent';
const dbm = await import('../core/db.mjs');
const health = await import('../core/health.mjs');
const shopping = await import('../core/shopping.mjs');
const handles = [];
test.after(() => { handles.forEach(db => dbm.close(db)); fs.rmSync(home, { recursive: true, force: true }); });
test.beforeEach(t => t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network is permitted in this test.'); }));
function fresh() { const db = dbm.open(':memory:'); dbm.migrate(db); handles.push(db); return db; }
const add = (db, over = {}) => health.saveGroceryItem(db, { name: 'Oats', quantity: '1 cup', estimatedCost: 3, state: 'needed', ...over }).item;
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function configured(db, extra = {}) {
  const secrets = new Map(), requests = [];
  const deps = { setSecret: async (key, value) => secrets.set(key, value), getSecret: async key => secrets.get(key),
    fetch: async (url, request) => { requests.push({ url, ...request });
      return url.includes('/retailers?') ? reply({ retailers: [{ retailer_key: 'fixture-store', name: 'Fixture Grocery' }] })
        : reply({ products_link_url: 'https://www.instacart.com/store/shopping_lists/synthetic' }); }, ...extra };
  await shopping.saveShoppingSettings(db, { provider: 'instacart', countryCode: 'US', postalCode: '46201', accountLabel: 'Personal account reminder', apiKey: 'keys.synthetic-secret-123' }, deps);
  await shopping.findShoppingStores(db, {}, deps);
  await shopping.saveShoppingSettings(db, { retailerKey: 'fixture-store' }, deps);
  requests.length = 0;
  return { deps, secrets, requests };
}

test('shopping starts unconfigured and never guesses ingredients from meal names', () => {
  const db = fresh();
  health.savePlan(db, { title: 'Saved meals', weekStart: '2026-09-07', entries: [{ date: '2026-09-08', kind: 'meal', title: 'Pasta dinner', details: 'PRIVATE MEAL NOTE' }] });
  const result = shopping.getShopping(db);
  assert.equal(result.settings.provider, '');
  assert.equal(result.totals.budgetMinor, null);
  assert.equal(result.items.length, 0);
  assert.equal(result.plans[0].meals[0].title, 'Pasta dinner');
  assert.equal(result.checkout.supported, false);
  assert.equal(result.checkout.ordered, false);
  assert.equal(shopping.prepareShoppingList(db).canCreate, false);
});

test('only compatible explicit quantities combine and inventory states stay out of needed totals', () => {
  const db = fresh();
  add(db, { quantity: '2 cups', estimatedCost: 4 }); add(db, { name: 'oats', quantity: '1 cup', estimatedCost: 2 });
  add(db, { quantity: '1 kg', estimatedCost: null }); add(db, { quantity: '250 g', estimatedCost: 1 });
  add(db, { quantity: 'one large bag', estimatedCost: null }); add(db, { quantity: 'one large bag', estimatedCost: null });
  add(db, { state: 'have', estimatedCost: 20 }); add(db, { state: 'bought', estimatedCost: 30 });
  const result = shopping.getShopping(db);
  assert.equal(result.totals.items, 6);
  assert.equal(result.groups.length, 5);
  assert.equal(result.groups.find(group => group.unit === 'cup').quantity, 3);
  assert.equal(result.groups.filter(group => group.quantity === null).length, 2);
  assert.equal(result.totals.estimatedMinor, 700);
  assert.equal(result.totals.unknownPrices, 3);
  assert.deepEqual(shopping.parseGroceryQuantity('1/2 cup'), { quantity: 0.5, unit: 'cup' });
  for (const quantity of ['1/0 cup', '-2 kg', 'one cup', '3 unknownunits', '']) assert.equal(shopping.parseGroceryQuantity(quantity), null);
});

test('keys stay in the secret store and nearby retailers use the documented fixed endpoint', async () => {
  const db = fresh(), requests = [];
  const setup = await configured(db, { fetch: async (url, request) => { requests.push({ url, request }); return reply({ retailers: [{ retailer_key: 'fixture-store', name: 'Fixture Grocery' }] }); } });
  assert.equal(setup.secrets.get(shopping.SHOPPING_SECRET_REF), 'keys.synthetic-secret-123');
  assert.equal(requests[0].url, 'https://connect.instacart.com/idp/v1/retailers?postal_code=46201&country_code=US');
  assert.equal(requests[0].request.headers.Authorization, 'Bearer keys.synthetic-secret-123');
  assert.equal(requests[0].request.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM kv').all()), /synthetic-secret/);
  assert.doesNotMatch(JSON.stringify(shopping.getShopping(db)), /synthetic-secret/);
  await assert.rejects(shopping.saveShoppingSettings(db, { retailerKey: 'invented-store' }), /Find nearby stores/);
});

test('a reviewed list sends only product details, returns list_created and is reused without ordering', async () => {
  const db = fresh();
  health.saveProfile(db, { allergies: 'PRIVATE ALLERGY', diet: 'PRIVATE DIET', weeklyBudget: 30 });
  const plan = health.savePlan(db, { title: 'PRIVATE PLAN', weekStart: '2026-09-07', entries: [{ date: '2026-09-08', kind: 'meal', title: 'PRIVATE MEAL', details: 'PRIVATE MEDICAL DETAIL' }] }).plan;
  const item = add(db, { planId: plan.id, entryId: plan.entries[0].id });
  const { deps, requests } = await configured(db);
  const review = shopping.prepareShoppingList(db, { selectedIds: [item.id], title: 'Reviewed groceries' });
  assert.equal(review.canCreate, true);
  assert.equal(review.groups[0].meals[0], 'PRIVATE MEAL', 'local review keeps its source meal');
  const approved = { selectedIds: review.selectedIds, title: review.title, reviewToken: review.reviewToken, approved: true };
  const result = await shopping.createShoppingList(db, approved, deps);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://connect.instacart.com/idp/v1/products/products_link');
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.link_type, 'shopping_list');
  assert.deepEqual(payload.line_items[0].line_item_measurements, [{ quantity: 1, unit: 'cup' }]);
  assert.doesNotMatch(requests[0].body, /PRIVATE|Personal account|Fixture Grocery|weeklyBudget|retailer_key/);
  assert.equal(result.status, 'list_created');
  assert.equal(result.ordered, false);
  assert.equal(health.getHealth(db).groceryItems[0].state, 'needed');
  const repeated = await shopping.createShoppingList(db, approved, deps);
  assert.equal(repeated.cached, true);
  assert.equal(requests.length, 1, 'unchanged links are cached instead of recreated');
});

test('sharing requires explicit approval and rejects stale list, budget or settings reviews before external I/O', async () => {
  const db = fresh(), item = add(db);
  const { deps, requests } = await configured(db);
  const review = shopping.prepareShoppingList(db);
  await assert.rejects(shopping.createShoppingList(db, { ...review }, deps), /approve sharing/);
  health.saveGroceryItem(db, { ...item, quantity: '3 cups', expectedUpdatedAt: item.updatedAt });
  await assert.rejects(shopping.createShoppingList(db, { ...review, approved: true }, deps), /changed/);
  const second = shopping.prepareShoppingList(db); health.saveProfile(db, { weeklyBudget: 40 });
  await assert.rejects(shopping.createShoppingList(db, { ...second, approved: true }, deps), /changed/);
  const third = shopping.prepareShoppingList(db); await shopping.saveShoppingSettings(db, { accountLabel: 'Other account reminder' }, deps);
  await assert.rejects(shopping.createShoppingList(db, { ...third, approved: true }, deps), /changed/);
  assert.equal(requests.length, 0);
});

test('Have and Bought are explicit Health updates with stale-edit protection', () => {
  const db = fresh(), item = add(db);
  const saved = shopping.setShoppingItemState(db, { id: item.id, state: 'have', expectedUpdatedAt: item.updatedAt }).item;
  assert.equal(saved.quantity, item.quantity);
  assert.equal(shopping.getShopping(db).totals.items, 0);
  assert.throws(() => shopping.setShoppingItemState(db, { id: item.id, state: 'bought', expectedUpdatedAt: item.updatedAt }), /changed/);
  shopping.setShoppingItemState(db, { id: item.id, state: 'bought', expectedUpdatedAt: saved.updatedAt });
  assert.equal(health.getHealth(db).groceryItems[0].state, 'bought');
});

test('budget estimates remain partial when prices are unknown and cannot be mistaken for a final quote', () => {
  const db = fresh(); health.saveProfile(db, { weeklyBudget: 10 });
  add(db, { estimatedCost: 4 }); add(db, { name: 'Milk', estimatedCost: null });
  let result = shopping.prepareShoppingList(db);
  assert.equal(result.totals.status, 'partial_estimate');
  assert.equal(result.totals.estimatedMinor, 400);
  assert.equal(result.totals.unknownPrices, 1);
  add(db, { name: 'Fruit', estimatedCost: 9 }); result = shopping.prepareShoppingList(db);
  assert.equal(result.totals.status, 'over_estimate');
  assert.match(result.totals.note, /tax, fees and tips are not included/);
});

test('duplicate in-flight sharing is blocked and later edits do not erase the approved link', async () => {
  const db = fresh(), item = add(db);
  const { deps } = await configured(db);
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  deps.fetch = async () => { entered(); await new Promise(resolve => { release = resolve; }); return reply({ products_link_url: 'https://www.instacart.com/store/shopping_lists/concurrent' }); };
  const review = { ...shopping.prepareShoppingList(db), approved: true };
  const first = shopping.createShoppingList(db, review, deps); await enteredPromise;
  await assert.rejects(shopping.createShoppingList(db, review, deps), /already being created/);
  health.saveGroceryItem(db, { ...item, name: 'Newer grocery name', expectedUpdatedAt: item.updatedAt });
  release(); const result = await first;
  assert.equal(result.status, 'list_created');
  assert.equal(result.changedSinceReview, true);
  assert.equal(result.ordered, false);
});

test('provider errors, unexpected links and missing credentials never record a success or leak response contents', async () => {
  const db = fresh(); add(db); const { deps } = await configured(db);
  const review = { ...shopping.prepareShoppingList(db), approved: true };
  deps.fetch = async () => new Response('echo keys.synthetic-secret-123', { status: 403 });
  await assert.rejects(shopping.createShoppingList(db, review, deps), error => !error.message.includes('synthetic-secret') && /permissions/.test(error.message));
  deps.fetch = async () => reply({ products_link_url: 'https://instacart.com.attacker.invalid/cart' });
  await assert.rejects(shopping.createShoppingList(db, review, deps), /trusted shopping-list link/);
  deps.getSecret = async () => null;
  await assert.rejects(shopping.createShoppingList(db, review, deps), /API key is missing/);
  assert.equal(shopping.getShopping(db).lastResult, null);
});

test('an edit while the secret store unlocks invalidates approval before any provider request', async () => {
  const db = fresh(), item = add(db); const { deps, requests } = await configured(db);
  const review = { ...shopping.prepareShoppingList(db), approved: true };
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  deps.getSecret = async () => { entered(); await new Promise(resolve => { release = resolve; }); return 'keys.synthetic-secret-123'; };
  const pending = shopping.createShoppingList(db, review, deps);
  await enteredPromise;
  health.saveGroceryItem(db, { ...item, quantity: '5 cups', expectedUpdatedAt: item.updatedAt });
  release();
  await assert.rejects(pending, /changed/);
  assert.equal(requests.length, 0);
});

test('concurrent key saves serialize before secret access so the saved key and settings cannot diverge', async () => {
  const db = fresh();
  let release, entered, storedKey = null; const written = [];
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const deps = { setSecret: async (ref, value) => { written.push({ ref, value }); entered(); await new Promise(resolve => { release = resolve; }); storedKey = value; } };
  const first = shopping.saveShoppingSettings(db, { provider: 'instacart', accountLabel: 'First account reminder', apiKey: 'keys.first-fixture-key', expectedRevision: null }, deps);
  await enteredPromise;
  await assert.rejects(shopping.saveShoppingSettings(db, { provider: 'instacart', accountLabel: 'Second account reminder', apiKey: 'keys.second-fixture-key', expectedRevision: null }, deps), /already being saved/);
  assert.equal(written.length, 1);
  release(); await first;
  assert.equal(storedKey, 'keys.first-fixture-key');
  const settings = shopping.getShopping(db).settings;
  assert.equal(settings.accountLabel, 'First account reminder');
  assert.equal(settings.keySaved, true);
  await assert.rejects(shopping.saveShoppingSettings(db, { apiKey: 'keys.stale-fixture-key', expectedRevision: null }, deps), /changed/);
  assert.equal(written.length, 1, 'stale revisions never reach the secret store');
  assert.doesNotMatch(JSON.stringify(shopping.getShopping(db)), /keys\./);
});
