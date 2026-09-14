import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.ZELOS_LOG_LEVEL = 'silent';
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-health-planner-'));
process.env.ZELOS_HOME = path.join(temp, 'home');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { migrateHealth, saveProfile, saveLab, getHealth } = await import('../core/health.mjs');
const { generateHealthPlan, HealthPlannerError, HEALTH_PLAN_SOURCES } = await import('../core/health-planner.mjs');
const config = { identity: { email: 'PRIVATE_IDENTITY@example.com' }, mail: [{ password: 'MAIL_SECRET_SENTINEL' }], model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'nemotron-3-nano:30b', maxTokens: 16384 } };
const weekStart = '2026-09-14';
const dates = Array.from({ length: 7 }, (_, i) => `2026-09-${14 + i}`);
function fixture(t, preferences = {}) {
  const db = new DatabaseSync(':memory:'); migrateHealth(db); t.after(() => db.close());
  saveProfile(db, { goals: 'Make cooking easier and build a consistent walking routine', diet: 'none', allergies: 'none', exerciseLimitations: 'none', householdSize: 2, weeklyBudget: 95, ...preferences });
  return db;
}
function plan() {
  return { title: 'A practical week', assumptions: ['Simple stovetop preparation is available.'],
    meals: dates.flatMap(date => ['breakfast', 'lunch', 'dinner'].map(mealSlot => ({ date, mealSlot, title: 'Rice, chickpeas and vegetables', details: 'Cook the rice, then combine with chickpeas and steamed broccoli.', ingredients: [{ name: 'Brown rice (dry)', quantity: 100, unit: 'g' }, { name: 'Chickpeas', quantity: 200, unit: 'g' }, { name: 'Broccoli', quantity: 200, unit: 'g' }] }))),
    workouts: dates.map((date, i) => i === 6 ? { date, activity: 'rest', title: 'Rest day', details: 'Take time to relax.', durationMinutes: 0, intensity: 'rest' } : { date, activity: 'walking', title: 'Easy walk', details: 'Walk at a comfortable pace on a familiar flat route.', durationMinutes: 10, intensity: 'light' }),
  };
}
const reply = (value = plan(), extra = {}) => ({ text: JSON.stringify(value), stopReason: 'stop', model: 'nemotron-3-nano:30b', usage: { input: 150, output: 3000 }, ...extra });
const options = (db, extra = {}) => ({ db, config, weekStart, complete: async () => reply(), ...extra });
const hasCode = code => error => error instanceof HealthPlannerError && error.code === code;
const ingredientPlan = name => { const value = plan(); value.meals[0].ingredients.push({ name, quantity: 1, unit: 'item' }); return value; };

test('generates a complete local review preview without reading labs or saving any records', async t => {
  const db = fixture(t);
  saveLab(db, { date: weekStart, name: 'PRIVATE_LAB_SENTINEL', value: '8', unit: 'mg/L', documentNote: 'PRIVATE_CLINICAL_NOTE' });
  const before = JSON.stringify(getHealth(db)); const reads = []; let request;
  const readOnlyDB = { prepare(sql) { reads.push(sql); assert.doesNotMatch(sql, /health_records|messages|events|secrets/i); return db.prepare(sql); } };
  const result = await generateHealthPlan(options(readOnlyDB, { instructions: 'Keep cleanup quick.', complete: async value => { request = value; return reply(); } }));
  assert.equal(result.preview.entries.length, 28); assert.equal(result.preview.entries.filter(entry => entry.kind === 'meal').length, 21);
  assert.equal(result.preview.reviewRequired, true); assert.equal(result.preview.saved, false); assert.equal(result.preview.ordered, false);
  assert.equal(result.preview.profileUpdatedAt, getHealth(db).profile.updatedAt);
  assert.equal(result.preview.weekStart, weekStart); assert.match(result.preview.id, /^health_preview_/);
  assert.deepEqual(result.usage, { input: 150, output: 3000 }); assert.equal(result.model, config.model.model);
  assert.equal(request.json, true); assert.equal(request.reasoningEffort, 'none'); assert.equal(request.localRuntime, 'ollama');
  assert.equal(request.stream, true); assert.equal(request.maxTokens, 16384); assert.equal(request.apiKey, null); assert.equal(request.retries, 1);
  assert.match(request.messages[0].content, /Keep cleanup quick/); assert.match(request.messages[0].content, /95/); assert.match(request.messages[0].content, /cooking easier/);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_LAB|PRIVATE_CLINICAL|PRIVATE_IDENTITY|MAIL_SECRET/);
  assert.equal(reads.length, 2); assert.equal(JSON.stringify(getHealth(db)), before);
  assert.deepEqual(result.preview.sources.map(source => source.url), HEALTH_PLAN_SOURCES.map(source => source.url));
  assert.match(result.preview.assumptions.join(' '), /prices.*not been checked/);
});

test('derived grocery totals convert compatible units and reference actual chronological meals', async t => {
  const db = fixture(t); const value = plan();
  value.meals.reverse(); value.meals[0].ingredients[0] = { name: 'Brown rice (dry)', quantity: 0.2, unit: 'kg' };
  value.meals[1].ingredients.push({ name: 'Brown rice (dry)', quantity: 50, unit: 'g' });
  const { preview } = await generateHealthPlan(options(db, { complete: async () => reply(value) }));
  const rice = preview.groceries.find(item => item.name === 'Brown rice (dry)');
  assert.equal(rice.quantity, 2250); assert.equal(rice.unit, 'g'); assert.equal(rice.mealRefs.length, 21);
  assert.deepEqual(preview.entries.slice(0, 4).map(entry => entry.mealSlot || entry.kind), ['breakfast', 'lunch', 'dinner', 'workout']);
  for (const grocery of preview.groceries) for (const index of grocery.mealRefs) assert.equal(preview.entries[index].kind, 'meal');
  assert.ok(preview.groceries.every(item => !Object.hasOwn(item, 'price')));
});

test('rejects remote, credential-bearing, query-bearing and cloud model configurations before inference', async t => {
  const db = fixture(t); let calls = 0;
  const variants = [{ baseUrl: 'https://api.openai.com/v1' }, { baseUrl: 'http://user:pass@127.0.0.1:11434/v1' }, { baseUrl: 'http://127.0.0.1:11434/v1?upstream=remote' }, { baseUrl: 'ftp://127.0.0.1/v1' }, { model: 'nemotron-3-super:cloud' }, { protocol: 'unknown' }];
  for (const change of variants) await assert.rejects(generateHealthPlan(options(db, { config: { model: { ...config.model, ...change } }, complete: async () => { calls++; return reply(); } })), hasCode('local_model_required'));
  assert.equal(calls, 0);
});

test('requires explicit goals, diet, allergies and limitations; missing is never interpreted as none', async t => {
  const db = fixture(t); let calls = 0;
  for (const key of ['goals', 'diet', 'allergies', 'exerciseLimitations']) {
    const previous = getHealth(db).profile[key]; saveProfile(db, { [key]: '' });
    await assert.rejects(generateHealthPlan(options(db, { complete: async () => { calls++; return reply(); } })), hasCode('profile_incomplete'));
    saveProfile(db, { [key]: previous });
  }
  assert.equal(calls, 0);
});

test('asks for clarification about ambiguous allergens, restrictions and clinical planning scope', async t => {
  const db = fixture(t); let calls = 0;
  const cases = [{ allergies: 'maybe peanuts' }, { allergies: 'nuts' }, { allergies: 'nightshades' }, { exerciseLimitations: 'bad knees' }, { exerciseLimitations: 'knee pain' }, { diet: 'renal diet' }, { diet: 'halal' }, { goals: 'lose 10 pounds this week' }, { diet: 'ketogenic' }];
  for (const change of cases) {
    saveProfile(db, { goals: 'Build a routine', diet: 'none', allergies: 'none', exerciseLimitations: 'none', ...change });
    await assert.rejects(generateHealthPlan(options(db, { complete: async () => { calls++; return reply(); } })), hasCode('clarification_needed'), JSON.stringify(change));
  }
  assert.equal(calls, 0);
});

test('blocks major allergen aliases even if the model ignores the saved allergy', async t => {
  const db = fixture(t);
  for (const [allergies, food] of [['milk', 'whey'], ['eggs', 'mayonnaise'], ['fish', 'salmon'], ['shellfish', 'shrimp'], ['tree nuts', 'cashew'], ['peanuts', 'groundnut oil'], ['wheat', 'semolina'], ['soy', 'edamame'], ['sesame', 'tahini'], ['gluten', 'barley'], ['kiwi', 'kiwi']]) {
    saveProfile(db, { allergies });
    await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(ingredientPlan(food)) })), hasCode('unsafe_plan'), `${allergies}/${food}`);
  }
});

test('applies diet exclusions and checks preparation text as well as ingredient names', async t => {
  const db = fixture(t, { diet: 'vegan' });
  for (const food of ['chicken', 'salmon', 'cheese', 'eggs', 'honey']) await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(ingredientPlan(food)) })), hasCode('unsafe_plan'));
  saveProfile(db, { diet: 'none', allergies: 'peanuts' });
  const value = plan(); value.meals[0].details += ' Add peanut oil.';
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('unsafe_plan'));
});

test('does not confuse plant milk with dairy, but still blocks its actual nut allergen', async t => {
  const db = fixture(t, { allergies: 'milk' });
  await generateHealthPlan(options(db, { complete: async () => reply(ingredientPlan('Almond milk')) }));
  saveProfile(db, { allergies: 'milk and tree nuts' });
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(ingredientPlan('Almond milk')) })), hasCode('unsafe_plan'));
});

test('exercise exclusions cannot be bypassed through free-text instructions', async t => {
  const db = fixture(t, { exerciseLimitations: 'no running or jumping' });
  let request;
  await generateHealthPlan(options(db, { complete: async value => { request = value; return reply(); } }));
  assert.match(request.messages[0].content, /Exercise exclusions: running, jumping/);
  const value = plan(); value.workouts[0].details = 'Begin with ten jumping jacks.';
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('unsafe_plan'));
  saveProfile(db, { exerciseLimitations: 'walking only' });
  value.workouts[0] = { ...value.workouts[0], activity: 'bodyweight_strength' };
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('invalid_plan'));
});

test('rest-only preference produces no disguised exercises', async t => {
  const db = fixture(t, { exerciseLimitations: 'rest only' }); const value = plan();
  value.workouts = dates.map(date => ({ date, activity: 'rest', title: 'Rest day', details: 'Relax and enjoy free time.', durationMinutes: 0, intensity: 'rest' }));
  const result = await generateHealthPlan(options(db, { complete: async () => reply(value) }));
  assert.ok(result.preview.entries.filter(entry => entry.kind === 'workout').every(entry => entry.durationMinutes === 0));
  value.workouts[0].details = 'Walk for ten minutes.';
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('unsafe_plan'));
});

test('validates the whole seven-day schedule and bounded explicit quantities', async t => {
  const db = fixture(t);
  const mutations = [p => p.meals.pop(), p => p.workouts.pop(), p => p.meals[0].date = '2026-09-21', p => p.meals[0].date = p.meals[3].date, p => p.meals[0].mealSlot = 'snack', p => p.meals[0].ingredients[0].quantity = -1, p => p.meals[0].ingredients[0].quantity = 0, p => p.meals[0].ingredients[0].quantity = 100000, p => p.meals[0].ingredients[0].quantity = 1.234, p => p.meals[0].ingredients[0].quantity = '100', p => p.meals[0].ingredients[0].unit = 'some', p => p.workouts[0].durationMinutes = 180, p => p.workouts[0].intensity = 'vigorous', p => p.workouts[0].activity = 'sprinting', p => p.groceries = [{ name: 'invented' }], p => p.meals[0].calories = 600];
  for (const mutate of mutations) { const value = plan(); mutate(value); await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('invalid_plan')); }
  assert.equal(getHealth(db).plans.length, 0); assert.equal(getHealth(db).groceryItems.length, 0);
});

test('rejects invented clinical advice, supplement advice and precise nutrition claims', async t => {
  const db = fixture(t);
  for (const details of ['This meal has 500 calories.', 'Protein: 40 grams.', 'Take a vitamin D supplement daily.', 'This will cure diabetes.', 'Your blood test shows a deficiency.']) {
    const value = plan(); value.meals[0].details = details;
    await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('unsafe_plan'), details);
  }
  await assert.rejects(generateHealthPlan(options(db, { instructions: 'Prescribe supplements for me.' })), hasCode('clarification_needed'));
});

test('rejects malformed, incomplete, oversized and executable model content', async t => {
  const db = fixture(t);
  for (const value of [{ text: '{' }, { text: '```json\n{}\n```' }, { text: 'x'.repeat(90001) }, { text: '' }]) await assert.rejects(generateHealthPlan(options(db, { complete: async () => value })), hasCode('invalid_plan'));
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(plan(), { stopReason: 'length' }) })), hasCode('incomplete_plan'));
  const value = plan(); value.title = '<img src=x onerror=alert(1)>';
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('unsafe_plan'));
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply({ clarification: 'Which foods must be excluded?' }) })), hasCode('clarification_needed'));
});

test('does not return a stale preview when the profile changes during local generation', async t => {
  const db = fixture(t);
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => { saveProfile(db, { allergies: 'peanuts' }); return reply(); } })), hasCode('profile_changed'));
  assert.equal(getHealth(db).profile.allergies, 'peanuts'); assert.equal(getHealth(db).plans.length, 0);
});

test('honors cancellation before inference and after an uncooperative model returns', async t => {
  const db = fixture(t); let called = false; const early = new AbortController(); early.abort();
  await assert.rejects(generateHealthPlan(options(db, { signal: early.signal, complete: async () => { called = true; return reply(); } })), { name: 'AbortError' });
  assert.equal(called, false);
  const pending = new AbortController();
  await assert.rejects(generateHealthPlan(options(db, { signal: pending.signal, complete: async () => { pending.abort(); return reply(); } })), { name: 'AbortError' });
  assert.equal(getHealth(db).plans.length, 0);
});

test('validates dates and instruction bounds before contacting the model', async t => {
  const db = fixture(t); let called = false; const complete = async () => { called = true; return reply(); };
  for (const invalid of ['2026-02-30', '2026-2-01', '2026-09-14T00:00Z', null]) await assert.rejects(generateHealthPlan(options(db, { weekStart: invalid, complete })), hasCode('invalid_week'));
  await assert.rejects(generateHealthPlan(options(db, { instructions: 'x'.repeat(2001), complete })), hasCode('invalid_instructions'));
  assert.equal(called, false);
});


test('checks explicit named food dislikes and singular/plural allergy terms', async t => {
  const db = fixture(t, { diet: 'Mediterranean; avoid mushrooms' });
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(ingredientPlan('Mushrooms')) })), hasCode('unsafe_plan'));
  saveProfile(db, { diet: 'none', allergies: 'strawberries and bananas' });
  for (const name of ['strawberry', 'banana', 'bananas']) await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(ingredientPlan(name)) })), hasCode('unsafe_plan'));
});

test('walking-only and seated-only scopes also constrain mislabeled activity prose', async t => {
  const db = fixture(t, { exerciseLimitations: 'walking only' }); const value = plan();
  value.workouts[0].details = 'Start on a bicycle and pedal for ten minutes.';
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('unsafe_plan'));
  saveProfile(db, { exerciseLimitations: 'seated only' });
  value.workouts.forEach(entry => { if (entry.activity !== 'rest') entry.activity = 'chair_mobility'; });
  value.workouts[0].details = 'Stand beside your chair and raise your arms.';
  await assert.rejects(generateHealthPlan(options(db, { complete: async () => reply(value) })), hasCode('unsafe_plan'));
});


test('grocery aggregation uses the same count and quantity bounds as reviewed-plan persistence',async t=>{
 const db=fixture(t);const many=plan();many.meals.forEach((meal,index)=>{meal.ingredients=Array.from({length:15},(_,ingredient)=>({name:`Rice variety ${index}-${ingredient}`,quantity:1,unit:'g'}));});
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>reply(many)})),error=>hasCode('clarification_needed')(error)&&/simpler meals/.test(error.message));
 saveProfile(db,{householdSize:3});const large=plan();large.meals.forEach(meal=>{meal.ingredients=[{name:'Brown rice',quantity:6000,unit:'g'}];});
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>reply(large)})),hasCode('clarification_needed'));
 assert.equal(getHealth(db).plans.length,0);
});

function mixedNativePlan(){const value=plan();return {assumptions:value.assumptions,meals:[...value.meals,...value.workouts.map(workout=>({...workout,mealSlot:'activity',details:workout.activity==='rest'?'':workout.details}))]};}

test('the initial request supplies an exact required schema with separate food and activity arrays',async t=>{
 const db=fixture(t,{exerciseLimitations:'walking only'});let request;
 const result=await generateHealthPlan(options(db,{complete:async value=>{request=value;return reply();}}));
 const content=request.messages[0].content;const schema=JSON.parse(/Exact JSON Schema[^\n]+\n([^\n]+)/.exec(content)[1]);
 assert.deepEqual(schema.required,['title','assumptions','meals','workouts']);assert.equal(schema.additionalProperties,false);
 assert.equal(schema.properties.meals.minItems,21);assert.equal(schema.properties.meals.maxItems,21);assert.equal(schema.properties.workouts.minItems,7);assert.equal(schema.properties.workouts.maxItems,7);
 assert.equal(schema.properties.meals.items.properties.activity,undefined);assert.equal(schema.properties.workouts.items.properties.mealSlot,undefined);
 assert.deepEqual(schema.properties.workouts.items.properties.activity.enum,['walking','rest']);assert.deepEqual(schema.properties.meals.items.properties.date.enum,dates);
 assert.deepEqual(request.jsonSchema.oneOf[0],schema);assert.equal(request.jsonSchema.oneOf.length,2);
 assert.deepEqual(request.jsonSchema.oneOf[1],{type:'object',additionalProperties:false,required:['clarification'],properties:{clarification:{type:'string',minLength:1,maxLength:600}}});
 assert.deepEqual(schema.properties.meals.items.properties.ingredients.items.properties.unit.enum,['g','kg','ml','l','tsp','tbsp','cup','item']);
 assert.equal(result.attempts,1);
});

test('repairs the observed Nemotron mixed-array format once, with errors, and accounts for both local calls',async t=>{
 const db=fixture(t);const calls=[];const before=JSON.stringify(getHealth(db));
 const result=await generateHealthPlan(options(db,{complete:async request=>{calls.push(request);return calls.length===1?reply(mixedNativePlan(),{usage:{input:1078,output:5305}}):reply();}}));
 assert.equal(calls.length,2);assert.equal(result.attempts,2);assert.equal(result.preview.entries.length,28);assert.equal(result.preview.entries.filter(entry=>entry.kind==='workout').length,7);
 assert.deepEqual(result.usage,{input:1228,output:8305});assert.equal(calls[0].messages.length,1);assert.equal(calls[1].messages.length,2);
 const repair=calls[1].messages[1].content;assert.match(repair,/Validation error: Missing required top-level title, workouts/);assert.match(repair,/meals has exactly 21 FOOD entries/);assert.match(repair,/previous invalid plan/);assert.match(repair,/mealSlot.*activity/);assert.match(repair,/rest details describe rest/);
 for(const request of calls){assert.equal(request.baseUrl,config.model.baseUrl);assert.equal(request.localRuntime,'ollama');assert.equal(request.reasoningEffort,'none');assert.equal(request.json,true);assert.equal(request.stream,true);assert.equal(request.maxTokens,16384);}
 assert.deepEqual(calls[0].jsonSchema,calls[1].jsonSchema);
 assert.equal(JSON.stringify(getHealth(db)),before);
});

test('unsupported count/package units receive one format repair without automatic quantity conversions',async t=>{
 const db=fixture(t);const before=JSON.stringify(getHealth(db));
 for(const [name,unit] of [['Garlic','clove'],['Whole grain bread','slice'],['Canned chickpeas','can']]){
  const bad=plan();bad.meals[0].ingredients[0]={name,quantity:1,unit};const calls=[];
  const corrected=plan();corrected.meals[0].ingredients[0]={name:unit==='can'?'Chickpeas (drained)':`${name} ${unit}`,quantity:unit==='can'?200:1,unit:unit==='can'?'g':'item'};
  const result=await generateHealthPlan(options(db,{complete:async request=>{calls.push(request);return reply(calls.length===1?bad:corrected);}}));
  assert.equal(calls.length,2);assert.equal(result.attempts,2);
  assert.match(calls[1].messages[1].content,/Ingredient units must be exactly one of g, kg, ml, l, tsp, tbsp, cup, item/);
  assert.match(calls[1].messages[1].content,/never assume a package-to-weight conversion/);
  assert.deepEqual(result.preview.entries[0].ingredients[0],corrected.meals[0].ingredients[0]);
  let repeated=0;await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{repeated++;return reply(bad);}})),hasCode('invalid_plan'));assert.equal(repeated,2);
 }
 assert.equal(JSON.stringify(getHealth(db)),before);
});

test('unsupported units do not make invalid quantities repairable or bypass bounds after repair',async t=>{
 const db=fixture(t);
 for(const quantity of [-1,0,1.234,5000,'1']){const bad=plan();bad.meals[0].ingredients[0]={name:'Garlic',quantity,unit:'clove'};let calls=0;
  await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;return reply(bad);}})),hasCode('invalid_plan'));assert.equal(calls,1);
 }
 const invalidUnit=plan();invalidUnit.meals[0].ingredients[0].unit='can';const tooMany=plan();tooMany.meals[0].ingredients[0]={name:'Chickpeas',quantity:25,unit:'item'};let calls=0;
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;return reply(calls===1?invalidUnit:tooMany);}})),hasCode('invalid_plan'));assert.equal(calls,2);assert.equal(getHealth(db).plans.length,0);
});

test('a second malformed or incomplete schedule is rejected rather than silently normalizing or omitting entries',async t=>{
 const db=fixture(t);let calls=0;
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;return reply(mixedNativePlan());}})),hasCode('invalid_plan'));assert.equal(calls,2);
 calls=0;const missing=plan();missing.workouts.pop();
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;return reply(calls===1?mixedNativePlan():missing);}})),hasCode('invalid_plan'));assert.equal(calls,2);
 assert.equal(getHealth(db).plans.length,0);
});

test('repair is bounded by input size and does not retry truncation, unsafe content, bounds or clarification',async t=>{
 const db=fixture(t,{allergies:'peanuts'});const invalidAmount=plan();invalidAmount.meals[0].ingredients[0].quantity=-1;
 const cases=[reply(ingredientPlan('Peanuts')),reply(invalidAmount),reply(plan(),{stopReason:'length'}),reply({clarification:'Which foods should be excluded?'}),{text:'x'.repeat(40001),stopReason:'stop'}];
 for(const response of cases){let calls=0;await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;return response;}})));assert.equal(calls,1);}
 let calls=0;await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;throw new Error('Synthetic transport failure');}})),/Synthetic transport/);assert.equal(calls,1);
});

test('a repaired plan still passes every content and quantity check',async t=>{
 const db=fixture(t,{allergies:'peanuts'});let calls=0;
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;return reply(calls===1?mixedNativePlan():ingredientPlan('Peanut butter'));}})),hasCode('unsafe_plan'));assert.equal(calls,2);
 const excessive=plan();excessive.workouts[0].durationMinutes=90;calls=0;
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;return reply(calls===1?mixedNativePlan():excessive);}})),hasCode('invalid_plan'));assert.equal(calls,2);
 assert.equal(getHealth(db).plans.length,0);
});

test('cancellation and profile changes during repair stop the result without writes',async t=>{
 const db=fixture(t);const controller=new AbortController();let calls=0;
 await assert.rejects(generateHealthPlan(options(db,{signal:controller.signal,complete:async()=>{calls++;if(calls===1)return reply(mixedNativePlan());controller.abort();return reply();}})),{name:'AbortError'});assert.equal(calls,2);
 calls=0;await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;if(calls===1)return reply(mixedNativePlan());saveProfile(db,{allergies:'sesame'});return reply();}})),hasCode('profile_changed'));assert.equal(calls,2);
 assert.equal(getHealth(db).plans.length,0);assert.equal(getHealth(db).profile.allergies,'sesame');
});

test('a profile change before structural validation prevents a repair call',async t=>{
 const db=fixture(t);let calls=0;
 await assert.rejects(generateHealthPlan(options(db,{complete:async()=>{calls++;saveProfile(db,{exerciseLimitations:'walking only'});return reply(mixedNativePlan());}})),hasCode('profile_changed'));assert.equal(calls,1);
});
