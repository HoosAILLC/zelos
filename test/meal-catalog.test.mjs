import test from 'node:test';
import assert from 'node:assert/strict';
import { MEAL_CATALOG } from '../core/meal-catalog.mjs';

const slots = ['breakfast', 'lunch', 'dinner'];
const allowedTags = new Set(['vegetarian', 'vegan', 'dairy-free', 'gluten-free']);
const allowedProteins = new Set(['plant', 'eggs', 'dairy', 'chicken', 'fish', 'beef', 'pork', 'turkey']);
const allowedUnits = new Set(['g', 'ml', 'tsp', 'tbsp', 'cup', 'item']);
const names = recipe => recipe.ingredients.map(i => i.name.toLowerCase());
const animalMeat = /\b(chicken|turkey|beef|pork|salmon|cod|trout|tuna|sardines?|anchov(?:y|ies)|shrimp|prawns?|gelatin|lard)\b/;
const dairy = /\b(milk|yogurt|yoghurt|kefir|cheese|feta|cheddar|ricotta|mozzarella|butter|cream|whey|casein)\b/;
const plantDairy = /\b(soy milk|soy yogurt|almond milk|coconut milk|peanut butter)\b/;

test('catalog supplies 90 stable, uniquely named meals evenly across three slots', () => {
  assert.equal(MEAL_CATALOG.length, 90);
  assert.equal(new Set(MEAL_CATALOG.map(r => r.id)).size, 90);
  assert.equal(new Set(MEAL_CATALOG.map(r => r.title.toLowerCase())).size, 90);
  for (const slot of slots) assert.equal(MEAL_CATALOG.filter(r => r.slot === slot).length, 30);
  for (const recipe of MEAL_CATALOG) {
    assert.match(recipe.id, /^catalog_[a-z0-9_]{1,52}$/, recipe.id);
    assert.ok(recipe.id.length <= 60);
    assert.ok(recipe.title.length >= 10 && recipe.title.length <= 100);
    assert.ok(recipe.description.length >= 25 && recipe.description.length <= 250);
    assert.ok(recipe.reason.length >= 25 && recipe.reason.length <= 250);
    assert.ok(recipe.cuisine.length >= 5);
    assert.ok(allowedProteins.has(recipe.protein), recipe.id);
  }
});

test('every recipe contains practical one-serving quantities and explicit cost ranges', () => {
  for (const recipe of MEAL_CATALOG) {
    assert.ok(Number.isInteger(recipe.minutes) && recipe.minutes >= 10 && recipe.minutes <= 90, recipe.id);
    assert.ok(recipe.ingredients.length >= 4 && recipe.ingredients.length <= 12, recipe.id);
    assert.equal(new Set(names(recipe)).size, recipe.ingredients.length, `${recipe.id}: duplicate ingredient`);
    let totalLow = 0;
    let totalHigh = 0;
    for (const ingredient of recipe.ingredients) {
      assert.equal(typeof ingredient.name, 'string');
      assert.ok(ingredient.name.length >= 3 && ingredient.name.length <= 100, recipe.id);
      assert.ok(allowedUnits.has(ingredient.unit), `${recipe.id}: ${ingredient.unit}`);
      assert.ok(Number.isFinite(ingredient.quantity) && ingredient.quantity > 0, recipe.id);
      const maximum = {g:400,ml:600,tsp:4,tbsp:4,cup:3,item:3}[ingredient.unit];
      assert.ok(ingredient.quantity <= maximum, `${recipe.id}: implausible serving of ${ingredient.name}`);
      assert.ok(Number.isInteger(ingredient.costLow) && ingredient.costLow >= 0, recipe.id);
      assert.ok(Number.isInteger(ingredient.costHigh) && ingredient.costHigh >= ingredient.costLow, recipe.id);
      assert.ok(ingredient.costHigh < 600, `${recipe.id}: unrealistic ingredient estimate`);
      totalLow += ingredient.costLow;
      totalHigh += ingredient.costHigh;
    }
    assert.ok(totalLow >= 75 && totalLow <= 1300, `${recipe.id}: low meal estimate ${totalLow}`);
    assert.ok(totalHigh > totalLow && totalHigh <= 2000, `${recipe.id}: high meal estimate ${totalHigh}`);
  }
});

test('meals vary in ingredients, preparation, cuisines and protein sources', () => {
  const signatures = MEAL_CATALOG.map(r => names(r).sort().join('|'));
  assert.equal(new Set(signatures).size, 90, 'renaming identical ingredient sets is not catalog variety');
  assert.equal(new Set(MEAL_CATALOG.map(r => r.steps.join(' '))).size, 90);
  assert.ok(new Set(MEAL_CATALOG.map(r => r.cuisine)).size >= 12);
  assert.equal(new Set(MEAL_CATALOG.map(r => r.protein)).size, allowedProteins.size);
  for (const slot of slots) {
    const meals = MEAL_CATALOG.filter(r => r.slot === slot);
    assert.ok(new Set(meals.map(r => r.cuisine)).size >= 8, slot);
    assert.ok(meals.filter(r => r.tags.includes('vegan')).length >= 7, slot);
    assert.ok(meals.filter(r => r.tags.includes('gluten-free')).length >= 10, slot);
  }
  assert.ok(MEAL_CATALOG.some(r => r.minutes > 45), 'longer meals must remain a real choice');
  assert.ok(MEAL_CATALOG.filter(r => r.minutes <= 20).length >= 10, 'quick options');
  const allSteps = MEAL_CATALOG.flatMap(r => r.steps).join(' ').toLowerCase();
  for (const method of ['bake', 'roast', 'simmer', 'blend', 'toast', 'stir-fry', 'mash']) assert.ok(allSteps.includes(method), method);
});

test('vegetarian, vegan and dairy-free labels do not contradict listed ingredients', () => {
  for (const recipe of MEAL_CATALOG) {
    assert.equal(new Set(recipe.tags).size, recipe.tags.length);
    for (const tag of recipe.tags) assert.ok(allowedTags.has(tag), recipe.id);
    const ingredients = names(recipe);
    if (recipe.tags.includes('vegan')) {
      assert.ok(recipe.tags.includes('vegetarian'), `${recipe.id}: vegan also vegetarian`);
      assert.ok(recipe.tags.includes('dairy-free'), `${recipe.id}: vegan also dairy-free`);
      assert.equal(recipe.protein, 'plant', recipe.id);
      for (const name of ingredients) {
        assert.ok(!animalMeat.test(name), `${recipe.id}: meat in vegan recipe`);
        assert.ok(!/\b(eggs?|honey)\b/.test(name), `${recipe.id}: animal ingredient`);
      }
    }
    if (recipe.tags.includes('vegetarian')) {
      for (const name of ingredients) assert.ok(!animalMeat.test(name), `${recipe.id}: meat in vegetarian recipe`);
    }
    if (recipe.tags.includes('dairy-free')) {
      for (const name of ingredients) assert.ok(!dairy.test(name) || plantDairy.test(name), `${recipe.id}: ${name} is not explicitly dairy-free`);
    }
  }
});

test('gluten-free labels exclude wheat grains and specify certified oats and tamari', () => {
  const glutenGrains = /\b(wheat|barley|bulgur|couscous|orzo|sourdough|pita|breadcrumbs|miso)\b/;
  for (const recipe of MEAL_CATALOG.filter(r => r.tags.includes('gluten-free'))) {
    for (const name of names(recipe)) {
      assert.ok(!glutenGrains.test(name), `${recipe.id}: ${name}`);
      if (/\b(oats|tamari|tortillas|rice noodles|buckwheat flour|cornmeal)\b/.test(name)) assert.match(name, /certified gluten-free/, `${recipe.id}: ${name}`);
      if (/\bbroth\b/.test(name)) assert.match(name, /gluten-free/);
    }
  }
});

test('raw poultry, fish, meat and eggs have explicit safe cooking instructions', () => {
  for (const recipe of MEAL_CATALOG) {
    const ingredients = names(recipe).join(' | ');
    const steps = recipe.steps.join(' ');
    assert.ok(recipe.steps.length >= 2 && recipe.steps.length <= 8, recipe.id);
    for (const step of recipe.steps) assert.ok(typeof step === 'string' && step.length >= 40 && step.length <= 600, recipe.id);
    if (/raw.*?\b(chicken|turkey)\b/.test(ingredients)) assert.match(steps, /165°F \(74°C\)/, recipe.id);
    if (/raw (?:salmon|cod|trout) fillet/.test(ingredients)) assert.match(steps, /145°F \(63°C\)/, recipe.id);
    if (/raw lean ground (?:beef|pork)/.test(ingredients)) assert.match(steps, /160°F \(71°C\)/, recipe.id);
    if (/raw (?:boneless beef sirloin steak|pork tenderloin)/.test(ingredients)) {
      assert.match(steps, /145°F \(63°C\)/, recipe.id);
      assert.match(steps.toLowerCase(), /rest.*(?:at least )?3 minutes/, recipe.id);
    }
    if (/\beggs\b/.test(ingredients)) {
      assert.ok(/160°F \(71°C\)/.test(steps) || /whites? and yolks? (?:must be|are) firm/.test(steps), recipe.id);
    }
  }
});

test('ready meals avoid invented medical targets, treatment claims and current price claims', () => {
  for (const recipe of MEAL_CATALOG) {
    const text = [recipe.title, recipe.description, recipe.reason, ...recipe.steps].join(' ').toLowerCase();
    assert.ok(!/\b(cure|treats?|detox|reverses?|prevents?|cholesterol|blood sugar|weight loss|calorie deficit|vitamin deficiency)\b/.test(text), recipe.id);
    assert.ok(!/\b(costco|kroger|meijer|live price|on sale|guaranteed price)\b/.test(text), recipe.id);
    assert.ok(!/\b(overnight|marinate for (?:several|four|eight)|soak for (?:several|four|eight))\b/.test(recipe.steps.join(' ').toLowerCase()), recipe.id);
  }
});
