/**
 * Original starter recipes, one serving each. Prices are rough USD cents for the
 * amount used, not live retailer quotes or the cost of buying full packages.
 * Cooking/allergen guidance checked 2026-09-12:
 * https://www.foodsafety.gov/food-safety-charts/safe-minimum-internal-temperatures
 * https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/eggs/shell-eggs-farm-table
 * https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies
 * Diet tags describe the listed ingredients, not a cross-contact guarantee.
 * Use packaged foods whose labels meet the user's restrictions. Water for
 * boiling/simmering is described in the steps and is not a grocery purchase.
 */
const INGREDIENTS = {
  oats: ['certified gluten-free rolled oats', 50, 'g', 20, 45],
  milk: ['pasteurized low-fat milk', 200, 'ml', 25, 50],
  soyMilk: ['unsweetened soy milk', 200, 'ml', 35, 70],
  yogurt: ['pasteurized plain Greek yogurt', 170, 'g', 65, 135],
  soyYogurt: ['plain unsweetened soy yogurt', 170, 'g', 90, 180],
  cottage: ['pasteurized cottage cheese', 170, 'g', 70, 140],
  ricotta: ['pasteurized ricotta cheese', 90, 'g', 60, 120],
  kefir: ['pasteurized plain kefir', 200, 'ml', 60, 115],
  egg: ['eggs', 2, 'item', 50, 100],
  bread: ['vegan whole-wheat bread', 70, 'g', 35, 75],
  sourdough: ['vegan sourdough bread', 70, 'g', 45, 90],
  wrap: ['vegan whole-wheat tortilla', 65, 'g', 35, 70],
  cornTortilla: ['certified gluten-free corn tortillas', 60, 'g', 25, 60],
  pita: ['vegan whole-wheat pita', 70, 'g', 40, 80],
  pasta: ['whole-wheat pasta', 75, 'g', 25, 60],
  shells: ['jumbo pasta shells', 75, 'g', 35, 75],
  orzo: ['dry orzo pasta', 70, 'g', 30, 65],
  noodles: ['dry vegan wheat noodles', 75, 'g', 35, 80],
  riceNoodles: ['certified gluten-free rice noodles', 75, 'g', 45, 100],
  rice: ['dry long-grain white rice', 65, 'g', 15, 35],
  brownRice: ['dry quick-cooking brown rice', 65, 'g', 30, 60],
  arborio: ['dry arborio rice', 70, 'g', 35, 75],
  quinoa: ['dry quinoa', 60, 'g', 40, 90],
  couscous: ['dry whole-wheat couscous', 65, 'g', 30, 65],
  bulgur: ['dry fine bulgur wheat', 65, 'g', 25, 60],
  barley: ['dry pearl barley', 60, 'g', 25, 55],
  buckwheat: ['certified gluten-free buckwheat flour', 60, 'g', 40, 85],
  cornmeal: ['certified gluten-free fine cornmeal', 45, 'g', 15, 40],
  flour: ['whole-wheat flour', 55, 'g', 15, 35],
  chickpeaFlour: ['chickpea flour', 70, 'g', 35, 80],
  breadcrumbs: ['vegan plain whole-wheat breadcrumbs', 20, 'g', 10, 30],
  baking: ['gluten-free baking powder', 0.5, 'tsp', 2, 5],
  chia: ['chia seeds', 25, 'g', 30, 60],
  walnuts: ['walnuts', 20, 'g', 25, 60],
  almonds: ['almonds', 20, 'g', 25, 55],
  pistachios: ['shelled pistachios', 20, 'g', 40, 85],
  peanuts: ['unsalted peanuts', 20, 'g', 15, 40],
  pumpkinSeeds: ['pumpkin seeds', 20, 'g', 25, 55],
  peanutButter: ['peanut butter made from peanuts', 25, 'g', 15, 35],
  tahini: ['tahini made from sesame seeds', 20, 'g', 25, 50],
  oliveOil: ['olive oil', 2, 'tsp', 10, 25],
  sesameOil: ['sesame oil', 1, 'tsp', 8, 18],
  tamari: ['certified gluten-free tamari soy sauce', 2, 'tsp', 10, 25],
  miso: ['vegan white miso paste', 15, 'g', 20, 40],
  maple: ['pure maple syrup', 1, 'tsp', 10, 25],
  cinnamon: ['ground cinnamon', 0.25, 'tsp', 1, 5],
  cumin: ['ground cumin', 0.5, 'tsp', 2, 6],
  paprika: ['ground paprika', 0.5, 'tsp', 2, 6],
  turmeric: ['ground turmeric', 0.25, 'tsp', 1, 5],
  oregano: ['dried oregano', 0.5, 'tsp', 2, 6],
  pepper: ['ground black pepper', 0.125, 'tsp', 1, 4],
  broth: ['gluten-free vegan low-sodium vegetable broth', 300, 'ml', 25, 60],
  tomatoCan: ['no-salt-added canned crushed tomatoes', 200, 'g', 35, 70],
  tomatoPaste: ['plain tomato paste', 20, 'g', 10, 25],
  coconutMilk: ['unsweetened canned coconut milk', 100, 'ml', 35, 70],
  salsa: ['gluten-free vegan tomato salsa', 60, 'g', 25, 50],
  hummus: ['vegan chickpea and sesame hummus', 60, 'g', 40, 85],
  mustard: ['plain Dijon mustard', 1, 'tsp', 5, 12],
  vinegar: ['apple cider vinegar', 2, 'tsp', 4, 10],
  feta: ['pasteurized vegetarian feta made with microbial rennet', 30, 'g', 40, 85],
  cheddar: ['pasteurized vegetarian cheddar made with microbial rennet', 30, 'g', 30, 65],
  mozzarella: ['pasteurized vegetarian mozzarella made with microbial rennet', 70, 'g', 65, 130],
  goatCheese: ['pasteurized vegetarian goat cheese made with microbial rennet', 30, 'g', 45, 95],
  nutritionalYeast: ['nutritional yeast', 10, 'g', 15, 35],
  chickpeas: ['canned chickpeas, drained and rinsed', 160, 'g', 35, 75],
  blackBeans: ['canned black beans, drained and rinsed', 160, 'g', 35, 75],
  whiteBeans: ['canned white beans, drained and rinsed', 160, 'g', 40, 80],
  kidneyBeans: ['canned kidney beans, drained and rinsed', 160, 'g', 35, 75],
  lentils: ['canned lentils, drained and rinsed', 160, 'g', 40, 85],
  redLentils: ['dry red lentils', 65, 'g', 25, 55],
  tofu: ['plain firm tofu', 170, 'g', 55, 120],
  silkenTofu: ['pasteurized ready-to-eat silken tofu', 170, 'g', 65, 130],
  tempeh: ['plain soy tempeh', 130, 'g', 95, 180],
  edamame: ['frozen shelled edamame', 120, 'g', 60, 130],
  chicken: ['raw boneless skinless chicken breast', 150, 'g', 120, 250],
  turkey: ['raw lean ground turkey', 150, 'g', 120, 250],
  beef: ['raw lean ground beef', 150, 'g', 150, 290],
  steak: ['raw boneless beef sirloin steak', 150, 'g', 230, 420],
  pork: ['raw pork tenderloin', 150, 'g', 120, 240],
  groundPork: ['raw lean ground pork', 150, 'g', 115, 230],
  salmon: ['raw salmon fillet', 150, 'g', 240, 430],
  cod: ['raw cod fillet', 150, 'g', 200, 360],
  trout: ['raw trout fillet', 150, 'g', 230, 410],
  tuna: ['canned light tuna in water, drained', 120, 'g', 95, 200],
  sardines: ['canned sardines in olive oil, drained', 100, 'g', 120, 250],
  potato: ['potato', 220, 'g', 25, 65],
  sweetPotato: ['sweet potato', 220, 'g', 40, 85],
  squash: ['peeled butternut squash', 240, 'g', 65, 135],
  carrot: ['carrot', 100, 'g', 15, 40],
  onion: ['onion', 70, 'g', 12, 35],
  garlic: ['garlic', 5, 'g', 5, 15],
  ginger: ['fresh ginger', 8, 'g', 8, 20],
  spinach: ['fresh spinach', 70, 'g', 35, 80],
  kale: ['fresh kale', 80, 'g', 35, 85],
  broccoli: ['broccoli', 160, 'g', 40, 90],
  cauliflower: ['cauliflower', 180, 'g', 45, 105],
  mushrooms: ['mushrooms', 120, 'g', 50, 110],
  zucchini: ['zucchini', 150, 'g', 35, 80],
  eggplant: ['eggplant', 200, 'g', 50, 110],
  bellPepper: ['bell pepper', 150, 'g', 60, 120],
  greenBeans: ['green beans', 150, 'g', 45, 100],
  asparagus: ['asparagus', 150, 'g', 90, 180],
  cabbage: ['green cabbage', 130, 'g', 20, 50],
  tomato: ['fresh tomato', 130, 'g', 40, 90],
  cherryTomatoes: ['cherry tomatoes', 100, 'g', 55, 110],
  cucumber: ['cucumber', 120, 'g', 25, 60],
  lettuce: ['romaine lettuce', 70, 'g', 30, 65],
  arugula: ['arugula', 50, 'g', 40, 85],
  beet: ['peeled beet', 160, 'g', 40, 90],
  celery: ['celery', 60, 'g', 15, 35],
  corn: ['frozen corn kernels', 80, 'g', 20, 45],
  peas: ['frozen peas', 100, 'g', 25, 55],
  avocado: ['avocado flesh', 80, 'g', 50, 110],
  lemon: ['lemon', 0.5, 'item', 20, 45],
  lime: ['lime', 0.5, 'item', 20, 45],
  parsley: ['fresh parsley', 5, 'g', 10, 25],
  cilantro: ['fresh cilantro', 5, 'g', 10, 25],
  basil: ['fresh basil', 5, 'g', 15, 40],
  dill: ['fresh dill', 5, 'g', 15, 35],
  scallion: ['scallion', 15, 'g', 10, 25],
  blueberries: ['blueberries', 90, 'g', 50, 120],
  strawberries: ['strawberries', 120, 'g', 50, 110],
  cherries: ['frozen pitted cherries', 100, 'g', 60, 120],
  raspberries: ['raspberries', 90, 'g', 70, 150],
  banana: ['banana', 1, 'item', 20, 40],
  apple: ['apple', 1, 'item', 40, 90],
  pear: ['pear', 1, 'item', 50, 100],
  peach: ['peach', 1, 'item', 55, 120],
  orange: ['orange', 1, 'item', 40, 90],
  mango: ['frozen mango pieces', 130, 'g', 60, 120],
  pineapple: ['frozen pineapple pieces', 100, 'g', 45, 95],
  raisins: ['raisins', 20, 'g', 15, 35],
};
const TAGS = { v: 'vegetarian', a: 'vegan', d: 'dairy-free', g: 'gluten-free' };
function recipe(id, title, slot, description, minutes, cuisine, tags, protein, ingredientKeys, steps, reason) {
  const ingredients = ingredientKeys.split(',').map(key => {
    const [code, scaleText] = key.split('*');
    const scale = scaleText ? Number(scaleText) : 1;
    const [name, quantity, unit, low, high] = INGREDIENTS[code];
    return { name, quantity: Math.round(quantity * scale * 1000) / 1000, unit, costLow: Math.round(low * scale), costHigh: Math.round(high * scale) };
  });
  return { id: `catalog_${id}`, title, slot, description, minutes, cuisine, tags: tags.split('').map(t => TAGS[t]), protein, ingredients, steps, reason };
}

export const MEAL_CATALOG = [
  recipe('blueberry_walnut_oatmeal', 'Blueberry walnut oatmeal', 'breakfast', 'Warm creamy oats with fresh berries and crunchy walnuts.', 15, 'American', 'vg', 'dairy',
    'oats,milk,blueberries,walnuts,cinnamon', [
      'Simmer the oats with the milk and 60 ml water in a small saucepan for 7–10 minutes, stirring until tender.',
      'Stir in the cinnamon. Spoon into a bowl and add the washed blueberries and chopped walnuts.'
    ], 'A simple warm breakfast using a short list of familiar ingredients.'),
  recipe('savory_mushroom_oats', 'Savory mushroom and spinach oats', 'breakfast', 'Peppery oats topped with sautéed vegetables and a fully cooked egg.', 25, 'American', 'vdg', 'eggs',
    'oats,egg*0.5,mushrooms,spinach,oliveOil,pepper', [
      'Simmer the oats in 250 ml water for 8–10 minutes until creamy.',
      'Slice the mushrooms and cook in the oil for 6–8 minutes. Add the spinach and stir until wilted.',
      'Move the vegetables to one side, add the egg and cook until the white and yolk are firm. Serve over the oats with pepper.'
    ], 'Savory grains offer a change from sweet breakfast bowls.'),
  recipe('apple_quinoa_porridge', 'Apple cinnamon quinoa porridge', 'breakfast', 'Tender quinoa with warm apple and toasted almonds.', 30, 'American', 'vadg', 'plant',
    'quinoa,soyMilk,apple,almonds,cinnamon', [
      'Rinse the quinoa. Dice the apple and combine both in a saucepan with the soy milk and 120 ml water.',
      'Bring to a gentle simmer, cover and cook for 18–20 minutes until the quinoa is tender; add water if needed.',
      'Rest for 5 minutes. Stir in the cinnamon and finish with chopped almonds.'
    ], 'Quinoa and soy milk provide an alternative to an oat-and-dairy breakfast.'),
  recipe('peach_yogurt_crunch', 'Peach yogurt crunch bowl', 'breakfast', 'Juicy peach, Greek yogurt and quickly toasted oats and seeds.', 15, 'American', 'vg', 'dairy',
    'yogurt,peach,oats*0.5,pumpkinSeeds*0.75,maple', [
      'Toast the oats and pumpkin seeds in a dry pan over medium-low heat for 4–5 minutes, stirring often. Let cool for 3 minutes.',
      'Wash and slice the peach. Add it to the yogurt with the cooled oat mixture and maple syrup.'
    ], 'A cold breakfast with a fresh fruit topping and a crisp homemade crunch.'),
  recipe('tropical_chia_cup', 'Tropical chia breakfast cup', 'breakfast', 'Quick-set chia with mango, pineapple and soy yogurt.', 45, 'Tropical', 'vadg', 'plant',
    'chia,soyMilk*0.75,soyYogurt*0.5,mango*0.75,pineapple*0.5,pumpkinSeeds*0.5', [
      'Whisk the chia seeds with the soy milk. Refrigerate for 30 minutes, stirring after the first 5 minutes so no dry clumps remain.',
      'Thaw the fruit according to its package directions and chop any large pieces.',
      'Stir the soy yogurt into the thickened chia and top with the fruit and pumpkin seeds.'
    ], 'Includes the setting time so the breakfast is ready when the timer says it is.'),
  recipe('strawberry_cottage_toast', 'Strawberry cottage cheese breakfast', 'breakfast', 'Cottage cheese and berries with whole-wheat toast and almonds.', 10, 'American', 'v', 'dairy',
    'cottage,strawberries,bread,almonds*0.5', [
      'Toast the bread. Wash and slice the strawberries.',
      'Spoon the cottage cheese into a bowl, add the strawberries and chopped almonds, and serve with the toast.'
    ], 'A complete breakfast with almost no cooking or cleanup.'),
  recipe('spinach_feta_omelette', 'Spinach feta omelette with toast', 'breakfast', 'A folded omelette filled with wilted spinach and tangy feta.', 20, 'Greek-inspired', 'v', 'eggs',
    'egg,spinach,feta,bread,oliveOil*0.5,pepper', [
      'Heat the oil in a small nonstick pan and wilt the spinach for 2 minutes. Beat the eggs with the pepper.',
      'Add the eggs and cook gently, lifting the edges to let uncooked egg flow underneath. Add the crumbled feta and fold.',
      'Continue cooking until fully set and 160°F (71°C) in the center. Toast the bread and serve alongside.'
    ], 'An easy vegetable-filled breakfast that uses one small pan.'),
  recipe('tomato_bean_shakshuka', 'Tomato and white bean shakshuka', 'breakfast', 'Eggs nestled in a warm tomato, pepper and bean sauce.', 30, 'North African-inspired', 'vd', 'eggs',
    'egg,tomatoCan,whiteBeans*0.5,bellPepper*0.5,onion*0.5,oliveOil,cumin,paprika,pita*0.5', [
      'Dice the onion and pepper. Sauté in the oil for 5 minutes, then stir in cumin, paprika, tomatoes and beans.',
      'Simmer for 8–10 minutes, adding a splash of water if the sauce becomes too thick.',
      'Make two wells, crack in the eggs, cover and cook until both whites and yolks are firm. Warm the pita and serve with the sauce.'
    ], 'Beans and vegetables make this skillet substantial enough for breakfast.'),
  recipe('sweet_potato_breakfast_hash', 'Sweet potato and black bean hash', 'breakfast', 'A colorful pan of sweet potato, beans, peppers and lime.', 30, 'Southwestern-inspired', 'vadg', 'plant',
    'sweetPotato,blackBeans*0.75,bellPepper*0.5,onion*0.5,oliveOil,cumin,lime,cilantro', [
      'Scrub and dice the sweet potato into 1 cm cubes. Microwave covered with 2 tbsp water for 4–5 minutes until almost tender.',
      'Sauté diced onion and pepper in the oil for 5 minutes. Add the sweet potato and cook for 6–8 minutes to brown.',
      'Stir in the beans and cumin and heat through. Finish with lime juice and chopped cilantro.'
    ], 'A filling egg-free breakfast that can also work as a simple lunch.'),
  recipe('tofu_scramble_wrap', 'Tofu scramble breakfast wrap', 'breakfast', 'Warm tofu, spinach and tomato tucked into a whole-wheat tortilla.', 20, 'American', 'vad', 'plant',
    'tofu,wrap,spinach,tomato*0.5,oliveOil,turmeric,nutritionalYeast,salsa*0.5', [
      'Drain and crumble the tofu. Dice the tomato. Heat the oil and cook the tofu with turmeric for 5–6 minutes.',
      'Add tomato and spinach; cook for 3–4 minutes until the spinach wilts. Stir in nutritional yeast.',
      'Warm the tortilla, fill with the scramble and salsa, and fold firmly.'
    ], 'A practical plant-based breakfast that is easy to eat on a busy morning.'),
  recipe('avocado_egg_toast', 'Avocado egg toast with tomatoes', 'breakfast', 'Whole-wheat toast with mashed avocado, a cooked egg and tomato.', 15, 'American', 'vd', 'eggs',
    'bread,avocado,egg*0.5,cherryTomatoes,lemon*0.5,oliveOil*0.5,pepper', [
      'Toast the bread. Mash the avocado with lemon juice and pepper, and halve the washed tomatoes.',
      'Heat the oil in a small pan and fry the egg until the white and yolk are firm.',
      'Spread avocado on the toast, add the egg and serve with the tomatoes.'
    ], 'A familiar breakfast with a fresh vegetable side.'),
  recipe('banana_peanut_french_toast', 'Banana peanut butter French toast', 'breakfast', 'Custardy whole-wheat toast with sliced banana and peanut butter.', 20, 'French-inspired', 'v', 'eggs',
    'bread,egg*0.5,milk*0.25,banana,peanutButter,oliveOil*0.5,cinnamon', [
      'Beat the egg with milk and cinnamon in a shallow bowl. Dip both sides of the bread and let soak briefly.',
      'Cook in the oil over medium-low heat for about 3–4 minutes per side until the center reaches 160°F (71°C).',
      'Spread with peanut butter and top with sliced banana.'
    ], 'Uses ripe fruit and pantry staples for a more leisurely breakfast.'),
  recipe('buckwheat_berry_pancakes', 'Buckwheat berry pancakes', 'breakfast', 'Small buckwheat pancakes served with strawberries and yogurt.', 25, 'American', 'vg', 'eggs',
    'buckwheat,egg*0.5,milk*0.5,baking,strawberries,yogurt*0.5,oliveOil*0.5', [
      'Whisk buckwheat flour and baking powder with the egg and milk to make a spoonable batter.',
      'Heat the oil in a nonstick pan. Cook small pancakes for 2–3 minutes per side until the centers are fully set and reach 160°F (71°C).',
      'Wash and slice the strawberries. Serve the pancakes with yogurt and berries.'
    ], 'Buckwheat changes the flavor and texture from ordinary flour pancakes.'),
  recipe('blueberry_cornmeal_pancakes', 'Blueberry cornmeal pancakes', 'breakfast', 'Golden cornmeal pancakes with berries and a spoonful of yogurt.', 25, 'American', 'v', 'eggs',
    'cornmeal,flour*0.5,egg*0.5,milk*0.5,baking,blueberries,yogurt*0.5,oliveOil*0.5', [
      'Mix cornmeal, flour and baking powder. Whisk in the egg and milk, then fold in half the washed blueberries.',
      'Rest for 5 minutes. Cook small pancakes in the oil over medium-low heat for about 3 minutes per side until fully set and 160°F (71°C) inside.',
      'Serve with the yogurt and remaining blueberries.'
    ], 'A cornmeal batter makes a distinct, lightly textured breakfast.'),
  recipe('mushroom_egg_muffins', 'Mushroom cheddar egg muffins', 'breakfast', 'Mini baked eggs with mushrooms, cheddar and a side of toast.', 40, 'American', 'v', 'eggs',
    'egg,mushrooms*0.75,cheddar,spinach*0.5,milk*0.15,oliveOil*0.5,bread', [
      'Heat the oven to 375°F. Slice the mushrooms and sauté in half the oil for 5–6 minutes; add spinach to wilt.',
      'Beat the eggs with milk and grated cheddar. Mix in the vegetables and divide among two greased muffin wells.',
      'Bake for 18–22 minutes until the centers reach 160°F (71°C). Rest for 3 minutes and serve with toast.'
    ], 'Small baked portions are useful when you want a breakfast that holds its shape.'),
  recipe('turkey_potato_breakfast_pan', 'Turkey and potato breakfast pan', 'breakfast', 'Ground turkey browned with potatoes, peppers and paprika.', 30, 'American', 'dg', 'turkey',
    'turkey*0.75,potato,bellPepper*0.5,onion*0.5,oliveOil,paprika,spinach*0.5', [
      'Dice the potato into small cubes. Microwave covered with 2 tbsp water for 4–5 minutes until nearly tender.',
      'Heat the oil and sauté diced onion and pepper for 4 minutes. Add turkey, breaking it into small pieces.',
      'Add potatoes and paprika; cook until browned and the turkey reaches 165°F (74°C). Stir in the spinach until wilted.'
    ], 'A savory breakfast using the same basic ingredients as an easy dinner skillet.'),
  recipe('salmon_spinach_breakfast_rice', 'Salmon and spinach breakfast rice', 'breakfast', 'Flaked cooked salmon over warm rice with spinach and lemon.', 35, 'Japanese-inspired', 'dg', 'fish',
    'rice,salmon*0.75,spinach,oliveOil,lemon,scallion', [
      'Rinse and cook the rice in water according to the packet, allowing 15–20 minutes plus its resting time.',
      'Heat the oil in a pan and cook the salmon for about 4–5 minutes per side until it reaches 145°F (63°C). Transfer to a clean plate.',
      'Wilt the spinach in the same pan, flake the salmon and serve over rice with lemon juice and sliced scallion.'
    ], 'A cooked fish-and-rice breakfast for mornings when sweet foods do not appeal.'),
  recipe('pear_almond_muesli', 'Pear and almond muesli', 'breakfast', 'Softened oats with yogurt, grated pear and crunchy almonds.', 30, 'Swiss-inspired', 'vg', 'dairy',
    'oats,yogurt,milk*0.25,pear,almonds,cinnamon', [
      'Combine the oats, yogurt and milk. Refrigerate for 20 minutes to soften the oats.',
      'Wash and grate half the pear, then slice the rest. Stir the grated pear and cinnamon into the muesli.',
      'Top with the pear slices and chopped almonds.'
    ], 'A cool breakfast with a realistic short soaking time.'),
  recipe('cherry_pistachio_couscous', 'Cherry pistachio breakfast couscous', 'breakfast', 'Warm milk couscous with cherries and chopped pistachios.', 15, 'Mediterranean-inspired', 'v', 'dairy',
    'couscous,milk,cherries,pistachios,cinnamon', [
      'Heat the milk and cherries in a small saucepan until steaming and the cherries are hot through.',
      'Stir in the couscous, cover, remove from heat and stand for 7 minutes or as directed on the packet.',
      'Fluff with a fork and finish with cinnamon and chopped pistachios.'
    ], 'Couscous offers a fast change from the usual breakfast grains.'),
  recipe('bean_breakfast_quesadilla', 'Black bean breakfast quesadilla', 'breakfast', 'A crisp tortilla filled with black beans, cheddar and salsa.', 20, 'Mexican-inspired', 'v', 'plant',
    'wrap,blackBeans*0.75,cheddar,salsa,avocado*0.5,lime*0.5', [
      'Mash the beans with half the salsa and heat in a pan until hot throughout.',
      'Spread on half the tortilla, add grated cheddar and fold. Toast in a dry skillet for 2–3 minutes per side until the cheese melts.',
      'Serve with the avocado, remaining salsa and a squeeze of lime.'
    ], 'Uses canned beans for a quick, substantial meat-free breakfast.'),
  recipe('carrot_raisin_oats', 'Carrot raisin breakfast oats', 'breakfast', 'Warm oats with grated carrot, raisins, cinnamon and walnuts.', 20, 'American', 'vadg', 'plant',
    'oats,soyMilk,carrot*0.6,raisins,walnuts,cinnamon', [
      'Peel and finely grate the carrot. Combine with oats, soy milk, raisins and 80 ml water.',
      'Simmer gently for 10–12 minutes, stirring, until the carrot and oats are tender.',
      'Stir in the cinnamon and finish with chopped walnuts.'
    ], 'Grated carrot adds texture and variety to a pantry-friendly breakfast.'),
  recipe('broccoli_potato_frittata', 'Broccoli potato frittata', 'breakfast', 'Tender potatoes and broccoli set in a small skillet of eggs.', 35, 'Italian-inspired', 'vdg', 'eggs',
    'egg,potato*0.75,broccoli*0.75,onion*0.5,oliveOil,pepper', [
      'Slice the potato thinly. Microwave covered with 2 tbsp water for 5 minutes; add small broccoli florets and microwave another 2 minutes.',
      'Sauté sliced onion in the oil for 4 minutes in a small pan. Add the drained vegetables and beaten eggs with pepper.',
      'Cover and cook gently for 10–12 minutes until fully set and 160°F (71°C) in the center.'
    ], 'A one-pan breakfast built around vegetables and eggs.'),
  recipe('chickpea_breakfast_pancake', 'Savory chickpea breakfast pancake', 'breakfast', 'A crisp chickpea-flour pancake with tomato and spinach.', 25, 'South Asian-inspired', 'vadg', 'plant',
    'chickpeaFlour,tomato*0.75,spinach*0.75,onion*0.5,oliveOil,cumin,soyYogurt*0.5', [
      'Whisk chickpea flour with cumin and 110 ml water to make a pourable batter. Rest for 5 minutes.',
      'Finely chop the onion, tomato and spinach and fold into the batter.',
      'Heat the oil in a nonstick pan. Spread into two thin pancakes and cook for 4–5 minutes per side until set throughout. Serve with soy yogurt.'
    ], 'Chickpea flour creates a savory breakfast without eggs or dairy.'),
  recipe('egg_cucumber_rice_bowl', 'Egg cucumber breakfast rice bowl', 'breakfast', 'Rice with cooked egg ribbons, cucumber and sesame dressing.', 30, 'Japanese-inspired', 'vdg', 'eggs',
    'rice,egg,cucumber,carrot*0.5,sesameOil,tamari,scallion', [
      'Cook the rice in water according to the packet. Slice the cucumber and grate the carrot while it cooks.',
      'Beat the eggs. Heat half the sesame oil in a nonstick pan and cook a thin omelette until fully set and 160°F (71°C); cut into ribbons.',
      'Top the rice with egg, cucumber, carrot and scallion. Drizzle with tamari and the remaining sesame oil.'
    ], 'Fresh vegetables and egg ribbons add contrast to a warm rice breakfast.'),
  recipe('mango_kefir_breakfast', 'Mango kefir smoothie and almond toast', 'breakfast', 'A creamy fruit smoothie with a simple crunchy toast side.', 10, 'American', 'v', 'dairy',
    'kefir,mango,banana*0.5,bread,almonds', [
      'Blend the kefir, mango and peeled banana until smooth, adding a little water if needed.',
      'Toast the bread. Serve it with the smoothie and almonds on the side.'
    ], 'Pairs a quick smoothie with solid food for a complete breakfast.'),
  recipe('berry_tofu_smoothie_toast', 'Berry tofu smoothie with peanut toast', 'breakfast', 'A berry and silken tofu smoothie alongside peanut butter toast.', 10, 'American', 'vad', 'plant',
    'silkenTofu,soyMilk*0.5,blueberries,banana*0.5,bread,peanutButter*0.75', [
      'Wash the berries. Blend with the ready-to-eat silken tofu, soy milk and peeled banana until smooth.',
      'Toast the bread and spread it with peanut butter. Serve alongside the smoothie.'
    ], 'Silken tofu makes a smooth breakfast drink without dairy.'),
  recipe('banana_baked_oat_cake', 'Banana baked oat breakfast cake', 'breakfast', 'A small warm oat cake with banana, cinnamon and yogurt.', 45, 'American', 'vg', 'eggs',
    'oats,banana,egg*0.5,milk*0.4,baking,cinnamon,yogurt*0.5,oliveOil*0.25', [
      'Heat the oven to 375°F. Grease a small ovenproof dish with the oil.',
      'Mash the banana, beat in the egg and milk, then stir in the oats, baking powder and cinnamon.',
      'Bake for 25–30 minutes until the center is set and reaches 160°F (71°C). Cool for 5 minutes and serve with yogurt.'
    ], 'A single-serving baked breakfast with the full baking time included.'),
  recipe('citrus_ricotta_toast', 'Citrus ricotta toast', 'breakfast', 'Creamy ricotta toast topped with orange and pistachios.', 15, 'Italian-inspired', 'v', 'dairy',
    'sourdough,ricotta,orange,pistachios*0.75,maple', [
      'Toast the bread. Peel the orange and cut the flesh into bite-sized pieces, removing seeds.',
      'Spread the ricotta over the toast and add orange pieces, chopped pistachios and maple syrup.'
    ], 'A fresh alternative to jam or sweetened cereal.'),
  recipe('homemade_seed_granola', 'Warm seed granola yogurt bowl', 'breakfast', 'Quick baked oat and seed clusters with yogurt and raspberries.', 35, 'American', 'vg', 'dairy',
    'oats,pumpkinSeeds,almonds*0.5,maple*2,oliveOil*0.5,yogurt,raspberries', [
      'Heat the oven to 325°F. Mix oats, seeds, chopped almonds, maple syrup and oil on a small lined tray.',
      'Bake for 15–18 minutes, stirring once, until lightly golden. Cool for 8 minutes so it crisps.',
      'Serve over yogurt with washed raspberries.'
    ], 'Making a small amount of granola keeps the ingredients and sweetness easy to choose.'),
  recipe('white_bean_tomato_toast', 'White bean tomato breakfast toast', 'breakfast', 'Warm garlicky white beans and tomatoes on toasted sourdough.', 20, 'Mediterranean-inspired', 'vad', 'plant',
    'whiteBeans,sourdough,cherryTomatoes,garlic,oliveOil,basil,lemon*0.5', [
      'Halve the tomatoes and mince the garlic. Cook in the oil for 4–5 minutes until the tomatoes soften.',
      'Add beans and 2 tbsp water. Simmer for 5 minutes, mashing a few beans to thicken.',
      'Toast the bread and spoon over the beans. Finish with basil and lemon juice.'
    ], 'An inexpensive savory breakfast built from beans and a few fresh ingredients.'),
  recipe('chickpea_cucumber_pita', 'Chickpea cucumber pita', 'lunch', 'Lemon-dressed chickpeas, cucumber and tomato tucked into warm pita.', 15, 'Mediterranean-inspired', 'vad', 'plant',
    'chickpeas,pita,cucumber,tomato*0.75,tahini*0.75,lemon,parsley', [
      'Rinse and drain the chickpeas. Dice the washed cucumber and tomato and chop the parsley.',
      'Whisk tahini with lemon juice and 1–2 tbsp water. Toss with the chickpeas and vegetables.',
      'Warm the pita, split and fill with the salad.'
    ], 'A quick lunch that needs chopping and assembly rather than a long cooking session.'),
  recipe('lemon_red_lentil_soup', 'Lemon red lentil soup', 'lunch', 'A thick lentil soup with carrots, cumin and bright lemon.', 35, 'Turkish-inspired', 'vad', 'plant',
    'redLentils,carrot,onion,garlic,broth,oliveOil,cumin,lemon,pita*0.5', [
      'Dice onion and carrot and mince garlic. Sauté in the oil for 5 minutes, then stir in cumin.',
      'Rinse the lentils and add with broth and 150 ml water. Simmer for 20–25 minutes until the lentils are soft.',
      'Mash or briefly blend part of the soup, add lemon juice and serve with warmed pita.'
    ], 'Dry lentils and vegetables make an affordable soup without a long soaking step.'),
  recipe('roasted_vegetable_quinoa', 'Roasted vegetable quinoa bowl', 'lunch', 'Quinoa with roasted zucchini, peppers and chickpeas in tahini dressing.', 40, 'Mediterranean-inspired', 'vadg', 'plant',
    'quinoa,zucchini,bellPepper*0.5,chickpeas*0.75,oliveOil,tahini*0.75,lemon,parsley', [
      'Heat the oven to 425°F. Dice the zucchini and pepper and toss with chickpeas and oil on a tray.',
      'Roast for 20–25 minutes, turning once. Meanwhile rinse and cook the quinoa in water according to its packet.',
      'Whisk tahini with lemon juice and 2 tbsp water. Assemble the quinoa and vegetables, then add dressing and parsley.'
    ], 'Roasted vegetables add variety while quinoa and chickpeas make a substantial base.'),
  recipe('chicken_avocado_wrap', 'Chicken avocado crunch wrap', 'lunch', 'Freshly cooked chicken, avocado and crisp vegetables in a tortilla.', 30, 'American', 'd', 'chicken',
    'chicken,wrap,avocado*0.75,lettuce,tomato*0.5,oliveOil,lemon,pepper', [
      'Heat the oil in a pan. Cook the chicken for approximately 6–8 minutes per side until a thermometer reads 165°F (74°C). Rest on a clean board.',
      'Slice the tomato and lettuce. Mash avocado with lemon juice and pepper.',
      'Slice the chicken, spread avocado over a warm tortilla and add chicken and vegetables. Fold to enclose.'
    ], 'A portable lunch with freshly cooked chicken and a simple avocado spread.'),
  recipe('tuna_white_bean_salad', 'Tuna and white bean salad', 'lunch', 'A substantial salad of tuna, white beans, cucumber and herbs.', 15, 'Italian-inspired', 'dg', 'fish',
    'tuna,whiteBeans*0.75,cucumber,tomato*0.75,arugula,oliveOil,lemon,parsley', [
      'Drain the tuna and rinse the beans. Wash and chop the cucumber, tomato, arugula and parsley.',
      'Whisk the oil with lemon juice. Gently toss everything together, keeping the tuna in bite-sized flakes.',
      'Serve immediately or refrigerate promptly until lunch.'
    ], 'Canned fish and beans make a no-cook lunch with few utensils.'),
  recipe('turkey_apple_melt', 'Turkey apple cheddar melt', 'lunch', 'A cooked turkey patty with apple, cheddar and whole-wheat toast.', 30, 'American', '', 'turkey',
    'turkey,bread,apple*0.5,cheddar,lettuce,oliveOil*0.5,mustard,pepper', [
      'Mix the turkey with pepper and form a thin patty. Cook in the oil for about 5–6 minutes per side until it reaches 165°F (74°C).',
      'Add cheddar to the patty, cover briefly to melt, and toast the bread.',
      'Spread bread with mustard. Add the patty, thin apple slices and lettuce; serve extra apple alongside.'
    ], 'A warm sandwich with a crisp fruit contrast.'),
  recipe('sweet_potato_bean_tacos', 'Sweet potato black bean tacos', 'lunch', 'Roasted sweet potato and beans in corn tortillas with lime slaw.', 40, 'Mexican-inspired', 'vadg', 'plant',
    'sweetPotato*0.75,blackBeans*0.75,cornTortilla,cabbage*0.5,oliveOil,cumin,lime,salsa', [
      'Heat the oven to 425°F. Dice the sweet potato into 1 cm cubes, toss with oil and cumin and roast for 20–25 minutes.',
      'Warm the beans in a saucepan with 2 tbsp water. Toss shredded cabbage with lime juice.',
      'Warm the tortillas and fill with sweet potato, beans, cabbage and salsa.'
    ], 'A vegetable-and-bean taco filling using common grocery staples.'),
  recipe('ginger_tofu_rice_bowl', 'Ginger tofu rice bowl', 'lunch', 'Golden tofu over rice with cucumber, carrots and ginger sauce.', 35, 'East Asian-inspired', 'vadg', 'plant',
    'tofu,rice,cucumber,carrot*0.75,ginger,tamari,sesameOil,oliveOil*0.5,scallion', [
      'Cook the rice in water according to the packet. Pat the tofu dry and cut into cubes.',
      'Brown tofu in olive oil for 8–10 minutes, turning. Add grated ginger, tamari and 2 tbsp water and simmer for 2 minutes.',
      'Slice cucumber and grate carrot. Serve tofu and vegetables over rice with sesame oil and scallion.'
    ], 'A flexible rice bowl with both warm and crunchy ingredients.'),
  recipe('caprese_pasta_salad', 'Caprese pasta salad', 'lunch', 'Whole-wheat pasta tossed with tomatoes, mozzarella and basil.', 25, 'Italian-inspired', 'v', 'dairy',
    'pasta,mozzarella,cherryTomatoes,basil,oliveOil,lemon*0.5,arugula*0.5', [
      'Cook pasta in boiling water according to the packet. Drain and rinse briefly under cool water.',
      'Wash and halve tomatoes, tear basil and chop mozzarella into bite-sized pieces.',
      'Toss pasta, cheese, tomatoes and arugula with oil and lemon juice. Serve or refrigerate promptly.'
    ], 'A familiar pasta salad with a short ingredient list.'),
  recipe('yogurt_egg_salad_sandwich', 'Yogurt egg salad sandwich', 'lunch', 'Chopped cooked eggs with yogurt, mustard and crunchy celery.', 30, 'American', 'v', 'eggs',
    'egg,bread,yogurt*0.3,celery*0.5,mustard,lettuce,tomato*0.5,pepper', [
      'Cover the eggs with water, bring to a boil, cover and turn off the heat. Stand for 12 minutes, then cool in cold water; the whites and yolks must be firm.',
      'Peel and chop eggs. Mix with finely diced celery, yogurt, mustard and pepper.',
      'Fill the bread with egg salad, washed lettuce and sliced tomato. Keep refrigerated if not eating immediately.'
    ], 'A creamy sandwich made from cooked eggs and plain yogurt.'),
  recipe('roasted_pepper_white_bean_soup', 'Roasted pepper white bean soup', 'lunch', 'A smooth roasted pepper and bean soup with toasted bread.', 45, 'Mediterranean-inspired', 'vad', 'plant',
    'bellPepper,whiteBeans,onion*0.5,garlic,broth,oliveOil,paprika,sourdough*0.75', [
      'Heat the oven to 425°F. Cut the pepper into strips and toss with half the oil. Roast for 25 minutes until soft and browned.',
      'Sauté chopped onion and garlic in the remaining oil for 5 minutes. Add beans, broth, paprika and roasted pepper; simmer for 8 minutes.',
      'Blend with an immersion blender, adding water to loosen if needed. Serve with toasted sourdough.'
    ], 'White beans create a creamy soup without dairy.'),
  recipe('salmon_couscous_salad', 'Salmon lemon couscous salad', 'lunch', 'Cooked salmon with couscous, cucumber, tomato and parsley.', 30, 'Mediterranean-inspired', 'd', 'fish',
    'salmon,couscous,cucumber*0.75,tomato*0.75,lemon,oliveOil,parsley', [
      'Cook the couscous with boiling water according to the packet, then fluff and spread in a bowl.',
      'Cook the salmon in half the oil for 4–5 minutes per side until it reaches 145°F (63°C). Rest briefly and flake.',
      'Chop cucumber, tomato and parsley. Toss with couscous, salmon, lemon juice and the remaining oil; eat warm or refrigerate promptly.'
    ], 'Combines a quick grain with cooked fish and fresh vegetables.'),
  recipe('beef_broccoli_lunch_bowl', 'Beef broccoli rice bowl', 'lunch', 'Sliced sirloin and broccoli over rice with a ginger-tamari finish.', 35, 'Chinese-inspired', 'dg', 'beef',
    'steak,rice,broccoli,ginger,garlic,tamari,oliveOil,sesameOil*0.5', [
      'Cook rice according to the packet. Cut broccoli into small florets and steam for 4–5 minutes.',
      'Cook the steak in the olive oil, turning, until its center reaches 145°F (63°C). Rest on a clean board for at least 3 minutes, then slice.',
      'Add minced garlic, ginger, tamari and 2 tbsp water to the pan. Simmer briefly, toss in broccoli and beef, and serve over rice with sesame oil.'
    ], 'A straightforward steak-and-vegetable lunch with a measured sauce.'),
  recipe('pork_cabbage_wrap', 'Pork and cabbage warm wrap', 'lunch', 'Tender pork with sautéed cabbage and mustard in a whole-wheat tortilla.', 30, 'European-inspired', 'd', 'pork',
    'pork,wrap,cabbage,carrot*0.5,oliveOil,mustard,vinegar,pepper', [
      'Heat half the oil and cook the pork until its center reaches 145°F (63°C). Rest on a clean board for at least 3 minutes.',
      'Shred cabbage and carrot. Sauté in the remaining oil for 5–7 minutes, then stir in vinegar and pepper.',
      'Slice the pork. Spread the warm tortilla with mustard and fill with pork and vegetables.'
    ], 'A warm wrap that uses cabbage for an inexpensive vegetable filling.'),
  recipe('edamame_noodle_crunch', 'Edamame noodle crunch bowl', 'lunch', 'Rice noodles and edamame with crunchy vegetables and sesame-lime dressing.', 25, 'East Asian-inspired', 'vadg', 'plant',
    'riceNoodles,edamame,cabbage*0.5,carrot*0.75,cucumber*0.75,tamari,sesameOil,lime,peanuts*0.5', [
      'Cook rice noodles according to the packet, then rinse under cool water and drain well.',
      'Cook edamame according to the packet until hot throughout. Cool briefly and combine with shredded cabbage, grated carrot and sliced cucumber.',
      'Whisk tamari, sesame oil and lime juice. Toss with noodles and vegetables and top with chopped peanuts.'
    ], 'A colorful noodle lunch that can be served cool.'),
  recipe('baked_falafel_couscous', 'Baked chickpea patties with couscous', 'lunch', 'Herby baked chickpea patties with couscous and cucumber tahini salad.', 45, 'Middle Eastern-inspired', 'vad', 'plant',
    'chickpeas,couscous,breadcrumbs,onion*0.5,garlic,parsley,cumin,oliveOil,cucumber,tahini*0.75,lemon', [
      'Heat the oven to 400°F. Mash well-drained chickpeas with finely chopped onion, garlic, parsley, cumin and breadcrumbs; add a teaspoon of water only if too dry.',
      'Shape into four small patties, brush with oil and bake on a lined tray for 20–25 minutes, turning once.',
      'Prepare couscous according to its packet. Whisk tahini with lemon juice and water, toss with chopped cucumber, and serve with patties and couscous.'
    ], 'A baked chickpea patty meal without deep frying or an overnight soaking requirement.'),
  recipe('mushroom_barley_soup', 'Mushroom barley soup', 'lunch', 'Pearl barley simmered with mushrooms, carrots and white beans.', 55, 'European-inspired', 'vad', 'plant',
    'barley,mushrooms,carrot,onion*0.5,whiteBeans*0.5,broth,oliveOil,garlic,parsley', [
      'Dice onion and carrot, slice mushrooms and mince garlic. Sauté in oil for 7–8 minutes.',
      'Add rinsed barley, broth and 200 ml water. Simmer partly covered for 30–40 minutes until barley is tender, adding water as needed.',
      'Stir in beans and simmer for 5 minutes. Finish with chopped parsley.'
    ], 'A hearty soup with the full barley cooking time included.'),
  recipe('curried_chickpea_rice', 'Curried chickpea rice bowl', 'lunch', 'Chickpeas and spinach in a tomato-coconut sauce over rice.', 30, 'South Asian-inspired', 'vadg', 'plant',
    'chickpeas,rice,tomatoCan*0.75,coconutMilk*0.5,spinach,onion*0.5,garlic,ginger,oliveOil,cumin,turmeric', [
      'Cook the rice in water according to the packet. Dice onion and mince garlic and ginger.',
      'Sauté onion in oil for 4 minutes. Add garlic, ginger, cumin and turmeric for 1 minute.',
      'Add tomatoes, chickpeas and coconut milk and simmer for 12–15 minutes. Wilt in spinach and serve with rice.'
    ], 'A pantry-based plant meal with a warm, gently spiced sauce.'),
  recipe('corn_black_bean_quinoa_salad', 'Corn black bean quinoa salad', 'lunch', 'Quinoa, corn and black beans with tomato, avocado and lime.', 30, 'Southwestern-inspired', 'vadg', 'plant',
    'quinoa,blackBeans*0.75,corn,tomato*0.75,avocado*0.5,lime,oliveOil,cilantro,cumin', [
      'Rinse and cook the quinoa according to its packet. Cook the corn until hot through according to its packet.',
      'Dice tomato and avocado and chop cilantro. Rinse the beans.',
      'Toss quinoa, corn, beans and vegetables with lime juice, oil and cumin. Serve warm or refrigerate promptly.'
    ], 'A grain-and-bean salad suited to a packed lunch.'),
  recipe('spinach_potato_quesadilla', 'Spinach potato quesadilla', 'lunch', 'A crisp tortilla filled with tender potatoes, spinach and cheddar.', 30, 'Mexican-inspired', 'v', 'dairy',
    'wrap,potato*0.75,spinach,cheddar,salsa,oliveOil*0.5,cumin', [
      'Dice the potato small and microwave covered with 2 tbsp water for 5–6 minutes until tender; drain.',
      'Heat oil in a pan, add potatoes and cumin and cook for 3 minutes. Add spinach and stir until wilted.',
      'Place the filling and grated cheese on half the tortilla, fold and toast in a dry skillet for 2–3 minutes per side. Serve with salsa.'
    ], 'A warm vegetarian lunch with a crisp exterior and a soft vegetable filling.'),
  recipe('chicken_minestrone', 'Chicken vegetable minestrone', 'lunch', 'A tomato broth soup with chicken, white beans, pasta and vegetables.', 40, 'Italian-inspired', 'd', 'chicken',
    'chicken*0.75,pasta*0.5,whiteBeans*0.5,carrot,celery,onion*0.5,zucchini*0.5,tomatoCan*0.75,broth,oliveOil,oregano', [
      'Dice onion, carrot, celery and zucchini. Sauté in the oil for 6 minutes.',
      'Cut the chicken into small pieces on a separate board. Add with tomatoes, broth and 200 ml water and simmer for 10 minutes.',
      'Add pasta and beans and simmer until the pasta is tender and chicken reaches 165°F (74°C), about 10–12 minutes. Stir in oregano.'
    ], 'A complete soup using small portions of chicken, beans and pasta.'),
  recipe('tomato_mozzarella_panini', 'Tomato mozzarella panini', 'lunch', 'A toasted mozzarella sandwich with basil and a white bean side.', 20, 'Italian-inspired', 'v', 'dairy',
    'sourdough,mozzarella,tomato,basil,oliveOil*0.5,whiteBeans*0.75,lemon*0.5,arugula', [
      'Slice tomato and mozzarella. Layer with basil between the bread slices and brush the outside with oil.',
      'Toast in a covered skillet over medium-low heat for 3–4 minutes per side until the cheese melts.',
      'Toss beans and washed arugula with lemon juice. Serve beside the sandwich.'
    ], 'A warm sandwich paired with beans and greens instead of a snack-only side.'),
  recipe('tempeh_peanut_noodles', 'Tempeh peanut noodle salad', 'lunch', 'Golden tempeh, noodles and crisp vegetables in a peanut-lime dressing.', 30, 'Southeast Asian-inspired', 'vad', 'plant',
    'tempeh,noodles,cabbage*0.5,carrot*0.75,peanutButter,lime,tamari,oliveOil,ginger', [
      'Cook noodles according to the packet and drain. Simmer sliced tempeh in water for 10 minutes, then drain.',
      'Brown tempeh in the oil for 5–6 minutes. Grate carrot, shred cabbage and finely grate ginger.',
      'Whisk peanut butter, tamari, lime juice and ginger with 2–3 tbsp warm water. Toss with noodles, vegetables and tempeh.'
    ], 'A plant-based noodle dish with a rich dressing made from pantry ingredients.'),
  recipe('tuna_stuffed_potato', 'Tuna yogurt stuffed potato', 'lunch', 'A tender baked potato filled with tuna, yogurt and scallion.', 25, 'British-inspired', 'g', 'fish',
    'potato*1.25,tuna,yogurt*0.4,scallion,lemon*0.5,cucumber,pepper', [
      'Scrub and pierce the potato. Microwave for 8–12 minutes, turning halfway, until tender throughout; rest for 3 minutes.',
      'Drain tuna and mix with yogurt, sliced scallion, lemon juice and pepper.',
      'Split the potato, fluff the flesh with a fork and spoon in the tuna mixture. Serve with sliced cucumber.'
    ], 'A quick stuffed potato using canned tuna and plain yogurt.'),
  recipe('roast_cauliflower_chickpea_wrap', 'Roasted cauliflower chickpea wrap', 'lunch', 'Spiced roasted cauliflower and chickpeas with creamy tahini in a wrap.', 40, 'Middle Eastern-inspired', 'vad', 'plant',
    'cauliflower,chickpeas*0.75,wrap,lettuce,oliveOil,cumin,paprika,tahini*0.75,lemon', [
      'Heat the oven to 425°F. Cut cauliflower into small florets and toss with chickpeas, oil, cumin and paprika.',
      'Roast for 25 minutes, turning once, until the cauliflower is tender and browned.',
      'Whisk tahini with lemon juice and 1–2 tbsp water. Fill a warm tortilla with lettuce, roasted vegetables and dressing.'
    ], 'Roasting gives a meat-free wrap a warm, substantial filling.'),
  recipe('greek_chicken_orzo', 'Greek chicken orzo lunch bowl', 'lunch', 'Lemony chicken and orzo with cucumber, tomato and feta.', 35, 'Greek-inspired', '', 'chicken',
    'chicken,orzo,cucumber*0.75,tomato*0.75,feta,lemon,oliveOil,oregano,parsley', [
      'Cook orzo in boiling water according to the packet and drain.',
      'Season chicken with oregano. Cook in half the oil until it reaches 165°F (74°C), then rest on a clean board and slice.',
      'Toss orzo with chopped cucumber, tomato, parsley, lemon juice and remaining oil. Top with chicken and crumbled feta.'
    ], 'Combines warm chicken with a fresh pasta salad base.'),
  recipe('beet_goat_cheese_lentils', 'Roasted beet goat cheese lentils', 'lunch', 'Earthy roasted beets and lentils with arugula and goat cheese.', 45, 'European-inspired', 'vg', 'plant',
    'beet,lentils,goatCheese,arugula,walnuts*0.5,oliveOil,vinegar,mustard', [
      'Heat the oven to 425°F. Cut the beet into small wedges, toss with half the oil and roast for 30–35 minutes until tender.',
      'Whisk remaining oil with vinegar and mustard. Rinse lentils and toss with dressing and washed arugula.',
      'Add warm beets and finish with crumbled goat cheese and chopped walnuts.'
    ], 'Roasted root vegetables bring variety to a lentil-based lunch.'),
  recipe('lemon_sardine_toast', 'Lemon sardine toast with greens', 'lunch', 'Canned sardines on tomato toast with a lemony cucumber salad.', 15, 'Mediterranean-inspired', 'd', 'fish',
    'sardines,sourdough,tomato,arugula,cucumber*0.75,lemon,oliveOil*0.5,parsley', [
      'Toast the bread and slice the tomato. Drain sardines and break into large pieces.',
      'Toss washed arugula and sliced cucumber with oil and half the lemon juice.',
      'Top toast with tomato and sardines, then add parsley and remaining lemon juice. Serve with the salad.'
    ], 'Canned sardines make a fast fish lunch with no raw-fish preparation.'),
  recipe('cabbage_egg_fried_rice', 'Cabbage and egg rice skillet', 'lunch', 'Freshly cooked rice tossed with cabbage, peas and cooked egg.', 35, 'Chinese-inspired', 'vdg', 'eggs',
    'rice,egg,cabbage,peas*0.75,carrot*0.5,tamari,sesameOil,oliveOil,scallion', [
      'Cook rice in water according to the packet. Spread on a clean plate to release steam while preparing the vegetables; do not leave it at room temperature for more than 2 hours.',
      'Stir-fry shredded cabbage, grated carrot and peas in olive oil for 5–6 minutes.',
      'Push vegetables aside, add beaten eggs and scramble until fully set and 160°F (71°C). Add rice, tamari and sesame oil and toss until steaming hot; finish with scallion.'
    ], 'Uses freshly cooked rice, so the stated time does not depend on having leftovers.'),
  recipe('butternut_lentil_soup', 'Butternut squash red lentil soup', 'lunch', 'Creamy squash and lentil soup with ginger and a crisp toast side.', 40, 'American', 'vad', 'plant',
    'squash,redLentils*0.75,onion*0.5,ginger,broth,oliveOil,cumin,sourdough*0.75,pumpkinSeeds*0.5', [
      'Dice squash and onion and mince ginger. Sauté onion in oil for 4 minutes, then add ginger and cumin.',
      'Add squash, rinsed lentils, broth and 150 ml water. Simmer for 20–25 minutes until completely tender.',
      'Blend with an immersion blender, adjusting with water. Top with pumpkin seeds and serve with toast.'
    ], 'Squash and lentils create a creamy soup without cream.'),
  recipe('lemon_salmon_potatoes', 'Lemon salmon with potatoes and green beans', 'dinner', 'A baked salmon plate with crisp-edged potatoes and tender green beans.', 45, 'Mediterranean-inspired', 'dg', 'fish',
    'salmon,potato,greenBeans,oliveOil,lemon,dill,pepper', [
      'Heat the oven to 425°F. Cut potatoes into small wedges, toss with half the oil and roast on a tray for 20 minutes.',
      'Add the salmon and green beans, brush with remaining oil and add pepper and lemon slices.',
      'Bake for 12–15 minutes more until salmon reaches 145°F (63°C) and potatoes are tender. Finish with chopped dill.'
    ], 'A complete fish dinner using one oven tray.'),
  recipe('chicken_broccoli_sheet_pan', 'Paprika chicken and broccoli couscous', 'dinner', 'Oven-roasted chicken and broccoli with fluffy couscous.', 40, 'Mediterranean-inspired', 'd', 'chicken',
    'chicken,broccoli,carrot*0.75,couscous,oliveOil,paprika,garlic,lemon', [
      'Heat the oven to 425°F. Cut carrot into thin sticks and broccoli into florets. Toss with half the oil on a tray.',
      'Coat chicken with the remaining oil, paprika and minced garlic. Add to the tray and roast for 22–28 minutes until chicken reaches 165°F (74°C).',
      'Prepare couscous with boiling water according to the packet. Serve with chicken, vegetables and lemon juice.'
    ], 'Roasted chicken and vegetables can cook while the couscous steeps.'),
  recipe('black_bean_chili_rice', 'Black bean vegetable chili with rice', 'dinner', 'A smoky bean chili with peppers, tomatoes and corn.', 40, 'Southwestern-inspired', 'vadg', 'plant',
    'blackBeans,kidneyBeans*0.5,rice*0.75,tomatoCan,bellPepper*0.75,onion*0.5,corn*0.5,oliveOil,cumin,paprika,lime', [
      'Cook the rice in water according to the packet. Dice onion and pepper.',
      'Sauté onion and pepper in oil for 6 minutes, then stir in cumin and paprika.',
      'Add tomatoes, beans, corn and 100 ml water. Simmer for 20 minutes, stirring occasionally. Finish with lime and serve over rice.'
    ], 'A bean-based dinner that relies mostly on canned and frozen staples.'),
  recipe('turkey_meatballs_pasta', 'Turkey meatballs with tomato pasta', 'dinner', 'Baked turkey meatballs in a simple tomato sauce with whole-wheat pasta.', 45, 'Italian-inspired', 'd', 'turkey',
    'turkey,pasta,breadcrumbs,tomatoCan,garlic,onion*0.5,oliveOil,oregano,spinach', [
      'Heat the oven to 400°F. Mix turkey with breadcrumbs, half the minced garlic and oregano. Form four small meatballs and brush with half the oil.',
      'Bake on a lined tray for 18–22 minutes until the centers reach 165°F (74°C).',
      'Meanwhile sauté diced onion and remaining garlic in the oil for 5 minutes, add tomatoes and simmer 12 minutes. Cook pasta according to its packet.',
      'Wilt spinach into the sauce, add the cooked meatballs and serve over drained pasta.'
    ], 'A familiar pasta dinner with a homemade, portioned meatball filling.'),
  recipe('tofu_broccoli_stir_fry', 'Tofu broccoli stir-fry with rice', 'dinner', 'Crisp tofu and broccoli coated in a light ginger-tamari sauce.', 35, 'Chinese-inspired', 'vadg', 'plant',
    'tofu,rice,broccoli,bellPepper*0.5,ginger,garlic,tamari,oliveOil,sesameOil', [
      'Cook rice according to the packet. Drain tofu, pat dry and cut into cubes.',
      'Brown tofu in half the olive oil for 8–10 minutes and set aside. Add the remaining olive oil, broccoli and sliced pepper with 3 tbsp water; cover for 4 minutes.',
      'Add minced garlic, ginger and tamari, return tofu and stir-fry for 3 minutes. Finish with sesame oil and serve over rice.'
    ], 'A straightforward tofu dinner with vegetables and a cooked grain.'),
  recipe('cod_tomato_white_beans', 'Cod tomato white bean skillet', 'dinner', 'Cod gently cooked in tomato sauce with white beans and spinach.', 30, 'Mediterranean-inspired', 'dg', 'fish',
    'cod,whiteBeans,tomatoCan,spinach,onion*0.5,garlic,oliveOil,lemon,oregano', [
      'Sauté diced onion and minced garlic in oil for 5 minutes. Add tomatoes, oregano, beans and 60 ml water.',
      'Simmer for 8 minutes, then nestle in the cod. Cover and cook for 8–12 minutes until fish reaches 145°F (63°C).',
      'Gently fold in spinach to wilt and finish with lemon juice.'
    ], 'Beans make this fish skillet a complete meal without a separate grain.'),
  recipe('pork_apple_cabbage', 'Pork tenderloin with apple cabbage', 'dinner', 'Seared pork with sweet-tart apples, cabbage and mashed potatoes.', 40, 'European-inspired', 'dg', 'pork',
    'pork,potato,apple*0.5,cabbage,onion*0.5,oliveOil,vinegar,mustard,pepper', [
      'Peel and cube the potato. Boil for 15–18 minutes until tender, drain and mash with a little cooking water and one-quarter of the oil.',
      'Cook pork in half the oil until its center reaches 145°F (63°C). Rest on a clean board for at least 3 minutes.',
      'Sauté shredded cabbage, sliced onion and apple in the remaining oil for 8–10 minutes. Add vinegar, mustard and pepper, then serve with sliced pork and mash.'
    ], 'A balanced plate of meat, potatoes and cooked fruit-and-vegetable sides.'),
  recipe('beef_fajita_rice_bowl', 'Beef fajita rice bowl', 'dinner', 'Sirloin with sautéed peppers, onions, rice and avocado.', 40, 'Tex-Mex-inspired', 'dg', 'beef',
    'steak,rice,bellPepper,onion,blackBeans*0.5,avocado*0.5,oliveOil,cumin,paprika,lime', [
      'Cook rice according to the packet. Slice onion and pepper and toss with cumin and paprika.',
      'Cook steak in half the oil until its center reaches 145°F (63°C). Rest for at least 3 minutes on a clean board, then slice.',
      'Sauté peppers and onion in remaining oil for 7–8 minutes and add beans to warm. Assemble over rice with steak, avocado and lime juice.'
    ], 'A build-your-own-style dinner made from simple fresh ingredients.'),
  recipe('spinach_ricotta_shells', 'Spinach ricotta stuffed shells', 'dinner', 'Baked pasta shells filled with spinach and ricotta in tomato sauce.', 55, 'Italian-inspired', 'v', 'dairy',
    'shells,ricotta,spinach,mozzarella*0.5,tomatoCan,garlic,oliveOil,oregano', [
      'Heat the oven to 375°F. Boil shells for 2 minutes less than the packet time and drain.',
      'Sauté minced garlic and spinach in oil until wilted. Chop spinach and mix with ricotta and oregano.',
      'Spoon tomato into a small ovenproof dish. Fill shells with ricotta mixture, arrange on the sauce and top with grated mozzarella.',
      'Cover and bake for 20 minutes, then uncover for 8–10 minutes until bubbling and 165°F (74°C) in the center.'
    ], 'A small baked pasta dish with the assembly and baking time included.'),
  recipe('lentil_mushroom_shepherd_pie', 'Lentil mushroom shepherd’s pie', 'dinner', 'A savory lentil and vegetable filling under a golden potato topping.', 60, 'British-inspired', 'vadg', 'plant',
    'lentils,mushrooms,carrot,onion*0.5,peas*0.5,potato*1.25,broth*0.5,tomatoPaste,oliveOil,pepper', [
      'Heat the oven to 400°F. Peel and cube potatoes, boil for 15–18 minutes, drain and mash with half the oil and a splash of cooking water.',
      'Sauté diced onion, carrot and mushrooms in the remaining oil for 8 minutes. Add lentils, peas, tomato paste, broth and pepper; simmer for 8 minutes to thicken.',
      'Transfer to a small ovenproof dish, spread potatoes over the top and bake for 20–25 minutes until bubbling and golden.'
    ], 'A comforting baked dinner that uses lentils in place of minced meat.'),
  recipe('chicken_peanut_noodles', 'Chicken peanut noodles with broccoli', 'dinner', 'Chicken and vegetables tossed with noodles and a peanut-lime sauce.', 35, 'Southeast Asian-inspired', 'd', 'chicken',
    'chicken,noodles,broccoli,carrot*0.5,peanutButter,tamari,lime,ginger,oliveOil', [
      'Cook noodles according to their packet, adding small broccoli florets for the final 3 minutes. Drain.',
      'Slice chicken on a separate board. Stir-fry in oil with grated ginger for 7–9 minutes until the chicken reaches 165°F (74°C).',
      'Whisk peanut butter, tamari and lime juice with 3 tbsp warm water. Toss with chicken, noodles, broccoli and grated carrot until hot throughout.'
    ], 'A complete noodle dinner with an easy homemade sauce.'),
  recipe('chickpea_spinach_coconut_curry', 'Chickpea spinach coconut curry', 'dinner', 'Chickpeas and cauliflower simmered in a spiced coconut sauce over rice.', 40, 'South Asian-inspired', 'vadg', 'plant',
    'chickpeas,rice,cauliflower*0.75,spinach,coconutMilk,tomatoCan*0.5,onion*0.5,garlic,ginger,oliveOil,cumin,turmeric', [
      'Cook rice according to the packet. Dice onion, mince garlic and ginger and cut cauliflower into small florets.',
      'Sauté onion in oil for 5 minutes. Add garlic, ginger, cumin and turmeric for 1 minute.',
      'Add cauliflower, chickpeas, tomatoes, coconut milk and 100 ml water. Simmer 15–20 minutes until cauliflower is tender; wilt in spinach and serve with rice.'
    ], 'A plant-based curry with a generous vegetable component.'),
  recipe('roast_veg_hummus_plate', 'Roasted vegetables and hummus grain plate', 'dinner', 'Roasted carrots, zucchini and chickpeas with hummus and bulgur.', 40, 'Middle Eastern-inspired', 'vad', 'plant',
    'bulgur,carrot,zucchini,chickpeas*0.75,hummus,oliveOil,cumin,lemon,parsley', [
      'Heat the oven to 425°F. Cut carrot into thin sticks and zucchini into chunks, toss with chickpeas, oil and cumin and roast for 25 minutes.',
      'Prepare bulgur in boiling water according to its packet and fluff with a fork.',
      'Serve vegetables and bulgur with hummus, chopped parsley and lemon juice.'
    ], 'A varied plant-based plate with a ready-made hummus dressing.'),
  recipe('ginger_salmon_rice', 'Ginger salmon with rice and cucumber', 'dinner', 'Pan-cooked salmon with ginger glaze and a fresh cucumber side.', 35, 'Japanese-inspired', 'dg', 'fish',
    'salmon,rice,cucumber,edamame*0.75,ginger,tamari,sesameOil,oliveOil*0.5,lime', [
      'Cook rice in water according to the packet. Cook edamame according to its packet and keep warm.',
      'Heat olive oil in a pan and cook salmon for 4–5 minutes per side. Add grated ginger, tamari and 2 tbsp water near the end; cook until salmon reaches 145°F (63°C).',
      'Toss sliced cucumber with lime juice and sesame oil. Serve beside salmon, rice and edamame.'
    ], 'A fish dinner with a fresh, crisp side and a simple cooked grain.'),
  recipe('turkey_stuffed_peppers', 'Turkey rice stuffed peppers', 'dinner', 'Bell pepper halves filled with turkey, rice and tomato sauce.', 60, 'Mediterranean-inspired', 'dg', 'turkey',
    'turkey,bellPepper*1.5,rice*0.75,tomatoCan,onion*0.5,garlic,oliveOil,oregano,parsley', [
      'Heat the oven to 400°F. Cook rice according to the packet. Halve and deseed peppers and bake cut-side up for 12 minutes.',
      'Sauté diced onion and garlic in oil for 4 minutes. Add turkey, breaking it apart, and cook until it reaches 165°F (74°C).',
      'Stir cooked rice, tomatoes and oregano into the turkey. Fill pepper halves and bake covered for 20 minutes, then uncovered for 8 minutes until hot throughout.',
      'Finish with parsley and serve all the pepper halves as one meal.'
    ], 'A complete stuffed vegetable dinner with preparation time fully accounted for.'),
  recipe('mushroom_pea_risotto', 'Mushroom pea risotto', 'dinner', 'Creamy stirred rice with mushrooms, peas and nutritional yeast.', 45, 'Italian-inspired', 'vadg', 'plant',
    'arborio,mushrooms,peas,onion*0.5,garlic,broth*1.5,oliveOil,nutritionalYeast,lemon*0.5', [
      'Warm the broth with 150 ml water in a saucepan. Sauté sliced mushrooms and diced onion in oil in a second pan for 7 minutes.',
      'Add minced garlic and rice and stir for 1 minute. Add warm broth one ladle at a time, stirring often and letting it absorb between additions.',
      'After 18–22 minutes, when rice is tender with a little bite, add peas and cook 3 minutes. Stir in nutritional yeast and lemon juice; loosen with hot water if needed.'
    ], 'Slow stirring creates a creamy rice dish without cream or cheese.'),
  recipe('sweet_potato_lentil_dal', 'Sweet potato red lentil dal', 'dinner', 'Soft lentils and sweet potato with ginger, spinach and warm rice.', 45, 'South Asian-inspired', 'vadg', 'plant',
    'redLentils,sweetPotato*0.75,rice*0.75,spinach,onion*0.5,ginger,garlic,oliveOil,cumin,turmeric,lemon', [
      'Cook rice according to the packet. Dice sweet potato into 1 cm cubes, chop onion and mince garlic and ginger.',
      'Sauté onion in oil for 5 minutes. Add garlic, ginger, cumin and turmeric, then rinsed lentils, sweet potato and 350 ml water.',
      'Simmer for 25 minutes until lentils and potato are soft, adding water if needed. Wilt in spinach, add lemon juice and serve over rice.'
    ], 'An inexpensive lentil dinner with no overnight bean preparation.'),
  recipe('beef_cabbage_roll_skillet', 'Beef cabbage roll skillet', 'dinner', 'Ground beef, cabbage and rice cooked in a tomato sauce.', 45, 'Eastern European-inspired', 'dg', 'beef',
    'beef,rice,cabbage*1.5,tomatoCan,onion*0.5,garlic,oliveOil,paprika,dill', [
      'Sauté diced onion and garlic in oil for 4 minutes. Add ground beef and break apart; cook until it reaches 160°F (71°C).',
      'Add shredded cabbage and paprika and cook for 4 minutes. Stir in rinsed rice, tomatoes and 200 ml water.',
      'Cover and simmer for 20–25 minutes, stirring occasionally and adding water if needed, until rice is tender. Finish with dill.'
    ], 'The flavors of stuffed cabbage without the work of rolling individual leaves.'),
  recipe('chicken_souvlaki_pita_plate', 'Lemon oregano chicken pita plate', 'dinner', 'Skillet chicken with warm pita, tomato salad and cucumber yogurt.', 40, 'Greek-inspired', '', 'chicken',
    'chicken,pita,yogurt*0.5,cucumber,tomato,lettuce,lemon,garlic,oliveOil,oregano', [
      'Cut chicken into bite-sized pieces on a separate board. Toss with oil, oregano, half the minced garlic and half the lemon juice; refrigerate while preparing the vegetables.',
      'Grate half the cucumber and squeeze dry. Mix with yogurt and remaining garlic. Chop the other cucumber half, tomato and lettuce.',
      'Cook chicken in a hot skillet for 8–10 minutes, turning, until pieces reach 165°F (74°C). Warm the pita.',
      'Serve chicken, pita, salad and cucumber yogurt with the remaining lemon juice.'
    ], 'A mixed plate where each component can be served separately.'),
  recipe('trout_herb_quinoa', 'Herb trout with quinoa and asparagus', 'dinner', 'Baked trout with lemony quinoa and tender asparagus.', 35, 'European-inspired', 'dg', 'fish',
    'trout,quinoa,asparagus,oliveOil,lemon,parsley,dill,pepper', [
      'Heat the oven to 400°F. Rinse and cook quinoa according to its packet.',
      'Trim asparagus and arrange beside trout on a lined tray. Brush with oil and add pepper and lemon slices.',
      'Bake for 12–16 minutes until trout reaches 145°F (63°C). Stir chopped parsley and dill into quinoa and serve together.'
    ], 'A simple oven-cooked fish dinner with a different grain and vegetable pairing.'),
  recipe('white_bean_kale_skillet', 'White bean kale skillet with toast', 'dinner', 'Garlicky white beans and kale in a thick tomato sauce.', 30, 'Italian-inspired', 'vad', 'plant',
    'whiteBeans*1.25,kale,tomatoCan,onion*0.5,garlic,oliveOil,oregano,sourdough,lemon*0.5', [
      'Chop onion and garlic. Remove tough kale stems and chop the leaves.',
      'Sauté onion and garlic in oil for 5 minutes. Add tomatoes, beans, oregano and 60 ml water; simmer for 10 minutes.',
      'Stir in kale and cook covered for 5–7 minutes until tender. Add lemon juice and serve with toasted sourdough.'
    ], 'A pantry-friendly bean dinner with hearty greens.'),
  recipe('eggplant_chickpea_couscous', 'Eggplant tomato chickpea couscous', 'dinner', 'Roasted eggplant and chickpeas in tomato sauce over couscous.', 45, 'North African-inspired', 'vad', 'plant',
    'eggplant,chickpeas,couscous,tomatoCan,onion*0.5,garlic,oliveOil,cumin,paprika,parsley', [
      'Heat the oven to 425°F. Cube eggplant, toss with half the oil and roast for 25–30 minutes until tender.',
      'Sauté diced onion and minced garlic in remaining oil for 5 minutes. Add cumin, paprika, tomatoes and chickpeas; simmer for 12 minutes.',
      'Prepare couscous according to the packet. Fold roasted eggplant into the sauce and serve over couscous with parsley.'
    ], 'Roasting the eggplant creates a different texture from a simple bean stew.'),
  recipe('baked_tofu_sweet_potato_slaw', 'Baked tofu sweet potato plate with peanut slaw', 'dinner', 'Roasted tofu and sweet potato with crunchy peanut-lime cabbage.', 45, 'Southeast Asian-inspired', 'vadg', 'plant',
    'tofu,sweetPotato,cabbage,carrot*0.5,peanutButter,tamari,lime,oliveOil,ginger', [
      'Heat the oven to 425°F. Pat tofu dry and cube it. Dice sweet potato into 1 cm cubes and toss both with oil on a lined tray.',
      'Roast for 25–30 minutes, turning once, until potato is tender and tofu has golden edges.',
      'Whisk peanut butter, tamari, lime juice and grated ginger with 2–3 tbsp water. Toss half with shredded cabbage and carrot; serve remaining sauce with the roast vegetables and tofu.'
    ], 'A vegetable-forward plate with contrasting roasted and crunchy components.'),
  recipe('pork_meatball_miso_soup', 'Pork meatball miso noodle soup', 'dinner', 'Small pork meatballs with noodles, mushrooms and greens in miso broth.', 40, 'Japanese-inspired', 'd', 'pork',
    'groundPork,noodles,breadcrumbs,mushrooms,spinach,ginger,garlic,miso,broth,scallion,sesameOil', [
      'Mix ground pork with breadcrumbs and half the grated ginger. Form six small meatballs.',
      'Bring broth and 250 ml water to a simmer with sliced mushrooms, minced garlic and remaining ginger. Add meatballs and simmer for 12–15 minutes until the centers reach 160°F (71°C).',
      'Cook noodles according to the packet in a separate pan. Wilt spinach into the broth, then dissolve miso in a little hot broth and stir it back in.',
      'Serve soup over the drained noodles with scallion and sesame oil.'
    ], 'A warming noodle dinner with freshly cooked meatballs.'),
  recipe('lentil_bolognese_pasta', 'Lentil mushroom bolognese', 'dinner', 'A thick lentil and mushroom tomato sauce over whole-wheat pasta.', 40, 'Italian-inspired', 'vad', 'plant',
    'lentils,pasta,mushrooms,carrot*0.5,onion*0.5,garlic,tomatoCan,tomatoPaste,oliveOil,oregano,nutritionalYeast', [
      'Finely chop mushrooms, onion and carrot and mince garlic. Sauté in oil for 8–10 minutes until softened.',
      'Stir in tomato paste, tomatoes, lentils, oregano and 60 ml water. Simmer for 18–20 minutes until thick.',
      'Cook pasta according to its packet. Serve with the sauce and nutritional yeast.'
    ], 'A hearty meat-free pasta sauce with a finely chopped vegetable base.'),
  recipe('chicken_enchilada_skillet', 'Chicken black bean enchilada skillet', 'dinner', 'Chicken, beans and tortilla strips baked under a tomato-cheddar topping.', 45, 'Mexican-inspired', 'g', 'chicken',
    'chicken,cornTortilla,blackBeans*0.75,tomatoCan,salsa,cheddar,bellPepper*0.5,onion*0.5,oliveOil,cumin', [
      'Heat the oven to 400°F. Dice chicken on a separate board and chop pepper and onion.',
      'Sauté onion and pepper in oil for 5 minutes. Add chicken and cumin and cook until chicken reaches 165°F (74°C).',
      'Stir in tomatoes, salsa and beans; simmer for 5 minutes. Fold in torn tortillas and transfer to a small ovenproof dish.',
      'Top with cheddar and bake for 12–15 minutes until bubbling and 165°F (74°C) throughout.'
    ], 'An easy layered tortilla dinner without individually rolling enchiladas.'),
  recipe('spinach_potato_egg_bake', 'Spinach potato egg bake with tomato salad', 'dinner', 'Baked eggs and potatoes with feta and a fresh tomato side.', 50, 'Mediterranean-inspired', 'vg', 'eggs',
    'egg,potato,spinach,feta,onion*0.5,oliveOil,tomato,cucumber*0.5,lemon*0.5', [
      'Heat the oven to 375°F. Thinly slice potatoes and microwave covered with 2 tbsp water for 6–7 minutes until tender; drain.',
      'Sauté onion in half the oil for 4 minutes and wilt in spinach. Combine with potato, beaten eggs and crumbled feta in a small oiled ovenproof dish.',
      'Bake for 22–28 minutes until set and 160°F (71°C) in the center. Toss chopped tomato and cucumber with lemon juice and serve alongside.'
    ], 'Eggs can make a simple dinner as well as a breakfast.'),
  recipe('roasted_squash_quinoa_beans', 'Roasted squash with quinoa and black beans', 'dinner', 'Tender squash wedges piled with lime-dressed quinoa, beans and seeds.', 55, 'Southwestern-inspired', 'vadg', 'plant',
    'squash*1.25,quinoa,blackBeans*0.75,bellPepper*0.5,onion*0.5,oliveOil,cumin,lime,pumpkinSeeds*0.5,cilantro', [
      'Heat the oven to 425°F. Cut squash into thick wedges, brush with half the oil and roast for 35–40 minutes until tender.',
      'Rinse and cook quinoa according to its packet. Sauté diced onion and pepper in remaining oil for 5 minutes; add beans and cumin and warm through.',
      'Toss quinoa with beans, vegetables and lime juice. Spoon over squash and finish with pumpkin seeds and cilantro.'
    ], 'A substantial roasted squash dinner with grains and beans.'),
  recipe('lemon_chicken_bulgur_kale', 'Lemon chicken with bulgur and kale', 'dinner', 'Pan-cooked chicken beside garlicky kale and fluffy bulgur.', 40, 'Mediterranean-inspired', 'd', 'chicken',
    'chicken,bulgur,kale,cherryTomatoes,garlic,oliveOil,lemon,oregano', [
      'Prepare bulgur according to its packet. Remove tough stems from kale and chop the leaves.',
      'Season chicken with oregano and cook in half the oil for 6–8 minutes per side until it reaches 165°F (74°C). Rest on a clean board.',
      'Sauté minced garlic and kale in remaining oil with 2 tbsp water for 5 minutes. Add halved tomatoes and cook 3 minutes more.',
      'Serve sliced chicken over bulgur with vegetables and lemon juice.'
    ], 'A familiar chicken dinner with a quick whole-wheat grain and cooked greens.'),
  recipe('cod_tacos_lime_slaw', 'Cod tacos with lime slaw', 'dinner', 'Spiced cooked cod in corn tortillas with cabbage and avocado.', 30, 'Mexican-inspired', 'dg', 'fish',
    'cod,cornTortilla,cabbage,carrot*0.5,avocado*0.75,oliveOil,lime,cumin,paprika,cilantro,blackBeans*0.5', [
      'Shred cabbage and carrot and toss with half the lime juice and chopped cilantro. Warm beans in a small pan with 2 tbsp water.',
      'Coat cod with cumin and paprika. Cook in oil for 3–5 minutes per side, depending on thickness, until it reaches 145°F (63°C).',
      'Warm tortillas. Fill with flaked cod, slaw and sliced avocado, and serve with the beans and remaining lime juice.'
    ], 'A quick fish taco plate with beans and fresh slaw.'),
];
