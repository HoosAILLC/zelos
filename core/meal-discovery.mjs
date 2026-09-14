/** A private, deterministic recipe library. This module never calls a model or a store. */
import { createHash, randomUUID } from 'node:crypto';
import { MEAL_CATALOG } from './meal-catalog.mjs';
import * as planner from './meal-planner.mjs';
import { mealFoodRules, checkFood, HealthPlannerError } from './health-planner.mjs';
import { getGroceryStores } from './grocery-stores.mjs';

export class MealDiscoveryError extends HealthPlannerError {
  constructor(message, status = 422) { super(message, { code: 'meal_discovery', status }); this.name = 'MealDiscoveryError'; }
}
const fail = (message, status) => { throw new MealDiscoveryError(message, status); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tasteKey = 'shopping.meals.library';
const slots = ['breakfast', 'lunch', 'dinner'];
const units = { g: 2000, kg: 2, ml: 2000, l: 2, tsp: 12, tbsp: 12, cup: 8, item: 12 };
const note = 'Library recipes are saved on the computer running Zelos. Prices are rough USD ingredient estimates for one serving, not store quotes; packages may cost more. Saved local AI ideas retain their original currency.';
const read = (db, key) => db.prepare('SELECT v FROM kv WHERE k=?').get(key)?.v ?? null;
const parse = raw => raw === null ? null : JSON.parse(raw);
const weekKey = weekStart => `shopping.meals.${weekStart}`;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,249}$/.test(value);
const savedId = value => typeof value === 'string' && /^week:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{1,100}$/.test(value);
const localId = (week, recipe) => recipe.origin === 'local-ai' && savedId(recipe.discoveryId) ? recipe.discoveryId : `week:${week.id}:${recipe.id}`;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 1000000) / 1000000;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

function compareAndSave(db, key, previous, value) {
  const next = JSON.stringify(value);
  const result = previous === null
    ? db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING').run(key, next)
    : db.prepare('UPDATE kv SET v=? WHERE k=? AND v=?').run(next, key, previous);
  if (result.changes !== 1) fail('Your meal choices changed on another device. Reload before saving.', 409);
}
function write(db, operation) {
  db.exec('SAVEPOINT meal_discovery_write');
  try { const value = operation(); db.exec('RELEASE meal_discovery_write'); return value; }
  catch (error) {
    db.exec('ROLLBACK TO meal_discovery_write; RELEASE meal_discovery_write');
    if (/SQLITE_BUSY|database is locked|database is busy/i.test(error.message)) fail('Meal preferences changed while saving. Reload and try again.', 409);
    throw error;
  }
}
function taste(db) {
  const raw = read(db, tasteKey), value = parse(raw) || { favorites: [], skipped: [], revision: null };
  if (!Array.isArray(value.favorites) || !Array.isArray(value.skipped) || value.favorites.length + value.skipped.length > 500 || [...value.favorites, ...value.skipped].some(id => !validId(id)) || new Set([...value.favorites, ...value.skipped]).size !== value.favorites.length + value.skipped.length || value.revision !== null && (typeof value.revision !== 'string' || value.revision.length > 100)) fail('Saved meal preferences need to be reviewed.', 409);
  const active = [...value.favorites, ...value.skipped], snapshots = value.snapshots ?? {}, recent = value.recentSnapshots ?? {};
  for (const collection of [snapshots, recent]) if (!collection || typeof collection !== 'object' || Array.isArray(collection)) fail('Saved recipes need to be reviewed.', 409);
  if (Object.keys(snapshots).length > 500 || Object.keys(recent).length > 20 || active.length + Object.keys(recent).length > 500) fail('Saved recipes need to be reviewed.', 409);
  for (const [collection, isActive] of [[snapshots, true], [recent, false]]) for (const [id, recipe] of Object.entries(collection)) {
    if (!savedId(id) || active.includes(id) !== isActive || recipe?.servings !== 1 || !normalizeRecipe(recipe, 1, recipe.priceCurrency, 'local-ai', id, { evidence: [] })) fail('A saved recipe needs to be reviewed.', 409);
  }
  return { raw, value };
}
const publicTaste = value => ({ favorites: value.favorites, skipped: value.skipped, revision: value.revision });
function recipeSnapshot(recipe) {
  // Retain cooking facts only. Saved Health evidence and past model reasons
  // must never travel with a favorite into another week's recommendations.
  const { id, title, slot, description, minutes, cuisine, tags, protein, ingredients, steps, servings, priceCurrency } = recipe;
  return { id, title, slot, description, minutes, cuisine, tags, protein, ingredients, steps, servings, priceCurrency };
}

/** Resolve exclusions with the same named-food rules used by weekly planning.
 * Free-form restrictive text must not quietly bypass an unsupported food rule. */
function foodRules(profile, instructions) {
  const unknownAllergies = !profile.allergies?.trim();
  const p = { ...profile, allergies: unknownAllergies ? 'none' : profile.allergies };
  const rules = mealFoodRules({ ...p, diet: [p.diet || '', instructions || ''].join('; ') }, instructions);
  const combined = [profile.diet || '', instructions || ''].join('\n');
  const fragments = [];
  for (const match of combined.matchAll(/\b(?:no|avoid|without|exclude|dislike|allergic to|intolerant to|(?:don[’']t|do not|can[’']t|cannot|never)\s+(?:eat|have|use|include|cook with))\s+([^.;\n]+)/gi)) fragments.push(match[1]);
  for (const match of combined.matchAll(/\b([a-z]+)[ -]free\b/gi)) {
    const phrase = match[1].trim();
    if (!/^(?:dairy|milk|gluten)$/.test(phrase)) fragments.push(phrase);
  }
  for (const fragment of fragments) {
    const fragmentRules = mealFoodRules({ allergies: 'none', diet: `no ${fragment}` });
    // allergyChecks knows named foods that diet aliases may not otherwise cover.
    try { fragmentRules.push(...mealFoodRules({ allergies: fragment, diet: 'none' })); } catch { /* unresolved remainder is checked below */ }
    let remainder = fragment.toLowerCase();
    for (const rule of fragmentRules) remainder = remainder.replace(new RegExp(rule.pattern.source, 'gi'), ' ');
    remainder = remainder.replace(/\b(?:and|or|any|all|please|foods?|products?)\b/g, '').replace(/[\s,;./()&-]/g, '');
    if (remainder || !fragmentRules.length) fail('Zelos could not fully understand a food exclusion. List specific foods in Food allergies or Food preferences before adding meals.');
    rules.push(...fragmentRules);
  }
  if (/\b(?:low|reduced|limited|less|zero)[ -]?(?:sodium|salt|sugar|carb|fat|potassium|phosphorus|oxalate)|\b(?:fodmap|histamine|paleo|whole30|carnivore|ketogenic|keto|renal|diabetic|elimination|certified|halal|kosher|plant[ -]based)\b/i.test(combined)) fail('This food restriction needs more specific guidance. Enter specific foods to avoid or a vegetarian/vegan preference; the library cannot verify therapeutic targets or certifications.');
  if (/\b(?:free|restricted|restriction|allerg(?:y|ies|ic)|intoleran\w*|sensitivity|sensitive)\b/i.test(combined.replace(/\b(?:dairy|milk|gluten)[ -]free\b/gi, '').replace(/\b[a-z]+[ -]free\b/gi, '').replace(/\b(?:allergic to|intolerant to)\s+[^.;\n]+/gi, ''))) fail('Clarify the foods to avoid in your saved preferences before adding meals.');
  return { rules, unknownAllergies };
}
function state(db, weekStart) {
  planner.mealDates(weekStart);
  const ctx = planner.mealContext(db), raw = read(db, weekKey(weekStart)), week = parse(raw);
  const instructions = week?.instructions || '';
  if (typeof instructions !== 'string' || instructions.length > 1000) fail('The saved weekly food preferences need to be reviewed.', 409);
  let rules = [], blocked = false, warnings = [], unknownAllergies = !ctx.profile.allergies?.trim();
  try { ({ rules, unknownAllergies } = foodRules(ctx.profile, instructions)); }
  catch (error) { if (!(error instanceof HealthPlannerError)) throw error; blocked = true; warnings.push(error.message); }
  if (unknownAllergies) warnings.push('Allergies are not set. These meal ideas are provisional; check every ingredient and product label.');
  return { ctx, raw, week, instructions, rules, blocked, warnings, unknownAllergies, saved: taste(db).value };
}
function normalizeRecipe(recipe, servings, currency, origin, discoveryId, ctx) {
  if (!recipe || typeof recipe !== 'object' || !validId(recipe.id) || !validId(discoveryId) || !Number.isInteger(servings) || servings < 1 || servings > 20 || !/^[A-Z]{3}$/.test(currency) || !slots.includes(recipe.slot) || !text(recipe.title, 150) || !text(recipe.description, 1000) || !Number.isInteger(recipe.minutes) || recipe.minutes < 1 || recipe.minutes > 120) return null;
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length < 2 || recipe.ingredients.length > 20 || !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 15 || recipe.steps.some(step => !text(step, 1000))) return null;
  const ingredients = [];
  for (const item of recipe.ingredients) {
    if (!item || !text(item.name, 100) || !Object.hasOwn(units, item.unit) || !finite(item.quantity) || item.quantity <= 0 || item.quantity > units[item.unit] * servings || ![item.costLow, item.costHigh].every(n => Number.isInteger(n) && n >= 0 && n <= 10000 * servings) || item.costHigh < item.costLow) return null;
    ingredients.push({ name: item.name, quantity: round(item.quantity / servings), unit: item.unit, costLow: Math.floor(item.costLow / servings), costHigh: Math.ceil(item.costHigh / servings) });
  }
  const matches = planner.mealFoodFocus(ctx).filter(focus => focus.pattern.test(ingredients.map(i => i.name).join('\n')));
  return { id: recipe.id, discoveryId, origin, title: recipe.title, slot: recipe.slot, description: recipe.description,
    minutes: recipe.minutes, cuisine: text(recipe.cuisine, 80) ? recipe.cuisine : 'Everyday',
    tags: Array.isArray(recipe.tags) ? recipe.tags.filter(tag => text(tag, 60)).slice(0, 12) : [],
    protein: text(recipe.protein, 80) ? recipe.protein : '', ingredients, steps: [...recipe.steps], servings: 1,
    reason: origin === 'library' && text(recipe.reason, 500) ? recipe.reason : 'A saved local AI idea, checked against your current food exclusions.',
    healthNotes: [...new Set(matches.map(f => f.note))], basisIds: [...new Set(matches.map(f => f.sourceId))],
    costLow: ingredients.reduce((sum, i) => sum + i.costLow, 0), costHigh: ingredients.reduce((sum, i) => sum + i.costHigh, 0), priceCurrency: currency };
}
function candidates(s) {
  const rows = MEAL_CATALOG.map(recipe => ({ recipe, servings: 1, currency: 'USD', origin: 'library', discoveryId: recipe.id }));
  const seen = new Set(rows.map(row => row.discoveryId));
  for (const [discoveryId, recipe] of Object.entries(s.saved.snapshots || {})) {
    rows.push({ recipe, servings: 1, currency: recipe.priceCurrency, origin: 'local-ai', discoveryId });
    seen.add(discoveryId);
  }
  for (const recipe of s.week?.recipes || []) {
    if (recipe.origin === 'library' || recipe.discoveryId?.startsWith('catalog_')) continue;
    const discoveryId = localId(s.week, recipe);
    if (seen.has(discoveryId)) continue;
    rows.push({ recipe, servings: s.week.servings, currency: s.week.currency, origin: 'local-ai', discoveryId });
    seen.add(discoveryId);
  }
  return rows;
}
function eligible(s) {
  const raw = candidates(s);
  if (s.blocked) return { recipes: [], totalCount: raw.length, excludedCount: raw.length };
  const recipes = [];
  for (const row of raw) {
    const recipe = normalizeRecipe(row.recipe, row.servings, row.currency, row.origin, row.discoveryId, s.ctx);
    if (!recipe) continue;
    try { checkFood([recipe.title, recipe.description, ...recipe.steps, ...recipe.ingredients.map(i => i.name)].join('\n'), s.rules); }
    catch (error) { if (!(error instanceof HealthPlannerError)) throw error; continue; }
    recipes.push(recipe);
  }
  return { recipes, totalCount: raw.length, excludedCount: raw.length - recipes.length };
}
function filterRecipes(recipes, filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(k => !['query', 'slot', 'cuisine', 'protein', 'maxMinutes', 'maxCost', 'favoritesOnly'].includes(k))) fail('Choose supported meal filters.', 400);
  for (const key of ['query', 'slot', 'cuisine', 'protein']) if (filters[key] != null && (typeof filters[key] !== 'string' || filters[key].length > 120)) fail('A meal filter is invalid.', 400);
  if (filters.slot && !slots.includes(filters.slot)) fail('Choose breakfast, lunch or dinner.', 400);
  for (const key of ['maxMinutes', 'maxCost']) if (filters[key] != null && (!finite(filters[key]) || filters[key] < 0 || filters[key] > 100000)) fail('Use a valid meal filter limit.', 400);
  if (filters.favoritesOnly != null && typeof filters.favoritesOnly !== 'boolean') fail('Choose a valid favorites filter.', 400);
  return recipes.filter(r => (!filters.query || [r.title, r.description, ...r.ingredients.map(i => i.name)].join(' ').toLowerCase().includes(filters.query.toLowerCase()))
    && (!filters.slot || r.slot === filters.slot) && (!filters.cuisine || r.cuisine.toLowerCase() === filters.cuisine.toLowerCase())
    && (!filters.protein || r.protein.toLowerCase() === filters.protein.toLowerCase()) && (filters.maxMinutes == null || r.minutes <= filters.maxMinutes)
    && (filters.maxCost == null || r.priceCurrency === 'USD' && r.costHigh <= filters.maxCost) && (!filters.favoritesOnly || r.favorite));
}

export function getMealLibrary(db, { weekStart, filters } = {}) {
  const s = state(db, weekStart), available = eligible(s), saved = s.saved;
  const recipes = filterRecipes(available.recipes.map(recipe => ({ ...recipe, favorite: saved.favorites.includes(recipe.discoveryId), skipped: saved.skipped.includes(recipe.discoveryId) })), filters);
  return { ...available, recipes, ...publicTaste(saved), eligibleCount: available.recipes.length, sources: s.ctx.evidence, currency: 'USD',
    weekRevision: s.week?.revision || null, preferences: { diet: s.ctx.profile.diet, allergies: s.ctx.profile.allergies, instructions: s.instructions,
      servings: s.week?.servings || s.ctx.profile.householdSize || 1, currency: s.ctx.profile.currency },
    blocked: s.blocked, warnings: s.warnings, unknownAllergies: s.unknownAllergies, noAllergyConfirmation: s.unknownAllergies,
    stale: !!s.week && s.week.contextFingerprint !== s.ctx.fingerprint, note };
}

function resolveSnapshot(db, recipeId, saved) {
  if (MEAL_CATALOG.some(recipe => recipe.id === recipeId)) return null;
  if (!savedId(recipeId)) fail('Choose a recipe from the meal library.', 404);
  if (saved.snapshots?.[recipeId] || saved.recentSnapshots?.[recipeId]) return saved.snapshots?.[recipeId] || saved.recentSnapshots[recipeId];
  for (const row of db.prepare("SELECT k,v FROM kv WHERE k GLOB 'shopping.meals.[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'").all()) {
    const week = parse(row.v);
    const source = week?.recipes?.find(recipe => recipe.origin !== 'library' && localId(week, recipe) === recipeId);
    if (!source) continue;
    const normalized = normalizeRecipe(source, week.servings, week.currency, 'local-ai', recipeId, { evidence: [] });
    if (!normalized) fail('This saved local AI recipe has incomplete cooking details. Choose another recipe.', 409);
    return recipeSnapshot(normalized);
  }
  fail('That saved local AI recipe is no longer available.', 404);
}
export function saveMealTaste(db, input) {
  if (!input || !validId(input.recipeId) || !['favorite', 'skip', 'clear'].includes(input.action) || !Object.hasOwn(input, 'expectedRevision')) fail('Choose a recipe and a meal preference.', 400);
  return write(db, () => {
    const { raw, value } = taste(db);
    if (input.expectedRevision !== value.revision) fail('Your saved meal preferences changed on another device. Reload before saving.', 409);
    const snapshots = { ...(value.snapshots || {}) }, recentSnapshots = { ...(value.recentSnapshots || {}) };
    if (input.action !== 'clear') {
      const snapshot = resolveSnapshot(db, input.recipeId, value);
      if (snapshot) snapshots[input.recipeId] = snapshot;
      delete recentSnapshots[input.recipeId];
    } else {
      if (![...value.favorites, ...value.skipped].includes(input.recipeId)) resolveSnapshot(db, input.recipeId, value);
      // Undo sends only the recipe ID. Keep a small inactive recovery shelf,
      // never a visible candidate, after the user clears its active snapshot.
      if (snapshots[input.recipeId]) {
        delete recentSnapshots[input.recipeId];
        recentSnapshots[input.recipeId] = snapshots[input.recipeId];
      }
      delete snapshots[input.recipeId];
    }
    const favorites = value.favorites.filter(id => id !== input.recipeId), skipped = value.skipped.filter(id => id !== input.recipeId);
    if (input.action === 'favorite') favorites.push(input.recipeId);
    if (input.action === 'skip') skipped.push(input.recipeId);
    favorites.sort(); skipped.sort();
    if (favorites.length + skipped.length > 500) fail('Keep up to 500 saved meal preferences. Clear some before adding more.', 400);
    const keepRecent = Math.min(20, 500 - favorites.length - skipped.length);
    for (const id of Object.keys(recentSnapshots).slice(0, Math.max(0, Object.keys(recentSnapshots).length - keepRecent))) delete recentSnapshots[id];
    if (JSON.stringify(favorites) === JSON.stringify(value.favorites) && JSON.stringify(skipped) === JSON.stringify(value.skipped) && JSON.stringify(snapshots) === JSON.stringify(value.snapshots || {}) && JSON.stringify(recentSnapshots) === JSON.stringify(value.recentSnapshots || {})) return publicTaste(value);
    const next = { favorites, skipped, revision: randomUUID(), ...(Object.keys(snapshots).length ? { snapshots } : {}), ...(Object.keys(recentSnapshots).length ? { recentSnapshots } : {}) };
    compareAndSave(db, tasteKey, raw, next); return publicTaste(next);
  });
}

function scaled(recipe, servings) {
  if (!Number.isInteger(servings) || servings < 1 || servings > 20) fail('Choose between 1 and 20 servings before adding meals.', 400);
  const ingredients = recipe.ingredients.map(item => ({ ...item, quantity: round(item.quantity * servings),
    costLow: item.costLow * servings, costHigh: item.costHigh * servings }));
  if (ingredients.some(i => i.quantity < .01 || i.quantity > units[i.unit] * servings || !Number.isSafeInteger(i.costLow) || !Number.isSafeInteger(i.costHigh))) fail('This recipe cannot be safely scaled to those servings.');
  return { ...recipe, id: recipe.discoveryId, servings, ingredients, costLow: ingredients.reduce((sum, i) => sum + i.costLow, 0), costHigh: ingredients.reduce((sum, i) => sum + i.costHigh, 0) };
}
function starterWeek(s, recipes, weekStart, db) {
  const servings = s.ctx.profile.householdSize || 1;
  const chosen = slots.flatMap(slot => {
    const choices = recipes.filter(r => r.slot === slot && r.origin === 'library').sort((a, b) => hash([weekStart, a.id]).localeCompare(hash([weekStart, b.id]))).slice(0, 3);
    if (!choices.length) fail('Your current food exclusions leave no recipe for every meal time. Update those preferences or generate a suitable week before adding meals.');
    return choices.map(recipe => scaled(recipe, servings));
  });
  const stores = getGroceryStores(db);
  return { id: randomUUID(), revision: randomUUID(), weekStart, servings, currency: 'USD', maxMinutes: Math.max(...chosen.map(recipe => recipe.minutes)), instructions: '', weeklyBudget: s.ctx.profile.weeklyBudget,
    recipes: chosen, meals: planner.mealDates(weekStart).flatMap((date, day) => slots.map(slot => {
      const choices = chosen.filter(recipe => recipe.slot === slot);
      return { id: `${day}-${slot}`, date, slot, recipeId: choices[day % choices.length].id };
    })), selectedIds: [], createdAt: new Date().toISOString(), contextFingerprint: s.ctx.fingerprint, sources: s.ctx.evidence,
    model: null, origin: 'library', built: null, preferredStores: stores.stores, storePreferencesRevision: stores.revision,
    priceNote: 'Rough USD ingredient costs for the amount used, not checked store quotes. Full packages, tax and delivery may cost more.', guidance: planner.MEAL_SOURCES };
}
export function addMealFromLibrary(db, input) {
  if (!input || typeof input !== 'object' || !validId(input.recipeId) || !/^[0-6]-(?:breakfast|lunch|dinner)$/.test(input.mealId || '') || !Object.hasOwn(input, 'expectedRevision')) fail('Choose a recipe and a day’s matching meal time.', 400);
  return write(db, () => {
    const s = state(db, input.weekStart);
    if (s.blocked) fail(s.warnings[0]);
    if (parse(read(db, `shopping.meals.job.${input.weekStart}`))?.status === 'running') fail('Wait for this week’s planning to finish before adding a recipe.', 409);
    if (s.week && s.week.contextFingerprint !== s.ctx.fingerprint) fail('Your health information changed. Generate current ideas before changing this week.', 409);
    const recipe = eligible(s).recipes.find(row => row.discoveryId === input.recipeId);
    if (!recipe) fail('This recipe is unavailable or excluded by your current food preferences. Choose another meal.', 409);
    if (recipe.slot !== input.mealId.slice(2)) fail('Choose the matching breakfast, lunch or dinner slot.', 400);
    if (recipe.origin === 'library' && (s.ctx.profile.currency !== 'USD' || s.week && s.week.currency !== 'USD')) fail('Library prices are in USD. Choose USD in meal preferences, or use local AI ideas in your saved currency.', 409);
    if (recipe.priceCurrency !== s.ctx.profile.currency || s.week && recipe.priceCurrency !== s.week.currency) fail('This saved recipe uses a different currency. Choose a recipe priced in your current meal currency.', 409);
    if (!s.week && recipe.priceCurrency !== 'USD') fail('Generate a week in this currency before adding the saved recipe.', 409);
    const requestHash = hash({ weekStart: input.weekStart, recipeId: input.recipeId, mealId: input.mealId, expectedRevision: input.expectedRevision });
    if (s.week?.lastDiscoveryAdd?.requestHash === requestHash && s.week.lastDiscoveryAdd.revision === s.week.revision) return { ...planner.getMealWeek(db, input.weekStart), unchanged: true };
    if (input.expectedRevision !== (s.week?.revision ?? null)) fail('Your week changed on another device. Reload before adding a meal.', 409);
    const week = s.week || starterWeek(s, eligible(s).recipes, input.weekStart, db);
    const meal = week.meals.find(m => m.id === input.mealId);
    if (!meal || meal.slot !== recipe.slot) fail('The saved week has no matching meal slot.', 409);
    const original = recipe.origin === 'local-ai' && !s.saved.snapshots?.[recipe.discoveryId]
      ? week.recipes.find(row => localId(week, row) === recipe.discoveryId) : null;
    let recipeId = original?.id;
    if (!original) {
      recipeId = recipe.origin === 'library' ? recipe.discoveryId : `saved_ai_${hash(recipe.discoveryId).slice(0, 32)}`;
      const existing = week.recipes.find(row => row.id === recipeId);
      if (existing && recipe.origin === 'local-ai' && existing.discoveryId !== recipe.discoveryId) fail('This saved recipe conflicts with another alternative. Reload before adding it.', 409);
      if (!existing) {
        if (week.recipes.length >= 150) fail('This week has too many saved alternatives. Generate a new week before adding more.', 409);
        week.recipes.push({ ...scaled(recipe, week.servings), id: recipeId });
      }
    }
    if (meal.recipeId === recipeId && week.selectedIds.includes(meal.id) && s.week) return { ...planner.getMealWeek(db, input.weekStart), unchanged: true };
    meal.recipeId = recipeId; week.selectedIds = [...new Set([...week.selectedIds, meal.id])];
    week.maxMinutes = Math.max(week.maxMinutes || 0, recipe.minutes);
    week.revision = randomUUID(); week.lastDiscoveryAdd = { requestHash, revision: week.revision };
    // Keep the previous build receipt. The explicit Build action reconciles its
    // old grocery items with these new selections; adding never writes groceries.
    compareAndSave(db, weekKey(input.weekStart), s.raw, week);
    return { ...planner.getMealWeek(db, input.weekStart), unchanged: false };
  });
}
