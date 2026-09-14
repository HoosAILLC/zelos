import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateHealth, saveProfile, getHealth } from '../core/health.mjs';
import { getGroceryStores, saveGroceryStores, GroceryStoresError } from '../core/grocery-stores.mjs';
import { getShopping, saveShoppingSettings, prepareShoppingList } from '../core/shopping.mjs';
import { generateMealWeek, getMealWeek, buildMealGroceries } from '../core/meal-planner.mjs';
import { samplePlan } from './helpers/meal-fixture.mjs';

const config = { model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'nemotron-3-nano:30b' } };
const input = { weekStart: '2026-09-14', servings: 1, maxMinutes: 45, instructions: '' };
const ids = ['costco', 'kroger', 'meijer'];
const reply = value => ({ text: JSON.stringify(value), stopReason: 'stop' });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE kv(k TEXT PRIMARY KEY,v TEXT)'); migrateHealth(db);
  saveProfile(db, { goals: 'Varied meals', diet: 'none', allergies: 'none', householdSize: 1, weeklyBudget: 80 });
  t.after(() => db.close()); return db;
}
const make = (db, complete = async () => reply(samplePlan())) => generateMealWeek({ db, config, input, complete });
const persist = (db, week) => db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)').run(`shopping.meals.${week.weekStart}`, JSON.stringify(week));

test('store preferences start empty, persist on Spark, and expose canonical editable stores without a connection', t => {
  const db = fixture(t), initial = getGroceryStores(db);
  assert.deepEqual(initial.stores, []); assert.equal(initial.revision, null);
  assert.deepEqual(initial.availableStores.slice(0, 3), [{ id: 'costco', name: 'Costco' }, { id: 'kroger', name: 'Kroger' }, { id: 'meijer', name: 'Meijer' }]);
  const saved = saveGroceryStores(db, { storeIds: ids, expectedRevision: null });
  assert.equal(typeof saved.revision, 'string'); assert.deepEqual(saved.stores.map(s => s.name), ['Costco', 'Kroger', 'Meijer']);
  assert.deepEqual(getGroceryStores(db), saved); assert.deepEqual(getShopping(db).storePreferences, saved);
  assert.equal(getShopping(db).settings.provider, ''); assert.equal(getShopping(db).settings.keySaved, false);
  assert.match(saved.note, /not checked store quotes/);
});

test('selection rejects invented stores, duplicates and stale-device writes, while deliberate clearing stays saved', t => {
  const db = fixture(t);
  for (const storeIds of [['https://price-api.invalid'], ['costco', 'costco'], ['Krojer'], 'costco', null]) {
    assert.throws(() => saveGroceryStores(db, { storeIds, expectedRevision: null }), GroceryStoresError);
  }
  assert.throws(() => saveGroceryStores(db, { storeIds: ids }), e => e.status === 409);
  const first = saveGroceryStores(db, { storeIds: ids, expectedRevision: null });
  assert.throws(() => saveGroceryStores(db, { storeIds: ['aldi'], expectedRevision: null }), e => e.status === 409);
  const repeated = saveGroceryStores(db, { storeIds: [...ids].reverse(), expectedRevision: first.revision });
  assert.equal(repeated.revision, first.revision);
  const cleared = saveGroceryStores(db, { storeIds: [], expectedRevision: first.revision });
  assert.deepEqual(cleared.stores, []); assert.notEqual(cleared.revision, first.revision); assert.deepEqual(getGroceryStores(db), cleared);
});

test('preferred stores never configure a checkout provider or alter its approved sharing payload', async t => {
  const db = fixture(t);
  await saveShoppingSettings(db, { provider: 'instacart', countryCode: 'US', postalCode: '46201', accountLabel: 'Account reminder' });
  const settings = getShopping(db).settings, before = prepareShoppingList(db);
  saveGroceryStores(db, { storeIds: ids, expectedRevision: null });
  assert.deepEqual(getShopping(db).settings, settings);
  const after = prepareShoppingList(db);
  assert.equal(after.reviewToken, before.reviewToken); assert.deepEqual(after.sharedData, before.sharedData);
  assert.doesNotMatch(JSON.stringify(after.sharedData), /Costco|Kroger|Meijer/);
});

test('local meal generation receives store preferences and labels unverified estimates without changing health evidence', async t => {
  const db = fixture(t), first = await make(db), before = JSON.stringify(getHealth(db));
  const preferences = saveGroceryStores(db, { storeIds: ids, expectedRevision: null }); let request;
  const week = await make(db, async r => { request = r; return reply(samplePlan()); });
  const prompt = request.messages[0].content;
  for (const store of ['Costco', 'Kroger', 'Meijer']) assert.match(prompt, new RegExp(store));
  assert.match(prompt, /not connected inventory or pricing feeds/);
  assert.match(prompt, /without assuming large packages are cheaper/);
  assert.match(prompt, /Do not infer the user has any membership/);
  assert.deepEqual(week.preferredStores, preferences.stores); assert.equal(week.storePreferencesRevision, preferences.revision);
  assert.match(week.priceNote, /not checked store quotes/);
  assert.equal(week.contextFingerprint, first.contextFingerprint); assert.equal(JSON.stringify(getHealth(db)), before);
});

test('changing stores keeps current weeks, grocery choices and health freshness intact, including during generation', async t => {
  const db = fixture(t), week = await make(db); persist(db, week);
  const first = saveGroceryStores(db, { storeIds: ids, expectedRevision: null });
  assert.deepEqual(getMealWeek(db, input.weekStart).week, week); assert.equal(getMealWeek(db, input.weekStart).stale, false);
  const saved = buildMealGroceries(db, { weekStart: input.weekStart, weekId: week.id, expectedRevision: week.revision, selectedIds: ['0-breakfast'] });
  const beforeHealth = JSON.stringify(getHealth(db));
  const next = await make(db, async () => {
    saveGroceryStores(db, { storeIds: ['meijer'], expectedRevision: first.revision }); return reply(samplePlan());
  });
  assert.deepEqual(next.preferredStores, first.stores, 'completed generation keeps the preferences it actually used');
  assert.equal(getMealWeek(db, input.weekStart).stale, false);
  assert.deepEqual(getMealWeek(db, input.weekStart).week, saved.week);
  assert.equal(JSON.stringify(getHealth(db)), beforeHealth);
  assert.deepEqual(getMealWeek(db, input.weekStart).storePreferences.stores, [{ id: 'meijer', name: 'Meijer' }]);
});

test('generated meals cannot advertise unchecked store prices or stock', async t => {
  const db = fixture(t);
  for (const reason of ['Current store prices make this a bargain.', 'This ingredient is on sale.', 'In stock at Kroger.', 'Use your membership discount.']) {
    const value = samplePlan(); value.recipes[0].reason = reason;
    await assert.rejects(make(db, async () => reply(value)), /cannot verify/);
  }
  const value = samplePlan(); value.recipes[0].steps[0] = 'Cook the rice in stock until tender.';
  await assert.doesNotReject(make(db, async () => reply(value)));
});
