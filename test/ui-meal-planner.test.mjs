import test from 'node:test';import assert from 'node:assert/strict';
import {installDom,text,findButton,settle} from './helpers/ui-dom.mjs';
import {samplePlan} from './helpers/meal-fixture.mjs';
let sequence=0;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t,{empty=false}={}) {
 const document=installDom(t),{api}=await import('../ui/lib/api.js'),calls=[];
 const names=['mealWeek','mealLibrary','saveMealTaste','addMealFromLibrary','generateMealWeek','cancelMealWeek','buildMealGroceries','saveHealthProfile','saveGroceryStores','saveShoppingSettings'];const previous=Object.fromEntries(names.map(n=>[n,api[n]]));t.after(()=>Object.assign(api,previous));
 const stores=[{id:'costco',name:'Costco'},{id:'kroger',name:'Kroger'},{id:'meijer',name:'Meijer'},{id:'aldi',name:'ALDI'}];
 const raw=samplePlan(),base={profile:{goals:'Varied meals',diet:'none',allergies:'none',householdSize:1,weeklyBudget:80,currency:'USD',updatedAt:'p1'},storePreferences:{stores:stores.slice(0,3),availableStores:stores,revision:'stores-v1',updatedAt:'2026-09-12T12:00:00Z',note:'Rough prices, not checked store quotes.'},health:{labCount:1},job:null,stale:false};
 let response;
 api.mealWeek=async weekStart=>{response ||= {...base,week:empty?null:{id:'w1',revision:'v1',weekStart,servings:1,currency:'USD',maxMinutes:45,createdAt:'2026-09-12T12:00:00Z',selectedIds:[],sources:[{id:'profile:goals',title:'Your goals',href:'#/health/profile'}],priceNote:'Rough prices',recipes:raw.recipes.map(r=>({...r,costLow:110,costHigh:180})),meals:Array.from({length:7},(_,day)=>['breakfast','lunch','dinner'].map((slot,i)=>({day,slot,recipeId:`r${i*3+day%3}`}))).flat().map(m=>{const d=new Date(weekStart+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+m.day);return {id:`${m.day}-${m.slot}`,date:d.toISOString().slice(0,10),slot:m.slot,recipeId:m.recipeId};})}};return structuredClone(response);};
 api.generateMealWeek=async body=>{calls.push({type:'generate',body});return {...response,job:{status:'complete'}};};
 api.buildMealGroceries=async body=>{calls.push({type:'build',body});response.week.selectedIds=body.selectedIds;response.week.revision='v2';return {week:structuredClone(response.week),groceryCount:3};};
 api.saveHealthProfile=async body=>{calls.push({type:'profile',body});return {profile:{...body,updatedAt:'p2'}};};
 api.saveGroceryStores=async body=>{calls.push({type:'stores',body});if(body.expectedRevision!==response.storePreferences.revision)throw new Error('Your preferred stores changed on another device. Reload before saving.');response.storePreferences={...response.storePreferences,stores:stores.filter(s=>body.storeIds.includes(s.id)),revision:`stores-v${calls.filter(c=>c.type==='stores').length+1}`};return structuredClone(response.storePreferences);};
 api.saveShoppingSettings=async body=>{calls.push({type:'connection',body});throw new Error('Store preferences must not configure Instacart.');};
 api.mealLibrary=async()=>({recipes:[{...raw.recipes[0],discoveryId:'catalog:berry-oatmeal',origin:'library',servings:1,costLow:110,costHigh:180,priceCurrency:'USD',tags:['vegan'],protein:'Grains',cuisine:'Everyday'}],favorites:[],skipped:[],revision:'taste1',sources:[],currency:'USD',totalCount:1,excludedCount:0,warnings:[],blocked:false});
 api.saveMealTaste=async()=>{throw new Error('This test did not authorize saving a taste preference.');};
 api.addMealFromLibrary=async()=>{throw new Error('This test must supply its explicit Add response.');};
 const {createMealPlanner}=await import(`../ui/lib/meal-planner.js?test=${++sequence}`);const planner=createMealPlanner({onListBuilt:async()=>calls.push({type:'loaded'})});document.body.appendChild(planner.root);await settle();return {view:planner.root,api,calls,planner,response};
}
test('renders seven days, three meals, times and prices without generating or writing on load',async t=>{const {view,calls}=await fixture(t);assert.equal(view.querySelectorAll('.meal-day').length,7);assert.equal(view.querySelectorAll('.meal-card').length,3);assert.match(text(view),/20 min/);assert.match(text(view),/1.10/);assert.equal(calls.length,0);assert.equal(findButton(view,'Build grocery list').disabled,true);});
test('selections and swaps build exactly the chosen meals and reload groceries once',async t=>{const {view,calls}=await fixture(t);view.querySelectorAll('.meal-select')[0].click();const swap=view.querySelectorAll('select').find(n=>n.getAttribute('aria-label').startsWith('Swap breakfast'));swap.value='r1';swap.fire('change');findButton(view,'Build grocery list').click();await settle();const built=calls.find(c=>c.type==='build');assert.deepEqual(built.body.selectedIds,['0-breakfast']);assert.deepEqual(built.body.choices,{'0-breakfast':'r1'});assert.equal(built.body.expectedRevision,'v1');assert.match(text(view),/1 meal saved/);assert.equal(calls.filter(c=>c.type==='loaded').length,1);});
test('preference edits are saved explicitly and generation uses one-person defaults',async t=>{const {view,calls}=await fixture(t,{empty:true});const goals=view.querySelector('[aria-label="Your goals"]');goals.value='Simple cooking';goals.fire('input');findButton(view,'Plan my week').click();await settle();assert.equal(calls[0].type,'profile');assert.equal(calls[0].body.goals,'Simple cooking');assert.equal(calls[1].type,'generate');assert.equal(calls[1].body.servings,1);assert.equal(calls[1].body.maxMinutes,45);});
test('a failed list save keeps the chosen meals and does not claim success',async t=>{const {view,api}=await fixture(t);view.querySelectorAll('.meal-select')[1].click();api.buildMealGroceries=async()=>{throw new Error('The current list changed');};findButton(view,'Build grocery list').click();await settle();assert.match(text(view),/The current list changed/);assert.match(text(view),/1 meal selected/);assert.doesNotMatch(text(view),/meal saved/);});
test('cross-device changes keep local choices reviewable and block stale saving',async t=>{const {view,planner,response,calls}=await fixture(t);view.querySelectorAll('.meal-select')[0].click();response.week.revision='external';response.week.recipes=samplePlan().recipes.map(r=>({...r,id:'new-'+r.id}));await planner.reload();assert.match(text(view),/changed on another device/);assert.equal(findButton(view,'Build grocery list').disabled,true);assert.equal(calls.length,0);assert.equal(view.querySelectorAll('.meal-card').length,3);});
test('unsaved preferences cannot silently build a list from older assumptions',async t=>{const {view,calls}=await fixture(t);view.querySelectorAll('.meal-select')[0].click();const allergy=view.querySelector('[aria-label="Food allergies"]');allergy.value='peanuts';allergy.fire('input');findButton(view,'Build grocery list').click();await settle();assert.match(text(view),/Save your meal preferences/);assert.equal(calls.length,0);});

test('store chips save independently with their revision and preserve selected meals and swaps', async t => {
 const { view, calls, response } = await fixture(t);
 assert.deepEqual(view.querySelectorAll('.meal-store-chip').map(n => text(n)), ['Costco', 'Kroger', 'Meijer']);
 view.querySelectorAll('.meal-select')[0].click();
 const swap = view.querySelectorAll('select').find(n => n.getAttribute('aria-label').startsWith('Swap breakfast'));
 swap.value = 'r1'; swap.fire('change');
 findButton(view, 'Edit stores').click(); assert.equal(findButton(view, 'Save stores').disabled, true);
 assert.equal(findButton(view, 'Shop at Meijer').getAttribute('aria-pressed'), 'true');
 findButton(view, 'Shop at Meijer').click(); findButton(view, 'Shop at ALDI').click();
 assert.equal(calls.length, 0); assert.match(text(view), /Prices stay approximate/);
 findButton(view, 'Save stores').click(); await settle();
 assert.deepEqual(calls, [{ type: 'stores', body: { storeIds: ['costco', 'kroger', 'aldi'], expectedRevision: 'stores-v1' } }]);
 assert.deepEqual(view.querySelectorAll('.meal-store-chip').map(n => text(n)), ['Costco', 'Kroger', 'ALDI']);
 assert.match(text(view), /1 meal selected/); assert.equal(findButton(view, 'Build grocery list').disabled, false);
 assert.equal(response.profile.updatedAt, 'p1');
 findButton(view, 'Edit stores').click(); findButton(view, 'Shop at Meijer').click(); findButton(view, 'Save stores').click(); await settle();
 assert.equal(calls[1].body.expectedRevision, 'stores-v2');
 findButton(view, 'Build grocery list').click(); await settle();
 const built = calls.find(c => c.type === 'build'); assert.deepEqual(built.body.selectedIds, ['0-breakfast']); assert.deepEqual(built.body.choices, { '0-breakfast': 'r1' });
 assert.equal(built.body.expectedRevision, 'v1'); assert.equal(calls.some(c => ['profile', 'connection', 'generate'].includes(c.type)), false);
});

test('a delayed discovery Add preserves newer week selections, swaps and preferences for conflict review', async t => {
 const { view, api, response, calls } = await fixture(t), pending = defer();
 api.addMealFromLibrary = body => { calls.push({ type: 'add', body }); return pending.promise; };
 findButton(view, 'Discover meals').click(); await settle();
 const add = findButton(view, 'Add Berry oatmeal to week'); assert.ok(add); assert.equal(add.disabled, false);
 add.click();
 assert.equal(calls.length, 1);
 assert.deepEqual(calls[0].body, { weekStart: response.week.weekStart, recipeId: 'catalog:berry-oatmeal', mealId: '0-breakfast', expectedRevision: 'v1' });
 findButton(view, 'Your week · 0/21').click();
 view.querySelectorAll('.meal-select')[1].click();
 let swap = view.querySelectorAll('select').find(node => node.getAttribute('aria-label').startsWith('Swap breakfast'));
 swap.value = 'r1'; swap.fire('change');
 const allergy = view.querySelector('[aria-label="Food allergies"]'); allergy.value = 'peanuts'; allergy.fire('input');
 pending.resolve({ ...structuredClone(response), week: { ...structuredClone(response.week), revision: 'added-v2', selectedIds: ['0-breakfast'] }, unchanged: false });
 await settle();
 assert.match(text(view), /newer unsaved choices were kept for review/);
 assert.match(text(view), /changed on another device/);
 assert.match(text(view), /1 meal selected/);
 assert.deepEqual(view.querySelectorAll('.meal-select').map(node => node.getAttribute('aria-pressed')), ['false', 'true', 'false']);
 swap = view.querySelectorAll('select').find(node => node.getAttribute('aria-label').startsWith('Swap breakfast'));
 assert.equal(swap.value, 'r1');
 assert.equal(view.querySelector('[aria-label="Food allergies"]').value, 'peanuts');
 assert.equal(findButton(view, 'Build grocery list').disabled, true);
 findButton(view, 'Build grocery list').click(); await settle();
 assert.deepEqual(calls.map(call => call.type), ['add']);
});

test('saving stores does not save or discard unfinished health preference edits', async t => {
 const { view, calls } = await fixture(t);
 const allergy = view.querySelector('[aria-label="Food allergies"]'); allergy.value = 'peanuts'; allergy.fire('input');
 view.querySelectorAll('.meal-select')[0].click(); findButton(view, 'Edit stores').click(); findButton(view, 'Shop at ALDI').click();
 findButton(view, 'Save stores').click(); await settle();
 assert.deepEqual(calls.map(c => c.type), ['stores']); assert.equal(view.querySelector('[aria-label="Food allergies"]').value, 'peanuts');
 assert.match(text(view), /1 meal selected/);
 assert.equal(findButton(view, 'Build grocery list').disabled, true);
 findButton(view, 'Build grocery list').click(); await settle(); assert.deepEqual(calls.map(c => c.type), ['stores']);
});

test('a stale store save retains the editable draft and selected meals without claiming success', async t => {
 const { view, response, calls } = await fixture(t);
 view.querySelectorAll('.meal-select')[1].click(); findButton(view, 'Edit stores').click(); findButton(view, 'Shop at ALDI').click();
 response.storePreferences.revision = 'stores-another-device';
 findButton(view, 'Save stores').click(); await settle();
 assert.match(text(view), /preferred stores changed on another device/); assert.doesNotMatch(text(view), /Your stores are saved/);
 assert.equal(findButton(view, 'Shop at ALDI').getAttribute('aria-pressed'), 'true'); assert.equal(findButton(view, 'Save stores').disabled, false);
 assert.match(text(view), /1 meal selected/); assert.deepEqual(calls.map(c => c.type), ['stores']); assert.equal(calls[0].body.expectedRevision, 'stores-v1');
});

test('resetting store edits restores the saved selection without a write or lost meal selection', async t => {
 const { view, calls } = await fixture(t);
 view.querySelectorAll('.meal-select')[2].click(); findButton(view, 'Edit stores').click(); findButton(view, 'Shop at Costco').click();
 assert.equal(findButton(view, 'Shop at Costco').getAttribute('aria-pressed'), 'false');
 findButton(view, 'Reset changes').click();
 assert.equal(findButton(view, 'Shop at Costco').getAttribute('aria-pressed'), 'true'); assert.equal(findButton(view, 'Save stores').disabled, true);
 assert.match(text(view), /1 meal selected/); assert.equal(calls.length, 0);
});

test('refreshing while stores are edited retains the original revision until changes are deliberately reset', async t => {
 const { view, response, planner, calls } = await fixture(t);
 view.querySelectorAll('.meal-select')[0].click(); findButton(view, 'Edit stores').click(); findButton(view, 'Shop at ALDI').click();
 response.storePreferences = { ...response.storePreferences, stores: [{ id: 'meijer', name: 'Meijer' }], revision: 'stores-external' };
 await planner.reload();
 assert.equal(findButton(view, 'Shop at Costco').getAttribute('aria-pressed'), 'true');
 assert.equal(findButton(view, 'Shop at ALDI').getAttribute('aria-pressed'), 'true');
 findButton(view, 'Save stores').click(); await settle();
 assert.equal(calls[0].body.expectedRevision, 'stores-v1'); assert.match(text(view), /preferred stores changed on another device/);
 assert.deepEqual(response.storePreferences.stores, [{ id: 'meijer', name: 'Meijer' }]);
 findButton(view, 'Reset changes').click();
 assert.equal(findButton(view, 'Shop at Costco').getAttribute('aria-pressed'), 'false');
 assert.equal(findButton(view, 'Shop at Meijer').getAttribute('aria-pressed'), 'true');
 findButton(view, 'Shop at Costco').click(); findButton(view, 'Save stores').click(); await settle();
 assert.equal(calls[1].body.expectedRevision, 'stores-external'); assert.match(text(view), /Your stores are saved/);
 assert.match(text(view), /1 meal selected/); assert.deepEqual(calls.map(c => c.type), ['stores', 'stores']);
});
