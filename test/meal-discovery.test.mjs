import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MEAL_CATALOG } from '../core/meal-catalog.mjs';
import { getMealLibrary, saveMealTaste, addMealFromLibrary, MealDiscoveryError } from '../core/meal-discovery.mjs';
import { migrateHealth, saveProfile, saveLab, getHealth, saveGroceryItem } from '../core/health.mjs';
import { mealContext, mealDates, buildMealGroceries } from '../core/meal-planner.mjs';
import { mealFoodRules, checkFood } from '../core/health-planner.mjs';
import { samplePlan } from './helpers/meal-fixture.mjs';

const weekStart = '2026-09-14';
const key = start => `shopping.meals.${start}`;
const write = (db, name, value) => db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)').run(name, JSON.stringify(value));
const raw = (db, name) => db.prepare('SELECT v FROM kv WHERE k=?').get(name)?.v ?? null;
function fixture(t, profile = {}) {
 const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE kv(k TEXT PRIMARY KEY,v TEXT)'); migrateHealth(db);
 saveProfile(db, { goals: 'Varied meals', diet: 'none', allergies: 'none', householdSize: 1, currency: 'USD', weeklyBudget: 80, ...profile });
 t.after(() => db.close()); return db;
}
function generatedWeek(db, { servings = 1, instructions = '', currency = 'USD', start = weekStart } = {}) {
 const ctx = mealContext(db), recipes = samplePlan().recipes.map(recipe => ({ ...recipe,
  ingredients: recipe.ingredients.map(i => ({ ...i, quantity: i.quantity * servings, costLow: i.costLow * servings, costHigh: i.costHigh * servings })),
  costLow: 110 * servings, costHigh: 180 * servings, healthNotes: ['OLD NOTE MUST NOT BE REUSED'], basisIds: ['lab:no-longer-present'] }));
 const week = { id: 'synthetic-'+start, revision: 'week-v1', weekStart: start, servings, currency, maxMinutes: 45, instructions,
  recipes, meals: mealDates(start).flatMap((date, day) => ['breakfast', 'lunch', 'dinner'].map((slot, i) => ({ id: `${day}-${slot}`, date, slot, recipeId: `r${i * 3 + day % 3}` }))),
  selectedIds: [], createdAt: '2026-09-12T12:00:00Z', contextFingerprint: ctx.fingerprint, sources: ctx.evidence, model: 'synthetic-local', built: null };
 write(db, key(start), week); return week;
}
const library = db => getMealLibrary(db, { weekStart });
const pick = (db, slot = 'breakfast') => library(db).recipes.find(r => r.origin === 'library' && r.slot === slot);
const add = (db, recipe, mealId = '0-breakfast', expectedRevision = null) => addMealFromLibrary(db, { weekStart, recipeId: recipe.discoveryId, mealId, expectedRevision });

test('discovery offers the complete local catalog with explicit one-serving USD prices and performs no writes or network calls', t => {
 const db = fixture(t); t.mock.method(globalThis, 'fetch', () => { throw new Error('No network in local discovery'); });
 const before = JSON.stringify(db.prepare('SELECT * FROM kv ORDER BY k').all()), result = library(db);
 assert.equal(MEAL_CATALOG.length, 90); assert.equal(result.totalCount, 90); assert.equal(result.recipes.length, 90); assert.equal(result.excludedCount, 0);
 assert.equal(result.revision, null); assert.equal(result.weekRevision, null); assert.equal(result.currency, 'USD');
 assert.ok(result.recipes.every(r => r.servings === 1 && r.priceCurrency === 'USD' && r.origin === 'library' && r.discoveryId === r.id));
 assert.ok(result.recipes.every(r => r.costLow === r.ingredients.reduce((n, i) => n + i.costLow, 0) && r.costHigh >= r.costLow));
 assert.match(result.note, /not store quotes/); assert.equal(JSON.stringify(db.prepare('SELECT * FROM kv ORDER BY k').all()), before);
});

test('blank allergies remain explicitly unknown while unresolved or uncertain allergy text blocks discovery and add', t => {
 const db = fixture(t, { allergies: '' }); const initial = library(db), recipe = initial.recipes[0];
 assert.equal(initial.recipes.length, 90); assert.equal(initial.blocked, false); assert.equal(initial.unknownAllergies, true); assert.equal(initial.noAllergyConfirmation, true);
 assert.match(initial.warnings.join(' '), /Allergies are not set/); assert.equal(getHealth(db).profile.allergies, '');
 assert.doesNotThrow(() => add(db, recipe, `0-${recipe.slot}`));
 for (const allergies of ['nuts', 'maybe peanuts', 'dragonfruit']) {
  saveProfile(db, { allergies }); const blocked = library(db);
  assert.equal(blocked.blocked, true); assert.deepEqual(blocked.recipes, []); assert.ok(blocked.warnings.length);
  assert.throws(() => add(db, recipe, `1-${recipe.slot}`, JSON.parse(raw(db, key(weekStart))).revision), MealDiscoveryError);
 }
});

test('actual allergies, saved diet and weekly exclusions are enforced before visibility and again on add', t => {
 const db = fixture(t), initial = library(db);
 const peanut = initial.recipes.find(r => r.ingredients.some(i => /peanut/i.test(i.name))); assert.ok(peanut);
 saveProfile(db, { allergies: 'peanuts', diet: 'vegan' });
 const week = generatedWeek(db, { instructions: 'no mushrooms' }), available = library(db), rules = mealFoodRules(getHealth(db).profile);
 assert.ok(available.recipes.length > 0 && available.recipes.length < available.totalCount);
 for (const recipe of available.recipes) {
  const words = [recipe.title, recipe.description, ...recipe.steps, ...recipe.ingredients.map(i => i.name)].join('\n');
  assert.doesNotThrow(() => checkFood(words, rules)); assert.doesNotMatch(words, /mushroom/i);
 }
 assert.throws(() => add(db, peanut, `0-${peanut.slot}`, week.revision), /excluded/);
 week.instructions = 'vegan this week'; write(db, key(weekStart), week);
 assert.ok(library(db).recipes.every(r => { try { checkFood(r.ingredients.map(i => i.name).join(' '), rules); return true; } catch { return false; } }));
});

test('unsupported restrictive notes fail closed but ordinary cooking notes keep discovery usable', t => {
 const db = fixture(t);
 for (const diet of ['no quince', 'no chicken or quince', 'low sodium', 'nut-free', 'plant-based']) {
  saveProfile(db, { diet }); assert.equal(library(db).blocked, true, diet); assert.deepEqual(library(db).recipes, [], diet);
 }
 saveProfile(db, { diet: 'none' });
 const week = generatedWeek(db, { instructions: 'quick lunches, fewer dishes' });
 assert.equal(library(db).blocked, false); assert.ok(library(db).recipes.length >= 90);
 week.instructions = 'avoid quince'; write(db, key(weekStart), week); assert.equal(library(db).blocked, true);
 saveProfile(db, { diet: 'gluten free and dairy free' }); week.instructions = ''; write(db, key(weekStart), week);
 assert.equal(library(db).blocked, false); assert.ok(library(db).recipes.length > 0);
});

test('new filters only narrow already eligible meals and unknown filters cannot broaden restrictions', t => {
 const db = fixture(t, { allergies: 'peanuts', diet: 'vegetarian' });
 const available = library(db), result = getMealLibrary(db, { weekStart, filters: { slot: 'dinner', maxMinutes: 30, maxCost: 1000 } });
 assert.ok(result.recipes.length > 0 && result.recipes.length < available.recipes.length);
 assert.ok(result.recipes.every(r => available.recipes.some(e => e.discoveryId === r.discoveryId) && r.minutes <= 30 && r.costHigh <= 1000));
 assert.throws(() => getMealLibrary(db, { weekStart, filters: { includeAllergens: true } }), /supported meal filters/);
 assert.throws(() => getMealLibrary(db, { weekStart, filters: { maxMinutes: -1 } }), /filter limit/);
});

test('health notes and source IDs are derived afresh, never copied from historical model annotations', t => {
 const db = fixture(t), today = new Date().toISOString().slice(0, 10);
 saveLab(db, { id: 'lipid', date: today, name: 'Total cholesterol', value: '208', unit: 'mg/dL', referenceHigh: 200 });
 const week = generatedWeek(db), first = library(db);
 assert.ok(first.recipes.some(r => r.basisIds.includes('lab:lipid')));
 assert.ok(first.recipes.every(r => !r.basisIds.includes('lab:no-longer-present') && !r.healthNotes.includes('OLD NOTE MUST NOT BE REUSED')));
 saveLab(db, { id: 'lipid', date: today, name: 'Total cholesterol', value: '180', unit: 'mg/dL', referenceHigh: 200 });
 const next = library(db); assert.ok(next.recipes.every(r => !r.basisIds.includes('lab:lipid'))); assert.equal(next.stale, true);
 assert.equal(next.sources.find(s => s.id === 'lab:lipid').value, '180');
 assert.throws(() => add(db, next.recipes[0], `0-${next.recipes[0].slot}`, week.revision), /health information changed/);
});

test('saved local AI ideas keep their identity, normalize servings, preserve currency and ignore invalid saved prices', t => {
 const db = fixture(t, { householdSize: 2, currency: 'CAD' }), week = generatedWeek(db, { servings: 2, currency: 'CAD' });
 let result = library(db), ai = result.recipes.find(r => r.origin === 'local-ai');
 assert.equal(result.recipes.length, 99); assert.equal(ai.discoveryId, `week:${week.id}:r0`); assert.equal(ai.servings, 1); assert.equal(ai.ingredients[0].quantity, 50); assert.equal(ai.costLow, 110); assert.equal(ai.costHigh, 180); assert.equal(ai.priceCurrency, 'CAD');
 assert.ok(result.recipes.filter(r => r.origin === 'library').every(r => r.priceCurrency === 'USD'));
 assert.throws(() => add(db, pick(db), '0-breakfast', week.revision), /Library prices are in USD/);
 assert.doesNotThrow(() => add(db, ai, '0-breakfast', week.revision));
 week.recipes[0].ingredients[0].costLow = -1; write(db, key(weekStart), week);
 result = library(db); assert.equal(result.recipes.some(r => r.discoveryId === ai.discoveryId), false); assert.equal(result.excludedCount, 1);
});

test('favorite, skip and clear persist independently with conflict protection and a bounded state', t => {
 const db = fixture(t), recipe = pick(db), before = JSON.stringify(getHealth(db));
 let saved = saveMealTaste(db, { recipeId: recipe.discoveryId, action: 'favorite', expectedRevision: null });
 assert.deepEqual(saved.favorites, [recipe.discoveryId]); assert.deepEqual(saved.skipped, []);
 assert.equal(library(db).recipes.find(r => r.discoveryId === recipe.discoveryId).favorite, true);
 assert.throws(() => saveMealTaste(db, { recipeId: recipe.discoveryId, action: 'skip', expectedRevision: null }), /another device/);
 saved = saveMealTaste(db, { recipeId: recipe.discoveryId, action: 'skip', expectedRevision: saved.revision });
 assert.deepEqual(saved.favorites, []); assert.deepEqual(saved.skipped, [recipe.discoveryId]);
 saved = saveMealTaste(db, { recipeId: recipe.discoveryId, action: 'clear', expectedRevision: saved.revision }); assert.deepEqual(saved.favorites, []); assert.deepEqual(saved.skipped, []);
 const revision = saved.revision; assert.equal(saveMealTaste(db, { recipeId: recipe.discoveryId, action: 'clear', expectedRevision: revision }).revision, revision);
 assert.throws(() => saveMealTaste(db, { recipeId: 'catalog_invented', action: 'favorite', expectedRevision: revision }), /library/);
 assert.equal(JSON.stringify(getHealth(db)), before); assert.equal(raw(db, key(weekStart)), null);
 write(db, 'shopping.meals.library', { favorites: Array.from({ length: 500 }, (_, i) => `week:old-${i}:recipe`), skipped: [], revision: 'full' });
 assert.throws(() => saveMealTaste(db, { recipeId: recipe.discoveryId, action: 'favorite', expectedRevision: 'full' }), /500/);
});

test('local AI favorites validate the actual week membership and vanished entries can still be cleared', t => {
 const db = fixture(t); generatedWeek(db); const ai = library(db).recipes.find(r => r.origin === 'local-ai');
 const saved = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: null });
 assert.throws(() => saveMealTaste(db, { recipeId: 'week:unknown:r0', action: 'favorite', expectedRevision: saved.revision }), /no longer available/);
 db.prepare('DELETE FROM kv WHERE k=?').run(key(weekStart));
 assert.deepEqual(saveMealTaste(db, { recipeId: ai.discoveryId, action: 'clear', expectedRevision: saved.revision }).favorites, []);
});

test('adding without generation creates deterministic slots, scales recipes and selects only the requested meal', t => {
 const db = fixture(t, { householdSize: 2 }); saveGroceryItem(db, { name: 'Manual oats', quantity: '2 cup' });
 write(db, 'unrelated.setting', { keep: true }); const before = JSON.stringify(getHealth(db)), recipe = pick(db, 'lunch');
 const input = { weekStart, recipeId: recipe.discoveryId, mealId: '3-lunch', expectedRevision: null }, added = addMealFromLibrary(db, input);
 assert.equal(added.week.meals.length, 21); assert.equal(new Set(added.week.meals.map(m => m.id)).size, 21); assert.deepEqual(added.week.selectedIds, ['3-lunch']);
 assert.equal(added.week.model, null); assert.equal(added.week.origin, 'library'); assert.equal(added.week.servings, 2);
 const chosen = added.week.recipes.find(r => r.id === recipe.discoveryId);
 assert.equal(chosen.ingredients[0].quantity, Math.round(recipe.ingredients[0].quantity * 2000000) / 1000000); assert.equal(chosen.costLow, recipe.costLow * 2); assert.equal(chosen.costHigh, recipe.costHigh * 2);
 assert.deepEqual(added.profile, getHealth(db).profile); assert.ok(added.health && added.storePreferences);
 assert.equal(added.week.meals.find(m => m.id === '3-lunch').recipeId, recipe.discoveryId); assert.equal(JSON.stringify(getHealth(db)), before); assert.deepEqual(JSON.parse(raw(db, 'unrelated.setting')), { keep: true });
 const persisted = raw(db, key(weekStart)); assert.equal(addMealFromLibrary(db, input).unchanged, true); assert.equal(raw(db, key(weekStart)), persisted);
 assert.equal(library(db).recipes.length, 90, 'catalog choices in the week do not duplicate library cards');
});

test('add preserves the build receipt and existing groceries until an explicit build, then produces the new list', t => {
 const db = fixture(t), week = generatedWeek(db), built = buildMealGroceries(db, { weekStart, weekId: week.id, expectedRevision: week.revision, selectedIds: ['0-breakfast'] });
 const groceries = JSON.stringify(getHealth(db)), receipt = raw(db, `shopping.meals.built.${weekStart}`), recipe = pick(db);
 const added = add(db, recipe, '0-breakfast', built.week.revision);
 assert.deepEqual(added.week.built, built.week.built); assert.equal(raw(db, `shopping.meals.built.${weekStart}`), receipt); assert.equal(JSON.stringify(getHealth(db)), groceries);
 const result = buildMealGroceries(db, { weekStart, weekId: added.week.id, expectedRevision: added.week.revision, selectedIds: added.week.selectedIds });
 assert.equal(result.unchanged, false); assert.equal(getHealth(db).plans[0].entries[0].title, recipe.title);
});

test('cross-device adds, active generation, health changes, mismatched slots and unsupported currencies never write a stale week', t => {
 const db = fixture(t), recipe = pick(db), added = add(db, recipe), saved = raw(db, key(weekStart));
 assert.throws(() => add(db, pick(db, 'lunch'), '0-lunch', null), /another device/);
 assert.throws(() => add(db, recipe, '0-dinner', added.week.revision), /matching/);
 assert.throws(() => add(db, { discoveryId: 'catalog_invented' }, '0-breakfast', added.week.revision), /unavailable/);
 write(db, `shopping.meals.job.${weekStart}`, { status: 'running' }); assert.throws(() => add(db, recipe, '1-breakfast', added.week.revision), /planning to finish/);
 db.prepare('DELETE FROM kv WHERE k=?').run(`shopping.meals.job.${weekStart}`); assert.equal(raw(db, key(weekStart)), saved);
 saveProfile(db, { allergies: 'peanuts' }); assert.throws(() => add(db, recipe, '1-breakfast', added.week.revision), /health information changed/); assert.equal(raw(db, key(weekStart)), saved);
 const other = fixture(t, { currency: 'EUR' }); assert.throws(() => add(other, pick(other)), /Library prices are in USD/); assert.equal(raw(other, key(weekStart)), null);
});

test('explicitly selected longer recipes raise the week time label while bad servings fail before writing', t => {
 const db = fixture(t), week = generatedWeek(db);
 const recipe = library(db).recipes.find(r => r.origin === 'library' && r.minutes > week.maxMinutes); assert.ok(recipe);
 const added = add(db, recipe, `0-${recipe.slot}`, week.revision); assert.equal(added.week.maxMinutes, recipe.minutes);
 const other = fixture(t, { householdSize: 21 }); assert.throws(() => add(other, pick(other)), /1 and 20/); assert.equal(raw(other, key(weekStart)), null);
});

test('explicit AI favorites retain one-serving cooking snapshots across weeks and regeneration without exposing private snapshots', t => {
 const db = fixture(t, { householdSize: 2 }), week = generatedWeek(db, { servings: 2 });
 const ai = library(db).recipes.find(recipe => recipe.origin === 'local-ai');
 const beforeHealth = JSON.stringify(getHealth(db));
 const saved = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: null });
 assert.deepEqual(Object.keys(saved).sort(), ['favorites', 'revision', 'skipped']);
 const persisted = JSON.parse(raw(db, 'shopping.meals.library')), snapshot = persisted.snapshots[ai.discoveryId];
 assert.equal(Object.keys(persisted.snapshots).length, 1); assert.equal(snapshot.servings, 1);
 assert.deepEqual(snapshot.ingredients, ai.ingredients); assert.equal(snapshot.priceCurrency, 'USD');
 for (const field of ['basisIds', 'healthNotes', 'reason', 'sources', 'favorite', 'skipped']) assert.equal(Object.hasOwn(snapshot, field), false, field);
 // Even a reused source id cannot silently change a recipe the user saved.
 week.recipes[0].title = 'Replacement breakfast'; week.revision = 'regenerated'; write(db, key(weekStart), week);
 assert.equal(library(db).recipes.find(recipe => recipe.discoveryId === ai.discoveryId).title, ai.title);
 const next = getMealLibrary(db, { weekStart: '2026-09-21', filters: { favoritesOnly: true } });
 assert.equal(next.totalCount, 91); assert.deepEqual(next.recipes.map(recipe => recipe.discoveryId), [ai.discoveryId]);
 assert.equal(next.recipes[0].title, ai.title); assert.equal(Object.hasOwn(next, 'snapshots'), false);
 db.prepare('DELETE FROM kv WHERE k=?').run(key(weekStart));
 assert.equal(getMealLibrary(db, { weekStart: '2026-09-21' }).recipes.find(recipe => recipe.discoveryId === ai.discoveryId).title, ai.title);
 assert.equal(JSON.stringify(getHealth(db)), beforeHealth);
});

test('saved AI recipes are rechecked against new allergies and derive Health notes only from current evidence', t => {
 const db = fixture(t), today = new Date().toISOString().slice(0, 10);
 saveLab(db, { id: 'lipid', date: today, name: 'Total cholesterol', value: '208', unit: 'mg/dL', referenceHigh: 200 });
 const week = generatedWeek(db); week.recipes[0].ingredients[1].name = 'peanuts'; write(db, key(weekStart), week);
 const ai = library(db).recipes.find(recipe => recipe.origin === 'local-ai');
 assert.ok(ai.basisIds.includes('lab:lipid'));
 const saved = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: null });
 db.prepare('DELETE FROM kv WHERE k=?').run(key(weekStart));
 saveLab(db, { id: 'lipid', date: today, name: 'Total cholesterol', value: '180', unit: 'mg/dL', referenceHigh: 200 });
 const refreshed = library(db).recipes.find(recipe => recipe.discoveryId === ai.discoveryId);
 assert.deepEqual(refreshed.basisIds, []); assert.deepEqual(refreshed.healthNotes, []);
 assert.doesNotMatch(JSON.stringify(refreshed), /OLD NOTE|no-longer-present|208/);
 saveProfile(db, { allergies: 'peanuts' });
 const excluded = library(db); assert.equal(excluded.blocked, false);
 assert.ok(excluded.favorites.includes(ai.discoveryId)); assert.equal(excluded.recipes.some(recipe => recipe.discoveryId === ai.discoveryId), false);
 const before = raw(db, 'shopping.meals.library');
 assert.throws(() => add(db, ai), /unavailable or excluded/); assert.equal(raw(db, key(weekStart)), null);
 assert.equal(raw(db, 'shopping.meals.library'), before);
 saveProfile(db, { allergies: 'none' }); assert.ok(library(db).recipes.some(recipe => recipe.discoveryId === ai.discoveryId));
 assert.equal(library(db).revision, saved.revision);
});

test('adding a saved AI recipe copies and scales a unique target alternative while preserving groceries, source and other slots', t => {
 const db = fixture(t, { householdSize: 2 }), source = generatedWeek(db, { servings: 2 });
 const ai = library(db).recipes.find(recipe => recipe.origin === 'local-ai');
 saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: null });
 saveProfile(db, { householdSize: 3 });
 const targetDate = '2026-09-21', target = generatedWeek(db, { servings: 3, start: targetDate });
 const built = buildMealGroceries(db, { weekStart: targetDate, weekId: target.id, expectedRevision: target.revision, selectedIds: ['0-dinner'] });
 const beforeHealth = JSON.stringify(getHealth(db)), beforeSource = raw(db, key(source.weekStart));
 const beforeReceipt = raw(db, `shopping.meals.built.${targetDate}`), beforeTaste = raw(db, 'shopping.meals.library');
 const input = { weekStart: targetDate, recipeId: ai.discoveryId, mealId: '0-breakfast', expectedRevision: built.week.revision };
 const result = addMealFromLibrary(db, input), selected = result.week.meals.find(meal => meal.id === '0-breakfast');
 const copy = result.week.recipes.find(recipe => recipe.id === selected.recipeId);
 assert.match(copy.id, /^saved_ai_[a-f0-9]{32}$/); assert.notEqual(copy.id, 'r0');
 assert.equal(copy.discoveryId, ai.discoveryId); assert.equal(copy.origin, 'local-ai');
 assert.equal(copy.title, ai.title); assert.equal(copy.ingredients[0].quantity, ai.ingredients[0].quantity * 3);
 assert.equal(copy.costLow, ai.costLow * 3); assert.deepEqual(copy.healthNotes, []);
 assert.equal(result.week.recipes.find(recipe => recipe.id === 'r0').id, 'r0');
 assert.deepEqual(result.week.meals.filter(meal => meal.id !== '0-breakfast'), built.week.meals.filter(meal => meal.id !== '0-breakfast'));
 assert.deepEqual(new Set(result.week.selectedIds), new Set(['0-dinner', '0-breakfast']));
 assert.deepEqual(result.week.built, built.week.built); assert.equal(raw(db, `shopping.meals.built.${targetDate}`), beforeReceipt);
 assert.equal(JSON.stringify(getHealth(db)), beforeHealth); assert.equal(raw(db, key(source.weekStart)), beforeSource);
 assert.equal(raw(db, 'shopping.meals.library'), beforeTaste);
 const persisted = raw(db, key(targetDate)); assert.equal(addMealFromLibrary(db, input).unchanged, true); assert.equal(raw(db, key(targetDate)), persisted);
 const second = addMealFromLibrary(db, { ...input, mealId: '1-breakfast', expectedRevision: result.week.revision });
 assert.equal(second.week.recipes.filter(recipe => recipe.discoveryId === ai.discoveryId).length, 1);
 const listing = getMealLibrary(db, { weekStart: targetDate });
 assert.equal(listing.recipes.filter(recipe => recipe.discoveryId === ai.discoveryId).length, 1);
 assert.equal(listing.totalCount, 100, '90 catalog + 9 target AI + one saved source, without a duplicate copied card');
});

test('saved AI can seed a new USD week after its source is deleted, but mismatched currencies never write', t => {
 const db = fixture(t), source = generatedWeek(db), ai = library(db).recipes.find(recipe => recipe.origin === 'local-ai');
 saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: null });
 db.prepare('DELETE FROM kv WHERE k=?').run(key(source.weekStart));
 const chosen = add(db, ai); assert.equal(chosen.week.meals.length, 21); assert.deepEqual(chosen.week.selectedIds, ['0-breakfast']);
 assert.equal(chosen.week.recipes.find(recipe => recipe.id === chosen.week.meals[0].recipeId).title, ai.title);
 saveProfile(db, { currency: 'CAD' });
 const target = generatedWeek(db, { start: '2026-09-21', currency: 'CAD' });
 const before = raw(db, key(target.weekStart));
 assert.throws(() => addMealFromLibrary(db, { weekStart: target.weekStart, recipeId: ai.discoveryId, mealId: '0-breakfast', expectedRevision: target.revision }), /different currency/);
 assert.equal(raw(db, key(target.weekStart)), before);
 assert.throws(() => addMealFromLibrary(db, { weekStart: '2026-09-28', recipeId: ai.discoveryId, mealId: '0-breakfast', expectedRevision: null }), /different currency/);
 assert.equal(raw(db, key('2026-09-28')), null);
});

test('skipped AI snapshots survive source deletion and clear removes only the explicit taste entry with revision protection', t => {
 const db = fixture(t); generatedWeek(db); const ai = library(db).recipes.find(recipe => recipe.origin === 'local-ai');
 const saved = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'skip', expectedRevision: null });
 db.prepare('DELETE FROM kv WHERE k=?').run(key(weekStart));
 assert.ok(getMealLibrary(db, { weekStart: '2026-09-21' }).recipes.find(recipe => recipe.discoveryId === ai.discoveryId).skipped);
 const before = raw(db, 'shopping.meals.library');
 assert.throws(() => saveMealTaste(db, { recipeId: ai.discoveryId, action: 'clear', expectedRevision: null }), /another device/);
 assert.equal(raw(db, 'shopping.meals.library'), before);
 const favorite = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: saved.revision });
 assert.deepEqual(Object.keys(favorite).sort(), ['favorites', 'revision', 'skipped']);
 const cleared = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'clear', expectedRevision: favorite.revision });
 assert.deepEqual(cleared.favorites, []); assert.deepEqual(cleared.skipped, []);
 assert.equal(Object.hasOwn(JSON.parse(raw(db, 'shopping.meals.library')), 'snapshots'), false);
 assert.equal(library(db).recipes.some(recipe => recipe.discoveryId === ai.discoveryId), false);
 assert.equal(Object.hasOwn(library(db), 'recentSnapshots'), false);
 const undone = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: cleared.revision });
 assert.deepEqual(undone.favorites, [ai.discoveryId]);
 assert.equal(library(db).recipes.find(recipe => recipe.discoveryId === ai.discoveryId).title, ai.title);
 assert.equal(Object.hasOwn(JSON.parse(raw(db, 'shopping.meals.library')), 'recentSnapshots'), false);
});

test('cleared AI snapshots remain invisible and bounded while the most recent clear can be undone', t => {
 const db = fixture(t); let revision = null, last;
 for (let i = 0; i < 22; i++) {
  const week = generatedWeek(db); week.id = `synthetic-generation-${i}`; write(db, key(weekStart), week);
  const ai = library(db).recipes.find(recipe => recipe.origin === 'local-ai');
  const saved = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: revision });
  const cleared = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'clear', expectedRevision: saved.revision });
  revision = cleared.revision; last = ai;
 }
 db.prepare('DELETE FROM kv WHERE k=?').run(key(weekStart));
 const persisted = JSON.parse(raw(db, 'shopping.meals.library'));
 assert.equal(Object.keys(persisted.recentSnapshots).length, 20);
 assert.equal(persisted.recentSnapshots['week:synthetic-generation-0:r0'], undefined);
 assert.equal(library(db).totalCount, 90); assert.equal(library(db).recipes.some(recipe => recipe.origin === 'local-ai'), false);
 const restored = saveMealTaste(db, { recipeId: last.discoveryId, action: 'favorite', expectedRevision: revision });
 assert.deepEqual(restored.favorites, [last.discoveryId]); assert.equal(library(db).totalCount, 91);
 const crowded = JSON.parse(raw(db, 'shopping.meals.library'));
 crowded.favorites = [...crowded.favorites, ...Array.from({ length: 480 }, (_, i) => `week:legacy-${i}:r0`)];
 write(db, 'shopping.meals.library', crowded);
 const catalog = pick(db);
 saveMealTaste(db, { recipeId: catalog.discoveryId, action: 'favorite', expectedRevision: restored.revision });
 const bounded = JSON.parse(raw(db, 'shopping.meals.library'));
 assert.equal(bounded.favorites.length + bounded.skipped.length + Object.keys(bounded.recentSnapshots).length, 500);
 assert.equal(Object.keys(bounded.recentSnapshots).length, 18);
});

test('legacy AI taste IDs gain snapshots only on an explicit save and malformed or oversized snapshots fail without writes', t => {
 const db = fixture(t), week = generatedWeek(db), ai = library(db).recipes.find(recipe => recipe.origin === 'local-ai');
 write(db, 'shopping.meals.library', { favorites: [ai.discoveryId], skipped: [], revision: 'legacy' });
 const before = raw(db, 'shopping.meals.library'); library(db); assert.equal(raw(db, 'shopping.meals.library'), before);
 const saved = saveMealTaste(db, { recipeId: ai.discoveryId, action: 'favorite', expectedRevision: 'legacy' });
 assert.notEqual(saved.revision, 'legacy');
 const valid = JSON.parse(raw(db, 'shopping.meals.library'));
 assert.equal(valid.snapshots[ai.discoveryId].servings, 1);
 for (const corrupt of [
  { ...valid, snapshots: { ...valid.snapshots, 'week:unselected:r0': valid.snapshots[ai.discoveryId] } },
  { ...valid, snapshots: { [ai.discoveryId]: { ...valid.snapshots[ai.discoveryId], servings: 2 } } },
  { ...valid, favorites: Array.from({ length: 501 }, (_, i) => `week:old-${i}:r0`), snapshots: {} },
 ]) {
  write(db, 'shopping.meals.library', corrupt); const bad = raw(db, 'shopping.meals.library');
  assert.throws(() => library(db), /reviewed/);
  assert.equal(raw(db, 'shopping.meals.library'), bad); assert.equal(raw(db, key(weekStart)), JSON.stringify(week));
 }
});
