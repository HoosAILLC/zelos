/** Reviewed groceries from Health. Local planning; explicit Instacart list creation, never checkout. */
import { createHash, randomUUID } from 'node:crypto';
import { getHealth, saveGroceryItem, healthDate } from './health.mjs';
import { getSecret as readSecret, setSecret as writeSecret } from './secrets.mjs';
import { getGroceryStores } from './grocery-stores.mjs';

export const SHOPPING_SECRET_REF = 'shopping.instacart.apiKey';
export class ShoppingError extends Error {
  constructor(status, message) { super(message); this.name = 'ShoppingError'; this.status = status; }
}
const fail = (message, status = 400) => { throw new ShoppingError(status, message); };
const stamp = () => new Date().toISOString();
const get = (db, key, fallback) => { try { return JSON.parse(db.prepare('SELECT v FROM kv WHERE k=?').get(`shopping.${key}`)?.v) ?? fallback; } catch { return fallback; } };
const put = (db, key, value) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(`shopping.${key}`, JSON.stringify(value));
const text = (value, label, max = 200, required = false) => {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || required && !value.trim()) fail(`${label} is missing or invalid.`);
  return value.trim();
};
const defaults = () => ({ provider: '', environment: 'production', countryCode: '', postalCode: '', retailerKey: '', storeName: '', accountLabel: '', keySaved: false, revision: null });
const settingsOf = db => ({ ...defaults(), ...get(db, 'settings', {}) });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const moneyMinor = value => value == null ? null : Math.round(value * 100);
const active = new WeakSet();
const settingsActive = new WeakSet();

/** Checkout has no adapter. A future implementation must quote and bind these exact fields before approval. */
export const CHECKOUT_APPROVAL_CONTRACT = Object.freeze({
  supported: false, status: 'not_available', ordered: false,
  required: ['provider', 'verifiedAccount', 'retailer', 'productsAndQuantities', 'substitutionChoices',
    'finalPrices', 'taxesFeesTip', 'totalAndCurrency', 'deliveryOrPickupAddress', 'deliveryWindow', 'paymentMethod', 'expiresAt', 'explicitPurchaseApproval'],
  message: 'Complete checkout on Instacart after reviewing the store, products, final total and delivery details. Zelos cannot place an order.',
});

export async function saveShoppingSettings(db, input, deps = {}) {
  if (settingsActive.has(db)) fail('Grocery settings are already being saved. Wait for that result before saving again.', 409);
  settingsActive.add(db);
  try { return await saveSettings(db, input, deps); }
  finally { settingsActive.delete(db); }
}
async function saveSettings(db, input, deps) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide grocery settings.');
  const previous = settingsOf(db), next = { ...previous };
  if (input.expectedRevision !== undefined && input.expectedRevision !== previous.revision) fail('Grocery settings changed. Refresh before saving.', 409);
  for (const [key, allowed] of [['provider', ['', 'instacart']], ['environment', ['production', 'development']], ['countryCode', ['', 'US', 'CA']]]) {
    if (input[key] !== undefined) { if (!allowed.includes(input[key])) fail(`Choose a valid ${key}.`); next[key] = input[key]; }
  }
  if (input.postalCode !== undefined) next.postalCode = text(input.postalCode, 'Postal code', 12).toUpperCase();
  if (input.accountLabel !== undefined) next.accountLabel = text(input.accountLabel, 'Account reminder', 150);
  if (next.countryCode !== previous.countryCode || next.postalCode !== previous.postalCode || next.environment !== previous.environment) {
    next.retailerKey = ''; next.storeName = '';
  }
  if (input.retailerKey !== undefined) {
    const retailerKey = text(input.retailerKey, 'Store', 150);
    const cache = get(db, 'retailers', {});
    const store = cache.countryCode === next.countryCode && cache.postalCode === next.postalCode && cache.environment === next.environment
      ? cache.retailers?.find(store => store.key === retailerKey) : null;
    if (retailerKey && !store) fail('Find nearby stores and choose one from that list.');
    next.retailerKey = retailerKey; next.storeName = store?.name || '';
  }
  if (input.apiKey !== undefined && input.apiKey !== '') {
    const key = text(input.apiKey, 'Instacart API key', 4000, true);
    if (/\s/.test(key) || key.length < 8) fail('Enter the API key supplied by Instacart.');
    await (deps.setSecret || writeSecret)(SHOPPING_SECRET_REF, key);
    next.keySaved = true;
  }
  if (settingsOf(db).revision !== previous.revision) fail('Grocery settings changed while the key was being saved. Refresh before saving again.', 409);
  next.revision = randomUUID(); next.updatedAt = stamp();
  put(db, 'settings', next);
  return { settings: next };
}

const UNITS = new Map(Object.entries({ each: 'each', item: 'each', items: 'each',
  g: 'g', gram: 'g', grams: 'g', kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', oz: 'oz', ounce: 'oz', ounces: 'oz',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', l: 'l', liter: 'l', liters: 'l',
  cup: 'cup', cups: 'cup', tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbs', tablespoon: 'tbs', tablespoons: 'tbs', tbs: 'tbs',
  gallon: 'gallon', gallons: 'gallon', pint: 'pint', pints: 'pint', quart: 'quart', quarts: 'quart',
  bunch: 'bunch', bunches: 'bunch', can: 'can', cans: 'can', head: 'head', heads: 'head', package: 'package', packages: 'package', packet: 'packet' }));
export function parseGroceryQuantity(value) {
  const source = String(value || '').trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*([a-z ]*)$/.exec(source);
  if (!match) return null;
  const amount = match[1].includes('/') ? match[1].split('/').map(Number).reduce((a, b) => a / b) : Number(match[1]);
  const unit = match[2] ? UNITS.get(match[2].trim()) : 'each';
  return Number.isFinite(amount) && amount > 0 && amount <= 1000000 && unit ? { quantity: amount, unit } : null;
}
function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    const quantity = parseGroceryQuantity(item.quantity);
    const key = `${item.name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}|${quantity?.unit || item.id}`;
    let group = groups.get(key);
    if (!group) { group = { name: item.name, quantity: quantity?.quantity ?? null, unit: quantity?.unit ?? null,
      quantityText: item.quantity || 'Quantity not entered', itemIds: [], estimatedMinor: 0, unknownPrices: 0, meals: [] }; groups.set(key, group); }
    else if (quantity) group.quantity = Math.round((group.quantity + quantity.quantity) * 1000000) / 1000000;
    group.itemIds.push(item.id);
    if (item.estimatedCost === null) group.unknownPrices++; else group.estimatedMinor += moneyMinor(item.estimatedCost);
    if (item.mealTitle && !group.meals.includes(item.mealTitle)) group.meals.push(item.mealTitle);
    if (group.quantity !== null) group.quantityText = `${group.quantity} ${group.unit}`;
  }
  return [...groups.values()];
}
function records(db) {
  const health = getHealth(db);
  return { profile: { weeklyBudget: health.profile.weeklyBudget, currency: health.profile.currency },
    plans: health.plans.map(plan => ({ id: plan.id, title: plan.title, weekStart: plan.weekStart,
      meals: plan.entries.filter(entry => entry.kind === 'meal').map(({ id, title, state }) => ({ id, title, state })) })),
    items: health.groceryItems.map(item => {
      const plan = health.plans.find(plan => plan.id === item.planId), meal = plan?.entries.find(entry => entry.id === item.entryId && entry.kind === 'meal');
      return { ...item, planTitle: plan?.title || '', mealTitle: meal?.title || '', mealState: meal?.state || null };
    }) };
}
function totals(items, profile) {
  const estimatedMinor = items.reduce((sum, item) => sum + (moneyMinor(item.estimatedCost) || 0), 0);
  const unknownPrices = items.filter(item => item.estimatedCost === null).length, budgetMinor = moneyMinor(profile.weeklyBudget);
  return { items: items.length, estimatedMinor, unknownPrices, budgetMinor, currency: profile.currency,
    status: budgetMinor === null ? 'budget_unset' : estimatedMinor > budgetMinor ? 'over_estimate' : unknownPrices ? 'partial_estimate' : 'within_estimate',
    note: 'Rough ingredient estimates, including saved meal estimates. Full packages and store prices may cost more; tax, fees and tips are not included.' };
}
function setupIssues(settings) {
  return [!settings.provider && 'Choose a grocery provider.', !settings.keySaved && 'Save an Instacart developer API key.',
    !settings.retailerKey && 'Find and choose your preferred store.', !settings.accountLabel && 'Add a reminder for the Instacart account you will use.'].filter(Boolean);
}
export function getShopping(db, { weekStart } = {}) {
  if (weekStart) healthDate(weekStart);
  const data = records(db), settings = settingsOf(db);
  if (weekStart) data.items = data.items.filter(item => !item.planId?.startsWith('meal_week_') || item.planId === `meal_week_${weekStart}`);
  const needed = data.items.filter(item => item.state === 'needed');
  const retailers = get(db, 'retailers', {}), last = get(db, 'lastResult', null);
  return { ...data, mealPlanner: true, settings, storePreferences: getGroceryStores(db), setupIssues: setupIssues(settings), groups: groupItems(needed), totals: totals(needed, data.profile),
    retailers: retailers.countryCode === settings.countryCode && retailers.postalCode === settings.postalCode && retailers.environment === settings.environment ? retailers.retailers || [] : [],
    lastResult: last, checkout: CHECKOUT_APPROVAL_CONTRACT,
    providerNote: 'Your store and account reminders stay in Zelos. Confirm the actual store and signed-in account on Instacart; its list API does not select them.' };
}
export function setShoppingItemState(db, input) {
  if (!['needed', 'have', 'bought'].includes(input?.state)) fail('Choose Needed, Already have or Bought.');
  const item = records(db).items.find(item => item.id === input.id);
  if (!item) fail('This grocery item no longer exists.', 404);
  if (!input.expectedUpdatedAt || input.expectedUpdatedAt !== item.updatedAt) fail('This grocery item changed. Refresh before updating it.', 409);
  return saveGroceryItem(db, { ...item, state: input.state, expectedUpdatedAt: input.expectedUpdatedAt });
}

async function requestProvider(settings, endpoint, request, deps) {
  if (settings.provider !== 'instacart') fail('Choose Instacart before connecting.');
  const key = await (deps.getSecret || readSecret)(SHOPPING_SECRET_REF);
  if (typeof key !== 'string' || !key.trim()) fail('The Instacart API key is missing. Save it in grocery settings.', 409);
  const base = settings.environment === 'development' ? 'https://connect.dev.instacart.tools' : 'https://connect.instacart.com';
  const timeout = AbortSignal.timeout(20000), signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  deps.beforeRequest?.();
  let response;
  try {
    response = await (deps.fetch || globalThis.fetch)(`${base}${endpoint}`, { ...request,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' }, signal, redirect: 'error' });
  } catch { fail('Instacart did not confirm a result. No order was placed by Zelos. Try again when the connection is available.', 502); }
  if (!response.ok) fail(response.status === 401 || response.status === 403
    ? 'Instacart did not accept this key or its permissions. Check developer access for shopping lists.'
    : `Instacart could not complete the request (HTTP ${response.status}).`, 502);
  try {
    const reader = response.body.getReader(); let raw = '', bytes = 0; const decoder = new TextDecoder();
    while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > 1000000) { await reader.cancel(); fail('Instacart returned an oversized response.', 502); }
      raw += decoder.decode(value, { stream: true }); }
    raw += decoder.decode(); return JSON.parse(raw);
  } catch (error) { if (error instanceof ShoppingError) throw error; fail('Instacart returned an unreadable response. No order was placed by Zelos.', 502); }
}
export async function findShoppingStores(db, input = {}, deps = {}) {
  const settings = settingsOf(db);
  if (!['US', 'CA'].includes(settings.countryCode) || !settings.postalCode) fail('Save your country and postal code first.');
  const postal = settings.postalCode;
  if (settings.countryCode === 'US' ? !/^\d{5}(?:-\d{4})?$/.test(postal) : !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(postal)) fail('Enter a valid postal code for the selected country.');
  const query = new URLSearchParams({ postal_code: postal, country_code: settings.countryCode });
  const response = await requestProvider(settings, `/idp/v1/retailers?${query}`, { method: 'GET' }, { ...deps,
    beforeRequest: () => { if (settingsOf(db).revision !== settings.revision) fail('Grocery settings changed. Save them before finding stores again.', 409); } });
  if (!Array.isArray(response.retailers)) fail('Instacart returned no readable store list.', 502);
  const retailers = response.retailers.slice(0, 200).flatMap(store => typeof store.retailer_key === 'string' && typeof store.name === 'string'
    ? [{ key: text(store.retailer_key, 'Store identifier', 150, true), name: text(store.name, 'Store name', 200, true) }] : []);
  if (settingsOf(db).revision !== settings.revision) fail('Grocery settings changed while finding stores. Try again.', 409);
  put(db, 'retailers', { environment: settings.environment, countryCode: settings.countryCode, postalCode: postal, retailers, fetchedAt: stamp() });
  return { retailers };
}
export function prepareShoppingList(db, input = {}) {
  const data = records(db), settings = settingsOf(db), available = data.items.filter(item => item.state === 'needed');
  const selectedIds = input.selectedIds === undefined ? available.map(item => item.id) : input.selectedIds;
  if (!Array.isArray(selectedIds) || selectedIds.length > 100 || selectedIds.some(id => typeof id !== 'string' || id.length > 150)) fail('Choose up to 100 grocery records.');
  const ids = new Set(selectedIds), selected = available.filter(item => ids.has(item.id));
  if (selected.length !== ids.size) fail('A selected grocery item changed or is no longer needed. Refresh the list.', 409);
  const title = text(input.title ?? 'My grocery list', 'List title', 120, true), groups = groupItems(selected);
  const payload = { title, link_type: 'shopping_list', expires_in: 7,
    line_items: groups.map(group => ({ name: group.name, display_text: `${group.name} — ${group.quantityText}`,
      ...(group.quantity !== null ? { line_item_measurements: [{ quantity: group.quantity, unit: group.unit }] } : {}) })),
    landing_page_configuration: { enable_pantry_items: true } };
  const summary = totals(selected, data.profile), issues = setupIssues(settings);
  if (!selected.length) issues.push('Select at least one needed grocery item.');
  const reviewToken = hash({ payload, ids: selected.map(item => [item.id, item.updatedAt]), settingsRevision: settings.revision, profile: data.profile });
  return { status: 'review_required', ordered: false, reviewToken, title, selectedIds: selected.map(item => item.id), groups, totals: summary,
    storeName: settings.storeName, accountLabel: settings.accountLabel, environment: settings.environment, issues, canCreate: !issues.length,
    sharedData: payload, privacyNote: 'Only this title, product names and quantities are sent to Instacart. Health records, meal notes, budget and account reminders stay on the computer running Zelos.',
    checkout: CHECKOUT_APPROVAL_CONTRACT };
}
function safeProviderLink(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
    && ['instacart.com', 'instacart.ca', 'instacart.tools'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null; } catch { return null; }
}
export async function createShoppingList(db, input, deps = {}) {
  if (input?.approved !== true) fail('Review the exact list and approve sharing it with Instacart first.', 409);
  const review = prepareShoppingList(db, input);
  if (typeof input.reviewToken !== 'string' || input.reviewToken !== review.reviewToken) fail('The grocery list or settings changed. Review the current list before sharing it.', 409);
  if (!review.canCreate) fail(review.issues.join(' '), 409);
  const cached = get(db, 'links', []).find(result => result.reviewToken === review.reviewToken && Date.parse(result.expiresAt) > Date.now());
  if (cached) return { ...cached, cached: true };
  if (active.has(db)) fail('A grocery list is already being created. Wait for its result.', 409);
  active.add(db);
  try {
    const response = await requestProvider(settingsOf(db), '/idp/v1/products/products_link', { method: 'POST', body: JSON.stringify(review.sharedData) }, { ...deps,
      beforeRequest: () => { if (prepareShoppingList(db, input).reviewToken !== review.reviewToken) fail('The grocery list or settings changed. Review the current list before sharing it.', 409); } });
    const url = safeProviderLink(response.products_link_url);
    if (!url) fail('Instacart did not return a trusted shopping-list link. No order was placed by Zelos.', 502);
    const result = { status: 'list_created', ordered: false, url, title: review.title, reviewToken: review.reviewToken,
      storeName: review.storeName, accountLabel: review.accountLabel, environment: review.environment,
      createdAt: stamp(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      message: 'Shopping list created. Open Instacart to review its store, quantities, prices and checkout. No order has been placed by Zelos.' };
    try { result.changedSinceReview = prepareShoppingList(db, input).reviewToken !== review.reviewToken; } catch { result.changedSinceReview = true; }
    put(db, 'links', [result, ...get(db, 'links', []).filter(row => row.reviewToken !== review.reviewToken)].slice(0, 20));
    put(db, 'lastResult', result); return result;
  } finally { active.delete(db); }
}
