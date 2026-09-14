import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';
import { samplePlan } from './helpers/meal-fixture.mjs';
let sequence = 0;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const base = {
  settings: { provider: '', environment: 'production', countryCode: '', postalCode: '', accountLabel: '', retailerKey: '', keySaved: false, revision: null },
  setupIssues: ['Choose a grocery provider.'], retailers: [], providerNote: 'Confirm the store and account on Instacart.',
  items: [{ id: 'oats', name: 'Oats <img onerror=bad>', quantity: '1 cup', estimatedCost: 3, state: 'needed', updatedAt: '2026-09-11T12:00:00Z', mealTitle: 'Breakfast', planTitle: 'Saved plan', mealState: 'planned' }],
  groups: [{ name: 'Oats <img onerror=bad>', quantityText: '1 cup', itemIds: ['oats'], quantity: 1, unit: 'cup' }],
  totals: { items: 1, estimatedMinor: 300, unknownPrices: 0, budgetMinor: null, currency: 'USD', status: 'budget_unset', note: 'Entered estimates only.' },
  checkout: { message: 'Zelos cannot place an order. Review checkout on Instacart.' }, lastResult: null,
};
async function fixture(t, initial = base) {
  const document = installDom(t), { api } = await import('../ui/lib/api.js'), data = structuredClone(initial), calls = [];
  const names = ['shopping', 'saveShoppingSettings', 'shoppingStores', 'reviewShoppingList', 'createShoppingList', 'setShoppingItemState', 'mealWeek', 'mealLibrary', 'saveMealTaste', 'addMealFromLibrary'];
  const previous = Object.fromEntries(names.map(name => [name, api[name]]));
  const reads = { shopping: [], week: [], library: [] };
  const planning = { week: null, profile: { goals: 'Varied meals', diet: 'none', allergies: 'none', householdSize: 1, weeklyBudget: 80, currency: 'USD', updatedAt: 'profile-v1' },
    health: { labCount: 0 }, storePreferences: { stores: [], availableStores: [], revision: null }, job: null, stale: false };
  const library = { recipes: [{ ...samplePlan().recipes[3], title: 'Peanut rice bowl', discoveryId: 'catalog:synthetic', origin: 'library', servings: 1, costLow: 110, costHigh: 180, priceCurrency: 'USD', tags: ['vegan'], protein: 'Legumes', cuisine: 'Everyday' }],
    favorites: [], skipped: [], revision: 'taste1', sources: [], currency: 'USD', totalCount: 1, excludedCount: 0, warnings: [], blocked: false };
  api.shopping = async weekStart => { reads.shopping.push(weekStart); return structuredClone(data); };
  api.mealWeek = async weekStart => { reads.week.push(weekStart); return structuredClone(planning); };
  api.mealLibrary = async weekStart => { reads.library.push(weekStart); return structuredClone(library); };
  api.saveMealTaste = api.addMealFromLibrary = async () => { throw new Error('Reading groceries must not change meal choices or preferences.'); };
  api.saveShoppingSettings = async value => { calls.push({ type: 'settings', value }); return {}; };
  api.shoppingStores = async value => { calls.push({ type: 'stores', value }); return { retailers: [] }; };
  api.reviewShoppingList = async value => { calls.push({ type: 'review', value }); return { ...value, reviewToken: 'exact-reviewed-token', groups: structuredClone(data.groups),
    totals: structuredClone(data.totals), storeName: 'Fixture store', accountLabel: 'Personal', privacyNote: 'Only selected products are shared.', canCreate: true, issues: [], environment: 'production' }; };
  api.createShoppingList = async value => { calls.push({ type: 'create', value }); const result = { status: 'list_created', ordered: false, title: value.title,
    url: 'https://www.instacart.com/store/shopping_lists/fixture', message: 'Shopping list created. No order has been placed by Zelos.' }; data.lastResult = result; return result; };
  api.setShoppingItemState = async value => { calls.push({ type: 'state', value }); const row = data.items.find(item => item.id === value.id); row.state = value.state; data.groups = []; return { item: row }; };
  t.after(() => Object.assign(api, previous));
  const module = await import(`../ui/views/shopping.js?test=${++sequence}`);
  const view = document.body.appendChild(module.renderShopping()); await settle();
  return { view, data, calls, api, document, module, reads, planning, library };
}

test('shopping renders saved facts safely and does not connect or create a list on load', async t => {
  const { view, calls } = await fixture(t);
  assert.equal(view.querySelectorAll('img').length, 0);
  assert.match(text(view), /Oats <img onerror=bad>/);
  assert.match(text(view), /Connect a store/);
  assert.match(text(view), /Weekly budget Not set/);
  assert.equal(view.querySelector('[aria-label="Instacart developer API key"]').value, '');
  assert.equal(calls.length, 0);
  assert.equal(view.querySelectorAll('.shopping-group').length, 1);
});

test('creation requires a separate review click and submits exactly the reviewed list', async t => {
  const { view, calls } = await fixture(t);
  const title = view.querySelector('[aria-label="Shopping list title"]'); title.value = 'My chosen groceries'; title.fire('input');
  findButton(view, 'Review 1 selected item').click(); await settle();
  assert.deepEqual(calls[0], { type: 'review', value: { title: 'My chosen groceries', selectedIds: ['oats'] } });
  assert.equal(calls.some(call => call.type === 'create'), false);
  assert.match(text(view), /It does not place an order or authorize a payment/);
  findButton(view, 'Create Instacart list').click(); await settle();
  assert.deepEqual(calls.find(call => call.type === 'create').value, { title: 'My chosen groceries', selectedIds: ['oats'], reviewToken: 'exact-reviewed-token', approved: true });
  assert.match(text(view), /Last shopping list created/);
  assert.match(text(view), /No order has been placed/);
  assert.equal(view.querySelectorAll('a').find(link => link.getAttribute('href') === 'https://www.instacart.com/store/shopping_lists/fixture').getAttribute('rel'), 'noopener noreferrer');
});

test('editing the title invalidates the visible approval rather than leaving a stale share button', async t => {
  const { view, calls } = await fixture(t);
  findButton(view, 'Review 1 selected item').click(); await settle();
  assert.ok(view.querySelector('[aria-label="Review grocery sharing"]'));
  assert.equal(view.querySelector('[aria-label="Shopping list title"]'), null);
  findButton(view, 'Back to editing').click();
  const title = view.querySelector('[aria-label="Shopping list title"]'); title.value = 'Changed title'; title.fire('input');
  assert.equal(view.querySelector('[aria-label="Review grocery sharing"]'), null);
  assert.equal(calls.some(call => call.type === 'create'), false);
});

test('Have is an explicit saved Health update with the current revision', async t => {
  const { view, calls } = await fixture(t);
  const status = view.querySelector('[aria-label="Status of Oats <img onerror=bad> for Breakfast (1 cup)"]');
  status.value = 'have'; status.fire('change'); await settle();
  assert.deepEqual(calls.find(call => call.type === 'state').value, { id: 'oats', state: 'have', expectedUpdatedAt: '2026-09-11T12:00:00Z' });
  assert.match(text(view), /Already have/);
  assert.equal(calls.some(call => call.type === 'create'), false);
});

test('connection settings save the entered key explicitly and never render a returned credential', async t => {
  const { view, calls } = await fixture(t);
  const values = { 'Grocery provider': 'instacart', Country: 'US', 'Postal code': '46201', 'Instacart account reminder': 'Personal', 'Instacart developer API key': 'keys.fixture-secret' };
  for (const [label, value] of Object.entries(values)) view.querySelector(`[aria-label="${label}"]`).value = value;
  findButton(view, 'Save connection and store').click(); await settle();
  const saved = calls.find(call => call.type === 'settings').value;
  assert.equal(saved.apiKey, 'keys.fixture-secret');
  assert.equal(saved.provider, 'instacart');
  assert.equal(saved.postalCode, '46201');
  assert.equal(saved.expectedRevision, null);
  assert.doesNotMatch(text(view), /keys.fixture-secret/);
  assert.equal(calls.some(call => call.type === 'stores' || call.type === 'create'), false);
});

test('empty groceries have no invented plan ingredients or enabled sharing action', async t => {
  const empty = structuredClone(base); empty.items = []; empty.groups = []; empty.totals.items = 0;
  const { view, calls } = await fixture(t, empty);
  assert.match(text(view), /Your grocery list is empty/);
  assert.equal(findButton(view, 'Review 0 selected items').disabled, true);
  assert.equal(calls.length, 0);
});

test('unsaved grocery setup survives selection changes, refresh and a failed save without leaking the key', async t => {
  const {view,calls,api}=await fixture(t);
  for(const [label,value] of [['Instacart account reminder','My unsaved account'],['Instacart developer API key','private-unsaved-key']]) {
    const node=view.querySelector(`[aria-label="${label}"]`);node.value=value;node.fire('input');
  }
  findButton(view,'Clear selection').click();findButton(view,'Refresh').click();await settle();
  assert.equal(view.querySelector('[aria-label="Instacart account reminder"]').value,'My unsaved account');
  assert.equal(view.querySelector('[aria-label="Instacart developer API key"]').value,'private-unsaved-key');
  assert.ok(!text(view).includes('private-unsaved-key'));assert.equal(calls.length,0);
  api.saveShoppingSettings=async()=>{throw new Error('Settings changed elsewhere');};findButton(view,'Save connection and store').click();await settle();
  assert.equal(view.querySelector('[aria-label="Instacart account reminder"]').value,'My unsaved account');
  assert.equal(view.querySelector('[aria-label="Instacart developer API key"]').value,'private-unsaved-key');
  assert.match(text(view),/Settings changed elsewhere/);
});

test('grocery setup changes invalidate sharing and Health links target the relevant section',async t=>{
 const {view,calls}=await fixture(t);findButton(view,'Review 1 selected item').click();await settle();
 assert.equal(view.querySelector('[aria-label="Instacart account reminder"]'),null);
 findButton(view,'Back to editing').click();
 const account=view.querySelector('[aria-label="Instacart account reminder"]');account.value='Different account';account.fire('input');
 assert.equal(view.querySelector('[aria-label="Review grocery sharing"]'),null);
 findButton(view,'Review 1 selected item').click();await settle();assert.equal(calls.filter(call=>call.type==='review').length,1);
 assert.match(text(view),/Save your connection and store changes/);
 const links=view.querySelectorAll('a').map(link=>link.getAttribute('href'));
 assert.ok(links.includes('#/health/profile'));assert.ok(links.includes('#/health/groceries'));
});

test('returning to Groceries refreshes Health preferences and recipe eligibility while retaining discovery filters', async t => {
 const { view, document, module, reads, planning, library, calls } = await fixture(t, { ...base, mealPlanner: true });
 const planner = view.querySelector('.meal-planner'), discovery = view.querySelector('.meal-discovery');
 assert.ok(discovery); assert.equal(reads.week.length, 1); assert.equal(reads.library.length, 1);
 assert.match(text(discovery), /Peanut rice bowl/);
 const search = view.querySelector('[aria-label="Search meal ideas"]'); search.value = 'bowl'; search.fire('input');
 view.remove();
 planning.profile = { ...planning.profile, allergies: 'peanuts', updatedAt: 'profile-v2' };
 planning.health.labCount = 2;
 library.recipes = [{ ...library.recipes[0], discoveryId: 'catalog:bean-bowl', title: 'Bean rice bowl' }];
 library.revision = 'taste2';
 const reopened = document.body.appendChild(module.renderShopping()); await settle();
 assert.equal(reopened, view); assert.equal(view.querySelector('.meal-planner'), planner);
 assert.equal(view.querySelector('.meal-discovery'), discovery);
 assert.equal(reads.shopping.length, 2); assert.equal(reads.week.length, 2); assert.equal(reads.library.length, 2);
 assert.equal(view.querySelector('[aria-label="Food allergies"]').value, 'peanuts');
 assert.match(text(view), /2 saved lab results/);
 assert.equal(view.querySelector('[aria-label="Search meal ideas"]'), search); assert.equal(search.value, 'bowl');
 assert.match(text(discovery), /Bean rice bowl/); assert.doesNotMatch(text(discovery), /Peanut rice bowl/);
 assert.equal(calls.length, 0);
});

function groceryWeek(id, name) {
 const result = structuredClone({ ...base, mealPlanner: true });
 result.items = [{ ...result.items[0], id, name }];
 result.groups = [{ ...result.groups[0], name, itemIds: [id] }];
 return result;
}

test('a late grocery response from an earlier week cannot overwrite the current list or its review selection', async t => {
 const { view, api, calls } = await fixture(t, { ...base, mealPlanner: true }), requests = [];
 api.shopping = weekStart => { const pending = defer(); requests.push({ weekStart, ...pending }); return pending.promise; };
 findButton(view, 'Next meal week').click(); await settle();
 findButton(view, 'Next meal week').click(); await settle();
 assert.equal(requests.length, 2); assert.notEqual(requests[0].weekStart, requests[1].weekStart);
 requests[1].resolve(groceryWeek('current-rice', 'Current week rice')); await settle();
 assert.equal(findButton(view, 'Refresh').disabled, false);
 assert.match(text(view.querySelector('.shopping-group')), /Current week rice/);
 const current = view.querySelector('[aria-label="Include Current week rice"]'); assert.equal(current.checked, true);
 // A newer local selection is also protected from the older response.
 current.checked = false; current.fire('change');
 requests[0].resolve(groceryWeek('older-oats', 'Earlier week oats')); await settle();
 assert.match(text(view.querySelector('.shopping-group')), /Current week rice/);
 assert.doesNotMatch(text(view), /Earlier week oats/);
 assert.equal(view.querySelector('[aria-label="Include Current week rice"]').checked, false);
 assert.equal(findButton(view, 'Review 0 selected items').disabled, true);
 findButton(view, 'Select needed').click(); findButton(view, 'Review 1 selected item').click(); await settle();
 assert.deepEqual(calls.find(call => call.type === 'review').value.selectedIds, ['current-rice']);
 assert.equal(calls.some(call => call.type === 'create' || call.type === 'state'), false);
});

test('finishing an older grocery request does not release the current week loading guard', async t => {
 const { view, api, calls } = await fixture(t, { ...base, mealPlanner: true }), requests = [];
 api.shopping = weekStart => { const pending = defer(); requests.push({ weekStart, ...pending }); return pending.promise; };
 findButton(view, 'Next meal week').click(); await settle();
 findButton(view, 'Next meal week').click(); await settle();
 assert.equal(requests.length, 2);
 requests[0].resolve(groceryWeek('older-oats', 'Earlier week oats')); await settle();
 assert.equal(findButton(view, 'Working…').disabled, true);
 assert.equal(findButton(view, 'Review 1 selected item').disabled, true);
 assert.doesNotMatch(text(view), /Earlier week oats/);
 requests[1].resolve(groceryWeek('current-rice', 'Current week rice')); await settle();
 assert.equal(findButton(view, 'Refresh').disabled, false);
 assert.equal(findButton(view, 'Review 1 selected item').disabled, false);
 assert.match(text(view.querySelector('.shopping-group')), /Current week rice/);
 assert.equal(calls.length, 0);
});
