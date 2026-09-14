/** Recipe matching is local and deterministic. Model image URLs are never used. */
import { el } from './dom.js';
import { mealPhotoCatalog } from './meal-photo-catalog.js';

export function mealPhoto(recipe = {}) {
  const title = String(recipe.title || '').toLowerCase();
  const ingredients = (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).map(i => i?.name || '').join(' ').toLowerCase();
  const text = `${title} ${ingredients}`;
  // Read dietary labels from the recipe, never from a side ingredient such as vegan bread.
  const labels = `${title} ${(Array.isArray(recipe.tags) ? recipe.tags : []).join(' ')}`.toLowerCase();
  const plantBased = /\b(vegan|plant[- ]based)\b/.test(labels);
  const meatFree = plantBased || /\b(vegetarian|meatless|mock)\b/.test(labels);
  const dairyFree = plantBased || /\b(dairy[- ]free|milk[- ]free)\b/.test(labels);
  const meat = !meatFree && /\b(chicken|turkey|beef|pork|bacon|ham|salmon|tuna|cod|trout|tilapia|sardines?|anchov(?:y|ies)|shrimp|prawns?|fish|steak|meat|lamb|duck|sausage)\b/.test(text);
  const soup = /\b(soup|stew|chowder|ramen|pho|minestrone|chili)\b/.test(title);
  const filledBread = /\b(wrap|burrito|sandwich|panini|melt|pita|tacos?|quesadilla|pizza)\b/.test(title);
  const noodles = /\b(noodles?|soba|udon|lo mein|chow mein)\b/.test(title);
  const pasta = /\b(pasta|spaghetti|penne|fusilli|macaroni|orzo|bolognese|stuffed shells)\b/.test(title);
  const grains = /\b(rice|grains?|quinoa|bulgur|barley|couscous)\b/.test(text);
  const groundMeat = /\b(meatballs?|sausage)\b|\b(ground|minced?)\s+(?:(?:lean|extra[- ]lean)\s+)?(beef|pork|chicken|turkey|lamb|meat)\b/.test(text);
  const savoryBreakfast = /\b(savory|savoury|mushroom|spinach|chickpea|tomato|cucumber|potato|bean)\b/.test(title);
  const entree = !soup && !noodles && !pasta && !/\b(wrap|burrito|sandwich|curry|curried|salad|tacos?|quesadilla|pizza|enchilada|fajita|meatballs?)\b/.test(title);
  let id;
  // Match the dish form first: yogurt dressing does not make a sandwich a parfait.
  if (!meat && /\bpancakes?\b/.test(title) && !savoryBreakfast) id = 'pancakes';
  else if (!meat && /\bsmoothie\b/.test(title)) id = 'smoothie';
  else if (!meat && /\bchia\b/.test(title) && /\b(pudding|cup|breakfast)\b/.test(title)) id = 'chia-pudding';
  else if (!meat && !dairyFree && !filledBread && /\bcottage cheese\b/.test(title)) id = 'cottage-cheese';
  else if (!meat && /\bfrench toast\b/.test(title)) id = 'french-toast';
  else if (!meat && !dairyFree && /\bricotta\b/.test(title) && /\btoast\b/.test(title)) id = 'ricotta-toast';
  else if (!meat && /\btoast\b/.test(title) && /\bavocado\b/.test(title)) id = 'toast';
  else if (!meat && /\bmuesli\b/.test(title)) id = 'muesli';
  else if (!meat && /\bbaked\b/.test(title) && /\boats?\b/.test(title) && !savoryBreakfast) id = 'baked-oats';
  else if (!meat && !soup && !filledBread && !savoryBreakfast && !/\b(stuffed|sauce|dressing|dip)\b/.test(title) && /\b(yogurt|yoghurt|parfait)\b/.test(title)) id = 'yogurt';
  else if (!meat && !savoryBreakfast && /\b(oats?|oatmeal|porridge)\b/.test(title) && !/\b(muffins?|cookies?|bread|bars?|cake)\b/.test(title)) id = 'oatmeal';
  else if (!meat && !plantBased && /\bshakshuka\b/.test(title)) id = 'shakshuka';
  else if (!meat && !dairyFree && /\bquesadillas?\b/.test(title)) id = 'quesadilla';
  else if (!meat && !plantBased && /\begg\b/.test(title) && /\bsandwich\b/.test(title)) id = 'egg-sandwich';
  else if (!meat && !dairyFree && /\b(sandwich|panini|melt)\b/.test(title) && /\b(cheese|mozzarella|cheddar|feta)\b/.test(text)) id = 'vegetable-sandwich';
  else if (!meat && !dairyFree && /\b(wrap|burrito|pita)\b/.test(title) && /\b(cheese|mozzarella|cheddar|feta)\b/.test(text)) id = 'vegetable-wrap';
  else if (!meat && /\b(wrap|burrito|pita)\b/.test(title) && /\b(chickpeas?|hummus|tofu|vegetables?|veggie|cucumber|cauliflower)\b/.test(text)) id = 'vegan-wrap';
  else if (!meat && /\btacos?\b/.test(title) && /\b(beans?|vegetables?|veggie|corn)\b/.test(text)) id = 'bean-tacos';
  else if (/\bstuffed peppers?\b/.test(title)) id = 'stuffed-peppers';
  else if (meat && !soup && /\bmeatballs?\b/.test(title)) id = 'meatballs';
  else if (!meat && !soup && noodles) id = 'vegetable-noodles';
  else if (!meat && /\b(curry|curried|dal|dahl)\b/.test(title) && /\brice\b/.test(text)) id = 'vegetable-curry';
  else if (!meat && /\b(curry|curried)\b/.test(title)) id = 'vegetable-curry';
  else if (!meat && /\brisotto\b/.test(title)) id = 'pea-risotto';
  else if (!meat && soup && /\b(carrot|butternut|squash|pumpkin|roasted pepper)\b/.test(title) && !noodles) id = 'carrot-soup';
  else if (!meat && /\b(soup|stew|dal|dahl)\b/.test(title) && /\blentils?\b/.test(text)) id = 'lentil-soup';
  else if (!meat && !soup && pasta) id = 'pasta';
  else if (!meatFree && !soup && !filledBread && !noodles && /\bchicken\b/.test(title) && (/\bsalad\b/.test(title) || /\bbowl\b/.test(title) && /\b(lettuce|greens|arugula|cucumber|tomato)\b/.test(text))) id = 'chicken-salad';
  else if (!meatFree && entree && /\b(cod|haddock|tilapia|halibut|pollock|trout|white fish)\b/.test(title)) id = 'white-fish';
  else if (!meatFree && !groundMeat && !soup && !filledBread && !noodles && !pasta && /\b(beef|steak)\b/.test(title)) id = 'beef-vegetables';
  else if (!meatFree && !groundMeat && entree && /\bpork\b/.test(title)) id = 'pork-vegetables';
  else if (!meatFree && entree && /\bsalmon\b/.test(title)) id = 'salmon';
  else if (!meatFree && entree && /\bchicken\b/.test(title)) id = 'chicken';
  else if (!meat && !plantBased && !soup && !filledBread && !grains && !/\bmuffins?\b/.test(title) && /\b(eggs?|omelet|omelette|frittata)\b/.test(title)) id = 'eggs';
  else if (!meat && /\bsalad\b/.test(title) && /\b(chickpeas?|garbanzo)\b/.test(text)) id = 'chickpea-salad';
  else if (!meat && !soup && !filledBread && grains && /\b(stir[- ]fry|skillet|rice|grain|quinoa|bulgur|barley|couscous)\b/.test(title) && !/\b(salad|sweet|cherry|fruit|porridge|oats?)\b/.test(title)) id = 'vegetable-stir-fry';
  else if (!meat && !soup && !filledBread && /\b(hash|skillet)\b/.test(title) && /\b(potato|beans?|vegetables?|veggie|kale|spinach)\b/.test(text)) id = 'vegetable-stir-fry';
  else if (!meat && !soup && !filledBread && /\bplate\b/.test(title) && /\b(roasted|baked)\b/.test(title) && /\b(vegetables?|sweet potato|slaw)\b/.test(text)) id = 'vegetable-bowl';
  else if (!meat && !soup && !filledBread && recipe.slot !== 'breakfast' && /\b(bowl|salad|lentils)\b/.test(title) && /\b(chickpeas?|lentils?|beans?|vegetables?|veggie|quinoa|rice|tofu)\b/.test(text)) id = 'vegetable-bowl';
  else id = 'kitchen';
  const photo = mealPhotoCatalog[id];
  return photo ? { ...photo, id, caption: id === 'kitchen' ? 'Kitchen inspiration' : 'Serving idea' } : null;
}

export function mealPhotoFigure(photo) {
  const figure = el('figure', { class: 'meal-photo' });
  const fallback = () => figure.replaceChildren(el('span', { class: 'meal-photo-fallback', text: 'Made in your kitchen' }));
  if (!photo) { fallback(); return figure; }
  figure.appendChild(el('img', {
    src: photo.src, alt: `${photo.description}. Illustrative photo; follow the recipe ingredients.`,
    width: photo.width, height: photo.height, loading: 'lazy', decoding: 'async', draggable: 'false',
    style: { 'object-position': photo.position }, onerror: fallback,
  }));
  figure.appendChild(el('figcaption', { text: photo.caption }));
  return figure;
}

export function mealPhotoCredit(photo) {
  return photo ? el('p', { class: 'meal-photo-credit' }, [
    el('span', { text: 'Illustrative photo · ' }),
    el('a', { href: photo.source, target: '_blank', rel: 'noopener noreferrer', text: photo.credit }),
  ]) : null;
}
