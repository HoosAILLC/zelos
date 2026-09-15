/** Fictional meal selections in module memory, using the app's original recipe
 * catalog. No model, retailer, health inference, order or account is contacted. */
import {recipes as catalog,stores as availableStores} from './demo-catalog.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const slots=['breakfast','lunch','dinner'];
const example='Prepared sample menu · no live AI call and no personal health assessment. Prices are rough ingredient estimates, not retailer quotes or full-package costs.';
export function createDemoMeals(records,{now,fail,id}) {
  const health=records['/api/health-tracking'];
  const weeks=new Map(),healthDrafts=new Map(),savedHealthDrafts=new Map();
  let tasteRevision='demo-taste-0',storeRevision='demo-stores-0';
  let favorites=[],skipped=[],storeIds=['kroger','aldi'];
  const dateAt=(week,n)=>new Date(Date.parse(week+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  const validDate=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value||'')||!Number.isFinite(Date.parse(value+'T12:00:00Z')))fail('Choose a valid sample week.');return value;};
  const recipeFor=(recipe,servings=1)=>({...clone(recipe),discoveryId:recipe.id,origin:'library',basisIds:[],healthNotes:[],
    ingredients:recipe.ingredients.map(item=>({...item,quantity:item.quantity*servings,costLow:item.costLow*servings,costHigh:item.costHigh*servings})),
    costLow:recipe.ingredients.reduce((n,item)=>n+item.costLow*servings,0),costHigh:recipe.ingredients.reduce((n,item)=>n+item.costHigh*servings,0),priceCurrency:'USD'});
  function makeWeek(weekStart,{servings=2,maxMinutes=45,instructions=''}={}) {
    const recipes=catalog.map(recipe=>recipeFor(recipe,servings));
    const meals=Array.from({length:7},(_,day)=>slots.map(slot=>({id:`${day}-${slot}`,date:dateAt(weekStart,day),slot,recipeId:recipes.filter(r=>r.slot===slot&&r.minutes<=maxMinutes)[day%Math.max(1,recipes.filter(r=>r.slot===slot&&r.minutes<=maxMinutes).length)]?.id||recipes.find(r=>r.slot===slot).id}))).flat();
    return {id:'demo_week_'+weekStart,revision:id('meal_revision'),weekStart,servings,maxMinutes,instructions,recipes,meals,
      selectedIds:meals.filter(m=>m.slot==='dinner').map(m=>m.id),currency:'USD',weeklyBudget:health.profile.weeklyBudget,sources:[],priceNote:example,createdAt:now(),built:null};
  }
  function getWeek(weekStart){validDate(weekStart);if(!weeks.has(weekStart))weeks.set(weekStart,makeWeek(weekStart));return weeks.get(weekStart);}
  const stores=()=>clone({stores:storeIds.map(value=>availableStores.find(store=>store.id===value)),availableStores,revision:storeRevision,note:'Sample preferences only. No store account is connected and no prices are checked.'});
  const state=weekStart=>clone({week:getWeek(weekStart),job:null,profile:health.profile,storePreferences:stores(),health:{labCount:0,sources:[],ready:false},stale:false,notice:example});
  const library=weekStart=>clone({recipes:catalog.map(recipe=>recipeFor(recipe)),favorites,skipped,revision:tasteRevision,weekRevision:getWeek(weekStart).revision,
    eligibleCount:catalog.length,sources:[],currency:'USD',preferences:{...health.profile,servings:health.profile.householdSize},blocked:false,warnings:[],unknownAllergies:true,noAllergyConfirmation:true,stale:false,note:example});
  const guard=(expected,actual)=>{if(expected!==actual)fail('This sample changed. Reload the current view before saving.',409);};
  function action(route,body={}) {
    if(route==='/api/shopping/store-preferences'){
      guard(body.expectedRevision,storeRevision);
      if(!Array.isArray(body.storeIds)||body.storeIds.some(value=>!availableStores.some(store=>store.id===value)))fail('Choose a store from the sample list.');
      storeIds=[...new Set(body.storeIds)];storeRevision=id('store_revision');return stores();
    }
    if(route==='/api/shopping/meals/taste'){
      guard(body.expectedRevision,tasteRevision);
      if(!catalog.some(recipe=>recipe.id===body.recipeId)||!['favorite','skip','clear'].includes(body.action))fail('Choose a recipe from the sample library.');
      favorites=favorites.filter(value=>value!==body.recipeId);skipped=skipped.filter(value=>value!==body.recipeId);
      if(body.action==='favorite')favorites.push(body.recipeId);if(body.action==='skip')skipped.push(body.recipeId);
      tasteRevision=id('taste_revision');return clone({favorites,skipped,revision:tasteRevision});
    }
    if(!['/api/shopping/week/generate','/api/shopping/week/build','/api/shopping/week/cancel','/api/shopping/meals/add'].includes(route))fail('This action needs the installed app.',501);
    const week=getWeek(body.weekStart);
    if(route==='/api/shopping/week/cancel')return state(body.weekStart);
    guard(body.expectedRevision,week.revision);
    if(route==='/api/shopping/week/generate'){
      const servings=Number(body.servings),maxMinutes=Number(body.maxMinutes);
      if(!Number.isInteger(servings)||servings<1||servings>20||!Number.isFinite(maxMinutes)||maxMinutes<1||maxMinutes>120)fail('Choose valid sample servings and cooking time.');
      weeks.set(body.weekStart,makeWeek(body.weekStart,{servings,maxMinutes,instructions:String(body.instructions||'').slice(0,1000)}));return state(body.weekStart);
    }
    if(route==='/api/shopping/meals/add'){
      const meal=week.meals.find(meal=>meal.id===body.mealId),recipe=week.recipes.find(recipe=>recipe.id===body.recipeId);
      if(!meal||!recipe||recipe.slot!==meal.slot)fail('Choose a matching meal and day.');
      meal.recipeId=recipe.id;week.selectedIds=[...new Set([...week.selectedIds,meal.id])];week.revision=id('meal_revision');return state(body.weekStart);
    }
    if(body.weekId!==week.id||!Array.isArray(body.selectedIds)||body.selectedIds.some(value=>!week.meals.some(meal=>meal.id===value)))fail('Choose meals from this sample week.');
    const choices=body.choices||{};
    for(const [mealId,recipeId] of Object.entries(choices)){
      const meal=week.meals.find(value=>value.id===mealId),recipe=week.recipes.find(value=>value.id===recipeId);
      if(!meal||!recipe||meal.slot!==recipe.slot)fail('Choose a matching replacement meal.');
    }
    for(const meal of week.meals)if(choices[meal.id])meal.recipeId=choices[meal.id];
    week.selectedIds=[...new Set(body.selectedIds)];
    const grouped=new Map();
    for(const meal of week.meals.filter(meal=>week.selectedIds.includes(meal.id)))for(const ingredient of week.recipes.find(recipe=>recipe.id===meal.recipeId).ingredients){
      const key=ingredient.name+'|'+ingredient.unit,group=grouped.get(key)||{...ingredient,quantity:0,costLow:0,costHigh:0};
      group.quantity+=ingredient.quantity;group.costLow+=ingredient.costLow;group.costHigh+=ingredient.costHigh;grouped.set(key,group);
    }
    const planId=week.id;
    const groceries=[...grouped.values()].map((ingredient,index)=>({id:planId+'_ingredient_'+index,planId,name:ingredient.name,quantity:`${Number(ingredient.quantity.toFixed(2))} ${ingredient.unit}`,estimatedCost:(ingredient.costLow+ingredient.costHigh)/200,state:'needed',createdAt:now(),updatedAt:now()}));
    health.groceryItems=[...health.groceryItems.filter(item=>item.planId!==planId),...groceries];
    const plan={id:planId,title:'Sample meal week',weekStart:week.weekStart,entries:week.meals.filter(meal=>week.selectedIds.includes(meal.id)).map(meal=>({id:planId+'_'+meal.id,date:meal.date,type:'meal',title:week.recipes.find(recipe=>recipe.id===meal.recipeId).title,state:'planned'})),updatedAt:now()};
    const existing=health.plans.findIndex(value=>value.id===planId);if(existing<0)health.plans.unshift(plan);else health.plans[existing]=plan;
    week.built={at:now(),itemIds:groceries.map(item=>item.id)};week.revision=id('meal_revision');
    return {week:clone(week),groceryCount:groceries.length,notice:'Sample list updated only in this tab. No order was placed.'};
  }
  function healthPreview(body={}) {
    const weekStart=validDate(body.weekStart),servings=Math.min(20,Math.max(1,Number(health.profile.householdSize)||2));
    const entries=Array.from({length:7},(_,day)=>{
      const recipe=recipeFor(catalog.filter(recipe=>recipe.slot==='dinner')[day],servings);
      return {date:dateAt(weekStart,day),kind:'meal',mealSlot:'dinner',title:recipe.title,details:recipe.steps.join(' '),ingredients:recipe.ingredients.map(({name,quantity,unit})=>({name,quantity,unit}))};
    });
    const grouped=new Map();entries.forEach((entry,index)=>entry.ingredients.forEach(ingredient=>{
      const key=ingredient.name+'|'+ingredient.unit,item=grouped.get(key)||{...ingredient,quantity:0,mealRefs:[]};
      item.quantity+=ingredient.quantity;item.mealRefs.push(index);grouped.set(key,item);
    }));
    const preview={id:id('health_preview'),weekStart,title:'Example dinners for the week',entries,groceries:[...grouped.values()],
      assumptions:[example,'This is a fixed fictional dinner plan, not a response to your instructions or a recommendation based on health records.',`Recipe quantities cover ${servings} sample servings. Review the meals and ingredient quantities before saving.`],
      sources:[],profileUpdatedAt:health.profile.updatedAt,reviewRequired:true,saved:false,ordered:false};
    healthDrafts.set(preview.id,clone(preview));return {preview:clone(preview),model:'a prepared example · no live AI or health assessment'};
  }
  function saveHealthPreview(body={}) {
    const preview=body.preview,issued=healthDrafts.get(preview?.id);
    if(body.reviewed!==true||!issued)fail('Review a prepared sample plan before saving.');
    if(savedHealthDrafts.has(preview.id))return clone(savedHealthDrafts.get(preview.id));
    if(preview.profileUpdatedAt!==health.profile.updatedAt||preview.profileUpdatedAt!==issued.profileUpdatedAt)fail('Your sample preferences changed. Draft a new example before saving.',409);
    if(typeof preview.title!=='string'||!preview.title.trim()||!Array.isArray(preview.entries)||preview.entries.length>56||!Array.isArray(preview.groceries)||preview.groceries.length>250)fail('Review the sample plan details.');
    const units=['g','kg','ml','l','tsp','tbsp','cup','item'];
    const validIngredient=item=>item&&typeof item.name==='string'&&item.name.trim()&&Number.isFinite(item.quantity)&&item.quantity>0&&units.includes(item.unit);
    if(preview.entries.some(entry=>!entry.title?.trim()||!entry.details?.trim()||entry.kind!=='meal'||!Array.isArray(entry.ingredients)||!entry.ingredients.length||entry.ingredients.some(item=>!validIngredient(item)))||preview.groceries.some(item=>!validIngredient(item)))fail('Review every meal and ingredient quantity.');
    const plan={id:id('health_plan'),title:preview.title,weekStart:issued.weekStart,entries:preview.entries.map(entry=>({...clone(entry),id:id('meal'),state:'planned'})),createdAt:now(),updatedAt:now()};
    const groceries=preview.groceries.map(item=>({id:id('grocery'),planId:plan.id,entryId:plan.entries[item.mealRefs?.[0]]?.id||'',name:item.name,quantity:Number(item.quantity.toFixed(2))+' '+item.unit,estimatedCost:null,state:'needed',createdAt:now(),updatedAt:now()}));
    health.plans.unshift(plan);health.groceryItems.push(...groceries);
    const result={saved:true,plan:clone(plan),groceryCount:groceries.length,notice:'Prepared example saved only in this tab. No order was placed.'};
    savedHealthDrafts.set(preview.id,result);return clone(result);
  }
  return {week:state,library,stores,action,healthPreview,saveHealthPreview};
}
