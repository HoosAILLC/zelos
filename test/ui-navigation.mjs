/** Exact user-click navigation exceptions. Never exempts a host or a whole file. */
import assert from 'node:assert/strict';
const HEALTH_DECLARATION="const sourceURLs=new Set(['https://www.who.int/news-room/fact-sheets/detail/healthy-diet','https://www.cdc.gov/physical-activity-basics/adding-adults/index.html','https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies']);";
const SHOPPING_ANCHOR="el('a', { href: 'https://docs.instacart.com/developer_platform_api/get_started/api-keys', target: '_blank', rel: 'noopener noreferrer', text: 'Get a developer API key' })";
const BRAVE_ANCHOR="el('a', { href: 'https://api-dashboard.search.brave.com/app/keys', target: '_blank', rel: 'noopener noreferrer', text: 'Get a Brave Search API key' })";
const MEAL_PHOTO_SOURCES = [
  "https://www.pexels.com/photo/bowl-of-oatmeal-with-sliced-fruits-and-berries-4725747/",
  "https://www.pexels.com/photo/spoon-in-a-bowl-with-yogurt-and-berries-10421049/",
  "https://www.pexels.com/photo/a-plate-with-food-on-it-including-salad-and-eggs-18426946/",
  "https://www.pexels.com/photo/bread-with-avocado-4451872/",
  "https://www.pexels.com/photo/pancakes-with-fresh-berries-4725640/",
  "https://www.pexels.com/photo/pink-smoothie-in-a-glass-with-fresh-fruit-on-top-4051766/",
  "https://www.pexels.com/photo/a-bowl-of-chickpea-salad-6066050/",
  "https://www.pexels.com/photo/soup-and-sliced-bread-on-table-9928340/",
  "https://www.pexels.com/photo/grilled-salmon-with-vegetables-on-a-plate-31235406/",
  "https://www.pexels.com/photo/grilled-meat-with-green-ladies-finger-vegetable-on-white-ceramic-plate-1247677/",
  "https://www.pexels.com/photo/close-up-shot-of-a-pasta-dish-on-a-plate-5507643/",
  "https://www.pexels.com/photo/a-hand-cooking-on-a-frying-pan-7964679/",
  "https://unsplash.com/photos/bowl-of-vegetable-salads-IGfIGP5ONV0",
  "https://www.pexels.com/photo/assorted-vegetables-on-chopping-board-on-wooden-surface-5645089/",
  "https://www.pexels.com/photo/a-sandwich-with-tomatoes-and-cheese-on-a-napkin-17942177/",
  "https://www.pexels.com/photo/burrito-on-white-ceramic-plate-11136408/",
  "https://www.pexels.com/photo/scrumptious-tacos-on-a-plate-5848707/",
  "https://www.pexels.com/photo/close-up-photo-of-quesadilla-5840082/",
  "https://www.pexels.com/photo/golden-spoon-near-soup-bowl-4451869/",
  "https://www.pexels.com/photo/cooked-food-in-bowl-2456434/",
  "https://www.pexels.com/photo/curry-rice-dish-in-a-plate-10464100/",
  "https://www.pexels.com/photo/close-up-shot-of-risotto-6129137/",
  "https://www.pexels.com/photo/delicious-stuffed-peppers-in-metal-pan-35718863/",
  "https://www.pexels.com/photo/meatballs-on-baking-tray-5836992/",
  "https://www.pexels.com/photo/fruit-topping-on-a-glass-of-creamy-desert-5150207/",
  "https://www.pexels.com/photo/food-on-the-plate-9407178/",
  "https://www.pexels.com/photo/fork-and-knife-beside-a-pan-with-cooked-food-6275166/",
  "https://www.pexels.com/photo/close-up-photo-of-tasty-looking-french-toast-8143760/",
  "https://www.pexels.com/photo/muesli-with-slices-of-apples-and-black-coffee-15378364/",
  "https://www.pexels.com/photo/oatmel-with-fruits-6068870/",
  "https://www.pexels.com/photo/slices-of-pie-with-whipped-cream-on-top-5836438/",
  "https://www.pexels.com/photo/close-up-shot-of-a-delicious-food-12653397/",
  "https://www.pexels.com/photo/meal-with-beef-on-plate-16444386/",
  "https://www.pexels.com/photo/meat-dish-and-vegetables-341044/",
  "https://www.pexels.com/photo/chicken-salad-20272479/",
  "https://www.pexels.com/photo/delicious-egg-salad-sandwich-on-whole-wheat-31150259/",
  "https://www.pexels.com/photo/photo-of-sliced-tomatoes-on-pita-bread-3872385/"
];
export function stripFixedNavigation(where, source) {
  if(where==='ui/lib/subscription.js'){
    // A reviewed setup link plus a config value sent only to the local server.
    // Behavioral tests verify render cannot start sign-in, save, or inference.
    const install="const INSTALL_URL = 'https://learn.chatgpt.com/docs/cli';";
    const spec="return { protocol: 'chatgpt', label: 'ChatGPT subscription', baseUrl: 'https://chatgpt.com', model: selectedModel, keyRef: null, maxTokens };";
    for(const declaration of [install,spec]) {
      assert.equal(source.split(declaration).length-1,1,'Subscription must use each exact reviewed address declaration once');
      source=source.replace(declaration,'');
    }
    assert.equal([...source.matchAll(/\bINSTALL_URL\b/g)].length,1,'The setup address is used only once');
    assert.match(source,/link\(INSTALL_URL, 'Open Codex installation guide'\)/,'The setup address must remain a click-only link');
    assert.doesNotMatch(source,/\bfetch\s*\(/,'Subscription UI must use local API wrappers');
    return source;
  }
  if(where==='ui/lib/meal-photo-catalog.js'){
    for (const url of MEAL_PHOTO_SOURCES) {
      const line='    \"source\": '+JSON.stringify(url)+',';
      assert.equal(source.split(line).length-1,1,'Each reviewed photo credit must appear once');
      source=source.replace(line,'');
    }
    return source;
  }
  if(where==='ui/lib/bank-link.js'){
    // First-party bank UI, not a downloaded Plaid SDK. These are the only
    // fixed Plaid links; the helper produces protected click-only anchors.
    const helper="const external=(text,href)=>el('a',{class:'btn quiet',text,href,target:'_blank',rel:'noopener noreferrer'});";
    assert.equal(source.split(helper).length-1,1,'Plaid navigation must use the exact protected anchor helper');
    for(const call of [
      "external('Open Plaid dashboard','https://dashboard.plaid.com/')",
      "external('Trial setup guide','https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan')",
    ]) {
      assert.equal(source.split(call).length-1,1,'Plaid must use each exact reviewed setup link once');
      source=source.replace(call,'');
    }
    return source;
  }
  if(where==='ui/views/health.js'){
    assert.equal(source.split(HEALTH_DECLARATION).length-1,1,'Health must declare the exact three reviewed guidance URLs once');
    assert.equal([...source.matchAll(/\bsourceURLs\b/g)].length,2,'Health guidance URLs may only be declared and checked for navigation');
    assert.match(source,/sourceURLs\.has\(source\.url\)\s*\?el\('a',\{href:source\.url,target:'_blank',rel:'noopener noreferrer',text:source\.title\}\)/,'Health citations must remain checked, plain-text anchors');
    return source.replace(HEALTH_DECLARATION,'');
  }
  if(where==='ui/views/shopping.js'){
    assert.equal(source.split(SHOPPING_ANCHOR).length-1,1,'Shopping may link to this exact developer-key help page once');
    return source.replace(SHOPPING_ANCHOR,'');
  }
  if(where==='ui/views/ask.js'){
    assert.equal(source.split(BRAVE_ANCHOR).length-1,1,'Ask may link to this exact Brave-key help page once');
    return source.replace(BRAVE_ANCHOR,'');
  }
  return source;
}
