import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {mealPhoto,mealPhotoFigure,mealPhotoCredit} from '../ui/lib/meal-photos.js';
import {mealPhotoCatalog} from '../ui/lib/meal-photo-catalog.js';
import {MEAL_CATALOG} from '../core/meal-catalog.mjs';
import {installDom,text} from './helpers/ui-dom.mjs';
const photo=(title,names=[],slot='dinner')=>mealPhoto({title,ingredients:names.map(name=>({name})),slot});

test('every card photo is a bundled, verified local asset with a credit',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('../assets/meals/manifest.json',import.meta.url)));
 assert.equal(Object.keys(mealPhotoCatalog).length,37);
 assert.deepEqual(Object.keys(mealPhotoCatalog).sort(),manifest.assets.map(a=>a.id).sort());
 assert.equal(new Set(manifest.assets.map(a=>a.file)).size,manifest.assets.length);
 for(const [id,p] of Object.entries(mealPhotoCatalog)) {
  assert.match(p.src,/^\/assets\/meals\/[a-z-]+\.jpg$/);
  const source=manifest.assets.find(a=>a.id===id);assert.ok(source?.visuallyVerified);
  const bytes=fs.readFileSync(new URL('../'+p.src.slice(1),import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256);
  assert.equal(p.source,source.source);assert.ok(p.credit);assert.equal(p.width,800);
  assert.equal(p.height,source.height);assert.equal(p.position,source.objectPosition);
  assert.equal(bytes.length,source.bytes);assert.ok(source.licenseUrl);assert.equal(source.illustrative,true);
 }
});
test('dish form wins over a minor ingredient and different dishes change the image',()=>{
 assert.equal(photo('Oat pancakes',['Oat flour']).id,'pancakes');
 assert.equal(photo('Berry overnight oats').id,'oatmeal');
 assert.notEqual(photo('Berry overnight oats').src,photo('Berry smoothie').src);
 assert.equal(photo('Avocado toast',['Avocado']).id,'toast');
 assert.equal(photo('Lentil and vegetable soup',['Lentils']).id,'lentil-soup');
 assert.equal(photo('Chicken and veggie skillet',['Chicken breast']).id,'chicken');
 assert.equal(photo('Roasted salmon with rice').id,'salmon');
});
test('expanded breakfast photos follow the prepared dish rather than a shared topping',()=>{
 for(const [title,id] of [
  ['Tropical chia breakfast cup','chia-pudding'],['Strawberry cottage cheese breakfast','cottage-cheese'],
  ['Tomato and white bean shakshuka','shakshuka'],['Banana peanut butter French toast','french-toast'],
  ['Pear and almond muesli','muesli'],['Banana baked oat breakfast cake','baked-oats'],
  ['Citrus ricotta toast','ricotta-toast'],
 ]) assert.equal(photo(title,[],'breakfast').id,id,title);
 for(const title of ['Savory mushroom oats','Savory chickpea pancake','Mushroom cheddar egg muffins']) assert.equal(photo(title,[],'breakfast').id,'kitchen',title);
});
test('new savory photos cover compatible dish families, including generated title synonyms',()=>{
 for(const [title,ingredients,id] of [
  ['Tomato mozzarella panini',['Mozzarella','Tomato'],'vegetable-sandwich'],
  ['Vegetarian feta vegetable wrap',['Feta','Vegetables'],'vegetable-wrap'],
  ['Tofu scramble breakfast wrap',['Tofu','Tortilla','Spinach'],'vegan-wrap'],
  ['Chickpea cucumber pita',['Chickpeas','Cucumber'],'vegan-wrap'],
  ['Roasted cauliflower chickpea wrap',['Cauliflower','Chickpeas'],'vegan-wrap'],
  ['Black bean tacos',['Black beans'],'bean-tacos'],
  ['Spinach potato quesadilla',['Cheddar'],'quesadilla'],
  ['Butternut squash soup',['Butternut squash'],'carrot-soup'],
  ['Tempeh peanut noodle salad',['Tempeh','Wheat noodles'],'vegetable-noodles'],
  ['Vegetarian tofu curry',['Tofu'],'vegetable-curry'],
  ['Curried chickpea rice bowl',['Chickpeas','Rice'],'vegetable-curry'],
  ['Mushroom pea risotto',['Rice','Peas'],'pea-risotto'],
  ['Turkey rice stuffed peppers',['Turkey','Rice','Bell pepper'],'stuffed-peppers'],
  ['Turkey meatballs with tomato pasta',['Turkey','Pasta'],'meatballs'],
  ['Lentil mushroom bolognese',['Lentils','Pasta'],'pasta'],
  ['Spinach ricotta stuffed shells',['Pasta shells','Ricotta'],'pasta'],
  ['Roasted vegetables and hummus grain plate',['Bulgur','Vegetables'],'vegetable-stir-fry'],
  ['Eggplant tomato chickpea couscous',['Couscous','Chickpeas'],'vegetable-stir-fry'],
  ['Sweet potato black bean hash',['Sweet potato','Black beans'],'vegetable-stir-fry'],
  ['White bean kale skillet with toast',['Beans','Kale'],'vegetable-stir-fry'],
  ['Baked tofu sweet potato plate with peanut slaw',['Tofu','Sweet potato','Slaw'],'vegetable-bowl'],
 ]) assert.equal(photo(title,ingredients).id,id,title);
});
test('protein photos follow the actual protein and preparation family',()=>{
 for(const [title,ingredients,id] of [
  ['Cod tomato white bean skillet',['Cod fillet','White beans'],'white-fish'],
  ['Herb trout with quinoa and asparagus',['Trout fillet','Quinoa'],'white-fish'],
  ['Beef broccoli rice bowl',['Beef sirloin steak','Broccoli'],'beef-vegetables'],
  ['Beef fajita rice bowl',['Beef steak','Ground cumin','Rice'],'beef-vegetables'],
  ['Pork tenderloin with apple cabbage',['Pork tenderloin','Ground black pepper'],'pork-vegetables'],
  ['Chicken salad',['Chicken'],'chicken-salad'],
  ['Greek chicken orzo lunch bowl',['Chicken','Orzo','Cucumber'],'chicken-salad'],
  ['Yogurt egg salad sandwich',['Eggs','Yogurt'],'egg-sandwich'],
 ]) assert.equal(photo(title,ingredients).id,id,title);
 for(const [title,ingredients] of [
  ['Beef cabbage roll skillet',['Raw lean ground beef','Cabbage']],['Cod tacos',['Cod fillet']],
  ['Pork wrap',['Pork tenderloin']],['Tuna sandwich',['Tuna']],['Pork sausage dinner',['Pork sausage']],
 ]) assert.equal(photo(title,ingredients).id,'kitchen',title);
});
test('unmatched meals get neutral kitchen photography, never an unrelated meat or salad plate',()=>{
 for(const [title,ingredients] of [
  ['Vegan chicken sandwich',['Plant-based chicken']],['Salmon soup',['Salmon']],
  ['Chicken vegetable minestrone',['Chicken','Pasta']],['Chicken peanut noodles',['Chicken','Noodles']],
  ['Tuna yogurt stuffed potato',['Tuna','Yogurt']],
  ['Chicken tacos',['Chicken']],['Pork meatball miso noodle soup',['Pork','Noodles']],
  ['Vegan meatballs',['Tofu']],['Peanut butter toast',['Peanut butter']],['Oat muffins',['Oat flour']],['Unknown dinner',[]],
 ]) assert.equal(photo(title,ingredients).id,'kitchen',title);
 assert.equal(photo('Apple and seed bowl',['Apples','Seeds'],'breakfast').caption,'Kitchen inspiration');
 assert.equal(photo('<img src=https://external.test>',[]).id,'kitchen');
 assert.equal(mealPhoto({title:'Dinner',imageUrl:'https://external.test/private'}).id,'kitchen');
});
test('recipe dietary tags prevent meat or visible cheese images from contradicting the dish',()=>{
 for(const [title,names,tags] of [
  ['Chicken breast',['Plant-based chicken'],['vegan']],
  ['Turkey meatballs',['Mock turkey'],['vegetarian']],
  ['Cheese vegetable sandwich',['Plant-based cheese'],['vegan']],
  ['Feta wrap',['Dairy-free feta'],['dairy-free']],
  ['Cheese quesadilla',['Vegan cheese'],['vegan']],
  ['Cod fillet',['Mock cod'],['vegetarian']],['Beef steak',['Soy steak'],['vegan']],
  ['Pork roast',['Mock pork'],['vegetarian']],['Egg sandwich',['Tofu'],['vegan']],
 ]) assert.equal(mealPhoto({title,ingredients:names.map(name=>({name})),tags}).id,'kitchen',title);
 assert.equal(photo('Chicken with vegetables',['Chicken breast','Vegan whole-wheat bread']).id,'chicken','a vegan side ingredient must not hide real chicken');
 assert.equal(photo('Cod noodles',['Cod','Rice noodles']).id,'kitchen');
 assert.equal(photo('Sardine salad',['Sardines','Beans']).id,'kitchen');
});
test('the public recipe library has broad serving-photo coverage with safe fallbacks',()=>{
 const matched=MEAL_CATALOG.map(recipe=>({recipe,photo:mealPhoto(recipe)}));
 assert.ok(matched.filter(r=>r.photo.id!=='kitchen').length>=68,'at least 68 of 90 reviewed recipes have corresponding serving photos');
 assert.ok(new Set(matched.map(r=>r.photo.id)).size>=33,'discovery should show varied dish families');
 for(const {recipe,photo:p} of matched) if(recipe.tags.includes('vegetarian')) assert.ok(!['salmon','chicken','meatballs','white-fish','beef-vegetables','pork-vegetables','chicken-salad'].includes(p.id),recipe.title);
 for(const title of ['Chicken vegetable minestrone','Chicken peanut noodles with broccoli','Tuna yogurt stuffed potato']) assert.equal(matched.find(r=>r.recipe.title===title).photo.id,'kitchen',title);
});
test('photo uses meaningful alternative text, loads locally and fails gracefully',t=>{
 installDom(t);const p=photo('Berry oatmeal'),figure=mealPhotoFigure(p),img=figure.querySelector('img');
 assert.match(img.getAttribute('alt'),/Illustrative photo/);assert.equal(img.getAttribute('loading'),'lazy');assert.equal(img.getAttribute('src'),p.src);
 assert.equal(img.getAttribute('draggable'),'false','native image dragging must not swallow card swipe gestures');
 assert.equal(text(figure),'Serving idea');assert.equal(mealPhotoCredit(p).querySelector('a').getAttribute('rel'),'noopener noreferrer');
 img.fire('error');assert.equal(figure.querySelector('img'),null);assert.equal(text(figure),'Made in your kitchen');
});
